// Regression fixture for #1419 — per-row allowRead must filter subscription delivery.
//
// allowRead is designed so that:
//   - When `this` is a loaded record (a specific row), allow only if the row's owner
//     matches the requesting user.
//   - When `this` is the collection (no specific record loaded, this.owner undefined/null),
//     allow the subscription to open. This is the permissive side that lets a non-owner open
//     a whole-table subscription — the scenario where the pre-#1419 delivery loop leaked every
//     row's events because it never re-evaluated allowRead per record.
//
// Super users always pass so that seed writes and setup ops succeed.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

export class Vault extends tables.Vault {
	allowRead(user, _target, _context) {
		if (isSuper(user)) return true;
		const owner = this?.owner;
		// Collection subscribe / no loaded record: allow the connection to open.
		if (owner === undefined || owner === null) return true;
		// Per-row: only the owner can read this specific record.
		return owner === user?.username;
	}

	allowUpdate(user, _record, _context) {
		return isSuper(user);
	}
	allowCreate(user, _record, _context) {
		return isSuper(user);
	}
	allowDelete(user, _target, _context) {
		return isSuper(user);
	}
}
