package com.example.querylab.support.experiment;

import com.example.querylab.dto.dataset.SeedConfig;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Published only after commit so failed seed operations cannot change request size estimates. */
@Component
public class DatasetMetadata {

    private volatile SeedConfig currentConfig;

    public SeedConfig getCurrentConfig() {
        return copy(currentConfig);
    }

    public void updateAfterCommit(SeedConfig config) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException("Dataset metadata requires a service transaction");
        }

        SeedConfig snapshot = copy(config);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                currentConfig = snapshot;
            }
        });
    }

    private SeedConfig copy(SeedConfig config) {
        if (config == null) {
            return null;
        }
        return new SeedConfig(config.getPostCount(), config.getCommentsPerPost(),
                config.getAttachmentsPerPost(), config.getBodyBytes(), config.getSeed(),
                config.getDistribution());
    }
}
