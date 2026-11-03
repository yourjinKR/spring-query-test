import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runComparison } from './compare.mjs';
import { distribution } from './analyze-study.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ids = Array.from({ length: 10 }, (_, index) => index + 1);
const fixedConfig = { postCount: 200, bodyBytes: 1024, seed: 42, distribution: 'UNIFORM' };
const statisticsSql = `SELECT json_build_object(
  'capturedAt', clock_timestamp(),
  'statsReset', (SELECT stats_reset FROM pg_stat_statements_info),
  'dealloc', (SELECT dealloc FROM pg_stat_statements_info),
  'entries', COALESCE((SELECT json_agg(s) FROM (
    SELECT queryid::text, calls, rows, total_exec_time, shared_blks_hit, shared_blks_read,
           temp_blks_read, temp_blks_written, query
    FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND toplevel AND query ~* '^select' AND query ~* 'lab_(post|comment|attachment)'
      AND query !~* 'pg_stat_statements'
    ORDER BY queryid
  ) s), '[]'::json))`;

export function parseArgs(args) {
  const options = { baseUrl: 'http://127.0.0.1:8080', scenarios: '1/1,20/5,50/20,100/20', output: null };
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--base-url': 'baseUrl', '--scenarios': 'scenarios', '--output': 'output' }[args[index]];
    if (!key || args[index + 1] == null) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = args[index + 1];
  }
  if (!options.output) throw new Error('Use --output <new-diagnostic-directory> [--scenarios 1/1,20/5,50/20,100/20]');
  const url = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--base-url must be an HTTP URL without credentials, query or fragment');
  }
  options.baseUrl = options.baseUrl.replace(/\/+$/, '');
  options.scenarios = options.scenarios.split(',').map((text) => {
    const match = /^(\d+)\/(\d+)$/.exec(text);
    if (!match || Number(match[1]) > 100 || Number(match[2]) > 20) throw new Error('Scenarios must use comments/attachments within 0..100 / 0..20');
    return { id: `${Number(match[1])}/${Number(match[2])}`, commentsPerPost: Number(match[1]), attachmentsPerPost: Number(match[2]) };
  });
  if (!options.scenarios.length || new Set(options.scenarios.map((scenario) => scenario.id)).size !== options.scenarios.length) {
    throw new Error('Scenarios must be nonempty and distinct');
  }
  options.output = resolve(options.output);
  return options;
}

async function docker(args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', args, { cwd: repositoryRoot, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('Docker diagnostic command timed out after 60s')); }, 60_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolveCommand(stdout.trim());
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) { child.kill(); finish(new Error('Docker diagnostic output exceeded 16 MiB')); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_768); });
    child.on('error', finish);
    child.on('close', (code) => finish(code === 0 ? null : new Error(`Docker diagnostic command failed (${code}): ${stderr}`)));
  });
}

const compose = (...args) => docker(['compose', '-f', 'compose.yaml', ...args]);
const sqlJson = async (sql) => JSON.parse(await compose('exec', '-T', 'db', 'psql', '-X', '-t', '-A', '-U', 'querylab', '-d', 'querylab', '-v', 'ON_ERROR_STOP=1', '-c', sql));
const hashPosts = (posts) => createHash('sha256').update(JSON.stringify(posts)).digest('hex');

async function api(options, path, config) {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: config ? 'POST' : 'GET',
    ...(config ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) } : {}),
    signal: AbortSignal.timeout(120_000), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

function expectedQueryRows(scenario, strategy) {
  return strategy === 'v1' ? [10 * Math.max(1, scenario.commentsPerPost) * Math.max(1, scenario.attachmentsPerPost)]
    : [10, 10 * scenario.commentsPerPost, 10 * scenario.attachmentsPerPost];
}

function assertDataset(dataset, scenario) {
  const expected = { ...fixedConfig, commentsPerPost: scenario.commentsPerPost, attachmentsPerPost: scenario.attachmentsPerPost };
  if (!isDeepStrictEqual(dataset.config, expected) || dataset.postCount !== 200
    || dataset.commentCount !== 200 * scenario.commentsPerPost || dataset.attachmentCount !== 200 * scenario.attachmentsPerPost) {
    throw new Error(`Dataset mismatch for ${scenario.id}`);
  }
}

