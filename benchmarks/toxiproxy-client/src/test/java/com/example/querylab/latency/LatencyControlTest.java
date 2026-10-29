package com.example.querylab.latency;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class LatencyControlTest {
    @Test
    void setsOddRttAndRestoresDeterministicOwnedToxicsWithoutTouchingOthers() throws Exception {
        try (FakeToxiproxy server = new FakeToxiproxy()) {
            String foreignBefore = server.toxics.get("someone-elses-delay").toString();
            Map<String, Object> output = LatencyControl.run(
                    LatencyControl.Request.parse(new String[]{"set", "1"}), server.environment());

            assertEquals("set", output.get("command"));
            assertEquals(1L, output.get("requestedAddedRttMs"));
            assertFalse(server.toxics.containsKey(LatencyControl.UP_TOXIC));
            assertEquals(1, server.toxics.get(LatencyControl.DOWN_TOXIC).getAsJsonObject("attributes").get("latency").getAsInt());
            for (String name : List.of(LatencyControl.DOWN_TOXIC)) {
                assertEquals(0, server.toxics.get(name).getAsJsonObject("attributes").get("jitter").getAsInt());
                assertEquals(1.0f, server.toxics.get(name).get("toxicity").getAsFloat());
            }
            assertEquals(foreignBefore, server.toxics.get("someone-elses-delay").toString());
            assertTrue(server.mutations.stream().noneMatch(path -> path.contains("someone-elses-delay")));

            LatencyControl.run(LatencyControl.Request.parse(new String[]{"set", "0"}), server.environment());
            assertFalse(server.toxics.containsKey(LatencyControl.UP_TOXIC));
            assertFalse(server.toxics.containsKey(LatencyControl.DOWN_TOXIC));
            assertEquals(foreignBefore, server.toxics.get("someone-elses-delay").toString());
            int mutationCount = server.mutations.size();
            LatencyControl.run(LatencyControl.Request.parse(new String[]{"set", "0"}), server.environment());
            assertEquals(mutationCount, server.mutations.size());
        }
    }

    @Test
    void acceptsOnlyTheKnownIpv6WildcardNormalization() throws Exception {
        try (FakeToxiproxy server = new FakeToxiproxy()) {
            server.listen = "[::]:8666";
            Map<String, Object> output = LatencyControl.run(
                    LatencyControl.Request.parse(new String[]{"set", "2"}), server.environment());
            assertEquals("[::]:8666", ((Map<?, ?>) output.get("proxy")).get("listen"));
            assertEquals(1, server.toxics.get(LatencyControl.UP_TOXIC).getAsJsonObject("attributes").get("latency").getAsInt());
            assertEquals(1, server.toxics.get(LatencyControl.DOWN_TOXIC).getAsJsonObject("attributes").get("latency").getAsInt());
            server.listen = "127.0.0.1:8666";
            int mutationCount = server.mutations.size();
            assertThrows(IllegalArgumentException.class, () -> LatencyControl.run(
                    LatencyControl.Request.parse(new String[]{"set", "2"}), server.environment()));
            assertEquals(mutationCount, server.mutations.size());
        }
    }

    @Test
    void rejectsIncorrectExistingProxyWithoutChangingToxics() throws Exception {
        try (FakeToxiproxy server = new FakeToxiproxy()) {
            server.upstream = "other-db:5432";
            assertThrows(IllegalArgumentException.class, () -> LatencyControl.run(
                    LatencyControl.Request.parse(new String[]{"set", "2"}), server.environment()));
            assertTrue(server.mutations.isEmpty());
        }
    }

    @Test
    void rejectsMalformedOrOverflowingSettingsBeforeControlActions() {
        for (String raw : List.of("-1", "1.5", "1ms", "9223372036854775808", "1001")) {
            assertThrows(IllegalArgumentException.class,
                    () -> LatencyControl.Request.parse(new String[]{"set", raw}));
        }
        assertThrows(IllegalArgumentException.class,
                () -> LatencyControl.Request.parse(new String[]{"calibrate", "1", "0"}));
        assertThrows(IllegalArgumentException.class,
                () -> LatencyControl.Request.parse(new String[]{"inspect", "1"}));
    }

    @Test
    void percentileUsesDocumentedNearestRankAndMedianSupportsNegativePairedDifferences() {
        List<Double> values = List.of(4.0, -2.0, 2.0, 8.0);
        assertEquals(3.0, LatencyControl.median(values));
        assertEquals(8.0, LatencyControl.percentile(values, 0.95));
        assertEquals(-2.0, LatencyControl.median(List.of(-3.0, -2.0, -1.0)));
    }

    private static final class FakeToxiproxy implements AutoCloseable {
        private final HttpServer server;
        final Map<String, JsonObject> toxics = new LinkedHashMap<>();
        final List<String> mutations = new ArrayList<>();
        String upstream = LatencyControl.UPSTREAM;
        String listen = LatencyControl.LISTEN;

        FakeToxiproxy() throws IOException {
            toxics.put("someone-elses-delay", toxic("someone-elses-delay", "downstream", 42, 2, 0.5));
            toxics.put(LatencyControl.UP_TOXIC, toxic(LatencyControl.UP_TOXIC, "upstream", 99, 3, 0.2));
            toxics.put(LatencyControl.DOWN_TOXIC, toxic(LatencyControl.DOWN_TOXIC, "downstream", 6, 4, 0.3));
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::respond);
            server.start();
        }

        Map<String, String> environment() {
            return Map.of("TOXIPROXY_HOST", "127.0.0.1", "TOXIPROXY_PORT", Integer.toString(server.getAddress().getPort()));
        }

        private JsonObject proxy() {
            JsonObject proxy = new JsonObject();
            proxy.addProperty("name", LatencyControl.PROXY_NAME);
            proxy.addProperty("listen", listen);
            proxy.addProperty("upstream", upstream);
            proxy.addProperty("enabled", true);
            return proxy;
        }

        private void respond(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            String prefix = "/proxies/" + LatencyControl.PROXY_NAME;
            String body;
            if (exchange.getRequestMethod().equals("DELETE")) {
                mutations.add(path);
                toxics.remove(path.substring(path.lastIndexOf('/') + 1));
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            } else if (exchange.getRequestMethod().equals("POST")) {
                mutations.add(path);
                JsonObject update = JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
                String name = path.substring(path.lastIndexOf('/') + 1);
                JsonObject existing = toxics.get(name);
                if (existing == null) throw new IOException("Unexpected test mutation");
                for (Map.Entry<String, com.google.gson.JsonElement> entry : update.entrySet()) {
                    if (entry.getKey().equals("attributes")) {
                        entry.getValue().getAsJsonObject().entrySet().forEach(attribute ->
                                existing.getAsJsonObject("attributes").add(attribute.getKey(), attribute.getValue()));
                    } else existing.add(entry.getKey(), entry.getValue());
                }
                body = existing.toString();
            } else if (path.equals("/version")) body = "2.12.0";
            else if (path.equals("/proxies")) {
                JsonObject proxies = new JsonObject();
                proxies.add(LatencyControl.PROXY_NAME, proxy());
                body = proxies.toString();
            } else if (path.equals(prefix)) body = proxy().toString();
            else if (path.equals(prefix + "/toxics")) {
                JsonArray array = new JsonArray();
                toxics.values().forEach(array::add);
                body = array.toString();
            } else throw new IOException("Unexpected test path");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        }

        private static JsonObject toxic(String name, String stream, long delay, long jitter, double toxicity) {
            JsonObject toxic = new JsonObject();
            toxic.addProperty("name", name);
            toxic.addProperty("type", "latency");
            toxic.addProperty("stream", stream);
            toxic.addProperty("toxicity", toxicity);
            JsonObject attributes = new JsonObject();
            attributes.addProperty("latency", delay);
            attributes.addProperty("jitter", jitter);
            toxic.add("attributes", attributes);
            return toxic;
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }
}
