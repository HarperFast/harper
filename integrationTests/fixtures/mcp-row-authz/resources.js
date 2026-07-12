// Row-level RBAC overrides for the Doc table. A non-super user may only read or
// mutate rows they own (owner === username). These are the exact per-record
// guards REST honors; the MCP application profile must honor them too (#1487).

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

function ownsThisRow(self, user) {
	return self?.owner != null && user?.username != null && self.owner === user.username;
}

export class Doc extends tables.Doc {
	allowRead(user, _target, _context) {
		return isSuper(user) || ownsThisRow(this, user);
	}

	allowUpdate(user, _record, _context) {
		return isSuper(user) || ownsThisRow(this, user);
	}

	allowDelete(user, _target, _context) {
		return isSuper(user) || ownsThisRow(this, user);
	}

	// `record` may arrive as a Promise for the streamed body; resolve before use.
	async allowCreate(user, record, _context) {
		if (isSuper(user)) return true;
		const body = record && typeof record.then === 'function' ? await record : record;
		return body?.owner != null && user?.username != null && body.owner === user.username;
	}
}
