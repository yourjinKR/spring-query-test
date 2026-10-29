# 구현 검증 기록

검증일: 2026-10-26 (Asia/Seoul)

## 자동화 검증

| 항목 | 결과 |
|---|---|
| Java 21 / Spring Boot 4.1.2 / QueryDSL 7.7 패키징 | 성공 |
| Maven Wrapper 3.9.11 실행 | 성공 |
| 서버 단위 테스트 | 3개 통과 |
| 실제 PostgreSQL 18.6 Testcontainers 통합 테스트 | 8개 통과, 생략 0개 |
| 클라이언트 TypeScript / Vite 프로덕션 빌드 | 성공 |
| 클라이언트 ID 파싱·백분위·동등성·실행 순서 테스트 | 4개 통과 |
| Node 반복 비교 스크립트 테스트 | 4개 통과 |
| 최종 클라이언트 npm audit | 취약점 0개 |
| 서버·클라이언트 Docker 다단계 빌드 | 성공 |
| Compose 전체 프로파일 설정 검증 | 성공 |

통합 테스트는 실제 반환 행 수, SELECT 1/3회, DTO 내용·정렬, 빈 자식과 없는 부모, 고정 seed와 편향 데이터의 재현성, 계측의 요청 간 분리, 잘못된 생성 요청 이후 데이터 보존을 확인한다. 추가로 200만 행이 되는 JOIN은 실행 전에 거절하고, 같은 데이터를 v2에서 SELECT 3회·3,001행으로 조회하는 크기 제한 동작을 확인했다.

## 실제 연결 검증

- DB·서버·nginx 클라이언트를 Docker Compose로 실행했다. 서버와 DB health check 통과, 화면 HTTP 200 및 nginx의 API 프록시 동작을 확인했다.
- 기본 데이터는 게시글 200개, 댓글 4,000개, 첨부파일 1,000개, 본문 1,024바이트, seed 42다.
- 부모 ID 1,2,3 조회: v1은 1 SELECT·300행, v2는 3 SELECT·78행이며 DTO가 일치했다.
- 브라우저에서 부모 ID 1~50을 워밍업 2회 후 8회 비교했다. 매 회차 DTO가 일치했고 마지막 요청의 v1은 5,000행, v2는 1,300행이었다.
- analysis 모드에서 실제 SQL 1/3개가 표시되고, benchmark 모드에서 SQL 본문이 생략되는 것을 확인했다.
- 잘못된 ID 및 모드는 HTTP 400, 없는 API 경로는 HTTP 404를 반환했다.
- Actuator Prometheus 출력에서 HTTP, JVM, JDBC pool, Hikari 지표를 확인했다.
- 선택적 Prometheus 컨테이너도 실행하여 `/api/v1/targets`의 query-lab 대상이 `health=up`이고 수집 오류가 없는 것을 확인했다.
- EXPLAIN 4개를 실제 실행했다. 부모 3개 기준 최상위 반환 행은 단일 JOIN 300행, 분할 쿼리 각각 3/60/15행이었다. pg_stat_statements 조회도 성공했다.
- k6로 전략별 2 VU·5초·워밍업 2회 연동 검증을 실행했다. HTTP 오류 및 응답 계약 검사 실패가 없었으며 요청별 SQL 횟수도 유지됐다.

브라우저 이미지와 원시 연동 검증 로그는 로컬 `artifacts/`, `benchmarks/results/`에 두며 Git 대상에서 제외했다. 측정 시간은 머신·캐시·동시 실행 작업에 따라 달라진다. 위 짧은 실행은 연동 검증이고, 전략의 일반적인 성능 우열을 입증하는 벤치마크가 아니다.

이 작업 환경에서는 Windows의 5432 바인딩 제한으로 로컬 `.env`에 `DB_PORT=55432`를 사용했고, 기존 Prometheus의 9090 점유로 `PROMETHEUS_PORT=9091`을 사용했다. 배포용 예시 설정은 `.env.example`에서 조절할 수 있다.

## 백엔드 계층 분리 후 검증

백엔드를 Controller–Service–Repository와 개별 Lombok DTO로 변경한 후 `clean verify`를 실행했다. 서버 테스트는 단위 3개·실제 PostgreSQL 통합 8개, 총 11개 통과했고 실패·오류·생략은 모두 0개였다. 클라이언트와 벤치마크 도구는 이 리팩터링에서 변경하지 않았다.

- 깨끗한 빌드에서 Lombok 1.18.48과 QueryDSL annotation processor를 함께 실행하고 Q 클래스 3개 생성을 확인했다.
- 병렬 서비스 호출 16개에서 전략별 SQL 횟수·행 수·SQL 공개 설정이 요청 간 섞이지 않는 것을 검증했다.
- 외부 트랜잭션에서 Service가 반환된 뒤에도 커밋까지 데이터 교체 잠금을 유지하고, 메타데이터가 커밋 후에만 바뀌는 것을 검증했다. 읽기 측에는 SQL을 사용하지 않아 DB 자체 잠금에 의존하는 검사가 되지 않게 했다.
- 실행 JAR에서 Lombok 런타임과 삭제된 옛 Controller·Coordinator·중첩 DTO가 남지 않는 것을 확인했다.
- 백엔드 Docker 이미지만 다시 빌드·실행한 뒤 `/v1/posts`, `/v2/posts`의 JSON·DTO 정합성과 SELECT 1/3회, 부모 3개 기준 300/78행을 확인했다.
- nginx 클라이언트의 API 프록시, benchmark 모드의 SQL 생략, JSON 생성 요청의 Bean Validation HTTP 400을 확인했다.
- 실제 DB의 데이터 현황과 seed 설정을 변경 전후 비교해 기존 실험 데이터가 보존된 것을 확인했다. 재생성의 정상 동작 검증은 Testcontainers의 별도 DB에서 수행했다.
- Node 반복 비교 스크립트도 같은 API에 연결해 DTO 동등성과 응답 계약을 확인했다.

