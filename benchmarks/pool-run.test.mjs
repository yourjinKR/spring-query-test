import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerArguments, histogramQuantile, parseArgs, parseK6Summary, parsePoolMetrics, runDocker, runPoolExperiment, summarizePools } from './pool-run.mjs';

function fixture({ count = 10, sum = 0.05, pending = 0, active = 1, max = 5, labels = 'pool="query-lab"' } = {}) {
  return `# HELP hikaricp_connections_max Maximum connections
hikaricp_connections_max{${labels}} ${max}
hikaricp_connections_active{${labels}} ${active}
hikaricp_connections_pending{${labels}} ${pending}
hikaricp_connections_idle{${labels}} ${max - active}
hikaricp_connections_timeout_total{${labels}} 0
hikaricp_connections_acquire_seconds_count{${labels}} ${count}
hikaricp_connections_acquire_seconds_sum{${labels}} ${sum}
hikaricp_connections_acquire_seconds_bucket{${labels},le="0.01"} ${count - 1}
hikaricp_connections_acquire_seconds_bucket{le="0.1",${labels}} ${count}
hikaricp_connections_acquire_seconds_bucket{${labels},le="+Inf"} ${count}
hikaricp_connections_usage_seconds_count{${labels}} ${count}
hikaricp_connections_usage_seconds_sum{${labels}} ${sum * 2}
hikaricp_connections_usage_seconds_bucket{${labels},le="0.1"} ${count}
hikaricp_connections_usage_seconds_bucket{${labels},le="+Inf"} ${count}
unrelated_counter_total 999
`;
}

test('optional cardinality row invariants pass to k6 and default runs stay opt-in', () => {
  const options = parseArgs(['--strategy', 'v2', '--expected-rows', '10', '--expected-query-rows', '10,0,0']);
  assert.deepEqual(options.expectedQueryRows, [10, 0, 0]);
  const args = dockerArguments(options);
  assert.ok(args.includes('EXPECTED_ROWS=10'));
  assert.ok(args.includes('EXPECTED_QUERY_ROWS=10,0,0'));
  assert.equal(dockerArguments(parseArgs([])).some((arg) => arg.startsWith('EXPECTED_')), false);
  assert.throws(() => parseArgs(['--strategy', 'v2', '--expected-rows', '10', '--expected-query-rows', '10,1,0']), /sum/);
});

test('Prometheus parsing preserves escaped labels and matches pools independently of label order', () => {
  const labels = String.raw`application="lab",pool="query\\lab\"x\nline"`;
  const pools = parsePoolMetrics(fixture({ labels }));
  assert.equal(pools.length, 1);
  assert.equal(pools[0].labels.pool, 'query\\lab"x\nline');
  assert.equal(pools[0].labels.application, 'lab');
  assert.equal(pools[0].gauges.max, 5);
  assert.equal(pools[0].acquire.buckets['+Inf'], 10);
  assert.equal(pools[0].usage.count, 10);
});

test('cumulative bucket estimates are approximate and overflow is not reported as a finite p95', () => {
  const normal = histogramQuantile({ '0.01': 8, '0.1': 10, '+Inf': 10 }, 0.95, 10);
  assert.ok(Math.abs(normal.value - 0.0775) < 0.000001);
  assert.equal(normal.overflow, false);
  assert.deepEqual(histogramQuantile({ '0.1': 1, '+Inf': 10 }, 0.95, 10), { value: null, overflow: true });
  assert.equal(histogramQuantile({}, 0.95, 0).value, null);
});

test('pool deltas exclude baseline samples, retain sampled pending maxima, and reject counter resets', () => {
  const before = parsePoolMetrics(fixture());
  const middle = parsePoolMetrics(fixture({ count: 12, sum: 0.06, pending: 3, active: 5 }));
  const after = parsePoolMetrics(fixture({ count: 14, sum: 0.07 }));
  const result = summarizePools(before, after, [{ pools: before }, { pools: middle }, { pools: after }], 4)[0];
  assert.equal(result.acquire.count, 4);
  assert.ok(Math.abs(result.acquire.meanMs - 5) < 0.000001);
  assert.ok(Math.abs(result.usage.meanMs - 10) < 0.000001);
  assert.equal(result.sampledMaxPending, 3);
  assert.equal(result.sampledMaxActive, 5);
  assert.equal(result.acquisitionCountMinusCompletedRequests, 0);
  assert.deepEqual(result.missingMetrics, []);
  const reset = summarizePools(after, before, [], 4)[0];
  assert.equal(reset.counterReset, true);
  assert.equal(reset.acquire.count, null);
  assert.equal(reset.acquire.meanMs, null);
  const missing = summarizePools([], after, [], 4)[0];
  assert.ok(missing.missingMetrics.includes('acquire count/sum'));
});

