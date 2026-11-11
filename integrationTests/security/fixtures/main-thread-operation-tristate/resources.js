// SQA-181: worker-side surfaces for the main-only operations registered in main.js.
import { isMainThread, threadId } from 'node:worker_threads';

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	async get() {
		return { threadId, isMainThread };
	}
}

// server.operation(body, { user }, authorize) as the request's own authenticated principal.
export class Probe extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const operation = target.get('op');
		if (!operation) throw new Error("Probe requires an 'op' query parameter");
		const authorizeParam = target.get('authorize');
		if (authorizeParam !== 'true' && authorizeParam !== 'false') throw new Error('Probe requires authorize=true|false');
		const authorize = authorizeParam === 'true';
		const user = this.getContext()?.user;
		let result;
		try {
			const value = await server.operation({ operation }, { user }, authorize);
			result = { ok: true, result: value };
		} catch (error) {
			result = { ok: false, error: error.message, statusCode: error.statusCode };
		}
		return { threadId, isMainThread, username: user?.username ?? null, operation: result };
	}
}
