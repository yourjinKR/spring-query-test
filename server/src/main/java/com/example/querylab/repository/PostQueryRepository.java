package com.example.querylab.repository;

import static com.example.querylab.domain.QAttachment.attachment;
import static com.example.querylab.domain.QComment.comment;
import static com.example.querylab.domain.QPost.post;

import com.example.querylab.metrics.QueryMetrics;
import com.example.querylab.repository.projection.AttachmentRow;
import com.example.querylab.repository.projection.CommentRow;
import com.example.querylab.repository.projection.JoinedPostRow;
import com.example.querylab.repository.projection.PostRow;
import com.querydsl.core.types.Projections;
import com.querydsl.jpa.impl.JPAQueryFactory;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;

@Repository
@RequiredArgsConstructor
public class PostQueryRepository {

    private final JPAQueryFactory queryFactory;
    private final QueryMetrics queryMetrics;

    public List<JoinedPostRow> findJoinedPosts(List<Long> postIds) {
        List<JoinedPostRow> rows = queryFactory
                .select(Projections.constructor(
                        JoinedPostRow.class,
                        post.id,
                        post.title,
                        post.body,
                        comment.id,
                        comment.content,
                        attachment.id,
                        attachment.fileName,
                        attachment.byteSize))
                .from(post)
                .leftJoin(comment).on(comment.post.id.eq(post.id))
                .leftJoin(attachment).on(attachment.post.id.eq(post.id))
                .where(post.id.in(postIds))
                .fetch();

        queryMetrics.fetched(rows.size());
        return rows;
    }

    public List<PostRow> findPosts(List<Long> postIds) {
        List<PostRow> rows = queryFactory
                .select(Projections.constructor(PostRow.class, post.id, post.title, post.body))
                .from(post)
                .where(post.id.in(postIds))
                .fetch();

        queryMetrics.fetched(rows.size());
        return rows;
    }

    public List<CommentRow> findComments(List<Long> postIds) {
        List<CommentRow> rows = queryFactory
                .select(Projections.constructor(CommentRow.class, comment.post.id, comment.id, comment.content))
                .from(comment)
                .where(comment.post.id.in(postIds))
                .fetch();

        queryMetrics.fetched(rows.size());
        return rows;
    }

    public List<AttachmentRow> findAttachments(List<Long> postIds) {
        List<AttachmentRow> rows = queryFactory
                .select(Projections.constructor(
                        AttachmentRow.class,
                        attachment.post.id,
                        attachment.id,
                        attachment.fileName,
                        attachment.byteSize))
                .from(attachment)
                .where(attachment.post.id.in(postIds))
                .fetch();

        queryMetrics.fetched(rows.size());
        return rows;
    }
}
