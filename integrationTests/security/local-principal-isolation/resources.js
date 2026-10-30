import { threadId } from 'node:worker_threads';

class Open extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
}

export class WhoAmI extends Open {
	get() {
		const context = this.getContext();
		const user = context?.user;
		return {
			threadId,
			username: user?.username ?? null,
			superUser: user?.role?.permission?.super_user === true,
			localMarker: user?._localPrincipal === true,
			ip: context?.ip ?? null,
		};
	}
}

async function store(context, user) {
	const updated = { user };
	await context.session.update(updated);
	return { threadId, sessionId: updated.id, userKeySurvived: 'user' in updated, user: updated.user ?? null };
}

export class SessionStore extends Open {
	get() {
		const context = this.getContext();
		return store(context, context.user);
	}
}

export class SessionStoreSpread extends Open {
	get() {
		const context = this.getContext();
		return store(context, { ...context.user });
	}
}

export class SessionStoreName extends Open {
	get() {
		const context = this.getContext();
		return store(context, context.user?.username);
	}
}

export class SessionRows extends Open {
	async get() {
		if (this.getContext()?.user?.role?.permission?.super_user !== true) {
			throw Object.assign(new Error('super user only'), { statusCode: 403 });
		}
		const rows = [];
		for await (const record of databases.system.hdb_session.search({})) rows.push(JSON.parse(JSON.stringify(record)));
		return rows;
	}
}
