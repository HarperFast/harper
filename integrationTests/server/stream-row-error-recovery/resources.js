import { threadId } from 'node:worker_threads';

export class Probe extends Resource {
	static loadAsInstance = false;
	get() {
		return { threadId, observed: globalThis.rowErrorsObserved ?? [] };
	}
}
