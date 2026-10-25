package com.example.querylab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.querylab.domain.Distribution;
import com.example.querylab.domain.QueryStrategy;
import com.example.querylab.dto.dataset.DatasetStatus;
import com.example.querylab.dto.dataset.SeedConfig;
import com.example.querylab.dto.metrics.QueryMetric;
import com.example.querylab.dto.post.PostsResponse;
import com.example.querylab.service.DatasetService;
import com.example.querylab.service.PostService;
import com.example.querylab.support.experiment.DatasetMetadata;
import com.example.querylab.support.experiment.LabTransactionLock;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "lab.seed-on-startup=false")
@Testcontainers(disabledWithoutDocker = true)
class PostgresQueryIntegrationTest {

    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18.6-bookworm");

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @Autowired
    private DatasetService datasetService;

    @Autowired
    private PostService postService;

    @Autowired
    private DatasetMetadata datasetMetadata;

    @Autowired
    private LabTransactionLock transactionLock;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void identicalResultsWithOneVersusThreeSelectsAndActualFlatRows() {
        datasetService.replace(new SeedConfig(3, 4, 3, 64, 42, Distribution.UNIFORM));
        List<Long> ids = List.of(1L, 2L, 3L);

        PostsResponse v1 = postService.findWithSingleQuery(ids, true);
        PostsResponse v2 = postService.findWithSplitQueries(ids, true);

        assertThat(v1.getPosts()).isEqualTo(v2.getPosts()).hasSize(3);
        assertThat(v1.getMetrics().getQueryCount()).isEqualTo(1);
        assertThat(v2.getMetrics().getQueryCount()).isEqualTo(3);
        assertThat(v1.getMetrics().getTotalRows()).isEqualTo(36);
        assertThat(v2.getMetrics().getTotalRows()).isEqualTo(24);
        assertThat(v2.getMetrics().getQueries())
                .extracting(QueryMetric::getRows)
                .containsExactly(3L, 12L, 9L);
        assertThat(v1.getMetrics().getQueries().getFirst().getSql()).containsIgnoringCase("left join");
        assertThat(v1.getPosts().getFirst().getComments()).hasSize(4);
        assertThat(v1.getPosts().getFirst().getAttachments()).hasSize(3);
        assertThat(v1.getPosts().getFirst().getBody().getBytes(StandardCharsets.US_ASCII)).hasSize(64);
    }

    @Test
    void keepsParentsWithEmptyCollectionsAndAlwaysRunsThreeBulkSelects() {
        datasetService.replace(new SeedConfig(2, 0, 0, 0, 8, Distribution.UNIFORM));

        PostsResponse v1 = postService.findWithSingleQuery(List.of(1L, 2L, 999L), true);
        PostsResponse v2 = postService.findWithSplitQueries(List.of(1L, 2L, 999L), true);

        assertThat(v1.getPosts()).isEqualTo(v2.getPosts()).hasSize(2);
        assertThat(v1.getMetrics().getTotalRows()).isEqualTo(2);
        assertThat(v2.getMetrics().getTotalRows()).isEqualTo(2);
        assertThat(v2.getMetrics().getQueryCount()).isEqualTo(3);
        assertThat(v1.getPosts()).allSatisfy(post -> {
            assertThat(post.getComments()).isEmpty();
            assertThat(post.getAttachments()).isEmpty();
        });

        PostsResponse missing = postService.findWithSplitQueries(List.of(999L), false);

        assertThat(missing.getPosts()).isEmpty();
        assertThat(missing.getMetrics().getQueryCount()).isEqualTo(3);
        assertThat(missing.getMetrics().getTotalRows()).isZero();
    }

    @Test
    void skewedDatasetIsDeterministicAndDoesNotLoseOrDuplicateChildren() {
        SeedConfig config = new SeedConfig(10, 2, 1, 33, 17, Distribution.SKEWED);
        DatasetStatus status = datasetService.replace(config);

        PostsResponse first = postService.findWithSingleQuery(List.of(1L, 10L), true);
        PostsResponse split = postService.findWithSplitQueries(List.of(1L, 10L), true);

        assertThat(first.getPosts()).isEqualTo(split.getPosts());
        assertThat(first.getMetrics().getTotalRows()).isEqualTo(201);
        assertThat(split.getMetrics().getTotalRows()).isEqualTo(32);
        assertThat(status.getCommentCount()).isEqualTo(20);
        assertThat(status.getAttachmentCount()).isEqualTo(10);

        datasetService.replace(config);

        assertThat(postService.findWithSingleQuery(List.of(1L, 10L), true).getPosts())
                .isEqualTo(first.getPosts());
        assertThat(datasetService.status()).isEqualTo(status);
    }

    @Test
    void benchmarkModeOmitsSqlAndMetricsDoNotLeakAcrossRequests() {
        datasetService.replace(new SeedConfig(1, 2, 2, 5, 7, Distribution.UNIFORM));

        PostsResponse v1 = postService.findWithSingleQuery(List.of(1L), false);
        PostsResponse v2 = postService.findWithSplitQueries(List.of(1L), false);

        assertThat(v1.getMetrics().getQueryCount()).isEqualTo(1);
        assertThat(v2.getMetrics().getQueryCount()).isEqualTo(3);
        assertThat(v2.getMetrics().getQueries())
                .allSatisfy(metric -> assertThat(metric.getSql()).isNull());
    }

