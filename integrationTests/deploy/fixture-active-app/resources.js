export class active_app_health extends Resource {
	static path = '/active_app/health';
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
