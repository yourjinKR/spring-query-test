import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeLatency, loadLatency, toCsv, toMarkdown, toSvg } from './analyze-latency.mjs';

const dataset = { postCount: 200, config: { commentsPerPost: 20, attachmentsPerPost: 5, seed: 42 } };
const validation = { datasetMatchesBaseline: true, poolMatchesExpected: true, cleanupConfirmed: true, measurementValid: true, proxyMatchesExpected: true };
const proxy = (rttMs) => ({ name: 'querylab-postgres', listen: '[::]:8666', upstream: 'db:5432', enabled: true,
  toxics: [['upstream', Math.floor(rttMs / 2)], ['downstream', Math.ceil(rttMs / 2)]].filter(([, delay]) => delay > 0)
    .map(([stream, latencyMs]) => ({ name: `querylab-rtt-${stream}`, stream, latencyMs, type: 'latency', jitterMs: 0, toxicity: 1 })) });

function fixture(specifications, expectedRepeats = 1) {
  const reports = new Map();
  const points = specifications.map((specification, index) => {
    const { strategy = 'v1', poolSize = 10, repeat = 1, phase = 'measure', stage = 'sweep', route = 'proxy',
      rttMs = 0, vus = 1, model = 'closed', rate = model === 'arrival' ? 10 : null,
      order = strategy === 'v1' ? 1 : 2, p50 = 5, p95 = p50 * 1.2, p99 = p95 * 1.2,
      completed = 1000, rps = 100, status = 'completed', dropped = 0, exitCode = status === 'completed' ? 0 : 99,
      pointValidation = validation } = specification;
    const path = `run-${index}.json`;
    reports.set(path, {
      status, error: null, datasetUnchanged: true, datasetBefore: dataset, datasetAfter: dataset, pollErrorCount: 0,
      parameters: { strategy, model, vus, rate, durationMs: 30_000, ids: [1, 2, 3], requestTimeout: '10s',
        baseUrl: 'http://localhost:8080', dockerBaseUrl: 'http://server:8080' },
      pools: [{ configuredMaximum: poolSize, counterReset: false, missingMetrics: [], sampledMaximumChanged: false,
        acquisitionCountMinusCompletedRequests: 0, acquire: { meanMs: 0.001, p95Ms: 0.01 }, usage: { meanMs: p50 - 0.1, p95Ms: p95 },
        sampledMaxPending: 0, timeoutCount: 0 }],
      runner: { exitCode, cliTerminated: true, cleanup: { after: { status: 'removed' } }, stopReason: null },
      k6: { metadata: { durationMs: 30_000, requestTimeoutMs: 10_000 },
      measurements: { startedRequests: completed, completedRequests: completed, successfulRequests: completed, measuredElapsedMs: 30_000,
        incompleteRequests: 0, droppedIterations: dropped, httpErrorRate: 0, contractErrorRate: 0,
        completedRequestsPerSecond: rps, successfulRequestsPerSecond: rps },
      results: { metrics: { measured_http_ms: { values: { med: p50, 'p(95)': p95, 'p(99)': p99 } } } } },
    });
    return { sequence: index + 1, phase, stage, route, rttMs, poolSize, repeat, model,
      vus: model === 'closed' ? vus : null, rate, strategy, order, report: path, status, exitCode,
      validation: pointValidation, proxyBefore: proxy(rttMs), proxyAfter: proxy(rttMs) };
  });
  return { campaign: { schemaVersion: 1, experiment: 'latency', status: 'completed', completedAt: '2026-10-29T00:00:00Z',
    datasetBaseline: dataset, parameters: { repeats: expectedRepeats, totalMeasuredRuns: points.filter((point) => point.phase === 'measure').length }, points }, reports };
}

test('groups distinguish RTT, route and stage; warmups do not enter measured comparisons', () => {
  const { campaign, reports } = fixture([
    { phase: 'warmup', p50: 999 },
    { strategy: 'v1', rttMs: 0 }, { strategy: 'v2', rttMs: 0, p50: 3 },
    { strategy: 'v1', rttMs: 1 }, { strategy: 'v2', rttMs: 1, p50: 6 },
    { strategy: 'v1', route: 'direct', stage: 'baseline' }, { strategy: 'v2', route: 'direct', stage: 'baseline' },
    { strategy: 'v1', stage: 'refine', rttMs: 1 }, { strategy: 'v2', stage: 'refine', rttMs: 1 },
  ]);
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.coverage.excludedWarmupPoints, 1);
  assert.equal(result.coverage.measuredRuns, 8);
  assert.equal(result.groups.length, 4);
  assert.ok(result.groups.every((group) => group.cleanPairs === 1));
  assert.equal(result.groups.find((group) => group.stage === 'sweep' && group.rttMs === 0).pairedRunMetrics.v2.httpP50Ms.median, 3);
});

