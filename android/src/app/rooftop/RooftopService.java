package app.rooftop;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import rooftop.Rooftop;

/**
 * Keeps Rooftop running while the screen is off or another app is open (a foreground service, so
 * Android shows a notification for as long as it runs). The Rooftop object lives once per app process.
 */
public class RooftopService extends Service {
    static final String STOP = "app.rooftop.STOP";
    private static final String CHANNEL = "rooftop";
    private static final List<Runnable> waiting = new ArrayList<>();
    private static Rooftop app;
    private static String failure;

    private WifiManager.MulticastLock multicast;

    /** Runs {@code task} once Rooftop has started (right away if it already has). */
    static synchronized void whenReady(Runnable task) {
        if (app != null || failure != null) task.run();
        else waiting.add(task);
    }

    static synchronized Rooftop app() {
        return app;
    }

    static synchronized String failure() {
        return failure;
    }

    private static synchronized void started(Rooftop started, String error) {
        app = started;
        failure = error;
        for (Runnable task : waiting) task.run();
        waiting.clear();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Sharing", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);

        // Android drops Wi-Fi broadcast packets to save battery unless an app holds this lock.
        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        multicast = wifi.createMulticastLock("rooftop");
        multicast.setReferenceCounted(false);
        multicast.acquire();

        synchronized (RooftopService.class) {
            if (app != null) return;
        }
        new Thread(() -> {
            try {
                Rooftop rooftop = new Rooftop(new AndroidPlatform(this));
                rooftop.start();
                started(rooftop, null);
            } catch (Throwable e) { // Errors too: anything here must reach the screen, not vanish
                Log.e("Rooftop", "could not start", e);
                started(null, Log.getStackTraceString(e));
            }
        }, "rooftop-start").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            // ponytail: ends the whole process so every socket closes at once; a clean shutdown path can come later
            android.os.Process.killProcess(android.os.Process.myPid());
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (multicast != null && multicast.isHeld()) multicast.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RooftopService.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Rooftop is sharing")
                .setContentText("Tap to open. Devices on this Wi-Fi or hotspot can send you files.")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .setOngoing(true)
                .build();
    }
}
