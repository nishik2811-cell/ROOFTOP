package rooftop.model;

import java.net.InetAddress;

/** A device we reach over the Wi-Fi. Parent of PcPeer and PhoneClient (hierarchical inheritance). */
public abstract class NetworkDevice extends Device {
    private static final long ONLINE_MS = 10_000;

    private final InetAddress address;
    private volatile long lastSeen = System.currentTimeMillis();

    protected NetworkDevice(String name, InetAddress address) {
        super(name);
        this.address = address;
    }

    public InetAddress address() {
        return address;
    }

    public void touch() {
        lastSeen = System.currentTimeMillis();
    }

    public boolean isOnline() {
        return System.currentTimeMillis() - lastSeen < ONLINE_MS;
    }

    public long secondsSinceSeen() {
        return (System.currentTimeMillis() - lastSeen) / 1000;
    }
}
