package rooftop.net;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.StringJoiner;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLContext;
import rooftop.Rooftop;
import rooftop.error.InvalidFileNameException;
import rooftop.error.OffsetMismatchException;
import rooftop.error.WrongPinException;
import rooftop.model.Device;
import rooftop.model.History;
import rooftop.model.NetworkDevice;
import rooftop.model.PhoneClient;
import rooftop.model.Progress;
import rooftop.model.ReceivedItem;
import rooftop.model.SealedBox;
import rooftop.model.ReceivedText;
import rooftop.security.Certificates;
import rooftop.security.FileNames;
import rooftop.util.QrCode;
import rooftop.util.Texts;

/**
 * The browser side. Serves the page and a small JSON API on two listeners:
 *   HTTPS on every network card, for other phones and PCs (PIN required),
 *   plain HTTP on 127.0.0.1 only, for this device's own screen (no PIN, no certificate warning).
 */
public class WebServer {
    private static final String JSON = "application/json; charset=utf-8";
    private static final String TEXT = "text/plain; charset=utf-8";
    private static final Map<String, String[]> PAGES = new HashMap<>();
    private static final Map<String, String> IMAGE_TYPES = new HashMap<>();

    static {
        PAGES.put("/", new String[]{"index.html", "text/html; charset=utf-8"});
        PAGES.put("/style.css", new String[]{"style.css", "text/css; charset=utf-8"});
        PAGES.put("/app.js", new String[]{"app.js", "text/javascript; charset=utf-8"});
        PAGES.put("/e2e.js", new String[]{"e2e.js", "text/javascript; charset=utf-8"});
        PAGES.put("/display.woff2", new String[]{"display.woff2", "font/woff2"}); // Big Shoulders Display (OFL), for the intro
        // shown inline so murals can use them; everything else (html, svg, ...) is a plain download
        IMAGE_TYPES.put("jpg", "image/jpeg");
        IMAGE_TYPES.put("jpeg", "image/jpeg");
        IMAGE_TYPES.put("png", "image/png");
        IMAGE_TYPES.put("gif", "image/gif");
        IMAGE_TYPES.put("webp", "image/webp");
        IMAGE_TYPES.put("avif", "image/avif");
    }

    private static final long MAX_GZIP_PIECE = 64L << 20; // what one compressed piece may expand to

    private final Rooftop app;
    private String scheme = "https";
    /** Resumable uploads in progress: when the first piece came, and bytes on the wire vs bytes of file so far. */
    private final Map<String, long[]> uploads = new ConcurrentHashMap<>();
    /** When this PC's own page last asked for the state: sealed files are only offered to it while it is open. */
    private volatile long hostPageSeen;

    public WebServer(Rooftop app) {
        this.app = app;
    }

    public void start() throws IOException {
        // bounded: at most 64 requests at once (each page keeps one waiting in /api/wait); beyond that a request is refused
        ExecutorService pool = new java.util.concurrent.ThreadPoolExecutor(4, 64, 30, java.util.concurrent.TimeUnit.SECONDS,
                new java.util.concurrent.SynchronousQueue<>());
        // 127.0.0.1 explicitly: Android's getLoopbackAddress() is ::1, which the page at 127.0.0.1 cannot reach
        ServerSocket local = new ServerSocket(Wire.LOCAL_PORT, 50, InetAddress.getByName("127.0.0.1"));
        Http.serve(local, this::route, pool, app.log()::add);
        ServerSocket lan;
        try {
            SSLContext tls = Certificates.load(app.inbox().dir().resolve(".rooftop"));
            lan = tls.getServerSocketFactory().createServerSocket(Wire.HTTPS_PORT);
        } catch (Exception e) {
            // ponytail: falls back to plain HTTP so the app still works; the PIN still guards it
            app.log().add("HTTPS unavailable (" + e.getMessage() + "), phones will use plain HTTP");
            lan = new ServerSocket(Wire.HTTPS_PORT);
            scheme = "http";
        }
        Http.serve(lan, this::route, pool, app.log()::add);
    }

