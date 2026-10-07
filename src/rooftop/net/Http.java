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
 * A deliberately small HTTP/1.1 server: one request per connection, Content-Length bodies only.
 * Written by hand because Android has no com.sun.net.httpserver, and the PC and phone builds share it.
 */
public final class Http {
    private static final int MAX_LINE = 8192;
    private static final int MAX_HEADERS = 100;
    private static final int TIMEOUT_MS = 60_000;

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
            headers.put("Connection", "close");
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
                    pool.execute(() -> handle(socket, handler, log));
                } catch (IOException e) {
                    if (!server.isClosed()) log.accept("http accept failed: " + e.getMessage());
                }
            }
        });
    }

    private static void handle(Socket socket, Handler handler, Consumer<String> log) {
        try (socket) {
            socket.setSoTimeout(TIMEOUT_MS);
            InputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = new BufferedOutputStream(socket.getOutputStream());
            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            Response response = new Response(out, parts.length > 0 && "HEAD".equals(parts[0]));
            if (parts.length != 3) {
                response.send(400, "text/plain", "bad request");
                return;
            }
            Map<String, String> headers = new HashMap<>();
            for (String line = readLine(in); line != null && !line.isEmpty(); line = readLine(in)) {
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
                if (headers.size() > MAX_HEADERS) throw new IOException("too many headers");
            }
            URI uri;
            try {
                uri = new URI(parts[1]);
            } catch (URISyntaxException e) {
                response.send(400, "text/plain", "bad address");
                return;
            }
            String lengthHeader = headers.get("content-length");
            long length = lengthHeader == null ? -1 : Long.parseLong(lengthHeader);
            Request request = new Request(parts[0], uri.getPath(), query(uri), headers, socket.getInetAddress(),
                    new LimitedInputStream(in, Math.max(length, 0)), length);
            handler.handle(request, response);
            out.flush();
        } catch (SSLException e) {
            // A phone that has not accepted the certificate yet hangs up during the handshake. Normal.
        } catch (Exception e) {
            log.accept("http error: " + e);
        }
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
    }
}
