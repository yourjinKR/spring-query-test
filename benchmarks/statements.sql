\set ON_ERROR_STOP on
-- The extension is installed by Compose's initial database setup script.
-- Run only one strategy at a time. Capture before/after and subtract by queryid.
-- Counters are server-wide aggregates, not request-scoped metrics. rows counts
-- returned/affected rows, not every row scanned inside the execution plan.
SELECT queryid, calls, rows, total_exec_time, mean_exec_time,
       shared_blks_hit, shared_blks_read, temp_blks_read, temp_blks_written,
       query
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query ~* '^select'
  AND toplevel
  AND query ~* 'lab_(post|comment|attachment)'
  AND query !~* 'pg_stat_statements'
ORDER BY total_exec_time DESC;
