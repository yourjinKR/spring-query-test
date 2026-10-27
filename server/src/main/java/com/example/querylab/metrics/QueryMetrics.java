package com.example.querylab.metrics;

import com.example.querylab.dto.metrics.Metrics;
import com.example.querylab.dto.metrics.QueryMetric;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/** Collects measurements for one synchronous service call, independently of other requests. */
@Component
public class QueryMetrics {

    private final ThreadLocal<Collector> current = new ThreadLocal<>();

    public void begin(boolean includeSql) {
        if (current.get() != null) {
            throw new IllegalStateException("A query observation is already active");
        }
        current.set(new Collector(includeSql));
    }

    public void clear() {
        current.remove();
    }

    public void executed(String sql, long elapsedMs) {
        Collector collector = current.get();
        if (collector != null) {
            collector.entries.add(new Entry(collector.includeSql ? sql : null, elapsedMs));
        }
    }

    public void fetched(int rows) {
        Collector collector = current.get();
        if (collector == null) {
            return;
        }
        if (collector.entries.isEmpty()) {
            throw new IllegalStateException("SELECT was not intercepted");
        }
        collector.entries.getLast().rows = rows;
    }

    public void assembled(long elapsedNanos) {
        requireCollector().assemblyNanos += elapsedNanos;
    }

    public Metrics snapshot(long startedNanos) {
        Collector collector = requireCollector();
        List<QueryMetric> queries = collector.entries.stream()
                .map(entry -> new QueryMetric(entry.sql, entry.elapsedMs, entry.rows))
                .toList();

        long totalRows = queries.stream().mapToLong(QueryMetric::getRows).sum();
        double jdbcExecuteMs = queries.stream().mapToDouble(QueryMetric::getElapsedMs).sum();
        double fetchAndAssembleMs = (System.nanoTime() - startedNanos) / 1_000_000.0;
        double assemblyMs = collector.assemblyNanos / 1_000_000.0;

        return new Metrics(queries.size(), totalRows, fetchAndAssembleMs,
                jdbcExecuteMs, assemblyMs, queries);
    }

    private Collector requireCollector() {
        Collector collector = current.get();
        if (collector == null) {
            throw new IllegalStateException("No query observation is active");
        }
        return collector;
    }

    private static final class Collector {

        private final boolean includeSql;
        private final List<Entry> entries = new ArrayList<>();
        private long assemblyNanos;

        private Collector(boolean includeSql) {
            this.includeSql = includeSql;
        }
    }

    private static final class Entry {

        private final String sql;
        private final long elapsedMs;
        private long rows;

        private Entry(String sql, long elapsedMs) {
            this.sql = sql;
            this.elapsedMs = elapsedMs;
        }
    }
}
