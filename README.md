# Rooftop

**AllDrop: AirDrop for *all* your devices.** iPhone to Windows, Android to Mac, Linux to anything. Files and clipboard text fly across the same Wi-Fi or hotspot, with no internet, no cables, no accounts and nothing to install on phones.

Made by **Nishita, Aryan and Keshav**.

---

## Features

- Works on **Windows, macOS, Linux** (Java host), **Android** (host app or browser) and **iPhone** (browser).
- Phones join by scanning a QR code, with no app needed.
- Send files and text to **everyone** or to **one chosen device**.
- **Every file end-to-end encrypted:** whether it goes to one device or to everyone, a file is sealed in the sender's browser for each recipient's key, and only those browsers can open it (the PC's own page included). The PC in the middle stores only ciphertext and deletes it once every recipient has saved its copy.
- **Keys you can check:** each device shows a 6-digit safety code per device, and a QR code the other can scan with its camera to mark the key verified. The Send to list says which devices are verified.
- PC-to-PC transfers are encrypted (ECDH + AES-256-GCM) and tied to the receiving PC's PIN, so a wrong PIN or someone in the middle fails before any data moves.
- **Reliable transfers:** big files go in pieces, so a dropped Wi-Fi resumes instead of starting over; failed sends retry automatically; PC-to-PC files are checked with SHA-256.
- **Smarter sending:** pick as many files as you like, any time. Three move at once, small ones go first (a big file never waits more than 20 s behind them), and each can be cancelled or retried. A tray shows live speed, time left and a speed graph.
- **Compression only when it helps:** text-like files are packed on the way (in the browser, or between PCs) if a sample actually shrinks; photos, videos and archives are sent as they are.
- **Chat** between all devices, to everyone or to one device, with an unread dot.
- **Custom names** for every phone and PC, remembered across restarts.
- **History** of every file sent and received in the session, with speed, also after the file is removed.
- **Notifications** when a file or message arrives while Rooftop is in the background (and a count in the tab title).
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
 Phone (browser) --HTTPS :8443, files sealed end to end--> Host (PC or Android app) <--TCP :45455, encrypted, PIN-checked--> Other PC
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
├── net/        Discovery (UDP), TransferServer/Client (TCP), SendQueue, Frames, Http, WebServer
├── security/   SecureChannel (ECDH + SPAKE2 + AES-GCM), Spake2, Certificates, PinGuard, FileNames
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
| Files between browsers | End to end, every file, to one device or to everyone (details below) |
| Phone ↔ host | HTTPS (TLS 1.3) with a certificate generated on first run; chat messages and the page itself travel this way |
| PC ↔ PC | Fresh ECDH (P-256) key per transfer and SPAKE2 (RFC 9382) with the receiving PC's PIN, bound together over the whole handshake; both sides prove they got the same keys before any data, so a wrong PIN or a man in the middle fails right away and counts as a wrong try. Both terminals show the same safety code. Then AES-256-GCM on every chunk; tampering stops the transfer |
| Access | Random 6-digit PIN per run (no palindromes); 10 wrong tries blocks that device |
| File names | `../../x` becomes `x`; duplicates become `name (2).ext`; half-received files are deleted |
| Downloads | Served with `Content-Security-Policy: sandbox` and `nosniff` |
| Browser keys | A new ECDH P-256 key pair per session in every browser (phones and the PC's own page); the private half is non-extractable and stays in IndexedDB. A device without a key is shown as such and is never sent a file |
| Sealing | A fresh random AES-256-GCM key and a random id per file; 1 MB chunks whose nonce is the file id, a "last chunk" flag and the chunk number, so nothing can be reordered or cut off. The file name travels encrypted. The file key is wrapped separately for each recipient with HKDF-SHA-256 over two ECDH results (a one-time key with the recipient's key, and the sender's key with the recipient's key), so a swapped sender key fails to open. Sizes are padded (to 64 KB, then to a sixteenth of the nearest power of two) |
| On the PC | Only ciphertext with the wrapped keys, in a hidden temp folder, never in the inbox. It remembers only the transfer id, the recipient ids, the padded size and the arrival time. Transfers between other devices never show up in its page, city, inbox, history, log or terminal. It deletes the bytes and the record after the last recipient's acknowledgement, at session end, or after 1 hour. Files for the PC are opened by the PC's own page and saved into its inbox |
| Verification | A 6-digit safety code from both public keys, and a QR code with a 120-bit key fingerprint that another device scans to mark the key verified (remembered per key) |
| Integrity | PC-to-PC files carry a SHA-256 of the whole file; a mismatch discards the copy and the sender retries |

**Known limits:**
- Browsers load Rooftop's code from the host, so a host running modified code could serve a page that leaks keys or files. The safety code and the QR check catch a swapped key, not a swapped page.
- The host sees that transfers happen: their padded size, their timing, and who sends to whom. It cannot read them.
- The certificate is self-signed, so an attacker on the same Wi-Fi who can redirect traffic could pose as the host; passive sniffing sees nothing useful. Verifying keys protects files even then.
- Chat messages are protected by HTTPS on the way and readable by the host, not end to end.
- Files compressed before sealing can reveal how well they compress, through their padded size.
- Files that land on the PC (sent to it, to everyone, or from another PC) are stored there unencrypted, like any download.
- A PC only receives end-to-end files while its own page (`http://localhost:8080`) is open. Two PCs need this version on both sides to talk to each other.

## Terminal commands

Type these in the window where Rooftop runs:

| Command | Does |
|---|---|
| `devices` | list PCs and phones on this Wi-Fi |
| `send <pc> <pin> <file>` | send a file to another PC |
| `text <pc> <pin> <message>` | send text to another PC's clipboard |
| `inbox`, `rm <name>` | list or delete received files |
| `history` | files sent and received in this session |
| `name <new name>` | rename this PC |
| `qr` | show the link, QR code and PIN again |
| `session` | end this session: new PIN, phones disconnected, messages and files deleted |
| `radar` | open the radar window (applet) |
| `log`, `help`, `quit` | |

## Testing

```bash
java src/rooftop/SelfTest.java      # PIN, file names, encryption, tamper checks, sealed storage, PC-to-PC PIN handshake
java src/rooftop/Benchmark.java     # transfer speed on this PC
ROOFTOP_LOG=rooftop.log node test/e2e-browser.mjs   # with Rooftop running (output saved to rooftop.log): three browsers, end to end (needs: npm i -D playwright)
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
