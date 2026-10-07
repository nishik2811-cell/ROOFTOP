package rooftop;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import rooftop.security.SecureChannel;

/**
 * Measures transfer speed for different chunk sizes, so the default is chosen from data, not a guess.
 * Real disk read on the sender, real encryption (SecureChannel), real disk write on the receiver.
 *
 *   java src/rooftop/Benchmark.java                 this machine only (loopback: shows CPU, disk and crypto cost)
 *   java src/rooftop/Benchmark.java serve           on PC A: wait for a benchmark over the real network
 *   java src/rooftop/Benchmark.java to <ip-of-A>    on PC B: run it across the Wi-Fi to A
 *   add "--mb 200" for a bigger test file (default 100 MB), "--runs 5" for more repetitions (default 3)
 */
public class Benchmark {
    private static final String BENCH_PIN = "benchmark"; // both ends of a speed test are your own PCs

    private static final int PORT = 45460;
    private static final int[] SIZES = {64 << 10, 128 << 10, 256 << 10, 512 << 10, 1 << 20};

    public static void main(String[] args) throws Exception {
        List<String> a = Arrays.asList(args);
        int mb = a.contains("--mb") ? Integer.parseInt(a.get(a.indexOf("--mb") + 1)) : 100;
        int runs = a.contains("--runs") ? Integer.parseInt(a.get(a.indexOf("--runs") + 1)) : 3;
        if (a.contains("serve")) { serve(); return; }
        String host = a.contains("to") ? a.get(a.indexOf("to") + 1) : null;

        Path file = Files.createTempFile("rooftop-bench", ".bin");
        try (OutputStream out = Files.newOutputStream(file)) { // random bytes: nothing compresses or caches away
            byte[] block = new byte[1 << 20];
            Random r = new Random(1);
            for (int i = 0; i < mb; i++) { r.nextBytes(block); out.write(block); }
        }
        Thread server = null;
        if (host == null) { server = new Thread(() -> { try { serve(); } catch (IOException ignored) { } }); server.setDaemon(true); server.start(); Thread.sleep(300); }
        String target = host == null ? "127.0.0.1" : host;

        System.out.printf(Locale.ROOT, "Rooftop benchmark: %d MB file, %d runs per size, to %s%n", mb, runs, host == null ? "this machine (loopback)" : host);
        for (int size : SIZES) sendOnce(file, target, size); // warm-up: let the JIT compile the hot path before timing anything
        System.out.println("chunk      median MB/s   median time   all runs (MB/s)");
        for (int size : SIZES) {
            List<Double> speeds = new ArrayList<>();
            List<Double> times = new ArrayList<>();
            for (int run = 0; run < runs; run++) {
                double seconds = sendOnce(file, target, size);
                times.add(seconds);
                speeds.add(Files.size(file) / 1e6 / seconds);
            }
            List<Double> sorted = new ArrayList<>(speeds);
            sorted.sort(null);
            List<Double> sortedTimes = new ArrayList<>(times);
            sortedTimes.sort(null);
            StringBuilder all = new StringBuilder();
            for (double s : speeds) all.append(String.format(Locale.ROOT, "%.1f ", s));
            System.out.printf(Locale.ROOT, "%-8s   %8.1f      %8.2f s    %s%n", label(size), sorted.get(runs / 2), sortedTimes.get(runs / 2), all.toString().trim());
        }
        Files.deleteIfExists(file);
    }

    private static String label(int size) {
        return size >= 1 << 20 ? (size >> 20) + " MB" : (size >> 10) + " KB";
    }

    /** One transfer: chunk size and length up front, then the data, then a one-byte receipt. */
    private static double sendOnce(Path file, String host, int chunk) throws IOException {
        long size = Files.size(file);
        try (Socket socket = new Socket(host, PORT); InputStream src = Files.newInputStream(file)) {
            SecureChannel ch = SecureChannel.open(socket, true, BENCH_PIN, chunk);
            DataOutputStream out = new DataOutputStream(ch.output());
            out.writeInt(chunk);
            out.writeLong(size);
            out.flush();
            long start = System.nanoTime();
            byte[] buf = new byte[chunk];
            for (int n; (n = src.read(buf)) > 0; ) out.write(buf, 0, n);
            out.flush();
            if (ch.input().read() != 'K') throw new IOException("no receipt");
            return (System.nanoTime() - start) / 1e9;
        }
    }

    /** Receives benchmark files and writes them to disk, like a real transfer, then throws them away. */
    private static void serve() throws IOException {
        try (ServerSocket server = new ServerSocket(PORT)) {
            System.out.println("Benchmark receiver ready on port " + PORT + " (" + InetAddress.getLocalHost().getHostAddress() + "). Ctrl+C to stop.");
            while (true) {
                try (Socket s = server.accept()) {
                    SecureChannel ch = SecureChannel.open(s, false, BENCH_PIN);
                    DataInputStream in = new DataInputStream(new BufferedInputStream(ch.input(), 1 << 20));
                    int chunk = in.readInt();
                    long left = in.readLong();
                    Path sink = Files.createTempFile("rooftop-bench-recv", ".part");
                    try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(sink), chunk)) {
                        byte[] buf = new byte[chunk];
                        while (left > 0) {
                            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                            if (n < 0) throw new IOException("cut off");
                            out.write(buf, 0, n);
                            left -= n;
                        }
                    }
                    Files.deleteIfExists(sink);
                    ch.output().write('K');
                    ch.output().flush();
                }
            }
        }
    }
}
