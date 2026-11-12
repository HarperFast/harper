export class AnyPrincipalSecret extends tables.Secret {
	allowRead(user) {
		return Boolean(user);
	}
	allowCreate(user) {
		return Boolean(user);
	}
}

export class StaticGateSecret extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	get() {
		const user = this.getContext()?.user;
		if (!user) {
			const error = new Error('Unauthorized');
			error.statusCode = 401;
			throw error;
		}
		return { username: user?.username ?? null, type: typeof user };
	}
}

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	get() {
		const user = this.getContext()?.user;
		return {
			type: typeof user,
			username: user?.username ?? null,
			value: typeof user === 'string' ? user : null,
		};
	}
}
