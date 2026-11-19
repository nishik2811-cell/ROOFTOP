package app.rooftop;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/**
 * A small log in the app's own storage that survives restarts and crashes, so a glitch while the app opens can be
 * shown (and shared) once it does open. No developer options or cable needed.
 */
final class Diag {
    private static final long MAX_BYTES = 64 * 1024;
    private static File file;

    private Diag() {
    }

    /** Once per process: where the log lives, and a crash is written down before the process dies. */
    static synchronized void init(Context context) {
        if (file != null) return;
        file = new File(context.getApplicationContext().getFilesDir(), "startup.log");
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            add("CRASH in " + thread.getName() + ": " + android.util.Log.getStackTraceString(e));
            if (previous != null) previous.uncaughtException(thread, e);
        });
        add("process started");
    }

    static synchronized void add(String event) {
        if (file == null) return;
        try {
            if (file.length() > MAX_BYTES) { // keep the newer half
                byte[] all = Files.readAllBytes(file.toPath());
                Files.write(file.toPath(), Arrays.copyOfRange(all, all.length / 2, all.length));
            }
            String line = new SimpleDateFormat("HH:mm:ss.SSS", Locale.ROOT).format(new Date())
                    + " [" + android.os.Process.myPid() + "] " + event + "\n";
            Files.write(file.toPath(), line.getBytes(StandardCharsets.UTF_8), StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            // the log is a help, never a reason to fail
        }
    }

    /** The last {@code maxChars} of the log. */
    static synchronized String recent(int maxChars) {
        try {
            String all = file == null ? "" : new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            return all.length() > maxChars ? all.substring(all.length() - maxChars) : all;
        } catch (IOException e) {
            return "(could not read the log: " + e.getMessage() + ")";
        }
    }

    /** This app's own recent lines from Android's log (an app may read its own): the browser engine's errors, crashes. */
    static String systemLog(int maxChars) {
        StringBuilder out = new StringBuilder();
        try {
            Process logcat = new ProcessBuilder("logcat", "-d", "-t", "400", "-v", "time").redirectErrorStream(true).start();
            try (BufferedReader in = new BufferedReader(new InputStreamReader(logcat.getInputStream(), StandardCharsets.UTF_8))) {
                for (String line; (line = in.readLine()) != null; ) out.append(line).append('\n');
            }
        } catch (IOException e) {
            out.append("(could not read Android's log: ").append(e.getMessage()).append(")\n");
        }
        return out.length() > maxChars ? out.substring(out.length() - maxChars) : out.toString();
    }
}