test('CLI validates bounded inputs and Docker arguments force measured-only k6 without shell composition', () => {
  const options = parseArgs(['--strategy', 'v2', '--model', 'arrival', '--rate', '50', '--ids', '3,1,3', '--warmup', '2']);
  assert.deepEqual(options.ids, [1, 3]);
  const args = dockerArguments(options);
  assert.ok(args.includes('LOAD_MODEL=arrival'));
  assert.ok(args.includes('RATE=50'));
  assert.ok(args.includes('WARMUP=0'));
  assert.equal(args.at(-1), '/scripts/load.js');
  assert.ok(args.includes('--no-deps'));
  assert.match(args[args.indexOf('--name') + 1], /^querylab-load-[0-9a-f-]{36}$/);
  for (const invalid of [
    ['--model', 'unknown'], ['--vus', '0'], ['--rate', '5001'],
    ['--preallocated-vus', '200', '--max-vus', '100'], ['--duration', '0s'],
    ['--duration', '11m'], ['--base-url', 'http://user:password@localhost'], ['--unknown', '1'],
  ]) assert.throws(() => parseArgs(invalid));
  assert.equal(parseK6Summary(`progress\n${JSON.stringify({ results: { metrics: {} } })}\n`).results.metrics != null, true);
});

async function mockRun({ changedDataset = false, exitCode = 0, pollingFailure = false } = {}) {
  const calls = [];
  let ended = false;
  let running = false;
  let datasetCalls = 0;
  const options = { ...parseArgs(['--warmup', '2']), sampleMs: 5 };
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/lab/dataset') {
      datasetCalls++;
      return new Response(JSON.stringify({ postCount: changedDataset && datasetCalls > 1 ? 2 : 1, config: null }), { status: 200 });
    }
    if (path.endsWith('/posts')) return new Response(JSON.stringify({ posts: [], metrics: { queryCount: 1 } }), { status: 200 });
    if (path === '/actuator/prometheus') {
      if (pollingFailure && running) throw new Error('Scrape disconnected');
      return new Response(fixture({ count: ended ? 14 : running ? 12 : 10, sum: ended ? 0.07 : 0.05, pending: running ? 2 : 0 }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const runner = async () => {
    calls.push('runner');
    running = true;
    await delay(25);
    running = false;
    ended = true;
    return {
      exitCode, signal: null, stderr: '', outputLimitExceeded: false,
      stdout: JSON.stringify({ measurements: { completedRequests: 4, droppedIterations: 0 }, results: { metrics: {} } }),
    };
  };
  return { report: await runPoolExperiment(options, { fetchImpl, runner }), calls };
}

test('wrapper excludes its warmup and status borrows from deltas, samples during load, and leaves dataset untouched', async () => {
  const { report, calls } = await mockRun();
  assert.equal(report.status, 'completed');
  assert.equal(report.datasetUnchanged, true);
  assert.equal(report.pools[0].acquire.count, 4);
  assert.equal(report.pools[0].sampledMaxPending, 2);
  assert.equal(report.pools[0].configuredMaximum, 5);
  assert.deepEqual(calls.slice(0, 5), ['/lab/dataset', '/v1/posts', '/v1/posts', '/actuator/prometheus', 'runner']);
  assert.deepEqual(calls.slice(-2), ['/actuator/prometheus', '/lab/dataset']);
  assert.ok(report.samples.length > 2);
  assert.equal(report.error, null);
});

test('threshold failure persists the k6 report, while changed data or failed scrapes invalidate measurements', async () => {
  const failed = (await mockRun({ exitCode: 99 })).report;
  assert.equal(failed.status, 'load_failed');
  assert.equal(failed.k6.measurements.completedRequests, 4);
  assert.equal(failed.runner.exitCode, 99);
  const changed = (await mockRun({ changedDataset: true })).report;
  assert.equal(changed.status, 'measurement_invalid');
  assert.equal(changed.datasetUnchanged, false);
  const disconnected = (await mockRun({ pollingFailure: true })).report;
  assert.equal(disconnected.status, 'measurement_invalid');
  assert.ok(disconnected.pollErrorCount > 0);
});

function fakeDocker({ mode = 'normal', signalSource = new EventEmitter(), cleanupHangs = false } = {}) {
  const calls = [];
  let cleanups = 0;
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'docker');
    assert.equal(options.shell, false);
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', 137, 'SIGTERM')); return true; };
    queueMicrotask(() => {
      if (args[0] === 'rm') {
        assert.deepEqual(args.slice(0, 2), ['rm', '-f']);
        assert.equal(args.length, 3);
        assert.match(args[2], /^querylab-load-[0-9a-f-]{36}$/);
        cleanups++;
        if (cleanupHangs) return;
        if (cleanups > 1 || mode === 'normal') child.stderr.emit('data', Buffer.from(`Error: No such container: ${args[2]}`));
        child.emit('close', cleanups > 1 || mode === 'normal' ? 1 : 0, null);
      } else if (mode === 'normal') {
        child.stdout.emit('data', Buffer.from('{"results":{"metrics":{}}}'));
        child.emit('close', 0, null);
      } else if (mode === 'output') {
        child.stdout.emit('data', Buffer.from('excessive-output'));
      } else if (mode === 'spawn-error') {
        child.emit('error', new Error('Docker unavailable'));
        child.emit('close', -2, null);
      } else if (mode === 'signal') {
        signalSource.emit('SIGTERM');
      }
    });
    return child;
  };
  return { calls, signalSource, spawnImpl };
}

