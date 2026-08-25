// Component load in a worker awaits a completion that does not hold the event loop —
// modeling a dependency wakeup delivered through an unref'd handle (the CI trigger is
// rocksdb-js's cross-thread lock-release / parked-commit-retry wake, delivered through an
// unref'd threadsafe function during concurrent multi-worker startup). A pre-ready worker
// awaiting such a completion must stay alive until the ready handshake instead of
// clean-exiting with code 0 when its ref'd-handle set drains.
import { isMainThread } from 'node:worker_threads';

if (!isMainThread) {
	await new Promise((resolve) => setTimeout(resolve, 2500).unref());
}

export class LivenessProbe extends Resource {
	async get() {
		return { alive: true };
	}
}
