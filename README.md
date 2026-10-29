# Query Laba

Application에서 PostgreSQL로 조회할 때 **단일 JOIN의 왕복 절감**과 **분할 조회의 결과 행 절감**을 비교하는 실습 프로젝트입니다.

- `/v1/posts`: 게시글·댓글·첨부파일을 한 번에 LEFT JOIN합니다. SELECT **1회**.
- `/v2/posts`: 게시글, 댓글, 첨부파일을 순서대로 벌크 조회하고 DTO를 조립합니다. SELECT **3회**.
- 같은 ID 집합에는 같은 게시글 DTO를 반환합니다. 없는 ID는 생략하고 빈 자식 컬렉션은 유지합니다.
- 인증/인가는 없으며 Docker의 공개 포트는 로컬 주소에 바인딩합니다.

## 실행

Docker Desktop 또는 Docker Engine + Compose가 필요합니다. 레포지토리 루트에서 실행합니다.

```powershell
docker compose up --build -d
```

- 비교 화면: <http://localhost:5173>
- 서버 상태: <http://localhost:8080/actuator/health>
- 데이터 현황: <http://localhost:8080/lab/dataset>

최초 시작 시 비어 있는 DB에 게시글 200개, 게시글당 댓글 20개·첨부파일 5개, 본문 1,024바이트, seed 42인 데이터를 생성합니다. 화면에서 시나리오를 선택하고 **데이터 생성** 후 **비교 실행**을 누릅니다. 데이터 생성은 이 실습의 기존 데이터를 교체합니다. PostgreSQL 볼륨은 컨테이너 종료 후에도 유지됩니다.

포트나 자원 제한은 `.env.example`을 `.env`로 복사해 바꿀 수 있습니다. Windows에서 5432가 예약되거나 이미 사용 중이면 `DB_PORT=55432`로 바꿉니다. 컨테이너 사이의 DB 연결은 내부 포트 5432를 계속 사용합니다.

```powershell
Copy-Item .env.example .env
docker compose logs -f server
docker compose down
```

`down`은 데이터를 삭제하지 않습니다. Java와 Node를 호스트에 설치하지 않아도 Docker로 전체 앱을 실행할 수 있습니다.

## 기술 구성

| 영역 | 구성 |
|---|---|
| 서버 | Java 21, Spring Boot 4.1.2, Spring Data JPA, OpenFeign QueryDSL 7.7, Lombok |
| DB | PostgreSQL 18.6, Flyway, pg_stat_statements |
| 관측 | datasource-proxy, Actuator, Micrometer, 선택적 Prometheus |
| 클라이언트 | React 19, TypeScript, Vite 7 |
| 부하·반복 실행 | k6, Node.js 비교 스크립트 |
| 실행 | Docker Compose, Maven Wrapper 3.9.11 |

```text
server/       API, DTO 조회 전략, 데이터 생성, 계측, DB 마이그레이션, 테스트
client/       React 비교 화면
infra/        PostgreSQL 초기화와 Prometheus 설정
benchmarks/   반복 비교, k6, EXPLAIN·통계 SQL
docs/         실험 설계와 측정값 해석
```

JPA 엔티티는 스키마와 관계를 정의하고, 비교 조회는 양쪽 모두 scalar projection을 사용합니다. OSIV, ORM 2차 캐시와 쿼리 캐시는 끕니다. 같은 요청의 세 SELECT는 읽기 전용 REPEATABLE READ 트랜잭션 안에서 실행합니다. 데이터 생성과 조회는 단일 서버 프로세스의 읽기/쓰기 잠금으로 겹치지 않게 합니다.

백엔드는 `PostController → PostService → PostQueryRepository` 구조입니다. Service는 조회 순서와 트랜잭션, Repository는 QueryDSL, 별도 assembler는 DTO 조립을 담당합니다. Lombok 적용 기준과 패키지별 역할은 [백엔드 코드 안내](server/README.md)에 정리했습니다.

## API

```http
GET /v1/posts?ids=1,2,3&mode=analysis
GET /v2/posts?ids=1,2,3&mode=analysis
GET /lab/dataset
POST /lab/dataset
```