    /** The link the QR code points at. */
    public String phoneUrl(String ip) {
        return scheme + "://" + ip + ":" + Wire.HTTPS_PORT + "/?pin=" + app.pins().pin();
    }

    private void route(Http.Request req, Http.Response res) throws IOException {
        try {
            res.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
            if (PAGES.containsKey(req.path)) {
                String[] page = PAGES.get(req.path);
                res.header("Cache-Control", "no-cache").send(200, page[1], app.platform().asset(page[0]));
            } else if (req.path.startsWith("/api/")) {
                res.header("Cache-Control", "no-store"); // live data and files: never kept in a browser cache
                api(req, res, req.path.substring("/api".length()));
            } else {
                res.send(404, TEXT, "not found");
            }
        } catch (WrongPinException e) {
            res.send(403, JSON, "{\"error\":\"pin\",\"blocked\":" + e.isBlocked() + "}");
        } catch (InvalidFileNameException e) {
            res.send(400, TEXT, e.getMessage());
        } catch (NoSuchFileException e) {
            res.send(404, TEXT, "no such file");
        } catch (IOException | RuntimeException e) {
            app.log().add("web error: " + e);
            if (!res.isCommitted()) res.send(500, TEXT, "server error");
        }
    }

    private void api(Http.Request req, Http.Response res, String route) throws IOException, WrongPinException {
        boolean local = req.remote.isLoopbackAddress();
        if (!local) app.pins().check(req.remote.getHostAddress(), req.query.get("pin"));
        NetworkDevice guest = local ? null : visitor(req);
        String visitor = local ? app.me().name() : guest.name();
        String visitorId = local ? app.me().id() : guest.id();
        boolean post = "POST".equals(req.method);
        // anything a device POSTs may change what others see: wake every page waiting in /api/wait
        // (piece uploads wake them only when the last piece is in, see sealedPiece)
        if (post && !route.equals("/sealed/upload") && !route.equals("/upload")) app.changed();

        switch (route) {
            case "/wait" -> { // long poll: returns as soon as something changes, or after 20 s
                long seen;
                try { seen = Long.parseLong(req.query.getOrDefault("v", "-1")); } catch (NumberFormatException e) { seen = -1; }
                res.send(200, JSON, "{\"v\":" + app.awaitChange(seen, 20_000) + "}");
            }
            case "/state" -> {
                if (local) hostPageSeen = System.currentTimeMillis();
                res.send(200, JSON, stateJson(visitor, visitorId, local));
            }
            case "/qr" -> { // the QR code for a device's own key link, so another device can scan it to verify the key
                String text = req.query.getOrDefault("text", "");
                if (text.isEmpty() || text.length() > 400) res.send(400, TEXT, "bad text");
                else res.header("Cache-Control", "no-store").send(200, JSON, qrJson(text));
            }
            case "/connect" -> {
                if (local) res.send(200, JSON, connectJson());
                else res.send(404, TEXT, "not found");
            }
            case "/upload" -> {
                if (!local) { // other devices send end-to-end encrypted files only (see /sealed/upload)
                    req.body.skip(Math.max(0, req.length));
                    res.send(403, TEXT, "this Rooftop only takes end-to-end encrypted files. Reload the page.");
                    return;
                }
                // the PC's own page saves files it decrypted; "as" keeps the real sender on the file
                NetworkDevice sender = req.query.containsKey("as") ? app.devices().find(req.query.get("as")).orElse(null) : null;
                String from = sender != null ? sender.name() : visitor, fromId = sender != null ? sender.id() : visitorId;
                if (!post) res.send(405, TEXT, "POST only");
                else if (req.length < 0) res.send(411, TEXT, "Content-Length required");
                else if (req.query.containsKey("key")) uploadPiece(req, res, from, fromId);
                else {
                    String to = recipient(req.query.get("to"));
                    long started = System.nanoTime();
                    ReceivedItem item = app.inbox().store(req.query.get("name"), req.body, req.length, from, fromId, to, new Progress(req.length));
                    app.history().add(new History.Entry(System.currentTimeMillis(), item.name(), item.size(), from, fromId, to,
                            recipientName(to), true, (System.nanoTime() - started) / 1_000_000, 1, ""));
                    app.log().add(from + " -> " + recipientName(to) + ": " + item.name() + " (" + Texts.humanSize(req.length) + ", "
                            + Texts.speed(req.length, System.nanoTime() - started) + ")");
                    app.changed();
                    res.send(200, JSON, "{\"name\":" + Texts.json(item.name()) + "}");
                }
            }
            case "/text" -> { // chat is end to end now (see /chat); browsers never send text in plain
                req.body.skip(Math.max(0, req.length));
                res.send(410, TEXT, "chat is end-to-end encrypted now. Reload the page.");
            }
            case "/chat/send" -> {
                if (!post) {
                    res.send(405, TEXT, "POST only");
                    return;
                }
                chatSend(req, res, visitorId);
            }
            case "/chat" -> res.header("Cache-Control", "no-store").send(200, JSON, chatJson(req, visitorId));
            case "/clip" -> {
                if (local) res.send(200, TEXT, app.clipboard());
                else res.send(404, TEXT, "not found");
            }
            case "/name" -> { // a device picks the name others see
                if (!post) {
                    res.send(405, TEXT, "POST only");
                    return;
                }
                String wanted = new String(rooftop.util.Streams.readUpTo(req.body, 400), StandardCharsets.UTF_8);
                boolean ok = local ? app.rename(wanted) : guest.rename(wanted);
                if (ok) app.log().add(visitor + " is now called " + (local ? app.me() : guest).name());
                res.send(ok ? 200 : 400, JSON, "{\"name\":" + Texts.json((local ? app.me() : guest).name()) + "}");
            }
            case "/history" -> res.header("Cache-Control", "no-store").send(200, JSON, historyJson(visitorId, local));
            case "/key" -> { // a browser registers its end-to-end public key
                if (!post) res.send(405, TEXT, "POST only");
                else {
                    String key = new String(rooftop.util.Streams.readUpTo(req.body, 200), StandardCharsets.US_ASCII).trim();
                    (local ? app.me() : guest).setPublicKey(key);
                    res.send(200, TEXT, "ok");
                }
            }
            case "/sealed/upload" -> {
                if (!post) res.send(405, TEXT, "POST only");
                else if (req.length < 0) res.send(411, TEXT, "Content-Length required");
                else sealedPiece(req, res, visitorId);
            }
            case "/remove" -> {
                String name = req.query.get("name");
                boolean allowed = post && name != null && app.inbox().newestFirst().stream()
                        .anyMatch(i -> i.name().equals(name) && i.visibleTo(visitorId) && canRemove(i, visitorId, local));
                if (!allowed) res.send(404, TEXT, "not found");
                else {
                    app.inbox().remove(name);
                    app.log().add(visitor + " removed " + name);
                    res.send(200, TEXT, "ok");
                }
            }
            case "/session" -> { // only the host itself may end the session
                if (!local) res.send(404, TEXT, "not found");
                else if (!post) res.send(405, TEXT, "POST only");
                else {
                    app.newSession();
                    res.send(200, JSON, connectJson());
                }
            }
            default -> {
                if (route.startsWith("/sealed/")) { // /sealed/<id> to collect, /sealed/<id>/ack once saved
                    String rest = route.substring("/sealed/".length());
                    if (rest.endsWith("/ack") && post) {
                        boolean gone = app.sealed().acknowledge(rest.substring(0, rest.length() - 4), visitorId);
                        res.header("Cache-Control", "no-store").send(gone ? 200 : 404, TEXT, gone ? "ok" : "not found");
                    } else {
                        Path p = app.sealed().collect(rest, visitorId);
                        res.header("Cache-Control", "no-store").sendFile("application/octet-stream", p);
                    }
                } else if (route.startsWith("/files/")) {
                    String name = route.substring("/files/".length());
                    boolean allowed = app.inbox().newestFirst().stream().anyMatch(i -> i.name().equals(name) && i.visibleTo(visitorId));
                    if (allowed) serveFile(req, res, name);
                    else res.send(404, TEXT, "not found");
                }
                else res.send(404, TEXT, "not found");
            }
        }
    }

