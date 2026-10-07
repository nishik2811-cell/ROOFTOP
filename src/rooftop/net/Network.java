package rooftop.net;

import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

public final class Network {
    private Network() {
    }

    /** Every IPv4 address on a real network card (Wi-Fi, Ethernet, hotspot), with its broadcast address. */
    public static List<InterfaceAddress> lanAddresses() throws SocketException {
        List<InterfaceAddress> result = new ArrayList<>();
        for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces()))
            if (ni.isUp() && !ni.isLoopback())
                for (InterfaceAddress ia : ni.getInterfaceAddresses())
                    if (ia.getBroadcast() != null) result.add(ia);
        return result;
    }

    /** The IP on the default route (Wi-Fi or hotspot, not Docker or VPN). Connecting UDP sends no packet. */
    public static String lanIp() throws SocketException {
        List<String> candidates = new ArrayList<>();
        for (InterfaceAddress ia : lanAddresses())
            if (ia.getAddress() instanceof Inet4Address) candidates.add(ia.getAddress().getHostAddress());
        try (DatagramSocket probe = new DatagramSocket()) {
            probe.connect(InetAddress.getByName("192.0.2.1"), 9);
            String routed = probe.getLocalAddress().getHostAddress();
            if (candidates.contains(routed)) return routed; // a phone on mobile data routes elsewhere; skip that
        } catch (Exception ignored) {
            // no default route, e.g. this device is the hotspot
        }
        return candidates.isEmpty() ? "localhost" : candidates.get(0);
    }

    public static List<String> otherAddresses(String chosen) throws SocketException {
        List<String> others = new ArrayList<>();
        for (InterfaceAddress ia : lanAddresses()) {
            String ip = ia.getAddress().getHostAddress();
            if (!ip.equals(chosen)) others.add(ip);
        }
        return others;
    }

    public static String hostName() {
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "pc-" + new Random().nextInt(1000);
        }
    }
}
