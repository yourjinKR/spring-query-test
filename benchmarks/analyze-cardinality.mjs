import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { distribution } from './analyze-study.mjs';

const metricNames = ['httpP50Ms', 'httpP95Ms', 'httpP99Ms', 'completedRps', 'successfulRps',
  'fetchAndAssembleP50Ms', 'fetchAndAssembleP95Ms', 'jdbcExecuteP50Ms', 'jdbcExecuteP95Ms', 'assemblyP50Ms', 'assemblyP95Ms',
  'acquireMeanMs', 'usageMeanMs', 'sampledMaxPending', 'timeoutCount'];
const finite = (value) => Number.isFinite(value) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const summarize = (runs) => Object.fromEntries(metricNames.map((name) => [name, distribution(runs.map((run) => run.metrics[name]))]));
const expectedFixed = { postCount: 200, bodyBytes: 1024, seed: 42, distribution: 'UNIFORM' };
const directUrl = 'jdbc:postgresql://db:5432/querylab';

export function expectedRows(comments, attachments, parents = 10) {
  if (![comments, attachments, parents].every(count)) throw new Error('Cardinality and parent count must be nonnegative safe integers');
  return { v1: parents * Math.max(1, comments) * Math.max(1, attachments),
    v2: parents * (1 + comments + attachments), queries: { v1: [parents * Math.max(1, comments) * Math.max(1, attachments)],
      v2: [parents, parents * comments, parents * attachments] } };
}

function datasetIssues(dataset, comments, attachments, fixed, label) {
  const issues = [];
  if (!dataset || !isDeepStrictEqual(dataset.config, { ...fixed, commentsPerPost: comments, attachmentsPerPost: attachments })
    || dataset.postCount !== fixed.postCount || dataset.commentCount !== fixed.postCount * comments
    || dataset.attachmentCount !== fixed.postCount * attachments) issues.push(`${label} does not match expected dataset/config/counts`);
  return issues;
}

function correctnessIssues(correctness, rows, parents) {
  const issues = [];
  if (!correctness || correctness.equalResults !== true || correctness.error) return ['DTO correctness evidence is missing or failed'];
  const samples = correctness.samples ?? [];
  for (const strategy of ['v1', 'v2']) {
    const selected = samples.filter((sample) => sample.strategy === strategy);
    if (selected.length === 0) issues.push(`DTO correctness evidence for ${strategy} is missing`);
    for (const sample of selected) {
      if (sample.postCount !== parents || sample.metrics?.queryCount !== rows.queries[strategy].length
        || sample.metrics?.totalRows !== rows[strategy]
        || !isDeepStrictEqual(sample.metrics?.queries?.map((query) => query.rows), rows.queries[strategy])) {
        issues.push(`DTO correctness ${strategy} parent/SELECT/totalRows/queries[].rows differs from expected`);
      }
    }
  }
  const hashes = samples.map((sample) => sample.postsSha256);
  if (!hashes.length || hashes.some((hash) => !/^[a-f0-9]{64}$/i.test(hash ?? '')) || new Set(hashes).size !== 1) {
    issues.push('DTO SHA-256 evidence is invalid or differs between strategies');
  }
  return issues;
}

