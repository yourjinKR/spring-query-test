package com.example.querylab.dto.post;

import com.example.querylab.domain.QueryStrategy;
import com.example.querylab.dto.metrics.Metrics;
import java.util.List;
import lombok.Value;

@Value
public class PostsResponse {
    QueryStrategy strategy;
    List<PostDto> posts;
    Metrics metrics;
}
