import { credentialRejectionError } from 'harper';
import { threadId } from 'node:worker_threads';

const M1 = 'https://auth1.lifecycle.test/.well-known/oauth-protected-resource/mcp';
const M2 = 'https://auth2.lifecycle.test/.well-known/oauth-protected-resource/mcp';
const V2_TIMEOUT_MS = 30_000;

let gate;
let openGate;
let pendingHolds = 0;
const calls = {};
function resetGate() {
	gate = new Promise((resolve) => {
		openGate = resolve;
	});
}
resetGate();

function makeValidator(prefix, { holds }) {
	return async (token, _request, signal) => {
		if (typeof token !== 'string' || !token.startsWith(prefix)) return undefined;
		calls[token] = (calls[token] ?? 0) + 1;
		const rest = token.slice(prefix.length);
		if (holds && (rest.startsWith('hold-good-') || rest === 'hold-bad')) {
			pendingHolds++;
			try {
				// the abort is Harper's validator deadline: a hold the suite never released still ends
				await new Promise((resolve) => {
					gate.then(resolve);
					signal?.addEventListener('abort', resolve, { once: true });
				});
			} finally {
				pendingHolds--;
			}
			if (rest === 'hold-bad') throw credentialRejectionError(`${prefix} validator refused after the hold`, 401);
			return {
				username: rest.slice('hold-good-'.length),
				authExpiresAt: Math.floor(Date.now() / 1000) + 600,
				authCacheable: false,
			};
		}
		if (rest === 'bad') throw credentialRejectionError(`${prefix} validator refused the token`, 401);
		if (rest === 'fault') throw new Error(`${prefix} validator fault`);
		if (rest.startsWith('good-'))
			return { username: rest.slice('good-'.length), authExpiresAt: Math.floor(Date.now() / 1000) + 600 };
		return undefined;
	};
}

server.registerBearerValidator(makeValidator('v1-', { holds: false }), { challenge: { resourceMetadata: M1 } });

function registerV2() {
	return server.registerBearerValidator(makeValidator('v2-', { holds: true }), {
		timeoutMs: V2_TIMEOUT_MS,
		challenge: { resourceMetadata: M2 },
	});
}
let unregisterV2 = registerV2();

function registerAfterV2() {
	return server.registerBearerValidator(async (token) => {
		if (token !== 'v2-hold-bad') return undefined;
		calls['after-v2'] = (calls['after-v2'] ?? 0) + 1;
		return { username: 'reader_one', authExpiresAt: Math.floor(Date.now() / 1000) + 600, authCacheable: false };
	});
}
let unregisterAfterV2;

function fail(status, message) {
	const error = new Error(message);
	error.statusCode = status;
	return error;
}

const actions = {
	'unregister-v2'() {
		if (!unregisterV2) throw fail(409, 'v2 is not registered');
		unregisterV2();
		unregisterV2 = undefined;
	},
	'register-v2'() {
		if (unregisterV2) throw fail(409, 'v2 is already registered');
		unregisterV2 = registerV2();
		// the chain runs in registration order: keep the validator that follows V2 behind it
		if (unregisterAfterV2) {
			unregisterAfterV2();
			unregisterAfterV2 = registerAfterV2();
		}
	},
	'register-after-v2'() {
		if (!unregisterV2 || unregisterAfterV2) throw fail(409, 'needs v2 registered and no validator after it');
		unregisterAfterV2 = registerAfterV2();
	},
	'unregister-after-v2'() {
		unregisterAfterV2?.();
		unregisterAfterV2 = undefined;
	},
	'open-gate'() {
		openGate();
	},
	'reset-gate'() {
		// releases a call an earlier test left held
		openGate();
		resetGate();
	},
	'state'() {},
};

export class LifecycleControl extends Resource {
	static loadAsInstance = false;
	async post(_target, data) {
		const context = this.getContext();
		if (context?.user?.role?.permission?.super_user !== true) throw fail(403, 'super user required');
		const action = actions[data?.action];
		if (!Object.hasOwn(actions, data?.action)) throw fail(400, `unknown action ${data?.action}`);
		action();
		return {
			v2Registered: Boolean(unregisterV2),
			afterV2Registered: Boolean(unregisterAfterV2),
			pendingHolds,
			calls,
			threadId,
		};
	}
}
