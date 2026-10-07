package rooftop.net;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.nio.charset.StandardCharsets;
import rooftop.Rooftop;
import rooftop.model.NetworkDevice;
import rooftop.model.PcPeer;
import rooftop.util.Threads;

/** Finds other PCs: every 2 s each one shouts "ROOFTOP <name>" to the Wi-Fi's broadcast address. */
public class Discovery implements Runnable {
    private static final long BEACON_EVERY_MS = 2000;

    private final Rooftop app;

    public Discovery(Rooftop app) {
        this.app = app;
    }

    public void start() {
        Threads.daemon("beacon", this);              // a Runnable object...
        Threads.daemon("beacon-listener", this::listen); // ...and a method reference, both become threads
    }

    /** Announcer loop. */
    @Override
    public void run() {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            while (!Thread.currentThread().isInterrupted()) {
                // built every time, so a renamed PC is announced under its new name
                for (String prefix : new String[]{Wire.BEACON, Wire.BEACON_FRAMES}) {
                    byte[] message = (prefix + app.me().name()).getBytes(StandardCharsets.UTF_8);
                    for (InterfaceAddress ia : Network.lanAddresses()) {
                        try {
                            socket.send(new DatagramPacket(message, message.length, ia.getBroadcast(), Wire.UDP_PORT));
                        } catch (IOException e) {
                            // that network card went away; the others still get the beacon
                        }
                    }
                }
                Thread.sleep(BEACON_EVERY_MS);
            }
        } catch (IOException e) {
            app.log().add("beacon stopped: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void listen() {
        try (DatagramSocket socket = new DatagramSocket(Wire.UDP_PORT)) {
            byte[] buf = new byte[512];
            while (true) {
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                socket.receive(packet);
                String message = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                boolean frames = message.startsWith(Wire.BEACON_FRAMES);
                if (!frames && !message.startsWith(Wire.BEACON)) continue;
                String name = message.substring((frames ? Wire.BEACON_FRAMES : Wire.BEACON).length()).trim();
                if (name.isEmpty() || name.equals(app.me().name())) continue;
                seen(name, packet.getAddress(), frames);
            }
        } catch (IOException e) {
            app.log().add("discovery off (is another Rooftop running?): " + e.getMessage());
        }
    }

    private void seen(String name, InetAddress address, boolean frames) {
        NetworkDevice known = app.devices().find(name).orElse(null);
        if (known instanceof PcPeer pc && known.address().equals(address)) {
            known.touch();
            if (frames) pc.setTakesFrames();
            return;
        }
        PcPeer peer = new PcPeer(name, address);
        if (frames) peer.setTakesFrames();
        app.devices().put(name, peer);
        if (known == null) app.log().add("spotted " + name + " at " + address.getHostAddress());
    }
}
