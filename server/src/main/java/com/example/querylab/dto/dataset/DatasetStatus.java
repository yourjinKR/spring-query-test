package com.example.querylab.dto.dataset;

import lombok.Value;

@Value
public class DatasetStatus {
    long postCount;
    long commentCount;
    long attachmentCount;
    SeedConfig config;
}
