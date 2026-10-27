import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './lib/api.ts';
import { executionOrder, parseIds, samePosts, summarize } from './lib/experiment.ts';
import type { DatasetConfig, DatasetStatus, Experiment, ObservationMode, QueryResponse, Sample, Version } from './lib/types.ts';

const DEFAULT_CONFIG: DatasetConfig = {
  postCount: 200, commentsPerPost: 20, attachmentsPerPost: 5,
  bodyBytes: 1024, seed: 42, distribution: 'UNIFORM',
};
const VERSIONS: Version[] = ['v1', 'v2'];
const nf = new Intl.NumberFormat('ko-KR');
const ms = (value: number | null) => value === null ? '—' : value.toFixed(2);
const number = (value: number | null) => value === null ? '—' : nf.format(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';

function Icon({ name, size = 18 }: { name: 'play' | 'database' | 'refresh' | 'download' | 'arrow' | 'check' | 'code' | 'close'; size?: number }) {
  const paths = {
    play: <path d="m8 5 11 7-11 7V5Z" />,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function NumericInput({ label, value, onChange, min, max, unit, note }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; unit?: string; note?: string;
}) {
  return <label className="field"><span className="field-label">{label}</span>
    <span className="input-wrap"><input type="number" required min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />{unit && <span className="input-unit">{unit}</span>}</span>
    {note && <span className="field-note">{note}</span>}
  </label>;
}

function ComparisonBars({ title, description, values, unit, decimals = true }: {
  title: string; description: string; values: [number | null, number | null]; unit: string; decimals?: boolean;
}) {
  const maximum = Math.max(0.001, ...values.map((value) => value ?? 0));
  return <div className="chart-card"><div className="chart-heading"><h3>{title}</h3><span>{unit}</span></div>
    <p>{description}</p><div className="bar-chart">
      {VERSIONS.map((version, index) => <div className="bar-row" key={version}>
        <span className={`version-label ${version}`}>{version}</span>
        <div className="bar-track"><div className={`bar-fill ${version}`} style={{ width: values[index] === null ? '0%' : `${Math.max(values[index]! > 0 ? 1 : 0, values[index]! / maximum * 100)}%` }} /></div>
        <span className="bar-value">{decimals ? ms(values[index]) : number(values[index])}</span>
      </div>)}
    </div>
  </div>;
}

function TrialChart({ samples }: { samples: Sample[] }) {
  const data = VERSIONS.map((version) => samples.filter((sample) => sample.version === version));
  const maximum = Math.max(1, ...samples.map((sample) => sample.metrics.fetchAndAssembleMs));
  const length = Math.max(1, data[0].length - 1);
  const points = (group: Sample[]) => group.map((sample, i) => `${38 + i / length * 694},${143 - sample.metrics.fetchAndAssembleMs / maximum * 113}`).join(' ');
  return <div className="trial-chart"><div className="chart-heading"><h3>회차별 조회·조립 시간</h3><span>ms · 낮을수록 빠름</span></div>
    {samples.length ? <svg className="line-chart" viewBox="0 0 760 177" role="img" aria-label="측정 회차별 v1과 v2의 서버 조회 및 조립 시간">
      {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1="38" x2="732" y1={143 - fraction * 113} y2={143 - fraction * 113} className="grid-line" /><text x="0" y={147 - fraction * 113}>{(maximum * fraction).toFixed(1)}</text></g>)}
      {data.map((group, index) => <g key={index} className={VERSIONS[index]}><polyline points={points(group)} fill="none" stroke="currentColor" strokeWidth="2" />{group.map((sample, i) => <circle key={i} cx={38 + i / length * 694} cy={143 - sample.metrics.fetchAndAssembleMs / maximum * 113} r="3" fill="currentColor"><title>{VERSIONS[index]} · {sample.iteration}회 · {sample.metrics.fetchAndAssembleMs.toFixed(3)} ms</title></circle>)}</g>)}
      <text x="38" y="169">1회</text><text x="706" y="169">{data[0].length}회</text>
    </svg> : <div className="chart-placeholder"><span /><span /><span /><p>실험을 실행하면 회차별 측정값이 표시됩니다.</p></div>}
    <div className="legend"><span><i className="dot v1" /> v1 · 단일 JOIN</span><span><i className="dot v2" /> v2 · 분할 조회</span></div>
  </div>;
}

export default function App() {
  const [dataset, setDataset] = useState<DatasetStatus | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [config, setConfig] = useState<DatasetConfig>(DEFAULT_CONFIG);
  const [idsInput, setIdsInput] = useState('1-50');
  const [mode, setMode] = useState<ObservationMode>('analysis');
  const [warmups, setWarmups] = useState(2);
  const [repetitions, setRepetitions] = useState(8);
  const [busy, setBusy] = useState<'seeding' | 'running' | 'refreshing' | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedRun, setSelectedRun] = useState(0);
  const [tab, setTab] = useState<'overview' | 'sql' | 'response'>('overview');
  const [previewVersion, setPreviewVersion] = useState<Version>('v1');
  const runController = useRef<AbortController | null>(null);
  const current = experiments[selectedRun];
  const summaries = { v1: summarize(current?.samples ?? [], 'v1'), v2: summarize(current?.samples ?? [], 'v2') };
  const configDirty = dataset?.config ? Object.keys(DEFAULT_CONFIG).some((key) => config[key as keyof DatasetConfig] !== dataset.config![key as keyof DatasetConfig]) : false;
  let parsedIds: number[] = [];
  let idsError: string | null = null;
  try { parsedIds = parseIds(idsInput); } catch (cause) { idsError = errorMessage(cause); }

  useEffect(() => {
    const controller = new AbortController();
    api<DatasetStatus>('/lab/dataset', {}, controller.signal).then((status) => {
      setDataset(status); setConnection('online'); if (status.config) setConfig(status.config);
    }).catch((cause) => {
      if (!controller.signal.aborted) { setConnection('offline'); setError(errorMessage(cause)); }
    });
    return () => { controller.abort(); runController.current?.abort(); };
  }, []);

  const updateConfig = <K extends keyof DatasetConfig>(key: K, value: DatasetConfig[K]) => setConfig((previous) => ({ ...previous, [key]: value }));

  async function refreshDataset() {
    setBusy('refreshing'); setError(null);
    try {
      const status = await api<DatasetStatus>('/lab/dataset');
      setDataset(status); setConnection('online'); if (status.config) setConfig(status.config);
    } catch (cause) { setConnection('offline'); setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function seedDataset(event: FormEvent) {
    event.preventDefault();
    setBusy('seeding'); setError(null); setNotice(null);
    try {
      const status = await api<DatasetStatus>('/lab/dataset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
      }, undefined, 120_000);
      setDataset(status); setConnection('online'); if (status.config) setConfig(status.config);
      setNotice('설정한 seed로 데이터 교체와 통계 갱신을 완료했습니다.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function runExperiment(event: FormEvent) {
    event.preventDefault();
    if (idsError || !dataset || busy) return;
    setBusy('running'); setError(null); setNotice(null);
    const controller = new AbortController();
    runController.current = controller;
    const startedAt = new Date().toISOString();
    const samples: Sample[] = [];
    const latest = {} as Record<Version, QueryResponse>;
    let matchedPairs = 0;
    const total = (warmups + repetitions) * 2;
    setProgress({ done: 0, total, label: '데이터 상태 확인 중' });
    try {
      const datasetBefore = await api<DatasetStatus>('/lab/dataset', {}, controller.signal);
      for (let round = 0; round < warmups + repetitions; round += 1) {
        const warming = round < warmups;
        const iteration = round - warmups + 1;
        const order = executionOrder(round);
        for (let position = 0; position < order.length; position += 1) {
          const version = order[position];
          setProgress({ done: round * 2 + position, total, label: `${warming ? `워밍업 ${round + 1}/${warmups}` : `측정 ${iteration}/${repetitions}`} · ${version}` });
          const before = performance.now();
          const response = await api<QueryResponse>(`/${version}/posts?ids=${parsedIds.join(',')}&mode=${mode}`, {}, controller.signal);
          const httpMs = performance.now() - before;
          latest[version] = response;
          if (!warming) samples.push({ iteration, order: position + 1, version, httpMs, metrics: response.metrics, parentCount: response.posts.length });
          setProgress({ done: round * 2 + position + 1, total, label: warming ? '워밍업 진행 중' : '측정 진행 중' });
        }
        if (!warming && samePosts(latest.v1.posts, latest.v2.posts)) matchedPairs += 1;
      }
      setProgress({ done: total, total, label: '데이터 정합성 확인 중' });
      const datasetAfter = await api<DatasetStatus>('/lab/dataset', {}, controller.signal);
      const datasetUnchanged = JSON.stringify(datasetBefore) === JSON.stringify(datasetAfter);
      const experiment: Experiment = {
        startedAt, completedAt: new Date().toISOString(), ids: parsedIds, mode, warmups, repetitions,
        dataset: datasetBefore, datasetAfter, datasetUnchanged, matchedPairs, samples, latest,
        environment: { userAgent: navigator.userAgent, origin: window.location.origin },
      };
      setExperiments((previous) => [experiment, ...previous].slice(0, 5)); setSelectedRun(0); setTab('overview');
      setDataset(datasetAfter); setConnection('online');
      if (matchedPairs !== repetitions || !datasetUnchanged) setError('응답 데이터 또는 데이터셋 상태가 일치하지 않습니다. 결과를 확인하고 동일 데이터에서 다시 실행해 주세요.');
      else setNotice(`${repetitions}회 비교를 완료했습니다. 모든 회차의 응답 데이터가 일치합니다.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); runController.current = null; }
  }

  function downloadExperiment() {
    if (!current) return;
    const payload = { schemaVersion: 1, ...current, summaries, measurementNotes: {
      percentiles: 'Nearest-rank; warmup requests excluded. Small browser samples are exploratory, not a load benchmark.',
      httpMs: 'Browser fetch through response body parsing; excludes rendering. Includes browser/network/proxy overhead.',
      totalRows: 'Flat tuples fetched before DTO grouping; not database rows scanned or network bytes.',
      fetchAndAssembleMs: 'Server query fetching and DTO assembly; excludes HTTP serialization.',
      jdbcExecuteMs: 'JDBC execute calls only; not pure DB execution and not all ResultSet consumption.',
      latest: 'Only the final response payload of each strategy is retained; raw timing samples are retained for all measured rounds.',
    } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `query-lab-${current.startedAt.replaceAll(':', '-')}.json`;
    anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const reduction = summaries.v1.rows && summaries.v2.rows !== null ? (1 - summaries.v2.rows / summaries.v1.rows) * 100 : null;
  const equalityPass = current && current.matchedPairs === current.repetitions && current.datasetUnchanged;
  const preview = current?.latest[previewVersion];

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Query Lab 홈"><span className="brand-mark"><span /><span /><span /></span><span>query<span className="brand-light">lab</span><span className="brand-period">.</span></span></a>
      <span className="topbar-caption">APPLICATION <span>↔</span> DATABASE</span>
      <div className={`connection ${connection}`}><i />{connection === 'online' ? 'API 연결됨' : connection === 'connecting' ? '연결 확인 중' : 'API 연결 안 됨'}</div>
      <a className="metrics-link" href="/actuator/prometheus" target="_blank" rel="noreferrer">Metrics <span>↗</span></a>
    </header>

    <main>
      <section className="page-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> QUERY STRATEGY EXPERIMENT</div><h1>한 번에 가져올까,<br className="mobile-break" /> 나눠서 가져올까<span>?</span></h1><p>같은 데이터, 다른 조회 전략. 쿼리 수와 반환 행 수의 균형을 직접 확인하세요.</p></div><div className="intro-badge"><span>01</span><div>JOIN vs Split Query<small>Java 21 · Spring Boot 4 · PostgreSQL</small></div></div></section>

      <div className="workspace">
        <aside className="sidebar">
          <section className="panel dataset-panel"><div className="panel-title"><span><Icon name="database" /> 실험 데이터</span><button className="icon-button" title="현재 데이터 상태 새로고침" aria-label="현재 데이터 상태 새로고침" disabled={!!busy} onClick={refreshDataset}><Icon name="refresh" size={16} /></button></div>
            <div className="dataset-stats"><div><strong>{dataset ? nf.format(dataset.postCount) : '—'}</strong><span>게시글</span></div><div><strong>{dataset ? nf.format(dataset.commentCount) : '—'}</strong><span>댓글</span></div><div><strong>{dataset ? nf.format(dataset.attachmentCount) : '—'}</strong><span>첨부파일</span></div></div>
            <form onSubmit={seedDataset}><fieldset disabled={!!busy}><legend className="sr-only">데이터 생성 설정</legend>
              <div className="field-label preset-label">시나리오 프리셋</div><div className="presets">
                {[{ label: '작게', comment: 1, attachment: 1 }, { label: '기본', comment: 20, attachment: 5 }, { label: '행 증폭', comment: 100, attachment: 20 }].map((preset) => <button type="button" key={preset.label} className={config.commentsPerPost === preset.comment && config.attachmentsPerPost === preset.attachment ? 'selected' : ''} onClick={() => setConfig((previous) => ({ ...previous, commentsPerPost: preset.comment, attachmentsPerPost: preset.attachment }))}>{preset.label}<small>{preset.comment} × {preset.attachment}</small></button>)}
              </div>
              <NumericInput label="전체 게시글 수" value={config.postCount} onChange={(value) => updateConfig('postCount', value)} min={1} max={10000} unit="개" />
              <div className="two-fields"><NumericInput label="게시글당 댓글" value={config.commentsPerPost} onChange={(value) => updateConfig('commentsPerPost', value)} min={0} max={200} /><NumericInput label="게시글당 첨부" value={config.attachmentsPerPost} onChange={(value) => updateConfig('attachmentsPerPost', value)} min={0} max={100} /></div>
              <div className="two-fields"><NumericInput label="본문 크기" value={config.bodyBytes} onChange={(value) => updateConfig('bodyBytes', value)} min={0} max={16384} unit="B" /><NumericInput label="고정 seed" value={config.seed} onChange={(value) => updateConfig('seed', value)} min={-2147483648} max={2147483647} /></div>
              <label className="field"><span className="field-label">자식 데이터 분포</span><select value={config.distribution} onChange={(event) => updateConfig('distribution', event.target.value as DatasetConfig['distribution'])}><option value="UNIFORM">균등 분포</option><option value="SKEWED">편향 분포</option></select>{config.distribution === 'SKEWED' && <span className="field-note">ID 10, 20, 30…에 댓글·첨부를 각각 설정값의 10배 생성하고, 나머지 게시글에는 생성하지 않습니다.</span>}</label>
              <p className="seed-note">생성하면 기존 실험 데이터를 교체합니다. 같은 설정과 seed로 재현할 수 있습니다.</p>
              <button className="secondary-button full-width" type="submit"><Icon name="refresh" size={15} />{busy === 'seeding' ? '데이터 생성 중…' : '데이터 생성 · 교체'}{configDirty && <i className="unsaved-dot" />}</button>
              {configDirty && <p className="pending-note">변경한 설정을 데이터에 적용해 주세요.</p>}
            </fieldset></form>
          </section>

          <section className="panel execution-panel"><div className="panel-title"><span><Icon name="play" /> 비교 실행</span><span className="tiny-label">SEQUENTIAL</span></div>
            <form onSubmit={runExperiment}><fieldset disabled={!!busy}><legend className="sr-only">실험 실행 설정</legend>
              <label className="field"><span className="field-label">조회할 게시글 ID <span>최대 100개</span></span><input type="text" required value={idsInput} onChange={(event) => setIdsInput(event.target.value)} placeholder="1-50 또는 1,2,3" aria-describedby="ids-note" aria-invalid={!!idsError} /><span id="ids-note" className={`field-note ${idsError ? 'invalid' : ''}`}>{idsError ?? `${parsedIds.length}개 ID · 중복 제거 후 오름차순`}</span></label>
              <div className="two-fields"><NumericInput label="워밍업" value={warmups} onChange={setWarmups} min={0} max={20} unit="회" /><NumericInput label="측정 반복" value={repetitions} onChange={setRepetitions} min={1} max={50} unit="회" /></div>
              <div className="field-label mode-label">관측 모드</div><div className="mode-switch"><button className={mode === 'analysis' ? 'active' : ''} type="button" onClick={() => setMode('analysis')}>분석 <span>SQL 포함</span></button><button className={mode === 'benchmark' ? 'active' : ''} type="button" onClick={() => setMode('benchmark')}>측정 <span>SQL 생략</span></button></div>
              <p className="execution-note">두 API를 순차 호출하고 매 회차 실행 순서를 교대합니다. 워밍업은 결과에서 제외합니다.</p>
              <button className="primary-button full-width" type="submit" disabled={!!idsError || !dataset || configDirty}><Icon name="play" size={17} />{busy === 'running' ? '실험 진행 중…' : '두 전략 비교하기'}<Icon name="arrow" size={16} /></button>
            </fieldset></form>
            {busy === 'running' && <div className="progress-box"><div><span>{progress.label}</span><span>{progress.done}/{progress.total}</span></div><progress max={progress.total || 1} value={progress.done} /><button type="button" className="text-button" onClick={() => runController.current?.abort()}>실험 중지</button></div>}
          </section>
          <p className="sidebar-footnote">이 화면은 순차 비교용입니다.<br />동시 부하와 처리량은 k6로 측정하세요.</p>
        </aside>

        <section className="results-area" aria-label="실험 결과">
          {error && <div role="alert" className="alert error"><span>!</span><p>{error}</p><button className="icon-button" aria-label="오류 메시지 닫기" onClick={() => setError(null)}><Icon name="close" size={15} /></button></div>}
          {notice && <div role="status" className="alert success"><Icon name="check" size={18} /><p>{notice}</p><button className="icon-button" aria-label="안내 메시지 닫기" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}

          <div className="strategy-grid">{VERSIONS.map((version) => <article key={version} className={`strategy-card ${version}`}><div className="strategy-topline"><span className="version-pill">{version}</span><span className="strategy-type">{version === 'v1' ? 'SINGLE JOIN' : 'SPLIT QUERIES'}</span><span className="strategy-dots">···</span></div><h2>{version === 'v1' ? '한 번의 JOIN' : '행 수를 줄인 분할 조회'}</h2><p>{version === 'v1' ? '게시글 + 댓글 + 첨부파일을 한 SQL로 조회' : '게시글 → 댓글 일괄 → 첨부파일 일괄 조회'}</p><div className="query-flow">{version === 'v1' ? <><span>Post</span><i>⋈</i><span>Comment</span><i>⋈</i><span>Attachment</span></> : <><span>Post</span><i>→</i><span>Comment[]</span><i>→</i><span>Attachment[]</span></>}</div><div className="strategy-bottom"><code>GET /{version}/posts</code><span>{number(summaries[version].queryCount)} <small>SQL / 요청</small></span></div></article>)}</div>

          <section className="panel result-panel"><div className="results-toolbar"><div className="tabs" role="group" aria-label="결과 보기"><button className={tab === 'overview' ? 'active' : ''} aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>관측 결과</button><button className={tab === 'sql' ? 'active' : ''} aria-pressed={tab === 'sql'} onClick={() => setTab('sql')}>SQL 상세</button><button className={tab === 'response' ? 'active' : ''} aria-pressed={tab === 'response'} onClick={() => setTab('response')}>응답 확인</button></div><button className="export-button" onClick={downloadExperiment} disabled={!current}><Icon name="download" size={15} /> JSON 내보내기</button></div>
            <div className="run-meta"><div><i className={current ? 'dot live' : 'dot idle'} /><span>{current ? `${new Date(current.completedAt).toLocaleTimeString('ko-KR')} · ${current.ids.length}개 ID · ${current.repetitions}회 측정 · ${current.mode === 'analysis' ? '분석 모드' : '측정 모드'}` : '실험을 실행하고 실제 측정값을 확인하세요.'}</span></div>{experiments.length > 1 && <select aria-label="이전 실행 결과" value={selectedRun} onChange={(event) => setSelectedRun(Number(event.target.value))}>{experiments.map((experiment, index) => <option value={index} key={experiment.startedAt}>{index === 0 ? '최근 실행' : `${index}회 전`} · {new Date(experiment.completedAt).toLocaleTimeString('ko-KR')}</option>)}</select>}</div>

            {tab === 'overview' && <div className="overview-content"><div className="highlight-grid"><div className="highlight"><span>반환 행 수 변화 <span className="metric-tag">v2 / v1</span></span><strong className={reduction !== null && reduction >= 0 ? 'accent-green' : ''}>{reduction === null ? '—' : `${Math.abs(reduction).toFixed(1)}`}<small>{reduction === null ? '' : `% ${reduction >= 0 ? '감소' : '증가'}`}</small></strong><p>최종 DTO 조립 전, 조회한 평탄한 행</p></div><div className="highlight"><span>조회·조립 중앙값 <span className="metric-tag">v1 → v2</span></span><strong>{ms(summaries.v1.fetchP50)}<i>→</i>{ms(summaries.v2.fetchP50)}<small>ms</small></strong><p>쿼리 실행 · 결과 소비 · DTO 조립</p></div><div className="highlight equality-highlight"><span>응답 데이터 정합성</span><strong className={current ? equalityPass ? 'accent-green' : 'accent-red' : ''}>{current ? equalityPass ? <><Icon name="check" size={22} /> 일치</> : '확인 필요' : '—'}</strong><p>{current ? `${current.matchedPairs}/${current.repetitions}회 DTO 일치 · ${current.datasetUnchanged ? '데이터 상태 동일' : '데이터 상태 변경'}` : '모든 측정 회차의 posts를 비교'}</p></div></div>
              <div className="charts-grid"><ComparisonBars title="DB가 반환한 행" description="마지막 요청의 전체 SQL 반환 행 합계" values={[summaries.v1.rows, summaries.v2.rows]} unit="rows" decimals={false} /><ComparisonBars title="서버 조회·조립 p50" description="서버에서 측정 · HTTP 직렬화 제외" values={[summaries.v1.fetchP50, summaries.v2.fetchP50]} unit="ms" /></div>
              <TrialChart samples={current?.samples ?? []} />
              <div className="table-section"><div className="table-heading"><h3>측정 지표 비교</h3><span>워밍업 제외 · nearest-rank percentile</span></div><div className="table-scroll"><table><thead><tr><th scope="col">관측 지표</th><th scope="col"><span className="dot v1" /> v1 · 단일 JOIN</th><th scope="col"><span className="dot v2" /> v2 · 분할 조회</th></tr></thead><tbody>
                {[
                  ['반환 행 수 · 마지막 요청', number(summaries.v1.rows), number(summaries.v2.rows)],
                  ['SQL 횟수 · 마지막 요청', number(summaries.v1.queryCount), number(summaries.v2.queryCount)],
                  ['조회·조립 p50', `${ms(summaries.v1.fetchP50)} ms`, `${ms(summaries.v2.fetchP50)} ms`],
                  ['조회·조립 p95', `${ms(summaries.v1.fetchP95)} ms`, `${ms(summaries.v2.fetchP95)} ms`],
                  ['JDBC execute p50', `${ms(summaries.v1.jdbcP50)} ms`, `${ms(summaries.v2.jdbcP50)} ms`],
                  ['DTO 조립 p50', `${ms(summaries.v1.assemblyP50)} ms`, `${ms(summaries.v2.assemblyP50)} ms`],
                  ['브라우저 HTTP p50', `${ms(summaries.v1.httpP50)} ms`, `${ms(summaries.v2.httpP50)} ms`],
                  ['브라우저 HTTP p95', `${ms(summaries.v1.httpP95)} ms`, `${ms(summaries.v2.httpP95)} ms`],
                  ['브라우저 HTTP p99', `${ms(summaries.v1.httpP99)} ms`, `${ms(summaries.v2.httpP99)} ms`],
                ].map(([label, left, right]) => <tr key={label}><th scope="row">{label}</th><td>{left}</td><td>{right}</td></tr>)}
              </tbody></table></div></div>
              <div className="measurement-notes"><span className="note-symbol">i</span><div><p>소수 표본의 p95·p99는 탐색용입니다. 동시 부하나 성능 결론에는 충분한 k6 표본이 필요합니다.</p><p>HTTP는 브라우저의 응답 본문 파싱까지 포함합니다. JDBC execute는 순수 DB 시간이 아니며, 반환 행 수는 스캔 행 수·전송 바이트와 다릅니다.</p></div></div>
            </div>}

            {tab === 'sql' && <div className="detail-content">{current ? <><div className="detail-intro"><Icon name="code" /><div><h3>마지막 요청의 SQL</h3><p>실제 실행된 SELECT와 JDBC 실행 시간입니다. 결과 소비 시간 전체를 뜻하지 않습니다.</p></div></div>{VERSIONS.map((version) => <div className="sql-group" key={version}><div className="sql-group-heading"><span className={`version-pill ${version}`}>{version}</span><h3>{version === 'v1' ? '단일 JOIN' : '분할 조회'}</h3><span>{current.latest[version].metrics.queryCount} SELECT · {nf.format(current.latest[version].metrics.totalRows)} rows</span></div>{current.latest[version].metrics.queries.map((query, index) => <div className="sql-block" key={index}><div><span>QUERY {String(index + 1).padStart(2, '0')}</span><span>{nf.format(query.rows)} rows <i>·</i> {query.elapsedMs.toFixed(3)} ms</span></div>{query.sql ? <pre><code>{query.sql}</code></pre> : <p className="sql-omitted">측정 모드에서는 SQL 텍스트를 생략합니다. 분석 모드로 실행하면 SQL을 확인할 수 있습니다.</p>}</div>)}</div>)}</> : <EmptyDetail text="실험 후 실제 실행된 SQL과 반환 행 수를 확인할 수 있습니다." />}</div>}

            {tab === 'response' && <div className="detail-content">{preview ? <><div className="preview-heading"><div><h3>조회 응답 미리보기</h3><p>마지막 요청 · 게시글 {preview.posts.length}개 · {equalityPass ? '모든 측정 회차의 데이터 일치' : '정합성 결과 확인 필요'}</p></div><div className="preview-toggle">{VERSIONS.map((version) => <button key={version} className={previewVersion === version ? 'active' : ''} onClick={() => setPreviewVersion(version)}>{version}</button>)}</div></div><p className="preview-note">미리보기는 게시글 2개, 자식 각 3개, 본문 160자로 제한합니다. 내보내기에는 양쪽의 마지막 전체 응답을 포함합니다.</p><pre className="response-preview"><code>{JSON.stringify(preview.posts.slice(0, 2).map((post) => ({ ...post, body: post.body.slice(0, 160) + (post.body.length > 160 ? '…' : ''), comments: post.comments.slice(0, 3), attachments: post.attachments.slice(0, 3), _preview: { totalComments: post.comments.length, totalAttachments: post.attachments.length, truncated: true } })), null, 2)}</code></pre></> : <EmptyDetail text="같은 ID를 조회한 두 API의 응답 데이터가 여기에 표시됩니다." />}</div>}
          </section>
          <div className="experiment-principles"><span>동일한 부모 ID</span><i>·</i><span>동일한 DTO</span><i>·</i><span>고정 seed</span><i>·</i><span>교대 순차 실행</span><i>·</i><span>ORM 캐시 비활성화</span></div>
        </section>
      </div>
    </main>
    <footer><span>QUERY LAB <i>/</i> 관측으로 이해하는 조회 전략</span><span>반환 행 수와 왕복 횟수의 균형을 찾는 실험</span></footer>
  </div>;
}

function EmptyDetail({ text }: { text: string }) {
  return <div className="empty-detail"><span className="empty-icon"><Icon name="code" size={30} /></span><h3>아직 실행된 실험이 없습니다.</h3><p>{text}</p></div>;
}
