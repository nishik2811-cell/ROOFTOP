package rooftop.model;

import java.net.InetAddress;

/** A browser talking to us over HTTP: iPhone, Android, or a laptop that has no Java. */
public class PhoneClient extends NetworkDevice {
    private final boolean mobile;

    public PhoneClient(String userAgent, InetAddress address) {
        super(nameFrom(userAgent, address), address);
        this.mobile = userAgent.contains("Mobi") || userAgent.contains("Android") || userAgent.contains("iPhone");
    }

    private static String nameFrom(String ua, InetAddress address) {
        String model = ua.contains("iPhone") ? "iPhone"
                : ua.contains("iPad") ? "iPad"
                : ua.contains("Android") ? "Android"
                : ua.contains("Windows") ? "Windows browser"
                : ua.contains("Mac OS") ? "Mac browser"
                : ua.contains("Linux") ? "Linux browser"
                : "Browser";
        String ip = address.getHostAddress();
        return model + " ." + ip.substring(ip.lastIndexOf('.') + 1);
    }

    /** Browsers are told apart by their address on this network. */
    @Override
    public String id() {
        return "web " + address().getHostAddress();
    }

    @Override
    public String kind() {
        return mobile ? "PHONE" : "BROWSER";
    }
}
