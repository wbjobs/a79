import os
import json
import uuid
import time
from typing import List, Dict, Any, Optional
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import aiofiles

from voxelizer import (
    voxelize_file, list_models, save_uploaded_model,
    get_model_path, load_voxelized, save_voxelized
)
from annotation_store import store, User, PointAnnotation


app = FastAPI(title="3D Point Cloud Annotation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


class ConnectionManager:
    def __init__(self):
        self.model_connections: Dict[str, Dict[str, WebSocket]] = {}

    def connect(self, model_name: str, user_id: str, websocket: WebSocket):
        if model_name not in self.model_connections:
            self.model_connections[model_name] = {}
        self.model_connections[model_name][user_id] = websocket

    def disconnect(self, model_name: str, user_id: str):
        if model_name in self.model_connections:
            if user_id in self.model_connections[model_name]:
                del self.model_connections[model_name][user_id]
            if len(self.model_connections[model_name]) == 0:
                del self.model_connections[model_name]

    async def broadcast(self, model_name: str, message: Dict[str, Any], exclude_user: Optional[str] = None):
        if model_name not in self.model_connections:
            return
        for uid, ws in list(self.model_connections[model_name].items()):
            if exclude_user and uid == exclude_user:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                pass

    async def send_to_user(self, model_name: str, user_id: str, message: Dict[str, Any]):
        if model_name not in self.model_connections:
            return
        ws = self.model_connections[model_name].get(user_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                pass

    def get_connections_count(self, model_name: str) -> int:
        if model_name not in self.model_connections:
            return 0
        return len(self.model_connections[model_name])


manager = ConnectionManager()

DEFAULT_TAGS = [
    ("车门", "#e74c3c"),
    ("轮胎", "#3498db"),
    ("车窗", "#9b59b6"),
    ("车顶", "#2ecc71"),
    ("车身", "#f39c12"),
]


def ensure_default_tags(model_name: str):
    tags = store.get_tags(model_name)
    if len(tags) == 0:
        for name, color in DEFAULT_TAGS:
            store.add_tag(model_name, name, color)


@app.get("/")
async def root():
    return {"message": "3D Point Cloud Annotation Server", "status": "running"}


@app.get("/api/models")
async def get_models():
    models = list_models()
    return {"models": models}


@app.post("/api/models/upload")
async def upload_model(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    ext = Path(file.filename).suffix.lower()
    supported = {'.obj', '.gltf', '.glb'}
    if ext not in supported:
        raise HTTPException(status_code=400, detail=f"Unsupported format. Supported: {supported}")
    content = await file.read()
    path = save_uploaded_model(file.filename, content)
    return {"filename": file.filename, "size": len(content), "status": "uploaded"}


@app.post("/api/models/{model_name}/voxelize")
async def voxelize_model(model_name: str, resolution: int = 64, use_surface: bool = False):
    path = get_model_path(model_name)
    if not path:
        raise HTTPException(status_code=404, detail=f"Model not found")
    try:
        resolution = max(16, min(resolution, 512))
        data = voxelize_file(str(path), resolution=resolution, use_surface=use_surface)
        model_id = f"{Path(model_name).stem}_{resolution}_{'surface' if use_surface else 'voxel'}"
        save_voxelized(model_id, data)
        ensure_default_tags(model_name)
        return {
            "model_id": model_id,
            "num_points": data["num_points"],
            "bounds": data["bounds"],
            "model_name": model_name
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Voxelization failed: {str(e)}")


@app.get("/api/models/{model_name}/pointcloud")
async def get_pointcloud(model_name: str, resolution: int = 64, use_surface: bool = False):
    model_id = f"{Path(model_name).stem}_{resolution}_{'surface' if use_surface else 'voxel'}"
    data = load_voxelized(model_id)
    if not data:
        path = get_model_path(model_name)
        if not path:
            raise HTTPException(status_code=404, detail="Model not found")
        try:
            resolution = max(16, min(resolution, 512))
            data = voxelize_file(str(path), resolution=resolution, use_surface=use_surface)
            save_voxelized(model_id, data)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Voxelization failed: {str(e)}")
    ensure_default_tags(model_name)
    return {
        "model_id": model_id,
        "positions": data["positions"],
        "normals": data["normals"],
        "num_points": data["num_points"],
        "bounds": data["bounds"],
        "model_name": model_name
    }


@app.get("/api/models/{model_name}/tags")
async def get_tags(model_name: str):
    ensure_default_tags(model_name)
    return {"tags": store.get_tags(model_name)}


@app.post("/api/models/{model_name}/tags")
async def add_tag(model_name: str, payload: Dict[str, str]):
    tag_name = payload.get("name", "").strip()
    color = payload.get("color", "#4fc3f7")
    if not tag_name:
        raise HTTPException(status_code=400, detail="Tag name required")
    store.add_tag(model_name, tag_name, color)
    tags = store.get_tags(model_name)
    await manager.broadcast(model_name, {
        "type": "tags_updated",
        "tags": tags
    })
    return {"tags": tags}


@app.delete("/api/models/{model_name}/tags/{tag_name}")
async def delete_tag(model_name: str, tag_name: str):
    store.remove_tag(model_name, tag_name)
    tags = store.get_tags(model_name)
    await manager.broadcast(model_name, {
        "type": "tags_updated",
        "tags": tags
    })
    return {"tags": tags, "removed": tag_name}


@app.get("/api/models/{model_name}/annotations")
async def get_annotations(model_name: str):
    annotations = store.get_all_annotations(model_name)
    result = []
    for idx, ann in annotations.items():
        result.append(ann.to_dict())
    return {"annotations": result}


@app.get("/api/models/{model_name}/stats")
async def get_stats(model_name: str, total_points: int = 0):
    return {"stats": store.get_stats(model_name, total_points)}


@app.get("/api/models/{model_name}/users")
async def get_users(model_name: str):
    users = store.get_users(model_name)
    return {"users": [u.to_dict() for u in users]}


@app.websocket("/ws/{model_name}")
async def websocket_endpoint(websocket: WebSocket, model_name: str):
    await websocket.accept()
    user_id = None
    try:
        init_msg = await websocket.receive_json()
        if init_msg.get("type") != "join":
            await websocket.close()
            return
        user_id = init_msg.get("user_id") or str(uuid.uuid4())
        username = init_msg.get("username", f"User_{user_id[:6]}")
        color = init_msg.get("color", "#ff0000")
        user = User(user_id=user_id, username=username, color=color)
        store.add_user(model_name, user)
        manager.connect(model_name, user_id, websocket)
        await websocket.send_json({
            "type": "welcome",
            "user_id": user_id,
            "user": user.to_dict()
        })
        users = store.get_users(model_name)
        await manager.broadcast(model_name, {
            "type": "users_updated",
            "users": [u.to_dict() for u in users]
        }, exclude_user=None)
        annotations = store.get_all_annotations(model_name)
        annotations_list = []
        for idx, ann in annotations.items():
            annotations_list.append(ann.to_dict())
        await websocket.send_json({
            "type": "annotations_init",
            "annotations": annotations_list
        })
        tags = store.get_tags(model_name)
        await websocket.send_json({
            "type": "tags_updated",
            "tags": tags
        })
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type", "")
            if msg_type == "update_user":
                new_username = msg.get("username", username)
                new_color = msg.get("color", color)
                user.username = new_username
                user.color = new_color
                store.update_user(model_name, user)
                users = store.get_users(model_name)
                await manager.broadcast(model_name, {
                    "type": "users_updated",
                    "users": [u.to_dict() for u in users]
                })
                await websocket.send_json({
                    "type": "user_updated",
                    "user": user.to_dict()
                })
            elif msg_type == "annotate":
                point_indices = msg.get("point_indices", [])
                label = msg.get("label", "")
                if not point_indices or not label:
                    continue
                user.last_active = time.time()
                store.update_user(model_name, user)
                annotations = store.annotate_points(model_name, point_indices, label, user)
                await manager.broadcast(model_name, {
                    "type": "annotations_added",
                    "annotations": [a.to_dict() for a in annotations],
                    "by_user": user_id
                })
            elif msg_type == "remove_annotation":
                point_index = msg.get("point_index")
                if point_index is None:
                    continue
                store.remove_annotation(model_name, point_index)
                await manager.broadcast(model_name, {
                    "type": "annotation_removed",
                    "point_index": point_index,
                    "by_user": user_id
                })
            elif msg_type == "ping":
                user.last_active = time.time()
                store.update_user(model_name, user)
                await websocket.send_json({"type": "pong", "timestamp": time.time()})
    except WebSocketDisconnect:
        pass
    finally:
        if user_id:
            store.remove_user(model_name, user_id)
            manager.disconnect(model_name, user_id)
            users = store.get_users(model_name)
            await manager.broadcast(model_name, {
                "type": "users_updated",
                "users": [u.to_dict() for u in users]
            })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
