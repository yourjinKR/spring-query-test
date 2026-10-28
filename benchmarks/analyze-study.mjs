import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const metricDefinitions = {
  httpP95Ms: { direction: 'lower', label: 'HTTP p95 ms' },
  httpP99Ms: { direction: 'lower', label: 'HTTP p99 ms' },
  completedRps: { direction: 'higher', label: 'Completed RPS' },
  successfulRps: { direction: 'higher', label: 'Successful RPS' },
  acquireMeanMs: { direction: 'lower', label: 'Acquire mean ms' },
  acquireP95Ms: { direction: 'lower', label: 'Acquire p95 estimate ms' },
  usageMeanMs: { direction: 'lower', label: 'Usage mean ms' },
  usageP95Ms: { direction: 'lower', label: 'Usage p95 estimate ms' },
  sampledMaxPending: { direction: 'lower', label: 'Sampled max pending' },
  timeoutCount: { direction: 'lower', label: 'Pool timeout count' },
};

const resourceMetricNames = ['serverCpuMedianPercent', 'serverCpuMaxPercent', 'dbCpuMedianPercent', 'dbCpuMaxPercent',
  'loadCpuMedianPercent', 'loadCpuMaxPercent', 'gcPauseSecondsApprox', 'gcPauseCountApprox', 'allocatedBytesApprox'];

const finite = (value) => Number.isFinite(value) ? value : null;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted.at(-1) : null,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function summarizeMetrics(runs) {
  return Object.fromEntries(Object.keys(metricDefinitions)
    .map((key) => [key, distribution(runs.map((run) => run.metrics[key]))]));
}

function summarizeResourceMetrics(runs) {
  return Object.fromEntries(resourceMetricNames
    .map((name) => [name, distribution(runs.map((run) => run.resources.metrics[name]))]));
}

