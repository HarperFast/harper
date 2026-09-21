'use strict';

// libuv sizes its thread pool once, on first use, from UV_THREADPOOL_SIZE. That pool is
// process-global — every worker thread shares it — so it bounds how many native async tasks
// (HNSW searches, async fs, dns) can run at once for the whole process, and its default of 4 does
// so regardless of threads.count. Size it to the machine; a value already in the environment wins.
//
// This is its own module, imported first by the entry point, because a module's dependencies are
// evaluated before its own body under ESM: written inline at the top of bin/harper.ts the
// assignment ran *after* every import below it — including the logger, which touches the
// filesystem — whenever that file loads as ESM (the type-stripped dev/test path). A
// first-position side-effect import is evaluated before the imports that follow it under both ESM
// and the CommonJS `tsc` emits for the shipped `dist/bin/harper.js`.
import { availableParallelism } from 'node:os';

process.env.UV_THREADPOOL_SIZE ??= String(Math.min(1024, Math.max(4, availableParallelism())));
