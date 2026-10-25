package com.example.querylab.support.experiment;

import com.example.querylab.domain.QueryStrategy;
import com.example.querylab.dto.dataset.SeedConfig;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** A conservative lab memory budget based on the last committed seed, without extra SELECTs. */
@Component
@RequiredArgsConstructor
public class ResultSizeGuard {

    private static final long MAX_RESULT_ROWS = 250_000;
    private static final long MAX_ESTIMATED_BYTES = 192L * 1024 * 1024;

    private final DatasetMetadata metadata;

    public void validate(List<Long> ids, QueryStrategy strategy) {
        SeedConfig config = metadata.getCurrentConfig();
        if (config == null) {
            return;
        }

        long rows = 0;
        long estimatedBytes = 0;
        for (Long id : ids) {
            if (id > config.getPostCount()) {
                continue;
            }

            long comments = config.childCount(config.getCommentsPerPost(), id);
            long attachments = config.childCount(config.getAttachmentsPerPost(), id);

            if (strategy == QueryStrategy.SINGLE_JOIN) {
                long joinedRows = Math.max(1, comments) * Math.max(1, attachments);
                rows += joinedRows;
                estimatedBytes += joinedRows * (config.getBodyBytes() + 512L);
            } else {
                rows += 1 + comments + attachments;
                estimatedBytes += config.getBodyBytes() + 512L + 256L * (comments + attachments);
            }
        }

        if (rows > MAX_RESULT_ROWS || estimatedBytes > MAX_ESTIMATED_BYTES) {
            throw new IllegalArgumentException(
                    "Estimated result exceeds the lab budget (250,000 rows or 192 MiB); "
                            + "reduce IDs, body size or child counts");
        }
    }
}