function assertSample(sample, scenario) {
  const expected = expectedQueryRows(scenario, sample.strategy);
  if (sample.postCount !== 10 || sample.metrics?.queryCount !== expected.length
    || sample.metrics.totalRows !== expected.reduce((total, value) => total + value, 0)
    || !isDeepStrictEqual(sample.metrics.queries?.map((query) => query.rows), expected)) {
    throw new Error(`Returned row or SELECT contract mismatch for ${scenario.id}/${sample.strategy}`);
  }
}

export function bindIds(sql) {
  if (typeof sql !== 'string' || !/^select\b/i.test(sql.trim()) || (sql.match(/\?/g) ?? []).length !== ids.length || /;/.test(sql)) {
    throw new Error('Expected one captured SELECT with exactly ten ID placeholders');
  }
  let index = 0;
  return sql.replace(/\?/g, () => String(ids[index++]));
}

export function summarizePlan(document) {
  const plan = document?.[0];
  if (!plan?.Plan || !Number.isFinite(plan['Execution Time'])) throw new Error('EXPLAIN JSON is missing its plan or execution time');
  const nodes = [];
  function visit(node, path) {
    nodes.push({ path, nodeType: node['Node Type'], joinType: node['Join Type'] ?? null,
      relation: node['Relation Name'] ?? null, actualRows: node['Actual Rows'], actualLoops: node['Actual Loops'],
      sharedHitBlocks: node['Shared Hit Blocks'] ?? 0, sharedReadBlocks: node['Shared Read Blocks'] ?? 0,
      tempReadBlocks: node['Temp Read Blocks'] ?? 0, tempWrittenBlocks: node['Temp Written Blocks'] ?? 0,
      sortMethod: node['Sort Method'] ?? null, sortSpaceType: node['Sort Space Type'] ?? null,
      hashBatches: node['Hash Batches'] ?? null });
    (node.Plans ?? []).forEach((child, index) => visit(child, `${path}.${index}`));
  }
  visit(plan.Plan, '0');
  return { executionTimeMs: plan['Execution Time'], planningTimeMs: plan['Planning Time'] ?? null,
    top: nodes[0], nodes,
    note: 'Rows are per-loop node output. Parent buffers include descendants; do not sum nodes. EXPLAIN excludes normal result transfer and DTO/JSON work.' };
}

function summarizePlans(plans) {
  const summaries = plans.map(summarizePlan);
  if (new Set(summaries.map((summary) => JSON.stringify(summary.nodes.map(({ path, nodeType, joinType, relation }) => ({ path, nodeType, joinType, relation }))))).size !== 1) {
    return { repetitions: summaries.length, planChanged: true, runs: summaries };
  }
  return { repetitions: summaries.length, planChanged: false,
    executionTimeMs: distribution(summaries.map((summary) => summary.executionTimeMs)),
    planningTimeMs: distribution(summaries.map((summary) => summary.planningTimeMs)),
    nodes: summaries[0].nodes.map((node, index) => ({ ...node,
      ...Object.fromEntries(['actualRows', 'actualLoops', 'sharedHitBlocks', 'sharedReadBlocks', 'tempReadBlocks', 'tempWrittenBlocks']
        .map((key) => [key, distribution(summaries.map((summary) => summary.nodes[index][key]))])) })),
    note: summaries[0].note };
}

export function statisticsDelta(before, after) {
  if (before.statsReset !== after.statsReset) throw new Error('pg_stat_statements was reset during diagnostic HTTP calls');
  if (before.dealloc !== after.dealloc) throw new Error('pg_stat_statements entries were evicted during diagnostic HTTP calls');
  const previous = new Map(before.entries.map((entry) => [entry.queryid, entry]));
  return after.entries.flatMap((entry) => {
    const first = previous.get(entry.queryid);
    const delta = Object.fromEntries(['calls', 'rows', 'total_exec_time', 'shared_blks_hit', 'shared_blks_read', 'temp_blks_read', 'temp_blks_written']
      .map((key) => [key, entry[key] - (first?.[key] ?? 0)]));
    if (Object.values(delta).some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`Invalid/reset pg_stat_statements counters for queryid ${entry.queryid}`);
    return delta.calls > 0 ? [{ queryid: entry.queryid, query: entry.query, ...delta,
      meanExecutionTimeMs: delta.total_exec_time / delta.calls }] : [];
  });
}

