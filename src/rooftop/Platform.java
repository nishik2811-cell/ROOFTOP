package rooftop;

import java.io.IOException;
import java.nio.file.Path;

/**
 * What differs between a PC and an Android phone. Rooftop's shared code talks only to this interface;
 * DesktopPlatform and the Android app's AndroidPlatform implement it.
 */
public interface Platform {
    String deviceName();

    Path inboxDir();

    /** One of the page files: index.html, style.css, app.js. */
    byte[] asset(String name) throws IOException;

    void setClipboard(String text);

    /** The clipboard text, or null when this platform is not allowed to read it right now. */
    String clipboard();
}
