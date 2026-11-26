# G2Sim — Unreal simulator for the G2 glasses

Walk a 3D scene in first person and see the **live glasses display** of the app you are developing, laid over your view like the real waveguide. Head movement becomes IMU data, walking becomes GPS, and mouse / keyboard become temple, ring and context-menu input. No XR device needed.

```
 G2Sim.exe  ──ws://127.0.0.1:5173/__emu/ws──▶  Vite dev server (emulator hub)  ──▶  your app in the Even Hub simulator
            ◀── glasses frames (PNG), app state ──
```

## Use it (teammates: no Unreal install needed)

1. In the repo: `npm install`, then `npm run dev` and `npm run simulate` (two terminals).
2. Download `G2Sim-Win64.zip` from the GitHub Releases page, unzip, run `G2Sim.exe`.
3. It connects by itself; the bottom bar turns green. Edits to the app reload as usual and show up in G2Sim.

Another machine or port: `G2Sim.exe -hub=ws://192.168.1.20:5173/__emu/ws`.

## Worlds

- **Shanghai Bund at night** (default): you stand on the Bund promenade looking across the river at the Pudong skyline. It is a photographic 360° HDRI (CC0, see [ASSETS.md](ASSETS.md)) on the engine's HDRI Backdrop, so it looks real as long as you mostly turn your head; walking is limited to about 15 m around the capture point, where the projection holds up.
- **Basic city block**: `-world=basic` opens the old procedural streets (daylight, simple shapes).

## Recording a demo (`-cinematic`)

```bash
G2Sim.exe -cinematic -cinepitch=10 -cineyaw=4
# without packaging:
UnrealEditor.exe <repo>/unreal/G2Sim/G2Sim.uproject -game -windowed -ResX=1920 -ResY=1080 -cinematic -cinepitch=10 -cineyaw=4
```

A 1920x1080 window with only the glasses display: no help, status bar, toasts or engine on-screen messages, no cursor. The head looks around by itself, slowly (about ±14° yaw, ±2° pitch, ±1° roll, fading in over the first 6 s). Mouse clicks and gesture keys are ignored, so all gestures come from outside through the hub.

| Option / key | Effect |
|---|---|
| `-cinepitch=` / `-cineyaw=` | Framing in degrees relative to the start (pitch up is positive). `10` / `4` keeps the glasses display over the dark sky above the Bund skyline |
| `-cineamount=` | Scales the motion (`0` = still, `0.5` = calmer) |
| `-hudx=` / `-hudscale=` | Glasses display: horizontal shift in 1920-wide pixels (positive = right) / size factor. Also work without `-cinematic` |
| P | Pause / resume the motion |
| G, [ ], PgUp / PgDn | Glasses display on/off, size, height |
| Esc | Free the mouse (click to take it back) |

On a display scaled above 100 %, Windows may show the window larger than 1920x1080; the game still renders 1920x1080, so capture the game (e.g. OBS Game Capture) rather than a screen region.

## Controls

| Input | Action |
|---|---|
| Mouse / WASD / Shift | Look / walk (1.4 m/s) / run |
| Q / E | Tilt head (roll) |
| Left click | Tap |
| Wheel or Up / Down | Swipe up / down |
| X | Double tap (in the simulator this closes the app) |
| Hold F | Long press |
| 1 / 2 / 3 or Tab | Input source: right temple / ring / left temple |
| Right click or C | Context menu (wheel to choose, click to send) |
| G, [ ], PgUp / PgDn | Glasses display on/off, size, height |
| H / Esc | Help / free the mouse |

Right-temple gestures and list scrolling go through the simulator itself (the firmware scrolls lists); ring and left-temple gestures, long presses and menu clicks are injected by the emulator. See the repo README.

## VR (Meta Quest 2 / 3 over Link)

