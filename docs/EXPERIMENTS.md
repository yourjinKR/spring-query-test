# 실험 설계와 결과 해석

동시 요청의 처리량·커넥션 풀 획득·점유 시간은 [동시 요청·풀 실험](CONCURRENCY.md)에서 별도로 다룹니다. Service 내부의 조회 타이머가 트랜잭션 진입의 커넥션 획득 대기를 포함한다고 가정하지 않습니다.

## 비교 대상

같은 게시글 ID 집합의 `Post + Comment[] + Attachment[]`를 조회한다. 게시글과 두 자식 컬렉션은 모두 ID 오름차순으로 정렬한다. 없는 ID는 생략하고 자식 없는 게시글은 빈 배열로 반환한다.

- `GET /v1/posts`: 두 자식을 LEFT JOIN한 평탄한 결과를 조회하고, 자식 ID로 중복을 제거해 DTO를 만든다. SELECT 1회.
- `GET /v2/posts`: 게시글, 댓글, 첨부파일을 각각 벌크 조회하고 부모 ID로 연결한다. SELECT 3회. 쿼리는 순차 실행하며 부모마다 추가 조회하지 않는다.

두 방식 모두 QueryDSL JPA의 scalar projection을 사용한다. 엔티티 fetch join, LAZY 초기화, 엔티티 변경 감지 비용을 함께 비교하지 않는다. API 응답의 `posts`만 정합성 비교 대상이며 `strategy`와 `metrics`는 달라도 정상이다.

## 반환 행 수

게시글 i의 댓글 수를 cᵢ, 첨부파일 수를 aᵢ라고 할 때:

- v1: Σ max(1, cᵢ) × max(1, aᵢ)
- v2: 게시글 수 + Σ cᵢ + Σ aᵢ

UNIFORM 분포에서 존재하는 게시글 50개를 조회하면 다음과 같다.

| 댓글 / 첨부파일 | v1 행 | v2 행 |
|---|---:|---:|
| 0 / 0 | 50 | 50 |
| 1 / 1 | 50 | 150 |
| 20 / 5 | 5,000 | 1,300 |
| 100 / 20 | 100,000 | 6,050 |

이는 결과 행 수이며 테이블 스캔 행 수가 아니다. 자식이 없는 경우에도 세 개의 SELECT는 실행되지만 빈 자식 조회의 결과 행은 0이다. SKEWED 분포에서는 부모별 실제 자식 수를 사용해야 한다. 전체 평균 자식 수 두 개를 곱하면 실제 JOIN 행 수와 다를 수 있다.

자식 수가 작고 왕복 지연이 큰 환경에서는 단일 조회가 빠를 수도 있다. 결과 행이 늘어나면 DB 연산, DB→서버 전송, JDBC 변환, 애플리케이션의 중복 제거와 객체 할당 비용이 커질 수 있다. 성능 우열은 측정으로 판단한다.

## 측정값의 범위

| 값 | 의미 | 포함하지 않는 것 / 주의점 |
|---|---|---|
| HTTP 시간 | 클라이언트 요청 시작부터 응답 본문 소비까지 | 브라우저, 네트워크, JSON 등도 포함하므로 DB 시간으로 부르지 않음 |
| fetchAndAssembleMs | 서버 조회와 DTO 조립 구간의 경과 시간 | HTTP 직렬화 및 클라이언트까지의 전송 시간 제외 |
| jdbcExecuteMs | datasource-proxy가 관찰한 SELECT 실행 호출 시간 합 | 순수 DB 실행 시간이 아니며 ResultSet 전체 소비 비용과 일치하지 않음 |
| assemblyMs | 가져온 평탄한 결과를 최종 DTO로 조립하는 시간 | JDBC 결과를 평탄한 값으로 변환하는 과정 전체를 대표하지 않음 |
| queryCount | 해당 조회 구간에서 관측한 SELECT 수 | 전역 누적 통계가 아님 |
| totalRows / queries[].rows | QueryDSL이 실제 가져온 평탄한 결과의 행 수 | 고유 객체 수, DB 내부 스캔 행 수, 실제 전송 바이트가 아님 |

각 시간은 계측 범위와 오버헤드가 다르므로 무조건 합산·차감해서 CPU 시간이나 네트워크 시간이라고 해석하지 않는다. 반환 JSON이 같아도 DB→서버 전송량은 다를 수 있다. 바이트 계측을 하지 않았다면 행 수를 바이트 수로 표시하지 않는다.

## 권장 실험 순서

