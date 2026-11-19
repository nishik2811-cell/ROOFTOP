package app.rooftop;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import rooftop.Rooftop;

/** Shows the same city page the PC shows, served by this phone's own Rooftop on 127.0.0.1. */
public class MainActivity extends Activity {
    private static final String HOME = "http://127.0.0.1:8080/";
    private static final int PICK_FILES = 1;

    private static final int MAX_RETRIES = 15;
    private static final int START_TIMEOUT_MS = 12_000;

    private WebView web;            // null once the page's process is gone
    private ValueCallback<Uri[]> pendingPick;
    private int retries;            // failed loads since the page last started (a failed load still "finishes")
    private boolean watching;       // a start check is scheduled
    private int watchId;            // so a check scheduled before the problem screen does nothing
    private boolean gaveUp;         // the problem screen is up: no automatic reloads until "Try again"

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 0);
        startForegroundService(new Intent(this, RooftopService.class));

        getWindow().setStatusBarColor(Color.parseColor("#171615"));
        getWindow().setNavigationBarColor(Color.parseColor("#171615"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#d4cbbe"));
        setContentView(web);

        // proves to the server that requests come from this page, not another app on the phone (see Platform.localSecret)
        android.webkit.CookieManager.getInstance().setCookie(HOME, "rooftop-local=" + AndroidPlatform.LOCAL_SECRET + "; HttpOnly; SameSite=Strict");

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setUserAgentString(settings.getUserAgentString() + " RooftopApp"); // lets the page leave out "Open in tab"

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url.toString().startsWith(HOME)) return false;
                if ("rooftop".equals(url.getScheme())) { tryAgain(); return true; } // the problem screen's button
                // never leave our own page: another Rooftop session (Join) or a link from chat opens in the phone's
                // browser, which handles its certificate and saving files, while this app keeps hosting
                if (request.isForMainFrame() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (android.content.ActivityNotFoundException e) {
                        Toast.makeText(MainActivity.this, "No browser on this phone to open " + url, Toast.LENGTH_LONG).show();
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!isCity(url) || watching || gaveUp) return;
                watching = true; // one deadline from the first try, however often it reloads meanwhile
                int id = ++watchId;
                view.postDelayed(() -> checkStarted(id), START_TIMEOUT_MS);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                log("page load failed: " + error.getErrorCode() + " " + error.getDescription() + " (" + request.getUrl() + ")");
                if (gaveUp) return;
                if (retries++ < MAX_RETRIES) view.postDelayed(() -> { if (!gaveUp && web != null) web.loadUrl(HOME); }, 600); // server still starting
                else showProblem("The sharing server is not answering (" + error.getDescription() + ").");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame()) log("page load answered " + response.getStatusCode() + " " + response.getReasonPhrase() + " (" + request.getUrl() + ")");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                // the page's process crashed, or Android stopped it to free memory; unhandled, the whole app is killed silently
                String why = detail.didCrash() ? "The page crashed." : "Android closed the page to free memory.";
                log("page process gone: " + why);
                web = null;
                view.destroy();
                android.widget.TextView text = new android.widget.TextView(MainActivity.this);
                text.setTextIsSelectable(true);
                text.setTypeface(android.graphics.Typeface.MONOSPACE);
                text.setTextColor(Color.parseColor("#f2eee6"));
                text.setPadding(48, 48, 48, 48);
                text.setText(why + "\nTake a screenshot of this and send it over. Close and reopen Rooftop to try again.\n\n" + problemDetails());
                android.widget.ScrollView scroll = new android.widget.ScrollView(MainActivity.this);
                scroll.setBackgroundColor(Color.parseColor("#171615"));
                scroll.addView(text);
                setContentView(scroll);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) { // page errors go into the log the problem screen shows
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR)
                    log("page error: " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return false;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(pick, "Send files"), PICK_FILES);
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> saveToDownloads(Uri.parse(url)));

        RooftopService.whenReady(() -> runOnUiThread(() -> {
            if (RooftopService.failure() != null) showProblem("Rooftop could not start.");
            else web.loadUrl(HOME);
        }));
    }

    /** The page flags itself started within seconds; if it has not, show why instead of a loading crosshair forever. */
    private void checkStarted(int id) {
        if (id != watchId || gaveUp || web == null || isDestroyed()) return;
        watching = false;
        if (!isCity(web.getUrl())) return; // e.g. a file opened on its own: scripts are blocked there, nothing to check
        boolean[] answered = {false};
        web.evaluateJavascript("String(window.rooftopStarted === true)", started -> {
            answered[0] = true;
            if (id != watchId || gaveUp || web == null || isDestroyed() || !isCity(web.getUrl())) return;
            if ("\"true\"".equals(started)) retries = 0; // started: later failures get their own retries
            else showProblem("The page did not finish starting.");
        });
        web.postDelayed(() -> {
            if (!answered[0] && id == watchId && !gaveUp && web != null && !isDestroyed()) showProblem("The page stopped responding while starting.");
        }, 3000);
    }

    /** The city page itself, not a file or other address on the same server. */
    private static boolean isCity(String url) {
        return url != null && (url.equals(HOME) || url.startsWith(HOME + "?") || url.startsWith(HOME + "#"));
    }

    private void tryAgain() {
        if (web == null) return;
        gaveUp = false;
        retries = 0;
        web.loadUrl(HOME); // loaded by the app, so the page's cookie goes along
    }

    /** Shows what went wrong on screen, so a screenshot is enough to report it. */
    private void showProblem(String headline) {
        gaveUp = true;
        watching = false;
        watchId++;
        if (web == null) return; // the page's process is gone, and that screen already says so
        String html = "<body style='background:#171615;color:#f2eee6;font:14px monospace;padding:20px'>"
                + "<h3 style='color:#3fd6e0'>" + escape(headline) + "</h3>"
                + "<p>Take a screenshot of this and send it over.</p>"
                + "<pre style='white-space:pre-wrap;font-size:11px;color:#bab4a9'>" + escape(problemDetails()) + "</pre>"
                + "<p><a style='color:#3fd6e0' href='rooftop:retry'>Try again</a></p></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** Which build, phone and WebView, why Rooftop could not start, and its recent activity (page errors included). */
    private String problemDetails() {
        StringBuilder details = new StringBuilder();
        String build;
        try {
            build = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            build = "?";
        }
        android.content.pm.PackageInfo webView = WebView.getCurrentWebViewPackage(); // an old one is a common cause
        details.append("Rooftop ").append(build).append(" on ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append(", Android ").append(Build.VERSION.RELEASE)
                .append(", WebView ").append(webView != null ? webView.versionName : "unknown").append('\n');
        if (RooftopService.failure() != null) details.append(RooftopService.failure());
        Rooftop app = RooftopService.app();
        if (app != null) details.append("\nRecent activity:\n").append(app.log().recent());
        return details.toString();
    }

    private static void log(String line) {
        Rooftop app = RooftopService.app();
        if (app != null) app.log().add(line);
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILES || pendingPick == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                picked = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        pendingPick.onReceiveValue(picked);
        pendingPick = null;
    }

    /** "Save" on this phone copies the file out of the app into Downloads/Rooftop, where Files and Gallery see it. */
    private void saveToDownloads(Uri url) {
        Rooftop app = RooftopService.app();
        String name = url.getLastPathSegment();
        if (app == null || name == null) return;
        new Thread(() -> {
            String message;
            try {
                Path file = app.inbox().pathOf(name);
                String mime = URLConnection.guessContentTypeFromName(name);
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, file.getFileName().toString());
                values.put(MediaStore.Downloads.MIME_TYPE, mime != null ? mime : "application/octet-stream");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Rooftop");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = getContentResolver();
                Uri target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (target == null) throw new java.io.IOException("Android refused to create the file");
                try (InputStream in = Files.newInputStream(file); OutputStream out = resolver.openOutputStream(target)) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(target, values, null, null);
                message = "Saved to Downloads/Rooftop";
            } catch (Exception e) {
                message = "Could not save: " + e.getMessage();
            }
            String shown = message;
            runOnUiThread(() -> Toast.makeText(this, shown, Toast.LENGTH_SHORT).show());
        }).start();
    }

    @Override
    public void onBackPressed() {
        String url = web != null ? web.getUrl() : null;
        if (url != null && url.startsWith(HOME) && !isCity(url)) { // on a file of our own server: back to the city
            if (web.canGoBack()) web.goBack();
            else web.loadUrl(HOME);
            return;
        }
        if (web != null) {
            web.evaluateJavascript("(() => {"
                    + "const s = document.querySelector('dialog.sheet[open]');"
                    + "if (s && s.id !== 'sheet-pin') { s.close(); return true; }"
                    + "const st = document.getElementById('story');"
                    + "if (st && !st.hidden) { if (typeof closeStory === 'function') closeStory(); else st.hidden = true; return true; }"
                    + "return false;"
                    + "})()", handled -> {
                if (!"true".equals(handled)) {
                    moveTaskToBack(true); // keep sharing in the background; stop it from the notification
                }
            });
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
