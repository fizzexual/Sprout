package io.sprout.host;

import java.nio.file.Path;

/** Independent wire fixture; it deliberately does not call Jackson's writer. */
public final class ProtocolWorker {
    public static void main(String[] args) throws Exception {
        System.in.readAllBytes();
        String mode = Path.of(args[1]).getFileName().toString();
        String output = switch (mode) {
            case "duplicate" -> "{\"allow\":false,\"allow\":true}";
            case "escaped-duplicate" -> "{\"allow\":false,\"\\u0061llow\":true}";
            case "nonfinite" -> "{\"amount\":1e999}";
            case "negative-nonfinite" -> "-1e999";
            case "deep" -> "[".repeat(129) + "0" + "]".repeat(129);
            case "deep-empty" -> "[".repeat(129) + "]".repeat(129);
            case "boundary" -> "[".repeat(128) + "0" + "]".repeat(128);
            case "boundary-empty" -> "[".repeat(128) + "]".repeat(128);
            case "surrogate" -> "{\"text\":\"\\ud800\"}";
            case "surrogate-key" -> "{\"\\udc00\":true}";
            case "nul" -> "{\"text\":\"\\u0000suffix\"}";
            case "nul-key" -> "{\"\\u0000\":true}";
            case "paired" -> "{\"text\":\"\\ud83c\\udf31\",\"literal\":\"\\\\ud800\"}";
            case "large-finite" -> "{\"value\":100000000000000000000}";
            case "leading-blank" -> "\n{}";
            case "trailing-blank" -> "{}\n";
            case "healthy" -> "{\"ok\":true}";
            default -> throw new IllegalArgumentException(mode);
        };
        System.out.println(output);
    }
}