    /**
     * Resumable upload, one piece per request: ?name&size&key&offset&to. The browser sends a few MB at a time;
     * if the connection drops it asks again from the same offset, and a 409 tells it where we really are.
     */
    private void uploadPiece(Http.Request req, Http.Response res, String visitor, String visitorId) throws IOException {
        long size, offset;
        try {
            size = Long.parseLong(req.query.getOrDefault("size", "-1"));
            offset = Long.parseLong(req.query.getOrDefault("offset", "-1"));
        } catch (NumberFormatException e) {
            res.send(400, TEXT, "bad size or offset");
            return;
        }
        // A piece may come gzipped when the browser found that the file shrinks; raw is its length unpacked.
        boolean gzip = "gzip".equals(req.query.get("z"));
        long count = req.length;
        if (gzip) {
            try {
                count = Long.parseLong(req.query.getOrDefault("raw", "-1"));
            } catch (NumberFormatException e) {
                count = -1;
            }
        }
        if (size < 0 || offset < 0 || count < 0 || (gzip && count > MAX_GZIP_PIECE) || offset + count > size) {
            req.body.skip(req.length);
            res.send(400, TEXT, "bad size or offset");
            return;
        }
        // the id mixes in who is sending, so two phones with the same file never write into each other's upload
        String id = Texts.sha256(visitorId + "|" + req.query.get("key")).substring(0, 32);
        long[] stats = uploads.computeIfAbsent(id, k -> new long[]{System.nanoTime(), 0, 0});
        long started = System.nanoTime();
        try {
            java.io.InputStream body = gzip ? new java.util.zip.GZIPInputStream(req.body, 64 * 1024) : req.body;
            app.inbox().append(id, offset, body, count, new Progress(count));
            if (gzip) while (req.body.read() >= 0) { /* the gzip trailer */ }
        } catch (OffsetMismatchException e) {
            req.body.skip(req.length); // read the piece anyway, or the browser sees a reset instead of our answer
            res.send(409, JSON, "{\"offset\":" + e.expected() + "}");
            return;
        } catch (java.util.zip.ZipException e) { // what arrived unpacked is kept; the browser carries on from there
            req.body.skip(req.length);
            res.send(409, JSON, "{\"offset\":" + app.inbox().received(id) + "}");
            return;
        }
        stats[1] += req.length;
        stats[2] += count;
        long have = offset + count;
        if (have < size) {
            res.send(200, JSON, "{\"offset\":" + have + "}");
            return;
        }
        String to = recipient(req.query.get("to"));
        ReceivedItem item = app.inbox().finish(id, req.query.get("name"), size, visitor, visitorId, to);
        uploads.remove(id);
        double ratio = stats[2] > 0 ? (double) stats[1] / stats[2] : 1;
        app.history().add(new History.Entry(System.currentTimeMillis(), item.name(), size, visitor, visitorId, to, recipientName(to),
                true, (System.nanoTime() - stats[0]) / 1_000_000, ratio, ""));
        app.log().add(visitor + " -> " + recipientName(to) + ": " + item.name() + " (" + Texts.humanSize(size)
                + (offset > 0 ? ", last piece " + Texts.speed(req.length, System.nanoTime() - started) : "")
                + (ratio < 0.95 ? String.format(Locale.ROOT, ", sent compressed to %d%%", Math.round(ratio * 100)) : "") + ")");
        app.changed();
        res.send(200, JSON, "{\"done\":true,\"name\":" + Texts.json(item.name()) + "}");
    }

