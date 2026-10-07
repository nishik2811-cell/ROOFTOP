package rooftop.util;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import rooftop.model.Progress;

public final class Streams {
    /** Transfer chunk size. Default 128 KB: fastest in Benchmark on our test laptop (see report); override with -Drooftop.buffer=... */
    public static final int CHUNK = Math.max(16 * 1024, Math.min(1 << 20, Integer.getInteger("rooftop.buffer", 128 * 1024)));
    /** The largest chunk any Rooftop accepts, whatever the sender chose. */
    public static final int MAX_CHUNK = 1 << 20;

    private Streams() {
    }

    /** Copies exactly {@code size} bytes in 64 KB chunks, reporting progress as it goes. */
    public static void copy(InputStream in, OutputStream out, long size, Progress progress) throws IOException {
        byte[] buf = new byte[CHUNK];
        long left = size;
        int n;
        while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
            out.write(buf, 0, n);
            left -= n;
            progress.add(n);
        }
        if (left > 0) throw new EOFException("connection closed with " + left + " bytes still missing");
    }

    /** Reads exactly {@code n} bytes (InputStream.readNBytes only exists on newer Android versions). */
    public static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new EOFException("cut off after " + off + " of " + n + " bytes");
            off += r;
        }
        return buf;
    }

    /** Reads until end of stream, but never more than {@code max} bytes. */
    public static byte[] readUpTo(InputStream in, int max) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while (out.size() < max && (r = in.read(buf, 0, Math.min(buf.length, max - out.size()))) > 0) out.write(buf, 0, r);
        return out.toByteArray();
    }
}
