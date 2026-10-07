package rooftop.model;

/**
 * A file that landed in the inbox.
 * fromId and to are device ids (see Device.id()); to is "*" when the file is for everyone.
 */
public record ReceivedItem(String name, long size, String from, String fromId, String to, long at) {
    public static final String EVERYONE = "*";

    /** Who may see this file: everyone it was addressed to, plus whoever sent it. */
    public boolean visibleTo(String deviceId) {
        return EVERYONE.equals(to) || to.equals(deviceId) || fromId.equals(deviceId);
    }
}
