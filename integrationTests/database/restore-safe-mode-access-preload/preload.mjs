import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

if (!process.env.RESTORE_SAFE_MODE_PRELOAD_OUT)
	throw new Error('restore-safe-mode-access preload: RESTORE_SAFE_MODE_PRELOAD_OUT is not set');
appendFileSync(
	process.env.RESTORE_SAFE_MODE_PRELOAD_OUT,
	`import:${process.pid}:${threadId}:${process.env.HARPER_SAFE_MODE ?? 'unset'}\n`
);
