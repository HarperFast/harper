'use strict';

// libuv sizes its thread pool once, on first use, from UV_THREADPOOL_SIZE. The pool is
// process-global — every worker thread shares it — so its default of 4 caps concurrent native
// async work (HNSW searches, async fs, dns) for the whole process regardless of threads.count.
// availableParallelism() honors CPU affinity and the cgroup CPU quota, so a container is sized to
// its own share rather than the host's. A value already in the environment wins.
//
// This is its own module so that the entry point can import it first: under ESM a module's
// dependencies are evaluated before its own body, so the same assignment written inline in
// bin/harper.ts would run after every import below it — including the logger, which touches the
// filesystem.
import { availableParallelism } from 'node:os';

process.env.UV_THREADPOOL_SIZE ??= String(Math.min(1024, Math.max(4, availableParallelism())));
