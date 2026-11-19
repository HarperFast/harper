let closed = false;

export class Gate extends Resource {
	static loadAsInstance = false;
	post(_target, data) {
		closed = data.closed === true;
		return { closed };
	}
}

export class Gated extends tables.Readings {
	static subscribe(request, context) {
		if (closed) return;
		return super.subscribe(request, context);
	}
}
