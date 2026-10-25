import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { parseArgs, parseIds, percentile, runComparison } from './compare.mjs';

test('IDs are normalized without accepting empty, unsafe, zero or excessive values', () => {
  assert.deepEqual(parseIds('3, 1,3,2'), [1, 2, 3]);
  for (const input of ['', '0', '-1', '1,,2', '1.2', '9007199254740992', Array(101).fill('1').join(',')]) {
    assert.throws(() => parseIds(input));
  }
});

test('nearest rank percentile is deterministic for small samples', () => {
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([30, 10, 20], 0.95), 30);
  assert.equal(percentile([], 0.95), null);
  assert.throws(() => parseArgs(['--repeats', '0']));
  assert.throws(() => parseArgs(['--mode', 'unknown']));
});

test('comparison excludes warmup, alternates order, and detects DTO changes', async () => {
  const calls = [];
  let mismatch = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/lab/dataset')) {
      response.end(JSON.stringify({ postCount: 1, commentCount: 0, attachmentCount: 0, config: null }));
      return;
    }
    const strategy = request.url.startsWith('/v1') ? 'v1' : 'v2';
    calls.push(strategy);
    response.end(JSON.stringify({ posts: [{ id: mismatch && strategy === 'v2' ? 2 : 1 }], metrics: { queryCount: strategy === 'v1' ? 1 : 3, totalRows: 1, fetchAndAssembleMs: 1, jdbcExecuteMs: 0.5, assemblyMs: 0.1, queries: [] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, ids: [1], warmup: 1, repeats: 2, mode: 'benchmark' };
    const report = await runComparison(options);
    assert.equal(report.error, null);
    assert.equal(report.samples.length, 4);
    assert.deepEqual(calls, ['v1', 'v2', 'v1', 'v2', 'v2', 'v1']);
    assert.equal(report.summaries.v1.httpMs.count, 2);
    mismatch = true;
    const invalid = await runComparison({ ...options, warmup: 0 });
    assert.equal(invalid.equalResults, false);
    assert.match(invalid.error, /DTO mismatch/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('HTTP failures and excessive declared response sizes remain failed reports', async () => {
  let oversized = false;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (oversized) {
      response.setHeader('Content-Length', String(33 * 1024 * 1024));
      response.end('{}');
    } else {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: 'Database is unavailable' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, ids: [1], warmup: 0, repeats: 1, mode: 'benchmark' };
    const failure = await runComparison(options);
    assert.match(failure.error, /HTTP 503.*Database is unavailable/);
    assert.equal(failure.samples.length, 0);
    assert.equal(failure.equalResults, null);
    oversized = true;
    const overflow = await runComparison(options);
    assert.match(overflow.error, /exceeded 32 MiB/);
    assert.equal(overflow.samples.length, 0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
