\set ON_ERROR_STOP on
-- Override with: psql -v ids='1,2,3' -f benchmarks/explain.sql
\if :{?ids}
\else
\set ids '1,2,3,4,5,6,7,8,9,10'
\endif

-- Diagnostic executions only. These discard result data and exclude ordinary
-- client transfer/DTO assembly. Do not run concurrently with measured requests.
-- Upper plan nodes include child buffers; do not sum all nodes' rows or buffers.
\echo 'v1: flat LEFT JOIN'
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT p.id, p.title, p.body, c.id, c.content, a.id, a.file_name, a.byte_size
FROM lab_post p
LEFT JOIN lab_comment c ON c.post_id = p.id
LEFT JOIN lab_attachment a ON a.post_id = p.id
WHERE p.id = ANY(string_to_array(:'ids', ',')::bigint[]);

\echo 'v2: posts'
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT p.id, p.title, p.body
FROM lab_post p
WHERE p.id = ANY(string_to_array(:'ids', ',')::bigint[]);

\echo 'v2: comments'
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT c.post_id, c.id, c.content
FROM lab_comment c
WHERE c.post_id = ANY(string_to_array(:'ids', ',')::bigint[]);

\echo 'v2: attachments'
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT a.post_id, a.id, a.file_name, a.byte_size
FROM lab_attachment a
WHERE a.post_id = ANY(string_to_array(:'ids', ',')::bigint[]);