function normalizeRun(point, report, campaign, readError = null) {
  const parameters = report?.parameters ?? {};
  const measurements = report?.k6?.measurements ?? {};
  const pool = report?.pools?.length === 1 ? report.pools[0] : null;
  const model = point.model ?? parameters.model ?? null;
  const poolSize = finite(point.poolSize);
  const vus = model === 'closed' ? finite(point.vus ?? parameters.vus) : null;
  const rate = model === 'arrival' ? finite(point.rate ?? parameters.rate) : null;
  const strategy = point.strategy ?? parameters.strategy ?? null;
  const reasons = [];
  const addReason = (condition, reason) => { if (condition) reasons.push(reason); };
  addReason(!report, readError ?? 'Report is missing');
  addReason(!['closed', 'arrival'].includes(model), 'Unknown load model');
  addReason(!['v1', 'v2'].includes(strategy), 'Unknown strategy');
  addReason(!(poolSize > 0), 'Expected pool size is missing');
  addReason(!(model === 'closed' ? vus > 0 : rate > 0), 'Expected load is missing');
  if (report) {
    addReason(!['completed', 'load_failed'].includes(report.status), `Report status is ${report.status ?? 'missing'}`);
    addReason(Boolean(report.error), `Report error: ${report.error}`);
    addReason(report.datasetUnchanged !== true, 'Dataset changed or its integrity is unknown');
    if (campaign.datasetBaseline != null) {
      addReason(!isDeepStrictEqual(campaign.datasetBaseline, report.datasetBefore)
        || !isDeepStrictEqual(campaign.datasetBaseline, report.datasetAfter), 'Dataset differs from the campaign baseline');
    }
    addReason(report.pollErrorCount !== 0, 'Pool polling failed or its status is unknown');
    addReason(!pool, 'Exactly one measured pool is required');
    if (pool) {
      addReason(pool.configuredMaximum !== poolSize, 'Actual pool maximum differs from the condition');
      addReason(pool.counterReset !== false, 'Pool counters reset or their status is unknown');
      addReason(!Array.isArray(pool.missingMetrics) || pool.missingMetrics.length > 0, 'Required pool metrics are missing');
      addReason(pool.sampledMaximumChanged !== false, 'Pool maximum changed or its status is unknown');
      addReason(pool.acquisitionCountMinusCompletedRequests !== 0, 'Pool borrow count does not match completed requests');
    }
    addReason(report.runner?.cliTerminated !== true, 'Load CLI termination was not confirmed');
    addReason(!['removed', 'already_absent'].includes(report.runner?.cleanup?.after?.status), 'Load container cleanup was not confirmed');
    addReason(Boolean(report.runner?.stopReason), `Load was interrupted: ${report.runner?.stopReason}`);
    addReason(Boolean(report.runner?.spawnError) || Boolean(report.runner?.outputLimitExceeded), 'Load runner failed');
    for (const [name, expected] of [['strategy', strategy], ['model', model], ['vus', vus], ['rate', rate]]) {
      if (expected != null && parameters[name] != null) {
        addReason(parameters[name] !== expected, `Report parameter ${name} differs from its condition`);
      }
    }
    for (const name of ['startedRequests', 'completedRequests', 'successfulRequests', 'incompleteRequests', 'droppedIterations']) {
      addReason(!nonnegative(measurements[name]), `Missing or invalid ${name}`);
    }
    addReason(measurements.successfulRequests > measurements.completedRequests
      || measurements.completedRequests > measurements.startedRequests, 'Request counts are inconsistent');
  }

  const k6Metric = (name, statistic) => finite(report?.k6?.results?.metrics?.[name]?.values?.[statistic]);
  const metrics = {
    httpP95Ms: k6Metric('measured_http_ms', 'p(95)'),
    httpP99Ms: k6Metric('measured_http_ms', 'p(99)'),
    completedRps: finite(measurements.completedRequestsPerSecond),
    successfulRps: finite(measurements.successfulRequestsPerSecond),
    acquireMeanMs: finite(pool?.acquire?.meanMs),
    acquireP95Ms: finite(pool?.acquire?.p95Ms),
    usageMeanMs: finite(pool?.usage?.meanMs),
    usageP95Ms: finite(pool?.usage?.p95Ms),
    sampledMaxPending: finite(pool?.sampledMaxPending),
    timeoutCount: finite(pool?.timeoutCount),
  };
  const measurementValid = reasons.length === 0;
  const loadFailures = [];
  const failure = (condition, reason) => { if (condition) loadFailures.push(reason); };
  failure(report?.status !== 'completed', `Load status is ${report?.status ?? 'missing'}`);
  failure(measurements.httpErrorRate !== 0, 'HTTP errors or missing error rate');
  failure(measurements.contractErrorRate !== 0, 'Response contract errors or missing error rate');
  failure(measurements.incompleteRequests !== 0, 'Incomplete requests');
  failure(measurements.droppedIterations !== 0, 'Dropped iterations');
  failure(pool?.timeoutCount !== 0, 'Pool timeouts or missing timeout counter');
  failure(!(measurements.completedRequests > 0), 'No completed requests');
  failure(measurements.successfulRequests !== measurements.completedRequests, 'Not all completed requests were successful');
  failure(metrics.httpP95Ms == null || metrics.httpP99Ms == null
    || metrics.completedRps == null || metrics.successfulRps == null, 'Required HTTP latency/throughput is missing');

  const settings = canonical({
    ids: parameters.ids ?? null,
    durationMs: parameters.durationMs ?? null,
    requestTimeout: parameters.requestTimeout ?? null,
    baseUrl: parameters.baseUrl ?? null,
    dockerBaseUrl: parameters.dockerBaseUrl ?? null,
    preallocatedVus: model === 'arrival' ? parameters.preallocatedVus ?? null : null,
    maxVus: model === 'arrival' ? parameters.maxVus ?? null : null,
    model, vus, rate, poolSize,
    dataset: report?.datasetBefore ?? null,
  });
  return {
    sequence: point.sequence ?? null,
    condition: point.condition ?? null,
    repeat: point.repeat ?? null,
    poolSize, model, vus, rate, strategy,
    order: finite(point.order),
    report: point.report ?? null,
    reportStatus: report?.status ?? 'missing',
    exitCode: point.exitCode ?? report?.runner?.exitCode ?? null,
    warnings: report?.warnings ?? [],
    measurementValid,
    measurementIssues: reasons,
    loadFailures,
    clean: measurementValid && loadFailures.length === 0,
    requests: {
      started: finite(measurements.startedRequests), completed: finite(measurements.completedRequests),
      successful: finite(measurements.successfulRequests), incomplete: finite(measurements.incompleteRequests),
      dropped: finite(measurements.droppedIterations),
      httpErrorRate: finite(measurements.httpErrorRate), contractErrorRate: finite(measurements.contractErrorRate),
    },
    metrics,
    settings,
    poolWindow: report?.poolWindow ?? null,
    loadContainerName: report?.runner?.containerName ?? null,
  };
}

