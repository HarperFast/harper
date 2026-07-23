export class metrics extends Resource {
	static path = '/prometheus_exporter/metrics';
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
