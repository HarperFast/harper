import { isMainThread, threadId, workerData } from 'node:worker_threads';

export class Runtime extends Resource {
	get() {
		return { isMainThread, threadId, workerIndex: workerData?.workerIndex, noServerStart: !!workerData?.noServerStart };
	}
}

export class BigNumber extends Resource {
	get() {
		return { value: 9007199254740993n };
	}
}

export class BuiltinCheck extends Resource {
	async get() {
		const fs = await import('node:fs');
		return typeof fs.readFile;
	}
}