function normalizeRun(point, loaded, campaign) {
  const report = loaded?.report ?? (loaded && !loaded.readError ? loaded : null);
  const parameters = report?.parameters ?? {};
  const measurements = report?.k6?.measurements ?? {};
  const pool = report?.pools?.length === 1 ? report.pools[0] : null;
  const issues = [];
  const issue = (condition, message) => { if (condition) issues.push(message); };
  const c = point.commentsPerPost; const a = point.attachmentsPerPost;
  const ids = campaign.parameters?.ids ?? Array.from({ length: 10 }, (_, index) => index + 1);
  const fixed = campaign.parameters?.fixedDataset ?? expectedFixed;
  const cardinalityValid = count(c) && c <= 200 && count(a) && a <= 100;
  const rows = cardinalityValid ? expectedRows(c, a, ids.length) : null;
  issue(!report, loaded?.readError ?? 'Report is missing');
  issue(!['sweep', 'confirm'].includes(point.stage), 'Unknown cardinality stage');
  issue(!cardinalityValid, 'Invalid comments/attachments cardinality');
  issue(point.route !== 'direct', 'Cardinality study requires direct database route');
  issue(point.poolSize !== 10 || point.model !== 'closed' || point.vus !== 1, 'Cardinality study requires pool 10 / closed VU 1');
  issue(!['v1', 'v2'].includes(point.strategy), 'Unknown strategy');
  issue(!Number.isInteger(point.repeat) || point.repeat < 1, 'Invalid repeat');
  issue(!isDeepStrictEqual(fixed, expectedFixed), 'Fixed dataset differs from 200 posts / bodyBytes 1024 / seed 42 / UNIFORM');
  issue(!isDeepStrictEqual(ids, Array.from({ length: 10 }, (_, index) => index + 1)), 'Query IDs must remain 1..10');
  for (const name of ['datasetMatchesExpected', 'poolMatchesExpected', 'cleanupConfirmed', 'measurementValid', 'dtoEqual', 'rowsMatchExpected', 'directRoute']) {
    issue(point.validation?.[name] !== true, `Point validation ${name} failed or is unknown`);
  }
  issue(point.routeBefore !== directUrl || point.routeAfter !== directUrl, 'Saved route evidence is not direct PostgreSQL before and after load');
  if (rows) {
    issues.push(...datasetIssues(point.datasetBaseline, c, a, fixed, 'Point baseline'));
    issues.push(...correctnessIssues(point.correctness, rows, ids.length));
    issues.push(...correctnessIssues(point.correctnessAfter, rows, ids.length).map((message) => `After measurement: ${message}`));
    if (point.correctness && point.correctnessAfter) issue(point.correctness.samples?.[0]?.postsSha256 !== point.correctnessAfter.samples?.[0]?.postsSha256, 'DTO SHA-256 changed before/after measurement');
    if (point.expectedRows) issue(point.expectedRows.v1 !== rows.v1 || point.expectedRows.v2 !== rows.v2, 'Saved expected rows differ from cardinality formula');
  }
  const k6Metric = (name, stat) => finite(report?.k6?.results?.metrics?.[name]?.values?.[stat]);
  const metrics = {
    httpP50Ms: k6Metric('measured_http_ms', 'med'), httpP95Ms: k6Metric('measured_http_ms', 'p(95)'), httpP99Ms: k6Metric('measured_http_ms', 'p(99)'),
    completedRps: finite(measurements.completedRequestsPerSecond), successfulRps: finite(measurements.successfulRequestsPerSecond),
    ...Object.fromEntries([['fetchAndAssemble', 'fetch_and_assemble_ms'], ['jdbcExecute', 'jdbc_execute_ms'], ['assembly', 'assembly_ms']]
      .flatMap(([key, name]) => [[`${key}P50Ms`, k6Metric(name, 'med')], [`${key}P95Ms`, k6Metric(name, 'p(95)')]])),
    acquireMeanMs: finite(pool?.acquire?.meanMs), usageMeanMs: finite(pool?.usage?.meanMs),
    sampledMaxPending: finite(pool?.sampledMaxPending), timeoutCount: finite(pool?.timeoutCount),
  };
  const durationMs = finite(report?.k6?.metadata?.durationMs);
  const timeoutMs = finite(report?.k6?.metadata?.requestTimeoutMs);
  const elapsedMs = finite(measurements.measuredElapsedMs);
  const windowExceeded = durationMs > 0 && timeoutMs > 0 && elapsedMs > durationMs + timeoutMs + 2000;
  issue(!(durationMs > 0 && timeoutMs > 0 && elapsedMs > 0), 'Measurement-window metadata is missing');
  issue(windowExceeded, 'Measurement-window clock-gap guard: elapsed exceeds duration + request timeout + 2000ms');
  if (report) {
    issue(!['completed', 'load_failed'].includes(report.status), `Report status is ${report.status ?? 'missing'}`);
    issue(Boolean(report.error), `Report error: ${report.error}`);
    issue(report.datasetUnchanged !== true || !isDeepStrictEqual(report.datasetBefore, point.datasetBaseline)
      || !isDeepStrictEqual(report.datasetAfter, point.datasetBaseline), 'Dataset changed or differs from point baseline');
    issue(report.pollErrorCount !== 0, 'Pool polling failed or status is unknown');
    issue(!pool, 'Exactly one measured pool is required');
    if (pool) {
      issue(pool.configuredMaximum !== point.poolSize, 'Pool maximum differs from requested condition');
      issue(pool.counterReset !== false || pool.sampledMaximumChanged !== false, 'Pool counters/settings changed or unknown');
      issue(!Array.isArray(pool.missingMetrics) || pool.missingMetrics.length !== 0, 'Pool metrics are missing');
      issue(pool.acquisitionCountMinusCompletedRequests !== 0, 'Pool acquisition attempts differ from completed requests');
    }
    issue(report.runner?.cliTerminated !== true || !['removed', 'already_absent'].includes(report.runner?.cleanup?.after?.status), 'Load cleanup/CLI termination was not confirmed');
    issue(Boolean(report.runner?.stopReason) || Boolean(report.runner?.spawnError) || Boolean(report.runner?.outputLimitExceeded), 'Load runner interrupted or failed');
    for (const name of ['strategy', 'model', 'vus']) issue(parameters[name] !== point[name], `Report parameter ${name} differs from condition`);
    issue(!isDeepStrictEqual(parameters.ids, ids), 'Report IDs differ from fixed query IDs');
    issue(parameters.durationMs !== durationMs, 'Report duration differs from k6 duration');
    for (const name of ['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations']) issue(!count(measurements[name]), `Invalid or missing ${name}`);
    issue(measurements.successfulRequests > measurements.completedRequests || measurements.completedRequests > measurements.startedRequests
      || measurements.startedRequests - measurements.completedRequests !== measurements.incompleteRequests, 'Request counts are inconsistent');
    if (rows && ['v1', 'v2'].includes(point.strategy)) {
      // Trend count equals successful responses because only contract-valid responses contribute.
      for (const [name, value] of [['returned_rows', rows[point.strategy]], ['query_count', rows.queries[point.strategy].length],
        ...rows.queries[point.strategy].map((value, index) => [`query_${index + 1}_rows`, value])]) {
        issue(k6Metric(name, 'count') !== measurements.successfulRequests || k6Metric(name, 'min') !== value || k6Metric(name, 'max') !== value,
          `Measured ${name} min/max/count differs from expected rows/SELECTs/successes`);
      }
    }
  }
  const failures = [];
  const fail = (condition, message) => { if (condition) failures.push(message); };
  const exitCode = point.exitCode ?? report?.runner?.exitCode ?? null;
  fail(exitCode !== 0 || report?.runner?.exitCode !== 0, 'Nonzero or unknown exit code');
  fail(report?.status !== 'completed', `Load status is ${report?.status ?? 'missing'}`);
  fail(measurements.httpErrorRate !== 0 || measurements.contractErrorRate !== 0, 'HTTP/contract errors or unknown error rates');
  fail(measurements.incompleteRequests !== 0 || measurements.droppedIterations !== 0, 'Incomplete or dropped iterations');
  fail(pool?.timeoutCount !== 0, 'Pool timeouts or unknown timeout count');
  fail(!(measurements.completedRequests > 0) || measurements.successfulRequests !== measurements.completedRequests, 'No successful load or not all completions succeeded');
  fail(metricNames.filter((name) => name !== 'httpP99Ms').some((name) => metrics[name] == null || metrics[name] < 0), 'Required latency/throughput/server/pool metrics are missing');
  return {
    sequence: point.sequence ?? null, stage: point.stage, scenario: `${c}/${a}`, commentsPerPost: c, attachmentsPerPost: a,
    expectedRows: rows ? { v1: rows.v1, v2: rows.v2 } : null,
    actualRows: k6Metric('returned_rows', 'min') === k6Metric('returned_rows', 'max') ? k6Metric('returned_rows', 'min') : null,
    queryCount: k6Metric('query_count', 'min') === k6Metric('query_count', 'max') ? k6Metric('query_count', 'min') : null,
    queryRows: rows && ['v1', 'v2'].includes(point.strategy) ? rows.queries[point.strategy].map((_, index) => ({
      min: k6Metric(`query_${index + 1}_rows`, 'min'), max: k6Metric(`query_${index + 1}_rows`, 'max') })) : [],
    route: point.route, poolSize: point.poolSize, model: point.model, vus: point.vus,
    repeat: point.repeat, strategy: point.strategy, order: point.order, report: point.report,
    reportStatus: report?.status ?? 'missing', exitCode, metrics,
    requests: Object.fromEntries(['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations', 'httpErrorRate', 'contractErrorRate'].map((name) => [name, finite(measurements[name])])),
    measurementValid: issues.length === 0, clean: issues.length === 0 && failures.length === 0, measurementIssues: issues, loadFailures: failures,
    measurementWindow: { durationMs, requestTimeoutMs: timeoutMs, measuredElapsedMs: elapsedMs, exceeded: windowExceeded },
    p99EnoughSamples: measurements.successfulRequests >= 1000,
    settings: canonical({ ids: parameters.ids ?? null, durationMs: parameters.durationMs ?? null, requestTimeout: parameters.requestTimeout ?? null,
      baseUrl: parameters.baseUrl ?? null, dockerBaseUrl: parameters.dockerBaseUrl ?? null, dataset: report?.datasetBefore ?? null }),
  };
}