    @Test
    void invalidDatasetCannotDestroyThePreviousSeed() {
        DatasetStatus before = datasetService.replace(new SeedConfig(2, 1, 1, 4, 3, Distribution.UNIFORM));

        assertThatThrownBy(() -> datasetService.replace(
                new SeedConfig(10_001, 1, 1, 4, 3, Distribution.UNIFORM)))
                .isInstanceOf(IllegalArgumentException.class);

        assertThat(datasetService.status()).isEqualTo(before);
    }

    @Test
    void guardsExplodingJoinBeforeFetchWhileAllowingTheEquivalentSplitRead() {
        DatasetStatus before = datasetService.replace(new SeedConfig(10, 200, 100, 0, 42, Distribution.SKEWED));

        assertThatThrownBy(() -> postService.findWithSingleQuery(List.of(10L), true))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Estimated result exceeds the lab budget");

        PostsResponse split = postService.findWithSplitQueries(List.of(10L), true);

        assertThat(split.getPosts()).hasSize(1);
        assertThat(split.getPosts().getFirst().getComments()).hasSize(2_000);
        assertThat(split.getPosts().getFirst().getAttachments()).hasSize(1_000);
        assertThat(split.getMetrics().getQueryCount()).isEqualTo(3);
        assertThat(split.getMetrics().getTotalRows()).isEqualTo(3_001);
        assertThat(datasetService.status()).isEqualTo(before);
    }

    @Test
    void concurrentCallsKeepQueryCountsRowsAndSqlVisibilityIsolated() throws Exception {
        datasetService.replace(new SeedConfig(3, 4, 3, 64, 42, Distribution.UNIFORM));
        List<Long> ids = List.of(1L, 2L, 3L);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<PostsResponse>> futures = new ArrayList<>();

        try (ExecutorService executor = Executors.newFixedThreadPool(4)) {
            try {
                for (int index = 0; index < 16; index++) {
                    int requestIndex = index;
                    futures.add(executor.submit(() -> {
                        awaitLatch(start);
                        boolean includeSql = requestIndex % 4 < 2;
                        return requestIndex % 2 == 0
                                ? postService.findWithSingleQuery(ids, includeSql)
                                : postService.findWithSplitQueries(ids, includeSql);
                    }));
                }
                start.countDown();

                for (int index = 0; index < futures.size(); index++) {
                    PostsResponse response = futures.get(index).get(10, TimeUnit.SECONDS);
                    boolean singleQuery = index % 2 == 0;
                    boolean includeSql = index % 4 < 2;

                    assertThat(response.getStrategy()).isEqualTo(singleQuery
                            ? QueryStrategy.SINGLE_JOIN : QueryStrategy.SPLIT_QUERIES);
                    assertThat(response.getMetrics().getQueryCount()).isEqualTo(singleQuery ? 1 : 3);
                    assertThat(response.getMetrics().getTotalRows()).isEqualTo(singleQuery ? 36 : 24);
                    assertThat(response.getPosts()).hasSize(3);
                    assertThat(response.getMetrics().getQueries()).allSatisfy(metric -> {
                        if (includeSql) {
                            assertThat(metric.getSql()).startsWithIgnoringCase("select");
                        } else {
                            assertThat(metric.getSql()).isNull();
                        }
                    });
                }
            } finally {
                start.countDown();
                executor.shutdownNow();
            }
        }
    }

    @Test
    void datasetWriteLockAndMetadataPublicationFollowTheOuterTransactionCommit() throws Exception {
        SeedConfig baseline = new SeedConfig(2, 1, 1, 4, 11, Distribution.UNIFORM);
        SeedConfig replacement = new SeedConfig(3, 2, 1, 8, 22, Distribution.UNIFORM);
        datasetService.replace(baseline);
        assertThat(datasetMetadata.getCurrentConfig()).isEqualTo(baseline);

        CountDownLatch replacementReturned = new CountDownLatch(1);
        CountDownLatch allowCommit = new CountDownLatch(1);
        CountDownLatch readerAttempted = new CountDownLatch(1);

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            try {
                Future<DatasetStatus> writer = executor.submit(() -> {
                    TransactionTemplate transaction = new TransactionTemplate(transactionManager);
                    return transaction.execute(status -> {
                        DatasetStatus replaced = datasetService.replace(replacement);
                        replacementReturned.countDown();
                        awaitLatch(allowCommit);
                        return replaced;
                    });
                });

                assertThat(replacementReturned.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(datasetMetadata.getCurrentConfig()).isEqualTo(baseline);

                Future<Boolean> reader = executor.submit(() -> {
                    TransactionTemplate transaction = new TransactionTemplate(transactionManager);
                    return transaction.execute(status -> {
                        readerAttempted.countDown();
                        transactionLock.acquireReadLock();
                        return true;
                    });
                });

                assertThat(readerAttempted.await(10, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> reader.get(200, TimeUnit.MILLISECONDS))
                        .isInstanceOf(TimeoutException.class);
                assertThat(datasetMetadata.getCurrentConfig()).isEqualTo(baseline);

                allowCommit.countDown();

                assertThat(writer.get(10, TimeUnit.SECONDS).getConfig()).isEqualTo(replacement);
                assertThat(reader.get(10, TimeUnit.SECONDS)).isTrue();
                assertThat(datasetMetadata.getCurrentConfig()).isEqualTo(replacement);
            } finally {
                allowCommit.countDown();
                executor.shutdownNow();
            }
        }
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Timed out while coordinating the transaction test");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while coordinating the transaction test", exception);
        }
    }
}
