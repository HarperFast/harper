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

let activeSend = false;
let messagesProduced = 0;

export class SendPressure extends Resource {
	get() {
		return { active: activeSend, produced: messagesProduced, threadId };
	}

	async *subscribe() {
		activeSend = true;
		messagesProduced = 0;
		try {
			const value = 'x'.repeat(512 * 1024);
			for (let id = 0; id < 128; id++) {
				messagesProduced++;
				yield { id, value, threadId };
			}
		} finally {
			activeSend = false;
		}
	}
}

let releaseConnect;
let delayedQueue;
let disconnectedBeforeConnect = false;

export class DelayedConnect extends Resource {
	async connect(incomingMessages) {
		delayedQueue = super.subscribe();
		disconnectedBeforeConnect = false;
		incomingMessages.once('close', () => {
			disconnectedBeforeConnect = true;
		});
		await new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		return delayedQueue;
	}

	get() {
		return {
			awaiting: !!releaseConnect,
			disconnected: disconnectedBeforeConnect,
			closed: delayedQueue?.closed,
			threadId,
		};
	}

	post() {
		releaseConnect?.();
		releaseConnect = undefined;
		return { released: true };
	}
}
