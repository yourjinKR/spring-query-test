import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStudy, distribution, summarizeResources, toCsv, toMarkdown } from './analyze-study.mjs';

const dataset = { postCount: 200, commentCount: 4000, attachmentCount: 1000,
  config: { postCount: 200, commentsPerPost: 20, attachmentsPerPost: 5, bodyBytes: 1024, seed: 42, distribution: 'UNIFORM' } };

function report({ strategy = 'v1', model = 'closed', pool = 2, vus = 20, rate = null,
  p95 = 100, p99 = 120, rps = 100, completed = 3000, status = 'completed', dropped = 0, httpErrors = 0 } = {}) {
  return {
    status, error: null, datasetBefore: dataset, datasetAfter: dataset, datasetUnchanged: true,
    pollErrorCount: 0, warnings: [],
    parameters: { strategy, model, vus: model === 'closed' ? vus : null, rate: model === 'arrival' ? rate : null,
      ids: [1, 2, 3], durationMs: 30_000, requestTimeout: '10s', baseUrl: 'http://localhost:8080', dockerBaseUrl: 'http://server:8080' },
    pools: [{ configuredMaximum: pool, counterReset: false, missingMetrics: [], sampledMaximumChanged: false,
      acquisitionCountMinusCompletedRequests: 0, sampledMaxPending: 18, timeoutCount: 0,
      acquire: { meanMs: 20, p95Ms: 30 }, usage: { meanMs: 5, p95Ms: 10 } }],
    runner: { cliTerminated: true, cleanup: { after: { status: 'already_absent' } }, stopReason: null },
    k6: {
      measurements: { startedRequests: completed, completedRequests: completed, successfulRequests: httpErrors ? 0 : completed,
        incompleteRequests: 0, droppedIterations: dropped, httpErrorRate: httpErrors, contractErrorRate: httpErrors,
        completedRequestsPerSecond: rps, successfulRequestsPerSecond: httpErrors ? 0 : rps },
      results: { metrics: { measured_http_ms: { values: { 'p(95)': p95, 'p(99)': p99 } } } },
    },
  };
}

function study(specifications) {
  const points = [];
  const reports = new Map();
  for (const [index, specification] of specifications.entries()) {
    const { repeat = 1, order = specification.strategy === 'v2' ? 2 : 1, phase = 'measure', ...configuration } = specification;
    const raw = report(configuration);
    const path = `run-${index}.json`;
    points.push({ phase, poolSize: configuration.pool ?? 2, model: configuration.model ?? 'closed',
      vus: configuration.model === 'arrival' ? null : configuration.vus ?? 20, rate: configuration.rate ?? null,
      repeat, strategy: configuration.strategy ?? 'v1', order, report: path, sequence: index + 1 });
    reports.set(path, raw);
  }
  return { campaign: { status: 'completed', completedAt: '2026-10-28T00:00:00Z', datasetBaseline: dataset,
    parameters: { repeats: 5 }, points }, reports };
}

test('run-level distribution uses an unweighted median and keeps missing values unknown', () => {
  assert.deepEqual(distribution([1, 100, 2, null, NaN]), { n: 3, median: 2, min: 1, max: 100 });
  assert.deepEqual(distribution([]), { n: 0, median: null, min: null, max: null });
  const { campaign, reports } = study([
    { repeat: 1, strategy: 'v1', p95: 1, completed: 100_000 },
    { repeat: 2, strategy: 'v1', p95: 2, completed: 10 },
    { repeat: 3, strategy: 'v1', p95: 100, completed: 10 },
  ]);
  const result = analyzeStudy(campaign, reports);
  assert.equal(result.groups[0].strategies.v1.cleanRunMetrics.httpP95Ms.median, 2);
  assert.equal(result.groups[0].strategies.v2.cleanRunMetrics.httpP95Ms.median, null);
});

