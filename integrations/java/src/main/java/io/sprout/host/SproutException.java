package io.sprout.host;

/** A bounded interpreter or protocol failure. */
public final class SproutException extends RuntimeException {
    private final String code;
    public SproutException(String code, String message) { super(message); this.code = code; }
    public SproutException(String code, String message, Throwable cause) { super(message, cause); this.code = code; }
    public String code() { return code; }
}
