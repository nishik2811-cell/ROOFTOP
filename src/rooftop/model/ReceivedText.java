package rooftop.model;

/**
 * A chat message. fromId and to are device ids as in ReceivedItem; to is "*" when it is for everyone.
 */
public record ReceivedText(String text, String from, String fromId, String to, long at) {
    /** Who may see it: everyone it was addressed to, plus whoever sent it. */
    public boolean visibleTo(String deviceId) {
        return ReceivedItem.EVERYONE.equals(to) || to.equals(deviceId) || fromId.equals(deviceId);
    }
}
