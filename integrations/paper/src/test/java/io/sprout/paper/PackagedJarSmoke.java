package io.sprout.paper;

import java.nio.file.Path;

/** Launch with only the shaded plugin JAR plus target/test-classes on the classpath. */
public final class PackagedJarSmoke {
    public static void main(String[] args) throws Exception {
        Class<?> hostClass = Class.forName("io.sprout.host.SproutHost");
        var host = hostClass.getConstructor(String.class).newInstance(args[0]);
        try {
            Object mapper = hostClass.getMethod("json").invoke(null);
            var parse = mapper.getClass().getMethod("readTree", String.class);
            Object input = parse.invoke(mapper, "{\"event\":\"mob_kill\",\"entity\":\"ZOMBIE\",\"player\":{\"id\":\"test\",\"name\":\"Ada\"}}");
            Object output = hostClass.getMethod("run", Path.class, parse.getReturnType()).invoke(host, Path.of(args[1]), input);
            if (!output.toString().contains("BREAD")) throw new AssertionError("Packaged host did not return native reward action: " + output);
            System.out.println("Packaged JAR native JSON smoke passed: " + output);
        } finally { ((AutoCloseable)host).close(); }
    }
}
