package com.example.querylab.support.experiment;

import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Coordinates this single lab instance; unlocks only after the owning transaction completes. */
@Component
public class LabTransactionLock {

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);

    public void acquireReadLock() {
        acquireUntilTransactionCompletes(lock.readLock());
    }

    public void acquireWriteLock() {
        acquireUntilTransactionCompletes(lock.writeLock());
    }

    private void acquireUntilTransactionCompletes(Lock requestedLock) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()
                || !TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException("Lab locks require a service transaction");
        }

        requestedLock.lock();
        boolean registered = false;
        try {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCompletion(int status) {
                    requestedLock.unlock();
                }
            });
            registered = true;
        } finally {
            if (!registered) {
                requestedLock.unlock();
            }
        }
    }
}
