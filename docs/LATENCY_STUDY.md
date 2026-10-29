# DB 왕복 지연과 조회 전략 비교

이 실습은 애플리케이션과 DB 사이에 추가한 지연에 따라 단일 JOIN(v1)과 순차 벌크 SELECT 3회(v2)의 우열이 어떻게 달라지는지 측정한다. 실제 EC2–Supabase 환경의 재현이나 해당 서비스의 성능 추정은 목적에 포함하지 않는다.

## 고정 조건

직전 [반복 실험](REPEATED_STUDY.md)의 데이터와 자원 조건을 사용한다.

- 게시글 200개, 게시글당 댓글 20개·첨부파일 5개, 본문 1,024바이트, seed 42, UNIFORM.
- 조회 ID 1~10. v1은 1 SELECT·1,000행, v2는 3 SELECT·260행이며 같은 DTO를 반환한다.
- 서버와 PostgreSQL 각각 CPU 상한 2개·메모리 1 GiB, JVM heap 256~768 MiB.
- 동일한 readOnly REPEATABLE READ 트랜잭션, 동일한 커넥션 재사용, fetch size 0.
- 풀은 기본 10개, 부하 실험에서는 2개와 10개를 비교한다. minimumIdle은 상한과 같다.
- 커넥션 획득 timeout 1,000ms, 검증 timeout 500ms, HTTP timeout 10초. 실패 표본도 보존한다.

데이터는 실행기가 재생성하지 않는다. 시작 조건과 실행 전후 메타데이터를 검사한다.

## 연결 경로와 제어 도구

```text
기본 경로: Application → PostgreSQL
지연 경로: Application → Toxiproxy → PostgreSQL
제어 경로: 실험용 Java CLI → Toxiproxy HTTP API
```

`compose.latency.yaml`을 기본 Compose에 겹쳐 사용한다. Toxiproxy 2.13.0은 기본 CPU 상한 4개·메모리 256 MiB이며, `TOXIPROXY_CPUS`로 상한을 바꿀 수 있다. 제어 API는 호스트 loopback에만 노출한다. 평소 `compose.yaml`의 DB 경로는 direct다. 프록시 자체의 CPU 포화가 비교를 지배하지 않는지 자원 표본을 확인한다.

