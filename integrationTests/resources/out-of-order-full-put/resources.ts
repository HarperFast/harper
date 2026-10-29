export class ApplyWrite extends Resource {
	static loadAsInstance = false;

	async post(_target, data) {
		await tables.Item[data.method](data.id, data.value, { timestamp: data.timestamp });
		return { applied: true };
	}
}
