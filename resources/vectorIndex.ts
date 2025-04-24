/**
 * Implementation of a vector index for HarperDB, using hierarchical navigable small world graphs.
 */
class VectorIndex {
	indexStore: any;
	M: number = 16; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation

	index(id: string, vector: number[], existingValue?: any) {
		// If this is the first entry, create it as the entry point
		const firstEntry = this.indexStore.getRange({ limit: 1 });
		if (!firstEntry || firstEntry.length === 0) {
			const level = Math.floor(-Math.log(Math.random()) * this.mL);
			this.indexStore.put(id, {
				vector,
				level,
				connections: new Array(level + 1).fill([]),
			});
			return;
		}

		// Generate random level for this new element
		const level = Math.floor(-Math.log(Math.random()) * this.mL);

		// Find entry point
		let entryPoint = this.getEntryPoint();
		let currentLevel = entryPoint.level;

		// For each level from top to bottom
		while (currentLevel > level) {
			// Search for closest neighbors at current level
			const neighbors = this.searchLayer(vector, entryPoint, this.efConstruction, currentLevel);

			if (neighbors.length > 0) {
				entryPoint = neighbors[0]; // closest neighbor becomes new entry point
			}
			currentLevel--;
		}

		// Connect the new element to neighbors at its level and below
		for (let l = Math.min(level, currentLevel); l >= 0; l--) {
			const neighbors = this.searchLayer(vector, entryPoint, this.efConstruction, l);

			// Select M closest neighbors
			const connections = neighbors.slice(0, this.M).map((n) => n.id);

			// Create bidirectional connections
			for (const neighborId of connections) {
				// Add connection to new element
				this.addConnection(id, neighborId, l);
				// Add reverse connection from neighbor to new element
				this.addConnection(neighborId, id, l);
			}
		}

		// Store the new element
		this.indexStore.put(id, {
			vector,
			level,
			connections: new Array(level + 1).fill([]),
		});
	}

	private getEntryPoint() {
		// Get element with highest level
		const entries = this.indexStore.getRange({});
		let maxLevel = -1;
		let entryPoint = null;

		for (const entry of entries) {
			if (entry.value.level > maxLevel) {
				maxLevel = entry.value.level;
				entryPoint = { ...entry.value, id: entry.key };
			}
		}
		return entryPoint;
	}

	private searchLayer(queryVector: number[], entryPoint: any, ef: number, level: number) {
		const visited = new Set([entryPoint.id]);
		const candidates = [
			{
				id: entryPoint.id,
				distance: this.similarity(queryVector, entryPoint.vector),
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
			const currentNode = this.indexStore.get(current.id);
			for (const neighborId of currentNode.connections[level] || []) {
				if (visited.has(neighborId)) continue;
				visited.add(neighborId);

				const neighbor = this.indexStore.get(neighborId);
				const distance = this.similarity(queryVector, neighbor.vector);

				if (distance < furthestDistance || results.length < ef) {
					candidates.push({ id: neighborId, distance });
					results.push({ id: neighborId, distance });
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

	private addConnection(fromId: string, toId: string, level: number) {
		const node = this.indexStore.get(fromId);
		if (!node.connections[level]) {
			node.connections[level] = [];
		}
		if (!node.connections[level].includes(toId)) {
			node.connections[level].push(toId);
		}
		this.indexStore.put(fromId, node);
	}
}