/** Monitor samples are observations within the pool window, not exact per-request resource attribution. */
export function summarizeResources(samples, window, loadContainerName = null) {
  const started = Date.parse(window?.startedAt);
  const ended = Date.parse(window?.endedAt);
  const selected = Number.isFinite(started) && Number.isFinite(ended)
    ? samples.filter((sample) => Date.parse(sample.at) >= started && Date.parse(sample.at) <= ended)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const cpus = (kind) => selected.flatMap((sample) => (sample.resources ?? [])
    .filter((resource) => kind === 'load' ? loadContainerName != null && resource.name === loadContainerName
      : new RegExp(`-${kind}-\\d+$`).test(resource.name ?? ''))
    .map((resource) => resource.cpuPercent).filter(Number.isFinite));
  const server = distribution(cpus('server'));
  const database = distribution(cpus('db'));
  const load = distribution(cpus('load'));
  const jvm = selected.filter((sample) => sample.jvm != null);
  const first = jvm[0]?.jvm;
  const last = jvm.at(-1)?.jvm;
  let reset = Boolean(first && last && nonnegative(first.uptimeSeconds) && nonnegative(last.uptimeSeconds)
    && last.uptimeSeconds < first.uptimeSeconds);
  const delta = (name) => {
    if (jvm.length < 2 || !nonnegative(first?.[name]) || !nonnegative(last?.[name])) return null;
    if (last[name] < first[name]) { reset = true; return null; }
    return last[name] - first[name];
  };
  const gcPauseSecondsApprox = delta('gcPauseSeconds');
  const gcPauseCountApprox = delta('gcPauseCount');
  const allocatedBytesApprox = delta('allocatedBytes');
  return {
    sampleCount: selected.length,
    samplesWithErrors: selected.filter((sample) => sample.errors?.length).length,
    counterReset: reset,
    metrics: {
      serverCpuMedianPercent: server.median, serverCpuMaxPercent: server.max,
      dbCpuMedianPercent: database.median, dbCpuMaxPercent: database.max,
      loadCpuMedianPercent: load.median, loadCpuMaxPercent: load.max,
      gcPauseSecondsApprox: reset ? null : gcPauseSecondsApprox,
      gcPauseCountApprox: reset ? null : gcPauseCountApprox,
      allocatedBytesApprox: reset ? null : allocatedBytesApprox,
    },
    note: 'CPU values are sampled Docker percentages (100%=one core). GC/allocation deltas use first/last available in-window JVM samples and omit window edges; they are approximate, not exact run totals.',
  };
}

function strategySummary(runs) {
  const clean = runs.filter((run) => run.clean);
  const sum = (name) => runs.reduce((total, run) => total + (run.requests[name] ?? 0), 0);
  return {
    recordedRuns: runs.length,
    measurementValidRuns: runs.filter((run) => run.measurementValid).length,
    cleanRuns: clean.length,
    reportStatusCounts: Object.fromEntries([...new Set(runs.map((run) => run.reportStatus))]
      .map((status) => [status, runs.filter((run) => run.reportStatus === status).length])),
    allRecordedRequests: {
      started: sum('started'), completed: sum('completed'), successful: sum('successful'),
      incomplete: sum('incomplete'), dropped: sum('dropped'),
    },
    cleanRunMetrics: summarizeMetrics(clean),
    allRecordedRunMetrics: summarizeMetrics(runs),
    cleanRunResources: summarizeResourceMetrics(clean),
  };
}

function compareMetrics(left, right) {
  return Object.fromEntries(Object.entries(metricDefinitions).map(([name, definition]) => {
    const a = left.metrics[name];
    const b = right.metrics[name];
    const ratio = Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a : null;
    const changePercent = ratio == null ? null : (ratio - 1) * 100;
    return [name, {
      v1: a, v2: b, v2OverV1: ratio, changePercent,
      improvementPercent: changePercent == null ? null : definition.direction === 'lower' ? -changePercent : changePercent,
    }];
  }));
}

function summarizePairs(pairs) {
  return Object.fromEntries(Object.keys(metricDefinitions).map((metric) => {
    const values = pairs.map((pair) => pair.metrics?.[metric]).filter(Boolean);
    const improvements = values.map((value) => value.improvementPercent).filter(Number.isFinite);
    return [metric, {
      direction: metricDefinitions[metric].direction,
      v2OverV1: distribution(values.map((value) => value.v2OverV1)),
      improvementPercent: distribution(improvements),
      v2Better: improvements.filter((value) => value > 1e-10).length,
      v1Better: improvements.filter((value) => value < -1e-10).length,
      equal: improvements.filter((value) => Math.abs(value) <= 1e-10).length,
      unavailable: pairs.length - improvements.length,
    }];
  }));
}

