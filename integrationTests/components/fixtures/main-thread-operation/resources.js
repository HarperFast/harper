/**
 * Fixture for #4134: a component on a worker thread calls, in-process, an operation that only the
 * main thread registered (the built-in agent's).
 */
import { isMainThread, threadId } from 'node:worker_threads';

async function attempt(body, context, authorize) {
	try {
		return { ok: true, result: await server.operation(body, context, authorize) };
	} catch (error) {
		return { ok: false, error: error.message, statusCode: error.statusCode };
	}
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		const user = this.getContext()?.user;
		return {
			threadId,
			isMainThread,
			builtin: await attempt({ operation: 'registration_info' }, { user }, true),
			agent: await attempt({ operation: 'get_agent_config' }, { user }, true),
			unauthorized: await attempt({ operation: 'get_agent_config' }, {}, false),
			unknown: await attempt({ operation: 'definitely_not_registered_anywhere' }, { user }, true),
		};
	}
}

// Runs the agent operation as the user named by the id, with authorization on.
export class ProbeAs extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const user = await server.getUser(String(target.id));
		return { agent: await attempt({ operation: 'get_agent_config' }, { user }, true) };
	}
}