function groupRuns(runs, expectedRepeats) {
  const first = runs[0];
  const variants = new Set(runs.filter((run) => run.measurementValid).map((run) => JSON.stringify(run.settings)));
  const repeats = new Set(runs.map((run) => run.repeat));
  if (Number.isInteger(expectedRepeats) && expectedRepeats > 0) for (let repeat = 1; repeat <= expectedRepeats; repeat++) repeats.add(repeat);
  const members = { v1: [], v2: [] };
  const pairs = [...repeats].sort((a, b) => a - b).map((repeat) => {
    const selected = Object.fromEntries(['v1', 'v2'].map((strategy) => [strategy, runs.filter((run) => run.repeat === repeat && run.strategy === strategy)]));
    const issues = [];
    for (const strategy of ['v1', 'v2']) if (selected[strategy].length !== 1) issues.push(`${strategy} has ${selected[strategy].length} runs; exactly one is required`);
    const left = selected.v1.length === 1 ? selected.v1[0] : null; const right = selected.v2.length === 1 ? selected.v2[0] : null;
    if (left && right && !isDeepStrictEqual(left.settings, right.settings)) issues.push('Paired workload settings differ');
    if (variants.size > 1) issues.push('Settings differ between repeats');
    if (left && right && !([left.order, right.order].sort().join() === '1,2')) issues.push('AB/BA order is invalid');
    const clean = issues.length === 0 && left?.clean === true && right?.clean === true;
    if (clean) { members.v1.push(left); members.v2.push(right); }
    return { repeat, clean, issues, firstStrategy: left?.order === 1 ? 'v1' : right?.order === 1 ? 'v2' : null,
      statuses: { v1: left?.reportStatus ?? null, v2: right?.reportStatus ?? null }, reports: { v1: left?.report ?? null, v2: right?.report ?? null },
      metrics: left && right ? Object.fromEntries(metricNames.map((name) => {
        const a = left.metrics[name]; const b = right.metrics[name];
        return [name, { v1: a, v2: b, v2MinusV1: a != null && b != null ? b - a : null, v2OverV1: a > 0 && b != null ? b / a : null }];
      })) : null };
  });
  const cleanPairs = pairs.filter((pair) => pair.clean);
  const summarizePairs = (selected) => Object.fromEntries(metricNames.map((name) => {
    const differences = selected.map((pair) => pair.metrics[name].v2MinusV1).filter(Number.isFinite);
    const lowerBetter = !['completedRps', 'successfulRps'].includes(name);
    return [name, { v2MinusV1: distribution(differences), v2OverV1: distribution(selected.map((pair) => pair.metrics[name].v2OverV1)),
      v2Better: differences.filter((value) => lowerBetter ? value < -1e-10 : value > 1e-10).length,
      v1Better: differences.filter((value) => lowerBetter ? value > 1e-10 : value < -1e-10).length,
      equal: differences.filter((value) => Math.abs(value) <= 1e-10).length }];
  }));
  const rows = first.expectedRows;
  return { stage: first.stage, scenario: first.scenario, commentsPerPost: first.commentsPerPost, attachmentsPerPost: first.attachmentsPerPost,
    expectedRows: rows, actualRows: Object.fromEntries(['v1', 'v2'].map((strategy) => [strategy, distribution(members[strategy].map((run) => run.actualRows))])),
    rowRatio: rows?.v2 > 0 ? rows.v1 / rows.v2 : null, rowReductionRate: rows?.v1 > 0 ? 1 - rows.v2 / rows.v1 : null,
    recordedRuns: runs.length, recordedPairs: pairs.length, cleanPairs: cleanPairs.length, settingVariantCount: variants.size,
    scanSettings: variants.size === 1 ? { ...runs.find((run) => run.measurementValid).settings, dataset: expectedFixed } : null,
    pairedRunMetrics: { v1: summarize(members.v1), v2: summarize(members.v2) }, pairMetrics: summarizePairs(cleanPairs),
    byFirstStrategy: Object.fromEntries(['v1', 'v2'].map((strategy) => {
      const selected = cleanPairs.filter((pair) => pair.firstStrategy === strategy);
      return [strategy, { pairs: selected.length, metrics: summarizePairs(selected) }];
    })),
    strategies: Object.fromEntries(['v1', 'v2'].map((strategy) => {
      const selected = runs.filter((run) => run.strategy === strategy);
      return [strategy, { recordedRuns: selected.length, cleanRuns: selected.filter((run) => run.clean).length,
        allRecordedMetrics: summarize(selected), ...Object.fromEntries(['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations']
          .map((name) => [name, selected.reduce((total, run) => total + (run.requests[name] ?? 0), 0)])) }];
    })), pairs };
}

