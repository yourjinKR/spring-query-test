import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export function parseIds(raw) {
  const parts = raw.split(',').map((value) => value.trim());
  if (!parts.length || parts.length > 100 || parts.some((value) => !/^[1-9]\d*$/.test(value))) {
    throw new Error('--ids must contain 1..100 positive integer IDs separated by commas');
  }
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id))) throw new Error('IDs must be safe integers');
  return [...new Set(ids)].sort((a, b) => a - b);
}

// Nearest-rank sample percentile. This reports the observed sample only; a small
// serial run does not estimate production tail latency or concurrent throughput.
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(samples) {
  const metric = (getter) => {
    const values = samples.map(getter);
    return {
      count: values.length,
      mean: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };
  };
  return {
    httpMs: metric((sample) => sample.httpMs),
    fetchAndAssembleMs: metric((sample) => sample.metrics.fetchAndAssembleMs),
    jdbcExecuteMs: metric((sample) => sample.metrics.jdbcExecuteMs),
    assemblyMs: metric((sample) => sample.metrics.assemblyMs),
    totalRows: metric((sample) => sample.metrics.totalRows),
    queryCount: metric((sample) => sample.metrics.queryCount),
  };
}

export function parseArgs(args) {
  const options = {
    baseUrl: 'http://localhost:8080', ids: parseIds('1,2,3,4,5,6,7,8,9,10'),
    warmup: 10, repeats: 30, mode: 'benchmark',
    output: `benchmarks/results/compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  };
  const names = { '--base-url': 'baseUrl', '--ids': 'ids', '--warmup': 'warmup', '--repeats': 'repeats', '--mode': 'mode', '--output': 'output' };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || args[index + 1] == null) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    const value = args[index + 1];
    options[name] = name === 'ids' ? parseIds(value) : ['warmup', 'repeats'].includes(name) ? Number(value) : value;
  }
  const url = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--base-url must use http or https');
  options.baseUrl = options.baseUrl.replace(/\/$/, '');
  if (!['analysis', 'benchmark'].includes(options.mode)) throw new Error('--mode must be analysis or benchmark');
  for (const [key, min, max] of [['warmup', 0, 1000], ['repeats', 1, 1000]]) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`--${key} must be ${min}..${max}`);
  }
  return options;
}

async function getJson(url) {
  const start = performance.now();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000), cache: 'no-store' });
  } catch (error) {
    throw new Error(`Request failed ${url}: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
  }
  const maxBodyBytes = 32 * 1024 * 1024;
  const declaredBytes = Number(response.headers.get('content-length'));
  if (declaredBytes > maxBodyBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeded 32 MiB ${url}; select fewer IDs or reduce the dataset`);
  }
  const chunks = [];
  let receivedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBodyBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded 32 MiB ${url}; select fewer IDs or reduce the dataset`);
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const httpMs = performance.now() - start;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 500)}`);
  return { body: JSON.parse(text), httpMs };
}

export async function runComparison(options) {
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    parameters: { baseUrl: options.baseUrl, ids: options.ids, warmupPairs: options.warmup, measuredPairs: options.repeats, mode: options.mode },
    measurement: 'Serial alternating pairs; HTTP time covers response body download, excludes JSON parsing. Warmup pairs are excluded. Percentiles use nearest rank.',
    datasetBefore: null, datasetAfter: null, equalResults: null, error: null,
    samples: [], summaries: {},
  };
  let expectedHash;
  const runPair = async (iteration, warmup) => {
    const order = iteration % 2 === 0 ? ['v1', 'v2'] : ['v2', 'v1'];
    for (const strategy of order) {
      const params = new URLSearchParams({ ids: options.ids.join(','), mode: options.mode });
      const { body, httpMs } = await getJson(`${options.baseUrl}/${strategy}/posts?${params}`);
      const expectedQueries = strategy === 'v1' ? 1 : 3;
      if (!Array.isArray(body.posts) || body.metrics?.queryCount !== expectedQueries) {
        throw new Error(`${strategy} violated response or SELECT count contract (expected ${expectedQueries})`);
      }
      for (const name of ['totalRows', 'fetchAndAssembleMs', 'jdbcExecuteMs', 'assemblyMs']) {
        if (!Number.isFinite(body.metrics[name]) || body.metrics[name] < 0) throw new Error(`${strategy} invalid metric: ${name}`);
      }
      const hash = createHash('sha256').update(JSON.stringify(body.posts)).digest('hex');
      if (expectedHash == null) {
        expectedHash = hash;
      } else if (hash !== expectedHash) {
        report.equalResults = false;
        throw new Error(`DTO mismatch at ${warmup ? 'warmup' : 'measured'} pair ${iteration + 1} (${strategy}); dataset may have changed`);
      } else {
        report.equalResults = true;
      }
      if (!warmup) {
        report.samples.push({ iteration: iteration + 1, order: order.indexOf(strategy) + 1, strategy, httpMs, postCount: body.posts.length, postsSha256: hash, metrics: body.metrics });
      }
    }
  };
  try {
    report.datasetBefore = (await getJson(`${options.baseUrl}/lab/dataset`)).body;
    for (let iteration = 0; iteration < options.warmup; iteration += 1) await runPair(iteration, true);
    for (let iteration = 0; iteration < options.repeats; iteration += 1) await runPair(iteration, false);
    report.datasetAfter = (await getJson(`${options.baseUrl}/lab/dataset`)).body;
    if (JSON.stringify(report.datasetBefore) !== JSON.stringify(report.datasetAfter)) throw new Error('Dataset metadata changed during comparison');
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.completedAt = new Date().toISOString();
  for (const strategy of ['v1', 'v2']) report.summaries[strategy] = summarize(report.samples.filter((sample) => sample.strategy === strategy));
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runComparison(options);
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: outputPath, equalResults: report.equalResults, error: report.error, summaries: report.summaries }, null, 2));
  if (options.repeats < 100) console.log('Few samples: reported p95 is descriptive only. Use k6 for concurrent load testing.');
  if (report.error) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
