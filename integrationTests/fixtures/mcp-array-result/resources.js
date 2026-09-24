// A record-scoped `get` resolving to an array, with no `static outputSchemas.get`,
// so `get_Listing` keeps the derived record schema it cannot satisfy.
export class Listing extends tables.Listing {
	async get() {
		return [
			{ id: 'a', name: 'first' },
			{ id: 'b', name: 'second' },
		];
	}
}