[toxiproxy-java 2.1.7](https://github.com/trekawek/toxiproxy-java)은 별도 Toxiproxy 서버를 제어하는 Java 클라이언트다. `benchmarks/toxiproxy-client/`의 실험용 CLI에서만 사용한다. 애플리케이션의 조회 코드는 변경하지 않는다.

추가 RTT R ms에 대해 upstream을 floor(R/2), downstream을 ceil(R/2)로 설정한다. Toxiproxy의 지연 단위가 정수 ms이므로 R=1이면 각각 0ms와 1ms다. jitter는 0, toxicity는 1로 고정한다. 0ms에서는 이 실험이 관리하는 latency toxic을 제거한다. 다른 toxic이 있으면 비교를 중단한다.

이는 TCP 스트림 지연 설정이다. SQL마다 정확히 한 번 일정 시간을 더하는 장치로 해석하지 않는다. 운영체제 타이머·버퍼·스케줄링 때문에 특히 작은 설정값과 관측 지연은 다를 수 있다.

## 단계

1. **경로 기준점**: direct와 proxy 0ms를 비교해 프록시 경유 자체의 영향을 확인한다.
2. **탐색**: 풀 10·VU 1에서 추가 RTT 0·1·2·5·10·20·50ms를 비교한다. 짧은 실행은 탐색 결과로 표시한다.
3. **반복 검증**: 탐색에서 관측한 역전 구간과 대표 지연을 30초·5쌍으로 확인한다. 역전점은 관측한 구간으로 보고하며 백분위 차이로 정확한 임계값을 계산하지 않는다.
4. **동시 부하**: 대표 RTT에서 풀 2/10·VU 20을 비교해 연결 점유와 획득 지연의 변화를 본다. 같은 VU가 같은 도착률을 뜻하지 않는다.

각 RTT에서 기존 연결을 재사용하는 SELECT 1을 direct/proxy 각각 10회 워밍업하고 기본 30회 표본을 수집한다. 결과는 설정된 추가 RTT를 점검하는 보조 교정값이며 순수 네트워크 RTT 측정값이 아니다. 단순 쿼리의 p95 차이를 API의 네트워크 비용으로 대체하지 않는다.

별도 DTO 정합성 검사와 워밍업은 측정 구간에서 제외한다. 전략 실행 순서는 AB/BA로 교대하고 반복마다 RTT 순서를 회전한다. 워밍업 결과도 별도 파일로 남긴다.

고정 도착률은 기본 실행하지 않는다. 추가할 때는 낮은 공통 도착률을 사전 확인하고 `-ArrivalRate`로 명시한다. 높은 지연에서 기존 150 req/s를 그대로 사용하면 포화·실패를 비교하는 실험이 될 수 있다. 발생기의 VU 부족으로 생긴 dropped iteration도 서버 오류와 구분한다.

## 실행

레포지토리 루트에서 Docker와 Node.js 22 이상을 사용한다.

```powershell
# 기본 앱과 직전 실험의 데이터가 먼저 준비되어 있어야 한다.
docker compose up -d --build
docker compose -f compose.yaml -f compose.latency.yaml --profile latency-tools build toxiproxy-control
# 초기 낮은 동시성 측정의 프록시 상한. 일반적인 기본값은 4다.
$env:TOXIPROXY_CPUS = '1.0'
docker compose -f compose.yaml -f compose.latency.yaml up -d toxiproxy

# 짧은 탐색. 출력 디렉터리는 기존 결과와 겹치지 않게 지정한다.
.\benchmarks\latency-study.ps1 -Stage baseline -Duration 10s -Repeats 3 -OutputDirectory benchmarks/results/latency-baseline
.\benchmarks\latency-study.ps1 -Stage sweep -Duration 10s -Repeats 1 -OutputDirectory benchmarks/results/latency-exploration

# 탐색 결과에 따라 RTT를 선택한 뒤 반복 검증한다.
.\benchmarks\latency-study.ps1 -Stage refine -RttMs 0,1,2 -Duration 30s -Repeats 5 -OutputDirectory benchmarks/results/latency-confirmation
# 경계 구간의 p95 혼재를 확인한 뒤 별도 블록으로 추가한 조건.
.\benchmarks\latency-study.ps1 -Stage refine -RttMs 5 -Duration 30s -Repeats 5 -OutputDirectory benchmarks/results/latency-confirmation-5ms
# 첫 부하 시도의 1코어 프록시 포화가 확인되어 본 부하 비교에서는 여유를 둔다.
$env:TOXIPROXY_CPUS = '4.0'
docker compose -f compose.yaml -f compose.latency.yaml up -d --no-deps toxiproxy
.\benchmarks\latency-study.ps1 -Stage load -Pools 2,10 -RttMs 0,2,10 -Duration 30s -Repeats 5 -OutputDirectory benchmarks/results/latency-load

node benchmarks/analyze-latency.mjs --input benchmarks/results/latency-confirmation
node benchmarks/analyze-latency.mjs --input benchmarks/results/latency-confirmation-5ms
node benchmarks/analyze-latency.mjs --input benchmarks/results/latency-load
```

실행기는 `campaign.json`과 `progress.json`, 실행별 k6/Hikari JSON, 교정·프록시 설정·정합성 스냅샷을 저장한다. 중단·실패를 포함해 기록하며 종료 시 원래 서버의 DB 경로·풀 설정과 호출 프로세스 환경변수를 복원한다. 다른 부하나 데이터 변경을 동시에 실행하지 않는다.

부하 실패가 있으면 결과를 저장하고 설정을 복원한 뒤 `completed_with_load_failures`와 종료 코드 1을 반환한다. 이를 계측 무효나 불완전한 실행과 구분하며, 자동 분석은 공통 정상 쌍의 지연 비교와 전체 실패 기록을 함께 제공한다.

Windows에서는 기본적으로 AC 전원 연결을 확인하고 시작·종료 시 전원 상태를 기록한다. 실행 중에는 화면 설정이나 전원 계획을 바꾸지 않고 임시 시스템 절전 방지 요청을 유지하며 종료 시 해제한다. `-RequireAcPower:$false`로 전원 확인을 명시적으로 해제할 수 있다.

실행을 중단하려면 출력 디렉터리에 `cancel` 파일을 만든다. 현재 실행을 마친 뒤 다음 경계에서 중단하고 원래 설정을 복원한다. 프로세스를 강제 종료하면 복원 코드를 실행하지 못할 수 있으므로 이 취소 경로를 사용한다.

자원 보조 관측이 필요하면 별도 터미널에서 `node benchmarks/study-monitor.mjs <결과 디렉터리>`를 실행한다. 서버·DB·프록시·부하 발생기 CPU와 JVM GC를 표본 수집하며, 결과 디렉터리에 `monitor-stop` 파일을 생성하면 종료한다.

## 결과 해석

- 주 지표는 HTTP p50/p95, 연결 usage/acquire, 완료·성공 RPS, 오류·timeout·dropped·미완료다.
- `fetchAndAssembleMs`는 트랜잭션 진입의 연결 획득과 종료 처리를 모두 포함하지 않는다. `jdbcExecuteMs`도 순수 DB 실행 시간이 아니다.
- SELECT 3회는 커넥션 획득 3회를 뜻하지 않는다. v2는 연결 하나를 계속 사용한다.
- `v2의 추가 왕복 비용 ≈ 2 × 추가 RTT`는 낮은 부하에서의 설명용 가설이다. 트랜잭션 제어·드라이버·전송·타이머 효과 때문에 실제 기울기로 검토한다.
- 정상 비교는 같은 반복 번호의 두 전략이 모두 정상인 쌍을 사용한다. 실패는 별도 표와 전체 실행 기록에 남긴다.
- 실행별 통계의 중앙값과 관측 범위를 요약한다. 여러 실행의 p95를 합쳐 전체 요청의 p95라고 부르지 않는다.
- JOIN 반환 행과 DB→앱 전송 바이트는 다르다. 본 실험은 실제 전송 바이트를 계측하지 않는다.
- 고정 지연 실험 이후에 데이터 크기·jitter·대역폭을 별도 변수로 확장할 수 있다.

실측값과 단계별 표본 수는 [2026-10-29 측정 기록](measurements/latency-2026-10-29-analysis.md)에 정리한다. 5ms 확인은 0~2ms 확인 후 선택한 별도 JVM 블록이며, 그 사이를 같은 블록의 연속 곡선처럼 연결하지 않는다.

최종 정적 그림은 Python과 Matplotlib이 설치된 환경에서 생성할 수 있다. 각 입력은 완료된 캠페인의 자동 분석 JSON이다.

```powershell
python benchmarks/plot-latency.py --confirmation benchmarks/results/latency-confirmation/analysis.json benchmarks/results/latency-confirmation-5ms/analysis.json --load benchmarks/results/latency-load/analysis.json --output docs/measurements/latency-2026-10-29.png
```
