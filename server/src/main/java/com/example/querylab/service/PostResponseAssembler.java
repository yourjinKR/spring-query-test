package com.example.querylab.service;

import com.example.querylab.dto.post.AttachmentDto;
import com.example.querylab.dto.post.CommentDto;
import com.example.querylab.dto.post.PostDto;
import com.example.querylab.repository.projection.AttachmentRow;
import com.example.querylab.repository.projection.CommentRow;
import com.example.querylab.repository.projection.JoinedPostRow;
import com.example.querylab.repository.projection.PostRow;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** Builds the same sorted response from either query strategy. */
@Component
public class PostResponseAssembler {

    public List<PostDto> fromJoinedRows(List<JoinedPostRow> rows) {
        Map<Long, PostAccumulator> posts = new TreeMap<>();

        for (JoinedPostRow row : rows) {
            PostAccumulator post = posts.computeIfAbsent(
                    row.getPostId(),
                    postId -> new PostAccumulator(postId, row.getTitle(), row.getBody()));

            if (row.getCommentId() != null) {
                post.comments.putIfAbsent(
                        row.getCommentId(),
                        new CommentDto(row.getCommentId(), row.getCommentContent()));
            }
            if (row.getAttachmentId() != null) {
                post.attachments.putIfAbsent(
                        row.getAttachmentId(),
                        new AttachmentDto(row.getAttachmentId(), row.getFileName(), row.getByteSize()));
            }
        }

        return toResponse(posts);
    }

    public List<PostDto> fromSplitRows(
            List<PostRow> postRows,
            List<CommentRow> commentRows,
            List<AttachmentRow> attachmentRows) {
        Map<Long, PostAccumulator> posts = new TreeMap<>();

        for (PostRow row : postRows) {
            posts.put(row.getId(), new PostAccumulator(row.getId(), row.getTitle(), row.getBody()));
        }
        for (CommentRow row : commentRows) {
            PostAccumulator post = posts.get(row.getPostId());
            if (post != null) {
                post.comments.put(row.getId(), new CommentDto(row.getId(), row.getContent()));
            }
        }
        for (AttachmentRow row : attachmentRows) {
            PostAccumulator post = posts.get(row.getPostId());
            if (post != null) {
                post.attachments.put(
                        row.getId(),
                        new AttachmentDto(row.getId(), row.getFileName(), row.getByteSize()));
            }
        }

        return toResponse(posts);
    }

    private List<PostDto> toResponse(Map<Long, PostAccumulator> posts) {
        return posts.values().stream()
                .map(PostAccumulator::toDto)
                .toList();
    }

    @RequiredArgsConstructor
    private static class PostAccumulator {

        private final long id;
        private final String title;
        private final String body;
        private final Map<Long, CommentDto> comments = new TreeMap<>();
        private final Map<Long, AttachmentDto> attachments = new TreeMap<>();

        private PostDto toDto() {
            return new PostDto(
                    id,
                    title,
                    body,
                    List.copyOf(comments.values()),
                    List.copyOf(attachments.values()));
        }
    }
}
