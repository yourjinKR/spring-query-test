package com.example.querylab.controller;

import com.example.querylab.dto.post.PostsResponse;
import com.example.querylab.service.PostService;
import java.util.Arrays;
import java.util.List;
import java.util.stream.LongStream;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class PostController {

    private static final int DEFAULT_POST_COUNT = 50;
    private static final int MAX_REQUESTED_IDS = 100;

    private final PostService postService;

    @GetMapping("/v1/posts")
    public PostsResponse getPostsV1(
            @RequestParam(name = "ids", required = false) String ids,
            @RequestParam(name = "mode", defaultValue = "analysis") String mode) {
        return postService.findWithSingleQuery(parseIds(ids), includeSql(mode));
    }

    @GetMapping("/v2/posts")
    public PostsResponse getPostsV2(
            @RequestParam(name = "ids", required = false) String ids,
            @RequestParam(name = "mode", defaultValue = "analysis") String mode) {
        return postService.findWithSplitQueries(parseIds(ids), includeSql(mode));
    }

    static List<Long> parseIds(String input) {
        if (input == null) {
            return LongStream.rangeClosed(1, DEFAULT_POST_COUNT).boxed().toList();
        }
        if (input.isBlank()) {
            throw new IllegalArgumentException("ids must contain 1 to 100 positive integers");
        }

        String[] tokens = input.split(",", -1);
        if (tokens.length > MAX_REQUESTED_IDS) {
            throw new IllegalArgumentException("ids accepts at most 100 values");
        }

        try {
            List<Long> ids = Arrays.stream(tokens)
                    .map(String::trim)
                    .map(Long::parseLong)
                    .distinct()
                    .sorted()
                    .toList();

            if (ids.stream().anyMatch(id -> id <= 0)) {
                throw new IllegalArgumentException("ids must be positive integers");
            }
            return ids;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("ids must be comma-separated positive integers");
        }
    }

    private boolean includeSql(String mode) {
        return switch (mode) {
            case "analysis" -> true;
            case "benchmark" -> false;
            default -> throw new IllegalArgumentException("mode must be analysis or benchmark");
        };
    }
}