    /**
     * A piece of an end-to-end sealed file for one device. Deliberately silent: no log line, no inbox entry.
     * The recipient must be a connected browser with a key; the PC itself never takes sealed files.
     */
    private void sealedPiece(Http.Request req, Http.Response res, String visitorId) throws IOException {
        java.util.Set<String> to = new java.util.HashSet<>(java.util.Arrays.asList(req.query.getOrDefault("to", "").split(",")));
        boolean recipientOk = !to.isEmpty() && to.size() <= 255 && !to.contains(visitorId) && to.stream().allMatch(this::canReceiveSealed);
        long size, offset;
        try {
            size = Long.parseLong(req.query.getOrDefault("size", "-1"));
            offset = Long.parseLong(req.query.getOrDefault("offset", "-1"));
        } catch (NumberFormatException e) {
            size = offset = -1;
        }
        if (!recipientOk || size < 0 || offset < 0 || offset + req.length > size || !req.query.containsKey("key")) {
            req.body.skip(req.length);
            res.send(400, TEXT, recipientOk ? "bad size or offset" : "that device cannot receive encrypted files right now");
            return;
        }
        String id = Texts.sha256(visitorId + "|" + req.query.get("key")).substring(0, 32);
        try {
            app.sealed().append(id, to, size, offset, req.body, req.length);
        } catch (OffsetMismatchException e) {
            req.body.skip(req.length);
            res.send(409, JSON, "{\"offset\":" + e.expected() + "}");
            return;
        }
        if (offset + req.length == size) app.changed(); // the recipients can collect it now
        res.header("Cache-Control", "no-store").send(200, JSON, "{\"offset\":" + (offset + req.length) + ",\"done\":" + (offset + req.length == size) + "}");
    }

