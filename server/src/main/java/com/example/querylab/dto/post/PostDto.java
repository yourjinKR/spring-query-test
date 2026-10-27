package com.example.querylab.dto.post;

import java.util.List;
import lombok.Value;

@Value
public class PostDto {
    long id;
    String title;
    String body;
    List<CommentDto> comments;
    List<AttachmentDto> attachments;
}