function makeGroup(runs) {
  const first = runs[0];
  const byRepeat = new Map();
  for (const run of runs) {
    const repeat = String(run.repeat);
    if (!byRepeat.has(repeat)) byRepeat.set(repeat, { v1: [], v2: [] });
    if (run.strategy === 'v1' || run.strategy === 'v2') byRepeat.get(repeat)[run.strategy].push(run);
  }
  const settingVariants = new Set(runs.filter((run) => run.measurementValid).map((run) => JSON.stringify(run.settings)));
  const cleanMembers = [];
  const pairs = [...byRepeat.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([repeat, members]) => {
    const issues = [];
    for (const strategy of ['v1', 'v2']) {
      if (members[strategy].length !== 1) issues.push(`${strategy} has ${members[strategy].length} runs; exactly one is required`);
    }
    const left = members.v1.length === 1 ? members.v1[0] : null;
    const right = members.v2.length === 1 ? members.v2[0] : null;
    const settingsMatch = Boolean(left && right && isDeepStrictEqual(left.settings, right.settings));
    if (left && right && !settingsMatch) issues.push('The paired runs have different workload/dataset settings');
    if (settingVariants.size > 1) issues.push('Settings differ between repeats in this condition');
    const capacityEligible = issues.length === 0 && left?.measurementValid === true && right?.measurementValid === true;
    const latencyEligible = capacityEligible && left.clean && right.clean;
    if (latencyEligible) cleanMembers.push({ repeat, v1: left, v2: right });
    const firstStrategy = left?.order === 1 && right?.order === 2 ? 'v1'
      : right?.order === 1 && left?.order === 2 ? 'v2' : null;
    return {
      repeat: Number.isFinite(Number(repeat)) ? Number(repeat) : repeat,
      firstStrategy,
      capacityEligible,
      latencyEligible,
      issues,
      runSequences: { v1: left?.sequence ?? null, v2: right?.sequence ?? null },
      runStatuses: { v1: left?.reportStatus ?? null, v2: right?.reportStatus ?? null },
      requests: { v1: left?.requests ?? null, v2: right?.requests ?? null },
      metrics: left && right ? compareMetrics(left, right) : null,
    };
  });
  const cleanPairs = pairs.filter((pair) => pair.latencyEligible);
  const firstRecordedRepeat = pairs[0]?.repeat ?? null;
  const firstCleanMembers = cleanMembers.find((pair) => String(pair.repeat) === String(firstRecordedRepeat));
  const laterCleanMembers = cleanMembers.filter((pair) => String(pair.repeat) !== String(firstRecordedRepeat));
  const firstRepeatDrift = {
    firstRecordedRepeat,
    firstRepeatWasClean: Boolean(firstCleanMembers),
    byStrategy: Object.fromEntries(['v1', 'v2'].map((strategy) => {
      const firstRun = firstCleanMembers?.[strategy];
      const laterRuns = laterCleanMembers.map((pair) => pair[strategy]);
      const laterMetrics = summarizeMetrics(laterRuns);
      return [strategy, {
        firstMetrics: firstRun?.metrics ?? null,
        laterCleanRuns: laterRuns.length,
        laterMetrics,
        firstOverLaterMedian: Object.fromEntries(Object.keys(metricDefinitions).map((name) => {
          const baseline = laterMetrics[name].median;
          return [name, firstRun && baseline > 0 && Number.isFinite(firstRun.metrics[name])
            ? firstRun.metrics[name] / baseline : null];
        })),
      }];
    })),
    note: 'Descriptive first recorded repeat versus later common clean pairs; not a trend test or a reason to discard the first repeat.',
  };
  return {
    poolSize: first.poolSize, model: first.model, vus: first.vus, rate: first.rate,
    condition: first.condition,
    recordedRuns: runs.length,
    settingVariantCount: settingVariants.size,
    strategies: { v1: strategySummary(runs.filter((run) => run.strategy === 'v1')),
      v2: strategySummary(runs.filter((run) => run.strategy === 'v2')) },
    pairedRunMetrics: Object.fromEntries(['v1', 'v2'].map((strategy) =>
      [strategy, summarizeMetrics(cleanMembers.map((pair) => pair[strategy]))])),
    pairedRunResources: Object.fromEntries(['v1', 'v2'].map((strategy) =>
      [strategy, summarizeResourceMetrics(cleanMembers.map((pair) => pair[strategy]))])),
    pairing: {
      recordedRepeats: pairs.length,
      capacityEligiblePairs: pairs.filter((pair) => pair.capacityEligible).length,
      cleanLatencyPairs: cleanPairs.length,
      excludedPairs: pairs.length - cleanPairs.length,
      cleanPairMetrics: summarizePairs(cleanPairs),
      firstRepeatDrift,
      byFirstStrategy: Object.fromEntries(['v1', 'v2', 'unknown'].map((strategy) => {
        const selected = cleanPairs.filter((pair) => (pair.firstStrategy ?? 'unknown') === strategy);
        return [strategy, { pairs: selected.length, metrics: summarizePairs(selected) }];
      })),
      pairs,
    },
  };
}

