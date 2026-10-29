package com.example.querylab.latency;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import eu.rekawek.toxiproxy.Proxy;
import eu.rekawek.toxiproxy.ToxiproxyClient;
import eu.rekawek.toxiproxy.model.Toxic;
import eu.rekawek.toxiproxy.model.ToxicDirection;
import eu.rekawek.toxiproxy.model.toxic.Latency;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/** Experiment-only control process; never loaded into the measured application. */
public final class LatencyControl {
    static final String PROXY_NAME = "querylab-postgres";
    static final String LISTEN = "0.0.0.0:8666";
    static final String UPSTREAM = "db:5432";
    static final String UP_TOXIC = "querylab-rtt-upstream";
    static final String DOWN_TOXIC = "querylab-rtt-downstream";
    static final int WARMUP_REQUESTS = 10;
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();

    private LatencyControl() {}

    public static void main(String[] args) {
        try {
            Request request = Request.parse(args);
            Map<String, Object> result = run(request, System.getenv());
            System.out.println(JSON.toJson(result));
        } catch (IllegalArgumentException exception) {
            System.err.println(exception.getMessage());
            System.exit(2);
        } catch (Exception exception) {
            // Do not print JDBC URLs, credentials, response bodies, or stack traces.
            String sqlState = exception instanceof SQLException sql ? "; SQLState=" + sql.getSQLState() : "";
            System.err.println("Latency control failed: " + exception.getClass().getSimpleName() + sqlState);
            System.exit(1);
        }
    }

    static Map<String, Object> run(Request request, Map<String, String> environment) throws Exception {
        ToxiproxyClient client = new ToxiproxyClient(
                setting(environment, "TOXIPROXY_HOST", "toxiproxy"),
                integerSetting(environment, "TOXIPROXY_PORT", 8474, 1, 65535));
        Proxy proxy = request.command().equals("inspect")
                ? client.getProxy(PROXY_NAME) : ensureProxy(client);
        if (!request.command().equals("inspect")) {
            validateProxy(proxy);
            setLatency(proxy, request.rttMs());
            if (!proxy.isEnabled()) proxy.enable();
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schemaVersion", 1);
        result.put("command", request.command());
        result.put("recordedAt", Instant.now().toString());
        if (request.rttMs() != null) result.put("requestedAddedRttMs", request.rttMs());
        result.put("toxiproxyVersion", client.version());
        Map<String, Object> snapshot = snapshot(proxy);
        result.put("proxy", snapshot);
        if (request.command().equals("calibrate")) {
            // Other toxics are preserved, but cannot be silently included in calibration.
            for (Toxic toxic : proxy.toxics().getAll()) {
                if (!owned(toxic.getName())) {
                    throw new IllegalArgumentException("Calibration requires a proxy without unrelated toxics");
                }
            }
            result.put("calibration", calibrate(request.samples(), environment));
            result.put("proxyAfter", snapshot(client.getProxy(PROXY_NAME)));
        }
        return result;
    }

    private static Proxy ensureProxy(ToxiproxyClient client) throws Exception {
        for (Proxy proxy : client.getProxies()) {
            if (proxy.getName().equals(PROXY_NAME)) return proxy;
        }
        return client.createProxy(PROXY_NAME, LISTEN, UPSTREAM);
    }

    private static void validateProxy(Proxy proxy) {
        boolean wildcardListen = LISTEN.equals(proxy.getListen()) || "[::]:8666".equals(proxy.getListen());
        if (!wildcardListen || !UPSTREAM.equals(proxy.getUpstream())) {
            throw new IllegalArgumentException("Existing querylab-postgres proxy has unexpected listen/upstream settings");
        }
    }

    private static void setLatency(Proxy proxy, long rttMs) throws Exception {
        long upstreamMs = rttMs / 2;
        long downstreamMs = rttMs - upstreamMs;
        updateToxic(proxy, UP_TOXIC, ToxicDirection.UPSTREAM, upstreamMs);
        updateToxic(proxy, DOWN_TOXIC, ToxicDirection.DOWNSTREAM, downstreamMs);
    }

    private static void updateToxic(Proxy proxy, String name, ToxicDirection direction, long delayMs) throws Exception {
        Toxic existing = null;
        for (Toxic toxic : proxy.toxics().getAll()) {
            if (toxic.getName().equals(name)) existing = toxic;
        }
        if (delayMs == 0) {
            if (existing != null) existing.remove();
            return;
        }
        if (existing != null && (!(existing instanceof Latency) || existing.getStream() != direction)) {
            existing.remove();
            existing = null;
        }
        Latency latency = existing == null
                ? proxy.toxics().latency(name, direction, delayMs) : (Latency) existing;
        if (latency.getLatency() != delayMs) latency.setLatency(delayMs);
        if (latency.getJitter() != 0) latency.setJitter(0);
        if (latency.getToxicity() != 1.0f) latency.setToxicity(1.0f);
    }

    private static boolean owned(String name) {
        return UP_TOXIC.equals(name) || DOWN_TOXIC.equals(name);
    }

    private static Map<String, Object> snapshot(Proxy proxy) throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", proxy.getName());
        result.put("listen", proxy.getListen());
        result.put("upstream", proxy.getUpstream());
        result.put("enabled", proxy.isEnabled());
        List<Map<String, Object>> toxics = new ArrayList<>();
        for (Toxic toxic : proxy.toxics().getAll()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", toxic.getName());
            item.put("type", toxic.getClass().getSimpleName().toLowerCase(Locale.ROOT));
            item.put("stream", toxic.getStream().name().toLowerCase(Locale.ROOT));
            item.put("toxicity", toxic.getToxicity());
            item.put("owned", owned(toxic.getName()));
            if (toxic instanceof Latency latency) {
                item.put("latencyMs", latency.getLatency());
                item.put("jitterMs", latency.getJitter());
            }
            toxics.add(item);
        }
        result.put("toxics", toxics);
        return result;
    }

