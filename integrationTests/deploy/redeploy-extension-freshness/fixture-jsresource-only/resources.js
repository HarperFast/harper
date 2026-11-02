export class Existing extends Resource {
	static path = '/qa786-js-existing';
	static loadAsInstance = false;
	async get() {
		return { version: 1 };
	}
}
