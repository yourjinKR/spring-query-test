import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeCardinality, expectedRows, loadCardinality, toCsv, toMarkdown } from './analyze-cardinality.mjs';

const ids = Array.from({ length: 10 }, (_, index) => index + 1);
const fixedDataset = { postCount: 200, bodyBytes: 1024, seed: 42, distribution: 'UNIFORM' };
const validations = ['datasetMatchesExpected', 'poolMatchesExpected', 'cleanupConfirmed', 'measurementValid', 'dtoEqual', 'rowsMatchExpected', 'directRoute'];
function fixture(specifications, repeats = 1) {
  const reports = new Map();
  const points = specifications.map((specification, index) => {
    const { c = 20, a = 5, strategy = 'v1', repeat = 1, stage = 'confirm', phase = 'measure', p50 = 5, p95 = p50 * 1.5,
      completed = 1000, status = 'completed', exitCode = status === 'completed' ? 0 : 99, dropped = 0, order = strategy === 'v1' ? 1 : 2 } = specification;
    const rows = expectedRows(c, a);
    const dataset = { config: { ...fixedDataset, commentsPerPost: c, attachmentsPerPost: a }, postCount: 200, commentCount: 200 * c, attachmentCount: 200 * a };
    const correctness = { equalResults: true, error: null, samples: ['v1', 'v2'].map((name) => ({ strategy: name, postCount: 10,
      postsSha256: 'a'.repeat(64), metrics: { queryCount: rows.queries[name].length, totalRows: rows[name], queries: rows.queries[name].map((rows) => ({ rows })) } })) };
    const trend = (value) => ({ values: { min: value, max: value, med: value, 'p(95)': value * 1.1, count: completed } });
    const report = { status, error: null, datasetUnchanged: true, datasetBefore: dataset, datasetAfter: dataset, pollErrorCount: 0,
      parameters: { strategy, model: 'closed', vus: 1, ids, durationMs: 30_000, requestTimeout: '10s', baseUrl: 'http://localhost:8080', dockerBaseUrl: 'http://server:8080' },
      pools: [{ configuredMaximum: 10, counterReset: false, sampledMaximumChanged: false, missingMetrics: [], acquisitionCountMinusCompletedRequests: 0,
        acquire: { meanMs: 0.001 }, usage: { meanMs: 1 }, sampledMaxPending: 0, timeoutCount: 0 }],
      runner: { exitCode, cliTerminated: true, cleanup: { after: { status: 'removed' } } },
      k6: { metadata: { durationMs: 30_000, requestTimeoutMs: 10_000 }, measurements: { startedRequests: completed, completedRequests: completed,
        successfulRequests: completed, incompleteRequests: 0, droppedIterations: dropped, httpErrorRate: 0, contractErrorRate: 0,
        measuredElapsedMs: 30_000, completedRequestsPerSecond: completed / 30, successfulRequestsPerSecond: completed / 30 },
      results: { metrics: { measured_http_ms: { values: { med: p50, 'p(95)': p95, 'p(99)': p95 * 1.1 } },
        returned_rows: trend(rows[strategy]), query_count: trend(rows.queries[strategy].length),
        ...Object.fromEntries(rows.queries[strategy].map((rows, index) => [`query_${index + 1}_rows`, trend(rows)])),
        fetch_and_assemble_ms: trend(p50 / 2), jdbc_execute_ms: trend(p50 / 4), assembly_ms: trend(p50 / 10) } } } };
    const path = `run-${index}.json`; reports.set(path, report);
    return { sequence: index + 1, stage, phase, commentsPerPost: c, attachmentsPerPost: a, scenario: `${c}/${a}`, route: 'direct',
      routeBefore: 'jdbc:postgresql://db:5432/querylab', routeAfter: 'jdbc:postgresql://db:5432/querylab',
      poolSize: 10, model: 'closed', vus: 1, repeat, strategy, order, report: path, exitCode, datasetBaseline: dataset,
      correctness, correctnessAfter: structuredClone(correctness), expectedRows: { v1: rows.v1, v2: rows.v2 },
      validation: Object.fromEntries(validations.map((name) => [name, true])) };
  });
  return { campaign: { schemaVersion: 1, experiment: 'cardinality', status: 'completed', completedAt: '2026-10-30T00:00:00Z',
    parameters: { ids, fixedDataset, repeats, totalMeasuredRuns: points.filter((point) => point.phase === 'measure').length }, points }, reports };
}

test('row formulas include LEFT JOIN empty children and additive split rows', () => {
  assert.deepEqual(expectedRows(0, 0), { v1: 10, v2: 10, queries: { v1: [10], v2: [10, 0, 0] } });
  assert.equal(expectedRows(1, 1).v2, 30);
  assert.equal(expectedRows(100, 20).v1, 20_000);
  assert.equal(expectedRows(100, 20).v2, 1210);
  assert.throws(() => expectedRows(-1, 2), /nonnegative/);
});

