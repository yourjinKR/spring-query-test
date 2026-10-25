import type { Post, Sample, Version } from './types.ts';

export function parseIds(input: string): number[] {
  if (!input.trim()) throw new Error('조회할 게시글 ID를 입력해 주세요.');
  const ids = new Set<number>();
  for (const part of input.split(',')) {
    const token = part.trim();
    if (!/^\d+(?:\s*-\s*\d+)?$/.test(token)) {
      throw new Error('ID는 1,2,3 또는 1-50 형식으로 입력해 주세요.');
    }
    const [start, end = start] = token.split('-').map((value) => Number(value.trim()));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('ID는 양의 정수이며 범위의 시작은 끝보다 작거나 같아야 합니다.');
    }
    if (end - start >= 100) throw new Error('최대 100개의 게시글 ID를 조회할 수 있습니다.');
    for (let id = start; id <= end; id += 1) {
      ids.add(id);
      if (ids.size > 100) throw new Error('최대 100개의 게시글 ID를 조회할 수 있습니다.');
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** Nearest-rank percentile, with no interpolation of observed samples. */
export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1));
  return sorted[position];
}

export function summarize(samples: Sample[], version: Version) {
  const selected = samples.filter((sample) => sample.version === version);
  const extract = (key: 'fetchAndAssembleMs' | 'jdbcExecuteMs' | 'assemblyMs') => selected.map((sample) => sample.metrics[key]);
  const http = selected.map((sample) => sample.httpMs);
  return {
    count: selected.length,
    fetchP50: percentile(extract('fetchAndAssembleMs'), 0.5),
    fetchP95: percentile(extract('fetchAndAssembleMs'), 0.95),
    httpP50: percentile(http, 0.5),
    httpP95: percentile(http, 0.95),
    httpP99: percentile(http, 0.99),
    jdbcP50: percentile(extract('jdbcExecuteMs'), 0.5),
    assemblyP50: percentile(extract('assemblyMs'), 0.5),
    rows: selected.at(-1)?.metrics.totalRows ?? null,
    queryCount: selected.at(-1)?.metrics.queryCount ?? null,
  };
}

export function samePosts(left: Post[], right: Post[]): boolean {
  return sameValue(left, right);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

export function executionOrder(iteration: number): Version[] {
  return iteration % 2 === 0 ? ['v1', 'v2'] : ['v2', 'v1'];
}
