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
        byte[] message = (Wire.BEACON + app.me().name()).getBytes(StandardCharsets.UTF_8);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            while (!Thread.currentThread().isInterrupted()) {
                for (InterfaceAddress ia : Network.lanAddresses()) {
                    try {
                        socket.send(new DatagramPacket(message, message.length, ia.getBroadcast(), Wire.UDP_PORT));
                    } catch (IOException e) {
                        // that network card went away; the others still get the beacon
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
                if (!message.startsWith(Wire.BEACON)) continue;
                String name = message.substring(Wire.BEACON.length()).trim();
                if (name.isEmpty() || name.equals(app.me().name())) continue;
                seen(name, packet.getAddress());
            }
        } catch (IOException e) {
            app.log().add("discovery off (is another Rooftop running?): " + e.getMessage());
        }
    }

    private void seen(String name, InetAddress address) {
        NetworkDevice known = app.devices().find(name).orElse(null);
        if (known != null && known.address().equals(address)) {
            known.touch();
            return;
        }
        app.devices().put(name, new PcPeer(name, address));
        if (known == null) app.log().add("spotted " + name + " at " + address.getHostAddress());
    }
}