test('paired ratios and execution-order subgroups do not combine raw request percentiles', () => {
  const { campaign, reports } = study([
    { repeat: 1, strategy: 'v1', p95: 100, rps: 100, order: 1 },
    { repeat: 1, strategy: 'v2', p95: 50, rps: 200, order: 2 },
    { repeat: 2, strategy: 'v2', p95: 90, rps: 150, order: 1 },
    { repeat: 2, strategy: 'v1', p95: 100, rps: 100, order: 2 },
  ]);
  const group = analyzeStudy(campaign, reports).groups[0];
  assert.equal(group.pairing.cleanLatencyPairs, 2);
  assert.equal(group.pairing.cleanPairMetrics.httpP95Ms.v2OverV1.median, 0.7);
  assert.equal(group.pairing.cleanPairMetrics.httpP95Ms.improvementPercent.median, 30);
  assert.equal(group.pairing.cleanPairMetrics.httpP95Ms.v2Better, 2);
  assert.equal(group.pairing.cleanPairMetrics.completedRps.improvementPercent.median, 75);
  assert.equal(group.pairing.byFirstStrategy.v1.pairs, 1);
  assert.equal(group.pairing.byFirstStrategy.v2.pairs, 1);
});

test('failed arrival load remains in capacity counts but is excluded from latency comparisons', () => {
  const { campaign, reports } = study([
    { strategy: 'v1', model: 'arrival', rate: 600, status: 'load_failed', dropped: 100, p95: 1 },
    { strategy: 'v2', model: 'arrival', rate: 600, p95: 10 },
  ]);
  const result = analyzeStudy(campaign, reports);
  const group = result.groups[0];
  assert.equal(group.pairing.capacityEligiblePairs, 1);
  assert.equal(group.pairing.cleanLatencyPairs, 0);
  assert.equal(group.strategies.v1.cleanRuns, 0);
  assert.equal(group.strategies.v1.allRecordedRequests.dropped, 100);
  assert.equal(group.strategies.v1.allRecordedRunMetrics.httpP95Ms.median, 1);
  assert.equal(group.strategies.v1.cleanRunMetrics.httpP95Ms.median, null);
  assert.match(toCsv(result), /load_failed/);
});

test('warmups are excluded while missing or duplicate pair members are explicitly retained', () => {
  const { campaign, reports } = study([
    { phase: 'warmup', strategy: 'v1', p95: 999 },
    { repeat: 1, strategy: 'v1' },
    { repeat: 2, strategy: 'v1' },
    { repeat: 2, strategy: 'v1' },
    { repeat: 2, strategy: 'v2' },
  ]);
  const result = analyzeStudy(campaign, reports);
  assert.equal(result.coverage.excludedWarmupPoints, 1);
  assert.equal(result.coverage.measuredRuns, 4);
  assert.equal(result.groups[0].pairing.cleanLatencyPairs, 0);
  assert.match(result.groups[0].pairing.pairs[0].issues.join(), /v2 has 0/);
  assert.match(result.groups[0].pairing.pairs[1].issues.join(), /v1 has 2/);
});

test('counter contamination, changed data and missing reports invalidate measurements', () => {
  const { campaign, reports } = study([{ strategy: 'v1' }, { strategy: 'v2' }]);
  reports.get('run-0.json').pools[0].acquisitionCountMinusCompletedRequests = 1;
  reports.get('run-1.json').datasetAfter = { postCount: 1 };
  const result = analyzeStudy(campaign, reports);
  assert.equal(result.coverage.measurementValidRuns, 0);
  assert.match(result.runs[0].measurementIssues.join(), /borrow count/);
  assert.match(result.runs[1].measurementIssues.join(), /baseline/);
  reports.delete('run-0.json');
  assert.match(analyzeStudy(campaign, reports).runs[0].measurementIssues.join(), /missing/);
});

