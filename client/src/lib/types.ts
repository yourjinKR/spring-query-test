export type Version = 'v1' | 'v2';
export type ObservationMode = 'analysis' | 'benchmark';
export type Distribution = 'UNIFORM' | 'SKEWED';

export interface DatasetConfig {
  postCount: number;
  commentsPerPost: number;
  attachmentsPerPost: number;
  bodyBytes: number;
  seed: number;
  distribution: Distribution;
}

export interface DatasetStatus {
  postCount: number;
  commentCount: number;
  attachmentCount: number;
  config: DatasetConfig | null;
}

export interface Post {
  id: number;
  title: string;
  body: string;
  comments: { id: number; content: string }[];
  attachments: { id: number; fileName: string; byteSize: number }[];
}

export interface QueryMetric {
  sql: string | null;
  elapsedMs: number;
  rows: number;
}

export interface Metrics {
  queryCount: number;
  totalRows: number;
  fetchAndAssembleMs: number;
  jdbcExecuteMs: number;
  assemblyMs: number;
  queries: QueryMetric[];
}

export interface QueryResponse {
  strategy: 'SINGLE_JOIN' | 'SPLIT_QUERIES';
  posts: Post[];
  metrics: Metrics;
}

export interface Sample {
  iteration: number;
  order: number;
  version: Version;
  httpMs: number;
  metrics: Metrics;
  parentCount: number;
}

export interface Experiment {
  startedAt: string;
  completedAt: string;
  ids: number[];
  mode: ObservationMode;
  warmups: number;
  repetitions: number;
  dataset: DatasetStatus;
  datasetAfter: DatasetStatus;
  datasetUnchanged: boolean;
  matchedPairs: number;
  samples: Sample[];
  latest: Record<Version, QueryResponse>;
  environment: { userAgent: string; origin: string };
}
