package com.example.querylab.repository.projection;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public class AttachmentRow {

    private final Long postId;
    private final Long id;
    private final String fileName;
    private final Long byteSize;
}
