import { isMainThread, threadId } from 'node:worker_threads';

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	async get() {
		return { threadId, isMainThread };
	}
}

const LIMITED_USERNAME = 'main_thread_op_limited';

export class Probe extends Resource {
	static loadAsInstance = false;
	async get(target) {
		const operation = target.get('op');
		if (!operation) throw new Error("Probe requires an 'op' query parameter");
		const body = { operation };
		const impersonate = target.get('impersonate');
		if (impersonate === 'username') body.impersonate = { username: LIMITED_USERNAME };
		else if (impersonate) throw new Error(`unknown impersonate form '${impersonate}'`);
		const user = this.getContext()?.user;
		let result;
		try {
			result = { ok: true, result: summarize(await server.operation(body, { user }, true)) };
		} catch (error) {
			result = { ok: false, error: error.message, statusCode: error.statusCode };
		}
		return {
			threadId,
			isMainThread,
			username: user?.username ?? null,
			scopedToken: user?._scopedToken === true,
			operation: result,
		};
	}
}

function summarize(value) {
	if (value && typeof value === 'object' && typeof value.username === 'string' && 'role' in value) {
		return {
			username: value.username,
			superUser: value.role?.permission?.super_user === true,
			impersonated: value._impersonated === true,
		};
	}
	return value;
}

// A component's own principal view: usernames starting with `ovr-` have no hdb_user row. Two shapes
// probe the structured-clone boundary of the forward: `ovr-proto` keeps super_user on the prototype
// of role.permission; `ovr-fn` carries an own function property.
const OVERRIDE_PASSWORD = 'Override-pw!2026';
class PrototypeSuperPermission {
	constructor() {
		this.shape = 'prototype-super_user';
	}
	get super_user() {
		return true;
	}
}
function overrideUser(username) {
	switch (username) {
		case 'ovr-limited':
			return {
				username,
				active: true,
				role: { role: 'ovr_limited', id: 'ovr_limited', permission: { super_user: false } },
			};
		case 'ovr-super':
			return { username, active: true, role: { role: 'ovr_super', id: 'ovr_super', permission: { super_user: true } } };
		case 'ovr-proto':
			return {
				username,
				active: true,
				role: { role: 'ovr_proto', id: 'ovr_proto', permission: new PrototypeSuperPermission() },
			};
		case 'ovr-fn': {
			const user = { username, active: true, role: { role: 'ovr_fn', id: 'ovr_fn', permission: { super_user: true } } };
			user.describe = () => username;
			return user;
		}
		default:
			return undefined;
	}
}
const coreGetUser = server.getUser;
server.getUser = async function (username, password, request) {
	if (typeof username === 'string' && username.startsWith('ovr-')) {
		const user = overrideUser(username);
		if (!user || password !== OVERRIDE_PASSWORD) throw new Error('invalid override credentials');
		return user;
	}
	return coreGetUser.call(this, username, password, request);
};
