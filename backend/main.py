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
from annotation_store import store, User, PointAnnotation, LockInfo
from segmentation import run_segmentation


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


@app.get("/api/models/{model_name}/locks")
async def get_locks(model_name: str):
    locks = store.get_all_locks(model_name)
    result = []
    for idx, lock in locks.items():
        result.append(lock.to_dict())
    return {"locks": result}


@app.post("/api/models/{model_name}/locks/acquire")
async def acquire_lock(model_name: str, payload: Dict[str, Any]):
    point_index = payload.get("point_index")
    center_point = payload.get("center_point")
    positions = payload.get("positions")
    user_id = payload.get("user_id")
    username = payload.get("username", "unknown")
    user_color = payload.get("user_color", "#ff0000")
    radius = payload.get("radius", 1.0)
    ttl = payload.get("ttl", 5)

    if point_index is None or center_point is None or positions is None or user_id is None:
        raise HTTPException(status_code=400, detail="Missing required fields")

    user = User(user_id=user_id, username=username, color=user_color)
    lock = store.acquire_lock(model_name, point_index, center_point, positions, user, radius, ttl)

    if lock is None:
        existing_lock = store.is_point_locked(model_name, point_index)
        return {
            "success": False,
            "lock": None,
            "existing_lock": existing_lock.to_dict() if existing_lock else None,
            "message": existing_lock.username if existing_lock else "Failed to acquire lock"
        }

    await manager.broadcast(model_name, {
        "type": "lock_acquired",
        "lock": lock.to_dict(),
        "by_user": user_id
    })

    return {
        "success": True,
        "lock": lock.to_dict(),
        "message": "Lock acquired"
    }


@app.post("/api/models/{model_name}/locks/release")
async def release_lock(model_name: str, payload: Dict[str, Any]):
    point_index = payload.get("point_index")
    user_id = payload.get("user_id")

    if point_index is None or user_id is None:
        raise HTTPException(status_code=400, detail="Missing required fields")

    success = store.release_lock(model_name, point_index, user_id)

    if success:
        await manager.broadcast(model_name, {
            "type": "lock_released",
            "point_index": point_index,
            "by_user": user_id
        })

    return {"success": success}


@app.get("/api/models/{model_name}/conflict-logs")
async def get_conflict_logs(model_name: str, limit: int = 100):
    logs = store.get_conflict_logs(model_name, limit)
    return {"logs": logs}


