// Regression fixture for #1786 — a sync-declared (no `async` keyword) allowRead that returns a
// REJECTED thenable during per-record evaluation. Before the fix, neither the query-traversal
// guard nor the subscription delivery filter attached a handler to that rejection before
// discarding it, so each denied candidate/event reached Harper's global unhandledRejection
// logger. The fix attaches a no-op handler while keeping the fail-closed decision and the
// existing one-time diagnostic warning.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

// Owner marking a record whose per-record allowRead evaluation always rejects. Kept distinct
// from real owners so a normal, allowed record can also be present — an SSE subscription whose
// EVERY record is denied never writes a byte, so headers wouldn't flush and the test client
// would hang waiting for a response that never comes. This isn't a Harper bug to work around in
// the test; it just means the fixture needs at least one deliverable record.
const REJECTING_OWNER = 'REJECT_SENTINEL';

export class Rejecting extends tables.Rejecting {
	allowRead(user, target, context) {
		if (isSuper(user)) return true;
		if (!super.allowRead(user, target, context)) return false;
		const owner = this?.owner;
		// Collection scope (subscribe entry check) / no loaded record: allow the connection to open.
		if (owner === undefined || owner === null) return true;
		if (owner === REJECTING_OWNER) {
			// Per-record (query traversal, subscription event delivery): sync-declared but returns a
			// rejected thenable — must fail closed WITHOUT leaking an unhandledRejection.
			return Promise.reject(new Error('allowRead intentionally rejects during per-record evaluation (#1786)'));
		}
		return owner === user?.username;
	}

	allowUpdate(user) {
		return isSuper(user);
	}
	allowCreate(user) {
		return isSuper(user);
	}
	allowDelete(user) {
		return isSuper(user);
	}
}
