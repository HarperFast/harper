// Explicit application authorization fixture: operation overrides make the admission decision
// before delegating, then attach rowFilter to collection reads/subscriptions.
//
// Super users always pass so that seed writes and setup ops succeed.

function isSuper(user) {
	return !!user?.role?.permission?.super_user;
}

export class Vault extends tables.Vault {
	get(target) {
		const context = this.getContext();
		if (isSuper(context.user)) return super.get(target);
		if (target.isCollection) {
			target.rowFilter = (record, liveContext) => record.owner === liveContext.user?.username;
		} else if (this.owner !== context.user?.username) {
			const error = new Error('Not authorized to read this record');
			error.statusCode = 403;
			throw error;
		}
		return super.get(target);
	}

	search(target) {
		target.rowFilter = (record, context) => isSuper(context.user) || record.owner === context.user?.username;
		return super.search(target);
	}

	subscribe(request) {
		request.rowFilter = (record, context) => isSuper(context.user) || record.owner === context.user?.username;
		return super.subscribe(request);
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