/** Each entry is one execution. Requests within an execution are not independent replicates. */
export function analyzeStudy(campaign, loadedReports, resourceSamples = []) {
  if (!Array.isArray(campaign.points)) throw new Error('campaign.points must be an array');
  const entries = loadedReports instanceof Map ? loadedReports : new Map(Object.entries(loadedReports));
  const measured = campaign.points.filter((point) => point.phase === 'measure');
  const runs = measured.map((point) => {
    const loaded = entries.get(point.report);
    const run = normalizeRun(point, loaded?.report ?? (loaded && !loaded.readError ? loaded : null), campaign, loaded?.readError);
    run.resources = summarizeResources(resourceSamples, run.poolWindow, run.loadContainerName);
    return run;
  });
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.poolSize, run.model, run.model === 'closed' ? run.vus : run.rate]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const warnings = [];
  const terminalStatus = ['completed', 'completed_with_load_failures'].includes(campaign.status);
  const validCompletedAt = Number.isFinite(Date.parse(campaign.completedAt));
  const plannedRuns = nonnegative(campaign.parameters?.totalMeasuredRuns) ? campaign.parameters.totalMeasuredRuns : null;
  const allPlannedRunsRecorded = plannedRuns == null ? null : measured.length === plannedRuns;
  const campaignComplete = terminalStatus && validCompletedAt && allPlannedRunsRecorded !== false;
  if (!terminalStatus) warnings.push('Campaign is not in a completed state; this analysis may be partial');
  if (terminalStatus && !validCompletedAt) warnings.push('Campaign has a completed status but no valid completion timestamp');
  if (allPlannedRunsRecorded === false) warnings.push(`Recorded ${measured.length} of ${plannedRuns} planned measured runs; coverage is incomplete or inconsistent`);
  const failedLoads = runs.filter((run) => run.reportStatus === 'load_failed').length;
  if (failedLoads || campaign.status === 'completed_with_load_failures') warnings.push(`Campaign contains load failures (${failedLoads} recorded runs); this is separate from completion coverage`);
  if (campaign.restoreFailed) warnings.push('The campaign reported a server-setting restoration failure');
  const invalid = runs.filter((run) => !run.measurementValid).length;
  if (invalid) warnings.push(`${invalid} measured runs have measurement-integrity issues`);
  const groupSummaries = [...groups.values()].map(makeGroup).sort((a, b) =>
    (a.poolSize ?? 0) - (b.poolSize ?? 0) || String(a.model).localeCompare(String(b.model)) || (a.vus ?? a.rate ?? 0) - (b.vus ?? b.rate ?? 0));
  for (const group of groupSummaries) {
    if (group.pairing.cleanLatencyPairs < 5) warnings.push(`Pool ${group.poolSize} ${group.model} ${group.vus ?? group.rate}: fewer than five complete clean pairs`);
    if (group.settingVariantCount > 1) warnings.push(`Pool ${group.poolSize} ${group.model} ${group.vus ?? group.rate}: mixed settings prevent comparisons`);
  }
  return {
    schemaVersion: 1,
    analyzedAt: new Date().toISOString(),
    campaignStatus: campaign.status ?? null,
    campaignCompletedAt: campaign.completedAt ?? null,
    parameters: campaign.parameters ?? null,
    datasetBaseline: campaign.datasetBaseline ?? null,
    methodology: [
      'One run, not one request, is the replication unit. Warmup executions are excluded.',
      'Latency/throughput headline summaries use clean runs; failed and invalid runs remain in all-recorded summaries and CSV.',
      'Primary absolute comparison tables use the same common clean repeat pairs for both strategies; per-strategy all-clean summaries may have different denominators and are reported separately.',
      'Paired comparisons require one v1 and one v2 run per repeat with matching settings. No request percentiles are pooled or averaged into a pooled percentile.',
      'Summary values are run-level medians and observed ranges. Five pairs do not support precise confidence-interval or universal performance claims.',
      'Closed-loop pairs have the same VU count, not necessarily the same achieved request rate. Arrival pairs require zero dropped/incomplete/error requests for latency comparisons.',
      'Pool acquire/usage p95 are histogram estimates; pending maxima are sampled observations.',
      'Optional Docker CPU and JVM GC data are sampled within each pool observation window; GC deltas omit window edges and are approximate.',
    ],
    coverage: {
      campaignComplete,
      expectedMeasuredRuns: plannedRuns,
      allPlannedRunsRecorded,
      campaignPoints: campaign.points.length,
      excludedWarmupPoints: campaign.points.filter((point) => point.phase === 'warmup').length,
      excludedUnknownPhasePoints: campaign.points.filter((point) => !['warmup', 'measure'].includes(point.phase)).length,
      measuredRuns: runs.length,
      measurementValidRuns: runs.length - invalid,
      cleanRuns: runs.filter((run) => run.clean).length,
      resourceSamples: resourceSamples.length,
      runsWithResourceSamples: runs.filter((run) => run.resources.sampleCount > 0).length,
    },
    warnings,
    groups: groupSummaries,
    runs,
  };
}

