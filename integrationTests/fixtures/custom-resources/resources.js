// WorkItem: async write-then-patch pattern (CDI RT enqueueing + AI inference result attachment)
export class WorkItem extends tables.WorkItem {
	async post(body, _ctx) {
		const id = Math.random().toString(36).slice(2);
		// Use static class method to create a new record by explicit id
		await tables.WorkItem.put({ id, state: 'pending', payload: JSON.stringify(body) });
		return { id, state: 'pending' };
	}
	async patch(body, _ctx) {
		// this is the loaded record instance; doesExist() tells us if it was found
		if (!this.doesExist()) return new Response(null, { status: 404 });
		const current = await this.get();
		// Full update via single-arg super.put (legacy: update(record, true) + save)
		await super.put({ ...current, state: 'completed', result: body.result, resultAt: new Date() });
		return { state: 'completed' };
	}
}

// RedirectRule: routing decision with audit trail (Walmart USGM pattern)
export class RedirectRule extends tables.RedirectRule {
	async post(body, _ctx) {
		// chain detection: check if redirectUrl matches any existing matchUrl
		const existing = [];
		for await (const r of tables.RedirectRule.search({
			conditions: [{ attribute: 'matchUrl', value: body.redirectUrl }],
		})) {
			existing.push(r);
		}
		if (existing.length > 0) {
			const context = this.getContext();
			if (context?.response) context.response.status = 409;
			return { error: 'Chain redirect detected' };
		}
		const id = Math.random().toString(36).slice(2);
		const user = this.getContext()?.user;
		const record = { id, ...body, createdBy: user?.username || 'anonymous' };
		// Write the redirect rule and audit record using static methods
		await tables.RedirectRule.put(record);
		await tables.RedirectChange.put({
			id: Math.random().toString(36).slice(2),
			redirectId: id,
			operation: 'create',
			previousState: null,
		});
		return record;
	}
}

// Block external mutations on RedirectChange (audit log is immutable from outside)
export class RedirectChange extends tables.RedirectChange {
	post() {
		return new Response(null, { status: 405 });
	}
	put() {
		return new Response(null, { status: 405 });
	}
	patch() {
		return new Response(null, { status: 405 });
	}
	delete() {
		return new Response(null, { status: 405 });
	}
}

// RoutingDecision: POST-only routing lookup endpoint (Walmart USGM)
export class RoutingDecision extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const { path } = body;
		if (!path) return {};
		const now = new Date();
		const rules = [];
		for await (const r of tables.RedirectRule.search({ conditions: [{ attribute: 'matchUrl', value: path }] })) {
			rules.push(r);
		}
		const rule = rules.find((r) => {
			if (r.startTime && new Date(r.startTime) > now) return false;
			if (r.endTime && new Date(r.endTime) < now) return false;
			return true;
		});
		if (rule) return { shouldRedirect: true, status: rule.statusCode || 302, location: rule.redirectUrl };
		return {};
	}
}

// AbuseCounter: atomic counter with 403 threshold (Ford PasswordResetAbuse pattern)
export class AbuseCounter extends tables.AbuseCounter {
	async put(_body, _ctx) {
		// this is the loaded record instance; get current count from the stored record
		const current = await this.get();
		const id = this.getId();
		const newCount = ((current && current.count) || 0) + 1;
		if (newCount > 5) {
			const context = this.getContext();
			if (context?.response) context.response.status = 403;
			return { error: 'Too many attempts' };
		}
		// Full update via single-arg super.put (legacy: update(record, true) + save)
		await super.put({ id, count: newCount });
		return { count: newCount };
	}
}