test('groups keep cardinality and stage distinct and omit warmups', () => {
  const { campaign, reports } = fixture([{ phase: 'warmup' }, { strategy: 'v1' }, { strategy: 'v2' },
    { c: 0, a: 0 }, { c: 0, a: 0, strategy: 'v2' }, { stage: 'sweep' }, { stage: 'sweep', strategy: 'v2' }]);
  const result = analyzeCardinality(campaign, reports);
  assert.equal(result.coverage.cleanRuns, 6);
  assert.equal(result.coverage.excludedWarmupPoints, 1);
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups.find((group) => group.stage === 'confirm' && group.scenario === '20/5').rowRatio, 1000 / 260);
  assert.equal(result.groups.find((group) => group.scenario === '0/0').rowReductionRate, 0);
});

test('matched clean pairs alone determine medians and failed runs remain visible', () => {
  const { campaign, reports } = fixture([{ repeat: 1, p50: 1000, completed: 100000 }, { repeat: 1, strategy: 'v2', status: 'load_failed', dropped: 1 },
    { repeat: 2, p50: 20 }, { repeat: 2, strategy: 'v2', p50: 10 }, { repeat: 3, p50: 10 }, { repeat: 3, strategy: 'v2', p50: 8 }], 3);
  const result = analyzeCardinality(campaign, reports); const group = result.groups[0];
  assert.equal(group.cleanPairs, 2);
  assert.equal(group.pairedRunMetrics.v1.httpP50Ms.median, 15);
  assert.equal(group.pairMetrics.httpP50Ms.v2MinusV1.median, -6);
  assert.equal(group.strategies.v2.droppedIterations, 1);
  assert.match(toCsv(result), /load_failed/);
  assert.match(toMarkdown(result), /실패·계측 무효 실행\(삭제하지 않음\)/);
});

test('row/query mismatches and missing per-request evidence invalidate rather than silently accept data', () => {
  for (const mutate of [
    (report) => { report.k6.results.metrics.returned_rows.values.max++; },
    (report) => { report.k6.results.metrics.query_1_rows.values.count--; },
    (report) => { delete report.k6.results.metrics.query_count; },
    (report) => { report.k6.results.metrics.query_1_rows.values.min = 99; },
  ]) {
    const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]); mutate(reports.get('run-0.json'));
    const result = analyzeCardinality(campaign, reports);
    assert.equal(result.runs[0].measurementValid, false);
    assert.equal(result.groups[0].cleanPairs, 0);
    assert.match(result.runs[0].measurementIssues.join(), /Measured .* differs/);
  }
});

test('DTO evidence independently checks SHA-256, parent count and individual query rows before/after', () => {
  for (const mutate of [
    (point) => { point.correctness.samples[0].postsSha256 = 'b'.repeat(64); },
    (point) => { point.correctness.samples[0].metrics.queries[0].rows++; },
    (point) => { point.correctness.samples[1].postCount = 11; },
    (point) => { point.correctnessAfter.equalResults = false; },
    (point) => { point.correctnessAfter.samples.forEach((sample) => { sample.postsSha256 = 'b'.repeat(64); }); },
  ]) {
    const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]); mutate(campaign.points[0]);
    const result = analyzeCardinality(campaign, reports);
    assert.equal(result.runs[0].measurementValid, false);
    assert.match(result.runs[0].measurementIssues.join(), /DTO/);
  }
});

test('direct route, fixed dataset and actual counts cannot be asserted by booleans alone', () => {
  for (const mutate of [
    (point) => { point.routeAfter = 'jdbc:postgresql://toxiproxy:8666/querylab'; },
    (point) => { point.datasetBaseline = { ...point.datasetBaseline, commentCount: 99 }; },
    (point) => { point.validation.directRoute = false; },
    (point) => { point.route = 'proxy'; },
  ]) {
    const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]); mutate(campaign.points[0]);
    assert.equal(analyzeCardinality(campaign, reports).runs[0].measurementValid, false);
  }
  const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]);
  campaign.parameters.fixedDataset = { ...fixedDataset, bodyBytes: 2048 };
  assert.equal(analyzeCardinality(campaign, reports).coverage.cleanRuns, 0);
});

test('missing, duplicate and unrecorded repeats prevent paired comparisons', () => {
  const { campaign, reports } = fixture([{ repeat: 1 }, { repeat: 2 }, { repeat: 2 }, { repeat: 2, strategy: 'v2' }], 3);
  const group = analyzeCardinality(campaign, reports).groups[0];
  assert.equal(group.recordedPairs, 3); assert.equal(group.cleanPairs, 0);
  assert.match(group.pairs[0].issues.join(), /v2 has 0/);
  assert.match(group.pairs[1].issues.join(), /v1 has 2/);
  assert.match(group.pairs[2].issues.join(), /v1 has 0/);
});

