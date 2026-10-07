package rooftop.model;

/** A message that landed on this PC. */
public record ReceivedText(String text, String from, long at) {
}
