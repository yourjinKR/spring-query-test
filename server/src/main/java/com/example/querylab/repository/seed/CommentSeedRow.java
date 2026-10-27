package com.example.querylab.repository.seed;

import lombok.Value;

@Value
public class CommentSeedRow {

    long id;
    long postId;
    String content;
}
