package rooftop;

import java.awt.AWTError;
import java.awt.Toolkit;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import rooftop.net.Network;

/** Windows, macOS and Linux: page files from the web folder, clipboard through AWT. */
public class DesktopPlatform implements Platform {
    private final Path web;

    public DesktopPlatform(Path web) throws IOException {
        if (!Files.isRegularFile(web.resolve("index.html")))
            throw new IOException("page files not found in " + web.toAbsolutePath() + ". Run this from the project folder.");
        this.web = web;
    }

    @Override
    public String deviceName() {
        String name = System.getenv("ROOFTOP_NAME");
        return name != null ? name : Network.hostName();
    }

    @Override
    public Path inboxDir() {
        return Paths.get(System.getProperty("user.home"), "Rooftop");
    }

    @Override
    public byte[] asset(String name) throws IOException {
        return Files.readAllBytes(web.resolve(name));
    }

    @Override
    public void setClipboard(String text) {
        try {
            Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(text), null);
        } catch (RuntimeException | AWTError e) {
            // no desktop session: the text is still in the log and on the page
        }
    }

    @Override
    public String clipboard() {
        try {
            return (String) Toolkit.getDefaultToolkit().getSystemClipboard().getData(DataFlavor.stringFlavor);
        } catch (Exception | AWTError e) {
            return null;
        }
    }
}
