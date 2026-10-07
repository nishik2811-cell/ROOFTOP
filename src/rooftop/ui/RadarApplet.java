package rooftop.ui;

import java.applet.Applet;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Frame;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GraphicsEnvironment;
import java.awt.Image;
import java.awt.RenderingHints;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.util.List;
import rooftop.model.NetworkDevice;
import rooftop.model.PcPeer;
import rooftop.util.Registry;

/**
 * Applet life cycle (init, start, paint, stop, destroy) driving a live radar of nearby devices.
 * Browsers dropped applets years ago, so it is hosted in an AWT Frame instead of a web page.
 */
@SuppressWarnings("removal") // java.applet is deprecated for removal but still ships in JDK 25
public class RadarApplet extends Applet implements Runnable {
    private static final Color PAPER = new Color(0xd4cbbe);
    private static final Color INK = new Color(0x171615);
    private static final Color SKY = new Color(0x1f5fb3);
    private static final Color ACCENT = new Color(0xe0392b);
    private static final Color CYAN = new Color(0x3fd6e0);

    private final Registry<String, NetworkDevice> devices;
    private final String self;
    private volatile Thread animator;
    private double sweep;
    private Image buffer;

    public RadarApplet(Registry<String, NetworkDevice> devices, String self) {
        this.devices = devices;
        this.self = self;
    }

    @Override
    public void init() {
        setBackground(PAPER);
        setFont(new Font(Font.MONOSPACED, Font.BOLD, 12));
    }

    @Override
    public void start() {
        animator = new Thread(this, "radar");
        animator.setDaemon(true);
        animator.start();
    }

    @Override
    public void stop() {
        animator = null; // run() sees this and returns
    }

    @Override
    public void destroy() {
        buffer = null;
    }

    @Override
    public void run() {
        while (animator == Thread.currentThread()) {
            sweep = (sweep + 0.035) % (Math.PI * 2);
            repaint();
            try {
                Thread.sleep(33);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** Skip AWT's default clear-then-paint, which flickers. */
    @Override
    public void update(Graphics g) {
        paint(g);
    }

    @Override
    public void paint(Graphics screen) {
        int w = getWidth(), h = getHeight();
        if (w <= 0 || h <= 0) return;
        if (buffer == null || buffer.getWidth(null) != w || buffer.getHeight(null) != h) buffer = createImage(w, h);
        Graphics2D g = (Graphics2D) buffer.getGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(PAPER);
        g.fillRect(0, 0, w, h);

        int cx = w / 2, cy = h / 2 + 14, r = Math.min(w, h) / 2 - 44;
        g.setColor(INK);
        g.fillOval(cx - r + 6, cy - r + 6, 2 * r, 2 * r); // hard offset shadow
        g.setColor(SKY);
        g.fillOval(cx - r, cy - r, 2 * r, 2 * r);
        g.setColor(new Color(255, 255, 255, 60));
        for (int i = 1; i <= 3; i++) {
            int rr = r * i / 3;
            g.drawOval(cx - rr, cy - rr, 2 * rr, 2 * rr);
        }
        g.setColor(new Color(63, 214, 224, 70));
        g.fillArc(cx - r, cy - r, 2 * r, 2 * r, (int) -Math.toDegrees(sweep), 32);

        List<NetworkDevice> all = devices.all();
        for (NetworkDevice d : all) {
            double angle = Math.toRadians(Math.floorMod(d.name().hashCode(), 360));
            double dist = r * (d.isOnline() ? 0.55 : 0.85);
            int x = cx + (int) (Math.cos(angle) * dist), y = cy + (int) (Math.sin(angle) * dist);
            g.setColor(d.isOnline() ? PAPER : new Color(255, 255, 255, 90));
            g.setStroke(new BasicStroke(2));
            if (d instanceof PcPeer) g.fillRect(x - 6, y - 6, 12, 12);
            else g.fillOval(x - 6, y - 6, 12, 12);
            g.setColor(Color.WHITE);
            g.drawString(d.name(), x + 11, y + 4);
        }

        g.setColor(ACCENT);
        g.fillOval(cx - 7, cy - 7, 14, 14);
        g.setColor(Color.WHITE);
        g.drawString(self, cx - g.getFontMetrics().stringWidth(self) / 2, cy + 24);

        g.setColor(INK);
        g.drawString("ROOFTOP RADAR", 18, 26);
        g.setColor(ACCENT);
        String count = all.stream().filter(NetworkDevice::isOnline).count() + " NEARBY";
        g.drawString(count, w - 18 - g.getFontMetrics().stringWidth(count), 26);
        g.setColor(CYAN.darker());
        g.drawString("square = PC   circle = phone or browser", 18, h - 16);
        g.dispose();
        screen.drawImage(buffer, 0, 0, null);
    }

    /** Hosts the applet in a window and drives its life cycle the way a browser used to. */
    public static void open(Registry<String, NetworkDevice> devices, String self) {
        if (GraphicsEnvironment.isHeadless()) {
            System.out.println("  no display here: the radar needs a desktop session");
            return;
        }
        Frame frame = new Frame("Rooftop radar");
        RadarApplet applet = new RadarApplet(devices, self);
        frame.add(applet);
        frame.setSize(460, 500);
        frame.addWindowListener(new WindowAdapter() { // anonymous inner class
            @Override
            public void windowClosing(WindowEvent e) {
                applet.stop();
                applet.destroy();
                frame.dispose();
            }
        });
        applet.init();
        frame.setVisible(true);
        applet.start();
    }
}