역할별 파일과 Lombok 적용 기준은 [백엔드 안내](../server/README.md)에 정리했다.

## 동시성·풀 관측 보완 검증 (2026-10-28)

업무 Java 코드는 변경하지 않고 설정·부하 도구·지표 수집을 보완했다. k6 closed/arrival 설정과 측정 요약, Prometheus label·누적 bucket 차이·counter reset·누락 지표·수집 실패·데이터 변경·실패 결과 보존·실행 컨테이너 정리에 관한 Node 테스트 15개가 통과했다. 실제 k6 1.2.0에서 두 executor의 파싱과 동작도 확인했다.

- Hikari acquire/usage histogram을 실제 exporter에서 확인했다. acquire는 마이크로초 구간도 기록하며 percentile 값은 histogram 추정이다.
- 기존 기본 데이터와 ID 1~10, 풀 2/10, VU 1/20, 전략 v1/v2의 8조건을 각각 10초씩 실행했다. 전략별 워밍업 100회는 집계에서 제외했다.
- 8개 결과 모두 completed, 관측 경고·counter reset·HTTP 오류·계약 검사 실패·획득 timeout이 없었고, acquire 증가량은 완료 요청 수와 일치했다. 데이터도 유지됐다.
- 풀 2·v1에서 VU 1→20일 때 acquire 평균은 약 0.004ms→24.58ms, 관측된 최대 pending은 0→18이었다. v2도 VU 20에서 평균 획득 15.02ms와 pending 18을 관측했다.
- 풀 10·VU 20에서는 v1 acquire 평균이 5.00ms로 줄었지만 usage 평균은 2.31ms→11.01ms로 늘었다. v2도 풀 증가 시 점유 시간이 늘었다. CPU·DB·GC 추가 진단 없이 원인을 단정하거나 풀 증가가 전체 지연을 개선한다고 해석하지 않는다.
- 이 실행은 1회·10초인 탐색용 검증이다. 절대 성능·전략 우열의 일반화에는 충분한 시간과 반복이 필요하다.
- 별도 arrival 100 req/s·3초 실행은 301건 완료, dropped 0, 획득 증가량 301건으로 검증했다.
- 의도적으로 VU를 1로 제한한 arrival 500 req/s·2초 실행에서는 dropped 748건을 기록하고 load_failed로 저장했다. HTTP 오류는 0이었으므로 생성하지 못한 요청과 서버 오류가 구분되는 것을 확인했다.
- matrix 종료 후 원래 Compose 풀 설정을 복원했다. 원시 JSON·summary.csv·manifest는 로컬 `benchmarks/results/pool-matrix-verification/`에 저장했다.

## DB 왕복 지연 실험 검증 (2026-10-29)

조회 애플리케이션 코드는 유지하고 별도 Toxiproxy Compose overlay, Java 제어·교정 도구, 반복 실행기와 분석기를 추가했다. 설계와 실측값은 [지연 실험 안내](LATENCY_STUDY.md)와 [측정 기록](measurements/latency-2026-10-29-analysis.md)에 정리했다.

- 벤치마크 Node 테스트 44개가 통과했다. 정상 쌍의 집계, 실패 보존, 잘못된 RTT·프록시 설정, 단계·부하 조건 혼입, 측정 시간 공백과 정상 종료 대기의 구분을 포함한다.
- Java 제어 도구 Docker 빌드에서 테스트 5개가 통과했다. 실제 PostgreSQL/Toxiproxy 연결에서도 지연 제어와 재사용 JDBC 연결의 교정을 확인했다.
- 전체 Compose 프로파일의 설정 검사와 PowerShell 구문 검사가 통과했다.
- 주요 캠페인 측정 126회는 전부 계측 유효였다. 정상 122회·부하 실패 4회이며, 측정 요청 844,085건 중 성공 844,081건, 획득 timeout 4건, dropped·미완료는 0건이다. 워밍업 42회는 제외했다.
- 별도로 중단한 1코어 프록시 부하 시도의 4개 실행은 진단 기록으로 보존했다. 주요 결과와 합치지 않았다.
- 종료 후 DB 직접 연결, 풀 상한·minimumIdle 10개, 획득 timeout 30,000ms·검증 timeout 500ms를 확인했다. 기존 데이터와 nginx의 API 연결도 유지됐다.
- 임시 Windows 절전 방지 요청이 같은 스레드에서 해제됐고 시작·종료 시 AC 연결 상태를 확인했다. 자원 관측 프로세스와 이번 실험의 프록시 컨테이너는 종료했다.
- Matplotlib PNG/SVG를 생성하고 PNG의 축·범례·관측 범위·정상 쌍 수·단계별 프록시 CPU 상한 표시를 직접 확인했다.
