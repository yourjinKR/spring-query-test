package com.example.querylab.repository.projection;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public class CommentRow {

    private final Long postId;
    private final Long id;
    private final String content;
}