1. 기본 데이터에서 응답 정합성, SELECT 1/3회, 반환 행 수를 먼저 확인한다.
2. 부모 ID 1~50과 본문 크기를 고정하고 댓글·첨부파일 수만 바꾼다.
3. 자식 수를 고정하고 본문 크기를 0, 1,024, 8,192바이트 등으로 바꾼다.
4. 같은 seed의 UNIFORM과 SKEWED를 비교한다. 두 분포의 총 자식 수가 다를 수 있으므로 실제 개수도 함께 기록한다.
5. 별도 k6 실행으로 동시성을 늘리며 HTTP p95, 처리량, 오류율, JVM GC와 커넥션 풀 대기를 함께 본다.
6. [DB 왕복 지연 실험](LATENCY_STUDY.md)으로 지연을 통제해 왕복 횟수의 영향을 비교한다. 기본 Compose에 별도 지연 실험 overlay를 적용한다.

처음부터 모든 변수의 조합을 실행하지 않는다. 한 번에 한 변수를 바꾸고 성능이 역전되는 구간을 좁힌다. React 반복 실행은 기능 확인과 탐색용이다. 적은 표본의 p95는 변동이 크므로 부하 성능 결론에는 충분한 실행 시간과 반복 회차가 필요하다.

## 재현성

- 같은 seed, 데이터 설정, ID 집합, 버전, JVM·커넥션 풀·Docker 자원 설정을 기록한다.
- 데이터 생성 후 PostgreSQL 통계를 갱신한다.
- 첫 응답에는 JVM 클래스 로딩, JIT, 커넥션 준비, DB 캐시 영향이 있다. 워밍업 표본은 본 측정에서 제외한다.
- 탐색용 비교는 v1/v2 순서를 교대한다. 부하 실험은 전략별로 분리 실행하고 다음 회차에는 순서를 반대로 한다.
- 상세 SQL 로그, EXPLAIN, 무거운 프로파일링은 부하 측정과 따로 실행한다.
- `mode=benchmark`는 SQL 본문을 응답에서 생략한다. 관측 오버헤드 자체가 0이 되는 것은 아니다.
- 정상적인 실험 중에는 데이터를 재생성하거나 외부에서 수정하지 않는다. SKEWED는 매 10번째 ID에 설정값의 10배인 자식을 생성하고 나머지는 0개로 만든다.
- Docker Desktop, 브라우저, 부하 도구와 DB가 같은 머신 자원을 공유한다. 머신 간 절대 성능 비교에는 하드웨어·실행 환경 정보가 필요하다.

애플리케이션의 데이터 생성과 조회 보호 범위는 단일 서버 프로세스다. 외부 SQL이나 여러 서버 인스턴스의 쓰기까지 보호하는 실험 구성은 아니다. 동시 쓰기를 비교하려면 양쪽 요청의 트랜잭션 격리 수준과 스냅샷 요구부터 별도로 정한다. `readOnly=true`만으로 여러 SELECT의 동일 스냅샷을 보장하지 않는다.

## DB 원인 분석

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`은 조회를 실제 실행하고 실행 계획·반환 행·버퍼 사용을 보여준다. 일반 결과를 클라이언트로 보내지 않으며 계측 오버헤드도 있으므로 API 응답 시간과 직접 대체할 수 없다. 각 노드의 rows를 모두 더하면 같은 데이터가 중복 계산된다. 버퍼 지표도 상위 노드가 하위 노드 사용량을 포함할 수 있다.

`pg_stat_statements`는 SQL 형태별 누적 통계다. 실험 전후 스냅샷 차이로 `calls`, `rows`, `total_exec_time`, `shared_blks_hit/read`, `temp_blks_written`을 비교한다. 정규화된 IN 절의 길이에 따라 별도 항목이 만들어질 수 있다. 다른 작업이 실행되면 통계가 섞이므로 전략별로 분리 실행한다. 통계 조회와 EXPLAIN을 부하 실행 중에 반복하지 않는다.

## 후속 실험

현재 실험은 부모 ID가 이미 주어진 조건이다. 페이지네이션을 추가할 때는 부모 ID의 페이지를 먼저 구하고 양쪽에 동일하게 적용한다. 이 경우 공통 ID 조회까지 포함해 v1은 2회, v2는 4회가 된다. count 쿼리가 있다면 그 비용도 추가한다. 평탄한 JOIN 결과에 직접 LIMIT을 적용하면 부모 수와 자식 완전성을 보장하지 못한다.

엔티티 fetch join, 배치 로딩, JSON 집계 등을 추가하려면 별도 전략으로 둔다. 단일 SQL이라는 이유만으로 평탄한 JOIN과 JSON 집계를 같은 실험으로 취급하지 않는다.

## 참고

- [Hibernate: association fetching](https://docs.jboss.org/hibernate/orm/7.0/querylanguage/html_single/Hibernate_Query_Language.html)
- [PostgreSQL: EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html)
- [PostgreSQL: pg_stat_statements](https://www.postgresql.org/docs/18/pgstatstatements.html)
- [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html)
- [datasource-proxy](https://jdbc-observations.github.io/datasource-proxy/docs/current/user-guide/index.html)
