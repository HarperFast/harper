import { isMainThread, threadId } from 'node:worker_threads';

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	async get() {
		return { threadId, isMainThread };
	}
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const operation = target.get('op');
		if (!operation) throw new Error("Probe requires an 'op' query parameter");
		const user = this.getContext()?.user;
		let result;
		try {
			result = { ok: true, result: await server.operation({ operation }, { user }, true) };
		} catch (error) {
			result = { ok: false, error: error.message, statusCode: error.statusCode };
		}
		return { threadId, isMainThread, username: user?.username ?? null, operation: result };
	}
}
