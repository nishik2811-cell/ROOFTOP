package app.rooftop;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import rooftop.Platform;

/** The phone's side of {@link Platform}: page files from the APK, the Android clipboard, app storage. */
final class AndroidPlatform implements Platform {
    private final Context context;
    private final ClipboardManager clipboard;
    private final Handler main = new Handler(Looper.getMainLooper());

    AndroidPlatform(Context context) {
        this.context = context.getApplicationContext();
        this.clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @Override
    public String deviceName() {
        String name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        return name != null && !name.trim().isEmpty() ? name.trim() : Build.MODEL;
    }

    @Override
    public Path inboxDir() {
        File base = context.getExternalFilesDir(null);
        return new File(base != null ? base : context.getFilesDir(), "Rooftop").toPath();
    }

    @Override
    public byte[] asset(String name) throws IOException {
        try (InputStream in = context.getAssets().open("web/" + name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    @Override
    public void setClipboard(String text) {
        main.post(() -> clipboard.setPrimaryClip(ClipData.newPlainText("Rooftop", text)));
    }

    /** Android only lets the app on screen read the clipboard, so this may return null. */
    @Override
    public String clipboard() {
        FutureTask<String> read = new FutureTask<>(() -> {
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return null;
            CharSequence text = clip.getItemAt(0).coerceToText(context);
            return text != null ? text.toString() : null;
        });
        main.post(read);
        try {
            return read.get(1, TimeUnit.SECONDS);
        } catch (Exception e) {
            return null;
        }
    }
}