test('matched pairs alone determine headline medians, not unequal clean strategy counts or request weights', () => {
  const { campaign, reports } = fixture([
    { repeat: 1, strategy: 'v1', p50: 1000, completed: 100000 },
    { repeat: 1, strategy: 'v2', p50: 1, status: 'load_failed', dropped: 10 },
    { repeat: 2, strategy: 'v1', p50: 20, completed: 10 },
    { repeat: 2, strategy: 'v2', p50: 10, completed: 10 },
    { repeat: 3, strategy: 'v1', p50: 10 }, { repeat: 3, strategy: 'v2', p50: 8 },
  ], 3);
  const result = analyzeLatency(campaign, reports);
  const group = result.groups[0];
  assert.equal(group.cleanPairs, 2);
  assert.equal(group.strategies.v1.cleanRuns, 3);
  assert.equal(group.pairedRunMetrics.v1.httpP50Ms.median, 15);
  assert.equal(group.pairMetrics.httpP50Ms.v2MinusV1.median, -6);
  assert.equal(group.strategies.v2.dropped, 10);
  assert.equal(result.runs.length, 6);
  assert.match(toCsv(result), /load_failed/);
  assert.match(toMarkdown(result), /실패·계측 무효 실행\(삭제하지 않음\)/);
});

test('missing, duplicate and planned-but-unrecorded pair members are disclosed', () => {
  const { campaign, reports } = fixture([
    { repeat: 1, strategy: 'v1' },
    { repeat: 2, strategy: 'v1' }, { repeat: 2, strategy: 'v1' }, { repeat: 2, strategy: 'v2' },
  ], 3);
  const group = analyzeLatency(campaign, reports).groups[0];
  assert.equal(group.recordedPairs, 3);
  assert.equal(group.cleanPairs, 0);
  assert.match(group.pairs[0].issues.join(), /v2 has 0/);
  assert.match(group.pairs[1].issues.join(), /v1 has 2/);
  assert.match(group.pairs[2].issues.join(), /v1 has 0/);
});

test('missing reports, changed data, wrong settings, unverified route and failed validation are invalid', () => {
  const { campaign, reports } = fixture([
    { rttMs: -1 }, { strategy: 'v2', pointValidation: { ...validation, cleanupConfirmed: false } },
    { repeat: 2 }, { repeat: 2, strategy: 'v2' },
  ], 2);
  reports.get('run-0.json').datasetAfter = {};
  reports.get('run-1.json').parameters.strategy = 'v1';
  reports.delete('run-2.json');
  campaign.points[3].route = 'unknown';
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.coverage.measurementValidRuns, 0);
  assert.match(result.runs[0].measurementIssues.join(), /nonnegative integer/);
  assert.match(result.runs[0].measurementIssues.join(), /baseline/);
  assert.match(result.runs[1].measurementIssues.join(), /cleanupConfirmed/);
  assert.match(result.runs[1].measurementIssues.join(), /parameter strategy/);
  assert.match(result.runs[2].measurementIssues.join(), /missing/);
  assert.match(result.runs[3].measurementIssues.join(), /route/);
});

test('nonzero exits and missing HTTP median cannot become clean runs', () => {
  const { campaign, reports } = fixture([{ strategy: 'v1', exitCode: 1 }, { strategy: 'v2' }]);
  delete reports.get('run-1.json').k6.results.metrics.measured_http_ms.values.med;
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.coverage.cleanRuns, 0);
  assert.match(result.runs[0].loadFailures.join(), /exit code/);
  assert.match(result.runs[1].loadFailures.join(), /metrics are missing/);
  assert.equal(result.groups[0].pairedRunMetrics.v1.httpP50Ms.median, null);
});