test('changed settings between repeats and invalid AB/BA order suppress comparisons', () => {
  const { campaign, reports } = fixture([{ repeat: 1 }, { repeat: 1, strategy: 'v2' }, { repeat: 2 }, { repeat: 2, strategy: 'v2' }], 2);
  for (const index of [2, 3]) reports.get(`run-${index}.json`).parameters.requestTimeout = '20s';
  let result = analyzeCardinality(campaign, reports);
  assert.equal(result.groups[0].cleanPairs, 0);
  assert.match(result.warnings.join(), /mixed settings/);
  const other = fixture([{ strategy: 'v1' }, { strategy: 'v2', order: 1 }]);
  result = analyzeCardinality(other.campaign, other.reports);
  assert.match(result.groups[0].pairs[0].issues.join(), /AB\/BA/);
});

test('clock gaps and incomplete campaigns are disclosed; small p99 samples remain auxiliary', () => {
  const { campaign, reports } = fixture([{ strategy: 'v1', completed: 100 }, { strategy: 'v2', completed: 100 }]);
  reports.get('run-0.json').k6.measurements.measuredElapsedMs = 600_000;
  campaign.status = 'running'; campaign.parameters.totalMeasuredRuns = 10;
  const result = analyzeCardinality(campaign, reports);
  assert.equal(result.coverage.campaignComplete, false);
  assert.match(result.runs[0].measurementIssues.join(), /clock-gap/);
  assert.equal(result.runs[1].p99EnoughSamples, false);
  assert.match(result.warnings.join(), /2 of 10/);
  assert.match(result.warnings.join(), /partial/);
});

test('crossover bands describe observed repeat-consistent winners and retain mixed intervals', () => {
  const specifications = [];
  for (const [c, a, differences] of [[1, 1, [1, 2]], [5, 1, [-1, 1]], [5, 5, [-2, -1]]]) for (const [index, difference] of differences.entries()) {
    specifications.push({ c, a, repeat: index + 1, p50: 5 });
    specifications.push({ c, a, repeat: index + 1, strategy: 'v2', p50: 5 + difference });
  }
  const { campaign, reports } = fixture(specifications, 2);
  const result = analyzeCardinality(campaign, reports);
  assert.equal(result.crossovers.length, 1);
  assert.equal(result.crossovers[0].observations[1].p50Winner, 'mixed');
  assert.equal(result.crossovers[0].bands[0].lowerJoinRows, 10);
  assert.equal(result.crossovers[0].bands[0].upperJoinRows, 250);
  assert.match(toMarkdown(result), /정확한 전환점을 추정하지 않는다/);
});

test('exploration and confirmation or incompatible measurement durations never form one crossover', () => {
  const { campaign, reports } = fixture([{ c: 1, a: 1, stage: 'sweep' }, { c: 1, a: 1, stage: 'sweep', strategy: 'v2', p50: 8 },
    { c: 5, a: 5 }, { c: 5, a: 5, strategy: 'v2', p50: 2 }]);
  let result = analyzeCardinality(campaign, reports);
  assert.equal(result.crossovers.length, 2); assert.ok(result.crossovers.every((scan) => scan.bands.length === 0));
  campaign.points.forEach((point) => { point.stage = 'confirm'; });
  for (const index of [0, 1]) { reports.get(`run-${index}.json`).parameters.durationMs = 10_000; reports.get(`run-${index}.json`).k6.metadata.durationMs = 10_000; reports.get(`run-${index}.json`).k6.measurements.measuredElapsedMs = 10_000; }
  result = analyzeCardinality(campaign, reports);
  assert.equal(result.crossovers.length, 2); assert.ok(result.crossovers.every((scan) => scan.bands.length === 0));
});

test('CLI loads BOM/relative reports, writes derived outputs and protects raw reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'querylab-cardinality-'));
  const { campaign, reports } = fixture([{ strategy: 'v1' }, { strategy: 'v2' }]);
  await writeFile(join(directory, 'campaign.json'), '\uFEFF' + JSON.stringify(campaign));
  for (const [path, report] of reports) await writeFile(join(directory, path), JSON.stringify(report));
  assert.equal((await loadCardinality(directory)).reports.size, 2);
  const run = promisify(execFile);
  await run(process.execPath, ['benchmarks/analyze-cardinality.mjs', '--input', directory]);
  assert.equal(JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8')).coverage.cleanRuns, 2);
  assert.match(await readFile(join(directory, 'runs.csv'), 'utf8'), /commentsPerPost/);
  await assert.rejects(run(process.execPath, ['benchmarks/analyze-cardinality.mjs', '--input', directory, '--output', join(directory, 'run-0')]), /must not overwrite/);
});