export function findCrossovers(groups) {
  const scans = new Map();
  for (const group of groups.filter((group) => group.scanSettings)) {
    const key = JSON.stringify([group.stage, canonical(group.scanSettings)]);
    if (!scans.has(key)) scans.set(key, []);
    scans.get(key).push(group);
  }
  return [...scans.values()].map((selected) => {
    const observations = selected.map((group) => {
      const classify = (name) => group.cleanPairs === 0 ? 'unavailable' : group.pairMetrics[name].v1Better === group.cleanPairs ? 'v1'
        : group.pairMetrics[name].v2Better === group.cleanPairs ? 'v2' : 'mixed';
      return { scenario: group.scenario, joinRows: group.expectedRows.v1, cleanPairs: group.cleanPairs,
        p50Winner: classify('httpP50Ms'), p95Winner: classify('httpP95Ms') };
    }).sort((a, b) => a.joinRows - b.joinRows || a.scenario.localeCompare(b.scenario, undefined, { numeric: true }));
    const bands = [];
    for (const metric of ['p50', 'p95']) {
      let previous = null;
      for (const observation of observations) {
        if (!['v1', 'v2'].includes(observation[`${metric}Winner`])) continue;
        if (previous && previous[`${metric}Winner`] !== observation[`${metric}Winner`]) bands.push({ metric,
          lowerScenario: previous.scenario, upperScenario: observation.scenario, lowerJoinRows: previous.joinRows, upperJoinRows: observation.joinRows,
          lowerWinner: previous[`${metric}Winner`], upperWinner: observation[`${metric}Winner`] });
        previous = observation;
      }
    }
    return { stage: selected[0].stage, scanSettings: selected[0].scanSettings, observations, bands };
  });
}

