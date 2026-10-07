package rooftop.net;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;
import rooftop.security.FileNames;

/**
 * Compression for PC-to-PC files, used only where it pays off. The bytes travel in frames of up to 1 MB and each
 * frame is deflated only when that makes it clearly smaller. Photos, videos and archives are never tried, and a
 * file whose first frames do not shrink stops being tried, so incompressible data costs almost no CPU.
 *
 * <p>Frame: 1 byte (0 stored, 1 deflated), 4 bytes original length, 4 bytes length on the wire, then the bytes.
 */
public final class Frames {
    public static final int FRAME = 1 << 20;
    private static final int MAX_WIRE = FRAME + FRAME / 8 + 64;
    private static final double WORTH_IT = 0.9; // a deflated frame must be at least 10% smaller
    private static final int GIVE_UP_AFTER = 3;  // frames in a row that did not shrink
    private static final Set<String> PACKED = new HashSet<>(Arrays.asList( // Set.of needs Android 11
            "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "mp4", "m4v", "mov", "mkv", "webm", "avi",
            "mp3", "m4a", "aac", "ogg", "opus", "flac", "zip", "gz", "tgz", "7z", "rar", "xz", "bz2", "zst", "br",
            "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "apk", "aab", "ipa", "jar", "dmg", "pdf"));

    private Frames() {
    }

    /** False for formats that are compressed already. */
    public static boolean worthTrying(String fileName) {
        return !PACKED.contains(FileNames.extension(fileName).toLowerCase(Locale.ROOT));
    }

    /** Sender side. Call {@link #finish()} after the last byte; it does not close the stream underneath. */
    public static final class Encoder extends OutputStream {
        private final DataOutputStream out;
        private final byte[] buf = new byte[FRAME];
        private final byte[] packed = new byte[MAX_WIRE];
        private final Deflater deflater = new Deflater(Deflater.BEST_SPEED);
        private boolean trying;
        private int filled, misses;
        private long raw, wire;

        public Encoder(OutputStream out, boolean trying) {
            this.out = out instanceof DataOutputStream d ? d : new DataOutputStream(out);
            this.trying = trying;
        }

        @Override
        public void write(int b) throws IOException {
            buf[filled++] = (byte) b;
            if (filled == FRAME) emit();
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                int n = Math.min(len, FRAME - filled);
                System.arraycopy(b, off, buf, filled, n);
                filled += n;
                off += n;
                len -= n;
                if (filled == FRAME) emit();
            }
        }

        public void finish() throws IOException {
            if (filled > 0) emit();
            deflater.end();
            out.flush();
        }

        /** Bytes put on the wire per byte of file, e.g. 0.31 for text; 1.0 when nothing was compressed. */
        public double ratio() {
            return raw == 0 ? 1 : (double) wire / raw;
        }

        private void emit() throws IOException {
            int len = filled;
            boolean deflated = false;
            if (trying) {
                deflater.reset();
                deflater.setInput(buf, 0, filled);
                deflater.finish();
                int m = 0;
                while (!deflater.finished() && m < packed.length) m += deflater.deflate(packed, m, packed.length - m);
                if (deflater.finished() && m < filled * WORTH_IT) {
                    deflated = true;
                    len = m;
                    misses = 0;
                } else if (++misses >= GIVE_UP_AFTER) {
                    trying = false;
                }
            }
            out.writeByte(deflated ? 1 : 0);
            out.writeInt(filled);
            out.writeInt(len);
            out.write(deflated ? packed : buf, 0, len);
            raw += filled;
            wire += len + 9;
            filled = 0;
        }
    }

    /** Receiver side. Reads only whole frames, so it never takes bytes that come after the last one. */
    public static final class Decoder extends InputStream {
        private final DataInputStream in;
        private final byte[] buf = new byte[FRAME];
        private final byte[] packed = new byte[MAX_WIRE];
        private final Inflater inflater = new Inflater();
        private int pos, limit;

        public Decoder(InputStream in) {
            this.in = in instanceof DataInputStream d ? d : new DataInputStream(in);
        }

        @Override
        public int read() throws IOException {
            if (pos == limit && !next()) return -1;
            return buf[pos++] & 0xFF;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (pos == limit && !next()) return -1;
            int n = Math.min(len, limit - pos);
            System.arraycopy(buf, pos, b, off, n);
            pos += n;
            return n;
        }

        @Override
        public void close() {
            inflater.end(); // the connection underneath stays open for the checksum that follows
        }

        private boolean next() throws IOException {
            int kind;
            try {
                kind = in.readUnsignedByte();
            } catch (EOFException e) {
                return false;
            }
            int raw = in.readInt(), len = in.readInt();
            if (kind > 1 || raw < 1 || raw > FRAME || len < 1 || len > MAX_WIRE || (kind == 0 && len != raw))
                throw new IOException("damaged frame in compressed transfer");
            if (kind == 0) {
                in.readFully(buf, 0, raw);
            } else {
                in.readFully(packed, 0, len);
                inflater.reset();
                inflater.setInput(packed, 0, len);
                int got = 0;
                try {
                    while (got < raw && !inflater.finished()) {
                        int n = inflater.inflate(buf, got, raw - got);
                        if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break;
                        got += n;
                    }
                } catch (DataFormatException e) {
                    throw new IOException("damaged frame in compressed transfer", e);
                }
                if (got != raw || !inflater.finished()) throw new IOException("damaged frame in compressed transfer");
            }
            pos = 0;
            limit = raw;
            return true;
        }
    }
}