test('each normal run names its own container and awaits exact-name cleanup; --rm absence is harmless', async () => {
  const fake = fakeDocker();
  const result = await runDocker(parseArgs([]), { ...fake, cleanupTimeoutMs: 50 });
  const loadName = fake.calls[0][fake.calls[0].indexOf('--name') + 1];
  assert.equal(result.containerName, loadName);
  assert.deepEqual(fake.calls[1], ['rm', '-f', loadName]);
  assert.equal(result.cleanup.after.status, 'already_absent');
  assert.equal(result.exitCode, 0);
  assert.equal(fake.signalSource.listenerCount('SIGTERM'), 0);
});

test('timeout, output cap, spawn failure and termination signal clean up before and after CLI shutdown', async () => {
  for (const [mode, reason] of [['timeout', 'execution_timeout'], ['output', 'output_limit'], ['spawn-error', 'spawn_error'], ['signal', 'SIGTERM']]) {
    const fake = fakeDocker({ mode });
    const result = await runDocker(parseArgs([]), {
      ...fake, cleanupTimeoutMs: 50, stopGraceMs: 50, executionTimeoutMs: 10, maxStdoutBytes: 4,
    });
    assert.equal(result.stopReason, reason);
    assert.equal(result.cliTerminated, true);
    assert.deepEqual(fake.calls.filter((args) => args[0] === 'rm'), [
      ['rm', '-f', result.containerName], ['rm', '-f', result.containerName],
    ]);
    assert.equal(result.cleanup.before.status, 'removed');
    assert.equal(result.cleanup.after.status, 'already_absent');
    assert.equal(fake.signalSource.listenerCount('SIGINT'), 0);
    assert.equal(fake.signalSource.listenerCount('SIGTERM'), 0);
  }
});

test('cleanup itself is bounded and an unconfirmed removal is reported instead of hanging', async () => {
  const fake = fakeDocker({ cleanupHangs: true });
  const result = await runDocker(parseArgs([]), { ...fake, cleanupTimeoutMs: 10 });
  assert.equal(result.cleanup.after.status, 'cleanup_timeout');
  assert.equal(result.exitCode, 0);
});