`ids`를 생략하면 1~50을 조회합니다. 쉼표로 구분한 양의 정수를 최대 100개 입력하며, 중복은 제거하고 정렬합니다. React 화면에서는 `1-50` 범위 표현도 입력할 수 있습니다.

`mode=analysis`는 실행 SQL을 함께 반환하고 `mode=benchmark`는 SQL 본문을 생략합니다. 두 모드 모두 가벼운 요청별 계측을 유지합니다.

```json
{
  "strategy": "SINGLE_JOIN",
  "posts": [],
  "metrics": {
    "queryCount": 1,
    "totalRows": 0,
    "fetchAndAssembleMs": 0.0,
    "jdbcExecuteMs": 0.0,
    "assemblyMs": 0.0,
    "queries": [{ "sql": "select ...", "elapsedMs": 0.0, "rows": 0 }]
  }
}
```

위 응답은 형식을 설명하는 예시입니다. 실행 결과는 실제 DB에서 수집합니다. 정합성 비교 대상은 `posts`이며, 두 전략의 `strategy`와 `metrics`는 다릅니다. 반환 필드는 [API 계약](API_CONTRACT.md)에 정리했습니다.

데이터를 교체하려면 다음 JSON을 `POST /lab/dataset`으로 보냅니다.

```json
{
  "postCount": 200,
  "commentsPerPost": 20,
  "attachmentsPerPost": 5,
  "bodyBytes": 1024,
  "seed": 42,
  "distribution": "UNIFORM"
}
```

| 설정 | 범위·의미 |
|---|---|
| postCount | 1~10,000 |
| commentsPerPost | 0~200 |
| attachmentsPerPost | 0~100 |
| bodyBytes | 0~16,384, 정확히 해당 바이트 수의 ASCII 본문 |
| seed | 재현 가능한 본문과 첨부파일 크기 생성에 사용 |
| UNIFORM | 모든 게시글에 설정한 자식 수를 생성 |
| SKEWED | ID가 10의 배수인 게시글에 자식을 각각 설정값의 10배 생성, 나머지는 0개 |

전체 자식은 최대 200만 행, 전체 게시글 본문은 최대 128 MiB입니다. SKEWED에서 게시글 수가 10의 배수가 아니면 전체 평균이 설정값보다 작아질 수 있습니다. 자식 ID는 동일 설정의 재생성 시 동일하게 생성합니다.

조회는 시드 설정으로 예상한 결과가 25만 행 또는 보수적으로 추정한 192 MiB를 초과하면 HTTP 400으로 거절합니다. ID 수, 본문 크기 또는 자식 수를 줄여 실행합니다. 이 값은 실제 전송 바이트 계측이 아닙니다. 외부 SQL로 데이터를 수정하면 생성 설정과 실제 데이터가 달라질 수 있으므로 화면/API로만 데이터를 생성하는 실험을 전제로 합니다.

## 관측과 비교

화면에서 워밍업을 제외한 반복 측정을 실행하고 다음을 확인할 수 있습니다.

- 두 API의 DTO 정합성 및 SELECT 횟수
- 실제로 가져온 평탄한 결과 행 수와 행 감소율
- 서버 조회·DTO 조립 시간 및 JDBC 실행 호출 시간
- 브라우저 HTTP 시간의 p50/p95와 회차별 비교
- 실행 SQL, 일부 응답 미리 보기, 원시 표본과 데이터 설정의 JSON 내보내기

게시글 50개에 댓글 20개·첨부파일 5개라면 v1은 5,000행, v2는 1,300행을 가져옵니다. 이는 전체 스캔 행 수나 실제 네트워크 바이트가 아닙니다. JDBC 실행 시간도 순수 DB 시간과 다릅니다. [실험 설계와 결과 해석](docs/EXPERIMENTS.md)을 먼저 읽고 수치를 해석하세요.

Node.js 22 이상이 있으면 패키지 설치 없이 반복 비교할 수 있습니다.

```powershell
node benchmarks/compare.mjs --ids 1,2,3,4,5,6,7,8,9,10 --warmup 10 --repeats 30
```

