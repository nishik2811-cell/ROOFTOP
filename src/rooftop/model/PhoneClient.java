package rooftop.model;

import java.net.InetAddress;

/** A browser talking to us over HTTP: iPhone, Android, or a laptop that has no Java. */
public class PhoneClient extends NetworkDevice {
    private final boolean mobile;
    private final boolean tablet;
    private final String id;
    private final String platform;
    private final String browser;

    /** {@code id} is "web " + address, plus the browser's own random id when it sends one. */
    public PhoneClient(String userAgent, InetAddress address, String id) {
        super(nameFrom(userAgent, address), address);
        this.tablet = userAgent.contains("iPad") || (userAgent.contains("Android") && !userAgent.contains("Mobile"));
        this.mobile = (userAgent.contains("Mobi") || userAgent.contains("Android") || userAgent.contains("iPhone")) && !this.tablet;
        this.id = id;
        this.platform = detectPlatform(userAgent);
        this.browser = detectBrowser(userAgent);
    }

    private static String detectPlatform(String ua) {
        if (ua.contains("iPhone")) return "iOS";
        if (ua.contains("iPad")) return "iPadOS";
        if (ua.contains("Android")) return "Android";
        if (ua.contains("Windows")) return "Windows";
        if (ua.contains("Macintosh") || ua.contains("Mac OS")) return "macOS";
        if (ua.contains("Linux")) return "Linux";
        if (ua.contains("CrOS")) return "ChromeOS";
        return "Unknown";
    }

    private static String detectBrowser(String ua) {
        if (ua.contains("Edg/")) return "Edge";
        if (ua.contains("Chrome/") && !ua.contains("Edg/")) return "Chrome";
        if (ua.contains("Safari/") && !ua.contains("Chrome/")) return "Safari";
        if (ua.contains("Firefox/")) return "Firefox";
        return "Browser";
    }

    private static String nameFrom(String ua, InetAddress address) {
        String model = ua.contains("iPhone") ? "iPhone"
                : ua.contains("iPad") ? "iPad"
                : ua.contains("Android") ? (ua.contains("Mobile") ? "Android phone" : "Android tablet")
                : ua.contains("Windows") ? "Windows PC"
                : ua.contains("Mac OS") || ua.contains("Macintosh") ? "Mac"
                : ua.contains("Linux") ? "Linux"
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
        return tablet ? "TABLET" : (mobile ? "PHONE" : "BROWSER");
    }

    public String platform() {
        return platform;
    }

    public String browser() {
        return browser;
    }
}
