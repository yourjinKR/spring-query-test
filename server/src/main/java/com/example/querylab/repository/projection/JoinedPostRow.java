package com.example.querylab.repository.projection;

import lombok.AllArgsConstructor;
import lombok.Getter;

/** One flat row returned by the post/comment/attachment LEFT JOIN. */
@Getter
@AllArgsConstructor
public class JoinedPostRow {

    private final Long postId;
    private final String title;
    private final String body;
    private final Long commentId;
    private final String commentContent;
    private final Long attachmentId;
    private final String fileName;
    private final Long byteSize;
}
