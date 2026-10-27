package com.example.querylab.dto.metrics;

import lombok.Value;

@Value
public class QueryMetric {
    String sql;
    double elapsedMs;
    long rows;
}
