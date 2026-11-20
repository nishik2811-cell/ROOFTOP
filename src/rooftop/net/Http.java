package rooftop.net;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;
import javax.net.ssl.SSLException;
import rooftop.util.Threads;

/**
 * A deliberately small HTTP/1.1 server: keep-alive connections, Content-Length bodies only.
 * Written by hand because Android has no com.sun.net.httpserver, and the PC and phone builds share it.
 */
public final class Http {
    private static final int MAX_LINE = 8192;
    private static final int MAX_HEADERS = 100;
    private static final int TIMEOUT_MS = 60_000;
    private static final int HEAD_TIMEOUT_MS = 10_000; // to send the request line and headers
    private static final int IDLE_TIMEOUT_MS = 5_000; // a kept-alive connection waits this long for the next request
    private static final int MAX_REQUESTS_PER_CONNECTION = 1000;
    private static final long DRAIN_LIMIT = 256 * 1024; // unread body read away to keep the connection; more, and it closes
    /** Connections one address (or IPv6 /64) may hold open at once; this PC's own page is not limited. */
    private static final int MAX_PER_ADDRESS = 48;
    private static final Map<String, Integer> open = new java.util.concurrent.ConcurrentHashMap<>();

    private Http() {
    }

    /** Functional interface: the routes live in WebServer. */
    public interface Handler {
        void handle(Request request, Response response) throws Exception;
    }

    public static final class Request {
        public final String method;
        public final String path;
        public final Map<String, String> query;
        public final Map<String, String> headers;
        public final InetAddress remote;
        public final InputStream body;
        public final long length; // -1 when the client sent no Content-Length

        Request(String method, String path, Map<String, String> query, Map<String, String> headers,
                InetAddress remote, InputStream body, long length) {
            this.method = method;
            this.path = path;
            this.query = query;
            this.headers = headers;
            this.remote = remote;
            this.body = body;
            this.length = length;
        }