const formatNumber = (value) => value == null ? '—' : Math.abs(value) < 1 && value !== 0 ? value.toFixed(4) : value.toFixed(2);
const formatDistribution = (value) => value?.n ? `${formatNumber(value.median)} [${formatNumber(value.min)}, ${formatNumber(value.max)}]` : '—';

export function toMarkdown(analysis) {
  const lines = ['# 반복 실행 분석', '',
    `측정 실행 ${analysis.coverage.measuredRuns}개, 계측 유효 ${analysis.coverage.measurementValidRuns}개, 오류 없는 실행 ${analysis.coverage.cleanRuns}개. 워밍업 ${analysis.coverage.excludedWarmupPoints}개 제외.`, '',
    `캠페인 상태: ${analysis.campaignStatus ?? 'unknown'}. 계획 실행: ${analysis.coverage.expectedMeasuredRuns ?? '미지정'}, 완료 범위 확인: ${analysis.coverage.campaignComplete ? '완료' : '미완료 또는 불일치'}.`, '',
    '모든 표는 **실행별 통계의 중앙값 [최솟값, 최댓값]**이다. 요청을 합쳐 구한 백분위나 신뢰구간이 아니다. 주요 비교표는 양쪽 모두 정상인 **동일 반복의 공통 비교 쌍**만 사용한다. 실패·부하 미전달 실행은 아래 상태와 원시 CSV/JSON에 보존하며 정상 실행의 지연 우열에 섞지 않는다.', ''];
  for (const warning of analysis.warnings) lines.push(`- ${warning}`);
  if (analysis.warnings.length) lines.push('');
  for (const group of analysis.groups) {
    lines.push(`## Pool ${group.poolSize} · ${group.model} · ${group.model === 'closed' ? `${group.vus} VU` : `${group.rate} req/s`}`, '',
      `주요 비교: 공통 정상 ${group.pairing.cleanLatencyPairs}쌍. 두 전략의 분모와 반복 번호가 같다.`, '',
      '| 전략 | 공통 정상 실행 수 | HTTP p95 ms | HTTP p99 ms | 완료 RPS | acquire 평균 ms | usage 평균 ms | 관측 pending 최대 |',
      '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) {
      const metric = group.pairedRunMetrics[strategy];
      lines.push(`| ${strategy} | ${group.pairing.cleanLatencyPairs} | ${formatDistribution(metric.httpP95Ms)} | ${formatDistribution(metric.httpP99Ms)} | ${formatDistribution(metric.completedRps)} | ${formatDistribution(metric.acquireMeanMs)} | ${formatDistribution(metric.usageMeanMs)} | ${formatDistribution(metric.sampledMaxPending)} |`);
    }
    lines.push('', `정상 비교 쌍: ${group.pairing.cleanLatencyPairs}/${group.pairing.recordedRepeats}. 유효 계측이지만 과부하 등을 포함하는 capacity 쌍: ${group.pairing.capacityEligiblePairs}.`, '',
      '| 지표 | v2 개선율 중앙값 [범위] % | v2 유리 / v1 유리 / 동일 |', '|---|---:|---:|');
    for (const key of ['httpP95Ms', 'completedRps', 'acquireMeanMs', 'usageMeanMs']) {
      const metric = group.pairing.cleanPairMetrics[key];
      lines.push(`| ${metricDefinitions[key].label} | ${formatDistribution(metric.improvementPercent)} | ${metric.v2Better} / ${metric.v1Better} / ${metric.equal} |`);
    }
    lines.push('', `실행 순서: v1 선행 ${group.pairing.byFirstStrategy.v1.pairs}쌍, v2 선행 ${group.pairing.byFirstStrategy.v2.pairs}쌍. 순서별 비율은 JSON에 따로 기록했다.`, '');
    const drift = group.pairing.firstRepeatDrift;
    lines.push(`첫 반복 ${drift.firstRecordedRepeat}의 공통 정상 여부: ${drift.firstRepeatWasClean ? '정상' : '정상 비교에서 제외됨'}. 첫 반복/이후 공통 정상 반복 중앙값 비율(관측값; 첫 회차를 사후 삭제하지 않음):`, '',
      '| 전략 | HTTP p95 비율 | 완료 RPS 비율 | 이후 정상 반복 수 |', '|---|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) {
      const value = drift.byStrategy[strategy];
      lines.push(`| ${strategy} | ${formatNumber(value.firstOverLaterMedian.httpP95Ms)} | ${formatNumber(value.firstOverLaterMedian.completedRps)} | ${value.laterCleanRuns} |`);
    }
    lines.push('');
    if (Object.values(group.pairedRunResources).some((resource) => resource.serverCpuMedianPercent.n > 0)) {
      lines.push('| 전략 | 서버 CPU 표본 중앙값 % | DB CPU 표본 중앙값 % | 발생기 CPU 표본 중앙값 % | GC pause 근사 s |', '|---|---:|---:|---:|---:|');
      for (const strategy of ['v1', 'v2']) {
        const resource = group.pairedRunResources[strategy];
        lines.push(`| ${strategy} | ${formatDistribution(resource.serverCpuMedianPercent)} | ${formatDistribution(resource.dbCpuMedianPercent)} | ${formatDistribution(resource.loadCpuMedianPercent)} | ${formatDistribution(resource.gcPauseSecondsApprox)} |`);
      }
      lines.push('', 'CPU는 100%=1코어인 Docker 표본이며, GC는 관측 구간 안의 첫/마지막 표본 차이로 양 끝 구간을 생략한 근사다.', '');
    }
    lines.push('전략별 전체 정상 실행 참고치: 공통 쌍 표와 달리 전략별 분모가 다를 수 있으므로 이 표의 두 중앙값으로 상대 개선율을 계산하지 않는다.', '',
      '| 전략 | 정상/전체 실행 | 전체 정상 HTTP p95 ms | 전체 정상 완료 RPS | load_failed 수 | 전체 dropped 수 |', '|---|---:|---:|---:|---:|---:|');
    for (const strategy of ['v1', 'v2']) {
      const value = group.strategies[strategy];
      lines.push(`| ${strategy} | ${value.cleanRuns}/${value.recordedRuns} | ${formatDistribution(value.cleanRunMetrics.httpP95Ms)} | ${formatDistribution(value.cleanRunMetrics.completedRps)} | ${value.reportStatusCounts.load_failed ?? 0} | ${value.allRecordedRequests.dropped} |`);
    }
    lines.push('');
    const excluded = group.pairing.pairs.filter((pair) => !pair.latencyEligible);
    if (excluded.length) {
      lines.push('지연 비교에서 제외한 쌍:', ...excluded.map((pair) => `- repeat ${pair.repeat}: ${pair.issues.join('; ') || `상태 v1=${pair.runStatuses.v1}, v2=${pair.runStatuses.v2}; 오류·dropped·미완료·timeout 확인`}`), '');
    }
    const failedRuns = analysis.runs.filter((run) => run.poolSize === group.poolSize && run.model === group.model
      && (group.model === 'closed' ? run.vus === group.vus : run.rate === group.rate) && !run.clean);
    if (failedRuns.length) {
      lines.push('실패·계측 무효 실행(삭제하지 않음):', '',
        '| 반복 | 전략 | 상태 | 완료 수 | 성공 수 | dropped | 미완료 | HTTP 오류율 |', '|---:|---|---|---:|---:|---:|---:|---:|');
      for (const run of failedRuns) {
        lines.push(`| ${run.repeat} | ${run.strategy} | ${run.reportStatus} | ${run.requests.completed ?? '—'} | ${run.requests.successful ?? '—'} | ${run.requests.dropped ?? '—'} | ${run.requests.incomplete ?? '—'} | ${formatNumber(run.requests.httpErrorRate)} |`);
      }
      lines.push('');
    }
  }
  lines.push('## 해석 범위', '', ...analysis.methodology.map((note) => `- ${note}`), '');
  return lines.join('\n');
}

