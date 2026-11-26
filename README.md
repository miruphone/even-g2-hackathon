<img src="assets/logo.png" alt="Warden logo" width="120" align="right">

# Warden: guard your Telegram groups without reading them

Warden is an Even Realities G2 app for people who run Telegram communities. A bot sits in your groups as an admin. When a scam account shows up, your glasses show one verdict card, never the message itself. You pick an action with the ring and tap once.

```
■■■■ SCAM                    auto-muted · +1 waiting
┌──────────────────────────────────────────────┐
│ Fake TON airdrop claim link                  │
│ @ton_rewards_drop · 3 groups · 3 msgs        │
│ AI ● Airdrop bait with a wallet-connect link │
└──────────────────────────────────────────────┘
 [Ban + purge (3 groups)]          ← swipe picks, tap runs
  Ban + purge + warn (3 groups)
  Mute 24h + delete (3 groups)
  Not spam: trust user
```

After the tap, the same card stays up for 5 seconds (`▶ Banning @ton_rewards_drop in 3 groups · Hold to undo ■■■□□`, plus the exact warning it will post), then a result screen shows what Telegram confirmed: `Banned in 3 groups · 3 msgs removed · live 11s · warning posted`.

**Track:** 01 Messaging & News (Telegram). Also entered for Best Telegram integration.

**Demo video (2:56):** https://youtu.be/i-VfNVTMjZw

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
5. **You decide in one tap.** The card shows the verdict, who and where, and one reason (the AI's, or the strongest rule). Swipe through the actions and tap one. Warden mutes the account right away, keeps the card on screen for 5 seconds so you can hold to undo, and then bans the account and deletes its messages in every affected group. The result says how long the scam stayed visible.
6. **AI writes the follow-up, and you see it first.** "Ban + purge + warn" posts a short warning drafted in advance by the LLM and shown on the glasses during the undo window. Drafts with links, handles or markdown fall back to a template.
7. **The AI is a second opinion, not a hair trigger.** When the rules mute someone who was only warning others about a scam (quoting its link), the AI reads the intent, lifts the mute and turns the card into LIKELY OK with "Not spam: trust user" first.

### Glasses controls

| Gesture | Card | Idle | Recent |
|---|---|---|---|
| Swipe | choose an action | - | scroll |
| Tap | run the action | open recent actions | back |
| Hold | undo the last action (5 s window) | undo | undo |
| Double tap | exit | exit | exit |
| Context menu | undo, auto-mute on/off, recent, unpair (asks to confirm) | | |

The phone page inside the Even app handles pairing, lists your groups with any missing bot rights and how to fix them, and keeps the record: each incident with its message (phone only), the AI's reason, the warning that would be or was posted, and the outcome.

### In Telegram

- Pair by sending the 6-digit code from the glasses to the bot (the phone's "Open Telegram and pair" link does it for you).
- When you add, promote or remove the bot, it DMs you what it can do in that group, or exactly which right is missing and where to turn it on. `/status` repeats this any time. An "Add Warden to a group" button opens Telegram's group picker with Delete messages, Ban users and Invite users pre-selected.
- Groups stay quiet: the only posts are the warning you chose to send and a one-line notice when a raid lock pauses and reopens the chat.

### Built for the G2 platform limits

- **Foreground only.** Warden is a "moderation shift" you open while hosting or working. While it is closed, the bot keeps scoring messages and auto-muting the worst cases, so a full queue waits for you when you come back.
- **Design for a glance.** One card, three lines, at most four actions. The first action is always the safest sensible default.
- **Keys stay on the backend.** The app holds only a session token. You pair it by sending `/pair 123456` to the bot, or by tapping "Open Telegram" on the phone page. Google sign-in is not needed.

## Privacy and safety

- The glasses never show message text, only Warden's verdict. Message text is kept in the backend's memory only (never written to disk) and shown only on the admin's phone.
- Messages the rules flag or cannot settle are sent to the configured LLM provider (OpenAI by default, or Claude) for a verdict, with the sender's display name and the group title. Set `WARDEN_LLM=none` to keep everything on your server and run on rules only. Admins' own messages are never checked.
- Actions run only in groups where the paired Telegram account is an admin, and the server checks this on every action.
- Each destructive action starts with a mute that can be undone and gives a 5-second undo window. "Not spam: trust user" lifts the auto-mute and whitelists the user in that group.
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

Open http://localhost:8081. Copy the pairing code from the glasses into the "DM bot as admin" box, then press the scenario buttons: drainer bot, fake admin, a member warning about the drainer, raid, join requests.

To play the whole demo hands-free (scenarios, ring gestures and captions on the `/stage` overlay): `npm run demo`. `npm run demo:record` also records it with OBS Studio, composing the G2Sim window and the overlay offscreen (`tools/demo/obs.ts`).

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

- `tools/tgmock/`: a mock Telegram Bot API with scripted attacks, a live viewer, and a `/stage` overlay (simulated Telegram, captions) for recording.
- `tools/demo/`: the scripted demo take and the OBS recording controller.
- `src/dev/emulator.ts` + `tools/emulator/`: hardware emulator for the desktop simulator (ring, left temple, long press, context menu, IMU, location), with a control panel at `/__emu` and a WebSocket hub at `/__emu/ws`. Scriptable: `curl -X POST localhost:5173/__emu/send -d '{"type":"input","source":"ring","gesture":"tap"}'`.
- `unreal/G2Sim/`: an Unreal Engine 5.8 desktop and Quest simulator that shows the live glasses display over a 3D first-person view. See [unreal/G2Sim/README.md](unreal/G2Sim/README.md).

Known simulator differences: a double tap closes the app at once with no confirmation. Opening the context menu emits foreground enter and exit events. A Vite full reload makes `createStartUpPageContainer` return `1`, and the app falls back to `rebuildPageContainer`.

## What existed before the hackathon (Nov 23)

Only the official Even Hub minimal starter (commit `843ac2b`). Everything else was built during the build week: the emulator, the G2Sim simulator, the Telegram mock and Warden itself.

## Pack

```bash
npm run pack   # build + evenhub pack → .ehpk
```
