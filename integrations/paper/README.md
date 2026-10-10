# Sprout rules for Paper

This plugin keeps Java as the Minecraft host and moves pure gameplay rules into Sprout. It listens for player join and player-caused entity death, evaluates a JSON snapshot in background workers, validates the entire response, and schedules effects on Paper's main thread. It does not block a server tick waiting for an interpreter or cancel an event after it has already happened.

Build with **Java 25** and Maven:

```sh
mvn -f ../java/pom.xml test install
mvn test package
```

The API is pinned to official `io.papermc.paper:paper-api:26.2.build.133-stable`. See [Paper project setup](https://docs.papermc.io/paper/dev/project-setup/) and [scheduler rules](https://docs.papermc.io/paper/dev/scheduler/). This adapter targets ordinary Paper 26.2; Folia requires its own entity/region scheduling adapter and is unsupported here. The shaded JAR is `target/sprout-paper-0.1.0.jar`; Jackson is relocated to avoid dependency collisions with other plugins.

Install the JAR in a Paper test server's `plugins` directory. Start the server, then set `plugins/SproutRules/config.yml` `sprout-command` to the native executable's absolute path and restart. The plugin generates `rules.sprout` with a working greeting and zombie reward. Editing that file and running `/sproutrules reload` validates a frozen candidate against join and mob-kill fixtures before activation. Syntax/runtime/action-schema failures keep the previous version. A successful snapshot is persisted for fallback after a restart; `/sproutrules status` shows its hash. `/sproutrules test` evaluates a join fixture and reports the action count without applying it. Commands require `sprout.rules.admin` (operators by default). Config changes require restart.

Input examples:

```json
{"event":"join","player":{"id":"UUID","name":"Ada"}}
{"event":"mob_kill","player":{"id":"UUID","name":"Ada"},"entity":"ZOMBIE"}
```

Sprout emits exactly one JSON line, for example:

```json
{"actions":[{"type":"message","text":"Welcome!"},{"type":"give","material":"BREAD","amount":1}]}
```

Only `message` (plain text up to 512 characters) and `give` (configured material, integer amount 1–64) exist. All actions target the player from the original event. Unknown fields/types or a list over 16 entries reject the whole response before effects. Full inventories keep items that fit and report overflow; overflow does not drop entities into the world. No console command, arbitrary player target, filesystem, network or process capability is exposed to rules. The native Sprout sandbox is always enabled.

There are two background workers, a queue of at most 32 requests, 64 KiB source/input/output limits, bounded stderr, and native/host deadlines. Queue saturation rejects work; offline players and results arriving after disable are skipped. Disable cancels queued requests, interrupts workers, and terminates active interpreter processes. Source snapshots in `validated/` remain immutable while in-flight events may use them; remove old snapshots only while the server is stopped. Validation checks representative requests, so every real response is validated again. It is not full semantic checking or a guarantee that every rule branch succeeds.

`SPROUT_COMMAND` enables the native SDK/rule smoke tests. The tests exercise reload rejection, immutable source capture, persisted fallback, stale reload ordering, queue bounds, cancellation, and the action capability boundary. A live Paper server session requires the server owner's Minecraft EULA acceptance and a test world; unit/native tests do not accept those terms.

After packaging, verify the relocated host with only the plugin JAR and test classes on the classpath:

```sh
java -cp 'target/sprout-paper-0.1.0.jar:target/test-classes' io.sprout.paper.PackagedJarSmoke "$SPROUT_COMMAND" src/main/resources/rules.sprout
```

Use `;` instead of `:` for the classpath separator on Windows. This verifies the packaged SDK/dependencies and native JSON execution; it does not start Paper or exercise real server events.