    /** Stores one sealed chat envelope for the listed devices. Deliberately silent: no log, no history. */
    private void chatSend(Http.Request req, Http.Response res, String visitorId) throws IOException {
        if (req.length < 0 || req.length > rooftop.model.ChatBox.MAX_BYTES) {
            req.body.skip(Math.max(0, req.length));
            res.send(413, TEXT, "message too large");
            return;
        }
        byte[] bytes = rooftop.util.Streams.readFully(req.body, (int) req.length);
        java.util.Set<String> to = new java.util.HashSet<>(java.util.Arrays.asList(req.query.getOrDefault("to", "").split(",")));
        boolean ok = !to.isEmpty() && to.size() <= 255 && to.stream().allMatch(id -> id.equals(visitorId) || canChat(id));
        int ttl;
        try {
            ttl = Math.max(0, Math.min(60, Integer.parseInt(req.query.getOrDefault("ttl", "0"))));
        } catch (NumberFormatException e) {
            ttl = 0;
        }
        if (!ok) {
            res.send(400, TEXT, "someone in that conversation cannot receive encrypted chat");
            return;
        }
        long seq = app.chat().add(visitorId, to, bytes, ttl);
        res.header("Cache-Control", "no-store").send(200, JSON, "{\"seq\":" + seq + "}");
    }

    /** Chat reaches devices that have a key even while they are briefly away (a phone in a pocket), not just online ones. */
    private boolean canChat(String id) {
        if (app.me().id().equals(id)) return !app.me().publicKey().isEmpty();
        return app.devices().find(id).filter(d -> !d.publicKey().isEmpty()).isPresent();
    }

    private String chatJson(Http.Request req, String visitorId) {
        long after;
        try {
            after = Long.parseLong(req.query.getOrDefault("after", "0"));
        } catch (NumberFormatException e) {
            after = 0;
        }
        StringJoiner out = new StringJoiner(",", "[", "]");
        for (rooftop.model.ChatBox.Envelope e : app.chat().since(after, visitorId))
            out.add("{\"seq\":" + e.seq() + ",\"from\":" + Texts.json(e.from()) + ",\"at\":" + e.at()
                    + ",\"data\":\"" + java.util.Base64.getEncoder().encodeToString(e.bytes()) + "\"}");
        return "{\"latest\":" + app.chat().latest() + ",\"envelopes\":" + out + "}";
    }

