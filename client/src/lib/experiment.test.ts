import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionOrder, parseIds, percentile, samePosts, summarize } from './experiment.ts';
import type { Post, Sample } from './types.ts';

test('ID ranges are deduplicated and sorted, while unsafe and excessive inputs fail', () => {
  assert.deepEqual(parseIds('5, 1-3, 2'), [1, 2, 3, 5]);
  assert.equal(parseIds('1-100').length, 100);
  for (const value of ['', '0', '2-1', '1-101', '1,', '1.2', '9007199254740992']) {
    assert.throws(() => parseIds(value), undefined, value);
  }
});

test('nearest-rank percentiles use observations and do not mutate samples', () => {
  const values = [10, 1, 3, 2];
  assert.equal(percentile(values, 0.5), 2);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile([], 0.95), null);
  assert.deepEqual(values, [10, 1, 3, 2]);
});

test('DTO equality checks nested data and ordered arrays, ignoring object key order', () => {
  const post: Post = { id: 1, title: 'one', body: 'body', comments: [{ id: 1, content: 'a' }], attachments: [] };
  const reordered: Post = { comments: [{ content: 'a', id: 1 }], attachments: [], body: 'body', title: 'one', id: 1 };
  assert.equal(samePosts([post], [reordered]), true);
  assert.equal(samePosts([post], [{ ...post, comments: [] }]), false);
  assert.equal(samePosts([post], [{ ...post, body: 'different' }]), false);
  assert.equal(samePosts([], []), true);
});

test('summaries separate versions and preserve the latest observed row/query counts', () => {
  const sample = (version: 'v1' | 'v2', value: number): Sample => ({
    iteration: 1, order: 1, version, httpMs: value + 1, parentCount: 1,
    metrics: { queryCount: version === 'v1' ? 1 : 3, totalRows: value, fetchAndAssembleMs: value,
      jdbcExecuteMs: value / 2, assemblyMs: value / 4, queries: [] },
  });
  const result = summarize([sample('v1', 2), sample('v2', 100), sample('v1', 4)], 'v1');
  assert.equal(result.fetchP50, 2);
  assert.equal(result.httpP95, 5);
  assert.equal(result.queryCount, 1);
  assert.equal(result.rows, 4);
  assert.deepEqual(executionOrder(0), ['v1', 'v2']);
  assert.deepEqual(executionOrder(1), ['v2', 'v1']);
});
