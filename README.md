# SilentHuddle

[Leia em português](README.pt-BR.md)

> **Group chat, calls, and peer-to-peer sharing.**  
> Windows · Android 7+ (API 24+) · English and Portuguese

SilentHuddle is a communication app built with Tauri, TypeScript, and WebRTC.
Messages, files, voice, video, and screen sharing are sent directly between
participants whenever the network allows it.

**Current version: 1.4.1**

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/jiovanymatos51)

## Features

| Feature | Description |
| --- | --- |
| P2P rooms | Local sessions with temporary join codes and a peer mesh. |
| Chat | Messages, links, emoji, replies, reactions, warnings, and private messages. |
| Voice and video | Microphone, camera, per-participant volume, and voice activity indication. |
| Screen sharing | Screen and presentation audio, fullscreen, and Picture-in-Picture where supported by the system. |
| File transfer | Image, video, and audio previews; recipient approval before large files are sent. |
| Preferences | Language, avatar, nickname, custom signaling backend, devices, audio, and sound effects. |
| Clipboard | Paste images and files into chat. On Windows, files copied from File Explorer are read in chunks. |

<p align="center"><sub>Temporary rooms for conversations with people you choose.</sub></p>

## Security and privacy

WebRTC encrypts media and data channels in transit between devices. This protects
traffic on the network, but it does not make other room participants trustworthy:
participants receive what you send and may record messages, files, audio, video,
or your screen. The app does not provide accounts, verified identities, or room
moderation.

With direct connections, participants may discover one another's public IP
addresses during network negotiation. STUN helps establish connections but does
not hide IP addresses. The app accepts optional TURN servers; configuring TURN
alone does not guarantee that every connection is relayed or that your IP is
hidden. The client must enforce and verify a relay-only policy for that. A TURN
service will carry the relayed traffic.

The initial handshake uses a temporary code and sends WebRTC session descriptions
(SDP) through the signaling backend. These descriptions may contain ICE
candidates and network addresses, so treat the backend and Redis service as part
of your trusted infrastructure. Redis stores this state temporarily (120-second
TTL). A short code is not an account or verified identity; share it only with
people you intend to add.

**Only connect with people you trust.** Check what is visible before sharing your
screen, camera, microphone, or files. If you host your own backend, use HTTPS,
protect Redis credentials, and configure an appropriate CORS origin allowlist.
CORS is a browser protection; it does not replace authentication or server-side
rate limits.

### TURN and build secrets

