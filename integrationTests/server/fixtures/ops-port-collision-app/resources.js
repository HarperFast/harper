// Minimal resource so the app is a valid loadable component.
export class Ping extends Resource {
	get() {
		return { ok: true };
	}
}