export async function runDiagnostics(options) {
  await mkdir(options.output, { recursive: true });
  const reportPath = join(options.output, 'report.json');
  try { await access(reportPath); throw new Error('Output already contains a diagnostic report; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = { schemaVersion: 1, experiment: 'cardinality-diagnostics', startedAt: new Date().toISOString(), completedAt: null,
    status: 'running', error: null, parameters: options, route: null, datasetBefore: null, originalComparison: null,
    scenarios: [], warnings: [], restoration: { attempted: false, valid: false },
    notes: ['Run only after the HTTP benchmark completes; never concurrently with benchmarks or other profiling.',
      'EXPLAIN uses captured application SELECT projections and substitutes the fixed ID values. Three executions per SELECT are descriptive diagnostics.',
      'pg_stat_statements snapshots surround 30 separate HTTP requests per strategy. Those requests are not part of the k6 performance results.',
      'No statistics reset is performed. PostgreSQL execution time, JDBC execute time and HTTP time have different scopes.'] };
  const save = async () => {
    await writeFile(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await rename(`${reportPath}.tmp`, reportPath);
  };
  const compare = () => runComparison({ baseUrl: options.baseUrl, ids, warmup: 1, repeats: 1, mode: 'analysis' });
  let mutationAttempted = false;
  await save();
  try {
    report.route = await compose('exec', '-T', 'server', 'printenv', 'DB_URL');
    if (report.route !== 'jdbc:postgresql://db:5432/querylab') throw new Error('Diagnostics require the direct application DB route');
    const names = await docker(['ps', '--filter', 'label=com.docker.compose.project=spring-query-lab', '--format', '{{.Names}}']);
    if (names.split(/\r?\n/).some((name) => /querylab-load-|(?:^|-)k6(?:-|$)/.test(name))) throw new Error('A k6 workload is running; diagnostics must be isolated');
    report.datasetBefore = await api(options, '/lab/dataset');
    if (!report.datasetBefore.config) throw new Error('Original dataset has no reproducible seed configuration');
    report.originalComparison = await compare();
    if (report.originalComparison.error || !report.originalComparison.equalResults) throw new Error('Original DTO equality check failed');
    await save();
    for (const scenario of options.scenarios) {
      const point = { ...scenario, status: 'running', error: null, datasetBefore: null, datasetAfter: null,
        correctness: null, explains: [], statements: [] };
      report.scenarios.push(point);
      await save();
      mutationAttempted = true;
      point.datasetBefore = await api(options, '/lab/dataset', { ...fixedConfig, commentsPerPost: scenario.commentsPerPost, attachmentsPerPost: scenario.attachmentsPerPost });
      assertDataset(point.datasetBefore, scenario);
      point.correctness = await compare();
      if (point.correctness.error || !point.correctness.equalResults) throw new Error(`DTO mismatch for ${scenario.id}`);
      for (const sample of point.correctness.samples) assertSample(sample, scenario);
      if (!isDeepStrictEqual(point.correctness.datasetBefore, point.datasetBefore) || !isDeepStrictEqual(point.correctness.datasetAfter, point.datasetBefore)) throw new Error('Dataset changed during diagnostic correctness check');
      const expectedHash = point.correctness.samples[0].postsSha256;
      await save();
      for (const strategy of ['v1', 'v2']) {
        const sample = point.correctness.samples.find((entry) => entry.strategy === strategy);
        for (let index = 0; index < sample.metrics.queries.length; index++) {
          const sql = bindIds(sample.metrics.queries[index].sql);
          const entry = { strategy, query: index + 1, sql, expectedRows: expectedQueryRows(scenario, strategy)[index], rawFiles: [], summary: null };
          point.explains.push(entry);
          const plans = [];
          for (let repetition = 1; repetition <= 3; repetition++) {
            const document = await sqlJson(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
            const filename = `explain-${scenario.commentsPerPost}-${scenario.attachmentsPerPost}-${strategy}-query-${index + 1}-repeat-${repetition}.json`;
            await writeFile(join(options.output, filename), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
            entry.rawFiles.push(filename);
            plans.push(document);
            const summary = summarizePlan(document);
            if (summary.top.actualRows * summary.top.actualLoops !== entry.expectedRows) throw new Error('EXPLAIN top-level actual rows differ from expected application rows');
            entry.summary = summarizePlans(plans);
            await save();
          }
        }
        const statementPoint = { strategy, httpRequests: 30, status: 'running', before: null, after: null, delta: null, requests: [] };
        point.statements.push(statementPoint);
        try { statementPoint.before = await sqlJson(statisticsSql); }
        catch (error) { statementPoint.status = 'unavailable'; statementPoint.error = error.message; report.warnings.push(`pg_stat_statements unavailable for ${scenario.id}/${strategy}: ${error.message}`); await save(); continue; }
        for (let index = 0; index < statementPoint.httpRequests; index++) {
          const response = await api(options, `/${strategy}/posts?ids=${ids.join(',')}&mode=benchmark`);
          assertSample({ strategy, postCount: response.posts?.length, metrics: response.metrics }, scenario);
          if (hashPosts(response.posts) !== expectedHash) throw new Error('Diagnostic HTTP DTO hash mismatch');
          statementPoint.requests.push({ iteration: index + 1, postsSha256: expectedHash, metrics: response.metrics });
        }
        statementPoint.after = await sqlJson(statisticsSql);
        statementPoint.delta = statisticsDelta(statementPoint.before, statementPoint.after);
        const totalCalls = statementPoint.delta.reduce((total, entry) => total + entry.calls, 0);
        const totalRows = statementPoint.delta.reduce((total, entry) => total + entry.rows, 0);
        const expectedRows = expectedQueryRows(scenario, strategy).reduce((total, value) => total + value, 0) * statementPoint.httpRequests;
        if (totalCalls !== statementPoint.httpRequests * (strategy === 'v1' ? 1 : 3) || totalRows !== expectedRows) {
          statementPoint.status = 'contaminated_or_incomplete';
          report.warnings.push(`pg_stat_statements call/row deltas do not match the isolated requests for ${scenario.id}/${strategy}`);
        } else statementPoint.status = 'completed';
        await save();
      }
      point.datasetAfter = await api(options, '/lab/dataset');
      assertDataset(point.datasetAfter, scenario);
      if (!isDeepStrictEqual(point.datasetBefore, point.datasetAfter)) throw new Error('Dataset changed during EXPLAIN diagnostics');
      point.status = 'completed';
      await save();
    }
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    const active = report.scenarios.at(-1);
    if (active?.status === 'running') { active.status = 'failed'; active.error = error.message; }
  } finally {
    if (mutationAttempted) {
      report.restoration.attempted = true;
      try {
        report.restoration.dataset = await api(options, '/lab/dataset', report.datasetBefore.config);
        report.restoration.comparison = await compare();
        report.restoration.valid = isDeepStrictEqual(report.restoration.dataset, report.datasetBefore)
          && !report.restoration.comparison.error && report.restoration.comparison.equalResults === true
          && report.restoration.comparison.samples.every((sample) => sample.postsSha256 === report.originalComparison.samples[0].postsSha256);
        if (!report.restoration.valid) throw new Error('Original dataset metadata or DTO hash could not be confirmed after restoration');
      } catch (error) { report.restoration.error = error.message; report.status = 'failed'; }
    }
    report.completedAt = new Date().toISOString();
    await save();
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    const report = await runDiagnostics(options);
    console.log(JSON.stringify({ output: join(options.output, 'report.json'), status: report.status, error: report.error,
      scenarios: report.scenarios.map(({ id, status }) => ({ id, status })), restored: report.restoration.valid, warnings: report.warnings }, null, 2));
    if (report.status !== 'completed') process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
