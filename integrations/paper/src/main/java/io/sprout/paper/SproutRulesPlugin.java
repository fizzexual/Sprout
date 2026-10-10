package io.sprout.paper;

import com.fasterxml.jackson.databind.node.ObjectNode;
import io.sprout.host.SproutHost;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicBoolean;
import net.kyori.adventure.text.Component;
import org.bukkit.*;
import org.bukkit.command.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class SproutRulesPlugin extends JavaPlugin implements Listener, CommandExecutor {
    private final AtomicBoolean stopping = new AtomicBoolean();
    private SproutHost host;
    private RuleManager rules;
    private Path source;

    @Override public void onEnable() {
        saveDefaultConfig();
        source = getDataFolder().toPath().resolve("rules.sprout");
        if (!source.toFile().exists()) saveResource("rules.sprout", false);
        try {
            Set<String> materials = new HashSet<>();
            for (String name : getConfig().getStringList("allowed-materials")) {
                Material material = Material.matchMaterial(name);
                if (material == null || !material.isItem() || material.isAir()) throw new IllegalArgumentException("Invalid allowed material: " + name);
                materials.add(material.name());
            }
            var defaults = SproutHost.Options.defaults(Objects.requireNonNull(getConfig().getString("sprout-command")));
            host = new SproutHost(new SproutHost.Options(defaults.command(), getDataFolder().toPath(), true,
                getConfig().getInt("max-steps", 100_000), Duration.ofMillis(getConfig().getLong("runtime-timeout-ms", 1000)),
                Duration.ofMillis(getConfig().getLong("host-timeout-ms", 2000)), 65_536, 65_536, 16_384, 2));
            rules = new RuleManager(getDataFolder().toPath().resolve("validated"), host::run, new ActionPolicy(materials));
            Objects.requireNonNull(getCommand("sproutrules")).setExecutor(this);
            getServer().getPluginManager().registerEvents(this, this);
            reload(getServer().getConsoleSender());
        } catch (Exception failure) {
            getLogger().severe("Sprout setup failed: " + failure.getMessage()); getServer().getPluginManager().disablePlugin(this);
        }
    }
    @EventHandler(priority=EventPriority.MONITOR) public void onJoin(PlayerJoinEvent event) {
        dispatch(event.getPlayer(), input("join", event.getPlayer()));
    }
    @EventHandler(priority=EventPriority.MONITOR) public void onDeath(EntityDeathEvent event) {
        Player killer = event.getEntity().getKiller();
        if (killer != null) { ObjectNode data = input("mob_kill", killer); data.put("entity", event.getEntityType().name()); dispatch(killer, data); }
    }
    private ObjectNode input(String event, Player player) {
        ObjectNode input = SproutHost.json().createObjectNode(); input.put("event", event);
        input.putObject("player").put("id", player.getUniqueId().toString()).put("name", player.getName());
        return input;
    }
    private void dispatch(Player player, ObjectNode input) {
        if (rules == null || rules.current() == null || stopping.get()) return;
        UUID target = player.getUniqueId();
        rules.evaluate(input).whenComplete((actions, failure) -> {
            if (stopping.get()) return;
            if (failure != null) { getLogger().warning("Sprout event rejected: " + reason(failure)); return; }
            main(() -> {
                if (!Bukkit.isPrimaryThread()) throw new IllegalStateException("Sprout actions require main thread");
                Player online = getServer().getPlayer(target);
                if (online == null || !online.isOnline()) return;
                for (ActionPolicy.Action action : actions) {
                    if (action.type().equals("message")) online.sendMessage(Component.text(action.text()));
                    else if (action.type().equals("give")) {
                        var remaining = online.getInventory().addItem(new ItemStack(Material.valueOf(action.material()), action.amount()));
                        // Do not spawn extra world entities on inventory overflow.
                        if (!remaining.isEmpty()) online.sendMessage(Component.text("Your inventory was full; some reward items could not fit."));
                    }
                }
            });
        });
    }
    @Override public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!sender.hasPermission("sprout.rules.admin")) return true;
        if (args.length != 1) return false;
        switch (args[0].toLowerCase(Locale.ROOT)) {
            case "reload" -> reload(sender);
            case "status" -> sender.sendMessage(Component.text(rules.current() == null ? "No validated Sprout rules active." : "Active Sprout rules: " + rules.current().id()));
            case "test" -> {
                var test = SproutHost.json().createObjectNode(); test.put("event", "join");
                test.putObject("player").put("id", "00000000-0000-0000-0000-000000000000").put("name", "SproutTest");
                rules.evaluate(test).whenComplete((actions, failure) -> main(() -> sender.sendMessage(Component.text(failure == null
                    ? "Validated " + actions.size() + " actions; test applies none." : "Test failed: " + reason(failure)))));
            }
            default -> { return false; }
        }
        return true;
    }
    private void reload(CommandSender sender) {
        sender.sendMessage(Component.text("Validating Sprout candidate in the background..."));
        rules.reload(source).whenComplete((result, failure) -> main(() -> {
            if (failure != null) sender.sendMessage(Component.text("Reload rejected; previous rules retained: " + reason(failure)));
            else if (!result.superseded()) sender.sendMessage(Component.text((result.fallback() ? "Recovered last working rules: " : "Activated rules: ") + result.version().id()));
        }));
    }
    private void main(Runnable work) {
        if (stopping.get()) return;
        try { getServer().getScheduler().runTask(this, () -> { if (!stopping.get()) work.run(); }); }
        catch (org.bukkit.plugin.IllegalPluginAccessException ignored) { /* Disabled between check and scheduling. */ }
    }
    private static String reason(Throwable failure) {
        while (failure instanceof CompletionException && failure.getCause() != null) failure = failure.getCause();
        String text = failure.getMessage(); return text == null ? failure.getClass().getSimpleName() : text.substring(0, Math.min(text.length(), 300));
    }
    @Override public void onDisable() { stopping.set(true); if (rules != null) rules.close(); if (host != null) host.close(); }
}
