import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { distribution } from './analyze-study.mjs';

const metricNames = ['httpP50Ms', 'httpP95Ms', 'httpP99Ms', 'completedRps', 'successfulRps',
  'acquireMeanMs', 'acquireP95Ms', 'usageMeanMs', 'usageP95Ms', 'sampledMaxPending', 'timeoutCount'];
const finite = (value) => Number.isFinite(value) ? value : null;
const validCount = (value) => Number.isInteger(value) && value >= 0;
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const summarize = (runs) => Object.fromEntries(metricNames.map((name) => [name, distribution(runs.map((run) => run.metrics[name]))]));

function proxyIssues(snapshot, rttMs, label) {
  const issues = [];
  if (!snapshot || snapshot.name !== 'querylab-postgres' || snapshot.enabled !== true
    || snapshot.upstream !== 'db:5432' || !['0.0.0.0:8666', '[::]:8666'].includes(snapshot.listen)) {
    issues.push(`Saved ${label} proxy identity, endpoint or enabled state is invalid`);
  }
  if (!Array.isArray(snapshot?.toxics)) return [...issues, `Saved ${label} toxic configuration is missing`];
  if (!validCount(rttMs)) return issues;
  const expected = { upstream: Math.floor(rttMs / 2), downstream: Math.ceil(rttMs / 2) };
  for (const toxic of snapshot.toxics) {
    if (!toxic || !['upstream', 'downstream'].includes(toxic.stream)
      || toxic.name !== `querylab-rtt-${toxic.stream}` || toxic.type !== 'latency'
      || toxic.latencyMs !== expected[toxic.stream] || toxic.jitterMs !== 0 || toxic.toxicity !== 1) {
      issues.push(`Saved ${label} toxic differs from requested RTT/direction/jitter/toxicity`);
    }
  }
  for (const stream of ['upstream', 'downstream']) {
    const count = snapshot.toxics.filter((toxic) => toxic?.stream === stream).length;
    if (count !== (expected[stream] > 0 ? 1 : 0)) issues.push(`Saved ${label} ${stream} toxic is missing, duplicated or unexpectedly present at zero delay`);
  }
  return issues;
}

