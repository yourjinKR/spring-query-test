# Backend

일반적인 Spring MVC의 Controller–Service–Repository 구조 안에서 두 조회 전략을 비교합니다. 서버 외부의 React·k6·Docker·DB 관측 설정과 API JSON 형식은 유지합니다.

## 읽는 순서

1. [PostController](src/main/java/com/example/querylab/controller/PostController.java): `/v1/posts`, `/v2/posts` 매핑과 입력 검증
2. [PostService](src/main/java/com/example/querylab/service/PostService.java): 트랜잭션 경계와 전략별 조회 순서
3. [PostQueryRepository](src/main/java/com/example/querylab/repository/PostQueryRepository.java): QueryDSL 쿼리
4. [PostResponseAssembler](src/main/java/com/example/querylab/service/PostResponseAssembler.java): 중복 제거, 정렬, 응답 DTO 조립

v1은 `findJoinedPosts()` 한 번을 호출합니다. v2는 `findPosts()`, `findComments()`, `findAttachments()`를 순서대로 호출합니다. 두 서비스 메서드를 나란히 읽으면 차이가 드러나며, 두 방식 모두 읽기 전용 REPEATABLE READ 트랜잭션에서 실행합니다.

## 패키지와 책임

| 패키지 | 책임 |
|---|---|
| controller | URL 매핑, 요청 검증, Service 호출 |
| controller.advice | 예외와 HTTP 응답 매핑 |
| service | 조회·데이터 생성 정책, 트랜잭션, 응답 조립 |
| repository | QueryDSL 조회와 JDBC 일괄 저장 등 데이터 접근 |
| repository.projection | 쿼리의 평탄한 결과를 담는 타입 |
| repository.seed | 실험 데이터의 일괄 저장에 사용하는 타입 |
| domain | JPA 엔티티와 열거형 |
| dto | 개별 요청·응답 클래스 |
| config | QueryDSL Bean, 시작 시 데이터 초기화와 설정 |
| metrics | JDBC 관측과 요청별 계측 수명 주기 |
| support.experiment | 실험용 동시 실행 제어·메타데이터·메모리 예산 |

QueryDSL 전용 Repository는 `@Repository` 클래스로 구현합니다. 현재 사용하지 않는 CRUD 인터페이스나 Service 구현체 인터페이스는 추가하지 않습니다. 향후 일반적인 저장·수정 기능이 필요하면 목적에 맞게 `JpaRepository`를 추가할 수 있습니다.

데이터 생성도 `DatasetController → DatasetService → DatasetRepository`를 따릅니다. Service가 seed·분포·검증·청크 생성을 담당하고 Repository는 SQL을 실행합니다. 많은 실험 데이터를 준비하는 작업에는 JDBC batch를 사용하며, 비교 대상 조회는 JPA/QueryDSL입니다.

## Lombok과 코드 규칙

- Spring Bean은 `@RequiredArgsConstructor`와 `private final` 필드로 생성자 주입합니다.
- 엔티티는 `@Getter`와 `@NoArgsConstructor(access = PROTECTED)`를 사용합니다. `@Data`, 모든 필드의 setter, 연관관계를 포함하는 자동 equals/hashCode/toString은 추가하지 않습니다.
- 응답과 projection은 불변 Lombok 값 클래스를 사용합니다. JSON 요청인 `SeedConfig`는 기본 생성자·getter/setter와 Bean Validation을 사용합니다.
- 중첩 DTO 모음을 없애고 DTO마다 파일을 둡니다. 명시적 import와 여러 줄 형식으로 책임과 조건문이 드러나게 합니다.
- Lombok 버전은 Spring Boot BOM이 관리합니다. Maven에 Lombok과 QueryDSL annotation processor를 모두 명시하고 Lombok은 실행 JAR에서 제외합니다.

## 실험 지원 코드의 경계

`PostQueryObserver`는 계측 시작·완료·예외 시 정리를 처리합니다. Repository는 실제 fetch한 평탄한 결과 개수를 기록하며, 관측 구간 밖에서 직접 호출할 때는 계측 없이 동작합니다. Service는 SQL이나 JDBC 이벤트 처리 방법을 알 필요가 없습니다.

`LabTransactionLock`은 데이터 교체와 조회가 겹치지 않게 하는 단일 프로세스의 지원 코드입니다. Service의 `@Transactional` 경계 안에서 잠금을 얻고, Spring의 트랜잭션 완료 콜백에서 해제합니다. 따라서 메서드가 반환된 뒤 커밋·롤백이 끝날 때까지 잠금이 유지됩니다. `DatasetMetadata`도 커밋 후에만 갱신해 실패한 교체 요청이 조회 크기 제한에 영향을 주지 않게 합니다.

이 지원 코드는 일반적인 업무 애플리케이션에 그대로 적용해야 하는 패턴을 뜻하지 않습니다. 실험 중 데이터 재생성을 제어하기 위한 코드이며, 실제 조회 전략은 Controller–Service–Repository에서 확인할 수 있습니다.

## 검증

Java 21과 Docker를 준비한 뒤 실행합니다.

```powershell
.\mvnw.cmd clean test
.\mvnw.cmd package
```

`clean` 빌드는 삭제된 옛 클래스와 생성된 Q 클래스가 남아 우연히 실행되는 것을 방지하며 Lombok·QueryDSL의 annotation processing을 함께 확인합니다. PostgreSQL 통합 테스트가 생략되지 않았는지도 확인합니다. 전체 실행 방법과 실험 조건은 [루트 안내](../README.md)를 참고하세요.
