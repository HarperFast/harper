const { LabeledDoc, CachedDoc } = tables;

export class CachedSource extends Resource {
	async get() {
		const id = this.getId();
		return { id, value: `sourced ${id}` };
	}
}
CachedDoc.sourcedFrom(CachedSource);

// anonymous-readable exports of the tables above
export class PublicLabeled extends LabeledDoc {
	allowRead() {
		return true;
	}
}
export class PublicCached extends CachedDoc {
	allowRead() {
		return true;
	}
}

// resource that sets its own Cache-Control (RFC 9111 shared-cache opt-in)
export class SelfCaching extends Resource {
	allowRead() {
		return true;
	}
	get() {
		this.getContext().responseHeaders.set('Cache-Control', 'public, max-age=10');
		return { hello: 'world' };
	}
}

// sets a shared-cache opt-in but then rejects the credentials — the 401 must NOT be shared-cacheable
export class PublicButDenied extends Resource {
	allowRead() {
		return true;
	}
	get() {
		this.getContext().responseHeaders.set('Cache-Control', 'public, max-age=30');
		const error = new Error('Unauthorized');
		error.statusCode = 401;
		throw error;
	}
}
