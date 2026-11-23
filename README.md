# G2 Feature Demo

A demo app for Even Realities G2 glasses that exercises every Even Hub SDK (0.0.16) feature on one screen each, plus a **hardware emulator** that adds what the desktop simulator cannot do: IMU, ring / left-temple input, device status, location, and camera / album.

Built for the [Heads Up: Even Realities Hackathon](https://dorahacks.io/hackathon/even-realities/detail). Started on 2026-11-23 from the official Even Hub `minimal` template (Vite + TypeScript + SDK + CLI + simulator).

## Run

```bash
npm install
npm run dev        # dev server on :5173 (also serves the emulator panel)
npm run simulate   # simulator with the automation API on :9898
```

Then open the emulator panel at **http://localhost:5173/__emu**.

On real glasses: `npx evenhub qr --url http://<your-ip>:5173`, then scan with the Even app. The emulator stays off there, so the real sensors are used.

## Controls (glasses)

| Gesture | Action |
|---|---|
| Swipe up / down | Move through the menu, or the screen's secondary action |
| Tap | Open the item, or the screen's main action |
| Long press (1.2 s or longer) | Back to the menu |
| Double tap | Exit dialog, on every screen |
| Context menu | "Back to menu" plus actions for the current screen |

## Screens

| # | Screen | What it shows |
|---|---|---|
| 1 | Input | Tap, double tap, swipes and long press, counted per source (right temple / left temple / ring) |
| 2 | Text | Borders, corner radius and padding; text brightness 0–4; 5 Hz in-place updates; Japanese and symbols; long text |
| 3 | List | Firmware-scrolled list (20 items) and selection events |
| 4 | Image | Four canvas-drawn images (clock, 16 grey levels, text, shapes) and send times |
| 5 | Microphone | Glasses or phone mic, level meter, peak, direction, speaker role (self / other) |
| 6 | Motion | IMU on/off, report interval, sparklines per axis, dominant axis |
| 7 | Location | One-shot fix, continuous updates, distance walked |
| 8 | Camera / photos | Phone camera or album, then downscaled to 16 grey levels and shown on the glasses |
| 9 | Device | Model, battery, wearing, charging, in-case, user info, launch source |
| 10 | Storage | Counter saved in the app's own storage, which survives restarts |

## Hardware emulator (development only)

The simulator rejects `imuControl`, the location APIs, `pickImageFromAlbum` and `captureImageFromCamera`. It only emits right-temple input and never sends status changes.

`src/dev/emulator.ts` wraps those bridge calls and injects real-format host events through `window._listenEvenAppMessage`, the entry point the SDK listens on, so the app code cannot tell them apart from real ones. `tools/emulator/` is a Vite plugin that serves the control panel and relays its commands over Vite's WebSocket.

- Right-temple gestures, and list scrolling and selection, go to the simulator's own automation API, because the firmware scrolls lists itself.
- Left-temple and ring gestures, long presses, menu clicks, IMU, status, location, lifecycle and photos are injected into the page.
- Scriptable: `curl -X POST localhost:5173/__emu/send -d '{"type":"input","source":"ring","gesture":"tap"}'`
- The emulator is active only inside the simulator (`?emu=1` / `?emu=0` to force). It is dev-server only and is not in `npm run build` or the `.ehpk`.
- **Assumption:** IMU units and axes are undocumented. Emulated values are head angles in degrees (x = nod, y = shake, z = tilt). Re-tune on hardware.

## Known simulator differences

- Double tap → `shutDownPageContainer(1)` closes the app immediately (no confirmation dialog). Restart the simulator.
- Opening or closing the context menu emits foreground enter / exit events.
- A Vite full reload makes `createStartUpPageContainer` return `1`. The app falls back to `rebuildPageContainer`.

## Layout

```
src/main.ts            boot: early listeners, emulator (dev), app
src/app.ts             router, global gestures, lifecycle
src/core/              bridge queue + page model, input parsing, UI/glyph helpers, canvas → PNG
src/screens/           one file per feature screen
src/dev/emulator.ts    in-page emulator (dev only)
tools/emulator/        Vite plugin + control panel
```

## Pack

```bash
npm run pack   # build + evenhub pack (--sdk-ver 0.0.16) → out.ehpk
```