function normalizeRun(point, loaded, campaign) {
  const report = loaded?.report ?? (loaded && !loaded.readError ? loaded : null);
  const parameters = report?.parameters ?? {};
  const pool = report?.pools?.length === 1 ? report.pools[0] : null;
  const measurements = report?.k6?.measurements ?? {};
  const k6Metadata = report?.k6?.metadata ?? {};
  const durationMs = finite(k6Metadata.durationMs);
  const requestTimeoutMs = finite(k6Metadata.requestTimeoutMs);
  const measuredElapsedMs = finite(measurements.measuredElapsedMs);
  // buildMeasuredScenario sets gracefulStop=requestTimeout. The measured elapsed
  // value ends at the last HTTP completion, so allow that full drain plus a
  // conservative 2s scheduling allowance; a much longer gap invalidates the
  // intended measurement window without asserting that host sleep caused it.
  const schedulingToleranceMs = 2000;
  const windowChecked = durationMs > 0 && requestTimeoutMs > 0 && measuredElapsedMs != null;
  const maximumElapsedMs = windowChecked ? durationMs + requestTimeoutMs + schedulingToleranceMs : null;
  const measurementWindow = { checked: windowChecked, durationMs, requestTimeoutMs, measuredElapsedMs,
    schedulingToleranceMs, maximumElapsedMs, exceeded: windowChecked && measuredElapsedMs > maximumElapsedMs };
  const issues = [];
  const issue = (condition, message) => { if (condition) issues.push(message); };
  issue(!report, loaded?.readError ?? 'Report is missing');
  issue(!['baseline', 'sweep', 'refine', 'load'].includes(point.stage), 'Unknown experiment stage');
  issue(!['direct', 'proxy'].includes(point.route), 'Unknown database route');
  issue(!validCount(point.rttMs), 'Added RTT must be a nonnegative integer');
  issue(point.route === 'direct' && point.rttMs !== 0, 'Direct baseline must have zero injected RTT');
  issue(!Number.isInteger(point.poolSize) || point.poolSize < 1, 'Expected pool size is invalid');
  issue(!['closed', 'arrival'].includes(point.model), 'Unknown load model');
  issue(point.model === 'closed' && !(point.vus > 0), 'Expected VUs are missing');
  issue(point.model === 'arrival' && !(point.rate > 0), 'Expected arrival rate is missing');
  issue(!['v1', 'v2'].includes(point.strategy), 'Unknown strategy');
  issue(!Number.isInteger(point.repeat) || point.repeat < 1, 'Repeat number is invalid');
  for (const name of ['datasetMatchesBaseline', 'poolMatchesExpected', 'cleanupConfirmed', 'measurementValid', 'proxyMatchesExpected']) {
    issue(point.validation?.[name] !== true, `Point validation ${name} failed or is unknown`);
  }
  issues.push(...proxyIssues(point.proxyBefore, point.rttMs, 'proxyBefore'), ...proxyIssues(point.proxyAfter, point.rttMs, 'proxyAfter'));
  issue(measurementWindow.exceeded, `Measured k6 scenario window ${measuredElapsedMs}ms exceeds duration + request-timeout drain + ${schedulingToleranceMs}ms scheduling allowance (${maximumElapsedMs}ms); possible clock gap or host suspension`);
  if (report) {
    issue(!['completed', 'load_failed'].includes(report.status), `Report status is ${report.status ?? 'unknown'}`);
    issue(Boolean(report.error), `Report error: ${report.error}`);
    issue(report.datasetUnchanged !== true, 'Dataset changed or its integrity is unknown');
    if (campaign.datasetBaseline != null) {
      issue(!isDeepStrictEqual(campaign.datasetBaseline, report.datasetBefore)
        || !isDeepStrictEqual(campaign.datasetBaseline, report.datasetAfter), 'Dataset differs from campaign baseline');
    }
    issue(report.pollErrorCount !== 0, 'Pool polling failed or its status is unknown');
    issue(!pool, 'Exactly one measured pool is required');
    if (pool) {
      issue(pool.configuredMaximum !== point.poolSize, 'Actual pool maximum differs from requested condition');
      issue(pool.counterReset !== false || pool.sampledMaximumChanged !== false, 'Pool counters or settings changed');
      issue(!Array.isArray(pool.missingMetrics) || pool.missingMetrics.length > 0, 'Required pool metrics are missing');
      issue(pool.acquisitionCountMinusCompletedRequests !== 0, 'Pool acquisition attempt count differs from completed requests');
    }
    issue(report.runner?.cliTerminated !== true, 'Load CLI termination was not confirmed');
    issue(!['removed', 'already_absent'].includes(report.runner?.cleanup?.after?.status), 'Load container cleanup was not confirmed');
    issue(Boolean(report.runner?.stopReason) || Boolean(report.runner?.spawnError)
      || Boolean(report.runner?.outputLimitExceeded), 'Load runner was interrupted or failed');
    for (const name of ['strategy', 'model', ...(point.model === 'closed' ? ['vus'] : ['rate'])]) {
      issue(parameters[name] !== point[name], `Report parameter ${name} differs from condition`);
    }
    for (const name of ['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations']) {
      issue(!validCount(measurements[name]), `Invalid or missing ${name}`);
    }
    issue(measurements.successfulRequests > measurements.completedRequests
      || measurements.completedRequests > measurements.startedRequests, 'Request counts are inconsistent');
  }
  const metric = (statistic) => finite(report?.k6?.results?.metrics?.measured_http_ms?.values?.[statistic]);
  const metrics = {
    httpP50Ms: metric('med'), httpP95Ms: metric('p(95)'), httpP99Ms: metric('p(99)'),
    completedRps: finite(measurements.completedRequestsPerSecond), successfulRps: finite(measurements.successfulRequestsPerSecond),
    acquireMeanMs: finite(pool?.acquire?.meanMs), acquireP95Ms: finite(pool?.acquire?.p95Ms),
    usageMeanMs: finite(pool?.usage?.meanMs), usageP95Ms: finite(pool?.usage?.p95Ms),
    sampledMaxPending: finite(pool?.sampledMaxPending), timeoutCount: finite(pool?.timeoutCount),
  };
  const loadFailures = [];
  const failure = (condition, message) => { if (condition) loadFailures.push(message); };
  const exitCode = point.exitCode ?? report?.runner?.exitCode ?? null;
  failure(exitCode !== 0, 'Nonzero or unknown exit code');
  failure(report?.status !== 'completed', `Load status is ${report?.status ?? 'missing'}`);
  failure(measurements.httpErrorRate !== 0 || measurements.contractErrorRate !== 0, 'HTTP or response contract errors');
  failure(measurements.incompleteRequests !== 0 || measurements.droppedIterations !== 0, 'Incomplete or dropped iterations');
  failure(pool?.timeoutCount !== 0, 'Pool timeouts or missing timeout count');
  failure(!(measurements.completedRequests > 0) || measurements.successfulRequests !== measurements.completedRequests, 'Not all completed requests succeeded');
  failure(['httpP50Ms', 'httpP95Ms', 'httpP99Ms', 'completedRps', 'successfulRps', 'acquireMeanMs', 'usageMeanMs']
    .some((name) => metrics[name] == null || metrics[name] < 0), 'Required latency, throughput or pool metrics are missing');
  return {
    sequence: point.sequence ?? null, stage: point.stage ?? null, route: point.route ?? null,
    rttMs: finite(point.rttMs), poolSize: finite(point.poolSize), model: point.model ?? null,
    vus: point.model === 'closed' ? finite(point.vus) : null, rate: point.model === 'arrival' ? finite(point.rate) : null,
    repeat: point.repeat ?? null, strategy: point.strategy ?? null, order: point.order ?? null,
    report: point.report ?? null, reportStatus: report?.status ?? 'missing', exitCode,
    measurementValid: issues.length === 0, clean: issues.length === 0 && loadFailures.length === 0,
    measurementIssues: issues, loadFailures, metrics, measurementWindow,
    requests: Object.fromEntries(['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations', 'httpErrorRate', 'contractErrorRate']
      .map((name) => [name, finite(measurements[name])])),
    settings: canonical({ ids: parameters.ids ?? null, durationMs: parameters.durationMs ?? null,
      requestTimeout: parameters.requestTimeout ?? null, baseUrl: parameters.baseUrl ?? null,
      dockerBaseUrl: parameters.dockerBaseUrl ?? null,
      preallocatedVus: point.model === 'arrival' ? parameters.preallocatedVus ?? null : null,
      maxVus: point.model === 'arrival' ? parameters.maxVus ?? null : null, dataset: report?.datasetBefore ?? null }),
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
    const left = selected.v1.length === 1 ? selected.v1[0] : null;
    const right = selected.v2.length === 1 ? selected.v2[0] : null;
    if (left && right && !isDeepStrictEqual(left.settings, right.settings)) issues.push('Paired workload settings differ');
    if (variants.size > 1) issues.push('Settings differ between repeats');
    const clean = issues.length === 0 && left?.clean === true && right?.clean === true;
    if (clean) { members.v1.push(left); members.v2.push(right); }
    return {
      repeat, clean, issues,
      statuses: { v1: left?.reportStatus ?? null, v2: right?.reportStatus ?? null },
      reports: { v1: left?.report ?? null, v2: right?.report ?? null },
      firstStrategy: left?.order === 1 && right?.order === 2 ? 'v1' : right?.order === 1 && left?.order === 2 ? 'v2' : null,
      metrics: left && right ? Object.fromEntries(metricNames.map((name) => {
        const a = left.metrics[name]; const b = right.metrics[name];
        return [name, { v1: a, v2: b, v2MinusV1: a != null && b != null ? b - a : null,
          v2OverV1: a > 0 && b != null ? b / a : null }];
      })) : null,
    };
  });
  const cleanPairs = pairs.filter((pair) => pair.clean);
  const pairMetrics = Object.fromEntries(metricNames.map((name) => {
    const values = cleanPairs.map((pair) => pair.metrics[name].v2MinusV1).filter(Number.isFinite);
    const lowerBetter = !['completedRps', 'successfulRps'].includes(name);
    return [name, { v2MinusV1: distribution(values),
      v2OverV1: distribution(cleanPairs.map((pair) => pair.metrics[name].v2OverV1)),
      v2Better: values.filter((value) => lowerBetter ? value < -1e-10 : value > 1e-10).length,
      v1Better: values.filter((value) => lowerBetter ? value > 1e-10 : value < -1e-10).length,
      equal: values.filter((value) => Math.abs(value) <= 1e-10).length }];
  }));
  return {
    stage: first.stage, route: first.route, rttMs: first.rttMs, poolSize: first.poolSize, model: first.model, vus: first.vus, rate: first.rate,
    scanSettingsSignature: variants.size === 1 ? [...variants][0] : null,
    scanSettings: variants.size === 1 ? runs.find((run) => run.measurementValid)?.settings ?? null : null,
    recordedRuns: runs.length, settingVariantCount: variants.size, recordedPairs: pairs.length, cleanPairs: cleanPairs.length,
    pairedRunMetrics: { v1: summarize(members.v1), v2: summarize(members.v2) }, pairMetrics,
    strategies: Object.fromEntries(['v1', 'v2'].map((strategy) => {
      const selected = runs.filter((run) => run.strategy === strategy);
      return [strategy, { recordedRuns: selected.length, cleanRuns: selected.filter((run) => run.clean).length,
        allCleanMetrics: summarize(selected.filter((run) => run.clean)), allRecordedMetrics: summarize(selected),
        dropped: selected.reduce((total, run) => total + (run.requests.droppedIterations ?? 0), 0),
        incomplete: selected.reduce((total, run) => total + (run.requests.incompleteRequests ?? 0), 0),
        timeouts: selected.reduce((total, run) => total + (run.metrics.timeoutCount ?? 0), 0) }];
    })), pairs,
  };
}

