package com.example.querylab.dto.post;

import lombok.Value;

@Value
public class AttachmentDto {
    long id;
    String fileName;
    long byteSize;
}
