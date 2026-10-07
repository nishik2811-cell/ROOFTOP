package rooftop.cli;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import rooftop.Rooftop;
import rooftop.model.FilePayload;
import rooftop.model.NetworkDevice;
import rooftop.model.PcPeer;
import rooftop.model.ReceivedItem;
import rooftop.model.TextPayload;
import rooftop.model.Transfer;
import rooftop.ui.RadarApplet;
import rooftop.util.Texts;

/** Terminal commands. Reflection turns every @Command method into a command named after the method. */
public class Shell {
    private final Rooftop app;
    private final Map<String, Method> commands = new TreeMap<>();

    public Shell(Rooftop app) {
        this.app = app;
        for (Method m : Shell.class.getDeclaredMethods())
            if (m.isAnnotationPresent(Command.class)) commands.put(m.getName(), m);
    }

    public void run(InputStream input) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        for (String line; (line = in.readLine()) != null; ) {
            line = line.strip();
            if (line.isEmpty()) continue;
            String name = line.split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
            String rest = line.substring(name.length()).strip();
            Method method = commands.get(name);
            if (method == null) {
                System.out.println("unknown command '" + name + "', try help");
                continue;
            }
            try {
                method.invoke(this, rest);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause();
                if (cause instanceof UsageException)
                    System.out.println("usage: " + name + " " + method.getAnnotation(Command.class).usage());
                else
                    System.out.println("error: " + cause.getClass().getSimpleName() + ": " + cause.getMessage());
            } catch (IllegalAccessException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /** Nested class: thrown when a command gets too few words. */
    private static final class UsageException extends RuntimeException {
    }

    private static String[] words(String rest, int count) {
        String[] parts = rest.isEmpty() ? new String[0] : rest.split("\\s+", count);
        if (parts.length < count) throw new UsageException();
        return parts;
    }

    private NetworkDevice target(String nameOrIp) throws UnknownHostException {
        Optional<NetworkDevice> known = app.devices().find(nameOrIp);
        return known.isPresent() ? known.get() : new PcPeer(nameOrIp, InetAddress.getByName(nameOrIp));
    }

    @Command(help = "list commands")
    void help(String rest) {
        commands.forEach((name, m) -> {
            Command c = m.getAnnotation(Command.class);
            System.out.printf("  %-8s %-34s %s%n", name, c.usage(), c.help());
        });
    }

    @Command(help = "PCs and phones seen on this Wi-Fi")
    void devices(String rest) {
        var all = app.devices().all();
        if (all.isEmpty()) System.out.println("  nobody yet. Start Rooftop on another PC, or scan the QR code with a phone.");
        for (NetworkDevice d : all)
            System.out.printf("  %-8s %-26s %-16s %s%n", d.kind(), d.name(), d.address().getHostAddress(),
                    d.isOnline() ? "online" : "last seen " + d.secondsSinceSeen() + "s ago");
    }

    @Command(usage = "<pc name|ip> <their PIN> <file>", help = "send a file to another PC (encrypted)")
    void send(String rest) throws IOException {
        String[] w = words(rest, 3);
        app.sendQueue().submit(new Transfer(target(w[0]), new FilePayload(Paths.get(w[2])), w[1]));
        System.out.println("  queued " + w[2]);
    }

    @Command(usage = "<pc name|ip> <their PIN> <message>", help = "put text on another PC's clipboard")
    void text(String rest) throws IOException {
        String[] w = words(rest, 3);
        app.sendQueue().submit(new Transfer(target(w[0]), new TextPayload(w[2]), w[1]));
    }

    @Command(help = "received files, A to Z")
    void inbox(String rest) {
        SimpleDateFormat time = new SimpleDateFormat("dd MMM HH:mm");
        for (ReceivedItem i : app.inbox().byName())
            System.out.printf("  %-40s %10s  %-20s %s%n", i.name(), Texts.humanSize(i.size()), i.from(), time.format(new Date(i.at())));
        System.out.println("  folder: " + app.inbox().dir());
    }

    @Command(usage = "<file name>", help = "delete a received file")
    void rm(String rest) throws IOException {
        if (rest.isEmpty()) throw new UsageException();
        System.out.println(app.inbox().remove(rest) ? "  deleted " + rest : "  no file called " + rest);
    }

    @Command(usage = "<new name>", help = "rename this PC (other devices see the new name)")
    void name(String rest) {
        if (rest.isEmpty()) throw new UsageException();
        System.out.println(app.rename(rest) ? "  this PC is now called " + app.me().name() : "  that name has nothing printable in it");
    }

    @Command(help = "files sent and received in this session")
    void history(String rest) {
        SimpleDateFormat time = new SimpleDateFormat("HH:mm");
        var all = app.history().newestFirst();
        if (all.isEmpty()) System.out.println("  nothing yet");
        for (var e : all)
            System.out.printf("  %s  %-32s %10s  %s -> %s%s%n", time.format(new Date(e.at())), e.name(), Texts.humanSize(e.size()), e.from(), e.toName(),
                    e.ok() ? (e.millis() > 0 ? "  " + Texts.speed(e.size(), e.millis() * 1_000_000) : "") : "  FAILED: " + e.note());
    }

    @Command(help = "recent activity")
    void log(String rest) {
        System.out.print(app.log().recent());
    }

    @Command(help = "show the QR code, links and PIN again")
    void qr(String rest) throws IOException {
        app.printBanner();
    }

    @Command(help = "end this session: new PIN, phones disconnected, messages and files cleared")
    void session(String rest) throws IOException {
        app.newSession();
        app.printBanner();
    }

    @Command(help = "open the radar window (AWT applet)")
    void radar(String rest) {
        RadarApplet.open(app.devices(), app.me().name());
    }

    @Command(help = "open the received files folder in file manager")
    void folder(String rest) {
        try {
            java.awt.Desktop desktop = java.awt.Desktop.isDesktopSupported() ? java.awt.Desktop.getDesktop() : null;
            if (desktop != null && desktop.isSupported(java.awt.Desktop.Action.OPEN)) {
                java.nio.file.Path dir = app.inbox().dir();
                java.nio.file.Files.createDirectories(dir);
                desktop.open(dir.toFile());
                System.out.println("  opened " + dir);
            } else {
                System.out.println("  folder: " + app.inbox().dir());
            }
        } catch (Exception e) {
            System.out.println("  could not open folder: " + e.getMessage());
        }
    }

    @Command(help = "open Rooftop in default web browser")
    void web(String rest) {
        try {
            java.awt.Desktop desktop = java.awt.Desktop.isDesktopSupported() ? java.awt.Desktop.getDesktop() : null;
            if (desktop != null && desktop.isSupported(java.awt.Desktop.Action.BROWSE)) {
                desktop.browse(new java.net.URI("http://localhost:" + rooftop.net.Wire.LOCAL_PORT));
                System.out.println("  opened http://localhost:" + rooftop.net.Wire.LOCAL_PORT);
            } else {
                System.out.println("  open http://localhost:" + rooftop.net.Wire.LOCAL_PORT + " in your browser");
            }
        } catch (Exception e) {
            System.out.println("  could not open browser: " + e.getMessage());
        }
    }

    @Command(help = "stop Rooftop")
    void quit(String rest) {
        System.exit(0);
    }
}
