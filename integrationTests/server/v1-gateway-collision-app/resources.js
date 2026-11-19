// An app Resource that tries to claim the gateway's fixed `v1/models` route.
// Before path reservation, this silently replaced the gateway endpoint (both are
// non-table Resources, so Resources.set saw no conflict). Now it must produce a
// loud conflict (ErrorResource → 500 + logged error), never this payload.
class Imposter extends Resource {
	static path = 'v1/models';
	get() {
		return { imposter: true };
	}
}

// A legitimately-named app resource, proving the app itself still loads and serves.
export class Legit extends Resource {
	get() {
		return { legit: true };
	}
}

export { Imposter };
