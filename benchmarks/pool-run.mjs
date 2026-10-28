import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseIds } from './compare.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const gaugeNames = {
  hikaricp_connections: 'connections',
  hikaricp_connections_active: 'active',
  hikaricp_connections_idle: 'idle',
  hikaricp_connections_pending: 'pending',
  hikaricp_connections_max: 'max',
  hikaricp_connections_min: 'min',
};

function decodeLabel(value) {
  return value.replace(/\\([\\"n])/g, (_, escaped) => escaped === 'n' ? '\n' : escaped);
}

/** Parses only Hikari samples, preserving the complete label set for each pool. */
export function parsePoolMetrics(text) {
  const pools = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('hikaricp_')) continue;
    const sample = /^([a-zA-Z_:][\w:]*)(?:\{((?:[^"\\]|"(?:\\.|[^"\\])*"|\\.)*)\})?\s+([-+\w.]+)(?:\s+\d+)?(?:\s+#.*)?$/.exec(line);
    if (!sample) continue;
    const [, name, rawLabels = '', rawValue] = sample;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    for (const label of rawLabels.matchAll(/([a-zA-Z_]\w*)="((?:\\.|[^"\\])*)"/g)) {
      labels[label[1]] = decodeLabel(label[2]);
    }
    const boundary = labels.le;
    delete labels.le;
    const key = JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))));
    if (!pools.has(key)) pools.set(key, { key, labels, gauges: {}, acquire: { buckets: {} }, usage: { buckets: {} }, timeouts: null });
    const pool = pools.get(key);
    if (gaugeNames[name]) pool.gauges[gaugeNames[name]] = value;
    if (name === 'hikaricp_connections_timeout_total') pool.timeouts = value;
    const timer = /^hikaricp_connections_(acquire|usage)_seconds_(count|sum|bucket)$/.exec(name);
    if (timer) {
      const [, kind, part] = timer;
      if (part === 'bucket' && boundary != null) pool[kind].buckets[boundary] = value;
      else if (part === 'count') pool[kind].count = value;
      else if (part === 'sum') pool[kind].sumSeconds = value;
    }
  }
  return [...pools.values()].filter((pool) => Object.keys(pool.gauges).length || pool.acquire.count != null || pool.usage.count != null);
}

function counterDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return { value: null, missing: true, reset: false };
  if (after < before) return { value: null, missing: false, reset: true };
  return { value: after - before, missing: false, reset: false };
}

/** Linear interpolation inside finite cumulative buckets; overflow stays unknown. */
export function histogramQuantile(buckets, fraction, count) {
  if (!(count > 0)) return { value: null, overflow: false };
  const sorted = Object.entries(buckets).map(([le, cumulative]) => ({ upper: le === '+Inf' ? Infinity : Number(le), cumulative }))
    .filter(({ upper, cumulative }) => !Number.isNaN(upper) && Number.isFinite(cumulative))
    .sort((a, b) => a.upper - b.upper);
  let lower = 0;
  let previousCount = 0;
  const rank = count * fraction;
  for (const bucket of sorted) {
    if (bucket.cumulative < previousCount) return { value: null, overflow: false };
    if (bucket.cumulative >= rank) {
      if (!Number.isFinite(bucket.upper)) return { value: null, overflow: true };
      const width = bucket.cumulative - previousCount;
      return { value: width > 0 ? lower + (bucket.upper - lower) * (rank - previousCount) / width : bucket.upper, overflow: false };
    }
    lower = bucket.upper;
    previousCount = bucket.cumulative;
  }
  return { value: null, overflow: false };
}

function timerDifference(before, after) {
  const count = counterDelta(before?.count, after?.count);
  const sum = counterDelta(before?.sumSeconds, after?.sumSeconds);
  const buckets = {};
  let reset = count.reset || sum.reset;
  let bucketMissing = false;
  for (const boundary of new Set([...Object.keys(before?.buckets ?? {}), ...Object.keys(after?.buckets ?? {})])) {
    const delta = counterDelta(before?.buckets?.[boundary], after?.buckets?.[boundary]);
    reset ||= delta.reset;
    bucketMissing ||= delta.missing;
    if (delta.value != null) buckets[boundary] = delta.value;
  }
  const histogramAvailable = Object.keys(buckets).length > 0 && !bucketMissing && !reset;
  const p95 = histogramAvailable ? histogramQuantile(buckets, 0.95, count.value) : { value: null, overflow: false };
  return {
    count: reset ? null : count.value,
    totalSeconds: reset ? null : sum.value,
    meanMs: !reset && count.value > 0 && sum.value != null ? 1000 * sum.value / count.value : null,
    p95Ms: p95.value == null ? null : 1000 * p95.value,
    p95IsHistogramEstimate: true,
    p95Overflow: p95.overflow,
    histogramAvailable,
    cumulativeBucketDeltas: reset ? {} : buckets,
    counterReset: reset,
    missingCounters: count.missing || sum.missing,
  };
}

