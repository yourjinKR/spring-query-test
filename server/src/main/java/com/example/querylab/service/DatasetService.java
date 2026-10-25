package com.example.querylab.service;

import com.example.querylab.dto.dataset.DatasetStatus;
import com.example.querylab.dto.dataset.SeedConfig;
import com.example.querylab.repository.DatasetRepository;
import com.example.querylab.repository.seed.AttachmentSeedRow;
import com.example.querylab.repository.seed.CommentSeedRow;
import com.example.querylab.repository.seed.PostSeedRow;
import com.example.querylab.support.experiment.DatasetMetadata;
import com.example.querylab.support.experiment.LabTransactionLock;
import jakarta.validation.Validator;
import java.util.ArrayList;
import java.util.List;
import java.util.SplittableRandom;
import lombok.RequiredArgsConstructor;
import lombok.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class DatasetService {

    private static final int BATCH_SIZE = 1_000;
    private static final long MAX_CHILD_ROWS = 2_000_000;
    private static final long MAX_BODY_BYTES = 128L * 1024 * 1024;

    private final DatasetRepository datasetRepository;
    private final Validator validator;
    private final LabTransactionLock transactionLock;
    private final DatasetMetadata datasetMetadata;

    @Transactional(readOnly = true)
    public DatasetStatus status() {
        transactionLock.acquireReadLock();

        SeedConfig config = datasetRepository.findConfig().orElse(null);
        DatasetStatus status = new DatasetStatus(
                datasetRepository.countPosts(),
                datasetRepository.countComments(),
                datasetRepository.countAttachments(),
                config
        );
        datasetMetadata.updateAfterCommit(config);
        return status;
    }

    @Transactional
    public DatasetStatus replace(SeedConfig config) {
        transactionLock.acquireWriteLock();
        validate(config);

        datasetRepository.truncateLabTables();
        generateAndSavePosts(config);
        GeneratedChildren children = generateAndSaveChildren(config);
        datasetRepository.saveConfig(config);
        datasetRepository.analyzeTables();
        datasetMetadata.updateAfterCommit(config);

        return new DatasetStatus(config.getPostCount(), children.getCommentCount(),
                children.getAttachmentCount(), config);
    }

    private void validate(SeedConfig config) {
        if (config == null || !validator.validate(config).isEmpty()) {
            throw new IllegalArgumentException("Dataset values exceed the supported limits");
        }

        long childRows = 0;
        for (long postId = 1; postId <= config.getPostCount(); postId++) {
            childRows += config.childCount(config.getCommentsPerPost(), postId);
            childRows += config.childCount(config.getAttachmentsPerPost(), postId);
        }
        if (childRows > MAX_CHILD_ROWS) {
            throw new IllegalArgumentException("Dataset supports at most 2,000,000 total child rows");
        }
        if ((long) config.getPostCount() * config.getBodyBytes() > MAX_BODY_BYTES) {
            throw new IllegalArgumentException("Total post body size must not exceed 128 MiB");
        }
    }

    private void generateAndSavePosts(SeedConfig config) {
        List<PostSeedRow> posts = new ArrayList<>(BATCH_SIZE);
        for (long postId = 1; postId <= config.getPostCount(); postId++) {
            String body = generateBody(config, postId);
            posts.add(new PostSeedRow(postId, "Post " + postId, body));
            if (posts.size() == BATCH_SIZE) {
                datasetRepository.insertPosts(posts);
                posts.clear();
            }
        }
        if (!posts.isEmpty()) {
            datasetRepository.insertPosts(posts);
        }
    }

    private String generateBody(SeedConfig config, long postId) {
        SplittableRandom random = new SplittableRandom(config.getSeed() ^ (postId * 0x9e3779b97f4a7c15L));
        char[] body = new char[config.getBodyBytes()];
        for (int index = 0; index < body.length; index++) {
            body[index] = (char) ('a' + random.nextInt(26));
        }
        return new String(body);
    }

    private GeneratedChildren generateAndSaveChildren(SeedConfig config) {
        List<CommentSeedRow> comments = new ArrayList<>(BATCH_SIZE);
        List<AttachmentSeedRow> attachments = new ArrayList<>(BATCH_SIZE);
        long commentId = 1;
        long attachmentId = 1;

        for (long postId = 1; postId <= config.getPostCount(); postId++) {
            SplittableRandom random = new SplittableRandom(config.getSeed() ^ postId);
            int commentCount = config.childCount(config.getCommentsPerPost(), postId);
            int attachmentCount = config.childCount(config.getAttachmentsPerPost(), postId);

            for (int index = 0; index < commentCount; index++) {
                String content = "Comment " + index + " on post " + postId + " (seed " + config.getSeed() + ")";
                comments.add(new CommentSeedRow(commentId++, postId, content));
                if (comments.size() == BATCH_SIZE) {
                    datasetRepository.insertComments(comments);
                    comments.clear();
                }
            }

            for (int index = 0; index < attachmentCount; index++) {
                String fileName = "post-" + postId + "-file-" + index + ".txt";
                long byteSize = 1024L + random.nextInt(65536);
                attachments.add(new AttachmentSeedRow(attachmentId++, postId, fileName, byteSize));
                if (attachments.size() == BATCH_SIZE) {
                    datasetRepository.insertAttachments(attachments);
                    attachments.clear();
                }
            }
        }

        if (!comments.isEmpty()) {
            datasetRepository.insertComments(comments);
        }
        if (!attachments.isEmpty()) {
            datasetRepository.insertAttachments(attachments);
        }
        return new GeneratedChildren(commentId - 1, attachmentId - 1);
    }

    @Value
    private static class GeneratedChildren {

        long commentCount;
        long attachmentCount;
    }
}
