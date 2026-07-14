// Regression fixture for #1419 — per-row allowRead must filter subscription delivery.
//
// The recommended composition pattern for a record-scoped override:
//   - Gate on the base table/RBAC grant via `super.allowRead(...)` first, so a user who loses the
//     role's table-read is denied — at request entry, and (for a live subscription) when the #1414
//     re-auth recheck re-runs this same override against the fresh user.
//   - At collection scope (no record loaded — a whole-table subscribe, or the re-auth recheck),
//     return the base grant so the connection opens; per-row filtering happens during delivery.
//   - Per record (a loaded row), additionally require the requesting user to own the row.
//
// Super users always pass so that seed writes and setup ops succeed.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

export class Vault extends tables.Vault {
	allowRead(user, target, context) {
		if (isSuper(user)) return true;
		// Base table/RBAC grant — composes with the override so revoking the role's read terminates
		// (at entry and via #1414 re-auth), rather than the override standing in for RBAC.
		if (!super.allowRead(user, target, context)) return false;
		const owner = this?.owner;
		// Collection subscribe / no loaded record: RBAC passed, allow the connection to open.
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