    private static Map<String, Object> calibrate(int samples, Map<String, String> environment) throws SQLException {
        Properties properties = new Properties();
        properties.setProperty("user", setting(environment, "DB_USERNAME", "querylab"));
        properties.setProperty("password", setting(environment, "DB_PASSWORD", "querylab"));
        properties.setProperty("connectTimeout", "10");
        properties.setProperty("socketTimeout", "10");
        properties.setProperty("tcpKeepAlive", "true");
        String database = setting(environment, "DB_NAME", "querylab");
        if (!database.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("DB_NAME has unsupported characters");
        String directUrl = "jdbc:postgresql://" + setting(environment, "DIRECT_DB_HOST", "db") + ":"
                + integerSetting(environment, "DIRECT_DB_PORT", 5432, 1, 65535) + "/" + database;
        String proxyUrl = "jdbc:postgresql://" + setting(environment, "PROXY_DB_HOST", "toxiproxy") + ":"
                + integerSetting(environment, "PROXY_DB_PORT", 8666, 1, 65535) + "/" + database;
        List<Double> directTimes = new ArrayList<>();
        List<Double> proxyTimes = new ArrayList<>();
        List<Double> differences = new ArrayList<>();
        String driverVersion;
        try (Connection direct = DriverManager.getConnection(directUrl, properties);
             Connection proxied = DriverManager.getConnection(proxyUrl, properties)) {
            configureConnection(direct);
            configureConnection(proxied);
            driverVersion = direct.getMetaData().getDriverVersion();
            try (Statement directStatement = direct.createStatement(); Statement proxyStatement = proxied.createStatement()) {
                directStatement.setFetchSize(0);
                proxyStatement.setFetchSize(0);
                for (int i = 0; i < WARMUP_REQUESTS; i++) {
                    selectOne(directStatement);
                    selectOne(proxyStatement);
                }
                for (int i = 0; i < samples; i++) {
                    double directMs;
                    double proxyMs;
                    if (i % 2 == 0) {
                        directMs = selectOne(directStatement);
                        proxyMs = selectOne(proxyStatement);
                    } else {
                        proxyMs = selectOne(proxyStatement);
                        directMs = selectOne(directStatement);
                    }
                    directTimes.add(directMs);
                    proxyTimes.add(proxyMs);
                    differences.add(proxyMs - directMs);
                }
            }
            direct.rollback();
            proxied.rollback();
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("sql", "SELECT 1");
        result.put("driverVersion", driverVersion);
        result.put("connectionReuse", true);
        result.put("autoCommit", false);
        result.put("readOnly", true);
        result.put("isolation", "REPEATABLE_READ");
        result.put("fetchSize", 0);
        result.put("warmupRequestsPerConnection", WARMUP_REQUESTS);
        result.put("sampleOrder", "Alternating direct/proxy and proxy/direct pairs; sequential statements");
        result.put("excluded", "Connection setup, transaction start, warmup, rollback and connection close");
        result.put("percentileMethod", "nearest-rank; median averages the middle two values for even sample counts");
        result.put("direct", summary(directTimes));
        result.put("proxied", summary(proxyTimes));
        result.put("medianDifferenceMs", median(proxyTimes) - median(directTimes));
        result.put("p95DifferenceMs", percentile(proxyTimes, 0.95) - percentile(directTimes, 0.95));
        result.put("pairedMedianDifferenceMs", median(differences));
        result.put("pairedDifferencesMs", differences);
        result.put("note", "Differences include proxy overhead and scheduling; SELECT 1 calibration does not prove every query uses one round trip");
        return result;
    }

    private static void configureConnection(Connection connection) throws SQLException {
        connection.setReadOnly(true);
        connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
        connection.setAutoCommit(false);
    }

    private static double selectOne(Statement statement) throws SQLException {
        long started = System.nanoTime();
        try (ResultSet rows = statement.executeQuery("SELECT 1")) {
            if (!rows.next() || rows.getInt(1) != 1 || rows.next()) throw new SQLException("Unexpected calibration result");
        }
        return (System.nanoTime() - started) / 1_000_000.0;
    }

    static Map<String, Object> summary(List<Double> values) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("samples", values.size());
        result.put("medianMs", median(values));
        result.put("p95Ms", percentile(values, 0.95));
        result.put("rawSamplesMs", values);
        return result;
    }

    static double median(List<Double> values) {
        double[] sorted = values.stream().mapToDouble(Double::doubleValue).sorted().toArray();
        int middle = sorted.length / 2;
        return sorted.length % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    }

    static double percentile(List<Double> values, double probability) {
        double[] sorted = values.stream().mapToDouble(Double::doubleValue).sorted().toArray();
        return sorted[Math.max(0, (int) Math.ceil(probability * sorted.length) - 1)];
    }

    private static String setting(Map<String, String> environment, String name, String fallback) {
        String value = environment.get(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static int integerSetting(Map<String, String> environment, String name, int fallback, int minimum, int maximum) {
        long value = positiveLong(setting(environment, name, Integer.toString(fallback)), name);
        if (value < minimum || value > maximum) throw new IllegalArgumentException(name + " is outside its supported range");
        return (int) value;
    }

    private static long positiveLong(String raw, String name) {
        if (!raw.matches("[0-9]+")) throw new IllegalArgumentException(name + " must be a nonnegative integer");
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(name + " is outside its supported range");
        }
    }

    record Request(String command, Long rttMs, int samples) {
        static Request parse(String[] args) {
            if (args.length == 1 && args[0].equals("inspect")) return new Request("inspect", null, 0);
            if (args.length == 2 && args[0].equals("set")) {
                return new Request("set", supportedRtt(args[1]), 0);
            }
            if ((args.length == 2 || args.length == 3) && args[0].equals("calibrate")) {
                long count = args.length == 3 ? positiveLong(args[2], "samples") : 30;
                if (count < 5 || count > 10000) throw new IllegalArgumentException("samples must be in 5..10000");
                return new Request("calibrate", supportedRtt(args[1]), (int) count);
            }
            throw new IllegalArgumentException("Usage: set <rtt-ms> | inspect | calibrate <rtt-ms> [samples]");
        }

        private static long supportedRtt(String raw) {
            long value = positiveLong(raw, "rtt-ms");
            // Bound timer overflow and keep the fixed 10-second JDBC socket timeout meaningful.
            if (value > 1000) throw new IllegalArgumentException("rtt-ms must be in 0..1000");
            return value;
        }
    }
}
