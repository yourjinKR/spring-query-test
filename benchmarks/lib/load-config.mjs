const DEFAULT_IDS = '1,2,3,4,5,6,7,8,9,10';

function integerSetting(environment, name, fallback, minimum, maximum) {
  const raw = environment[name] ?? String(fallback);
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function durationSetting(environment, name, fallback, minimumMs, maximumMs) {
  const text = environment[name] ?? fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text);
  if (!match) throw new Error(`${name} must use ms, s or m (for example 500ms, 30s or 2m)`);
  const multiplier = { ms: 1, s: 1000, m: 60_000 }[match[2]];
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isFinite(milliseconds) || milliseconds < minimumMs || milliseconds > maximumMs) {
    throw new Error(`${name} must be between ${minimumMs}ms and ${maximumMs}ms`);
  }
  return { text, milliseconds };
}

export function parseLoadConfig(environment = {}) {
  const strategy = environment.STRATEGY || 'v1';
  if (!['v1', 'v2'].includes(strategy)) throw new Error('STRATEGY must be v1 or v2');

  const loadModel = environment.LOAD_MODEL || 'closed';
  if (!['closed', 'arrival'].includes(loadModel)) throw new Error('LOAD_MODEL must be closed or arrival');

  const baseUrl = (environment.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/.test(baseUrl)) {
    throw new Error('BASE_URL must be an http or https URL without a query or fragment');
  }

  const rawIds = (environment.IDS || DEFAULT_IDS).split(',').map((id) => id.trim());
  if (!rawIds.length || rawIds.length > 100 || rawIds.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error('IDS must contain 1..100 positive integer IDs separated by commas');
  }
  const parsedIds = rawIds.map(Number);
  if (parsedIds.some((id) => !Number.isSafeInteger(id))) throw new Error('IDS must contain safe integer IDs');
  const ids = [...new Set(parsedIds)].sort((left, right) => left - right);

  const duration = durationSetting(environment, 'DURATION', '30s', 1000, 600_000);
  const requestTimeout = durationSetting(environment, 'REQUEST_TIMEOUT', '120s', 1, 120_000);
  const config = {
    strategy, loadModel, baseUrl, ids,
    warmup: integerSetting(environment, 'WARMUP', 20, 0, 1000),
    duration: duration.text,
    durationMs: duration.milliseconds,
    requestTimeout: requestTimeout.text,
    requestTimeoutMs: requestTimeout.milliseconds,
    vus: null,
    rate: null,
    preAllocatedVUs: null,
    maxVUs: null,
    expectedRows: null,
    expectedQueryRows: null,
  };

  if (environment.EXPECTED_ROWS != null) {
    config.expectedRows = integerSetting(environment, 'EXPECTED_ROWS', 0, 0, 250_000);
  }
  if (environment.EXPECTED_QUERY_ROWS != null) {
    const parts = String(environment.EXPECTED_QUERY_ROWS).split(',');
    const count = strategy === 'v1' ? 1 : 3;
    if (parts.length !== count || parts.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) > 250_000)) {
      throw new Error(`EXPECTED_QUERY_ROWS must contain ${count} bounded nonnegative row counts`);
    }
    config.expectedQueryRows = parts.map(Number);
    if (config.expectedRows == null || config.expectedQueryRows.reduce((sum, rows) => sum + rows, 0) !== config.expectedRows) {
      throw new Error('EXPECTED_QUERY_ROWS must sum to EXPECTED_ROWS');
    }
  }

  if (loadModel === 'closed') {
    config.vus = integerSetting(environment, 'VUS', 5, 1, 200);
  } else {
    config.rate = integerSetting(environment, 'RATE', 50, 1, 5000);
    config.preAllocatedVUs = integerSetting(environment, 'PREALLOCATED_VUS', 20, 1, 500);
    config.maxVUs = integerSetting(environment, 'MAX_VUS', 100, 1, 500);
    if (config.preAllocatedVUs > config.maxVUs) throw new Error('PREALLOCATED_VUS must not exceed MAX_VUS');
  }
  return config;
}

/** Optional campaign invariants; ordinary latency/pool runs keep their existing contract. */
export function matchesExpectedRows(metrics, config) {
  return (config.expectedRows == null || metrics?.totalRows === config.expectedRows)
    && (config.expectedQueryRows == null || (Array.isArray(metrics?.queries)
      && metrics.queries.length === config.expectedQueryRows.length
      && config.expectedQueryRows.every((rows, index) => metrics.queries[index]?.rows === rows)));
}

export function buildMeasuredScenario(config) {
  const common = { duration: config.duration, gracefulStop: config.requestTimeout };
  return config.loadModel === 'closed'
    ? { executor: 'constant-vus', vus: config.vus, ...common }
    : {
      executor: 'constant-arrival-rate', rate: config.rate, timeUnit: '1s',
      preAllocatedVUs: config.preAllocatedVUs, maxVUs: config.maxVUs, ...common,
    };
}

export function summarizeMeasuredLoad(metrics = {}) {
  const metricValue = (name, key, fallback = null) => {
    const value = metrics[name]?.values?.[key];
    return Number.isFinite(value) ? value : fallback;
  };
  const startedRequests = metricValue('measured_started_requests', 'count', 0);
  const completedRequests = metricValue('measured_requests', 'count', 0);
  const successfulRequests = metricValue('measured_successes', 'count', 0);
  const elapsed = metricValue('measured_elapsed_ms', 'max');
  const measuredElapsedMs = completedRequests > 0 && elapsed > 0 ? elapsed : null;

  return {
    startedRequests,
    completedRequests,
    successfulRequests,
    incompleteRequests: Math.max(0, startedRequests - completedRequests),
    httpErrorRate: metricValue('measured_http_errors', 'rate'),
    contractErrorRate: metricValue('contract_errors', 'rate'),
    droppedIterations: metricValue('dropped_iterations', 'count', 0),
    measuredElapsedMs,
    completedRequestsPerSecond: measuredElapsedMs === null ? null : completedRequests * 1000 / measuredElapsedMs,
    successfulRequestsPerSecond: measuredElapsedMs === null ? null : successfulRequests * 1000 / measuredElapsedMs,
  };
}
