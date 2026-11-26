"""Build the default G2Sim world (/Game/World/Bund/Bund) from downloaded CC0 assets.

Run with the editor closed, after fetch_assets.py:

    set G2SIM_DOWNLOADS=C:\\path\\to\\downloads
    UnrealEditor-Cmd.exe <repo>/unreal/G2Sim/G2Sim.uproject -run=pythonscript
        -script=<repo>/unreal/G2Sim/Scripts/build_world.py -unattended -nosplash

Re-running rebuilds the map and keeps the imported HDRI; set G2SIM_REIMPORT=1
to import it again. Tune the look with the constants below.
"""
import os

import unreal

DOWNLOADS = os.environ.get("G2SIM_DOWNLOADS", "")
ROOT = "/Game/World"
MAP = ROOT + "/Bund/Bund"

EYE = 160.0  # cm, matches AG2SimCharacter (capsule 90 + camera 70)
# Yaw of the HDRI so that the Pudong skyline is due east (+Y), as on the real Bund.
HDRI_YAW = 180.0
HDRI_INTENSITY = 1.0
EXPOSURE_BIAS = -1.5
START_YAW = 90.0  # look east, across the river

REIMPORT_HDRI = os.environ.get("G2SIM_REIMPORT", "") == "1"


def log(msg):
    unreal.log_warning("[build_world] " + str(msg))


def import_file(path, dest, name=None):
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = dest
    if name:
        task.destination_name = name
    task.automated = True
    task.replace_existing = True
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = list(task.imported_object_paths)
    log(f"imported {path} -> {paths}")
    return paths


def import_assets():
    hdr = os.path.join(DOWNLOADS, "shanghai_bund", "shanghai_bund_8k.hdr")
    if REIMPORT_HDRI or not unreal.EditorAssetLibrary.does_asset_exist(ROOT + "/Bund/HDRI_ShanghaiBund"):
        if not os.path.isfile(hdr):
            raise RuntimeError("set G2SIM_DOWNLOADS to the fetch_assets.py output directory")
        import_file(hdr, ROOT + "/Bund", "HDRI_ShanghaiBund")
    cube = unreal.load_asset(ROOT + "/Bund/HDRI_ShanghaiBund")
    log(f"hdri class {cube.get_class().get_name()}")
    # Uncompressed half float: BC6H (TC_HDR_COMPRESSED) posterized the night sky.
    cube.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_HDR)
    unreal.EditorAssetLibrary.save_loaded_asset(cube)
    return cube


def build_level(cube):
    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    world = unreal.EditorLoadingAndSavingUtils.new_blank_map(False)
    if not world:
        raise RuntimeError("new_blank_map failed")

    def spawn(cls, loc, yaw=0.0, label=None):
        actor = eas.spawn_actor_from_class(cls, unreal.Vector(*loc), unreal.Rotator(0.0, 0.0, yaw))
        if label:
            actor.set_actor_label(label)
        return actor

    # Photographic backdrop: the HDRI on a dome with a projected floor that
    # catches shadows, plus a sky light lit by the same image.
    bp = unreal.EditorAssetLibrary.load_blueprint_class("/HDRIBackdrop/Blueprints/HDRIBackdrop")
    backdrop = spawn(bp, (0, 0, 0), HDRI_YAW, "HDRIBackdrop")
    backdrop.set_editor_property("Cubemap", cube)
    backdrop.set_editor_property("Intensity", HDRI_INTENSITY)
    backdrop.set_editor_property("ProjectionCenter", unreal.Vector(0, 0, EYE))
    log("backdrop ok")

    # Fixed exposure, so the night stays a night.
    ppv = spawn(unreal.PostProcessVolume, (0, 0, 0), 0.0, "PostProcess")
    ppv.set_editor_property("unbound", True)
    s = ppv.get_editor_property("settings")
    s.set_editor_property("override_auto_exposure_method", True)
    s.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
    s.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
    s.set_editor_property("auto_exposure_apply_physical_camera_exposure", False)
    s.set_editor_property("override_auto_exposure_bias", True)
    s.set_editor_property("auto_exposure_bias", EXPOSURE_BIAS)
    ppv.set_editor_property("settings", s)

    # Invisible floor to stand on (the backdrop has no collision).
    cube_mesh = unreal.load_asset("/Engine/BasicShapes/Cube")
    floor = spawn(unreal.StaticMeshActor, (0, 0, -50), 0.0, "Floor")
    smc = floor.static_mesh_component
    smc.set_static_mesh(cube_mesh)
    floor.set_actor_scale3d(unreal.Vector(80, 80, 1))
    floor.set_actor_hidden_in_game(True)
    smc.set_editor_property("cast_shadow", False)
    # Invisible walls keep the walker near the capture point, where the photo is true.
    for x, y, sx, sy in ((1500, 0, 1, 30), (-1500, 0, 1, 30), (0, 1500, 30, 1), (0, -1500, 30, 1)):
        wall = spawn(unreal.StaticMeshActor, (x, y, 200), 0.0, "Wall")
        wall.static_mesh_component.set_static_mesh(cube_mesh)
        wall.set_actor_scale3d(unreal.Vector(sx, sy, 4))
        wall.set_actor_hidden_in_game(True)
        wall.static_mesh_component.set_editor_property("cast_shadow", False)

    spawn(unreal.PlayerStart, (0, 0, 92), START_YAW, "PlayerStart")

    # Saving sometimes fails to open its temp file in Saved/ on the first try
    # (seen on Windows); a retry goes through.
    for _ in range(5):
        if unreal.EditorLoadingAndSavingUtils.save_map(world, MAP):
            break
        log("save failed, retrying")
    else:
        raise RuntimeError("save failed")
    log("saved " + MAP)


def main():
    cube = import_assets()
    build_level(cube)


main()
