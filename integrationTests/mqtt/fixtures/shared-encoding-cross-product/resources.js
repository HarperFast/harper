export class Ready extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
