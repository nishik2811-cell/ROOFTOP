# Rooftop

**Offline AirDrop for every device.** Send files and clipboard text between PCs and phones on the same Wi-Fi or hotspot. No internet, no cables, no accounts, nothing to install on phones.

Made by **Nishita, Aryan and Keshav** for the OOP using Java lab (24B15CS215).

---

## Features

- Works on **Windows, macOS, Linux** (Java host), **Android** (host app or browser) and **iPhone** (browser).
- Phones join by scanning a QR code, with no app needed.
- Send files and text to **everyone** or to **one chosen device**.
- Encrypted transfers: HTTPS for phones, ECDH + AES-256-GCM between PCs.
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

### OOP concepts used

| Concept | Where |
|---|---|
| Classes, constructors, static members | `Rooftop`, `util/Texts`, `net/Wire` |
| Inheritance (single, multilevel, hierarchical) | `Device` → `ThisDevice`; `Device` → `NetworkDevice` → `PcPeer` / `PhoneClient` |
| Polymorphism | `Device.id()` overridden in `ThisDevice` and `PhoneClient`; `Platform` implemented by desktop and Android |
| Association, aggregation, composition | `Transfer` uses a `NetworkDevice`, owns its `Progress`; `Inbox` holds `ReceivedItem`s |
| Abstract classes, interfaces | `Device`, `Payload` (abstract); `Transferable`, `Platform` (interfaces) |
| Packages | 7 packages under `src/rooftop` |
| String, StringBuilder, StringBuffer | `FileNames`, `Texts` (progress bar, JSON, palindrome check), `ActivityLog` (thread-safe log) |
| Exceptions | `RooftopException`, `WrongPinException`, `TransferFailedException`, `InvalidFileNameException`; multi-catch, try-with-resources |
| Collections | `ArrayList`, `HashSet`, `LinkedList`, `TreeSet`, `HashMap`, `Iterator` |
| Multithreading | `TransferServer extends Thread`, `Discovery implements Runnable`, `synchronized`, `wait`/`notifyAll` in `SendQueue` |
| Applet | `ui/RadarApplet` (`init`, `start`, `paint`, `stop`, `destroy`) |
| Generics | `Registry<K, V extends Device>` with `ofType(Class<T>)` |
| Reflection, annotations | `cli/Shell` finds `@Command` methods and calls them with `Method.invoke` |
| Records | `ReceivedItem`, `ReceivedText` |

## Security

| Area | Protection |
|---|---|
| Phone ↔ host | HTTPS (TLS 1.3) with a certificate generated on first run |
| PC ↔ PC | Fresh ECDH (P-256) key per transfer, AES-256-GCM on every chunk; tampering stops the transfer |
| Access | Random 6-digit PIN per run (no palindromes); 10 wrong tries blocks that device |
| File names | `../../x` becomes `x`; duplicates become `name (2).ext`; half-received files are deleted |
| Downloads | Served with `Content-Security-Policy: sandbox` and `nosniff` |

**Known limit:** the certificate is self-signed, so an attacker on the same Wi-Fi who can redirect traffic could pose as the host. Passive sniffing sees nothing useful.

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
```

For real Wi-Fi speed, run `java src/rooftop/Benchmark.java serve` on one PC and `java src/rooftop/Benchmark.java to <ip>` on another.

## Building the APK

Needs a JDK and the Android SDK (`ANDROID_HOME`, default `~/Android/sdk`, build-tools 35):

```bash
sh android/build.sh
```

The signing key (`android/rooftop-release.keystore`) is not in this repository. The script creates one if it is missing. Keep yours safe: Android only installs updates signed with the same key.

## Syllabus coverage

All 9 modules of 24B15CS215 are used in the project (details in [OOP concepts used](#oop-concepts-used)):

| # | Module | Covered by |
|---|---|---|
| 1 | Fundamentals | Single-file source launch (`java src/rooftop/Main.java`), primitive types throughout |
| 2 | OOP basics | Constructors, static members, arrays, control flow (`Rooftop`, `Texts`, `Wire`) |
| 3 | Object modelling | Single, multilevel and hierarchical inheritance; association, aggregation, composition |
| 4 | Modularity | Abstract classes, interfaces, 7 packages |
| 5 | String | String, StringBuilder, StringBuffer, palindrome PIN check |
| 6 | Exception handling | Custom checked and unchecked exceptions, propagation |
| 7 | Collections | ArrayList, LinkedList, HashSet, TreeSet, HashMap, Iterator |
| 8 | Multithreading | Thread, Runnable, synchronized, wait/notifyAll |
| 9 | Applet | `RadarApplet` with all life cycle methods |

Extras beyond the syllabus: generics, reflection, annotations, records, networking, cryptography.

## Credits

See [THIRD_PARTY.md](THIRD_PARTY.md) for the font and icon licenses.
