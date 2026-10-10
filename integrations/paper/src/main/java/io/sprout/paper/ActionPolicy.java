package io.sprout.paper;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;

/** The complete host capability surface; unknown actions/fields reject the whole response. */
public final class ActionPolicy {
    public record Action(String type, String text, String material, int amount) { }
    private final Set<String> materials;
    public ActionPolicy(Set<String> materials) { this.materials = Set.copyOf(materials); }
    public List<Action> validate(JsonNode response) {
        fields(response, Set.of("actions"));
        JsonNode actions = response.get("actions");
        if (actions == null || !actions.isArray() || actions.size() > 16) throw invalid("actions must be an array of at most 16 entries");
        List<Action> validated = new ArrayList<>();
        for (JsonNode item : actions) {
            String type = text(item, "type", 32);
            switch (type) {
                case "message" -> {
                    fields(item, Set.of("type", "text"));
                    validated.add(new Action(type, text(item, "text", 512), null, 0));
                }
                case "give" -> {
                    fields(item, Set.of("type", "material", "amount"));
                    String material = text(item, "material", 64);
                    JsonNode amount = item.get("amount");
                    if (!materials.contains(material) || amount == null || !amount.isIntegralNumber()
                        || !amount.canConvertToInt() || amount.intValue() < 1 || amount.intValue() > 64)
                        throw invalid("give requires an allowed material and integral amount 1..64");
                    validated.add(new Action(type, null, material, amount.intValue()));
                }
                default -> throw invalid("unsupported action: " + type);
            }
        }
        return List.copyOf(validated);
    }
    private static void fields(JsonNode node, Set<String> allowed) {
        if (node == null || !node.isObject()) throw invalid("expected an object");
        node.fieldNames().forEachRemaining(name -> { if (!allowed.contains(name)) throw invalid("unknown response field: " + name); });
    }
    private static String text(JsonNode node, String key, int limit) {
        JsonNode value = node == null ? null : node.get(key);
        if (value == null || !value.isTextual() || value.textValue().length() > limit) throw invalid(key + " must be bounded text");
        return value.textValue();
    }
    private static IllegalArgumentException invalid(String reason) { return new IllegalArgumentException("Invalid Sprout actions: " + reason); }
}
