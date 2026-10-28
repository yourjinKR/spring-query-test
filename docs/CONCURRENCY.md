# 동시 요청과 커넥션 풀 실험

## 핵심 가설

현재 v1과 v2는 모두 읽기 전용 REPEATABLE READ 트랜잭션을 사용한다. v2의 세 SELECT는 순차 실행되며 커넥션을 공유한다. SELECT 3회가 커넥션 획득 3회를 뜻하지 않는다. 비교할 핵심은 **요청당 커넥션 점유 시간**이다. JOIN 중복 데이터 처리 비용과 분할 조회의 추가 왕복 비용이 이 시간에 함께 반영된다. DTO 조립·커밋까지 커넥션이 점유될 수 있다.

`fetchAndAssembleMs`는 Service 메서드 안에서 시작하므로 트랜잭션 진입 시의 커넥션 획득 대기를 놓칠 수 있다. HTTP 지연과 Hikari 지표를 함께 본다. HTTP p95에서 조회 p95를 빼는 계산도 풀 대기가 아니다. 서로 다른 요청의 백분위이며 직렬화·서버 큐 등 다른 비용도 포함하기 때문이다.

| 지표 | 의미 |
|---|---|
| HTTP p50/p95/p99 | 부하 요청의 응답 지연. k6 duration은 연결 수립 등을 모두 포함하는 브라우저 fetch 시간과 다름 |
| 완료·성공 RPS, HTTP 오류율 | 실제 완료 처리량. 성공 RPS는 응답 계약까지 통과한 요청 기준 |
| Hikari acquire 평균·p95 | 커넥션 획득 경과 시간. 순수 queue wait가 아니며 검증·timeout 경로도 포함 |
| Hikari usage 평균·p95 | 빌린 시점부터 반환까지의 커넥션 점유 시간 |
| active / maximum, pending | 연결 사용률과 획득 대기 인원의 관측 표본 |
| timeout 증가량 | 연결 획득 제한 시간을 넘긴 횟수 |
| dropped / incomplete | 생성하지 못한 반복과 종료 전 완료되지 않은 요청 |
| DB·서버·발생기 CPU, JVM GC | 풀·DB·CPU·부하 발생기 병목을 구분하는 보조 자료 |

Hikari 풀 지표에는 API 경로 태그가 없으므로 한 실행에는 한 전략만 부하를 준다. 수집기는 워밍업 뒤 누적 지표의 기준값을 잡고, 마지막 pool snapshot 뒤에 데이터 현황을 조회한다. 측정 중에는 화면 비교·새로고침·데이터 생성 요청을 실행하지 않는다.

`pending`은 순간 gauge다. Prometheus의 5초 scrape와 수집기의 500ms polling 모두 짧은 대기를 놓칠 수 있고 Hikari gauge 자체의 갱신 간격도 있다. 관측된 pending 최대가 0이어도 대기가 없었다고 단정하지 않는다. 누적 acquire histogram·timeout을 함께 본다. histogram p95는 bucket 보간 추정값이며 원시 bucket도 결과에 보존한다.

Compose 서버 healthcheck는 DB 연결을 빌리는 `/actuator/health` 대신 `/actuator/health/liveness`를 사용해 관측 혼입을 줄인다. liveness가 DB 정상 상태를 보장하지는 않으며 실제 조회 워밍업 실패 시 부하를 시작하지 않는다.

## 실험 순서

먼저 같은 데이터·ID·본문 크기에서 **풀 2/10 × VU 1/10/50**의 여섯 조건을 비교한다. 이후 자식 수 1×1, 20×5, 100×20과 본문 크기를 한 변수씩 바꾼다. 데이터 변경은 기존 화면/API에서 명시적으로 수행한다. 풀 스크립트는 데이터를 교체하지 않는다. 기본 구성에는 인위적인 RTT 지연이 없어 네트워크 지연 통제는 후속 실험이다.

안정 상태에서 요청당 연결 획득이 한 번이고 평균 점유 시간이 S초라면 풀 상한 P의 거친 작업량 기준 상한은 `P / S`다. 연결 10개·평균 50ms라면 약 200 req/s다. CPU·DB·분산을 무시한 설명용 근사이며 실제 용량은 부하로 확인한다. 풀을 늘려 DB 경쟁과 점유 시간이 함께 늘어날 수도 있으므로 풀 대기 감소와 전체 성능 개선을 같은 말로 취급하지 않는다.

- `closed`: 고정 VU. 앞 요청이 끝나야 다음 요청이 시작된다. 느려지면 도착률도 줄어들므로 같은 VU가 같은 RPS는 아니다.
- `arrival`: 초당 목표 도착률을 정한다. 같은 목표 RPS에서 지연·오류를 비교한다. `dropped_iterations`는 서버 거부가 아니라 생성하지 못한 반복이며 서버 지연과 발생기의 VU·CPU 용량을 함께 점검한다.

