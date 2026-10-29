import http from 'k6/http';
import execution from 'k6/execution';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { buildMeasuredScenario, matchesExpectedRows, parseLoadConfig, summarizeMeasuredLoad } from './lib/load-config.mjs';

const config = parseLoadConfig(__ENV);
const { strategy, baseUrl, ids, warmup, loadModel, requestTimeout } = config;

const measuredHttpMs = new Trend('measured_http_ms', true);
const measuredElapsedMs = new Trend('measured_elapsed_ms', true);
const measuredStartedRequests = new Counter('measured_started_requests');
const measuredRequests = new Counter('measured_requests');
const measuredSuccesses = new Counter('measured_successes');
const measuredHttpErrors = new Rate('measured_http_errors');
const fetchAndAssembleMs = new Trend('fetch_and_assemble_ms', true);
const jdbcExecuteMs = new Trend('jdbc_execute_ms', true);
const assemblyMs = new Trend('assembly_ms', true);
const returnedRows = new Trend('returned_rows');
const queryCount = new Trend('query_count');
const queryRows = [1, 2, 3].map((index) => new Trend(`query_${index}_rows`));
const contractErrors = new Rate('contract_errors');
const expectedQueries = strategy === 'v1' ? 1 : 3;
const url = `${baseUrl}/${strategy}/posts?ids=${encodeURIComponent(ids.join(','))}&mode=benchmark`;

export const options = {
  scenarios: {
    measured: buildMeasuredScenario(config),
  },
  thresholds: {
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'checks{phase:measure}': ['rate==1'],
    contract_errors: ['rate==0'],
    ...(loadModel === 'arrival' ? { dropped_iterations: ['count==0'] } : {}),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
  tags: { strategy, load_model: loadModel },
  setupTimeout: '5m',
};

// Setup finishes before the measured scenario starts. Built-in all-phase HTTP
// metrics also contain these calls; use measured_http_ms or phase:measure below.
export function setup() {
  for (let i = 0; i < warmup; i += 1) {
    const response = http.get(url, { tags: { phase: 'warmup', name: `GET /${strategy}/posts` }, timeout: requestTimeout });
    if (response.status !== 200) fail(`Warmup failed: HTTP ${response.status}: ${response.body}`);
  }
}

export default function () {
  measuredStartedRequests.add(1);
  const response = http.get(url, { tags: { phase: 'measure', name: `GET /${strategy}/posts` }, timeout: requestTimeout });
  measuredRequests.add(1);
  // scenario.startTime excludes setup. The last completion may be in gracefulStop.
  measuredElapsedMs.add(Math.max(0, Date.now() - execution.scenario.startTime));
  measuredHttpErrors.add(response.status !== 200);
  measuredHttpMs.add(response.timings.duration);
  let result;
  try { result = response.json(); } catch { result = null; }
  const valid = check(response, {
    'HTTP 200': (r) => r.status === 200,
    'expected SELECT count': () => result?.metrics?.queryCount === expectedQueries,
    'posts is an array': () => Array.isArray(result?.posts),
    'finite nonnegative row count': () => Number.isFinite(result?.metrics?.totalRows) && result.metrics.totalRows >= 0,
    'expected campaign rows': () => matchesExpectedRows(result?.metrics, config),
    'finite nonnegative server timings': () => ['fetchAndAssembleMs', 'jdbcExecuteMs', 'assemblyMs']
      .every((name) => Number.isFinite(result?.metrics?.[name]) && result.metrics[name] >= 0),
    'benchmark omits SQL text': () => Array.isArray(result?.metrics?.queries)
      && result.metrics.queries.every((query) => query.sql == null || query.sql === ''),
  }, { phase: 'measure' });
  contractErrors.add(!valid);
  if (!valid) return;
  measuredSuccesses.add(1);
  fetchAndAssembleMs.add(result.metrics.fetchAndAssembleMs);
  jdbcExecuteMs.add(result.metrics.jdbcExecuteMs);
  assemblyMs.add(result.metrics.assemblyMs);
  returnedRows.add(result.metrics.totalRows);
  queryCount.add(result.metrics.queryCount);
  result.metrics.queries.forEach((query, index) => queryRows[index]?.add(query.rows));
}

export function handleSummary(data) {
  const measurements = summarizeMeasuredLoad(data.metrics);
  const report = {
    metadata: { ...config, recordedAt: new Date().toISOString() },
    measurements,
    measurementWindow: 'Scenario start through the last completed HTTP attempt, including final in-flight drain; excludes setup warmup. Failed HTTP attempts and returned timeouts count as completed. Requests interrupted before returning are incomplete.',
    notes: [
      'Use measured_http_ms and phase:measure metrics. Aggregate built-in HTTP metrics and raw Counter rates can include setup and shutdown time.',
      'completedRequestsPerSecond is completed count divided by measured_elapsed_ms.max, not a steady-state-only throughput estimate.',
      loadModel === 'closed'
        ? 'Closed-loop constant VUs: slower responses reduce request arrivals.'
        : 'Open-loop constant arrival rate: dropped_iterations > 0 means the configured arrival rate was not fully delivered; inspect generator VU/CPU capacity and server latency.',
    ],
    results: data,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  return __ENV.SUMMARY_PATH ? { stdout: output, [__ENV.SUMMARY_PATH]: output } : { stdout: output };
}
