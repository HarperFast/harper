// In workers, load awaits a completion that does not hold the event loop — modeling the
// unref'd-threadsafe-function wakes (rocksdb-js lock release / parked-commit retry) behind
// harper#2312.
import { isMainThread } from 'node:worker_threads';

// Declared before the await: Bun's loader reads the module namespace while evaluation is
// suspended at the top-level await, and a class declared after it would still be in its TDZ.
export class LivenessProbe extends Resource {
	async get() {
		return { alive: true };
	}
}

if (!isMainThread) {
	await new Promise((resolve) => setTimeout(resolve, 2500).unref());
}
