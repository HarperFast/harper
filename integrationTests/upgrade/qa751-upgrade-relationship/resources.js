function getTable(name) {
	const table = tables[name];
	if (!table) throw new Error(`QA-751: unknown table "${name}"`);
	return table;
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

export class Put extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const request = body || query || {};
		const table = getTable(request.table);
		await table.put(request.record);
		return { ok: true, table: request.table, id: request.record.id };
	}
}

export class InjectIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const request = body || query || {};
		const table = getTable(request.table);
		await table.indices[request.attribute].put(request.value, request.id);
		return { ...request, ok: true, injected: true };
	}
}

export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const request = body || query || {};
		const table = getTable(request.table);
		await table.indices[request.attribute].remove(request.value, request.id);
		return { ...request, ok: true, removed: true };
	}
}
