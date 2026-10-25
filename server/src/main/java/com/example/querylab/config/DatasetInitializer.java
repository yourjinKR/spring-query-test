package com.example.querylab.config;

import com.example.querylab.dto.dataset.DatasetStatus;
import com.example.querylab.dto.dataset.SeedConfig;
import com.example.querylab.service.DatasetService;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class DatasetInitializer implements ApplicationRunner {

    private final DatasetService datasetService;
    private final LabProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        DatasetStatus status = datasetService.status();
        if (properties.isSeedOnStartup() && status.getPostCount() == 0) {
            datasetService.replace(SeedConfig.defaults());
        }
    }
}
