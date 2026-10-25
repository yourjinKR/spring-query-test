package com.example.querylab.dto.dataset;

import com.example.querylab.domain.Distribution;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.EqualsAndHashCode;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode
@Builder
public class SeedConfig {
    @Min(1)
    @Max(10_000)
    private int postCount;

    @Min(0)
    @Max(200)
    private int commentsPerPost;

    @Min(0)
    @Max(100)
    private int attachmentsPerPost;

    @Min(0)
    @Max(16_384)
    private int bodyBytes;

    private long seed;

    @NotNull
    private Distribution distribution;

    public static SeedConfig defaults() {
        return new SeedConfig(200, 20, 5, 1_024, 42, Distribution.UNIFORM);
    }

    public int childCount(int base, long postId) {
        if (distribution == Distribution.SKEWED) {
            return postId % 10 == 0 ? base * 10 : 0;
        }
        return base;
    }
}
