// QA-F078 — GraphQL allowRead enforcement probe.
//
// Secret rows are owner-scoped: a non-super user may only read rows where
// this.owner === user.username. Super users always pass (admin seeding path).
// The role is granted full table-level CRUD so the table-level check passes and
// allowRead is the ONLY remaining gate.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

export class Secret extends tables.Secret {
	allowRead(user, _target, _context) {
		if (isSuper(user)) return true;
		return this.owner != null && user?.username != null && this.owner === user.username;
	}
}
