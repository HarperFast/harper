// A record-scoped `get` resolving to an ARRAY, with no `static outputSchemas.get`
// to redeclare the contract — so `get_Listing` keeps the derived record schema.
export class Listing extends tables.Listing {
	async get() {
		return [
			{ id: 'a', name: 'first' },
			{ id: 'b', name: 'second' },
		];
	}
}