    /** A device with an end-to-end key: a connected browser, or this PC while its own page is open. */
    private boolean canReceiveSealed(String id) {
        if (app.me().id().equals(id)) return hostPageOpen() && !app.me().publicKey().isEmpty();
        return app.devices().find(id).filter(d -> d.isOnline() && !d.publicKey().isEmpty()).isPresent();
    }

    private boolean hostPageOpen() {
        return System.currentTimeMillis() - hostPageSeen < 10_000;
    }

    private PhoneClient visitor(Http.Request req) {
        String ua = req.header("User-Agent") != null ? req.header("User-Agent") : "";
        String browser = req.query.getOrDefault("device", "");
        String id = "web " + req.remote.getHostAddress() + (browser.matches("[0-9a-f]{16,40}") ? " " + browser : "");
        NetworkDevice device = app.devices().getOrAdd(id, () -> new PhoneClient(ua, req.remote, id));
        device.touch();
        return (PhoneClient) device; // keys starting with "web " only ever hold PhoneClients
    }

    /** "*" (everyone), "host", or the id of a device that is connected right now; anything else means everyone. */
    private String recipient(String to) {
        if (to == null || to.isEmpty() || ReceivedItem.EVERYONE.equals(to)) return ReceivedItem.EVERYONE;
        if (app.me().id().equals(to)) return to;
        return app.devices().find(to).isPresent() ? to : ReceivedItem.EVERYONE;
    }

    /** The host may remove any file; a phone only the files it sent. */
    private static boolean canRemove(ReceivedItem item, String visitorId, boolean local) {
        return local || item.fromId().equals(visitorId);
    }

    private String recipientName(String to) {
        if (ReceivedItem.EVERYONE.equals(to)) return "everyone";
        if (app.me().id().equals(to)) return app.me().name();
        return app.devices().find(to).map(NetworkDevice::name).orElse("a device that left");
    }

    private String stateJson(String visitor, String visitorId, boolean local) {
        StringJoiner devices = new StringJoiner(",", "[", "]");
        List<NetworkDevice> online = new ArrayList<>(app.devices().all());
        online.removeIf(d -> !d.isOnline() || d.id().equals(visitorId) || (!(d instanceof PhoneClient) && d.name().equals(visitor)));
        online.sort(Comparator.comparing(NetworkDevice::kind).thenComparing(NetworkDevice::name));
        for (NetworkDevice d : online)
            devices.add("{\"id\":" + Texts.json(d.id()) + ",\"name\":" + Texts.json(d.name()) + ",\"kind\":" + Texts.json(d.kind())
                    + ",\"key\":" + Texts.json(d.publicKey()) + "}");

        StringJoiner files = new StringJoiner(",", "[", "]");
        for (ReceivedItem i : app.inbox().newestFirst()) {
            if (!i.visibleTo(visitorId)) continue; // a file sent to one device stays private to it (and its sender)
            files.add("{\"name\":" + Texts.json(i.name()) + ",\"size\":" + i.size() + ",\"from\":" + Texts.json(i.from())
                    + ",\"to\":" + Texts.json(recipientName(i.to())) + ",\"at\":" + i.at()
                    + ",\"removable\":" + canRemove(i, visitorId, local) + ",\"mine\":" + i.fromId().equals(visitorId) + "}");
        }

        StringJoiner sealed = new StringJoiner(",", "[", "]"); // only ever this visitor's own
        try {
            for (SealedBox.Waiting w : app.sealed().waitingFor(visitorId))
                sealed.add("{\"id\":" + Texts.json(w.id()) + ",\"size\":" + w.size() + ",\"at\":" + w.at() + "}");
        } catch (IOException e) {
            // nothing to offer this time; the next poll tries again
        }

        StringJoiner texts = new StringJoiner(",", "[", "]");
        for (ReceivedText t : app.inbox().texts()) {
            if (!local && !t.visibleTo(visitorId)) continue; // the PC's own screen sees every message that passed through it
            texts.add("{\"text\":" + Texts.json(t.text()) + ",\"from\":" + Texts.json(t.from()) + ",\"fromId\":" + Texts.json(t.fromId())
                    + ",\"to\":" + Texts.json(recipientName(t.to()))
                    + ",\"private\":" + !ReceivedItem.EVERYONE.equals(t.to()) + ",\"mine\":" + t.fromId().equals(visitorId)
                    + ",\"forMe\":" + (t.to().equals(visitorId) || ReceivedItem.EVERYONE.equals(t.to())) + ",\"at\":" + t.at() + "}");
        }
        List<History.Entry> history = app.history().newestFirst();

        return "{\"me\":" + Texts.json(app.me().name()) + ",\"meId\":" + Texts.json(app.me().id()) + ",\"you\":" + Texts.json(visitor)
                + ",\"youId\":" + Texts.json(visitorId) + ",\"local\":" + local
                + ",\"devices\":" + devices + ",\"files\":" + files + ",\"texts\":" + texts + ",\"sealed\":" + sealed
                + ",\"historyAt\":" + (history.isEmpty() ? 0 : history.get(0).at())
                + ",\"session\":" + Texts.json(app.session()) + ",\"meNamed\":" + app.named() + ",\"chatSeq\":" + app.chat().latest()
                + ",\"meKey\":" + Texts.json(canReceiveSealed(app.me().id()) ? app.me().publicKey() : "")
                + ",\"youKey\":" + Texts.json(local ? app.me().publicKey() : app.devices().find(visitorId).map(Device::publicKey).orElse("")) + "}";
    }

