package com.example.querylab.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;

import com.example.querylab.service.PostService;
import java.util.List;
import org.junit.jupiter.api.Test;

class PostControllerTest {

    @Test
    void parsesDefaultsAndSortsDeduplicatedIds() {
        assertThat(PostController.parseIds(null)).hasSize(50).startsWith(1L, 2L).endsWith(50L);
        assertThat(PostController.parseIds("3, 1,3,2")).containsExactly(1L, 2L, 3L);
    }

    @Test
    void rejectsMalformedZeroNegativeAndOversizedIds() {
        List<String> invalidIds = List.of("", " ", "0", "-1", "1,", "abc", "1.5",
                "9999999999999999999999999", "1,".repeat(100) + "1");

        for (String input : invalidIds) {
            assertThatThrownBy(() -> PostController.parseIds(input))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void routesVersionsAndValidatesModeBeforeQuerying() {
        PostService postService = mock(PostService.class);
        PostController controller = new PostController(postService);

        controller.getPostsV1("2,1", "analysis");
        controller.getPostsV2("1,2", "benchmark");

        verify(postService).findWithSingleQuery(List.of(1L, 2L), true);
        verify(postService).findWithSplitQueries(List.of(1L, 2L), false);
        assertThatThrownBy(() -> controller.getPostsV1("1", "invalid"))
                .isInstanceOf(IllegalArgumentException.class);
        verifyNoMoreInteractions(postService);
    }
}
