import http from 'k6/http';
import { check, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const strategy = __ENV.STRATEGY || 'v1';
if (!['v1', 'v2'].includes(strategy)) throw new Error('STRATEGY must be v1 or v2');
const baseUrl = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const ids = (__ENV.IDS || '1,2,3,4,5,6,7,8,9,10').split(',').map((id) => id.trim());
if (!ids.length || ids.length > 100 || ids.some((id) => !/^[1-9]\d*$/.test(id))) {
  throw new Error('IDS must contain 1..100 positive integer IDs separated by commas');
}
const warmup = Number(__ENV.WARMUP || 20);
const vus = Number(__ENV.VUS || 5);
if (!Number.isInteger(warmup) || warmup < 0 || warmup > 1000) throw new Error('WARMUP must be 0..1000');
if (!Number.isInteger(vus) || vus < 1 || vus > 200) throw new Error('VUS must be 1..200');

const measuredHttpMs = new Trend('measured_http_ms', true);
const fetchAndAssembleMs = new Trend('fetch_and_assemble_ms', true);
const jdbcExecuteMs = new Trend('jdbc_execute_ms', true);
const assemblyMs = new Trend('assembly_ms', true);
const returnedRows = new Trend('returned_rows');
const contractErrors = new Rate('contract_errors');
const expectedQueries = strategy === 'v1' ? 1 : 3;
const url = `${baseUrl}/${strategy}/posts?ids=${encodeURIComponent(ids.join(','))}&mode=benchmark`;

export const options = {
  scenarios: {
    measured: { executor: 'constant-vus', vus, duration: __ENV.DURATION || '30s', gracefulStop: '30s' },
  },
  thresholds: {
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'checks{phase:measure}': ['rate==1'],
    contract_errors: ['rate==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
  tags: { strategy },
  setupTimeout: '5m',
};

// Setup finishes before the measured scenario starts. Built-in all-phase HTTP
// metrics also contain these calls; use measured_http_ms or phase:measure below.
export function setup() {
  for (let i = 0; i < warmup; i += 1) {
    const response = http.get(url, { tags: { phase: 'warmup', name: `GET /${strategy}/posts` }, timeout: '120s' });
    if (response.status !== 200) fail(`Warmup failed: HTTP ${response.status}: ${response.body}`);
  }
}

export default function () {
  const response = http.get(url, { tags: { phase: 'measure', name: `GET /${strategy}/posts` }, timeout: '120s' });
  measuredHttpMs.add(response.timings.duration);
  let result;
  try { result = response.json(); } catch { result = null; }
  const valid = check(response, {
    'HTTP 200': (r) => r.status === 200,
    'expected SELECT count': () => result?.metrics?.queryCount === expectedQueries,
    'posts is an array': () => Array.isArray(result?.posts),
    'finite nonnegative row count': () => Number.isFinite(result?.metrics?.totalRows) && result.metrics.totalRows >= 0,
    'finite nonnegative server timings': () => ['fetchAndAssembleMs', 'jdbcExecuteMs', 'assemblyMs']
      .every((name) => Number.isFinite(result?.metrics?.[name]) && result.metrics[name] >= 0),
    'benchmark omits SQL text': () => Array.isArray(result?.metrics?.queries)
      && result.metrics.queries.every((query) => query.sql == null || query.sql === ''),
  }, { phase: 'measure' });
  contractErrors.add(!valid);
  if (!valid) return;
  fetchAndAssembleMs.add(result.metrics.fetchAndAssembleMs);
  jdbcExecuteMs.add(result.metrics.jdbcExecuteMs);
  assemblyMs.add(result.metrics.assemblyMs);
  returnedRows.add(result.metrics.totalRows);
}

export function handleSummary(data) {
  const report = {
    metadata: { strategy, baseUrl, ids, vus, warmup, duration: __ENV.DURATION || '30s', recordedAt: new Date().toISOString() },
    note: 'Use measured_http_ms and phase:measure metrics: aggregate built-in HTTP metrics also include setup warmup calls. This is a closed-loop constant-VU load test.',
    results: data,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  return __ENV.SUMMARY_PATH ? { stdout: output, [__ENV.SUMMARY_PATH]: output } : { stdout: output };
}
