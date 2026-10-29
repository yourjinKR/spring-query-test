# Experiment control process

This Java 21 process uses `eu.rekawek.toxiproxy:toxiproxy-java:2.1.7` to configure the experiment's TCP proxy. It is separate from the measured Spring application. Successful commands emit one JSON object to stdout. Errors go to stderr and exit with a nonzero status.

```text
set <rtt-ms>
inspect
calibrate <rtt-ms> [samples]
```

`set` creates or reuses `querylab-postgres`, listening at `0.0.0.0:8666` and forwarding to `db:5432`. The server's normalized wildcard listen address `[::]:8666` is also accepted; other endpoints are rejected. Only the `querylab-rtt-upstream` and `querylab-rtt-downstream` toxics are created or updated. Other toxics remain unchanged and appear in the snapshot. Added RTT accepts whole milliseconds in `0..1000`; upstream receives `floor(RTT/2)`, downstream receives the remainder, jitter is zero and toxicity is one. A direction with zero delay has its own toxic removed, so `set 0` keeps the proxy path without either latency toxic, and `set 1` has only downstream latency. Run control commands while the application is idle, since updating the two streams is not atomic.

`inspect` reads the existing proxy. It does not create or modify it.

`calibrate` first applies the requested delay and rejects unrelated toxics. It opens one direct and one proxied JDBC connection, sets both to read-only, REPEATABLE READ and auto-commit false, and performs ten warmup `SELECT 1` calls on each connection. It then runs 30 samples by default (allowed range 5..10000), alternating the direct/proxied order between sequential sample pairs. It records JDBC execute, result consumption and result close on the same reused connection. Connection setup, transaction start, warmup and rollback are excluded. All measured samples and paired differences are saved alongside medians and nearest-rank p95 values. The median difference includes proxy overhead and host scheduling; this is calibration of a tiny query, not an assertion that every application query has one network round trip.

Environment defaults:

| Setting | Default |
|---|---|
| `TOXIPROXY_HOST` / `TOXIPROXY_PORT` | `toxiproxy` / `8474` |
| `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | `querylab` |
| `DIRECT_DB_HOST` / `DIRECT_DB_PORT` | `db` / `5432` |
| `PROXY_DB_HOST` / `PROXY_DB_PORT` | `toxiproxy` / `8666` |

The calibration uses pgJDBC 42.7.14 and ten-second connection/socket timeouts. No password or JDBC URL is included in output. The Docker build runs the isolated Java tests and creates a shaded executable JAR.

```powershell
docker build -t querylab-latency-control:local benchmarks/toxiproxy-client
```
