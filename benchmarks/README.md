# 재현 가능한 비교와 부하 측정

먼저 같은 데이터와 ID를 사용하는지 확인합니다. 비교 중 재생성 버튼을 누르거나 다른 부하·EXPLAIN을 실행하지 않습니다. `/v1/posts`는 1회 JOIN, `/v2/posts`는 순차 3회 SELECT입니다. 두 방식 모두 `mode=benchmark`에서도 가벼운 요청별 계측을 수행하므로, 결과는 이 계측이 포함된 비용입니다.

## 단일 요청 반복 비교 (Node 22+, 별도 패키지 불필요)

레포지토리 루트에서 실행합니다.

```powershell
node benchmarks/compare.mjs --ids 1,2,3,4,5,6,7,8,9,10 --warmup 10 --repeats 30
node --test benchmarks/compare.test.mjs
```

옵션: `--base-url http://localhost:8080`, `--mode benchmark`, `--output benchmarks/results/custom.json`. `/lab/dataset` 메타데이터, ID, 실행 시각, Node 버전, 전략별 원시 측정값과 요약을 JSON으로 저장합니다. DTO의 SHA-256을 모든 반복에서 비교하며 불일치·메타데이터 변경·HTTP 오류에는 실패 상태와 비정상 종료 코드를 남깁니다. SQL이 필요하면 `--mode analysis`를 사용합니다.

워밍업은 집계에서 제외하고 측정 순서는 매 회차 v1→v2, v2→v1로 교대합니다. HTTP 시간은 응답 본문 다운로드까지 포함하고 JSON 파싱은 제외합니다. 요청당 제한 시간은 120초, 응답 본문은 32 MiB까지 허용합니다. 초과하면 ID 수나 데이터를 줄여 다시 실행합니다. p50/p95는 nearest-rank 방식의 표본 백분위입니다. 30회 반복은 탐색용이며 동시 요청 처리량이나 안정적인 꼬리 지연 추정이 아닙니다.

## 동시 부하 (k6)

Docker Compose의 서버가 준비된 뒤 한 전략씩 실행합니다. 측정 전 데이터셋을 고정합니다.

```powershell
docker compose run --rm -e STRATEGY=v1 -e VUS=5 -e DURATION=30s -e WARMUP=20 k6
docker compose run --rm -e STRATEGY=v2 -e VUS=5 -e DURATION=30s -e WARMUP=20 k6
```

로컬 k6가 있으면 `k6 run -e STRATEGY=v1 -e BASE_URL=http://localhost:8080 benchmarks/load.js`도 가능합니다. `IDS`로 같은 부모 목록을 지정하고 `VUS`를 1→5→20 등으로 늘립니다. 전략 순서를 바꿔 여러 회차 반복합니다. 생성기와 서버가 같은 머신의 CPU를 공유하므로 자원 설정도 함께 기록해야 합니다.

`setup()`에서 워밍업 후 측정 시나리오를 시작합니다. **`measured_http_ms`와 `phase:measure` 하위 지표**를 사용합니다. 전체 기본 `http_req_duration`에는 setup의 워밍업 호출도 들어갑니다. JSON 요약에는 실행 옵션, 처리량·오류율·백분위와 서버 구간 계측이 포함됩니다. `SUMMARY_PATH`를 지정하면 컨테이너 안의 쓰기 가능한 경로 또는 로컬 파일로 저장합니다. JSON 본문 다운로드 후 검증하는 작업은 반복 시간과 처리량에 영향을 줍니다. HTTP duration 지표에는 그 검증 시간이 포함되지 않습니다.

이는 고정 VU의 closed-loop 부하입니다. 서버가 느려지면 요청 도착률도 줄어들므로, 일정 도착률 실험과 같은 의미로 해석하지 않습니다. 부하 중 DTO 전체 동등성 비교는 하지 않으며 먼저 위 Node 비교로 검증합니다. HTTP 200, 요청별 SQL 횟수, 결과 형식, SQL 텍스트 제외를 부하 중 확인합니다.

## DB 실행 계획과 누적 통계

```powershell
Get-Content benchmarks/explain.sql | docker compose exec -T db psql -U querylab -d querylab -v ids=1,2,3
Get-Content benchmarks/statements.sql | docker compose exec -T db psql -U querylab -d querylab
```

`explain.sql`은 같은 ID에 대해 단일 JOIN과 세 분할 SQL을 실제로 실행합니다. JSON 계획에서 최상위 반환 행 수, 중간 조인 행 수, 예상 오차, 버퍼 접근과 임시 파일을 확인합니다. 노드마다 합산하면 중복 계산됩니다. 예제 SQL의 조건 표현은 `ANY`이므로, 애플리케이션의 `IN` 및 바인딩과 실행 계획이 달라질 수 있습니다. 정확한 앱 계획을 보려면 analysis 응답 SQL에 같은 파라미터를 대입해 실행합니다.

`EXPLAIN ANALYZE`는 결과를 일반 클라이언트로 전송하지 않고 자체 계측 비용이 있으므로 HTTP 시간이나 JDBC 시간과 직접 같다고 보지 않습니다. `pg_stat_statements`는 여러 요청의 누적 통계입니다. 다른 작업 없이 전략별 실행 전후 스냅샷을 저장한 뒤 `queryid`별 차이를 구합니다. `rows`는 반환·영향 행 수이며 전체 스캔 행 수가 아닙니다. 스크립트는 전역 통계를 초기화하지 않습니다.

## 선택적 Prometheus

```powershell
docker compose --profile monitoring up -d prometheus
```

`http://localhost:9090`에서 `infra/prometheus/queries.promql`의 쿼리로 HTTP p95, JVM heap·GC, Hikari 연결·대기를 확인합니다. 서버가 HTTP histogram을 노출하는지 확인해야 하며 관측 구간에 요청이 없으면 rate/백분위가 비어 있을 수 있습니다. 모니터링 유무와 scrape 주기도 비교 회차마다 동일하게 유지합니다.