export function summarizePools(before, after, samples, completedRequests = null) {
  const first = new Map(before.map((pool) => [pool.key, pool]));
  const last = new Map(after.map((pool) => [pool.key, pool]));
  return [...new Set([...first.keys(), ...last.keys()])].map((key) => {
    const baseline = first.get(key);
    const final = last.get(key);
    const acquire = timerDifference(baseline?.acquire, final?.acquire);
    const usage = timerDifference(baseline?.usage, final?.usage);
    const timeouts = counterDelta(baseline?.timeouts, final?.timeouts);
    const relevant = samples.flatMap((sample) => sample.pools.filter((pool) => pool.key === key));
    const maximum = (field) => {
      const values = relevant.map((pool) => pool.gauges[field]).filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    };
    const missingMetrics = [];
    for (const field of ['max', 'active', 'pending']) {
      if (!Number.isFinite(baseline?.gauges[field]) || !Number.isFinite(final?.gauges[field])) missingMetrics.push(field);
    }
    if (acquire.missingCounters) missingMetrics.push('acquire count/sum');
    if (usage.missingCounters) missingMetrics.push('usage count/sum');
    if (timeouts.missing) missingMetrics.push('timeout counter');
    return {
      labels: final?.labels ?? baseline?.labels,
      configuredMaximum: final?.gauges.max ?? baseline?.gauges.max ?? null,
      acquire,
      usage,
      timeoutCount: timeouts.value,
      sampledMaxActive: maximum('active'),
      sampledMaxPending: maximum('pending'),
      sampledMaximumChanged: relevant.some((pool) => pool.gauges.max !== baseline?.gauges.max),
      acquisitionCountMinusCompletedRequests: acquire.count != null && completedRequests != null ? acquire.count - completedRequests : null,
      counterReset: acquire.counterReset || usage.counterReset || timeouts.reset,
      missingMetrics,
    };
  });
}

export function parseArgs(args) {
  const options = {
    strategy: 'v1', model: 'closed', vus: 20, rate: 100, preallocatedVus: 20, maxVus: 100,
    duration: '15s', warmup: 10, sampleMs: 500, ids: parseIds('1,2,3,4,5,6,7,8,9,10'),
    baseUrl: 'http://127.0.0.1:8080', dockerBaseUrl: 'http://server:8080', requestTimeout: '120s',
    output: `benchmarks/results/pool-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  };
  const flags = {
    '--strategy': 'strategy', '--model': 'model', '--vus': 'vus', '--rate': 'rate',
    '--preallocated-vus': 'preallocatedVus', '--max-vus': 'maxVus', '--duration': 'duration',
    '--warmup': 'warmup', '--sample-ms': 'sampleMs', '--ids': 'ids', '--base-url': 'baseUrl',
    '--docker-base-url': 'dockerBaseUrl', '--request-timeout': 'requestTimeout', '--output': 'output',
  };
  const numeric = ['vus', 'rate', 'preallocatedVus', 'maxVus', 'warmup', 'sampleMs'];
  for (let index = 0; index < args.length; index += 2) {
    const key = flags[args[index]];
    if (!key || args[index + 1] == null) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = key === 'ids' ? parseIds(args[index + 1]) : numeric.includes(key) ? Number(args[index + 1]) : args[index + 1];
  }
  if (!['v1', 'v2'].includes(options.strategy)) throw new Error('--strategy must be v1 or v2');
  if (!['closed', 'arrival'].includes(options.model)) throw new Error('--model must be closed or arrival');
  for (const [key, minimum, maximum] of [['vus', 1, 200], ['rate', 1, 5000], ['preallocatedVus', 1, 500], ['maxVus', 1, 500], ['warmup', 0, 1000], ['sampleMs', 100, 10_000]]) {
    if (!Number.isInteger(options[key]) || options[key] < minimum || options[key] > maximum) throw new Error(`${key} must be ${minimum}..${maximum}`);
  }
  if (options.preallocatedVus > options.maxVus) throw new Error('--preallocated-vus must not exceed --max-vus');
  for (const key of ['baseUrl', 'dockerBaseUrl']) {
    const url = new URL(options[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${key} must be an HTTP URL without credentials`);
    options[key] = options[key].replace(/\/$/, '');
  }
  for (const [key, maximum] of [['duration', 600_000], ['requestTimeout', 120_000]]) {
    const match = /^(\d+)(ms|s|m)$/.exec(options[key]);
    const milliseconds = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 })[match[2]] : 0;
    if (milliseconds < 1000 || milliseconds > maximum) throw new Error(`${key} must be a duration between 1s and ${maximum / 1000}s`);
    if (key === 'duration') options.durationMs = milliseconds;
  }
  return options;
}