test('clock-gap guard rejects an extended measurement window while preserving normal drain and legitimate timeout failures', () => {
  const { campaign, reports } = fixture([
    { repeat: 1, strategy: 'v1' }, { repeat: 1, strategy: 'v2' },
    { repeat: 2, strategy: 'v1', status: 'load_failed' }, { repeat: 2, strategy: 'v2' },
  ], 2);
  reports.get('run-0.json').k6.measurements.measuredElapsedMs = 42 * 60_000;
  reports.get('run-1.json').k6.measurements.measuredElapsedMs = 41_000;
  const timedOut = reports.get('run-2.json');
  timedOut.k6.measurements.measuredElapsedMs = 40_000;
  timedOut.k6.measurements.successfulRequests = 999;
  timedOut.k6.measurements.httpErrorRate = 0.001;
  timedOut.k6.measurements.contractErrorRate = 0.001;
  timedOut.k6.measurements.successfulRequestsPerSecond = 99.9;
  timedOut.pools[0].timeoutCount = 1;
  timedOut.pools[0].acquire.count = 1000;
  timedOut.pools[0].usage.count = 999;
  // HikariCP 7.0.2 also records timeout attempts in the acquire Timer.
  timedOut.pools[0].acquisitionCountMinusCompletedRequests = 0;

  const result = analyzeLatency(campaign, reports);
  assert.equal(result.runs[0].measurementValid, false);
  assert.equal(result.runs[0].measurementWindow.maximumElapsedMs, 42_000);
  assert.match(result.runs[0].measurementIssues.join(), /possible clock gap/);
  assert.match(result.warnings.join(), /Measurement-window clock-gap guard/);
  assert.match(toMarkdown(result), /clock-gap guard/);
  assert.equal(result.runs[1].measurementValid, true);
  assert.equal(result.runs[1].clean, true);
  assert.equal(result.runs[2].measurementValid, true);
  assert.equal(result.runs[2].reportStatus, 'load_failed');
  assert.equal(result.runs[2].clean, false);
  assert.deepEqual(result.runs[2].measurementIssues, []);
  assert.match(result.runs[2].loadFailures.join(), /Pool timeouts/);
  assert.equal(result.runs[3].clean, true);
});

test('mixed workload settings across repetitions prevent all comparisons within a condition', () => {
  const { campaign, reports } = fixture([
    { repeat: 1 }, { repeat: 1, strategy: 'v2' }, { repeat: 2 }, { repeat: 2, strategy: 'v2' },
  ], 2);
  reports.get('run-2.json').parameters.ids = [99];
  reports.get('run-3.json').parameters.ids = [99];
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.groups[0].settingVariantCount, 2);
  assert.equal(result.groups[0].cleanPairs, 0);
  assert.match(result.warnings.join(), /mixed settings/);
});

test('crossover bands span observed consistent winners and disclose mixed repeats without fitting a point', () => {
  const specifications = [];
  for (const [rttMs, differences] of [[0, [-2, -1]], [1, [-1, 1]], [2, [2, 3]], [5, [8, 9]]]) {
    for (const [index, difference] of differences.entries()) {
      specifications.push({ strategy: 'v1', rttMs, repeat: index + 1, p50: 10, p95: 15 });
      specifications.push({ strategy: 'v2', rttMs, repeat: index + 1, p50: 10 + difference, p95: 15 + difference });
    }
  }
  specifications.push({ strategy: 'v1', stage: 'load', vus: 20, rttMs: 50, p50: 100 });
  specifications.push({ strategy: 'v2', stage: 'load', vus: 20, rttMs: 50, p50: 1 });
  const { campaign, reports } = fixture(specifications, 2);
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.crossovers.length, 1);
  const crossover = result.crossovers[0];
  assert.equal(crossover.observations.length, 4);
  assert.equal(crossover.observations[1].p50Winner, 'mixed');
  assert.deepEqual(crossover.bands.map(({ metric, lowerRttMs, upperRttMs }) => ({ metric, lowerRttMs, upperRttMs })),
    [{ metric: 'p50', lowerRttMs: 0, upperRttMs: 2 }, { metric: 'p95', lowerRttMs: 0, upperRttMs: 2 }]);
  assert.match(toMarkdown(result), /정확한 전환점을 추정하지 않는다/);
  const svg = toSvg(result);
  assert.match(svg, /<svg /);
  assert.match(svg, /Pool 10/);
  assert.match(svg, /observed run min\/max/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('analyzer rejects a different campaign type and distinguishes partial completion', () => {
  assert.throws(() => analyzeLatency({ points: [] }, new Map()), /latency campaign/);
  const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]);
  campaign.parameters.totalMeasuredRuns = 10;
  const result = analyzeLatency(campaign, reports);
  assert.equal(result.coverage.campaignComplete, false);
  assert.match(result.warnings.join(), /2 of 10/);
  campaign.status = 'running';
  assert.match(analyzeLatency(campaign, reports).warnings.join(), /partial/);
});

