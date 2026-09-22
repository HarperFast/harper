# resources/scheduler/ — Design notes

The built-in scheduler plugin.

**Read this when:** touching job leadership, leases or heartbeats.

Index of every design note: [DESIGN.md](../../DESIGN.md).

---

## Scheduler: cluster-once execution without a consensus primitive (`resources/scheduler/`)

The built-in `scheduler` plugin (#951) runs config-declared jobs "exactly once per cluster." The
non-obvious part is what Harper's substrate does and does not offer for that:

- **There is no election, consensus, or cross-node CAS anywhere in harper/harper-pro.** Replication
  converges concurrent writes by record version (LWW). A lease acquired with a plain `put` therefore
  cannot be race-free by construction — two nodes writing the lease both succeed locally and
  converge later. The engine's design accepts this: sticky leadership (a starter defers to a fresh
  heartbeat), a heartbeat takeover check (a leader seeing a fresher foreign heartbeat steps down),
  and documented handler idempotency are the mechanisms that ride out transient dual-leadership.
  Do not "fix" the race with a conditional write — the primitive does not exist.
- The lease + per-job run state live in the replicating system table `hdb_scheduler_state`
  (`audit: true` because system-table replication requires auditing; name chosen because `hdb_job`
  is taken by the legacy jobs subsystem). On constrained/directional replication topologies the
  lease may not reach every node; that limitation is inherent.
- The alphabetical node-name tie-break deliberately mirrors replication's deterministic failover
  convention (sorted node names in `subscriptionManager.ts`); the escalation ladder
  (`promotionWaitMs`) exists because a dead alphabetically-first node must not deadlock a
  leaderless cluster (each successive node waits one more `2 × watcher interval` rung).
- Thread-once vs cluster-once are separate layers: `getWorkerIndex() === 0` gates to one worker per
  node (correct in every threading mode incl. `threads: 0`); the lease gates across nodes.
  `handleApplication` holds a cross-thread load lock with a 30s timeout, so the plugin only
  registers there — election, scheduling, and catch-up run async after.
- Catch-up fires at most ONE missed occurrence per cron job, and a new job's `firstSeenAt` baseline
  prevents firing immediately on first deploy. Interval jobs are excluded from the sweep — they
  self-correct by anchoring to their persisted last run in `scheduleNextRun`.
- Timer firing is a deliberately thin `setTimeout` layer so the durable timer service (#754) can
  replace it without touching the config surface, election, or catch-up. Timing thresholds are
  env-overridable (`HARPER_SCHEDULER_*`) so multi-node tests can exercise failover in seconds.
