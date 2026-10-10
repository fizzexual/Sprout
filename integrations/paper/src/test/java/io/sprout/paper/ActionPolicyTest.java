package io.sprout.paper;

import static org.junit.jupiter.api.Assertions.*;
import io.sprout.host.SproutHost;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

final class ActionPolicyTest {
    private final ActionPolicy policy = new ActionPolicy(Set.of("BREAD"));
    @Test void acceptsOnlyBoundedMessagesAndWhitelistedItems() throws Exception {
        var actions = policy.validate(SproutHost.json().readTree("{\"actions\":[{\"type\":\"message\",\"text\":\"literal <tag>\"},{\"type\":\"give\",\"material\":\"BREAD\",\"amount\":1}]}"));
        assertEquals(2, actions.size()); assertEquals("literal <tag>", actions.get(0).text());
        assertEquals(1, actions.get(1).amount());
    }
    @ParameterizedTest @ValueSource(strings={
        "{\"actions\":[{\"type\":\"command\",\"text\":\"op me\"}]}",
        "{\"actions\":[{\"type\":\"give\",\"material\":\"DIAMOND\",\"amount\":1}]}",
        "{\"actions\":[{\"type\":\"give\",\"material\":\"BREAD\",\"amount\":65}]}",
        "{\"actions\":[{\"type\":\"give\",\"material\":\"BREAD\",\"amount\":1.5}]}",
        "{\"actions\":[{\"type\":\"give\",\"material\":\"BREAD\",\"amount\":4294967297}]}",
        "{\"actions\":[{\"type\":\"message\",\"text\":\"ok\",\"player\":\"somebody\"}]}",
        "{\"actions\":[],\"command\":\"stop\"}", "{}", "[]"
    }) void rejectsEntireResponseBeforeAnyHostEffects(String source) throws Exception {
        assertThrows(IllegalArgumentException.class, () -> policy.validate(SproutHost.json().readTree(source)));
    }
    @Test void boundsActionCountAndMessageLength() {
        var response = SproutHost.json().createObjectNode(); var list = response.putArray("actions");
        for (int i=0; i<17; i++) list.addObject().put("type", "message").put("text", "x");
        assertThrows(IllegalArgumentException.class, () -> policy.validate(response));
        list.removeAll(); list.addObject().put("type", "message").put("text", "x".repeat(513));
        assertThrows(IllegalArgumentException.class, () -> policy.validate(response));
    }
}
