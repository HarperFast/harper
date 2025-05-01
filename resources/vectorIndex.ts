/**
 * Implementation of a vector index for HarperDB, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
export class VectorIndex {
	static useObjectStore = true;
	indexStore: any;
	M: number = 16; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation

	constructor(indexStore: any) {
		this.indexStore = indexStore;
	}
	index(primaryKey: string, vector: number[], existingValue?: any) {
		// first get the node id for the primary key; we use internal node ids for better efficiency,
		// but we must use a safe key that won't collide with the node ids
		const safeKey = typeof primaryKey === 'number' ? [KEY_PREFIX, primaryKey] : primaryKey;
		let nodeId = this.indexStore.get(safeKey);
		if (!nodeId) {
			// TODO: Use auto-incrementing node ids
			nodeId = Math.floor(Math.random() * 1000000000);
			this.indexStore.put(safeKey, nodeId);
		}

		// If this is the first entry, create it as the entry point
		let entryPointId = this.indexStore.get(ENTRY_POINT);
		if (entryPointId === undefined) {
			const level = Math.floor(-Math.log(Math.random()) * this.mL);
			this.indexStore.put(nodeId, {
				vector,
				level,
				primaryKey,
				// TODO: Make each level of connections a separate top-level property so we can use lazy deserialization to access them
				connections: new Array(level + 1).fill([]),
			});
			this.indexStore.put(ENTRY_POINT, nodeId);
			return;
		}

		let entryPoint = this.indexStore.get(entryPointId);
		// Generate random level for this new element
		const level = Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);

		let currentLevel = entryPoint.level;

		// For each level from top to bottom
		while (currentLevel > level) {
			// Search for closest neighbors at current level
			const neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, currentLevel);

			if (neighbors.length > 0) {
				entryPointId = neighbors[0]; // closest neighbor becomes new entry point
				entryPoint = this.indexStore.get(entryPointId);
			}
			currentLevel--;
		}
		const connections = new Array(level + 1).fill([]);
		// Connect the new element to neighbors at its level and below
		for (let l = Math.min(level, currentLevel); l >= 0; l--) {
			const neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, l);

			// Select M closest neighbors
			const connectionsAtLevel = neighbors.slice(0, this.M >> 1);

			// Create bidirectional connections
			for (const { id, node } of connectionsAtLevel) {
				// Add connection to the new element
				if (!connections[l]) connections[l] = [];
				connections[l].push(id);
				// Add reverse connection from neighbor to new element
				this.addConnection(id, structuredClone(node), nodeId, l);
			}
		}

		// Store the new element
		this.indexStore.put(nodeId, {
			vector,
			level,
			primaryKey,
			connections,
		});
	}

	private getEntryPoint() {
		// Get entry point
		// TODO: Try to keep moving this around to keep the index balanced
		const entryPointId = this.indexStore.get(ENTRY_POINT);

		const node = this.indexStore.get(entryPointId);
		return { id: entryPointId, ...node };
	}

	private searchLayer(queryVector: number[], entryPointId: number, entryPoint: any, ef: number, level: number) {
		const visited = new Set([entryPointId]);
		const candidates = [
			{
				id: entryPointId,
				distance: this.similarity(queryVector, entryPoint.vector),
				node: entryPoint,
			},
		];
		const results = [...candidates];

		while (candidates.length > 0) {
			// Get closest unvisited element
			candidates.sort((a, b) => a.distance - b.distance);
			const current = candidates.shift()!;

			// Get furthest result distance
			const furthestDistance = results[results.length - 1].distance;

			// If current candidate is further than our worst result, we're done
			if (current.distance > furthestDistance) break;

			// Check neighbors of current point
			const currentNode = current.node;
			for (const neighborId of currentNode.connections[level] || []) {
				if (visited.has(neighborId)) continue;
				visited.add(neighborId);

				const neighbor = this.indexStore.get(neighborId);
				const distance = this.similarity(queryVector, neighbor.vector);

				if (distance < furthestDistance || results.length < ef) {
					const candidate = {
						id: neighborId,
						distance,
						node: neighbor,
					};
					candidates.push(candidate);
					results.push(candidate);
					results.sort((a, b) => a.distance - b.distance);
					if (results.length > ef) results.pop();
				}
			}
		}

		return results;
	}

	private similarity(a: number[], b: number[]): number {
		// Euclidean distance
		return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0));
	}
	search(comparator, value) {
		if (comparator !== 'similarity') return;
		const entryPoint = this.getEntryPoint();
		if (!entryPoint) return [];

		const results = this.searchLayer(value, entryPoint.id, entryPoint, this.efConstruction, entryPoint.level);
		return results.map((candidate) => ({
			value: candidate.node.primaryKey // return values
		});
	}

	private addConnection(fromId: number, node: any, toId: number, level: number) {
		if (!node.connections[level]) {
			node.connections[level] = [];
		}
		if (!node.connections[level].includes(toId)) {
			node.connections[level].push(toId);
		}
		if (node.connections[level].length > this.M) {
			// prune the connections to the M/2 closest neighbors
			const withDistance = node.connections[level].map((id) => {
				const neighboringNode = this.indexStore.get(id);
				return {
					id,
					distance: neighboringNode ? this.similarity(node.vector, neighboringNode.vector) : 0,
				};
			});
			withDistance.sort((a, b) => a.distance - b.distance);
			node.connections[level] = withDistance.slice(0, this.M >> 1).map((item) => item.id);
		}
		this.indexStore.put(fromId, node);
	}
}
