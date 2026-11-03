// Two ways a record-scoped `get` reaches the wire as a JSON array, neither declaring
// `static outputSchemas.get`, so both keep the derived record schema they cannot satisfy.
export class Listing extends tables.Listing {
	async get() {
		return [
			{ id: 'a', name: 'first' },
			{ id: 'b', name: 'second' },
		];
	}
}

// `Array.isArray` is false here; only the serialized form shows the array.
export class Coded extends tables.Coded {
	async get() {
		return { toJSON: () => [{ id: 'a', name: 'first' }] };
	}
}
