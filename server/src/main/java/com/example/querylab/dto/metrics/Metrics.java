package com.example.querylab.dto.metrics;

import java.util.List;
import lombok.Value;

@Value
public class Metrics {
    int queryCount;
    long totalRows;
    double fetchAndAssembleMs;
    double jdbcExecuteMs;
    double assemblyMs;
    List<QueryMetric> queries;
}