export function analyzeCardinality(campaign, loadedReports) {
  if (campaign?.experiment !== 'cardinality' || campaign.schemaVersion !== 1 || !Array.isArray(campaign.points)) throw new Error('Expected cardinality campaign schemaVersion 1 with points');
  const reports = loadedReports instanceof Map ? loadedReports : new Map(Object.entries(loadedReports));
  const points = campaign.points.filter((point) => point.phase === 'measure');
  const runs = points.map((point) => normalizeRun(point, reports.get(point.report), campaign));
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.stage, run.commentsPerPost, run.attachmentsPerPost]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const grouped = [...groups.values()].map((selected) => groupRuns(selected, campaign.parameters?.repeatsByStage?.[selected[0].stage] ?? campaign.parameters?.repeats))
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.commentsPerPost - b.commentsPerPost || a.attachmentsPerPost - b.attachmentsPerPost);
  const expected = finite(campaign.parameters?.totalMeasuredRuns);
  const terminal = ['completed', 'completed_with_load_failures'].includes(campaign.status) && Number.isFinite(Date.parse(campaign.completedAt));
  const warnings = (campaign.warnings ?? []).map((warning) => `[campaign] ${warning}`);
  if (!terminal) warnings.push('Campaign is incomplete; analysis may be partial.');
  if (expected !== runs.length) warnings.push(`Recorded ${runs.length} of ${expected ?? 'unknown'} planned measured runs.`);
  if (runs.some((run) => !run.clean)) warnings.push('Failed/invalid runs are retained and excluded from common clean pairs.');
  if (campaign.restoreFailed) warnings.push('Campaign reported restoration failure.');
  for (const group of grouped) {
    if (group.cleanPairs < 5) warnings.push(`${group.stage}/${group.scenario}: ${group.cleanPairs} clean pairs, fewer than five.`);
    if (group.settingVariantCount > 1) warnings.push(`${group.stage}/${group.scenario}: mixed settings prevent comparisons.`);
  }
  return { schemaVersion: 1, experiment: 'cardinality', analyzedAt: new Date().toISOString(), campaignStatus: campaign.status, parameters: campaign.parameters ?? {},
    coverage: { campaignComplete: terminal && expected === runs.length, expectedMeasuredRuns: expected, measuredRuns: runs.length,
      excludedWarmupPoints: campaign.points.filter((point) => point.phase === 'warmup').length,
      measurementValidRuns: runs.filter((run) => run.measurementValid).length, cleanRuns: runs.filter((run) => run.clean).length },
    methodology: [
      'One complete execution is one replicate; headline metrics use matched clean repeat pairs and unweighted run median [observed min,max]. Ranges are not confidence intervals; percentiles are not pooled.',
      'Cardinality is the paired comments/attachments scenario. Post count=200, IDs=1..10, bodyBytes=1024, seed=42, UNIFORM, direct DB route, pool=10 and VU=1 are fixed.',
      'totalRows counts returned flat rows, not database scan rows or network bytes. jdbcExecuteMs is JDBC execute-call duration, not pure PostgreSQL execution time.',
      'fetchAndAssembleMs excludes HTTP serialization; assemblyMs excludes materializing JDBC results. Different timers cannot be subtracted to establish causal CPU/network contributions.',
      'HTTP p99 is auxiliary; executions with fewer than 1000 successful responses are flagged in raw analysis. Closed-loop RPS is completed work at VU 1, not maximum service capacity.',
      'Crossover bands join opposite consistent winners in observed scenarios; exact thresholds are not fitted. Scenario paths vary two child counts and are not a universal scalar threshold.',
      'Exploration and confirmation stages, incompatible duration/IDs/timeouts/API settings remain separate. Elapsed time above duration + timeout + 2000ms is invalid.',
    ], warnings, groups: grouped, crossovers: findCrossovers(grouped), runs };
}

