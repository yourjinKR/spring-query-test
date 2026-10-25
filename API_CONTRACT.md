# Query Lab contract

This is a local learning application. Java 21 / Spring Boot 4 / JPA / OpenFeign QueryDSL / PostgreSQL, and React + TypeScript. No authentication.

## Read APIs

`GET /v1/posts?ids=1,2,3&mode=analysis` executes one flat LEFT JOIN.
`GET /v2/posts?ids=1,2,3&mode=analysis` executes three sequential bulk SELECTs: posts, comments, attachments. No per-parent SELECTs.

`ids` defaults to 1 through 50, is deduplicated and sorted, and is limited to 100 positive IDs. Missing parent IDs are omitted. `mode` is `analysis` (default) or `benchmark`. Both modes retain lightweight timings and counts; benchmark omits SQL text and avoids verbose SQL logging.

```json
{
  "strategy": "SINGLE_JOIN",
  "posts": [{"id":1,"title":"Post 1","body":"...","comments":[{"id":1,"content":"..."}],"attachments":[{"id":1,"fileName":"file.txt","byteSize":1024}]}],
  "metrics": {
    "queryCount":1,
    "totalRows":100,
    "fetchAndAssembleMs":2.5,
    "jdbcExecuteMs":1.0,
    "assemblyMs":0.5,
    "queries":[{"sql":"select ...","elapsedMs":1.0,"rows":100}]
  }
}
```

v2 strategy is `SPLIT_QUERIES`. Arrays are ordered by ID. `posts` must match between versions. Metrics are request scoped. `rows` counts fetched flat result tuples (not unique entities or rows scanned). JDBC time is not pure DB time and does not include all ResultSet consumption. Fetch-and-assemble covers query fetching, conversion and DTO assembly, not HTTP serialization. Timings need not sum to HTTP duration.

## Dataset APIs

`GET /lab/dataset` returns `{postCount, commentCount, attachmentCount, config}`. `config` may be null for an unseeded database.

`POST /lab/dataset` transactionally replaces only the lab tables using body `{postCount:1000, commentsPerPost:20, attachmentsPerPost:5, bodyBytes:1024, seed:42, distribution:"UNIFORM"}`. Also support `SKEWED` (deterministic unequal child counts). Return the same dataset status. Validate bounded positive post count, nonnegative child counts and body byte count. Document limits and skew semantics. IDs restart at 1. Post body is deterministic ASCII of exactly bodyBytes bytes. Run ANALYZE after successful seed. Startup seeds a small default dataset only if empty (configurable).

## Error response

HTTP 400/409/etc with JSON `{message:"human-readable explanation"}`; unknown API routes must return HTTP 404.

## Runtime

Server port 8080, client dev server 5173. PostgreSQL database/user/password: querylab/querylab/querylab, host port 5432. Environment: DB_URL default jdbc:postgresql://localhost:5432/querylab, DB_USERNAME, DB_PASSWORD. Actuator health and Prometheus metrics enabled. Flyway owns schema; ddl-auto=validate; OSIV and ORM query/second-level caches disabled.

## Limits and deterministic skew

Creation bounds: 1..10,000 posts, 0..200 configured comments, 0..100 configured attachments, 0..16,384 body bytes. Total children <=2,000,000; total parent body bytes <=128 MiB. Startup defaults: 200/20/5/1024/42/UNIFORM.

SKEWED assigns 10x configured children to every tenth post ID and zero children to all others. Read requests reject estimated results above 250,000 flat rows or 192 MiB; v2 counts parent body once per parent in this conservative estimate. These estimates are not measured network byte counts.