export function toCsv(analysis) {
  const columns = ['sequence', 'condition', 'poolSize', 'model', 'vus', 'rate', 'repeat', 'strategy', 'order', 'reportStatus', 'measurementValid', 'clean',
    ...Object.keys(metricDefinitions), ...resourceMetricNames, 'started', 'completed', 'successful', 'incomplete', 'dropped', 'httpErrorRate', 'contractErrorRate', 'issues', 'loadFailures', 'report'];
  const cell = (value) => value == null ? '' : /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  const records = analysis.runs.map((run) => ({ ...run, ...run.metrics, ...run.resources.metrics, ...run.requests,
    issues: run.measurementIssues.join('; '), loadFailures: run.loadFailures.join('; ') }));
  return [columns.join(','), ...records.map((record) => columns.map((name) => cell(record[name])).join(','))].join('\n') + '\n';
}

function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function loadStudy(input) {
  const campaignPath = extname(input).toLowerCase() === '.json' ? resolve(input) : resolve(input, 'campaign.json');
  const campaign = parseJson(await readFile(campaignPath, 'utf8'));
  const reports = new Map();
  const paths = new Set([campaignPath]);
  for (const point of campaign.points ?? []) {
    if (!point.report) continue;
    const path = resolve(dirname(campaignPath), point.report);
    paths.add(path);
    if (point.phase !== 'measure') continue;
    try { reports.set(point.report, { report: parseJson(await readFile(path, 'utf8')) }); }
    catch (error) { reports.set(point.report, { readError: error.message }); }
  }
  const resourceSamples = [];
  const resourceParseErrors = [];
  const resourcesPath = join(dirname(campaignPath), 'resources.jsonl');
  paths.add(resourcesPath);
  try {
    const resourceText = await readFile(resourcesPath, 'utf8');
    for (const [index, line] of resourceText.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { resourceSamples.push(parseJson(line)); }
      catch (error) { resourceParseErrors.push(`Resource line ${index + 1}: ${error.message}`); }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') resourceParseErrors.push(`Resource samples could not be read: ${error.message}`);
  }
  return { campaignPath, campaign, reports, resourceSamples, resourceParseErrors, protectedPaths: paths };
}

async function main() {
  const args = process.argv.slice(2);
  let input;
  let output;
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index + 1]) throw new Error(`Missing value for ${args[index]}`);
    if (args[index] === '--input') input = args[index + 1];
    else if (args[index] === '--output') output = args[index + 1];
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (!input) throw new Error('Use --input <study-directory-or-campaign.json> [--output <analysis.json>]');
  const loaded = await loadStudy(input);
  const outputPath = resolve(output ?? join(dirname(loaded.campaignPath), 'analysis.json'));
  const stem = outputPath.slice(0, outputPath.length - extname(outputPath).length);
  const targets = [outputPath, `${stem}.md`, `${stem}-runs.csv`];
  const normalize = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const protectedPaths = new Set([...loaded.protectedPaths].map(normalize));
  if (targets.some((target) => protectedPaths.has(normalize(target)))) throw new Error('Analysis outputs must not overwrite the campaign or raw reports');
  const analysis = analyzeStudy(loaded.campaign, loaded.reports, loaded.resourceSamples);
  analysis.warnings.push(...loaded.resourceParseErrors);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(targets[0], `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  await writeFile(targets[1], toMarkdown(analysis), 'utf8');
  await writeFile(targets[2], toCsv(analysis), 'utf8');
  console.log(JSON.stringify({ outputs: targets, coverage: analysis.coverage, warnings: analysis.warnings,
    conditions: analysis.groups.map((group) => ({ pool: group.poolSize, model: group.model, load: group.vus ?? group.rate,
      cleanPairs: group.pairing.cleanLatencyPairs, httpP95ImprovementPercent: group.pairing.cleanPairMetrics.httpP95Ms.improvementPercent,
      throughputImprovementPercent: group.pairing.cleanPairMetrics.completedRps.improvementPercent })) }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