        public String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }
    }

    public static final class Response {
        private final OutputStream out;
        private final boolean head;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private boolean committed;
        private boolean keepAlive; // the connection carries another request afterwards (set by handle)

        Response(OutputStream out, boolean head) {
            this.out = out;
            this.head = head;
        }

        public Response header(String name, String value) {
            headers.put(name, value);
            return this;
        }

        public boolean isCommitted() {
            return committed;
        }

        public void send(int status, String type, String body) throws IOException {
            send(status, type, body.getBytes(StandardCharsets.UTF_8));
        }

        public void send(int status, String type, byte[] body) throws IOException {
            begin(status, type, body.length);
            if (!head) out.write(body);
            out.flush();
        }

        public void sendFile(String type, Path file) throws IOException {
            begin(200, type, Files.size(file));
            if (!head) Files.copy(file, out);
            out.flush();
        }

        private void begin(int status, String type, long length) throws IOException {
            if (committed) throw new IOException("response already sent");
            committed = true;
            StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
            headers.put("Content-Type", type);
            headers.put("Content-Length", String.valueOf(length));
            headers.put("Connection", keepAlive ? "keep-alive" : "close");
            headers.forEach((k, v) -> sb.append(k).append(": ").append(v).append("\r\n"));
            out.write(sb.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
        }

        private static String reason(int status) {
            switch (status) {
                case 200: return "OK";
                case 400: return "Bad Request";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 405: return "Method Not Allowed";
                case 411: return "Length Required";
                default: return "Error";
            }
        }
    }

    /** Accepts connections on a background thread; each request is handled on the pool. */
    public static void serve(ServerSocket server, Handler handler, ExecutorService pool, Consumer<String> log) {
        Threads.daemon("http-" + server.getLocalPort(), () -> {
            while (!server.isClosed()) {
                try {
                    Socket socket = server.accept();
                    InetAddress from = socket.getInetAddress();
                    String key = from.isLoopbackAddress() ? null : rooftop.security.PinGuard.group(from.getHostAddress());
                    // one device on the network must not take every worker, PIN or not
                    if (key != null && open.merge(key, 1, Integer::sum) > MAX_PER_ADDRESS) {
                        open.merge(key, -1, Integer::sum);
                        socket.close();
                        continue;
                    }
                    try {
                        pool.execute(() -> {
                            try { handle(socket, handler, log); }
                            finally { if (key != null) open.merge(key, -1, (a, b) -> a + b == 0 ? null : a + b); }
                        });
                    } catch (java.util.concurrent.RejectedExecutionException busy) {
                        if (key != null) open.merge(key, -1, (a, b) -> a + b == 0 ? null : a + b);
                        socket.close(); // every worker is busy: the browser retries
                    }
                } catch (IOException e) {
                    if (!server.isClosed()) log.accept("http accept failed: " + e.getMessage());
                }
            }
        });
    }

    private static void handle(Socket socket, Handler handler, Consumer<String> log) {
        try (socket) {
            socket.setTcpNoDelay(true); // send replies at once: Nagle + delayed ACKs otherwise stall every request ~40 ms
            InputStream in = new BufferedInputStream(socket.getInputStream(), 64 * 1024);
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);
            // Keep-alive: a file goes up in pieces, and a new connection per piece meant a new TLS handshake and TCP slow
            // start each time, which over Wi-Fi cost more than the piece itself. So the connection serves request after
            // request, until the browser says close, a body is left unread, or it sits idle.
            for (int served = 0; served < MAX_REQUESTS_PER_CONNECTION; served++) {
                socket.setSoTimeout(served == 0 ? HEAD_TIMEOUT_MS : IDLE_TIMEOUT_MS);
                String requestLine;
                try {
                    requestLine = readLine(in);
                } catch (java.net.SocketTimeoutException idle) {
                    if (served > 0) return; // a kept-alive connection nobody used again: close it quietly
                    throw idle;
                }
                if (requestLine == null) return;
                socket.setSoTimeout(HEAD_TIMEOUT_MS); // the rest of the request line and headers
                String[] parts = requestLine.split(" ");
                if (parts.length != 3) {
                    new Response(out, false).send(400, "text/plain", "bad request");
                    return;
                }
                Map<String, String> headers = new HashMap<>();
                for (String line = readLine(in); line != null && !line.isEmpty(); line = readLine(in)) {
                    int colon = line.indexOf(':');
                    if (colon > 0) {
                        String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT), value = line.substring(colon + 1).trim();
                        String before = headers.put(name, value);
                        if (name.equals("content-length") && before != null && !before.equals(value)) { // two lengths: no telling
                            new Response(out, false).send(400, "text/plain", "bad request");             // where this body ends
                            return;
                        }
                    }
                    if (headers.size() > MAX_HEADERS) throw new IOException("too many headers");
                }
                boolean keepAlive = keepAlive(parts[2], headers);
                Response response = new Response(out, "HEAD".equals(parts[0]));
                response.keepAlive = keepAlive;
                socket.setSoTimeout(TIMEOUT_MS); // headers are in: the body (a few MB) gets longer
                URI uri;
                try {
                    uri = new URI(parts[1]);
                } catch (URISyntaxException e) {
                    new Response(out, false).send(400, "text/plain", "bad address");
                    return;
                }
                String lengthHeader = headers.get("content-length");
                long length = lengthHeader == null ? -1 : Long.parseLong(lengthHeader);
                if (lengthHeader != null && length < 0) { // a negative length would leave its body to be read as a request
                    new Response(out, false).send(400, "text/plain", "bad request");
                    return;
                }
                LimitedInputStream body = new LimitedInputStream(in, Math.max(length, 0));
                Request request = new Request(parts[0], uri.getPath(), query(uri), headers, socket.getInetAddress(), body, length);
                handler.handle(request, response);
                out.flush();
                if (!keepAlive || !response.isCommitted()) return;
                // the next request starts after this body: read away what the route left, or close if that is a lot
                if (body.left() > DRAIN_LIMIT) return;
                body.skipRest();
            }
        } catch (SSLException e) {
            // A phone that has not accepted the certificate yet hangs up during the handshake. Normal.
        } catch (Exception e) {
            log.accept("http error: " + e);
        }
    }

    /**
     * Whether this connection may carry another request after this one. Only Content-Length bodies are understood, so
     * a chunked one ends the connection: guessing where the next request starts is how requests get smuggled.
     */
    private static boolean keepAlive(String version, Map<String, String> headers) {
        if (headers.containsKey("transfer-encoding")) return false;
        String connection = headers.getOrDefault("connection", "").toLowerCase(Locale.ROOT);
        return "HTTP/1.1".equals(version) ? !connection.contains("close") : connection.contains("keep-alive");
    }

    /** Reads one CRLF-terminated header line, or null at end of stream. */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') line.write(b);
            if (line.size() > MAX_LINE) throw new IOException("header line too long");
        }
        if (b == -1 && line.size() == 0) return null;
        return line.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static Map<String, String> query(URI uri) {
        Map<String, String> result = new HashMap<>();
        String raw = uri.getRawQuery();
        if (raw == null) return result;
        try {
            for (String pair : raw.split("&")) {
                String[] kv = pair.split("=", 2);
                result.put(URLDecoder.decode(kv[0], "UTF-8"), kv.length > 1 ? URLDecoder.decode(kv[1], "UTF-8") : "");
            }
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e); // UTF-8 always exists
        }
        return result;
    }

    /** Stops the handler from reading past the request body into the next request. */
    private static final class LimitedInputStream extends InputStream {
        private final InputStream in;
        private long left;

        LimitedInputStream(InputStream in, long limit) {
            this.in = in;
            this.left = limit;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = in.read();
            if (b != -1) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        /** Bytes of the body nobody has read yet. */
        long left() {
            return left;
        }

        /** Reads away the rest of the body, so the connection is at the start of the next request. */
        void skipRest() throws IOException {
            byte[] buf = new byte[8192];
            while (left > 0 && read(buf, 0, buf.length) > 0) { /* discard */ }
            if (left > 0) throw new IOException("the request ended before its body did");
        }
    }
}
