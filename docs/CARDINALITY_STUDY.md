# 복수 To-Many cardinality와 조회 전략 비교

4차 실험은 댓글·첨부파일 수만 바꾸고, 같은 `Post + Comment[] + Attachment[]`를 반환하는 단일 LEFT JOIN(v1)과 순차 벌크 SELECT 3회(v2)를 비교한다. 분할 조회의 승리를 전제하지 않는다. 낮은 cardinality의 왕복 절감 효과, 결과 행 증가에 따른 비용 변화, 반복에서도 유지되는 우위 또는 혼재를 관찰한다.

## 기존 구조와 고정 조건

`main`의 README, 실험·반복·지연·동시성 문서와 benchmark 실행기·분석기를 검토했다. 조회 코드는 `PostController → PostService → PostQueryRepository`를 유지한다. 두 전략 모두 QueryDSL scalar projection, readOnly REPEATABLE READ 트랜잭션, 연결 하나를 사용한다. 조회/조립 타이머와 datasource-proxy도 변경하지 않는다. `pool-run.mjs`, `load.js`, `compare.mjs`의 k6·Hikari·DTO SHA-256 검증을 재사용하고, 분석 통계는 기존 `analyze-study.mjs`의 `distribution`을 사용한다.

| 조건 | 값 |
|---|---|
| 데이터 | 게시글 200개, 본문 1,024 ASCII bytes, seed 42, UNIFORM |
| 조회 부모 | 존재하는 ID 1~10, 항상 10개 |
| DB 경로 | Application → PostgreSQL direct |
| 추가 지연 | 0, Toxiproxy 사용 안 함 |
| Hikari | maximum/minimumIdle 10/10, acquire timeout 30,000ms, validation timeout 500ms |
| 부하 | closed model VU 1, 전략별 순차 실행, HTTP timeout 10초 |
| 자원 | 기본 Compose: 서버/DB 각각 CPU 상한 2개, 메모리 1 GiB, JVM heap 256~768 MiB |

`COMPOSE_FILE`을 기본 Compose로 고정하고 실제 실행 서버의 `DB_URL`을 각 실행 전후에 확인한다. proxy 경로이면 데이터 변경 전에 중단한다. 데이터 생성 API가 기존 세 테이블의 `ANALYZE`도 수행한다. 생성·정합성 검사·워밍업은 본 측정에서 제외한다. OSIV 및 ORM 캐시는 기존처럼 꺼져 있다.

## 시나리오와 기대 행 수

UNIFORM에서 부모 10개의 v1 행 수는 `10 × max(1,c) × max(1,a)`, v2는 `10 × (1+c+a)`이다. 댓글 또는 첨부가 없더라도 LEFT JOIN의 부모 행과 v2의 빈 자식 SELECT를 유지한다.

| 댓글/첨부 | v1 예상 행 | v2 예상 행 | v1/v2 | 행 감소율 `1−v2/v1` |
|---|---:|---:|---:|---:|
| 0/0 | 10 | 10 | 1.000 | 0.0% |
| 1/1 | 10 | 30 | 0.333 | −200.0% |
| 5/1 | 50 | 70 | 0.714 | −40.0% |
| 5/5 | 250 | 110 | 2.273 | 56.0% |
| 10/5 | 500 | 160 | 3.125 | 68.0% |
| 20/5 | 1,000 | 260 | 3.846 | 74.0% |
| 20/10 | 2,000 | 310 | 6.452 | 84.5% |
| 50/10 | 5,000 | 610 | 8.197 | 87.8% |
| 50/20 | 10,000 | 710 | 14.085 | 92.9% |
| 100/20 | 20,000 | 1,210 | 16.529 | 94.0% |

최대 시나리오의 JOIN 결과는 20,000행, 안전 제한에서 사용하는 보수적 메모리 추정은 약 29.3 MiB다. 기존 250,000행/192 MiB 조회 제한 안이므로 범위를 축소하지 않는다. 이는 실측 메모리나 전송 바이트가 아니다. 전체 데이터도 자식 24,000행·부모 본문 200 KiB로 생성 제한 안이다.

