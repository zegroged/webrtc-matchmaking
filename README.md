# WebRTC Matchmaking Engine

> A real-time matchmaking engine and WebRTC signaling server, with a Flutter client for Android, iOS and Web.

[![tests](https://github.com/zegroged/webrtc-matchmaking/actions/workflows/test.yml/badge.svg)](https://github.com/zegroged/webrtc-matchmaking/actions/workflows/test.yml)
![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socket.io&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-Android%20%7C%20iOS%20%7C%20Web-02569B?logo=flutter&logoColor=white)
![SQLite](https://img.shields.io/badge/node%3Asqlite-built--in-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-27%20unit%20%2B%2050%20e2e-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

[Türkçe README](README.tr.md)

---

**How this was built:** the code was written with AI assistance and reviewed by the author.

## Overview

This project pairs strangers into short peer-to-peer video calls and lets both sides opt into a
lasting connection afterwards. The interesting part is not the video — `flutter_webrtc` handles
that — it is everything around it: deciding *who* should talk to *whom*, brokering the WebRTC
handshake between two clients that have never met, and keeping the system usable when the waiting
pool is tiny.

The two problems the codebase is actually built around are **match quality under starvation** and
**moderation that does not teach abusers how to evade it**. A naive matchmaker either pairs the
first two people it finds (quality is zero) or holds out for a perfect match (nobody ever gets
paired). The engine here scores every candidate pair on a weighted rubric and then *relaxes the
acceptance threshold as a user waits longer*, so a busy pool gets good matches and an empty pool
still gets matches. The moderation layer normalizes Turkish text against a set of evasion tricks
(leet substitution, accent stripping, separator injection, character repetition) and then, by
design, still delivers the flagged message, recording the flag and docking the sender's trust
score instead of blocking. Blocking tells an attacker exactly which word tripped the filter.

The backend is a single Node.js process: Express for REST, Socket.IO for the matchmaking queue and
signaling, and `node:sqlite` (built into modern Node) for persistence, so the whole system runs with
`npm install && npm start` and no external database, broker, or container. The Flutter client is one
codebase targeting Android, iOS and Web. A vanilla HTML/CSS/JS admin panel sits at `/admin` for the
report queue, user management, and a kill switch. **This is a technical prototype — it was never
launched and has no users. See [Known limitations](#known-limitations) before reading anything else
into it.**

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Client | Flutter (Dart 3.12) | One codebase for Android, iOS and Web |
| Video | `flutter_webrtc` 1.5 | P2P media; STUN by default, TURN via env vars |
| Realtime | Socket.IO 4.8 | Queue, signaling relay, chat, presence — with ack callbacks |
| Backend | Node.js 22.13+ / Express 4.21 | Minimal runtime dependencies (3 prod packages total) |
| Database | `node:sqlite` (`DatabaseSync`) | No DB server to install; WAL mode, foreign keys on |
| Auth | `jsonwebtoken` 9 + SMS OTP | 30-day user tokens, 12-hour admin tokens |
| Admin UI | Plain HTML/CSS/JS | No build step; served statically from `/admin` |

Backend production dependencies: `express`, `socket.io`, `jsonwebtoken`. That is the entire list.

**Size:** ~2,000 lines of backend source across 12 modules, ~1,500 lines of admin panel, ~350 lines
of unit tests, ~280 lines of end-to-end simulation, and ~4,000 lines of Dart (6 screens, a tab
shell, and the shared client plumbing). The schema is 11 SQLite tables; the HTTP surface is 28 REST
endpoints across three routers.

---

## Features

**Matchmaking (`server/src/matchmaking.js`)**
- Weighted pair scoring with hard-rule vetoes (no shared language, or either side blocked → pair is
  forbidden, not just penalized)
- Progressive threshold relaxation over four wait-time bands
- Longest-waiting user picks first, so nobody starves
- 5-minute re-match cooldown per pair; a pair that ended in a skip keeps a score penalty for a
  further 24 hours (held in memory, so it clears on restart)
- Admin kill switch that halts queue intake process-wide

**Signaling and call lifecycle (`server/src/sockets.js`)**
- SDP offer/answer and ICE candidate relay over Socket.IO, scoped to the match both sockets belong to
- ICE server list served from `/api/rtc-config` (two Google STUN servers by default, TURN injected
  from environment)
- `initiator` flag decided server-side so exactly one peer creates the offer
- Match end reasons tracked (`skip` / `leave` / `report` / `disconnect`) with duration
- One active socket per account; a second login evicts the first with `session:replaced`
- Client-side ICE candidate buffering until the remote description is set

**Connections and chat**
- Mutual opt-in: a friendship is created only when *both* sides tap add. A one-sided request is
  never shown on the call screen — it surfaces later in an inbox, so nobody feels pressured in the
  moment
- 90-second grace window to add someone after the call ends
- Persistent 1:1 messaging with read receipts, presence, and a 10-messages-per-5-seconds rate limit
- Declining a request is silent — the sender is never told

**Moderation (`server/src/moderation.js`)**
- Turkish + English text filter with multi-stage normalization
- Reports with an optional evidence frame captured from the live video track at report time, plus a
  chat excerpt for message reports
- Auto-suspension: 3 reports from 3 *distinct* users within 24h → 48-hour suspension
- Trust score (0–100) driven by reports, flagged messages, and call telemetry
- Report de-duplication so one user cannot drain another's trust score by re-reporting

**Admin panel (`server/public/admin/`)**
- Dashboard: online / queued / in-call counts, 24h match volume, average duration, skip rate,
  mutual-add rate, pending reports, and 24h message and flagged-message counts
- Report queue with evidence viewer and dismiss / warn / suspend / ban actions
- User search, ban list, and the emergency kill switch

**Account and safety plumbing**
- SMS OTP registration (6 digits, 5-minute TTL, 5 attempts, 30-second resend cooldown)
- 18+ gate at registration; birth date is immutable after signup
- Bans keyed on the phone hash, so a banned number cannot simply re-register
- In-app blocking (deletes the friendship and permanently vetoes future matches)
- In-app account deletion (transactional wipe + tombstone + socket eviction)

---

## Architecture / Design notes

### Progressive threshold relaxation

`Matchmaker.tick()` runs once per second. For each waiting user it scores every other candidate and
keeps the best one, then compares that score against a threshold derived from **how long the pair
has been waiting**:

```js
MATCH_THRESHOLDS: [
  { maxWaitMs:  5000, minScore:   60 },
  { maxWaitMs: 15000, minScore:   30 },
  { maxWaitMs: 30000, minScore:    0 },
  { maxWaitMs: Infinity, minScore: -200 },
]
```

Scoring is `+50` for the same conversation mood, `+15` per shared interest, `+max(0, 10 - ageGap)`
for age proximity, `-30` if this pair previously ended in a skip, `-100` if they are inside the
5-minute re-match cooldown, and `-10` if their average trust score is below 50.

The final `-200` band is the load-bearing decision. It means that after 30 seconds even the
`-100` cooldown penalty becomes surmountable — because in a pool of four people, refusing to
re-pair anyone means pairing nobody. The **hard rules survive every band**: `scorePair` returns
`null` (not a low score) when there is no shared language or when either side has blocked the
other, and `null` is unmatchable at any threshold. Soft preferences decay under pressure; safety
constraints do not. That distinction between "penalty" and "veto" is the core of the module.

### Flagging beats blocking

`checkText()` applies five normalization steps (Turkish case folding, accent stripping, leet
substitution, separator stripping, and character-repetition squeezing) and matches the wordlist
against every resulting variant. So `s.i.k.t.i.r`, `S1KT1R` and `siktiiiir` all resolve to the same
token.

The Turkish case-folding step is the one worth pointing at:

```js
// 'İ'.toLowerCase() produces 'i' + U+0307, so Turkish I/İ are mapped by hand first.
let t = String(text).replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase();
t = t.replace(/ı/g, 'i');
```

JavaScript's `toLowerCase()` decomposes `İ` (U+0130) into `i` followed by a combining dot above
(U+0307). Any downstream comparison against a plain `i` silently fails, and the filter leaks. The
explicit pre-mapping closes that.

The behavioral decision matters more than the string handling: a flagged message is **still
delivered**. The server stores `flagged = 1` and deducts 2 trust points from the sender. Rejecting
the message would turn the filter into an oracle — send, observe rejection, adjust, repeat, until
you find a spelling that passes. Silent flagging gives the attacker no signal while still building
the evidence trail the admin queue runs on.

### Trust score as accumulated telemetry

Trust is not a moderation verdict; it is a running signal that feeds *back into matchmaking*. It
moves on ordinary usage, not just on reports: being skipped within 5 seconds costs the skipped user
1 point, a call lasting over 2 minutes earns both sides 1 point, a flagged message costs 2, a report
costs 5, an auto-suspension costs 15, and a report an admin dismisses refunds 5 to the accused. Once
the pair average drops below 50, `scorePair` docks 10 — low-trust users are deprioritized rather
than banned, which degrades the experience of likely bad actors without a hard, appealable decision.

### Provider seams

Every integration that would need a vendor account is isolated behind a single function so the
system runs end to end without one:

- `sms.js` exposes one `sendSms()`. In `dev` mode it logs instead of sending and the OTP is returned
  in the API response as `devCode`, which is what makes the automated end-to-end run possible.
- ICE servers are assembled in `config.js`; adding TURN is three environment variables and no code
  change, and clients fetch the result at runtime rather than hardcoding it.
- The text filter has a marked extension point for an external moderation API.

### Failure-mode handling worth noting

Several small decisions came out of thinking about what breaks under concurrency or hostile input:

- **Match creation is guarded against mid-queue disconnects.** If either socket vanished between
  being queued and being matched, `onMatch` re-enqueues the survivor rather than creating a
  half-dead match.
- **Chat excerpts are never truncated as JSON.** Each message body is capped *before*
  `JSON.stringify`, because slicing a serialized string produces invalid JSON — and there is a
  regression test for exactly that.
- **A report can only be resolved once.** `/reports/:id/resolve` returns `409` on an
  already-reviewed report, so two admins clicking simultaneously cannot apply contradicting actions,
  and a "suspend" action is guarded with `AND status != 'banned'` so it cannot quietly downgrade a ban.
- **Avatar uploads are validated by magic bytes, not by the declared type**, and the RIFF branch
  additionally requires the `WEBP` signature at offset 8 — otherwise every WAV and AVI file passes as
  an image.
- **Evidence files are admin-only** and the filename is passed through `path.basename()` to defeat
  traversal.
- **Phone numbers are never stored in plaintext** — only a SHA-256 hash, which is also what bans are
  keyed on.
- **Schema migrations are additive**, applied through an `ensureColumn()` helper, because
  `CREATE TABLE IF NOT EXISTS` will not alter a table that already exists.

### Single-process by choice, with the seams marked

State that would live in Redis at scale — the waiting pool, presence, active matches, chat rate
limits — lives in `Map`s. That is a deliberate trade: zero infrastructure to run the prototype, at
the cost of horizontal scaling. The migration points are marked in the source at the places that
would have to change.

---

## Getting started

**Requirements:** Node.js 22.13+ or 24+, and a Flutter release carrying Dart 3.12+
(`sdk: ^3.12.1` in `app/pubspec.yaml`). The version floor is `node:sqlite`: it does not exist before
Node 22.5, and on the 22.5–22.12 releases it still needs an `--experimental-sqlite` flag that
`npm start` does not pass.

```bash
# Backend
cd server
npm install
npm start          # http://localhost:3000  — admin panel at /admin
```

The server starts in `dev` OTP mode: no SMS is sent, and the verification code comes back in the
API response as `devCode`. On first run it generates an admin password and writes it to
`data/ADMIN_BILGILERI.txt`, and generates a JWT secret into `data/.jwt-secret` (the whole `data/`
directory is gitignored).

```bash
# Web client — built into the same server, so one process serves everything
cd app
flutter build web --release
cd ../server && npm start        # open http://localhost:3000

# Android
cd app
flutter run                       # emulator reaches the host at 10.0.2.2:3000 by default
flutter build apk --release

# iOS (requires macOS + Xcode)
cd app
flutter build ios --release
```

On a physical Android device, enter your machine's LAN address in the "server address" field on the
onboarding screen; it is persisted in `SharedPreferences`. Browsers only grant camera and microphone
access over `localhost` or HTTPS.

```bash
# Tests
cd server
npm test           # 27 unit tests (matchmaking, moderation, reports, schema migration)
npm run e2e        # 50 assertions: spawns the server, drives three simulated users end to end
npm run seed       # demo data for the admin panel

cd app
flutter analyze
flutter test
```

The end-to-end simulation covers registration (including the under-18 rejection), matchmaking,
WebRTC signal exchange, mutual friend-add, persistent messaging with the profanity filter, avatar
upload and rejection of non-image data, reporting with an evidence frame, blocking, and the full
admin API including the kill switch.

### Configuration

There is no `.env` file to copy — everything is read from environment variables with working
defaults in `server/src/config.js`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PROJEX_DATA_DIR` | `<repo>/data` | SQLite DB, evidence frames, avatars, secrets |
| `PROJEX_DB_FILE` | `<data dir>/projex.db` | SQLite file location, if it must sit outside the data dir |
| `PROJEX_OTP_MODE` | `dev` | `production` requires a real SMS provider in `sms.js` |
| `PROJEX_PHONE_SALT` | built-in constant | **Must be overridden** in any real deployment |
| `PROJEX_TURN_URL` / `_USER` / `_PASS` | unset | TURN relay; without it, users behind symmetric NAT cannot connect |

---

## Known limitations

These are real gaps, listed so nobody has to discover them by reading the source.

- **There is no image or video moderation. This is the reason the code is not production-ready.**
  The filter is text-only. Nothing inspects the live video stream — no on-device NSFW pre-filter, no
  cloud vision API, no periodic frame sampling. The client can capture a frame
  (`_captureSnapshot` in `call_screen.dart`), but it fires only when a user files a report. A random
  video pairing service without automated video moderation should not be operated, and this one is
  not.
- **The age gate is self-declared.** Registration rejects anyone under 18 by birth date, and the
  date is locked afterwards, but nothing verifies it. Phone-number ownership is the only real
  identity signal.
- **The profanity list is a small hand-maintained wordlist.** The normalizer defeats mechanical
  obfuscation, not novel vocabulary, and it carries the usual false-positive risk of substring
  matching. Real deployment needs an external moderation API behind the marked extension point.
- **Single process only.** The matchmaking pool, presence table, active-match registry and rate
  limiters are in-memory `Map`s, and there is no Socket.IO Redis adapter. Running two instances
  would split the matchmaking pool and break signaling. SQLite writes are synchronous and serialize
  on the event loop.
- **The SMS provider is a stub.** `sendSms()` throws in production mode until an integration is
  filled in. The `dev` fallback returns the OTP in the HTTP response, which is fine for testing and
  a critical vulnerability if ever shipped.
- **Phone hashing uses one fixed application-wide salt.** The hash is therefore deterministic
  across all users; given the database and the salt, the phone-number keyspace is small enough to
  enumerate. A real deployment needs an HMAC with a key held outside the database.
- **No push notifications.** Messages to an offline user are stored but not delivered until the app
  reconnects. The FCM/APNs hook point is marked in the `chat:send` handler.
- **The UI is Turkish-only.** Strings are hardcoded in the widgets; there is no ARB/l10n setup, and
  the app locale is pinned to `tr` even though `en` is listed as supported.
- **Client test coverage is thin.** The Dart side has a single widget test. All meaningful test
  coverage — 27 unit tests and 50 end-to-end assertions — is on the backend.
- **Development-mode transport settings are still on.** `usesCleartextTraffic="true"` is set on
  Android, and the server serves plain HTTP; both must change before any real deployment.
- **Evidence frames are stored unencrypted on local disk** with no retention policy or automatic
  expiry.

---

## Status

Technical prototype. **Never launched, zero users, no production deployment.** It was built to work
through two problems I wanted to solve properly — matchmaking under a starved pool, and text
moderation that resists evasion — and then stopped there, because shipping a random video pairing
product responsibly requires automated video moderation and real age verification, and I was not in
a position to build either of those well.

It is published as a reference implementation. The parts worth reading are `matchmaking.js` and
`moderation.js`; the rest is the surrounding system that makes them testable end to end. Everything
claimed above is verifiable in the source, and the test suites run offline with no external
services.

---

## License

MIT — see [LICENSE](LICENSE).