test('saved proxy snapshots and proxy validation must independently match the labeled injected RTT', () => {
  const mutations = [
    (point) => { point.rttMs = 4; },
    (point) => { point.validation = { ...point.validation, proxyMatchesExpected: false }; },
    (point) => { point.proxyBefore.toxics[0].jitterMs = 1; },
    (point) => { point.proxyAfter.upstream = 'other-db:5432'; },
    (point) => { point.proxyAfter.toxics.push({ ...point.proxyAfter.toxics[0], name: 'foreign-toxic' }); },
    (point) => { point.proxyAfter.toxics[1].toxicity = 0.5; },
    (point) => { point.proxyBefore.enabled = false; },
  ];
  for (const mutate of mutations) {
    const { campaign, reports } = fixture([{ strategy: 'v1', rttMs: 2 }, { strategy: 'v2', rttMs: 2 }]);
    mutate(campaign.points[0]);
    const result = analyzeLatency(campaign, reports);
    assert.equal(result.runs[0].measurementValid, false);
    assert.match(result.runs[0].measurementIssues.join(), /proxy|toxic/i);
    assert.equal(result.groups.reduce((total, group) => total + group.cleanPairs, 0), 0);
  }
  const { campaign, reports } = fixture([{ strategy: 'v1', rttMs: 1 }, { strategy: 'v2', rttMs: 1 }]);
  campaign.points[0].proxyAfter.toxics.push({ name: 'querylab-rtt-upstream', stream: 'upstream', latencyMs: 0, type: 'latency', jitterMs: 0, toxicity: 1 });
  const result = analyzeLatency(campaign, reports);
  assert.match(result.runs[0].measurementIssues.join(), /zero delay/);
});

test('campaign calibration warnings remain visible in analysis and Markdown', () => {
  const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]);
  campaign.warnings = ['Calibration 10/proxy/1 differs from configured RTT; scheduler precision is part of observed path.'];
  const result = analyzeLatency(campaign, reports);
  assert.match(result.warnings.join(), /\[campaign\] Calibration/);
  assert.match(toMarkdown(result), /scheduler precision/);
});

test('crossover scans and plotted lines do not mix exploratory and confirmatory stages or incompatible durations', () => {
  const { campaign, reports } = fixture([
    { stage: 'sweep', strategy: 'v1', rttMs: 0, p50: 5 },
    { stage: 'sweep', strategy: 'v2', rttMs: 0, p50: 3 },
    { stage: 'refine', strategy: 'v1', rttMs: 2, p50: 5 },
    { stage: 'refine', strategy: 'v2', rttMs: 2, p50: 7 },
  ]);
  reports.get('run-0.json').parameters.durationMs = 10_000;
  reports.get('run-1.json').parameters.durationMs = 10_000;
  let result = analyzeLatency(campaign, reports);
  assert.equal(result.crossovers.length, 2);
  assert.deepEqual(result.crossovers.map((scan) => scan.stage), ['sweep', 'refine']);
  assert.ok(result.crossovers.every((scan) => scan.bands.length === 0));
  let svg = toSvg(result);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 8);
  assert.match(svg, /sweep · Pool 10 · 10.00s/);
  assert.match(svg, /refine · Pool 10 · 30.00s/);
  assert.ok((svg.match(/points="[^"]+"/g) ?? []).every((points) => !points.includes(' ')));

  campaign.points[2].stage = 'sweep';
  campaign.points[3].stage = 'sweep';
  result = analyzeLatency(campaign, reports);
  assert.equal(result.crossovers.length, 2);
  assert.deepEqual(result.crossovers.map((scan) => scan.scanSettings.durationMs), [10_000, 30_000]);
  assert.ok(result.crossovers.every((scan) => scan.bands.length === 0));
  svg = toSvg(result);
  assert.equal((svg.match(/<polyline /g) ?? []).length, 8);
  assert.ok((svg.match(/points="[^"]+"/g) ?? []).every((points) => !points.includes(' ')));
});

test('CLI reads relative JSON reports including BOM, writes standalone outputs, and protects raw reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'querylab-latency-analysis-'));
  const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2', p50: 3 }]);
  await writeFile(join(directory, 'campaign.json'), '\uFEFF' + JSON.stringify(campaign));
  for (const [path, report] of reports) await writeFile(join(directory, path), JSON.stringify(report));
  const loaded = await loadLatency(directory);
  assert.equal(loaded.reports.size, 2);
  const run = promisify(execFile);
  await run(process.execPath, ['benchmarks/analyze-latency.mjs', '--input', directory]);
  assert.equal(JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8')).coverage.cleanRuns, 2);
  assert.match(await readFile(join(directory, 'runs.csv'), 'utf8'), /rttMs/);
  assert.match(await readFile(join(directory, 'latency.svg'), 'utf8'), /<svg /);
  await assert.rejects(run(process.execPath, ['benchmarks/analyze-latency.mjs', '--input', directory, '--output', join(directory, 'run-0')]), /must not overwrite/);
  assert.equal(JSON.parse(await readFile(join(directory, 'run-0.json'), 'utf8')).status, 'completed');
});