    private String historyJson(String visitorId, boolean local) {
        StringJoiner out = new StringJoiner(",", "[", "]");
        for (History.Entry e : app.history().newestFirst()) {
            if (!local && !e.visibleTo(visitorId)) continue;
            out.add("{\"at\":" + e.at() + ",\"name\":" + Texts.json(e.name()) + ",\"size\":" + e.size() + ",\"from\":" + Texts.json(e.from())
                    + ",\"fromId\":" + Texts.json(e.fromId())
                    + ",\"to\":" + Texts.json(e.toName()) + ",\"ok\":" + e.ok() + ",\"ms\":" + e.millis()
                    + ",\"ratio\":" + String.format(Locale.ROOT, "%.3f", e.ratio()) + ",\"note\":" + Texts.json(e.note())
                    + ",\"mine\":" + e.fromId().equals(visitorId) + "}");
        }
        return out.toString();
    }

    private static String qrJson(String text) {
        StringJoiner rows = new StringJoiner(",", "[", "]");
        for (boolean[] row : QrCode.encode(text)) {
            StringBuilder sb = new StringBuilder(row.length);
            for (boolean dark : row) sb.append(dark ? '1' : '0');
            rows.add("\"" + sb + "\"");
        }
        return "{\"qr\":" + rows + "}";
    }

    private String connectJson() throws IOException {
        String url = phoneUrl(Network.lanIp());
        StringJoiner rows = new StringJoiner(",", "[", "]");
        for (boolean[] row : QrCode.encode(url)) {
            StringBuilder sb = new StringBuilder(row.length);
            for (boolean dark : row) sb.append(dark ? '1' : '0');
            rows.add("\"" + sb + "\"");
        }
        return "{\"url\":" + Texts.json(url) + ",\"pin\":" + Texts.json(app.pins().pin()) + ",\"secure\":" + "https".equals(scheme)
                + ",\"qr\":" + rows + "}";
    }

    private void serveFile(Http.Request req, Http.Response res, String rawName) throws IOException {
        Path file = app.inbox().pathOf(rawName);
        String name = file.getFileName().toString();
        String type = IMAGE_TYPES.get(FileNames.extension(name).toLowerCase(Locale.ROOT));
        res.header("Content-Security-Policy", "sandbox"); // a received .html can never run as our page
        if (req.query.containsKey("dl"))
            res.header("Content-Disposition", "attachment; filename*=UTF-8''" + URLEncoder.encode(name, "UTF-8").replace("+", "%20"));
        res.sendFile(type != null ? type : "application/octet-stream", file);
    }
}
