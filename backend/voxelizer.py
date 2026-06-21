import os
import numpy as np
import trimesh
from pathlib import Path
from typing import Tuple, List, Dict, Optional


MODELS_DIR = Path(__file__).parent / "models"
VOXELIZED_DIR = Path(__file__).parent / "voxelized"

MODELS_DIR.mkdir(exist_ok=True)
VOXELIZED_DIR.mkdir(exist_ok=True)

SUPPORTED_FORMATS = {'.obj', '.gltf', '.glb'}


def get_estimate_normals(points: np.ndarray, k: int = 10) -> np.ndarray:
    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(points)
        normals = np.zeros_like(points)
        for i in range(len(points)):
            distances, indices = tree.query(points[i], k=min(k, len(points)))
            neighbors = points[indices]
            centered = neighbors - neighbors.mean(axis=0)
            cov = np.dot(centered.T, centered)
            eigenvalues, eigenvectors = np.linalg.eigh(cov)
            normal = eigenvectors[:, np.argmin(eigenvalues)]
            if normal[2] < 0:
                normal = -normal
            normals[i] = normal
        return normals
    except ImportError:
        print("scipy not available, using z-up normals")
        normals = np.zeros_like(points)
        normals[:, 2] = 1.0
        return normals


def load_mesh(file_path: Path) -> trimesh.Trimesh:
    ext = file_path.suffix.lower()
    if ext == '.obj':
        mesh = trimesh.load(str(file_path), force='mesh')
    elif ext in ('.gltf', '.glb'):
        scene = trimesh.load(str(file_path), force='scene')
        meshes = []
        for geom in scene.geometry.values():
            if isinstance(geom, trimesh.Trimesh):
                meshes.append(geom)
        if len(meshes) == 0:
            raise ValueError("No meshes found in GLTF file")
        mesh = trimesh.util.concatenate(meshes)
    else:
        raise ValueError(f"Unsupported format: {ext}")

    if isinstance(mesh, trimesh.Scene):
        meshes = []
        for geom in mesh.geometry.values():
            if isinstance(geom, trimesh.Trimesh):
                meshes.append(geom)
        if len(meshes) == 0:
            raise ValueError("No meshes found")
        mesh = trimesh.util.concatenate(meshes)
    return mesh


def normalize_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    vertices = mesh.vertices - mesh.vertices.mean(axis=0)
    max_extent = np.max(np.abs(vertices))
    if max_extent > 0:
        vertices = vertices / max_extent
    mesh.vertices = vertices
    return mesh


def voxelize_mesh(mesh: trimesh.Trimesh, resolution: int = 64) -> Tuple[np.ndarray, np.ndarray]:
    voxelgrid = mesh.voxelized(pitch=2.0 / resolution, method='subdivide')
    voxelgrid = voxelgrid.fill()
    voxel_matrix = voxelgrid.matrix

    indices = np.argwhere(voxel_matrix)
    if len(indices) == 0:
        raise ValueError("Voxelization produced empty result")

    origin = np.array(voxelgrid.origin)
    pitch = voxelgrid.pitch
    centers = origin + (indices.astype(np.float64) * pitch + pitch / 2)

    normals = get_estimate_normals(centers)

    return centers, normals


def sample_surface_points(mesh: trimesh.Trimesh, num_points: int = 50000) -> Tuple[np.ndarray, np.ndarray]:
    points, face_indices = trimesh.sample.sample_surface(mesh, num_points)
    normals = mesh.face_normals[face_indices]
    return points, normals


def voxelize_file(file_path: str, resolution: int = 64, use_surface: bool = False) -> Dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    mesh = load_mesh(path)
    mesh = normalize_mesh(mesh)

    if use_surface:
        num_points = resolution * resolution * 2
        positions, normals = sample_surface_points(mesh, num_points=num_points)
    else:
        positions, normals = voxelize_mesh(mesh, resolution=resolution)

    positions = positions.astype(np.float32)
    normals = normals.astype(np.float32)

    result = {
        'positions': positions.tolist(),
        'normals': normals.tolist(),
        'num_points': len(positions),
        'bounds': {
            'min': positions.min(axis=0).tolist(),
            'max': positions.max(axis=0).tolist()
        }
    }
    return result


def save_voxelized(model_name: str, data: Dict) -> Path:
    out_path = VOXELIZED_DIR / f"{model_name}.json"
    import json
    with open(out_path, 'w') as f:
        json.dump(data, f)
    return out_path


def load_voxelized(model_name: str) -> Optional[Dict]:
    path = VOXELIZED_DIR / f"{model_name}.json"
    if not path.exists():
        return None
    import json
    with open(path, 'r') as f:
        return json.load(f)


def list_models() -> List[str]:
    models = []
    for f in MODELS_DIR.iterdir():
        if f.suffix.lower() in SUPPORTED_FORMATS:
            models.append(f.name)
    return sorted(models)


def save_uploaded_model(filename: str, content: bytes) -> Path:
    path = MODELS_DIR / filename
    with open(path, 'wb') as f:
        f.write(content)
    return path


def get_model_path(model_name: str) -> Optional[Path]:
    path = MODELS_DIR / model_name
    if path.exists():
        return path
    return None
