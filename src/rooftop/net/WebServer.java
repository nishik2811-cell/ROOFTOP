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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLContext;
import rooftop.Rooftop;
import rooftop.error.InvalidFileNameException;
import rooftop.error.WrongPinException;
import rooftop.model.NetworkDevice;
import rooftop.model.PhoneClient;
import rooftop.model.Progress;
import rooftop.model.ReceivedItem;
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
        PAGES.put("/display.woff2", new String[]{"display.woff2", "font/woff2"}); // Big Shoulders Display (OFL), for the intro
        // shown inline so murals can use them; everything else (html, svg, ...) is a plain download
        IMAGE_TYPES.put("jpg", "image/jpeg");
        IMAGE_TYPES.put("jpeg", "image/jpeg");
        IMAGE_TYPES.put("png", "image/png");
        IMAGE_TYPES.put("gif", "image/gif");
        IMAGE_TYPES.put("webp", "image/webp");
        IMAGE_TYPES.put("avif", "image/avif");
    }

    private final Rooftop app;
    private String scheme = "https";

    public WebServer(Rooftop app) {
        this.app = app;
    }

    public void start() throws IOException {
        ExecutorService pool = Executors.newCachedThreadPool();
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

        switch (route) {
            case "/state" -> res.send(200, JSON, stateJson(visitor, visitorId, local));
            case "/connect" -> {
                if (local) res.send(200, JSON, connectJson());
                else res.send(404, TEXT, "not found");
            }
            case "/upload" -> {
                if (!post) res.send(405, TEXT, "POST only");
                else if (req.length < 0) res.send(411, TEXT, "Content-Length required");
                else {
                    String to = recipient(req.query.get("to"));
                    long started = System.nanoTime();
                    ReceivedItem item = app.inbox().store(req.query.get("name"), req.body, req.length, visitor, visitorId, to, new Progress(req.length));
                    app.log().add(visitor + " -> " + recipientName(to) + ": " + item.name() + " (" + Texts.humanSize(req.length) + ", "
                            + Texts.speed(req.length, System.nanoTime() - started) + ")");
                    res.send(200, JSON, "{\"name\":" + Texts.json(item.name()) + "}");
                }
            }
            case "/text" -> {
                if (!post) {
                    res.send(405, TEXT, "POST only");
                    return;
                }
                String text = new String(rooftop.util.Streams.readUpTo(req.body, Wire.MAX_TEXT), StandardCharsets.UTF_8);
                if (!text.trim().isEmpty()) app.receiveText(text, visitor);
                res.send(200, TEXT, "ok");
            }
            case "/clip" -> res.send(200, TEXT, app.clipboard());
            case "/session" -> { // only the host itself may end the session
                if (!local) res.send(404, TEXT, "not found");
                else if (!post) res.send(405, TEXT, "POST only");
                else {
                    app.newSession();
                    res.send(200, JSON, connectJson());
                }
            }
            default -> {
                if (route.startsWith("/files/")) {
                    String name = route.substring("/files/".length());
                    boolean allowed = app.inbox().newestFirst().stream().anyMatch(i -> i.name().equals(name) && i.visibleTo(visitorId));
                    if (allowed) serveFile(req, res, name);
                    else res.send(404, TEXT, "not found");
                }
                else res.send(404, TEXT, "not found");
            }
        }
    }

    private PhoneClient visitor(Http.Request req) {
        String ua = req.header("User-Agent") != null ? req.header("User-Agent") : "";
        NetworkDevice device = app.devices().getOrAdd("web " + req.remote.getHostAddress(), () -> new PhoneClient(ua, req.remote));
        device.touch();
        return (PhoneClient) device; // keys starting with "web " only ever hold PhoneClients
    }

    /** "*" (everyone), "host", or the id of a device that is connected right now; anything else means everyone. */
    private String recipient(String to) {
        if (to == null || to.isEmpty() || ReceivedItem.EVERYONE.equals(to)) return ReceivedItem.EVERYONE;
        if (app.me().id().equals(to)) return to;
        return app.devices().find(to).isPresent() ? to : ReceivedItem.EVERYONE;
    }

    private String recipientName(String to) {
        if (ReceivedItem.EVERYONE.equals(to)) return "everyone";
        if (app.me().id().equals(to)) return app.me().name();
        return app.devices().find(to).map(NetworkDevice::name).orElse(to);
    }

    private String stateJson(String visitor, String visitorId, boolean local) {
        StringJoiner devices = new StringJoiner(",", "[", "]");
        List<NetworkDevice> online = new ArrayList<>(app.devices().all());
        online.removeIf(d -> !d.isOnline() || d.name().equals(visitor));
        online.sort(Comparator.comparing(NetworkDevice::kind).thenComparing(NetworkDevice::name));
        for (NetworkDevice d : online)
            devices.add("{\"id\":" + Texts.json(d.id()) + ",\"name\":" + Texts.json(d.name()) + ",\"kind\":" + Texts.json(d.kind()) + "}");

        StringJoiner files = new StringJoiner(",", "[", "]");
        for (ReceivedItem i : app.inbox().newestFirst()) {
            if (!i.visibleTo(visitorId)) continue; // a file sent to one device stays private to it (and its sender)
            files.add("{\"name\":" + Texts.json(i.name()) + ",\"size\":" + i.size() + ",\"from\":" + Texts.json(i.from())
                    + ",\"to\":" + Texts.json(recipientName(i.to())) + ",\"at\":" + i.at() + "}");
        }

        StringJoiner texts = new StringJoiner(",", "[", "]");
        for (ReceivedText t : app.inbox().texts())
            texts.add("{\"text\":" + Texts.json(t.text()) + ",\"from\":" + Texts.json(t.from()) + ",\"at\":" + t.at() + "}");

        return "{\"me\":" + Texts.json(app.me().name()) + ",\"meId\":" + Texts.json(app.me().id()) + ",\"you\":" + Texts.json(visitor)
                + ",\"youId\":" + Texts.json(visitorId) + ",\"local\":" + local
                + ",\"devices\":" + devices + ",\"files\":" + files + ",\"texts\":" + texts + "}";
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
