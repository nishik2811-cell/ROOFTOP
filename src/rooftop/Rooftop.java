package rooftop;

import java.io.IOException;
import rooftop.model.History;
import rooftop.model.Inbox;
import rooftop.model.NetworkDevice;
import rooftop.model.PhoneClient;
import rooftop.model.ReceivedItem;
import rooftop.model.ReceivedText;
import rooftop.model.SealedBox;
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

/** Composition root, shared by the PC and Android builds. Platform differences come in through {@link Platform}. */
public class Rooftop {
    private final Platform platform;
    private final ThisDevice me;
    private final Registry<String, NetworkDevice> devices = new Registry<>();
    private final PinGuard pins = new PinGuard();
    private final ActivityLog log = new ActivityLog();
    private final History history = new History();
    private final rooftop.model.ChatBox chat = new rooftop.model.ChatBox();
    private volatile String session = newSessionId(); // browsers make a new end-to-end key whenever this changes
    private final SendQueue sendQueue = new SendQueue(this);
    private final WebServer web = new WebServer(this);
    private final Inbox inbox;
    private final SealedBox sealed;

    public Rooftop(Platform platform) throws IOException {
        this.platform = platform;
        this.me = new ThisDevice(platform.deviceName());
        this.inbox = new Inbox(platform.inboxDir());
        if (java.nio.file.Files.isRegularFile(nameFile())) // a name picked earlier on this PC
            me.rename(new String(java.nio.file.Files.readAllBytes(nameFile()), java.nio.charset.StandardCharsets.UTF_8));
        // end-to-end encrypted files passing through: a hidden temp folder for other devices, and a hidden folder
        // next to the inbox for files waiting for this PC (kept until this PC's page opens them). Neither is the inbox.
        this.sealed = new SealedBox(java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"), "rooftop-sealed-" + System.getProperty("user.name", "app")),
                inbox.dir().resolve(".rooftop").resolve("held"), ThisDevice.ID);
    }

    public void start() throws IOException {
        new Discovery(this).start();
        new TransferServer(this).start();
        sendQueue.start();
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

    /** A chat message. It lands on this PC's clipboard only if this PC is one of the people it is for. */
    public void receiveText(String text, String from, String fromId, String to) {
        inbox.addText(text, from, fromId, to);
        boolean forMe = ReceivedItem.EVERYONE.equals(to) || ThisDevice.ID.equals(to);
        log.add((forMe ? "text from " : "chat ") + from + (forMe ? ": " + text : " -> another device"));
        if (forMe && !ThisDevice.ID.equals(fromId)) platform.setClipboard(text);
    }

    /** Renames this PC and remembers the name for next time. */
    public boolean rename(String wanted) {
        if (!me.rename(wanted)) return false;
        try {
            java.nio.file.Files.createDirectories(nameFile().getParent());
            java.nio.file.Files.write(nameFile(), me.name().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (IOException e) {
            log.add("could not save the new name: " + e.getMessage());
        }
        return true;
    }

    /** True once someone picked a name for this PC (here or in the terminal), so the page stops asking. */
    public boolean named() {
        return java.nio.file.Files.isRegularFile(nameFile());
    }

    private java.nio.file.Path nameFile() {
        return inbox.dir().resolve(".rooftop").resolve("name");
    }

    /** Ends the current session: new PIN, phones must join again, messages and received files cleared. */
    public void newSession() throws IOException {
        pins.renew();
        int phones = devices.removeType(PhoneClient.class);
        int files = inbox.newSession();
        sealed.clear();
        history.clear();
        chat.clear();
        me.clearPublicKey();
        session = newSessionId();
        log.add("new session: PIN " + pins.pin() + ", " + phones + " phone(s) disconnected, " + files + " file(s) removed");
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

    private static String newSessionId() {
        byte[] b = new byte[12];
        new java.security.SecureRandom().nextBytes(b);
        return rooftop.util.Texts.hex(b);
    }

    public String session() {
        return session;
    }

    public rooftop.model.ChatBox chat() {
        return chat;
    }

    public History history() {
        return history;
    }

    public Inbox inbox() {
        return inbox;
    }

    public SealedBox sealed() {
        return sealed;
    }

    public SendQueue sendQueue() {
        return sendQueue;
    }

    public WebServer web() {
        return web;
    }
}
