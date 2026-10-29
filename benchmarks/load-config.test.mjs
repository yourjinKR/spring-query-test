import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeasuredScenario, matchesExpectedRows, parseLoadConfig, summarizeMeasuredLoad } from './lib/load-config.mjs';

test('defaults preserve closed-loop execution and configurable zero warmup', () => {
  const config = parseLoadConfig({ WARMUP: '0' });
  assert.equal(config.warmup, 0);
  assert.equal(config.loadModel, 'closed');
  assert.deepEqual(buildMeasuredScenario(config), {
    executor: 'constant-vus', vus: 5, duration: '30s', gracefulStop: '120s',
  });
  assert.equal(config.rate, null);
});

test('arrival model has an independent per-second rate and bounded VU allocation', () => {
  const config = parseLoadConfig({
    LOAD_MODEL: 'arrival', RATE: '120', PREALLOCATED_VUS: '8', MAX_VUS: '32',
    DURATION: '1.5m', REQUEST_TIMEOUT: '5s', VUS: '999',
  });
  assert.deepEqual(buildMeasuredScenario(config), {
    executor: 'constant-arrival-rate', rate: 120, timeUnit: '1s',
    preAllocatedVUs: 8, maxVUs: 32, duration: '1.5m', gracefulStop: '5s',
  });
  assert.equal(config.durationMs, 90_000);
  assert.equal(config.vus, null);
});

test('ID sets are safe, deduplicated, sorted and bounded before generating a URL', () => {
  const config = parseLoadConfig({ IDS: '3, 1,3,2', BASE_URL: 'http://127.0.0.1:8080/' });
  assert.deepEqual(config.ids, [1, 2, 3]);
  assert.equal(config.baseUrl, 'http://127.0.0.1:8080');
  for (const IDS of ['0', '-1', '1,', '1.5', '9007199254740992', '1,'.repeat(100) + '1']) {
    assert.throws(() => parseLoadConfig({ IDS }), /IDS/);
  }
});

test('invalid models, capacities, rates and time limits fail during initialization', () => {
  for (const environment of [
    { LOAD_MODEL: 'open' }, { STRATEGY: 'v3' }, { VUS: '0' }, { VUS: '201' },
    { WARMUP: '-1' }, { DURATION: '0s' }, { DURATION: '11m' }, { DURATION: 'forever' },
    { REQUEST_TIMEOUT: '121s' }, { REQUEST_TIMEOUT: '0ms' }, { BASE_URL: 'file:///tmp/api' },
    { LOAD_MODEL: 'arrival', RATE: '0' }, { LOAD_MODEL: 'arrival', RATE: '5001' },
    { LOAD_MODEL: 'arrival', RATE: '1.5' }, { LOAD_MODEL: 'arrival', PREALLOCATED_VUS: '101', MAX_VUS: '100' },
    { LOAD_MODEL: 'arrival', MAX_VUS: '501' },
  ]) assert.throws(() => parseLoadConfig(environment));
});

test('throughput excludes setup, includes returned failures/drain, and exposes incomplete attempts', () => {
  const summary = summarizeMeasuredLoad({
    measured_started_requests: { values: { count: 102 } },
    measured_requests: { values: { count: 100, rate: 2 } },
    measured_successes: { values: { count: 90 } },
    measured_http_errors: { values: { rate: 0.1 } },
    contract_errors: { values: { rate: 0.1 } },
    measured_elapsed_ms: { values: { max: 10_000 } },
    dropped_iterations: { values: { count: 12 } },
  });
  assert.equal(summary.completedRequestsPerSecond, 10);
  assert.equal(summary.successfulRequestsPerSecond, 9);
  assert.equal(summary.httpErrorRate, 0.1);
  assert.equal(summary.incompleteRequests, 2);
  assert.equal(summary.droppedIterations, 12);
});

test('no completed requests yields no invented latency/rate or error-rate observation', () => {
  const summary = summarizeMeasuredLoad({ measured_started_requests: { values: { count: 3 } } });
  assert.equal(summary.completedRequests, 0);
  assert.equal(summary.incompleteRequests, 3);
  assert.equal(summary.completedRequestsPerSecond, null);
  assert.equal(summary.successfulRequestsPerSecond, null);
  assert.equal(summary.measuredElapsedMs, null);
  assert.equal(summary.httpErrorRate, null);
});

test('cardinality invariants include empty child queries and reject inconsistent rows', () => {
  const config = parseLoadConfig({ STRATEGY: 'v2', EXPECTED_ROWS: '10', EXPECTED_QUERY_ROWS: '10,0,0' });
  const metrics = { totalRows: 10, queries: [{ rows: 10 }, { rows: 0 }, { rows: 0 }] };
  assert.ok(matchesExpectedRows(metrics, config));
  assert.equal(matchesExpectedRows({ ...metrics, totalRows: 11 }, config), false);
  assert.equal(matchesExpectedRows({ ...metrics, queries: [{ rows: 9 }, { rows: 1 }, { rows: 0 }] }, config), false);
  assert.equal(matchesExpectedRows({ totalRows: 10 }, config), false);
  assert.ok(matchesExpectedRows(undefined, parseLoadConfig({})));
  for (const environment of [
    { EXPECTED_ROWS: '-1' }, { EXPECTED_ROWS: '250001' },
    { EXPECTED_QUERY_ROWS: '10' },
    { STRATEGY: 'v2', EXPECTED_ROWS: '10', EXPECTED_QUERY_ROWS: '10,0' },
    { STRATEGY: 'v2', EXPECTED_ROWS: '10', EXPECTED_QUERY_ROWS: '10,1,0' },
    { EXPECTED_ROWS: '10', EXPECTED_QUERY_ROWS: 'NaN' },
  ]) assert.throws(() => parseLoadConfig(environment), /EXPECTED/);
});
