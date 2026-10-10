package io.sprout.host;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;

public final class FakeInterpreter {
    public static void main(String[] args) throws Exception {
        String mode = Path.of(args[1]).getFileName().toString();
        if (mode.equals("hang")) { Thread.sleep(30_000); return; }
        byte[] request = System.in.readAllBytes();
        switch (mode) {
            case "echo" -> System.out.write(request);
            case "args" -> System.out.println(SproutHost.json().valueToTree(Arrays.asList(args)));
            case "extra" -> System.out.println("{}\n{}");
            case "invalid" -> System.out.println("{bad}");
            case "duplicate" -> System.out.println("{\"x\":1,\"x\":2}");
            case "utf8" -> System.out.write(new byte[] {(byte)0xff});
            case "large" -> System.out.print("x".repeat(100_000));
            case "errors" -> System.err.print("x".repeat(100_000));
            case "runtime" -> { System.err.print("deliberate fixture failure"); System.exit(8); }
            default -> throw new IllegalArgumentException(mode);
        }
    }
}