## 실행과 반복 설계

레포지토리 루트에서 Docker Desktop/Compose, Node.js 22+, PowerShell을 사용한다. Windows에서는 AC 전원을 확인하고 실행 중 임시 절전 방지 요청을 유지한다. 호출 프로세스 환경변수와 초기 데이터 설정·DTO·풀 설정을 종료 시 복원한다. 기존 데이터는 생성 설정으로 재현되는 실습 데이터여야 한다.

```powershell
docker compose up -d --build

# 모든 조건의 짧은 탐색
.\benchmarks\cardinality-study.ps1 -Stage sweep -Duration 5s -Repeats 1 -WarmupDuration 10s -OutputDirectory benchmarks/results/cardinality-sweep
node benchmarks/analyze-cardinality.mjs --input benchmarks/results/cardinality-sweep

# 탐색 결과로 선택한 조건의 반복 검증. 실제 선택과 이유는 측정 기록 참조.
.\benchmarks\cardinality-study.ps1 -Stage confirm -Scenarios '1/1','5/1','5/5','20/5','100/20' -Duration 30s -Repeats 5 -WarmupDuration 10s -OutputDirectory benchmarks/results/cardinality-confirm
node benchmarks/analyze-cardinality.mjs --input benchmarks/results/cardinality-confirm

# HTTP 캠페인이 모두 끝난 뒤에만 별도 DB 진단
node benchmarks/explain-cardinality.mjs --output benchmarks/results/cardinality-explain

# Matplotlib이 설치된 Python 사용
python benchmarks/plot-cardinality.py --sweep benchmarks/results/cardinality-sweep/analysis.json --confirmation benchmarks/results/cardinality-confirm/analysis.json --output docs/measurements/cardinality
```

기본 실행기는 전체 10개 조건·30초·5쌍이다. `-Scenarios`로 확인할 조건만 지정할 수 있다. 매 반복 시나리오 순서를 회전하고 짝수 반복에는 반대 방향으로 진행한다. 같은 조건의 v1/v2 선행도 AB/BA로 교대한다. 데이터 변경마다 두 전략을 각각 10초 워밍업하고, 개별 실행 직전 순차 요청 10회도 제외한다. 한 번의 k6 실행을 반복 단위로 삼는다.

다른 benchmark, UI 비교, EXPLAIN, 프로파일링, 데이터 변경을 함께 실행하지 않는다. 보조 관측은 기존 `node benchmarks/study-monitor.mjs <캠페인 디렉터리>`를 사용한다. 종료 시 디렉터리에 `monitor-stop` 파일을 만든다. 기본 5초 간격의 CPU·컨테이너 메모리·JVM heap/GC 표본이며 순간 최대를 보장하지 않는다.

## 유효성 및 실패 처리

- 각 데이터 변경 후 전체 테이블 개수·생성 설정, 측정 전후 메타데이터를 검사한다.
- 두 전략의 `posts` SHA-256과 부모 수, SELECT 1/3회, `totalRows`, `queries[].rows`를 쌍 전후에 검사한다.
- k6의 모든 측정 응답에서 기대 `totalRows`와 개별 SELECT 행 수를 검사한다. `returned_rows`, `query_count`, `query_1_rows`~`query_3_rows`의 min/max/count를 저장한다. v2의 빈 자식 조회도 0행 표본으로 남긴다.
- 기대 행 수 불일치는 정상 결과로 취급하지 않는다. 원시 보고서를 남기고 중단한다.
- `campaign.json`, `progress.json`, `runtime.json`, 데이터/정합성/워밍업/측정 JSON을 보존한다. 같은 출력 디렉터리를 덮어쓰지 않는다.
- 정상 비교는 같은 반복 번호의 두 전략이 모두 정상인 공통 쌍만 사용한다. HTTP/계약 오류, timeout, dropped/incomplete, 계측 무효와 불완전 캠페인은 별도 공개한다.
- elapsed가 설정 duration + HTTP timeout + 2초를 넘으면 clock-gap 검사가 무효 처리한다. 호스트 절전의 증명은 아니다.
- 취소하려면 출력 디렉터리에 `cancel` 파일을 만든다. 실행 경계에서 중단 후 복원한다. 강제 프로세스 종료 시 finally 복원을 보장할 수 없다.

