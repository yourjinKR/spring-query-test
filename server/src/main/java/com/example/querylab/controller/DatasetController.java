package com.example.querylab.controller;

import com.example.querylab.dto.dataset.DatasetStatus;
import com.example.querylab.dto.dataset.SeedConfig;
import com.example.querylab.service.DatasetService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/lab/dataset")
@RequiredArgsConstructor
public class DatasetController {

    private final DatasetService datasetService;

    @GetMapping
    public DatasetStatus getDataset() {
        return datasetService.status();
    }

    @PostMapping
    public DatasetStatus replaceDataset(@Valid @RequestBody SeedConfig config) {
        return datasetService.replace(config);
    }
}
