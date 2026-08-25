// In workers, load awaits a completion that does not hold the event loop — modeling the
// unref'd-threadsafe-function wakes (rocksdb-js lock release / parked-commit retry) behind
// harper#2312.
import { isMainThread } from 'node:worker_threads';

if (!isMainThread) {
	await new Promise((resolve) => setTimeout(resolve, 2500).unref());
}

export class LivenessProbe extends Resource {
	async get() {
		return { alive: true };
	}
}