export function findCrossovers(groups) {
  const scans = new Map();
  for (const group of groups.filter((group) => ['sweep', 'refine'].includes(group.stage) && group.route === 'proxy'
    && group.model === 'closed' && group.vus === 1 && group.scanSettingsSignature != null)) {
    const key = JSON.stringify([group.stage, group.poolSize, group.scanSettingsSignature]);
    if (!scans.has(key)) scans.set(key, []);
    scans.get(key).push(group);
  }
  return [...scans.values()].map((selected) => {
    const { stage, poolSize, scanSettings, scanSettingsSignature } = selected[0];
    const rtts = [...new Set(selected.map((group) => group.rttMs))].sort((a, b) => a - b);
    const observations = rtts.map((rttMs) => {
      const paired = selected.filter((group) => group.rttMs === rttMs).flatMap((group) => group.pairs.filter((pair) => pair.clean));
      const differences = paired.map((pair) => pair.metrics.httpP50Ms.v2MinusV1);
      const p95Differences = paired.map((pair) => pair.metrics.httpP95Ms.v2MinusV1);
      const classify = (values) => values.length === 0 ? 'unavailable'
        : values.every((value) => value < -1e-10) ? 'v2' : values.every((value) => value > 1e-10) ? 'v1' : 'mixed';
      return { rttMs, cleanPairs: paired.length, p50V2MinusV1Ms: distribution(differences),
        p95V2MinusV1Ms: distribution(p95Differences), p50Winner: classify(differences), p95Winner: classify(p95Differences) };
    });
    const bands = [];
    for (const metric of ['p50', 'p95']) {
      let lastStable = null;
      for (const observation of observations) {
        const winner = observation[`${metric}Winner`];
        if (!['v1', 'v2'].includes(winner)) continue;
        if (lastStable && lastStable[`${metric}Winner`] !== winner) bands.push({ metric,
          lowerRttMs: lastStable.rttMs, upperRttMs: observation.rttMs,
          lowerWinner: lastStable[`${metric}Winner`], upperWinner: winner,
          interpretation: 'Observed interval between opposite, repeat-consistent winners; no exact crossover is estimated.' });
        lastStable = observation;
      }
    }
    return { stage, poolSize, scanSettings, scanSettingsSignature, observations, bands };
  });
}

