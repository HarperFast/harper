// subscribe (SSE / WebSocket) is authorized as 'read' (resources/Resource.ts:362), so allowRead gates all three surfaces
export class AnyPrincipalSecret extends tables.Secret {
	allowRead(user) {
		return Boolean(user);
	}
}

// probe for the server.onInvalidatedUser hook the PR resets failedCredentials on (security/auth.ts:101-106)
let invalidations = 0;
server.onInvalidatedUser(() => invalidations++);
export class InvalidationProbe extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	allowCreate() {
		return true;
	}
	get() {
		return { invalidations };
	}
	post() {
		server.invalidateUser();
		return { invalidations };
	}
}
