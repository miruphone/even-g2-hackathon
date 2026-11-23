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

Packaging takes ~1 minute once shaders are cached (the first run compiles shaders for much longer). Zip `Packaged/Windows` without the `.pdb` (~220 MB) for a release.

The OpenXR plugin is disabled for now: with it on, the cooker hung on exit on a PC that has the Varjo OpenXR runtime. It comes back with the VR mode.

The scene is built in C++ (`AG2SimGameMode`) on the engine's empty map, so the project has no binary assets yet. Future `.uasset` / `.umap` files are tracked with Git LFS (`.gitattributes`).

## Code

| File | Role |
|---|---|
| `G2HubSubsystem` | WebSocket client, reconnects every 2 s, PNG → texture, app state, outgoing commands |
| `G2SimPlayerController` | Polled keyboard / mouse controls, IMU and GPS streaming |
| `G2SimHUD` | Glasses overlay (with glow), status bar, help, context menu |
| `G2SimGameMode` | Procedural city block, sun / sky / fog, player start |
| `G2SimCharacter` | First-person walker, camera follows the head roll |
