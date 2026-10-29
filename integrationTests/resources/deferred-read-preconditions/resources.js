const STARTUP_VERSION = Date.UTC(2026, 0, 2, 3, 4, 5);

function startupStream(context) {
	return (async function* () {
		context.lastModified = STARTUP_VERSION;
		yield { id: 'a' };
		yield { id: 'b' };
	})();
}

export class DeferredStream extends Resource {
	static loadAsInstance = false;
	get() {
		return startupStream(this.getContext());
	}
}

export class DeferredEnvelope extends Resource {
	static loadAsInstance = false;
	get() {
		return { headers: { 'X-Deferred-Envelope': 'true' }, data: startupStream(this.getContext()) };
	}
}

export class RestrictedItem extends tables.RestrictedRow {
	static loadAsInstance = false;
	async allowRead() {
		await new Promise((resolve) => setTimeout(resolve, 1));
		return false;
	}
	get(target) {
		return this.search(target);
	}
}
