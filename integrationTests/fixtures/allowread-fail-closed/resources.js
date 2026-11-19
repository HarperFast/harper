// Fail-closed enforcement when an allow* hook throws/rejects (#1422 gap 1).
//
// allowRead is a *grant* hook layered over the default RBAC: it can widen access, and the
// built-in implementation defers to role/table permissions. The security property under test
// is that a hook which throws (sync) or rejects (async) must FAIL CLOSED — the request is
// denied rather than proceeding as if authorization was granted.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

// Grants read to any authenticated user — the happy path that must keep working after the
// fail-closed wrapping.
export class Allowed extends tables.Allowed {
	allowRead() {
		return true;
	}
	allowCreate(user) {
		return isSuper(user);
	}
	allowUpdate(user) {
		return isSuper(user);
	}
	allowDelete(user) {
		return isSuper(user);
	}
}

// allowRead throws synchronously for non-super users. Before the fix the exception was
// swallowed upstream and the request proceeded (fail open); it must now fail closed.
export class Throws extends tables.Throws {
	allowRead(user) {
		if (isSuper(user)) return true;
		throw new Error('allowRead intentionally throws (#1422 gap 1)');
	}
	allowCreate(user) {
		return isSuper(user);
	}
	allowUpdate(user) {
		return isSuper(user);
	}
	allowDelete(user) {
		return isSuper(user);
	}
}

// allowRead rejects asynchronously for non-super users — exercises the async rejection
// handler on the transactional path, which must also fail closed.
export class ThrowsAsync extends tables.ThrowsAsync {
	async allowRead(user) {
		if (isSuper(user)) return true;
		throw new Error('async allowRead intentionally rejects (#1422 gap 1)');
	}
	allowCreate(user) {
		return isSuper(user);
	}
	allowUpdate(user) {
		return isSuper(user);
	}
	allowDelete(user) {
		return isSuper(user);
	}
}
