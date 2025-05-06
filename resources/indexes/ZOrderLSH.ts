/**
 * Implementation of a vector index for HarperDB, using Locality Sensitive Hashing implemented as a Z-order curve
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const RANDOM_PROJECTION = Symbol.for('randomProjection');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
const RANDOM_PROJECTION_INPUT_DIMENSIONS = 10000;
export class ZOrderLSH {
	indexStore: any;
	precision = 1 / (1 << 8);
	constructor(indexStore: any, useRandomProjectionCount?: number) {
		this.indexStore = indexStore;
		if (useRandomProjectionCount) {
			this.randomProjection = this.indexStore.get(ENTRY_POINT);
			if (!this.randomProjection) {
				this.indexStore.transactionSync(() => {
					this.randomProjection = this.indexStore.get(ENTRY_POINT);
					if (!this.randomProjection) {
						this.randomProjection = this.generateRandomProjection(useRandomProjectionCount);
					}
					this.indexStore.putSync(RANDOM_PROJECTION, this.randomProjection);
				});
			}
		}
	}
	randomProjection: number[][];
	generateRandomProjection(count: number) {
		const randomProjection = new Array(RANDOM_PROJECTION_INPUT_DIMENSIONS).fill(0).map(() => {
			return new Array(count).fill(0).map(() => Math.random() * 2 - 1);
		});
		return randomProjection;
	}
	applyRandomProjection(vector: number[]) {
		const result = new Array(this.randomProjection.length).fill(0);
		for (let i = 0; i < vector.length; i++) {
			for (let j = 0; j < this.randomProjection[i].length; j++) {
				result[i] += vector[i] * this.randomProjection[i][j];
			}
		}
		return result;
	}
	get totalNodes() {}
	index(primaryKey: string, vector: number[], existingValue?: any) {
		if (this.randomProjection) {
			vector = this.applyRandomProjection(vector);
		}
		const result = 0;
		do {
			for (value of vector) {
			}
		} while (vector.some((v) => v < 0 || v > 1));
		this.indexStore;
	}
}