export function analyzeLatency(campaign, loadedReports) {
  if (campaign?.experiment !== 'latency' || campaign.schemaVersion !== 1 || !Array.isArray(campaign.points)) {
    throw new Error('Expected latency campaign schemaVersion 1 with a points array');
  }
  const reports = loadedReports instanceof Map ? loadedReports : new Map(Object.entries(loadedReports));
  const points = campaign.points.filter((point) => point.phase === 'measure');
  const runs = points.map((point) => normalizeRun(point, reports.get(point.report), campaign));
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.stage, run.route, run.rttMs, run.poolSize, run.model, run.vus, run.rate]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const stages = ['baseline', 'sweep', 'refine', 'load'];
  const grouped = [...groups.values()].map((selected) => groupRuns(selected,
    campaign.parameters?.repeatsByStage?.[selected[0].stage] ?? campaign.parameters?.repeats))
    .sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage) || String(a.route).localeCompare(String(b.route))
      || a.poolSize - b.poolSize || String(a.model).localeCompare(String(b.model)) || (a.vus ?? a.rate) - (b.vus ?? b.rate) || a.rttMs - b.rttMs);
  const expectedRuns = finite(campaign.parameters?.totalMeasuredRuns);
  const allPlannedRunsRecorded = expectedRuns == null ? null : expectedRuns === runs.length;
  const terminal = ['completed', 'completed_with_load_failures'].includes(campaign.status);
  const warnings = Array.isArray(campaign.warnings) ? campaign.warnings.map((warning) => `[campaign] ${String(warning)}`) : [];
  if (!terminal || !Number.isFinite(Date.parse(campaign.completedAt))) warnings.push('Campaign is incomplete; analysis may be partial.');
  if (allPlannedRunsRecorded === false) warnings.push(`Recorded ${runs.length} of ${expectedRuns} planned measured runs.`);
  if (runs.some((run) => !run.clean)) warnings.push('Failed or invalid runs are retained and excluded from common clean latency pairs.');
  for (const run of runs.filter((run) => run.measurementWindow.exceeded)) {
    warnings.push(`Measurement-window clock-gap guard: ${run.report ?? 'unknown report'} exceeded configured duration + request-timeout drain + 2000ms scheduling allowance; treat as measurement invalid, with possible host suspension or clock discontinuity.`);
  }
  if (campaign.restoreFailed) warnings.push('Campaign reported a restoration failure.');
  for (const group of grouped) {
    if (group.cleanPairs < 5) warnings.push(`${group.stage}/${group.route}/${group.rttMs}ms/pool${group.poolSize}/${group.model}/${group.vus ?? group.rate}: ${group.cleanPairs} clean pairs; fewer than five.`);
    if (group.settingVariantCount > 1) warnings.push(`${group.stage}/${group.route}/${group.rttMs}ms: mixed settings prevent comparisons.`);
  }
  return {
    schemaVersion: 1, experiment: 'latency', analyzedAt: new Date().toISOString(), campaignStatus: campaign.status,
    parameters: campaign.parameters ?? {}, datasetBaseline: campaign.datasetBaseline ?? null,
    coverage: { campaignComplete: terminal && Number.isFinite(Date.parse(campaign.completedAt)) && allPlannedRunsRecorded !== false,
      expectedMeasuredRuns: expectedRuns, allPlannedRunsRecorded, measuredRuns: runs.length,
      excludedWarmupPoints: campaign.points.filter((point) => point.phase === 'warmup').length,
      excludedUnknownPhasePoints: campaign.points.filter((point) => !['measure', 'warmup'].includes(point.phase)).length,
      measurementValidRuns: runs.filter((run) => run.measurementValid).length, cleanRuns: runs.filter((run) => run.clean).length },
    methodology: [
      'Added RTT is the injected value, not measured network RTT. Calibration and proxy-zero baseline must be reviewed separately.',
      'One execution is one replicate. Tables summarize run-level statistics by unweighted median and observed minimum/maximum.',
      'Main comparisons use matched repeat pairs in which both strategies are clean; failed and unmatched runs remain in JSON/CSV.',
      'Request percentiles are not pooled. Observed ranges are not confidence intervals.',
      'Closed VUs do not imply equal arrival rates. Arrival failures/dropped iterations are excluded from clean latency comparisons.',
      'Crossover intervals use opposite winners consistent across observed clean pairs; exact crossing points are not fitted.',
      'Crossover scans and plotted lines keep experiment stages and compatible duration/IDs/timeouts/API endpoints/dataset settings separate.',
      'Hikari p95 values are histogram estimates; pending maxima are sampled observations.',
      'For reports with k6 duration/request-timeout metadata, elapsed scenario time above duration + gracefulStop(requestTimeout) + 2000ms is invalid. The 2s allowance accommodates scheduling; exceeding it does not prove host suspension.',
    ], warnings, groups: grouped, crossovers: findCrossovers(grouped), runs,
  };
}

