package rooftop.error;

/** Checked: the other side refused, hung up, or sent something that makes no sense. */
public class TransferFailedException extends RooftopException {
    public TransferFailedException(String message) {
        super(message);
    }
}