const number = (value) => Number.isFinite(value) ? value.toFixed(3) : '—';
const range = (value) => value?.n ? `${number(value.median)} [${number(value.min)}, ${number(value.max)}]` : '—';
export function toMarkdown(analysis) {
  const lines = ['# Cardinality 실험 자동 분석', '', `상태 ${analysis.campaignStatus}: 측정 ${analysis.coverage.measuredRuns}회, 계측 유효 ${analysis.coverage.measurementValidRuns}회, 정상 ${analysis.coverage.cleanRuns}회. 워밍업 ${analysis.coverage.excludedWarmupPoints}회 제외.`, '',
    '실행별 통계의 중앙값 [관측 최솟값, 최댓값]. 동일 반복에서 양쪽 모두 정상인 쌍만 주요 비교에 사용한다.', '', ...analysis.warnings.map((warning) => `- ${warning}`), '',
    '| 단계 | 댓글/첨부 | 정상 쌍 | 예상 v1 rows | 실측 v1 rows | 예상 v2 rows | 실측 v2 rows | v1/v2 rows | 행 감소율 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const group of analysis.groups) lines.push(`| ${group.stage} | ${group.scenario} | ${group.cleanPairs}/${group.recordedPairs} | ${group.expectedRows?.v1 ?? '—'} | ${range(group.actualRows.v1)} | ${group.expectedRows?.v2 ?? '—'} | ${range(group.actualRows.v2)} | ${number(group.rowRatio)} | ${number(group.rowReductionRate * 100)}% |`);
  for (const group of analysis.groups) {
    lines.push('', `## ${group.stage}: ${group.scenario}`, '', '| 전략 | HTTP p50 ms | HTTP p95 ms | HTTP p99 ms | 완료 RPS | 성공 RPS |', '|---|---:|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) { const m = group.pairedRunMetrics[strategy]; lines.push(`| ${strategy} | ${range(m.httpP50Ms)} | ${range(m.httpP95Ms)} | ${range(m.httpP99Ms)} | ${range(m.completedRps)} | ${range(m.successfulRps)} |`); }
    lines.push('', '| 전략 | fetchAndAssemble p50 ms | JDBC execute p50 ms | assembly p50 ms | acquire 평균 ms | usage 평균 ms |', '|---|---:|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) { const m = group.pairedRunMetrics[strategy]; lines.push(`| ${strategy} | ${range(m.fetchAndAssembleP50Ms)} | ${range(m.jdbcExecuteP50Ms)} | ${range(m.assemblyP50Ms)} | ${range(m.acquireMeanMs)} | ${range(m.usageMeanMs)} |`); }
    lines.push('', `쌍별 p95 v2/v1 ${range(group.pairMetrics.httpP95Ms.v2OverV1)}. v2 유리 ${group.pairMetrics.httpP95Ms.v2Better}쌍, v1 유리 ${group.pairMetrics.httpP95Ms.v1Better}쌍.`, '');
  }
  lines.push('## 관측 역전 구간', '');
  for (const scan of analysis.crossovers) {
    lines.push(`- ${scan.stage} (${scan.scanSettings.durationMs / 1000}s): ${scan.observations.map((row) => `${row.scenario}: p50 ${row.p50Winner}, p95 ${row.p95Winner}`).join('; ')}`);
    for (const band of scan.bands) lines.push(`- ${band.metric}: ${band.lowerScenario} (${band.lowerJoinRows} JOIN rows, ${band.lowerWinner}) → ${band.upperScenario} (${band.upperJoinRows} JOIN rows, ${band.upperWinner}). 정확한 전환점을 추정하지 않는다.`);
    if (!scan.bands.length) lines.push('- 반복 쌍에서 방향이 일관된 역전 구간을 확인하지 못했다.');
  }
  const failures = analysis.runs.filter((run) => !run.clean);
  if (failures.length) {
    lines.push('', '## 실패·계측 무효 실행(삭제하지 않음)', '');
    for (const run of failures) lines.push(`- ${run.stage} ${run.scenario} 반복 ${run.repeat} ${run.strategy} (${run.report}): ${[...run.measurementIssues, ...run.loadFailures].join('; ')}`);
  }
  lines.push('', '## 해석 범위', '', ...analysis.methodology.map((line) => `- ${line}`), '');
  return lines.join('\n');
}

export function toCsv(analysis) {
  const columns = ['stage', 'scenario', 'commentsPerPost', 'attachmentsPerPost', 'repeat', 'strategy', 'order', 'reportStatus', 'exitCode', 'measurementValid', 'clean', 'actualRows', 'queryCount', 'p99EnoughSamples', ...metricNames,
    'startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations', 'httpErrorRate', 'contractErrorRate', 'measurementIssues', 'loadFailures', 'report'];
  const escape = (value) => { const string = value == null ? '' : String(value); return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string; };
  return [columns.join(','), ...analysis.runs.map((run) => {
    const row = { ...run, ...run.metrics, ...run.requests, measurementIssues: run.measurementIssues.join('; '), loadFailures: run.loadFailures.join('; ') };
    return columns.map((name) => escape(row[name])).join(',');
  })].join('\n') + '\n';
}

export async function loadCardinality(input) {
  const campaignPath = extname(input).toLowerCase() === '.json' ? resolve(input) : resolve(input, 'campaign.json');
  const parse = (value) => JSON.parse(value.replace(/^\uFEFF/, ''));
  const campaign = parse(await readFile(campaignPath, 'utf8')); const reports = new Map();
  const protectedPaths = new Set([campaignPath]);
  for (const point of campaign.points ?? []) {
    if (!point.report) continue;
    const path = isAbsolute(point.report) ? point.report : resolve(dirname(campaignPath), point.report);
    protectedPaths.add(path);
    if (point.phase !== 'measure') continue;
    try { reports.set(point.report, { report: parse(await readFile(path, 'utf8')) }); }
    catch (error) { reports.set(point.report, { readError: error.message }); }
  }
  return { campaignPath, campaign, reports, protectedPaths };
}

async function main() {
  const args = process.argv.slice(2); let input; let output;
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index + 1]) throw new Error(`Missing value for ${args[index]}`);
    if (args[index] === '--input') input = args[index + 1]; else if (args[index] === '--output') output = args[index + 1]; else throw new Error(`Unknown option ${args[index]}`);
  }
  if (!input) throw new Error('Use --input <campaign-directory-or-json> [--output <prefix>]');
  const loaded = await loadCardinality(input);
  const prefix = output ? resolve(output).replace(/\.(json|md)$/i, '') : join(dirname(loaded.campaignPath), 'analysis');
  const targets = [`${prefix}.json`, `${prefix}.md`, output ? `${prefix}-runs.csv` : join(dirname(prefix), 'runs.csv')];
  const normalized = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const protectedPaths = new Set([...loaded.protectedPaths].map(normalized));
  if (targets.some((path) => protectedPaths.has(normalized(path)))) throw new Error('Analysis must not overwrite campaign or raw reports');
  const result = analyzeCardinality(loaded.campaign, loaded.reports);
  await mkdir(dirname(prefix), { recursive: true });
  await writeFile(targets[0], JSON.stringify(result, null, 2) + '\n'); await writeFile(targets[1], toMarkdown(result)); await writeFile(targets[2], toCsv(result));
  console.log(JSON.stringify({ outputs: targets, coverage: result.coverage, crossovers: result.crossovers, warnings: result.warnings }, null, 2));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