async function fetchText(fetchImpl, url, signal, limit = 4 * 1024 * 1024) {
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), cache: 'no-store' });
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error(`Response exceeds ${limit} bytes: ${url}`);
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error(`Response exceeds ${limit} bytes: ${url}`);
      chunks.push(chunk);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 500)}`);
  return text;
}

export function dockerArguments(options, containerName = `querylab-load-${randomUUID()}`) {
  const environment = {
    BASE_URL: options.dockerBaseUrl, STRATEGY: options.strategy, LOAD_MODEL: options.model,
    IDS: options.ids.join(','), VUS: options.vus, RATE: options.rate,
    PREALLOCATED_VUS: options.preallocatedVus, MAX_VUS: options.maxVus,
    DURATION: options.duration, REQUEST_TIMEOUT: options.requestTimeout, WARMUP: 0,
  };
  return ['compose', 'run', '--rm', '--no-deps', '--name', containerName, '-T', ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]), 'k6', 'run', '--quiet', '/scripts/load.js'];
}

async function removeOwnContainer(containerName, spawnImpl, timeoutMs) {
  if (!/^querylab-load-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(containerName)) {
    throw new Error('Refusing to clean up an unrecognized load container name');
  }
  return new Promise((resolveCleanup) => {
    let child;
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCleanup({ ...result, stderr });
    };
    try {
      child = spawnImpl('docker', ['rm', '-f', containerName], { cwd: repositoryRoot, shell: false, windowsHide: true });
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384); });
      child.on('error', (error) => finish({ status: 'cleanup_failed', error: error.message }));
      child.on('close', (exitCode) => finish({
        status: exitCode === 0 ? 'removed' : /no such container/i.test(stderr) ? 'already_absent' : 'cleanup_failed', exitCode,
      }));
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ status: 'cleanup_timeout' });
      }, timeoutMs);
    } catch (error) {
      finish({ status: 'cleanup_failed', error: error.message });
    }
  });
}

function waitForClose(promise, milliseconds) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), milliseconds);
    promise.then(() => { clearTimeout(timer); resolveWait(true); });
  });
}

/** Removes only this run's uniquely named remote container, even if the Docker CLI fails. */
export async function runDocker(options, dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const signalSource = dependencies.signalSource ?? process;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 5000;
  const containerName = `querylab-load-${randomUUID()}`;
  let stdout = '';
  let stderr = '';
  let outputLimitExceeded = false;
  let stopReason = null;
  let spawnError = null;
  let closed = null;
  let child;
  let resolveClosed;
  let resolveStopped;
  const closedPromise = new Promise((resolveClose) => { resolveClosed = resolveClose; });
  const stoppedPromise = new Promise((resolveStop) => { resolveStopped = resolveStop; });
  const stop = (reason) => {
    if (stopReason != null) return;
    stopReason = reason;
    resolveStopped();
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  signalSource.on('SIGINT', onInterrupt);
  signalSource.on('SIGTERM', onTerminate);
  const timeout = setTimeout(() => stop('execution_timeout'), dependencies.executionTimeoutMs ?? options.durationMs + 180_000);
  let cleanupBefore = null;
  let cleanupAfter = null;
  let cliTerminated = false;
  try {
    try {
      child = spawnImpl('docker', dockerArguments(options, containerName), { cwd: repositoryRoot, shell: false, windowsHide: true });
      const append = (kind, chunk) => {
        if (outputLimitExceeded) return;
        const maximum = kind === 'stdout' ? (dependencies.maxStdoutBytes ?? 16 * 1024 * 1024) : (dependencies.maxStderrBytes ?? 2 * 1024 * 1024);
        if (Buffer.byteLength(kind === 'stdout' ? stdout : stderr) + chunk.length > maximum) {
          outputLimitExceeded = true;
          stop('output_limit');
          return;
        }
        if (kind === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      child.on('error', (error) => { spawnError = error.message; stop('spawn_error'); });
      child.on('close', (exitCode, signal) => { closed = { exitCode, signal }; resolveClosed(); });
    } catch (error) {
      spawnError = error.message;
      stop('spawn_error');
    }
    await Promise.race([closedPromise, stoppedPromise]);
    clearTimeout(timeout);
    if (stopReason != null) {
      // Remove the remote workload first: terminating the attached CLI alone is insufficient.
      cleanupBefore = await removeOwnContainer(containerName, spawnImpl, cleanupTimeoutMs);
      if (!closed && child) {
        try { child.kill(); } catch {}
      }
      cliTerminated = closed != null || !child || await waitForClose(closedPromise, dependencies.stopGraceMs ?? 2000);
    } else {
      cliTerminated = true;
    }
  } finally {
    clearTimeout(timeout);
    // Repeat after CLI shutdown to catch a create-vs-cancel race; --rm's normal 404 is harmless.
    cleanupAfter = await removeOwnContainer(containerName, spawnImpl, cleanupTimeoutMs);
    signalSource.removeListener('SIGINT', onInterrupt);
    signalSource.removeListener('SIGTERM', onTerminate);
  }
  return {
    exitCode: closed?.exitCode ?? null, signal: closed?.signal ?? null, stdout, stderr,
    outputLimitExceeded, stopReason, spawnError, containerName, cliTerminated,
    cleanup: { before: cleanupBefore, after: cleanupAfter },
  };
}

export function parseK6Summary(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('k6 did not return a JSON summary');
  const summary = JSON.parse(stdout.slice(start, end + 1));
  if (!summary.results?.metrics) throw new Error('k6 JSON summary has no results.metrics');
  return summary;
}

export async function runPoolExperiment(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const runner = dependencies.runner ?? runDocker;
  const started = Date.now();
  const report = {
    schemaVersion: 1, startedAt: new Date(started).toISOString(), completedAt: null,
    status: 'error', error: null, warnings: [], parameters: options,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    notes: [
      'One strategy per isolated run. This tool never changes the dataset or restarts the server.',
      'baseUrl is the host metrics/API address; dockerBaseUrl is the k6 container address. Both must resolve to the same application. Address mapping is supplied by the operator, not inferred by this tool.',
      'Warmup HTTP calls finish before the pool counter baseline; k6 runs with WARMUP=0.',
      'Pool counters span Docker startup through k6 completion and final scrape; this window differs from the k6 measured scenario window.',
      'Acquire time covers connection acquisition attempts, including immediate borrows and timed-out attempts; it is not pure queue wait. Usage is connection occupancy, not SQL time.',
      'Gauge maxima are sampled observations, not exact peaks. Hikari gauge values can be cached and subinterval spikes can be missed.',
      'Pool metrics have no API-route attribution; other application borrowers or timeout/window boundaries can affect counter comparisons.',
      'Server fetchAndAssembleMs starts inside the transactional service and does not measure the earlier pool acquisition wait.',
    ],
    datasetBefore: null, datasetAfter: null, datasetUnchanged: null,
    poolWindow: null, before: [], after: [], samples: [], pollErrors: [], pollErrorCount: 0, pools: [], k6: null, runner: null,
  };
  const json = async (path) => JSON.parse(await fetchText(fetchImpl, `${options.baseUrl}${path}`));
  const snapshot = async (signal) => parsePoolMetrics(await fetchText(fetchImpl, `${options.baseUrl}/actuator/prometheus`, signal));
  const saveSample = (pools) => report.samples.push({ elapsedMs: Date.now() - started, at: new Date().toISOString(), pools: pools.map(({ key, labels, gauges }) => ({ key, labels, gauges })) });
  try {
    report.datasetBefore = await json('/lab/dataset');
    for (let index = 0; index < options.warmup; index++) {
      const body = JSON.parse(await fetchText(fetchImpl, `${options.baseUrl}/${options.strategy}/posts?ids=${options.ids.join(',')}&mode=benchmark`, undefined, 32 * 1024 * 1024));
      if (!Array.isArray(body.posts) || body.metrics?.queryCount !== (options.strategy === 'v1' ? 1 : 3)) throw new Error('Warmup violated the response or query-count contract');
    }
    report.before = await snapshot();
    if (!report.before.length) throw new Error('No Hikari pool metrics found; verify Actuator/Micrometer before running load');
    report.poolWindow = { startedAt: new Date().toISOString(), endedAt: null };
    saveSample(report.before);
    const sampling = new AbortController();
    const sampler = (async () => {
      while (!sampling.signal.aborted) {
        try {
          await delay(options.sampleMs, undefined, { signal: sampling.signal });
          saveSample(await snapshot(sampling.signal));
        } catch (error) {
          if (sampling.signal.aborted) break;
          report.pollErrorCount++;
          if (report.pollErrors.length < 50) report.pollErrors.push({ at: new Date().toISOString(), message: error.message });
        }
      }
    })();
    let result;
    try {
      result = await runner(options);
    } finally {
      sampling.abort();
      await sampler;
    }
    report.runner = { exitCode: result.exitCode, signal: result.signal, stderr: result.stderr,
      outputLimitExceeded: result.outputLimitExceeded, stopReason: result.stopReason,
      spawnError: result.spawnError, containerName: result.containerName,
      cliTerminated: result.cliTerminated, cleanup: result.cleanup };
    report.after = await snapshot();
    report.poolWindow.endedAt = new Date().toISOString();
    saveSample(report.after);
    try {
      report.k6 = parseK6Summary(result.stdout);
    } catch (error) {
      report.rawStdout = result.stdout;
      throw error;
    }
    const completedRequests = report.k6.measurements?.completedRequests
      ?? report.k6.results.metrics.measured_requests?.values?.count ?? null;
    report.pools = summarizePools(report.before, report.after, report.samples, completedRequests);
    // This endpoint borrows from the pool, so it must follow the final pool scrape.
    report.datasetAfter = await json('/lab/dataset');
    report.datasetUnchanged = JSON.stringify(report.datasetBefore) === JSON.stringify(report.datasetAfter);
    for (const pool of report.pools) {
      if (pool.counterReset) report.warnings.push('Pool counters reset during the run; do not interpret deltas');
      if (pool.missingMetrics.length) report.warnings.push(`Missing pool metrics: ${pool.missingMetrics.join(', ')}`);
      if (!pool.acquire.histogramAvailable || !pool.usage.histogramAvailable) report.warnings.push('Pool histograms unavailable; mean values may exist but p95 is unknown');
      if (pool.sampledMaximumChanged) report.warnings.push('Observed pool maximum changed during the run');
      if (pool.acquisitionCountMinusCompletedRequests !== 0 && pool.acquisitionCountMinusCompletedRequests != null) report.warnings.push('Pool acquire count differs from completed requests; inspect other borrowers, failures and window boundaries');
    }
    const invalid = !report.datasetUnchanged || report.pollErrorCount > 0 || report.pools.some((pool) => pool.counterReset || pool.missingMetrics.length || pool.sampledMaximumChanged);
    if (!report.datasetUnchanged) report.warnings.push('Dataset metadata changed during load');
    const cleanupFailed = result.cleanup?.after && !['removed', 'already_absent'].includes(result.cleanup.after.status);
    if (cleanupFailed || result.cliTerminated === false) report.warnings.push('Could not confirm workload cleanup; stop before running another experiment');
    report.status = result.exitCode !== 0 || result.outputLimitExceeded || result.stopReason || cleanupFailed || result.cliTerminated === false
      ? 'load_failed' : invalid ? 'measurement_invalid' : 'completed';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.completedAt = new Date().toISOString();
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPoolExperiment(options);
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const poolSummary = report.pools.map((pool) => ({
    labels: pool.labels,
    configuredMaximum: pool.configuredMaximum,
    acquisitionCount: pool.acquire.count,
    acquireMeanMs: pool.acquire.meanMs,
    acquireP95Ms: pool.acquire.p95Ms,
    usageMeanMs: pool.usage.meanMs,
    usageP95Ms: pool.usage.p95Ms,
    timeoutCount: pool.timeoutCount,
    sampledMaxActive: pool.sampledMaxActive,
    sampledMaxPending: pool.sampledMaxPending,
    acquisitionCountMinusCompletedRequests: pool.acquisitionCountMinusCompletedRequests,
  }));
  console.log(JSON.stringify({ output, status: report.status, error: report.error,
    warnings: report.warnings, measurements: report.k6?.measurements, pools: poolSummary }, null, 2));
  if (report.runner?.stopReason === 'SIGINT') process.exitCode = 130;
  else if (report.runner?.stopReason === 'SIGTERM') process.exitCode = 143;
  else if (report.status !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
