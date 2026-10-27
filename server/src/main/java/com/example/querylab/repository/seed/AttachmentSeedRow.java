package com.example.querylab.repository.seed;

import lombok.Value;

@Value
public class AttachmentSeedRow {

    long id;
    long postId;
    String fileName;
    long byteSize;
}
