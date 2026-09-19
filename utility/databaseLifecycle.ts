'use strict';

// Destructive schema changes and worker teardown both wait on native database handles. Keep one
// bounded quiescence budget so a shorter generic thread timeout cannot interrupt either barrier.
export const DATABASE_QUIESCENCE_TIMEOUT_MS = 10 * 60_000;
