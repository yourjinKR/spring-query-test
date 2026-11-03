import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { bindIds, parseArgs, statisticsDelta, summarizePlan } from './explain-cardinality.mjs';

test('diagnostic arguments normalize fixed-range scenarios and output without contacting services', () => {
  const options = parseArgs(['--output', '.cache/diagnostic-test', '--base-url', 'http://localhost:8080///', '--scenarios', '0/0,01/01,100/20']);
  assert.equal(options.baseUrl, 'http://localhost:8080');
  assert.equal(options.output, resolve('.cache/diagnostic-test'));
  assert.deepEqual(options.scenarios, [
    { id: '0/0', commentsPerPost: 0, attachmentsPerPost: 0 },
    { id: '1/1', commentsPerPost: 1, attachmentsPerPost: 1 },
    { id: '100/20', commentsPerPost: 100, attachmentsPerPost: 20 },
  ]);
});

test('diagnostics require a distinct output and reject incomplete or unknown options', () => {
  assert.throws(() => parseArgs([]), /--output/);
  assert.throws(() => parseArgs(['--output']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--output', 'out', '--duration', '30s']), /Unknown or incomplete/);
});

test('diagnostics reject credentials and non-HTTP, query or fragment URLs', () => {
  for (const baseUrl of ['file:///tmp/x', 'http://user:secret@localhost:8080', 'http://localhost:8080/?x=1', 'https://localhost/#fragment']) {
    assert.throws(() => parseArgs(['--output', 'out', '--base-url', baseUrl]), /HTTP URL/);
  }
});

test('diagnostics reject duplicates after numeric normalization and invalid cardinalities', () => {
  for (const scenarios of ['1/1,01/01', '', '1/1,', '-1/1', '1/1.5', '101/20', '100/21', '1 /1']) {
    assert.throws(() => parseArgs(['--output', 'out', '--scenarios', scenarios]), /Scenarios/);
  }
});

const capturedSql = 'select p.id, p.body from lab_post p where p.id in (?,?,?,?,?,?,?,?,?,?) order by p.id';
test('binding substitutes exactly the fixed ten IDs and preserves SQL projection and ordering', () => {
  assert.equal(bindIds(capturedSql), 'select p.id, p.body from lab_post p where p.id in (1,2,3,4,5,6,7,8,9,10) order by p.id');
  assert.equal(bindIds(`  SELECT p.id FROM lab_post p WHERE p.id IN (?,?,?,?,?,?,?,?,?,?)`),
    '  SELECT p.id FROM lab_post p WHERE p.id IN (1,2,3,4,5,6,7,8,9,10)');
});

test('binding refuses mutation, multi-statement input and the wrong number of placeholders', () => {
  for (const sql of [null, '', 'delete from lab_post where id in (?,?,?,?,?,?,?,?,?,?)', `${capturedSql};select 1`,
    `${capturedSql};`, capturedSql.replace('?,', ''), capturedSql.replace('in (', 'in (?,')]) {
    assert.throws(() => bindIds(sql), /one captured SELECT/);
  }
});

test('plan summary preserves per-loop rows and nested nodes without summing inclusive buffers', () => {
  const document = [{ 'Execution Time': 2.5, 'Planning Time': 0.1, Plan: {
    'Node Type': 'Sort', 'Actual Rows': 1000, 'Actual Loops': 1, 'Shared Hit Blocks': 30,
    'Sort Method': 'quicksort', 'Sort Space Type': 'Memory', Plans: [{
      'Node Type': 'Nested Loop', 'Join Type': 'Left', 'Actual Rows': 100, 'Actual Loops': 10,
      'Shared Hit Blocks': 30, Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'lab_comment',
        'Actual Rows': 20, 'Actual Loops': 10, 'Shared Hit Blocks': 20, 'Shared Read Blocks': 2 }],
    }],
  } }];
  const before = structuredClone(document);
  const summary = summarizePlan(document);
  assert.equal(summary.executionTimeMs, 2.5);
  assert.equal(summary.planningTimeMs, 0.1);
  assert.equal(summary.top.actualRows, 1000);
  assert.equal(summary.top.sharedHitBlocks, 30);
  assert.equal(summary.top.sortMethod, 'quicksort');
  assert.equal(summary.top.sortSpaceType, 'Memory');
  assert.deepEqual(summary.nodes.map((node) => node.path), ['0', '0.0', '0.0.0']);
  assert.equal(summary.nodes[1].actualRows, 100);
  assert.equal(summary.nodes[1].actualLoops, 10);
  assert.equal(summary.nodes[1].joinType, 'Left');
  assert.equal(summary.nodes[2].relation, 'lab_comment');
  assert.equal(summary.nodes[2].sharedReadBlocks, 2);
  assert.match(summary.note, /do not sum/);
  assert.deepEqual(document, before);
});

