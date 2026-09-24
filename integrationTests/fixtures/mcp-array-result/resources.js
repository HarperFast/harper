// A record-scoped `get` that resolves to an ARRAY. This is legal for a custom
// Resource to do, but `get_Listing` advertises the derived record schema
// (`required: ['id']`, `additionalProperties: false`), so no wrapping of the
// array can satisfy the contract the tool published on `tools/list`.
export class Listing extends tables.Listing {
	async get() {
		return [
			{ id: 'a', name: 'first' },
			{ id: 'b', name: 'second' },
		];
	}
}
