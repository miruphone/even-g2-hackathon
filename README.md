# Warden: guard your Telegram groups without reading them

Warden is an Even Realities G2 app for people who run Telegram communities. A bot sits in your groups as an admin. When a scam account shows up, your glasses show one verdict card, never the message itself. You pick an action with the ring and tap once.

```
■■■■ SCAM   1/2                        auto-muted
┌──────────────────────────────────────────────┐
│ Wallet-drainer link                          │
│ @ton_rewards_drop · 3 groups · 3 msgs        │
│ Airdrop / claim bait · Joined 1m ago         │
└──────────────────────────────────────────────┘
 ▶ Ban + purge (3 groups)          ← tap
   Ban + purge + warn group
   Mute 24h
   Not spam - trust
```

**Track:** 01 Messaging & News (Telegram). Also entered for Best Telegram integration.

## The problem

Every crypto and Web3 project runs on Telegram groups, and every launch, AMA and airdrop brings a wave of attacks:

- drainer bots that post fake "claim your airdrop" links,
- accounts that copy an admin's name and photo and DM members to offer "support",
- raids where dozens of accounts join in a minute.

Admins catch these by reading every message on their phone, often while they host the AMA or speak on stage. A scam link that stays up for five minutes can empty members' wallets.

## Who it is for

Community managers and moderators of busy Telegram groups, crypto projects first. They already pay for anti-spam bots (Combot, Rose, Shieldy), but those bots either over-block or leave the judgment calls to a human staring at a phone.

## How it works

1. **The bot watches.** Add `@<your bot>` to your groups as an admin. It reads new messages, joins and join requests.
2. **Rules score every message.** Fast, explainable signals: drainer-style links, airdrop and claim bait, seed-phrase requests, "DM me" pitches, look-alike domains, accounts that clone an admin's name, floods, the same text across groups, join spikes, and risky join requests. When the rules are unsure, an LLM (OpenAI or Claude) reviews the message and returns a short verdict.
3. **Related events become one card.** The same account or the same text across three groups is one incident, not three.
4. **The worst cases are stopped at once.** High-confidence scams and impersonators are muted at once, which can be undone. A human makes the final call.
5. **You decide in one tap.** The card shows the verdict and the evidence. Swipe through the actions and tap one. Warden mutes the account right away, waits 5 seconds so you can hold to undo, and then bans the account and deletes its messages in every affected group.
6. **AI writes the follow-up.** "Ban + purge + warn group" posts a short warning that the LLM drafts, for example: "Admins never DM first. There is no claim link."

### Glasses controls

| Gesture | Card | Idle | Recent |
|---|---|---|---|
| Swipe | choose an action | - | scroll |
| Tap | run the action | open recent actions | back |
| Hold | undo the last action (5 s window) | undo | undo |
| Double tap | exit | exit | exit |
| Context menu | undo, auto-mute on/off, recent, unpair | | |

The phone page inside the Even app handles pairing, lists your groups and shows each incident in detail when you want to read it later.

### Built for the G2 platform limits

- **Foreground only.** Warden is a "moderation shift" you open while hosting or working. While it is closed, the bot keeps scoring messages and auto-muting the worst cases, so a full queue waits for you when you come back.
- **Design for a glance.** One card, three lines, at most four actions. The first action is always the safest sensible default.
- **Keys stay on the backend.** The app holds only a session token. You pair it by sending `/pair 123456` to the bot, or by tapping "Open Telegram" on the phone page. Google sign-in is not needed.

## Privacy and safety

- The glasses never show message text, only Warden's verdict. Message text stays on the backend in memory and is shown only on the admin's phone.
- Actions run only in groups where the paired Telegram account is an admin, and the server checks this on every action.
- Each destructive action starts with a mute that can be undone and gives a 5-second undo window. "Not spam - trust" lifts the auto-mute and whitelists the user in that group.
- The classifier treats message text as untrusted data, so injected instructions are only evidence. It is told to be conservative about normal crypto conversation.
- No funds and no trading are involved.

## Architecture

```
Telegram  ──getUpdates──►  server/ (Node 26, TypeScript)  ◄──HTTPS long poll──  src/ (G2 app in the Even app WebView)
   ▲                         detect.ts   rules + scoring                          app.ts    cards, gestures
   └──── Bot API actions ─── classify.ts LLM review + warning drafts           api.ts    session token, feed, actions
                             engine.ts   incidents, auto-mute, act/undo/commit    phone.ts  phone page
                             index.ts    HTTP API + bot loop
```

## Run it

Requirements: Node 26+, the Even Hub simulator (installed as a dev dependency).

```bash
npm install
```

### With the Telegram mock (no bot needed)

```bash
npm run tgmock        # mock Bot API + live group viewer on http://localhost:8081
npm run server:mock   # Warden backend on :8787 against the mock
npm run dev           # glasses app on :5173 (proxies /api to :8787)
npm run simulate      # Even Hub simulator
```

Open http://localhost:8081. Copy the pairing code from the glasses into the "DM bot as admin" box, then press the scenario buttons: drainer bot, fake admin, raid, join requests.

### With a real bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   WARDEN_OPENAI_API_KEY=sk-...      # optional: OpenAI reviews unclear messages and drafts warnings
   # or ANTHROPIC_API_KEY=sk-ant-... to use Claude instead; with neither, Warden runs on rules only
   ```
3. `npm run server`, then `npm run dev` and `npm run simulate`.
4. Add the bot to a group as an admin with "Delete messages" and "Ban users". You must be an admin of that group too.
5. Send the pairing code shown on the glasses to the bot.

Environment variables for the backend: `PORT` (8787), `TELEGRAM_API_BASE`, `WARDEN_DATA` (data/warden.json), `WARDEN_LLM` (openai, claude or none; default: whichever key is set), `OPENAI_MODEL` (gpt-5.4-nano), `WARDEN_MODEL` (claude-opus-5-5), `CORS_ORIGINS` (*). Use `WARDEN_OPENAI_API_KEY` rather than `OPENAI_API_KEY` in `.env`: Node does not let `.env` override a variable that is already set system-wide. For the app: `VITE_WARDEN_API` (the backend URL in production builds).

## Development tools in this repo

- `tools/tgmock/`: a mock Telegram Bot API with scripted attacks and a live viewer.
- `src/dev/emulator.ts` + `tools/emulator/`: hardware emulator for the desktop simulator (ring, left temple, long press, context menu, IMU, location), with a control panel at `/__emu` and a WebSocket hub at `/__emu/ws`. Scriptable: `curl -X POST localhost:5173/__emu/send -d '{"type":"input","source":"ring","gesture":"tap"}'`.
- `unreal/G2Sim/`: an Unreal Engine 5.8 desktop and Quest simulator that shows the live glasses display over a 3D first-person view. See [unreal/G2Sim/README.md](unreal/G2Sim/README.md).

Known simulator differences: a double tap closes the app at once with no confirmation. Opening the context menu emits foreground enter and exit events. A Vite full reload makes `createStartUpPageContainer` return `1`, and the app falls back to `rebuildPageContainer`.

## What existed before the hackathon (Nov 23)

Only the official Even Hub minimal starter (commit `843ac2b`). Everything else was built during the build week: the emulator, the G2Sim simulator, the Telegram mock and Warden itself.

## Pack

```bash
npm run pack   # build + evenhub pack → .ehpk
```
