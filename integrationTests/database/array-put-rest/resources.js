// Echoes what the per-element array-PUT dispatch handed a custom put() override, so the REST layer
// can assert an element target carries the request's query metadata alongside that element's own id.
const seen = [];

export class BatchEcho extends tables.Batch {
	put(record, target) {
		seen.push({
			recordId: record?.id,
			targetId: target?.id,
			isCollection: target?.isCollection === true,
			foo: target?.get?.('foo') ?? null,
			checkPermission: target?.checkPermission ?? null,
		});
		return super.put(record, target);
	}
}

export class ElementTargets extends Resource {
	get() {
		return { calls: seen.splice(0, seen.length) };
	}
}
