package rooftop.model;

import java.net.InetAddress;

/** A browser talking to us over HTTP: iPhone, Android, or a laptop that has no Java. */
public class PhoneClient extends NetworkDevice {
    private final boolean mobile;
    private final String id;

    /** {@code id} is "web " + address, plus the browser's own random id when it sends one. */
    public PhoneClient(String userAgent, InetAddress address, String id) {
        super(nameFrom(userAgent, address), address);
        this.mobile = userAgent.contains("Mobi") || userAgent.contains("Android") || userAgent.contains("iPhone");
        this.id = id;
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

    /** Browsers are told apart by their address on this network and the random id each one keeps. */
    @Override
    public String id() {
        return id;
    }

    @Override
    public String kind() {
        return mobile ? "PHONE" : "BROWSER";
    }
}