워밍업은 제외한다. 완료 처리량의 구간은 시나리오 시작부터 마지막 HTTP 응답 완료까지이며 마지막 진행 중 요청의 종료 대기도 포함한다. steady-state만의 RPS와 구분한다. k6 원시 Counter rate에는 setup·종료 시간이 반영될 수 있어 완료 수와 측정 경과 시간을 별도로 저장한다.

## 실행

Node.js 22 이상과 Docker Compose를 사용하며 추가 npm 패키지는 없다. 먼저 `docker compose up --build -d`로 준비한다.

```powershell
# 한 조건에서 전략별 실행
node benchmarks/pool-run.mjs --strategy v1 --model closed --vus 20 --duration 30s --warmup 100 --output benchmarks/results/pool-v1.json
node benchmarks/pool-run.mjs --strategy v2 --model closed --vus 20 --duration 30s --warmup 100 --output benchmarks/results/pool-v2.json

# 풀×동시성 교차 실행, 전략 순서 교대, 종료 시 설정 복원
.\benchmarks\pool-matrix.ps1 -Pools 2,10 -Vus 1,10,50 -Duration 30s -Warmup 100 -Repeats 3

# 같은 목표 도착률로 별도 실행
node benchmarks/pool-run.mjs --strategy v1 --model arrival --rate 100 --preallocated-vus 20 --max-vus 100 --duration 30s --warmup 100 --output benchmarks/results/arrival-v1.json
node benchmarks/pool-run.mjs --strategy v2 --model arrival --rate 100 --preallocated-vus 20 --max-vus 100 --duration 30s --warmup 100 --output benchmarks/results/arrival-v2.json
```

기본 ID는 1~10이며 `--ids 1,2,3`으로 바꾼다. `--base-url`은 호스트 측 서버(기본 `http://127.0.0.1:8080`), `--docker-base-url`은 k6 측의 **같은 서버**(기본 `http://server:8080`)다. 포트를 바꾸었다면 호스트 주소도 맞춘다.

matrix는 서버를 풀별로 다시 생성한다. 기본은 minimumIdle=maximumPoolSize인 고정 풀, 획득 timeout 1,000ms·검증 timeout 500ms다. 요청한 풀 크기와 실제 exporter의 상한이 다르거나 데이터 설정이 기준값과 달라지면 중단한다. 시작 시 실행 중인 서버의 풀 관련 환경변수 네 개만 보관해 종료 시 복원하고, 호출 프로세스의 환경변수도 복원한다. 조건별 JSON과 manifest를 남기며 실행 중에는 실험 환경을 다른 작업과 공유하지 않는다.

`DB_POOL_SIZE`, `DB_POOL_MIN_IDLE`, `DB_CONNECTION_TIMEOUT_MS`, `DB_VALIDATION_TIMEOUT_MS`로 설정한다. 기본 앱은 10개 고정 풀·획득 timeout 30초다. 검증 timeout은 획득 timeout보다 짧게 두고 PostgreSQL max_connections=50에 필요한 여유도 고려한다.

## 결과 품질 확인

JSON에는 데이터 설정 전후, 실제 풀 상한, 원시 baseline/final, gauge 표본, acquire/usage 차이, k6 결과가 있다. measurement_invalid, counter reset, 누락 지표, 수집 실패, 데이터 변경, dropped/incomplete를 먼저 확인한다. 임계값에 실패한 실행도 결과 파일을 남긴다.

acquire 증가량과 완료 요청 수의 차이는 다른 DB 사용이나 진행 중 요청을 찾아보는 진단값이다. 모든 외부 작업을 자동 차단하지는 않는다. 짧은 10초·1회 실행은 동작 검증과 포화 징후 탐색용이며 성능 결론에는 충분한 워밍업·시간·반복이 필요하다.

CPU·GC·HTTP 지표는 `infra/prometheus/queries.promql`, DB 작업은 `benchmarks/statements.sql`로 보완한다. `docker stats`로 서버·DB·k6를 함께 관찰하고 발생기도 같은 머신 자원을 쓴다는 점을 기록한다.

참고: [Hikari 설정](https://github.com/brettwooldridge/HikariCP), [Hikari 계측 구현](https://raw.githubusercontent.com/brettwooldridge/HikariCP/dev/src/main/java/com/zaxxer/hikari/metrics/micrometer/MicrometerMetricsTracker.java), [k6 부하 모델](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/), [Micrometer histogram](https://docs.micrometer.io/micrometer/reference/concepts/histogram-quantiles.html).