test('different workload settings between repeats prevent an apparently clean comparison', () => {
  const { campaign, reports } = study([
    { repeat: 1, strategy: 'v1' }, { repeat: 1, strategy: 'v2' },
    { repeat: 2, strategy: 'v1' }, { repeat: 2, strategy: 'v2' },
  ]);
  reports.get('run-2.json').parameters.ids = [9];
  reports.get('run-3.json').parameters.ids = [9];
  const result = analyzeStudy(campaign, reports);
  assert.equal(result.groups[0].settingVariantCount, 2);
  assert.equal(result.groups[0].pairing.cleanLatencyPairs, 0);
  assert.match(result.warnings.join(), /mixed settings/);
});

test('Markdown and CSV disclose run counts, percentile scope and failure details', () => {
  const { campaign, reports } = study([{ strategy: 'v1' }, { strategy: 'v2', p95: 50 }]);
  const result = analyzeStudy(campaign, reports);
  assert.match(toMarkdown(result), /실행별 통계의 중앙값/);
  assert.match(toMarkdown(result), /정상 비교 쌍: 1\/1/);
  const csv = toCsv(result);
  assert.equal(csv.trim().split('\n').length, 3);
  assert.match(csv, /measurementValid,clean,httpP95Ms/);
});

test('resource observations are window scoped, load-container specific, and unknown deltas stay unknown', () => {
  const sample = (seconds, serverCpu, allocated, extra = {}) => ({ at: `2026-10-28T00:00:${String(seconds).padStart(2, '0')}Z`,
    resources: [{ name: 'spring-query-lab-server-1', cpuPercent: serverCpu },
      { name: 'spring-query-lab-db-1', cpuPercent: 20 },
      { name: 'querylab-load-current', cpuPercent: 30 }, { name: 'querylab-load-other', cpuPercent: 999 }],
    jvm: { uptimeSeconds: seconds, gcPauseSeconds: seconds / 100, gcPauseCount: seconds, allocatedBytes: allocated },
    errors: [], ...extra });
  const window = { startedAt: '2026-10-28T00:00:10Z', endedAt: '2026-10-28T00:00:30Z' };
  const resource = summarizeResources([sample(5, 999, 0), sample(15, 100, 100), sample(25, 150, 400), sample(35, 999, 1000)], window, 'querylab-load-current');
  assert.equal(resource.sampleCount, 2);
  assert.equal(resource.metrics.serverCpuMedianPercent, 125);
  assert.equal(resource.metrics.dbCpuMedianPercent, 20);
  assert.equal(resource.metrics.loadCpuMedianPercent, 30);
  assert.equal(resource.metrics.allocatedBytesApprox, 300);
  assert.equal(resource.metrics.gcPauseCountApprox, 10);
  assert.equal(summarizeResources([], window).metrics.gcPauseCountApprox, null);
  const reset = summarizeResources([sample(15, 100, 400), sample(25, 100, 100)], window);
  assert.equal(reset.counterReset, true);
  assert.equal(reset.metrics.allocatedBytesApprox, null);
});

test('absolute comparison statistics use identical clean pair members rather than different strategy denominators', () => {
  const { campaign, reports } = study([
    { repeat: 1, strategy: 'v1', model: 'arrival', rate: 150, p95: 1000 },
    { repeat: 1, strategy: 'v2', model: 'arrival', rate: 150, p95: 1, status: 'load_failed', dropped: 10 },
    { repeat: 2, strategy: 'v1', model: 'arrival', rate: 150, p95: 20 },
    { repeat: 2, strategy: 'v2', model: 'arrival', rate: 150, p95: 10 },
  ]);
  const result = analyzeStudy(campaign, reports);
  const group = result.groups[0];
  assert.equal(group.strategies.v1.cleanRunMetrics.httpP95Ms.n, 2);
  assert.equal(group.strategies.v1.cleanRunMetrics.httpP95Ms.median, 510);
  assert.equal(group.strategies.v2.cleanRunMetrics.httpP95Ms.n, 1);
  assert.deepEqual(group.pairedRunMetrics.v1.httpP95Ms, { n: 1, median: 20, min: 20, max: 20 });
  assert.deepEqual(group.pairedRunMetrics.v2.httpP95Ms, { n: 1, median: 10, min: 10, max: 10 });
  assert.equal(group.pairing.firstRepeatDrift.firstRepeatWasClean, false);
  assert.equal(group.pairing.firstRepeatDrift.byStrategy.v1.firstMetrics, null);
  assert.match(toMarkdown(result), /주요 비교: 공통 정상 1쌍/);
  assert.match(toMarkdown(result), /실패·계측 무효 실행\(삭제하지 않음\)/);
  assert.match(toMarkdown(result), /load_failed/);
});

