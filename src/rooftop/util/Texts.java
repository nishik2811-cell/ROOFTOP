package rooftop.util;

import java.util.Locale;

/** String helpers. StringBuilder here because every call is confined to one thread. */
public final class Texts {
    private Texts() {
    }

    public static boolean isPalindrome(String s) {
        return new StringBuilder(s).reverse().toString().equals(s);
    }

    public static String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        String units = "KMGT";
        double value = bytes;
        int unit = -1;
        do {
            value /= 1024;
            unit++;
        } while (value >= 1024 && unit < units.length() - 1);
        return String.format(Locale.ROOT, "%.1f %sB", value, units.charAt(unit));
    }

    /** "[#########...........] 45%" */
    public static String bar(int percent, int width) {
        StringBuilder sb = new StringBuilder(width + 8).append('[');
        int filled = percent * width / 100;
        for (int i = 0; i < width; i++) sb.append(i < filled ? '#' : '.');
        return sb.append("] ").append(percent).append('%').toString();
    }

    /** Average speed from bytes and elapsed nanoseconds, e.g. "31.4 MB/s" (1 MB = 1,000,000 bytes). */
    public static String speed(long bytes, long nanos) {
        if (nanos <= 0) return "n/a";
        return String.format(Locale.ROOT, "%.1f MB/s", bytes / 1e6 / (nanos / 1e9));
    }

    /** Quotes and escapes a string for hand-built JSON. */
    public static String json(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }
}
