package rooftop.util;

import java.time.LocalTime;

/** Written from many threads at once, so it uses StringBuffer (synchronized) instead of StringBuilder. */
public class ActivityLog {
    private static final int KEEP_CHARS = 8000;

    private final StringBuffer buffer = new StringBuffer();

    public void add(String line) {
        String stamped = LocalTime.now().withNano(0) + "  " + line;
        System.out.println(stamped);
        synchronized (buffer) { // append + trim must happen together
            buffer.append(stamped).append('\n');
            if (buffer.length() > KEEP_CHARS)
                buffer.delete(0, buffer.indexOf("\n", buffer.length() - KEEP_CHARS) + 1);
        }
    }

    public String recent() {
        return buffer.toString();
    }
}
