package com.example.querylab.service;

import com.example.querylab.domain.QueryStrategy;
import com.example.querylab.dto.post.PostsResponse;
import com.example.querylab.metrics.PostQueryObserver;
import com.example.querylab.repository.PostQueryRepository;
import com.example.querylab.repository.projection.AttachmentRow;
import com.example.querylab.repository.projection.CommentRow;
import com.example.querylab.repository.projection.JoinedPostRow;
import com.example.querylab.repository.projection.PostRow;
import com.example.querylab.support.experiment.LabTransactionLock;
import com.example.querylab.support.experiment.ResultSizeGuard;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class PostService {

    private final PostQueryRepository postQueryRepository;
    private final PostResponseAssembler postResponseAssembler;
    private final PostQueryObserver postQueryObserver;
    private final LabTransactionLock labTransactionLock;
    private final ResultSizeGuard resultSizeGuard;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PostsResponse findWithSingleQuery(List<Long> postIds, boolean includeSql) {
        labTransactionLock.acquireReadLock();
        resultSizeGuard.validate(postIds, QueryStrategy.SINGLE_JOIN);

        return postQueryObserver.observe(QueryStrategy.SINGLE_JOIN, includeSql, () -> {
            List<JoinedPostRow> rows = postQueryRepository.findJoinedPosts(postIds);
            return postQueryObserver.assemble(() -> postResponseAssembler.fromJoinedRows(rows));
        });
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PostsResponse findWithSplitQueries(List<Long> postIds, boolean includeSql) {
        labTransactionLock.acquireReadLock();
        resultSizeGuard.validate(postIds, QueryStrategy.SPLIT_QUERIES);

        return postQueryObserver.observe(QueryStrategy.SPLIT_QUERIES, includeSql, () -> {
            List<PostRow> posts = postQueryRepository.findPosts(postIds);
            List<CommentRow> comments = postQueryRepository.findComments(postIds);
            List<AttachmentRow> attachments = postQueryRepository.findAttachments(postIds);

            return postQueryObserver.assemble(
                    () -> postResponseAssembler.fromSplitRows(posts, comments, attachments));
        });
    }
}
