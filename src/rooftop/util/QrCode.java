package rooftop.util;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** QR code encoder, standard library only: version 3, error correction L, mask 0 (URLs up to 53 bytes). */
public final class QrCode {
    private QrCode() {
    }

    public static boolean[][] encode(String text) {
        byte[] in = text.getBytes(StandardCharsets.UTF_8);
        int size = 29, dataLen = 55, eccLen = 15;
        if (in.length > 53) throw new IllegalArgumentException("QR text too long");
        boolean[][] dark = new boolean[size][size], fixed = new boolean[size][size];
        // function patterns: timing lines, 3 finders, 1 alignment, format bits
        for (int i = 0; i < size; i++) { put(dark, fixed, 6, i, i % 2 == 0); put(dark, fixed, i, 6, i % 2 == 0); }
        for (int[] c : new int[][]{{3, 3}, {size - 4, 3}, {3, size - 4}})
            for (int dy = -4; dy <= 4; dy++)
                for (int dx = -4; dx <= 4; dx++) {
                    int x = c[0] + dx, y = c[1] + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
                    if (x >= 0 && x < size && y >= 0 && y < size) put(dark, fixed, x, y, d != 2 && d != 4);
                }
        for (int dy = -2; dy <= 2; dy++)
            for (int dx = -2; dx <= 2; dx++) put(dark, fixed, 22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
        int fmt = 1 << 3; // ECC level L = 01, mask 000
        int rem = fmt;
        for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        int bits = (fmt << 10 | rem) ^ 0x5412;
        for (int i = 0; i <= 5; i++) put(dark, fixed, 8, i, bit(bits, i));
        put(dark, fixed, 8, 7, bit(bits, 6));
        put(dark, fixed, 8, 8, bit(bits, 7));
        put(dark, fixed, 7, 8, bit(bits, 8));
        for (int i = 9; i < 15; i++) put(dark, fixed, 14 - i, 8, bit(bits, i));
        for (int i = 0; i < 8; i++) put(dark, fixed, size - 1 - i, 8, bit(bits, i));
        for (int i = 8; i < 15; i++) put(dark, fixed, 8, size - 15 + i, bit(bits, i));
        put(dark, fixed, 8, size - 8, true);
        // data: byte mode header, payload, terminator, padding, then Reed-Solomon ECC
        byte[] data = new byte[dataLen + eccLen];
        int pos = 0;
        long acc = 0b0100L << 8 | in.length;
        int accBits = 12;
        for (byte b : in) { acc = acc << 8 | (b & 0xFF); accBits += 8; while (accBits >= 8) data[pos++] = (byte) (acc >>> (accBits -= 8)); }
        if (accBits > 0) data[pos++] = (byte) (acc << (8 - accBits)); // terminator zeros fill the rest
        for (int pad = 0xEC; pos < dataLen; pad ^= 0xEC ^ 0x11) data[pos++] = (byte) pad;
        byte[] ecc = rsRemainder(Arrays.copyOf(data, dataLen), eccLen);
        System.arraycopy(ecc, 0, data, dataLen, eccLen);
        // zigzag placement in 2-column strips from the bottom-right, then mask 0
        int i = 0;
        for (int right = size - 1; right >= 1; right -= 2) {
            if (right == 6) right = 5;
            for (int vert = 0; vert < size; vert++)
                for (int j = 0; j < 2; j++) {
                    int x = right - j, y = ((right + 1) & 2) == 0 ? size - 1 - vert : vert;
                    if (fixed[y][x]) continue;
                    if (i < data.length * 8) dark[y][x] = bit(data[i >>> 3], 7 - (i & 7));
                    i++;
                    if ((x + y) % 2 == 0) dark[y][x] = !dark[y][x];
                }
        }
        return dark;
    }

    private static void put(boolean[][] dark, boolean[][] fixed, int x, int y, boolean v) { dark[y][x] = v; fixed[y][x] = true; }

    private static boolean bit(int v, int i) { return ((v >>> i) & 1) != 0; }

    private static byte[] rsRemainder(byte[] data, int degree) {
        int[] gen = new int[degree];
        gen[degree - 1] = 1;
        for (int i = 0, root = 1; i < degree; i++, root = gfMul(root, 2))
            for (int j = 0; j < degree; j++) gen[j] = gfMul(gen[j], root) ^ (j + 1 < degree ? gen[j + 1] : 0);
        byte[] r = new byte[degree];
        for (byte b : data) {
            int factor = (b ^ r[0]) & 0xFF;
            System.arraycopy(r, 1, r, 0, degree - 1);
            r[degree - 1] = 0;
            for (int j = 0; j < degree; j++) r[j] ^= (byte) gfMul(gen[j], factor);
        }
        return r;
    }

    private static int gfMul(int x, int y) {
        int z = 0;
        for (int i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
        return z;
    }

    /** Two QR rows per text line using '▀' with explicit black/white colors, so it scans on dark or light terminals. */
    public static String toTerminal(boolean[][] m) {
        int n = m.length, q = 2;
        StringBuilder sb = new StringBuilder();
        for (int y = -q; y < n + q; y += 2) {
            for (int x = -q; x < n + q; x++) {
                boolean top = in(m, x, y), bottom = in(m, x, y + 1);
                sb.append(top ? "\033[30m" : "\033[97m").append(bottom ? "\033[40m" : "\033[107m").append('▀');
            }
            sb.append("\033[0m\n");
        }
        return sb.toString();
    }

    private static boolean in(boolean[][] m, int x, int y) { return y >= 0 && y < m.length && x >= 0 && x < m.length && m[y][x]; }
}
