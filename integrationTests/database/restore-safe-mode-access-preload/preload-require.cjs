const { appendFileSync } = require('node:fs');
const { threadId } = require('node:worker_threads');

if (!process.env.RESTORE_SAFE_MODE_PRELOAD_OUT)
	throw new Error('restore-safe-mode-access preloadRequire: RESTORE_SAFE_MODE_PRELOAD_OUT is not set');
appendFileSync(
	process.env.RESTORE_SAFE_MODE_PRELOAD_OUT,
	`require:${process.pid}:${threadId}:${process.env.HARPER_SAFE_MODE ?? 'unset'}\n`
);
