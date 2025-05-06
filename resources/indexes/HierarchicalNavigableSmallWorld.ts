import { cosineSimilarity, euclideanSimilarity } from './vector';
/**
 * Implementation of a vector index for HarperDB, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
export class HierarchicalNavigableSmallWorld {
	static useObjectStore = true;
	indexStore: any;
	M: number = 16; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation

	constructor(indexStore: any, options) {
		this.indexStore = indexStore;
		this.similarity = options?.similarity === 'euclidean' ? euclideanSimilarity : cosineSimilarity;
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
			const node = {
				vector,
				level,
				primaryKey,
			};
			for (let i = 0; i <= level; i++) {
				node[i] = [];
			}
			this.indexStore.put(nodeId, node);
			this.indexStore.put(ENTRY_POINT, nodeId);
			return;
		}

		let entryPoint = this.indexStore.get(entryPointId);
		// Generate random level for this new element
		const level = Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);
		let currentLevel = entryPoint.level;
		if (level >= currentLevel) {
			// if we are at this level or higher, make this the new entry point
			this.indexStore.put(ENTRY_POINT, nodeId);
		}

		// For each level from top to bottom
		while (currentLevel > level) {
			// Search for closest neighbors at current level
			const neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, currentLevel);

			if (neighbors.length > 0) {
				entryPointId = neighbors[0].id; // closest neighbor becomes new entry point
				entryPoint = neighbors[0].node;
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
				this.addConnection(id, node, nodeId, l);
			}
		}

		// Store the new element
		this.indexStore.put(nodeId, {
			vector,
			level,
			primaryKey,
			...connections,
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
				similarity: this.similarity(queryVector, entryPoint.vector),
				node: entryPoint,
			},
		];
		const results = [...candidates];

		while (candidates.length > 0) {
			// Get closest unvisited element
			candidates.sort((a, b) => b.similarity - a.similarity);
			const current = candidates.shift()!;

			// Get least result similarity
			const leastSimilarity = results[results.length - 1].similarity;

			// If current candidate is less similar than our worst result, we're done
			if (current.similarity < leastSimilarity) break;

			// Check neighbors of current point
			const currentNode = current.node;
			for (const neighborId of currentNode[level] || []) {
				if (visited.has(neighborId)) continue;
				visited.add(neighborId);

				const neighbor = this.indexStore.get(neighborId);
				const similarity = this.similarity(queryVector, neighbor.vector);

				if (similarity > leastSimilarity || results.length < ef) {
					const candidate = {
						id: neighborId,
						similarity,
						node: neighbor,
					};
					candidates.push(candidate);
					results.push(candidate);
					results.sort((a, b) => b.similarity - a.similarity);
					if (results.length > ef) results.pop();
				}
			}
		}

		return results;
	}

	search(comparator: string, value: number[]) {
		if (comparator !== 'similarity') return;
		let entryPoint = this.getEntryPoint();
		if (!entryPoint) return [];
		let entryPointId = entryPoint.id;
		let results: any[];
		// For each level from top to bottom
		for (let l = entryPoint.level; l >= 0; l--) {
			// Search for closest neighbors at current level
			results = this.searchLayer(value, entryPointId, entryPoint, this.efConstruction, l);

			if (results.length > 0) {
				const neighbor = results[0]; // closest neighbor becomes new entry point
				entryPoint = neighbor.node;
				entryPointId = neighbor.id;
			}
		}

		return results.map((candidate) => ({
			value: candidate.node.primaryKey, // return values
		}));
	}

	private addConnection(fromId: number, node: any, toId: number, level: number) {
		node = { ...node }; // copy the node so we can modify it
		if (!node[level]) {
			node[level] = [];
		}
		if (!node[level].includes(toId)) {
			node[level] = [...node[level], toId]; // copy and add
		}

		const maxConnections = level === 0 ? this.M : this.M >> 1;
		if (node[level].length > maxConnections) {
			// Get all connections with their similaritys
			const withSimilarity = node[level].map((id) => {
				const neighboringNode = this.indexStore.get(id);
				if (!neighboringNode) {
					return { id, similarity: Infinity };
				}

				// Count reverse connections to this node
				const reverseConnections = neighboringNode[level]?.filter((nid) => nid === fromId).length ?? 0;

				return {
					id,
					similarity: this.similarity(node.vector, neighboringNode.vector),
					reverseConnections,
				};
			});

			// Sort by similarity but prioritize nodes that have reverse connections
			withSimilarity.sort((a, b) => {
				if (a.reverseConnections !== b.reverseConnections) {
					return b.reverseConnections - a.reverseConnections; // Keep mutual connections
				}
				return b.similarity - a.similarity;
			});

			// Keep the best connections
			const keptConnections = withSimilarity.slice(0, maxConnections);
			const removedConnections = withSimilarity.slice(maxConnections);

			// Update this node's connections
			node[level] = keptConnections.map((item) => item.id);

			// For removed connections, ensure there's still a path to them
			for (const removed of removedConnections) {
				let removedNode = this.indexStore.get(removed.id);
				if (removedNode) {
					// Remove the reverse connection if it exists
					if (removedNode[level]) {
						removedNode = { ...removedNode };
						removedNode[level] = removedNode[level].filter((id) => id !== fromId);
						this.indexStore.put(removed.id, removedNode);
					}
				}
			}
		}
		this.indexStore.put(fromId, node);
	}
	private validateConnectivity(startLevel: number = 0) {
		const entryPoint = this.getEntryPoint();
		const visited = new Set<number>();

		// BFS from entry point to ensure all nodes are reachable
		const queue = [entryPoint.id];
		visited.add(entryPoint.id);

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const current = this.indexStore.get(currentId);

			for (let level = startLevel; level <= current.level; level++) {
				for (const neighborId of current[level] || []) {
					if (!visited.has(neighborId)) {
						visited.add(neighborId);
						queue.push(neighborId);
					}
				}
			}
		}

		// Check if all nodes are reachable
		// This would require maintaining a separate set/count of all nodes
		return visited.size === this.totalNodes;
	}
}
