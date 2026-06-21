import numpy as np
import trimesh
from pathlib import Path
import argparse


MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)


def create_car_model() -> trimesh.Trimesh:
    box_body = trimesh.creation.box(extents=[1.8, 0.8, 0.6])
    box_body.apply_translation([0, 0, 0.3])

    box_cabin = trimesh.creation.box(extents=[1.0, 0.7, 0.5])
    box_cabin.apply_translation([0, 0, 0.85])

    cyl_tire_fl = trimesh.creation.cylinder(radius=0.22, height=0.2, sections=24)
    cyl_tire_fl.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
    cyl_tire_fl.apply_translation([-0.6, 0.5, 0.22])
    cyl_tire_fr = cyl_tire_fl.copy()
    cyl_tire_fr.apply_translation([0, -1.0, 0])
    cyl_tire_rl = cyl_tire_fl.copy()
    cyl_tire_rl.apply_translation([1.2, 0, 0])
    cyl_tire_rr = cyl_tire_fr.copy()
    cyl_tire_rr.apply_translation([1.2, 0, 0])

    box_door_fl = trimesh.creation.box(extents=[0.85, 0.02, 0.5])
    box_door_fl.apply_translation([-0.1, 0.4, 0.55])
    box_door_fr = box_door_fl.copy()
    box_door_fr.apply_translation([0, -0.8, 0])

    meshes = [box_body, box_cabin, cyl_tire_fl, cyl_tire_fr,
              cyl_tire_rl, cyl_tire_rr, box_door_fl, box_door_fr]

    scene = trimesh.scene.scene.Scene()
    for m in meshes:
        scene.add_geometry(m)
    return scene.dump(concatenate=True)


def create_teapot_cube_model() -> trimesh.Trimesh:
    cube1 = trimesh.creation.box(extents=[0.8, 0.8, 0.8])
    cube1.apply_translation([0.6, 0, 0.4])

    cube2 = trimesh.creation.icosphere(subdivisions=3, radius=0.5)
    cube2.apply_translation([-0.6, 0, 0.5])

    cyl = trimesh.creation.cylinder(radius=0.3, height=1.2, sections=32)
    cyl.apply_translation([0, 0.6, 0.6])

    cone = trimesh.creation.cone(radius=0.4, height=0.8, sections=32)
    cone.apply_translation([0, -0.6, 0.4])

    scene = trimesh.scene.scene.Scene()
    for m in [cube1, cube2, cyl, cone]:
        scene.add_geometry(m)
    return scene.dump(concatenate=True)


def save_obj(mesh: trimesh.Trimesh, filename: str):
    path = MODELS_DIR / filename
    with open(path, 'w') as f:
        f.write(trimesh.exchange.obj.export_obj(mesh))
    print(f"Saved: {path} ({len(mesh.vertices)} vertices, {len(mesh.faces)} faces)")
    return path


def save_gltf(mesh: trimesh.Trimesh, filename: str):
    path = MODELS_DIR / filename
    with open(path, 'wb') as f:
        f.write(trimesh.exchange.gltf.export_glb(mesh))
    print(f"Saved: {path} ({len(mesh.vertices)} vertices, {len(mesh.faces)} faces)")
    return path


def main():
    parser = argparse.ArgumentParser(description="Generate sample 3D models for testing")
    parser.add_argument("--models", nargs="*", default=["car", "composite"],
                        choices=["car", "composite"], help="Which models to generate")
    args = parser.parse_args()

    generated = []
    if "car" in args.models:
        car = create_car_model()
        generated.append(save_obj(car, "car.obj"))
        generated.append(save_gltf(car, "car.glb"))
    if "composite" in args.models:
        comp = create_teapot_cube_model()
        generated.append(save_obj(comp, "composite.obj"))

    print(f"\nGenerated {len(generated)} model files in {MODELS_DIR}")
    print("You can now start the server and upload/use these models.")


if __name__ == "__main__":
    main()