test('plan summary retains temporary I/O and hash batching while absent counters default to zero', () => {
  const summary = summarizePlan([{ 'Execution Time': 0, Plan: { 'Node Type': 'Hash', 'Actual Rows': 0, 'Actual Loops': 1,
    'Temp Read Blocks': 3, 'Temp Written Blocks': 5, 'Hash Batches': 4 } }]);
  assert.equal(summary.executionTimeMs, 0);
  assert.equal(summary.planningTimeMs, null);
  assert.equal(summary.top.tempReadBlocks, 3);
  assert.equal(summary.top.tempWrittenBlocks, 5);
  assert.equal(summary.top.hashBatches, 4);
  assert.equal(summary.top.sharedReadBlocks, 0);
  assert.equal(summary.top.sharedHitBlocks, 0);
});

test('plan summary rejects absent plans and absent or non-finite execution timing', () => {
  for (const document of [undefined, [], [{}], [{ Plan: {} }], [{ Plan: {}, 'Execution Time': NaN }], [{ Plan: {}, 'Execution Time': Infinity }]]) {
    assert.throws(() => summarizePlan(document), /missing its plan or execution time/);
  }
});

const entry = (queryid, counters = {}) => ({ queryid, query: 'select p.id from lab_post p', calls: 10, rows: 100,
  total_exec_time: 5, shared_blks_hit: 20, shared_blks_read: 0, temp_blks_read: 0, temp_blks_written: 0, ...counters });
const snapshot = (entries, statsReset = '2026-10-30T00:00:00Z') => ({ entries, statsReset });

test('statistics delta subtracts counters and excludes unchanged SELECTs', () => {
  const before = snapshot([entry('one'), entry('unchanged')]);
  const after = snapshot([entry('one', { calls: 40, rows: 30100, total_exec_time: 65, shared_blks_hit: 80 }), entry('unchanged')]);
  const delta = statisticsDelta(before, after);
  assert.deepEqual(delta, [{ queryid: 'one', query: 'select p.id from lab_post p', calls: 30, rows: 30000,
    total_exec_time: 60, shared_blks_hit: 60, shared_blks_read: 0, temp_blks_read: 0, temp_blks_written: 0, meanExecutionTimeMs: 2 }]);
  assert.equal(before.entries[0].calls, 10);
});

test('statistics delta supports newly appearing normalized statements without resetting global statistics', () => {
  const delta = statisticsDelta(snapshot([]), snapshot([entry('new', { calls: 30, rows: 300, total_exec_time: 45 })]));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].calls, 30);
  assert.equal(delta[0].rows, 300);
  assert.equal(delta[0].meanExecutionTimeMs, 1.5);
});

test('statistics delta refuses reset timestamps, decreased counters and non-finite/missing counters', () => {
  assert.throws(() => statisticsDelta(snapshot([entry('q')]), snapshot([entry('q')], 'later')), /was reset/);
  assert.throws(() => statisticsDelta({ ...snapshot([]), dealloc: 0 }, { ...snapshot([]), dealloc: 1 }), /evicted/);
  for (const counters of [{ calls: 9 }, { rows: 99 }, { total_exec_time: 4 }, { shared_blks_hit: 19 },
    { shared_blks_read: -1 }, { temp_blks_read: NaN }, { temp_blks_written: undefined }, { total_exec_time: Infinity }]) {
    assert.throws(() => statisticsDelta(snapshot([entry('q')]), snapshot([entry('q', counters)])), /Invalid\/reset/);
  }
});