test('completion with load failures is distinct from partial coverage and missing timestamps', () => {
  const { campaign, reports } = study([
    { strategy: 'v1', status: 'load_failed', dropped: 2 }, { strategy: 'v2' },
  ]);
  campaign.status = 'completed_with_load_failures';
  campaign.parameters.totalMeasuredRuns = 2;
  const complete = analyzeStudy(campaign, reports);
  assert.equal(complete.coverage.campaignComplete, true);
  assert.equal(complete.coverage.allPlannedRunsRecorded, true);
  assert.equal(complete.warnings.some((warning) => /partial|coverage is incomplete/.test(warning)), false);
  assert.equal(complete.warnings.some((warning) => /contains load failures/.test(warning)), true);
  campaign.parameters.totalMeasuredRuns = 60;
  const partial = analyzeStudy(campaign, reports);
  assert.equal(partial.coverage.campaignComplete, false);
  assert.equal(partial.coverage.allPlannedRunsRecorded, false);
  assert.match(partial.warnings.join(), /2 of 60 planned/);
  campaign.parameters.totalMeasuredRuns = 2;
  campaign.completedAt = null;
  assert.equal(analyzeStudy(campaign, reports).coverage.campaignComplete, false);
  campaign.completedAt = '2026-10-28T00:00:00Z';
  campaign.status = 'running';
  assert.match(analyzeStudy(campaign, reports).warnings.join(), /partial/);
});

test('first-repeat drift describes the first recorded pair against later matched pairs without dropping it', () => {
  const { campaign, reports } = study([
    { repeat: 1, strategy: 'v1', p95: 100 }, { repeat: 1, strategy: 'v2', p95: 50 },
    { repeat: 2, strategy: 'v1', p95: 20 }, { repeat: 2, strategy: 'v2', p95: 10 },
    { repeat: 3, strategy: 'v1', p95: 30 }, { repeat: 3, strategy: 'v2', p95: 20 },
  ]);
  const group = analyzeStudy(campaign, reports).groups[0];
  assert.equal(group.pairing.cleanLatencyPairs, 3);
  assert.equal(group.pairedRunMetrics.v1.httpP95Ms.n, 3);
  assert.equal(group.pairing.firstRepeatDrift.firstRepeatWasClean, true);
  assert.equal(group.pairing.firstRepeatDrift.byStrategy.v1.firstOverLaterMedian.httpP95Ms, 4);
  assert.equal(group.pairing.firstRepeatDrift.byStrategy.v2.firstOverLaterMedian.httpP95Ms, 50 / 15);
});

test('arrival pairs with different load-generator VU budgets cannot be compared as the same workload', () => {
  const { campaign, reports } = study([
    { strategy: 'v1', model: 'arrival', rate: 150 },
    { strategy: 'v2', model: 'arrival', rate: 150 },
  ]);
  reports.get('run-0.json').parameters.preallocatedVus = 50;
  reports.get('run-1.json').parameters.preallocatedVus = 50;
  reports.get('run-0.json').parameters.maxVus = 100;
  reports.get('run-1.json').parameters.maxVus = 200;
  const group = analyzeStudy(campaign, reports).groups[0];
  assert.equal(group.pairing.cleanLatencyPairs, 0);
  assert.match(group.pairing.pairs[0].issues.join(), /different workload/);
});
