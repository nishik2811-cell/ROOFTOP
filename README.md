# Rooftop

**AllDrop: AirDrop for *all* your devices.** iPhone to Windows, Android to Mac, Linux to anything. Files and clipboard text fly across the same Wi-Fi or hotspot, with no internet, no cables, no accounts and nothing to install on phones.

Made by **Nishita, Aryan and Keshav**.

---

## Features

- Works on **Windows, macOS, Linux** (Java host), **Android** (host app or browser) and **iPhone** (browser).
- Phones join by scanning a QR code, with no app needed.
- Send files and text to **everyone** or to **one chosen device**.
- Encrypted transfers: HTTPS for phones, ECDH + AES-256-GCM between PCs.
- **Private files, end-to-end encrypted:** a file sent to one phone is sealed in the sender's browser and only the recipient's browser can open it. The PC in the middle stores only ciphertext and deletes it once the recipient saves the file. Both screens show a 6-digit safety code to compare.
- **Reliable transfers:** big files go in pieces, so a dropped Wi-Fi resumes instead of starting over; failed sends retry automatically; PC-to-PC files are checked with SHA-256.
- A 6-digit PIN protects every session. **End session, start new** (PC panel) gives a fresh PIN, disconnects all phones and deletes received files and messages.
- Remove any file with the **×** on it (in the city or the inbox). Phones can only remove files they sent.
- Received files appear on billboards and walls of a small explorable city, with a day and night mode.

## Quick start

You need **Java 22 or newer** ([adoptium.net](https://adoptium.net)). There is no build step and there are no libraries.

| PC | Run |
|---|---|
| Windows | double-click `start-windows.bat` |
| macOS | double-click `start-mac.command` (first time: right-click, Open) |
| Linux | `./start-linux.sh` |

Or from this folder: `java src/rooftop/Main.java`

1. **On the PC**, open `http://localhost:8080`. You see the QR code, PIN, connected devices and messages.
2. **On a phone**, scan the QR code. On the first visit the browser says "not private": tap *Advanced, Proceed* (Android) or *Show details, Visit this website* (iPhone). The connection is still encrypted; the certificate is simply self-signed.
3. **On another PC**, run Rooftop there too. The PCs find each other automatically.

Received files are saved to `~/Rooftop`.

> **Same network only.** Home Wi-Fi and phone hotspots work. College and cafe Wi-Fi often block devices from seeing each other; use a hotspot there. On Windows, allow Java through the firewall and set the network to Private.

### Android app

`Rooftop.apk` (Android 10+) runs the host on the phone itself, so no laptop is needed. Other phones and iPhones join it through their browser.

## How it works

```
 Phone (browser) --HTTPS :8443--> Host (PC or Android app) <--TCP :45455, encrypted--> Other PC
                                       |
                              UDP broadcast :45454  (devices announce themselves)
```

| Port | Used for |
|---|---|
| 8080 | Web page for the host itself (localhost only) |
| 8443 | Web page for phones (HTTPS) |
| 45454 / UDP | Discovery |
| 45455 / TCP | PC-to-PC transfers |

## Java architecture

All Java source code lives in **`src/rooftop/`**, split into packages:

```
src/rooftop/
├── Main.java            entry point
├── Rooftop.java         wires all the parts together
├── Platform.java        interface: what differs between desktop and Android
├── DesktopPlatform.java desktop version (AWT clipboard, ~/Rooftop folder)
├── SelfTest.java        checks for the risky parts
├── Benchmark.java       transfer speed test
├── model/      Device hierarchy, payloads, Transfer, Progress, Inbox
├── net/        Discovery (UDP), TransferServer/Client (TCP), SendQueue, Http, WebServer
├── security/   SecureChannel (ECDH + AES-GCM), Certificates, PinGuard, FileNames
├── error/      custom exceptions
├── util/       Registry, Texts, ActivityLog, Streams, Threads, QrCode
├── cli/        Shell and the @Command annotation
└── ui/         RadarApplet
```

Other folders:

| Folder | Contents |
|---|---|
| `web/` | The page (HTML, CSS, JS, font). No frameworks. |
| `android/` | Android host app: `AndroidPlatform`, `MainActivity`, `RooftopService`, `build.sh` |

## Security

| Area | Protection |
|---|---|
| Phone ↔ host | HTTPS (TLS 1.3) with a certificate generated on first run |
| PC ↔ PC | Fresh ECDH (P-256) key per transfer, AES-256-GCM on every chunk; tampering stops the transfer |
| Access | Random 6-digit PIN per run (no palindromes); 10 wrong tries blocks that device |
| File names | `../../x` becomes `x`; duplicates become `name (2).ext`; half-received files are deleted |
| Downloads | Served with `Content-Security-Policy: sandbox` and `nosniff` |
| Private files (one device) | Sealed in the browser: ECDH P-256 with a one-time key, HKDF-SHA-256, AES-256-GCM in 1 MB chunks (chunk number and "last chunk" flag in each nonce, so nothing can be reordered or cut off). The private key is non-extractable and stays in the browser (IndexedDB). The PC keeps only ciphertext in a hidden temp folder, never in the inbox, city, log or terminal, and deletes it after the recipient's acknowledgement, at session end, or after 1 hour |
| Integrity | PC-to-PC files carry a SHA-256 of the whole file; a mismatch discards the copy and the sender retries |

**Known limits:** the certificate is self-signed, so an attacker on the same Wi-Fi who can redirect traffic could pose as the host. Passive sniffing sees nothing useful. For private files, the page itself is served by the host, so a host running modified Rooftop code could serve a page that leaks keys; the safety code catches a swapped key, not a swapped page.

## Terminal commands

Type these in the window where Rooftop runs:

| Command | Does |
|---|---|
| `devices` | list PCs and phones on this Wi-Fi |
| `send <pc> <pin> <file>` | send a file to another PC |
| `text <pc> <pin> <message>` | send text to another PC's clipboard |
| `inbox`, `rm <name>` | list or delete received files |
| `qr` | show the link, QR code and PIN again |
| `session` | end this session: new PIN, phones disconnected, messages and files deleted |
| `radar` | open the radar window (applet) |
| `log`, `help`, `quit` | |

## Testing

```bash
java src/rooftop/SelfTest.java      # PIN, file names, encryption, tamper checks
java src/rooftop/Benchmark.java     # transfer speed on this PC
node test/e2e-check.mjs             # with Rooftop running: proves the PC never holds a readable private file
```

For real Wi-Fi speed, run `java src/rooftop/Benchmark.java serve` on one PC and `java src/rooftop/Benchmark.java to <ip>` on another.

## Building the APK

Needs a JDK and the Android SDK (`ANDROID_HOME`, default `~/Android/sdk`, build-tools 35):

```bash
sh android/build.sh
```

The signing key (`android/rooftop-release.keystore`) is not in this repository. The script creates one if it is missing. Keep yours safe: Android only installs updates signed with the same key.

## Credits

See [THIRD_PARTY.md](THIRD_PARTY.md) for the font and icon licenses.