1. Install the Meta Quest Link app on the PC. In **Settings → General → OpenXR Runtime**, make Meta Quest Link the active runtime (another runtime such as Varjo or SteamVR may be active).
2. Connect the headset with Link (cable) or Air Link, then start `G2Sim.exe -vr`.
3. The glasses display is a head-locked layer about 24° wide and slightly above the centre of view. A small info panel below it shows the input source, connection, the context menu and the last action.

| Controller | Action |
|---|---|
| Left stick (click: run) | Walk where you look |
| Right stick left / right | Snap turn 30° |
| Right stick up / down | Swipe up / down (in the menu: choose) |
| Right trigger | Tap (in the menu: send) |
| A / hold B | Double tap / long press |
| Right grip | Context menu open / close |
| X | Input source: right temple → ring → left temple |
| Y | Info panel on / off |
| Hold left grip + right stick | Display height (up/down) and size (left/right) |

Your real head movement is the IMU stream. The PC window mirrors the left eye, without the compositor layers.

## Sensors

- **IMU** — while the app has IMU on, the camera's pitch / yaw / roll in degrees are streamed as x / y / z (20 Hz into the emulator, which reports at the app's requested pace). Real-device units and axes are undocumented; this matches the emulator's assumption.
- **GPS** — position is sent once a second: +X is north, +Y is east, the origin is Tokyo Station (35.681236, 139.767125). Heading is the view yaw; speed is the walking speed.
- **Microphone** — the Even Hub simulator uses the PC microphone directly.

## Build (developers with Unreal)

Requires UE 5.8 and Visual Studio 2026 (MSVC 14.38+, not 14.40–14.43).

```bash
# editor build (close any open UE editor first: Live Coding blocks the build)
Build.bat G2SimEditor Win64 Development -Project=<repo>/unreal/G2Sim/G2Sim.uproject -WaitMutex -NoHotReload
# run without packaging
UnrealEditor.exe <repo>/unreal/G2Sim/G2Sim.uproject -game -windowed -ResX=1600 -ResY=900
# package G2Sim.exe into unreal/G2Sim/Packaged/Windows
RunUAT.bat BuildCookRun -project=<repo>/unreal/G2Sim/G2Sim.uproject -platform=Win64 -clientconfig=Shipping -build -cook -stage -pak -iostore -archive -archivedirectory=<repo>/unreal/G2Sim/Packaged -nop4 -unattended
```

`package.ps1` does the packaging and the zip in one step: `powershell -ExecutionPolicy Bypass -File unreal/G2Sim/package.ps1`.

Packaging takes ~1 minute once shaders are cached (the first run compiles shaders for much longer). Zip `Packaged/Windows` without the `.pdb` (~220 MB) for a release.

With the Varjo OpenXR runtime active, the cooker never exited. `package.ps1` points `XR_RUNTIME_JSON` at no runtime for the build, so packaging works whatever runtime is active.

The default world (`Content/World/Bund`) is generated by `Scripts/build_world.py` from a downloaded HDRI (`Scripts/fetch_assets.py`); see [ASSETS.md](ASSETS.md) for sources, licenses and the rebuild commands. `.uasset` / `.umap` files are tracked with Git LFS (`.gitattributes`). The first launch from the editor builds the 8K cubemap into the DDC (about half a minute, the view is grey until then); packaged builds ship it cooked.

## Code

| File | Role |
|---|---|
| `G2HubSubsystem` | WebSocket client, reconnects every 2 s, PNG → texture, app state, outgoing commands; `-world=basic` map switch |
| `G2SimPlayerController` | Polled keyboard / mouse and Touch controller input, IMU and GPS streaming, `-cinematic` look-around |
| `G2SimHUD` | Desktop: glasses overlay (with glow), status bar, help, context menu. VR: face-locked layers for the glasses and the info panel |
| `G2FaceLayer` | Head-locked OpenXR quad layer placed by distance, angular width and pitch |
| `G2SimGameMode` | On an empty map (`-world=basic`): procedural city block, sun / sky / fog, player start |
| `G2SimCharacter` | First-person walker; desktop camera follows mouse look + roll, VR camera follows the headset |