const number = (value) => !Number.isFinite(value) ? '—' : Math.abs(value) < 0.01 && value !== 0 ? value.toFixed(4) : value.toFixed(2);
const range = (value) => value?.n ? `${number(value.median)} [${number(value.min)}, ${number(value.max)}]` : '—';
const title = (group) => `${group.stage} · ${group.route} · 추가 RTT ${group.rttMs}ms · 풀 ${group.poolSize} · ${group.model === 'closed' ? `${group.vus} VU` : `${group.rate} req/s`}`;

export function toMarkdown(analysis) {
  const lines = ['# DB 지연 주입 실험 분석', '',
    `캠페인 상태: ${analysis.campaignStatus}. 측정 ${analysis.coverage.measuredRuns}회, 계측 유효 ${analysis.coverage.measurementValidRuns}회, 정상 ${analysis.coverage.cleanRuns}회. 워밍업 ${analysis.coverage.excludedWarmupPoints}회 제외.`, '',
    '**실행별 통계의 중앙값 [최솟값, 최댓값]**이며 신뢰구간이나 요청을 합친 백분위가 아니다. 주요 비교는 동일 반복에서 양쪽 모두 정상인 공통 쌍만 사용한다. RTT는 주입 설정값이며 실제 RTT는 보정 결과를 별도로 확인한다.', ''];
  for (const warning of analysis.warnings) lines.push(`- ${warning}`);
  lines.push('', '## 낮은 동시성에서 관측한 역전 구간', '');
  if (!analysis.crossovers.length) lines.push('관측 가능한 VU 1 proxy sweep/refine 결과가 없다.', '');
  for (const crossover of analysis.crossovers) {
    lines.push(`### ${crossover.stage} · 풀 ${crossover.poolSize} · 측정 ${number(crossover.scanSettings?.durationMs / 1000)}초`, '', '| 추가 RTT ms | 정상 쌍 | p50 v2−v1 ms | p50 일관된 우위 | p95 v2−v1 ms | p95 일관된 우위 |', '|---:|---:|---:|---|---:|---|');
    for (const row of crossover.observations) lines.push(`| ${row.rttMs} | ${row.cleanPairs} | ${range(row.p50V2MinusV1Ms)} | ${row.p50Winner} | ${range(row.p95V2MinusV1Ms)} | ${row.p95Winner} |`);
    lines.push('');
    if (!crossover.bands.length) lines.push('반복 쌍에서 방향이 일관된 역전 구간을 확인하지 못했다.', '');
    for (const band of crossover.bands) lines.push(`- ${band.metric}: 추가 RTT ${band.lowerRttMs}~${band.upperRttMs}ms 사이에서 ${band.lowerWinner} → ${band.upperWinner}. 관측한 두 설정 사이의 구간이며 정확한 전환점을 추정하지 않는다.`);
    lines.push('');
  }
  lines.push('## 조건별 공통 정상 비교', '');
  for (const group of analysis.groups) {
    lines.push(`### ${title(group)}`, '', `공통 정상 비교 쌍: ${group.cleanPairs}/${group.recordedPairs}.`, '',
      '| 전략 | HTTP p50 ms | HTTP p95 ms | HTTP p99 ms | 완료 RPS | acquire 평균 ms | usage 평균 ms | 관측 pending 최대 |',
      '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) {
      const metrics = group.pairedRunMetrics[strategy];
      lines.push(`| ${strategy} | ${range(metrics.httpP50Ms)} | ${range(metrics.httpP95Ms)} | ${range(metrics.httpP99Ms)} | ${range(metrics.completedRps)} | ${range(metrics.acquireMeanMs)} | ${range(metrics.usageMeanMs)} | ${range(metrics.sampledMaxPending)} |`);
    }
    lines.push('', `쌍별 p95 v2−v1: ${range(group.pairMetrics.httpP95Ms.v2MinusV1)}ms. v2 유리 ${group.pairMetrics.httpP95Ms.v2Better}쌍, v1 유리 ${group.pairMetrics.httpP95Ms.v1Better}쌍, 동일 ${group.pairMetrics.httpP95Ms.equal}쌍.`, '',
      '| 전략 | 정상/기록 실행 | 전체 dropped | 전체 incomplete | 전체 pool timeout |', '|---|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) { const row = group.strategies[strategy]; lines.push(`| ${strategy} | ${row.cleanRuns}/${row.recordedRuns} | ${row.dropped} | ${row.incomplete} | ${row.timeouts} |`); }
    const excluded = group.pairs.filter((pair) => !pair.clean);
    if (excluded.length) {
      lines.push('', '정상 비교에서 제외한 쌍(원시 기록은 보존):');
      for (const pair of excluded) lines.push(`- 반복 ${pair.repeat}: v1=${pair.statuses.v1 ?? 'missing'}, v2=${pair.statuses.v2 ?? 'missing'}; ${pair.issues.join('; ') || '부하 실패 또는 계측 무효'}`);
    }
    lines.push('');
  }
  const failures = analysis.runs.filter((run) => !run.clean);
  if (failures.length) {
    lines.push('## 실패·계측 무효 실행(삭제하지 않음)', '');
    for (const run of failures) lines.push(`- ${title(run)} · 반복 ${run.repeat} · ${run.strategy} · ${run.reportStatus}: ${[...run.measurementIssues, ...run.loadFailures].join('; ')}`);
    lines.push('');
  }
  lines.push('## 해석 범위', '', ...analysis.methodology.map((line) => `- ${line}`), '');
  return `${lines.join('\n')}\n`;
}

export function toCsv(analysis) {
  const columns = ['stage', 'route', 'rttMs', 'poolSize', 'model', 'vus', 'rate', 'repeat', 'strategy', 'order', 'reportStatus', 'exitCode', 'measurementValid', 'clean', ...metricNames,
    'startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations', 'httpErrorRate', 'contractErrorRate', 'measurementIssues', 'loadFailures', 'report'];
  const escape = (value) => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
  return `${[columns.join(','), ...analysis.runs.map((run) => {
    const row = { ...run, ...run.metrics, ...run.requests, measurementIssues: run.measurementIssues.join('; '), loadFailures: run.loadFailures.join('; ') };
    return columns.map((column) => escape(row[column])).join(',');
  })].join('\n')}\n`;
}

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function toSvg(analysis) {
  const groups = analysis.groups.filter((group) => ['sweep', 'refine'].includes(group.stage) && group.route === 'proxy'
    && group.model === 'closed' && group.vus === 1 && group.cleanPairs > 0 && group.scanSettingsSignature != null);
  const scans = new Map();
  for (const group of groups) {
    const key = JSON.stringify([group.stage, group.poolSize, group.scanSettingsSignature]);
    if (!scans.has(key)) scans.set(key, []);
    scans.get(key).push(group);
  }
  const scanGroups = [...scans.values()];
  const width = 1080; const panelHeight = 300; const height = 110 + Math.max(1, scanGroups.length) * panelHeight;
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="HTTP latency versus injected database RTT">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    '<style>text{font-family:Arial,sans-serif;fill:#243247;font-size:12px}.title{font-size:22px;font-weight:700}.subtitle{font-size:12px;fill:#526078}.axis{stroke:#ccd4df;stroke-width:1}.grid{stroke:#e9edf2;stroke-width:1}</style>',
    '<text x="40" y="32" class="title">HTTP latency vs. injected database RTT</text>',
    '<text x="40" y="56" class="subtitle">1 VU · matched clean pairs · run medians; whiskers show observed run min/max (not confidence intervals)</text>',
    '<text x="40" y="77" style="fill:#2166ac">v1 single JOIN</text><text x="190" y="77" style="fill:#c43c39">v2 split SELECTs</text>'];
  if (!scanGroups.length) output.push('<text x="40" y="150">No clean low-concurrency proxy sweep/refinement data is available.</text>');
  for (const [scanIndex, scanGroupsForSettings] of scanGroups.entries()) for (const [metricIndex, metric] of ['httpP50Ms', 'httpP95Ms'].entries()) {
    const selected = [...scanGroupsForSettings].sort((a, b) => a.rttMs - b.rttMs);
    const { stage, poolSize: pool, scanSettings } = selected[0];
    const left = 70 + metricIndex * 520; const top = 125 + scanIndex * panelHeight; const plotWidth = 435; const plotHeight = 200;
    const maxX = Math.max(1, ...selected.map((group) => group.rttMs));
    const maxY = Math.max(1, ...selected.flatMap((group) => ['v1', 'v2'].map((strategy) => group.pairedRunMetrics[strategy][metric].max ?? 0))) * 1.08;
    const x = (value) => left + plotWidth * value / maxX; const y = (value) => top + plotHeight - plotHeight * value / maxY;
    output.push(`<text x="${left}" y="${top - 17}" font-weight="700">${xml(stage)} · Pool ${pool} · ${number(scanSettings?.durationMs / 1000)}s · HTTP ${metric === 'httpP50Ms' ? 'p50' : 'p95'} (ms)</text>`);
    for (let index = 0; index <= 4; index++) {
      const value = maxY * index / 4; const yy = y(value);
      output.push(`<line class="grid" x1="${left}" x2="${left + plotWidth}" y1="${yy}" y2="${yy}"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end">${value.toFixed(0)}</text>`);
      const xx = x(maxX * index / 4);
      output.push(`<text x="${xx}" y="${top + plotHeight + 20}" text-anchor="middle">${(maxX * index / 4).toFixed(1)}</text>`);
    }
    output.push(`<line class="axis" x1="${left}" x2="${left + plotWidth}" y1="${top + plotHeight}" y2="${top + plotHeight}"/><text x="${left + plotWidth / 2}" y="${top + plotHeight + 43}" text-anchor="middle">Added RTT (ms)</text>`);
    for (const [strategy, color] of [['v1', '#2166ac'], ['v2', '#c43c39']]) {
      const values = selected.filter((group) => group.pairedRunMetrics[strategy][metric].n);
      output.push(`<polyline fill="none" stroke="${color}" stroke-width="2" points="${values.map((group) => `${x(group.rttMs)},${y(group.pairedRunMetrics[strategy][metric].median)}`).join(' ')}"/>`);
      for (const group of values) {
        const stat = group.pairedRunMetrics[strategy][metric]; const xx = x(group.rttMs);
        output.push(`<line x1="${xx}" x2="${xx}" y1="${y(stat.min)}" y2="${y(stat.max)}" stroke="${color}" stroke-width="1.5"/><circle cx="${xx}" cy="${y(stat.median)}" r="3.5" fill="${color}"><title>${xml(`${strategy}; added RTT=${group.rttMs}ms; ${stat.n} matched runs; median=${stat.median.toFixed(3)}ms; range=${stat.min.toFixed(3)}–${stat.max.toFixed(3)}ms`)}</title></circle>`);
      }
    }
  }
  output.push('</svg>');
  return `${output.join('\n')}\n`;
}

