package rooftop;

import java.io.IOException;
import rooftop.model.Inbox;
import rooftop.model.NetworkDevice;
import rooftop.model.PhoneClient;
import rooftop.model.ReceivedText;
import rooftop.model.ThisDevice;
import rooftop.net.Discovery;
import rooftop.net.Network;
import rooftop.net.SendQueue;
import rooftop.net.TransferServer;
import rooftop.net.WebServer;
import rooftop.net.Wire;
import rooftop.security.PinGuard;
import rooftop.util.ActivityLog;
import rooftop.util.QrCode;
import rooftop.util.Registry;
import rooftop.util.Threads;

/** Composition root, shared by the PC and Android builds. Platform differences come in through {@link Platform}. */
public class Rooftop {
    private final Platform platform;
    private final ThisDevice me;
    private final Registry<String, NetworkDevice> devices = new Registry<>();
    private final PinGuard pins = new PinGuard();
    private final ActivityLog log = new ActivityLog();
    private final SendQueue sendQueue = new SendQueue(this);
    private final WebServer web = new WebServer(this);
    private final Inbox inbox;

    public Rooftop(Platform platform) throws IOException {
        this.platform = platform;
        this.me = new ThisDevice(platform.deviceName());
        this.inbox = new Inbox(platform.inboxDir());
    }

    public void start() throws IOException {
        new Discovery(this).start();
        new TransferServer(this).start();
        Threads.daemon("sender", sendQueue);
        web.start();
        printBanner();
    }

    public void printBanner() throws IOException {
        String ip = Network.lanIp();
        String url = web.phoneUrl(ip);
        System.out.println(QrCode.toTerminal(QrCode.encode(url)));
        System.out.println(me.name() + " is on the roof.");
        System.out.println("  Phones: scan the code, or open " + url);
        for (String other : Network.otherAddresses(ip))
            System.out.println("          other network? try " + web.phoneUrl(other));
        System.out.println("  This PC: open http://localhost:" + Wire.LOCAL_PORT + " for a big QR code and the city.");
        System.out.println("  PIN " + pins.pin() + "   files land in " + inbox.dir());
        System.out.println("  Type 'help' for commands.");
    }

    public void receiveText(String text, String from) {
        inbox.addText(text, from);
        log.add("text from " + from + ": " + text);
        platform.setClipboard(text);
    }

    /** Ends the current session: new PIN, phones must join again, messages cleared, old files kept but private. */
    public void newSession() {
        pins.renew();
        int phones = devices.removeType(PhoneClient.class);
        inbox.newSession();
        log.add("new session: PIN " + pins.pin() + ", " + phones + " phone(s) disconnected");
    }

    public String clipboard() {
        String text = platform.clipboard();
        if (text != null) return text;
        return inbox.texts().stream().findFirst().map(ReceivedText::text).orElse("");
    }

    public Platform platform() {
        return platform;
    }

    public ThisDevice me() {
        return me;
    }

    public Registry<String, NetworkDevice> devices() {
        return devices;
    }

    public PinGuard pins() {
        return pins;
    }

    public ActivityLog log() {
        return log;
    }

    public Inbox inbox() {
        return inbox;
    }

    public SendQueue sendQueue() {
        return sendQueue;
    }

    public WebServer web() {
        return web;
    }
}
