export class Encoder767 extends Resource {
	static loadAsInstance = false;
	async get() {
		const store = databases.data.WidthShapes.primaryStore;
		return { randomAccessStructure: store.randomAccessStructure ?? store.encoder.randomAccessStructure };
	}
}