export async function loadLatency(input) {
  const campaignPath = extname(input).toLowerCase() === '.json' ? resolve(input) : resolve(input, 'campaign.json');
  const parse = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));
  const campaign = parse(await readFile(campaignPath, 'utf8'));
  const reports = new Map();
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
    if (args[index] === '--input') input = args[index + 1];
    else if (args[index] === '--output') output = args[index + 1];
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (!input) throw new Error('Use --input <campaign-directory-or-json> [--output <prefix>]');
  const loaded = await loadLatency(input);
  const prefix = output ? resolve(output).replace(/\.(json|md)$/i, '') : join(dirname(loaded.campaignPath), 'analysis');
  const targets = output ? [`${prefix}.json`, `${prefix}.md`, `${prefix}-runs.csv`, `${prefix}-latency.svg`]
    : [`${prefix}.json`, `${prefix}.md`, join(dirname(prefix), 'runs.csv'), join(dirname(prefix), 'latency.svg')];
  const normalized = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const protectedPaths = new Set([...loaded.protectedPaths].map(normalized));
  if (targets.some((path) => protectedPaths.has(normalized(path)))) throw new Error('Analysis must not overwrite campaign or raw reports');
  const analysis = analyzeLatency(loaded.campaign, loaded.reports);
  await mkdir(dirname(prefix), { recursive: true });
  await writeFile(targets[0], `${JSON.stringify(analysis, null, 2)}\n`);
  await writeFile(targets[1], toMarkdown(analysis));
  await writeFile(targets[2], toCsv(analysis));
  await writeFile(targets[3], toSvg(analysis));
  console.log(JSON.stringify({ outputs: targets, coverage: analysis.coverage, crossovers: analysis.crossovers, warnings: analysis.warnings }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