`VITE_*` settings are bundled into the compiled app and can be read by anyone who
installs it. Do not put permanent passwords or other secrets in these variables.
For production TURN, prefer temporary, limited credentials. See
[TURN configuration](#turn-recommended-for-production).

## What's new in 1.4.1

- Fullscreen screen sharing, with an exit button and Escape support. Android
  expands the view inside the app when its WebView does not provide the Fullscreen
  API. The sender can prioritize the capture's native resolution (up to 30 fps);
  this cannot increase the source resolution or remove network, capture, or
  WebView limitations.
- Paste images and files into chat. On Windows, files copied from File Explorer
  are read natively in chunks instead of loading the entire file into RAM. The
  attachment button supports multiple files. Files larger than 10 MB require
  recipient approval before transfer. On Android, clipboard support depends on
  the keyboard and WebView; the attachment button remains available.
- **Configure server** on the home screen saves a compatible API URL in AppData
  (or the app's private storage on Android). Leaving the field empty restores the
  default without showing its address in the UI. Use HTTPS; HTTP is allowed only
  for loopback development. All friends joining the same room must use the same
  backend. Saving the setting does not make a network request.
- Join, add, and server-configuration dialogs use the app's dark theme.

The room-entry architecture and limits from 1.4.0 remain in place. There is no
reusable host code, HTTP server on a user's PC, automatic port forwarding, or new
hosting architecture.

## Joining rooms

**Create room** creates a session on the local device without contacting the
backend. Rooms have no persistent name, password, invitation link, or refresh
button.

**Join room** opens a dialog with a temporary five-letter uppercase code (A–Z), a
copy button, and a button to confirm entry. The code expires after two minutes.
Automatic checks run every six seconds and stop after five attempts; manual
confirmation remains available until expiration. You can cancel or generate a
new code.

Any participant in the room can select **Add** and enter that code. The backend
only brokers the WebRTC offer and answer for this first connection. Once the
answer is received, the client cancels the code and stops polling. Redis also
expires abandoned codes automatically.

The participant who added the new person introduces them to the other peers.
Offers and answers for subsequent connections travel through that participant's
data channels, forming a mesh of direct connections. Names, colors, presence,
call state, messages, and files are exchanged over P2P. The server does not keep
a room directory or participant presence; the room can continue after its
creator leaves. A lost peer connection may be renegotiated through another
connected peer. If no intermediary remains, use a new join code to reconnect.

Public messages, warnings, replies, and reactions are synchronized with new
participants in batches with buffer control and deduplication. File references
include the name, type, and size, but file contents are not automatically resent
to someone who joins later. Private `/msg` conversations and local command
notices are not included in this synchronization. Chat history stays in memory
for the session and ends when the user leaves it.

**Backend update required:** deploy the 1.4.1 backend from `backend` before
distributing 1.4.1 clients. The version check requires `v1.4.1`. This protocol is
not compatible with the 1.3.3 room directory. See
[`backend/README.md`](backend/README.md).

## Chat commands

| Command | Example | Result |
| --- | --- | --- |
| `/help` | `/help` | Shows the command list only to you. |
| `/avatarcolor` | `/avatarcolor blue` | Changes your avatar color; accepts CSS colors and common English or Portuguese color names. |
| `/nickname` | `/nickname joao123` | Changes your name (up to 18 characters). |
| `/warn` | `/warn important announcement` | Sends a highlighted warning to the room. |
| `/msg` | `/msg joao123 private message` | Sends a private message to the participant with that nickname. |

## Project structure

```text
src/                 UI, WebRTC, chat, media, and settings
src-tauri/           Tauri desktop app, Rust code, and Android configuration
backend/             Vercel signaling API and Redis integration
api/                 API wrapper for deploying from the project root
scripts/             Local API server and protocol/feature tests
localbackendtests/   Signaling backend tests
```

## Development

On Windows, install Node.js, Rust with the MSVC toolchain, and Visual Studio Build
Tools with **Desktop development with C++**. Then run:

```powershell
npm install
npm run tauri -- dev
```

To build Windows release installers:

```powershell
npm run tauri -- build
```

Installers are written to `src-tauri/target/release/bundle/`. The `.gitignore`
keeps installers, APKs, caches, and signing files out of version control by
default.

Useful scripts from `package.json`:

```powershell
npm run build       # build the frontend
npm run check       # check TypeScript types
npm test            # run the existing backend and protocol tests
```

## Android (API 24+)

The Android app uses the same frontend as desktop and supports Android 7 (API 24)
or later. On Windows, install Android Studio with Android SDK, Platform-Tools,
Build-Tools, and NDK; JDK 17; and Visual Studio Build Tools with **Desktop
development with C++**. Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` for your
machine, then install the Rust Android targets:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm install
```

To run on a device with USB debugging enabled or an open emulator:

```powershell
adb devices
npm run tauri -- android dev
```

Build a universal release APK:

```powershell
npm run tauri -- android build --apk --ci
```

Build separate APKs per architecture or an Android App Bundle:

```powershell
npm run tauri -- android build --apk --split-per-abi
npm run tauri -- android build --aab
```

Artifacts are written under `src-tauri/gen/android/app/build/outputs`. Android
updates must be signed with the same release keystore used for previous versions.
Keep the keystore and passwords outside this repository and maintain a secure
backup. Screen capture depends on support in Android System WebView; presentation
audio also depends on the selected source and system providing an audio track.

During a call, the Android app runs a foreground service with a persistent
notification to help prevent the process and WebRTC engine from being suspended
when switching apps. On Android 13 and later, allow notifications when prompted.
The service stops when you leave the call.

## Local backend development

To run the signaling API locally, start it with:

```powershell
npm run dev:api
```

In another terminal, point the app to the local API and start it:

```powershell
$env:VITE_SIGNALING_API_BASE = "http://127.0.0.1:3001/api/"
npm run tauri -- dev
```

To deploy on Vercel, set `backend` as the Root Directory, or deploy that
folder as a separate project. Configure `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` (or the legacy `KV_REST_API_URL` and
`KV_REST_API_TOKEN`). See the backend README for routes, rate limits, CORS, and
protocol details. The production API requires Redis; the in-memory fallback is
for local development only.

The default signaling endpoint is set in `src/config.ts`. Override it at build
time with `VITE_SIGNALING_API_BASE`. Everyone joining the same room must use the
same backend.

## TURN (recommended for production)

You can include TURN servers in a frontend build using environment variables:

```text
VITE_TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
VITE_TURN_USERNAME=username
VITE_TURN_CREDENTIAL=temporary-credential
```

`VITE_*` values are visible in the compiled client. Only use values that may be
shared with app users; short-lived credentials are safer than a permanent TURN
password.

## App version and metadata

Keep the version synchronized in `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `src/config.ts`, and the `VERSION` constant in
`backend/api/index.js`. The backend rejects clients with a different
version string.

The app name, version, identifier, publisher, copyright, and installer
descriptions are in `src-tauri/tauri.conf.json`. Rust package metadata is in
`src-tauri/Cargo.toml`. The source icon is `src/assets/logo.ico`.

## License

SilentHuddle is licensed under the **MIT License**. See [`LICENSE.txt`](LICENSE.txt)
for the full text. The license permits use, modification, and redistribution,
including commercially, provided the copyright and license notice are retained.