@app.post("/api/models/{model_name}/segment")
async def segment_auto(model_name: str, payload: Dict[str, Any]):
    positions = payload.get("positions")
    normals = payload.get("normals")
    seed_points = payload.get("seed_points", {})
    method = payload.get("method", "auto")
    if not positions or not seed_points:
        raise HTTPException(status_code=400, detail="Missing positions or seed_points")
    total_seeds = sum(len(v) for v in seed_points.values())
    if total_seeds == 0:
        raise HTTPException(status_code=400, detail="No seed points provided")
    try:
        result = run_segmentation(
            positions, normals, seed_points, method=method
        )
        total_predicted = sum(len(v) for v in result.values())
        return {
            "success": True,
            "seed_points": seed_points,
            "predicted_labels": result,
            "total_seeds": total_seeds,
            "total_predicted": total_predicted,
            "method": method,
            "per_label_counts": {k: len(v) for k, v in result.items()}
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Segmentation failed: {str(e)}")


@app.post("/api/models/{model_name}/segment/apply")
async def apply_segmentation(model_name: str, payload: Dict[str, Any]):
    user_id = payload.get("user_id")
    username = payload.get("username", "unknown")
    user_color = payload.get("user_color", "#ffffff")
    predictions = payload.get("predictions", {})
    if not user_id or not predictions:
        raise HTTPException(status_code=400, detail="Missing required fields")
    user = User(user_id=user_id, username=username, color=user_color)
    all_annotations = []
    for label, point_indices in predictions.items():
        if not point_indices or not label:
            continue
        new_indices = []
        for idx in point_indices:
            existing = store.get_annotation(model_name, idx)
            if existing is None:
                new_indices.append(idx)
        if new_indices:
            annotations = store.annotate_points(model_name, new_indices, label, user)
            all_annotations.extend(annotations)
    annotations_dicts = [a.to_dict() for a in all_annotations]
    if annotations_dicts:
        await manager.broadcast(model_name, {
            "type": "annotations_added",
            "annotations": annotations_dicts,
            "by_user": user_id
        })
    return {
        "success": True,
        "applied_count": len(all_annotations),
        "annotations": annotations_dicts
    }


@app.get("/api/models/{model_name}/versions")
async def list_versions(model_name: str):
    versions = store.list_versions(model_name)
    return {"versions": versions}


@app.post("/api/models/{model_name}/versions")
async def save_version(model_name: str, payload: Dict[str, Any]):
    user_id = payload.get("user_id")
    username = payload.get("username", "unknown")
    user_color = payload.get("user_color", "#ffffff")
    name = payload.get("name")
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")
    user = User(user_id=user_id, username=username, color=user_color)
    version_info = store.save_version(model_name, user, name=name)
    await manager.broadcast(model_name, {
        "type": "version_saved",
        "version": {
            "version_id": version_info["version_id"],
            "name": version_info["name"],
            "created_at": version_info["created_at"],
            "created_by_username": version_info["created_by_username"],
            "created_by_color": version_info["created_by_color"],
            "annotations_count": version_info["annotations_count"]
        }
    })
    return {"version": version_info}


@app.post("/api/models/{model_name}/versions/{version_id}/restore")
async def restore_version(model_name: str, version_id: str, payload: Dict[str, Any]):
    user_id = payload.get("user_id")
    username = payload.get("username", "unknown")
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")
    result = store.restore_version(model_name, version_id)
    if not result:
        raise HTTPException(status_code=404, detail="Version not found")
    all_annotations = store.get_all_annotations(model_name)
    annotations_list = []
    for idx, ann in all_annotations.items():
        annotations_list.append(ann.to_dict())
    tags = store.get_tags(model_name)
    await manager.broadcast(model_name, {
        "type": "version_restored",
        "version_id": version_id,
        "version_name": result.get("name", version_id),
        "annotations": annotations_list,
        "tags": tags,
        "restored_by": {"user_id": user_id, "username": username}
    })
    return {
        "success": True,
        "version_id": version_id,
        "annotations_restored": len(annotations_list),
        "tags_restored": tags
    }


@app.delete("/api/models/{model_name}/versions/{version_id}")
async def delete_version(model_name: str, version_id: str):
    success = store.delete_version(model_name, version_id)
    return {"success": success}


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
        locks = store.get_all_locks(model_name)
        locks_list = []
        for idx, lock in locks.items():
            locks_list.append(lock.to_dict())
        await websocket.send_json({
            "type": "locks_init",
            "locks": locks_list
        })
        versions = store.list_versions(model_name)
        await websocket.send_json({
            "type": "versions_init",
            "versions": versions
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
                lock_point_index = msg.get("lock_point_index")
                if not point_indices or not label:
                    continue
                user.last_active = time.time()
                store.update_user(model_name, user)
                annotations = store.annotate_points(model_name, point_indices, label, user)
                if lock_point_index is not None:
                    store.release_lock(model_name, lock_point_index, user_id)
                    await manager.broadcast(model_name, {
                        "type": "lock_released",
                        "point_index": lock_point_index,
                        "by_user": user_id
                    })
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
            elif msg_type == "lock_acquire":
                point_index = msg.get("point_index")
                center_point = msg.get("center_point")
                positions = msg.get("positions")
                radius = msg.get("radius", 1.0)
                ttl = msg.get("ttl", 5)
                if point_index is None or center_point is None or positions is None:
                    continue
                lock = store.acquire_lock(model_name, point_index, center_point, positions, user, radius, ttl)
                if lock:
                    await manager.broadcast(model_name, {
                        "type": "lock_acquired",
                        "lock": lock.to_dict(),
                        "by_user": user_id
                    })
                    await websocket.send_json({
                        "type": "lock_acquired_ack",
                        "success": True,
                        "lock": lock.to_dict()
                    })
                else:
                    existing_lock = store.is_point_locked(model_name, point_index)
                    await websocket.send_json({
                        "type": "lock_acquired_ack",
                        "success": False,
                        "existing_lock": existing_lock.to_dict() if existing_lock else None,
                        "message": existing_lock.username if existing_lock else "Failed to acquire lock"
                    })
            elif msg_type == "lock_release":
                point_index = msg.get("point_index")
                if point_index is None:
                    continue
                success = store.release_lock(model_name, point_index, user_id)
                if success:
                    await manager.broadcast(model_name, {
                        "type": "lock_released",
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
