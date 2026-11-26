# Third-party assets

| Asset in the project | Source | Author | License |
|---|---|---|---|
| `Content/World/Bund/HDRI_ShanghaiBund` (8K HDR, imported as a cubemap) | [Shanghai Bund](https://polyhaven.com/a/shanghai_bund) on Poly Haven, file `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/8k/shanghai_bund_8k.hdr` | Greg Zaal | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([Poly Haven license](https://polyhaven.com/license)) |

CC0 needs no attribution and allows commercial use, redistribution in this public repo and use in a public video. Credit is given here anyway.

Engine content used at runtime (Unreal Engine EULA, ships with UE): the `HDRIBackdrop` plugin (dome mesh, projection materials, sky light blueprint) and `/Engine/BasicShapes` (invisible floor and walls, the `-world=basic` city).

## Rebuilding the world

The map is generated, so it can be rebuilt from the original files:

```bash
# 1. download (stdlib Python; keep the directory outside the repo)
python unreal/G2Sim/Scripts/fetch_assets.py C:\G2SimDownloads
# 2. import + build /Game/World/Bund/Bund (editor closed)
set G2SIM_DOWNLOADS=C:\G2SimDownloads
set G2SIM_REIMPORT=1
UnrealEditor-Cmd.exe unreal/G2Sim/G2Sim.uproject -run=pythonscript -script=unreal/G2Sim/Scripts/build_world.py -unattended -nosplash
```

Without `G2SIM_REIMPORT=1` the existing HDRI asset is kept and only the map is rebuilt (handy for tuning yaw, exposure or intensity at the top of `build_world.py`).