동시 부하는 두 전략을 따로 실행합니다.

풀 크기와 동시 요청 수를 교차하고 Hikari 획득·점유 시간까지 함께 수집하려면 [동시 요청·커넥션 풀 실험](docs/CONCURRENCY.md)을 참고하세요. `benchmarks/pool-run.mjs`는 한 조건의 결과를, `benchmarks/pool-matrix.ps1`는 풀·VU별 결과를 저장합니다. 같은 목표 RPS 비교를 위한 고정 도착률 모드도 지원합니다.

[30초·5쌍 반복 측정 결과](docs/REPEATED_STUDY.md)에는 풀 2/10개, 동시 요청 1/20개 및 150 req/s의 총 60회 결과와 실패 내역을 정리했습니다. `benchmarks/repeat-study.ps1`로 재현하고 `benchmarks/analyze-study.mjs`로 같은 반복 쌍을 분석할 수 있습니다.

[DB 왕복 지연 실험](docs/LATENCY_STUDY.md)은 Toxiproxy와 별도 Java 제어 도구로 추가 RTT를 바꾸며 조회 전략의 역전 구간과 연결 점유·풀 대기 변화를 비교합니다.

```powershell
docker compose run --rm -e STRATEGY=v1 -e VUS=5 -e DURATION=30s k6
docker compose run --rm -e STRATEGY=v2 -e VUS=5 -e DURATION=30s k6
```

선택적으로 Prometheus를 켤 수 있습니다. 호스트 9090이 이미 사용 중이면 `.env`에서 `PROMETHEUS_PORT=9091`로 바꿉니다.

```powershell
docker compose --profile monitoring up -d prometheus
```

부하 지표의 범위, 워밍업 처리, 실행 계획과 누적 통계 SQL은 [벤치마크 안내](benchmarks/README.md)를 참고하세요. 브라우저의 소수 반복 표본은 탐색용이며 안정적인 부하 성능 결론을 대신하지 않습니다.

## 로컬 개발과 테스트

Java 21과 Node.js 22.12 이상을 사용합니다. Maven은 Wrapper로 설치됩니다.

```powershell
docker compose up -d db
cd server
.\mvnw.cmd test
.\mvnw.cmd spring-boot:run
```

`DB_PORT=55432`를 사용했다면 서버 실행 터미널에서 `$env:DB_URL='jdbc:postgresql://localhost:55432/querylab'`을 설정합니다. JAVA_HOME은 Java 21 JDK를 가리켜야 합니다. macOS/Linux에서는 `./mvnw test`, `./mvnw spring-boot:run`을 사용합니다.

별도 터미널에서 클라이언트를 시작합니다. Vite는 `/v1`, `/v2`, `/lab`, `/actuator`를 서버 8080으로 프록시합니다.

```powershell
cd client
npm ci
npm test
npm run build
npm run dev
```

```powershell
# 레포지토리 루트
node --test benchmarks/compare.test.mjs
docker compose --profile monitoring --profile tools config --quiet
```

서버 테스트는 실제 PostgreSQL을 Testcontainers로 실행하여 DTO 동등성, SELECT 1/3회, 실제 반환 행 수, 빈 자식, 누락된 부모, 편향 데이터의 재현성, 요청별 계측과 잘못된 데이터 생성 요청을 검증합니다. Docker가 없으면 PostgreSQL 통합 테스트는 건너뛰므로 테스트 결과의 skipped 수를 확인하세요. Docker 이미지 빌드는 테스트를 생략하므로 변경 검증 시 위 테스트를 별도로 실행합니다.

현재 기본 실험에는 부모 ID 페이지 조회, 인위적인 네트워크 지연, 동시 쓰기가 포함되지 않습니다. 후속 실험 시 공통 ID 조회와 count 쿼리까지 전체 요청 비용에 포함하는 방법은 [실험 문서](docs/EXPERIMENTS.md)에 설명했습니다.

실제 실행과 테스트 결과는 [구현 검증 기록](docs/VERIFICATION.md)에 정리했습니다.
