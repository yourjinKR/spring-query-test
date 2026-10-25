package com.example.querylab.repository;

import com.example.querylab.domain.Distribution;
import com.example.querylab.dto.dataset.SeedConfig;
import com.example.querylab.repository.seed.AttachmentSeedRow;
import com.example.querylab.repository.seed.CommentSeedRow;
import com.example.querylab.repository.seed.PostSeedRow;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** JDBC batch writes are used only to prepare the experiment's fixture data. */
@Repository
@RequiredArgsConstructor
public class DatasetRepository {

    private static final int BATCH_SIZE = 1_000;

    private final JdbcTemplate jdbcTemplate;

    public Optional<SeedConfig> findConfig() {
        List<SeedConfig> configurations = jdbcTemplate.query("""
                SELECT post_count, comments_per_post, attachments_per_post, body_bytes, seed, distribution
                FROM lab_dataset_config
                WHERE id = 1
                """, (resultSet, rowNumber) -> new SeedConfig(
                resultSet.getInt("post_count"),
                resultSet.getInt("comments_per_post"),
                resultSet.getInt("attachments_per_post"),
                resultSet.getInt("body_bytes"),
                resultSet.getLong("seed"),
                Distribution.valueOf(resultSet.getString("distribution"))
        ));
        return configurations.stream().findFirst();
    }

    public long countPosts() {
        return Objects.requireNonNull(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM lab_post", Long.class));
    }

    public long countComments() {
        return Objects.requireNonNull(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM lab_comment", Long.class));
    }

    public long countAttachments() {
        return Objects.requireNonNull(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM lab_attachment", Long.class));
    }

    public void truncateLabTables() {
        jdbcTemplate.execute("TRUNCATE TABLE lab_comment, lab_attachment, lab_post, lab_dataset_config");
    }

    public void insertPosts(List<PostSeedRow> posts) {
        jdbcTemplate.batchUpdate("INSERT INTO lab_post(id, title, body) VALUES (?, ?, ?)",
                posts, BATCH_SIZE, (statement, post) -> {
                    statement.setLong(1, post.getId());
                    statement.setString(2, post.getTitle());
                    statement.setString(3, post.getBody());
                });
    }

    public void insertComments(List<CommentSeedRow> comments) {
        jdbcTemplate.batchUpdate("INSERT INTO lab_comment(id, post_id, content) VALUES (?, ?, ?)",
                comments, BATCH_SIZE, (statement, comment) -> {
                    statement.setLong(1, comment.getId());
                    statement.setLong(2, comment.getPostId());
                    statement.setString(3, comment.getContent());
                });
    }

    public void insertAttachments(List<AttachmentSeedRow> attachments) {
        jdbcTemplate.batchUpdate("INSERT INTO lab_attachment(id, post_id, file_name, byte_size) VALUES (?, ?, ?, ?)",
                attachments, BATCH_SIZE, (statement, attachment) -> {
                    statement.setLong(1, attachment.getId());
                    statement.setLong(2, attachment.getPostId());
                    statement.setString(3, attachment.getFileName());
                    statement.setLong(4, attachment.getByteSize());
                });
    }

    public void saveConfig(SeedConfig config) {
        jdbcTemplate.update("""
                INSERT INTO lab_dataset_config(
                    id, post_count, comments_per_post, attachments_per_post, body_bytes, seed, distribution
                ) VALUES (1, ?, ?, ?, ?, ?, ?)
                """, config.getPostCount(), config.getCommentsPerPost(), config.getAttachmentsPerPost(),
                config.getBodyBytes(), config.getSeed(), config.getDistribution().name());
    }

    public void analyzeTables() {
        jdbcTemplate.execute("ANALYZE lab_post");
        jdbcTemplate.execute("ANALYZE lab_comment");
        jdbcTemplate.execute("ANALYZE lab_attachment");
    }
}
