package com.example.querylab.metrics;

import com.example.querylab.domain.QueryStrategy;
import com.example.querylab.dto.post.PostDto;
import com.example.querylab.dto.post.PostsResponse;
import java.util.List;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** Keeps the experiment's timing lifecycle separate from query orchestration. */
@Component
@RequiredArgsConstructor
public class PostQueryObserver {

    private final QueryMetrics metrics;

    public PostsResponse observe(QueryStrategy strategy, boolean includeSql,
                                 Supplier<List<PostDto>> action) {
        metrics.begin(includeSql);
        long startedNanos = System.nanoTime();

        try {
            List<PostDto> posts = action.get();
            return new PostsResponse(strategy, posts, metrics.snapshot(startedNanos));
        } finally {
            metrics.clear();
        }
    }

    public List<PostDto> assemble(Supplier<List<PostDto>> action) {
        long startedNanos = System.nanoTime();
        try {
            return action.get();
        } finally {
            metrics.assembled(System.nanoTime() - startedNanos);
        }
    }
}
