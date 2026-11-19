// QA-519 — end-to-end verification of the shutdown-drain mechanism
// (components/shutdownDrain.ts, commit 9018760e4, PR #1621).
//
// The shipped unit tests (unitTests/components/shutdownDrain.test.js) only exercise the pure
// functions with fake drain objects — never a real worker, a real SHUTDOWN, or real in-flight
// work. This fixture registers a REAL ShutdownDrain inside an actual HTTP worker thread and
// gives the test a way to observe, via a marker file, exactly when the worker's simulated
// in-flight task finished relative to when the worker itself exited.
//
// To register into the SAME per-worker `drains` registry that
// `server/threads/threadServer.js` reads from (module state there is a plain in-memory `Set`,
// naturally scoped per worker thread — see the doc comment on shutdownDrain.ts), this file must
// land in Node's REAL native CJS `require` cache, not Harper's sandboxed VM module loader's
// private per-component cache (which would produce an isolated copy of the module with its own
// empty `Set`). `createRequire(import.meta.url)` escapes the sandbox for exactly this file,
// giving a genuine native `require` bound to this file's real location; requiring the absolute
// path to the compiled `dist/components/shutdownDrain.js` through it resolves to the exact same
// cache entry `threadServer.js` itself populated at boot.
import { createRequire } from 'node:module';
import { threadId } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';

const nativeRequire = createRequire(import.meta.url);
const { registerShutdownDrain } = nativeRequire(process.env.QA519_SHUTDOWN_DRAIN_ABS_PATH);

const MARKER_FILE = process.env.QA519_MARKER_FILE;
const parsedTaskDelay = Number(process.env.QA519_TASK_DELAY_MS);
const TASK_DELAY_MS = Number.isInteger(parsedTaskDelay) && parsedTaskDelay > 0 ? parsedTaskDelay : 2500;

function log(tag) {
	try {
		appendFileSync(MARKER_FILE, `${tag} t=${Date.now()} pid=${process.pid} tid=${threadId}\n`);
	} catch {
		// best effort — a lost log line just weakens the test's evidence, not worth crashing over
	}
}

let taskDone = false;
let stallMode = false;
let taskPromise = null;

function startTask(stall) {
	taskDone = false;
	stallMode = !!stall;
	log(stall ? 'B_START' : 'A_START');
	if (stall) {
		// Simulates a hung/stuck operation: never resolves on its own. hasWork() keeps reporting
		// true forever, so the ONLY way this worker can exit is the drain ceiling's force-kill
		// (runShutdownDrains' own deadline race abandoning this drain), not this promise settling.
		taskPromise = new Promise(() => {});
	} else {
		taskPromise = new Promise((resolve) => {
			setTimeout(() => {
				taskDone = true;
				log('A_DONE');
				resolve();
			}, TASK_DELAY_MS);
		});
	}
}

registerShutdownDrain({
	hasWork() {
		return stallMode ? true : taskPromise !== null && !taskDone;
	},
	async drain() {
		log(stallMode ? 'B_DRAIN_ENTER' : 'A_DRAIN_ENTER');
		await taskPromise;
		// Only reached if taskPromise actually settles before runShutdownDrains' own deadline
		// race abandons it — never true in stall mode (taskPromise there never resolves).
		log(stallMode ? 'B_DRAIN_EXIT_UNEXPECTED' : 'A_DRAIN_EXIT');
	},
});

// Fires synchronously as part of realExit()/process.exit() — the last thing this worker does.
process.on('exit', () => {
	log(stallMode ? 'B_EXIT' : 'A_EXIT');
});

export class TaskProbe extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const action = query && query.get ? query.get('action') : undefined;
		if (action === 'start') {
			startTask(false);
			return { started: true, mode: 'normal', delayMs: TASK_DELAY_MS, pid: process.pid, tid: threadId };
		}
		if (action === 'start-stall') {
			startTask(true);
			return { started: true, mode: 'stall', pid: process.pid, tid: threadId };
		}
		return { taskDone, stallMode, pid: process.pid, tid: threadId };
	}
}