`pool-run`의 신규 기대 행 옵션은 opt-in이다. 기존 repeat/latency 캠페인의 데이터나 변수는 변경하지 않는다.

## 지표와 해석

주 지표는 실행별 HTTP p50/p95와 완료·성공 RPS다. p99는 성공 요청 1,000개 이상 여부를 함께 표시하는 보조 지표다. 이는 정밀한 모집단 tail 추정 보장이 아니다. 실행별 통계의 중앙값과 관측 최소~최대를 요약하며 요청을 합친 백분위나 신뢰구간으로 표시하지 않는다. closed VU 1의 달성 RPS는 같은 도착률 비교나 최대 수용량이 아니다. k6 HTTP duration은 JSON 파싱·응답 검증 시간을 제외하지만 이 작업은 다음 요청 시점과 RPS에 영향을 준다.

`fetchAndAssembleMs`는 서버 조회·평탄값 변환·DTO 조립 구간이며 트랜잭션 진입의 연결 획득, 종료와 HTTP 직렬화를 모두 포함하지 않는다. `jdbcExecuteMs`는 datasource-proxy의 JDBC execute 호출 경과 시간 합계로 **정수 ms 해상도**다. 순수 PostgreSQL execution time이나 전체 ResultSet 소비 시간이 아니다. `assemblyMs`는 `.fetch()` 후 TreeMap·자식 중복 제거 등 최종 DTO 조립 구간이다. 백분위를 빼서 순수 JDBC/네트워크 시간을 계산하지 않는다.

`totalRows`는 QueryDSL이 가져온 평탄한 결과 행 수다. DB 내부 scan rows·네트워크 bytes가 아니다. 본문은 고정하지만 결과 중복과 실제 wire bytes의 관계를 계측한 실험도 아니다. 단일 JOIN assembler는 중복 행마다 자식 DTO를 만들고 `putIfAbsent`하므로, 측정에는 현재 구현의 중복 제거·할당 비용도 반영된다.

DB 진단은 앱 analysis SQL의 `?`에 같은 ID를 대입해 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`을 쿼리별 반복 실행한다. 최상위 rows, 중간 JOIN rows/loops, 실제 DB execution time, 버퍼 hit/read, JOIN 방식과 temp를 보존한다. 상위 노드의 buffers는 하위를 포함할 수 있어 노드별 합계를 만들지 않는다. EXPLAIN은 일반 결과 전송·DTO 조립을 하지 않으므로 HTTP 시간과 같은 값으로 비교하지 않는다. literal SQL의 별도 진단이며 PgJDBC의 prepared/generic plan이나 앱의 readOnly REPEATABLE READ 트랜잭션 문맥을 동일하게 재현하지는 않는다. `pg_stat_statements`도 본 측정 후 분리한 요청 블록의 전후 차이만 보조적으로 사용한다.

## 결과와 후속 범위

실측·선택한 반복 조건·오류·그래프·원시 데이터·재현 명령·검증은 [2026-10-30 측정 기록](measurements/cardinality-2026-10-30-analysis.md)에 정리한다.

3차 [왕복 지연 실험](LATENCY_STUDY.md)은 고정한 결과 행 수에서 추가 RTT를 바꿨고, 이번 실험은 direct 경로에서 cardinality를 바꾼다. 서로 다른 실행 블록의 절대값을 연결해 정밀한 2차원 경계로 추정하지 않는다. Query Count와 결과 행 처리 비용의 절충이 실제 관측과 일치하는지 검토한다.

후속 후보는 Row width(`bodyBytes`), UNIFORM vs SKEWED, Latency × Cardinality matrix, 동시성 증가에서의 cardinality 영향이다. 이번 변경에서는 실행하지 않는다.

