import { cosineSimilarity, euclideanSimilarity } from './vector';
import { FLOAT32_OPTIONS } from 'msgpackr';

/**
 * Implementation of a vector index for HarperDB, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
type Connection = {
	id: number;
	similarity: number;
};
type Node = {
	vector: number[];
	level: number;
	primaryKey: string;
	[level: number]: Connection[];
};
/**
 * Represents a Hierarchical Navigable Small World (HNSW) index for approximate nearest neighbor search.
 * This implementation is based on hierarchical graph navigation to efficiently index and search high-dimensional vectors.
 * A HNSW is basically a multi-dimensional skip list. Each node has (potentially) higher levels that are used for quickly
 * traversing the graph get in the neighborhood of the node, and then lower levels are used to more accurately find the
 * closest neighbors.
 *
 * This implementation is based on the paper "Efficient and Robust Approximate Nearest Neighbor Search in High Dimensions"
 * (mostly influenced AI's contributions)
 */
export class HierarchicalNavigableSmallWorld {
	static useObjectStore = true;
	indexStore: any;
	M: number = 32; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation
	// how aggressive do we avoid connections that have alternate indirect routes; a value of 0 never avoids connections,
	// a value of 1 is extremely aggressive.
	indirectnessFactor = 0.4;
	nodesVisitedCount = 0;

	idIncrementer: BigInt64Array | undefined;
	similarity: (a: number[], b: number[]) => number;
	constructor(indexStore: any, options: any) {
		this.indexStore = indexStore;
		if (indexStore) {
			this.indexStore.encoder.useFloat32 = FLOAT32_OPTIONS.ALWAYS;
			const cacheMap = new Map();
			const storeGet = this.indexStore.get;
			this.indexStore.get = (key) => {
				if (cacheMap.has(key)) {
					return cacheMap.get(key);
				}
				const value = storeGet.call(this.indexStore, key);
				cacheMap.set(key, value);
				return value;
			};
			const storePut = this.indexStore.put;
			this.indexStore.put = (key, value) => {
				cacheMap.set(key, value);
				storePut.call(this.indexStore, key, value);
			};
			const storeRemove = this.indexStore.remove;
			this.indexStore.remove = (key) => {
				cacheMap.set(key, undefined);
				storeRemove.call(this.indexStore, key);
			};
		}
		this.similarity = options?.similarity === 'euclidean' ? euclideanSimilarity : cosineSimilarity;
	}
	index(primaryKey: string, vector: number[], existingVector?: number[]) {
		// first get the node id for the primary key; we use internal node ids for better efficiency,
		// but we must use a safe key that won't collide with the node ids
		const safeKey = typeof primaryKey === 'number' ? [KEY_PREFIX, primaryKey] : primaryKey;
		let nodeId = this.indexStore.get(safeKey);
		// if the node id is not found, create a new node (and store it in the index store)
		// (note that we don't need to check if the node id is already in the index store,
		// because we use internal node ids for better efficiency, and we use a safe key
		// that won't collide with the node ids, so we can't have a collision with internal
		if (!nodeId) {
			if (!vector) return; // didn't exist before, doesn't exist now, nothing to do
			if (!this.idIncrementer) {
				let largestNodeId = 0;
				for (const key of this.indexStore.getKeys({
					reverse: true,
					limit: 1,
					start: Infinity,
					end: 0,
				})) {
					if (typeof key === 'number') largestNodeId = key;
				}

				this.idIncrementer = new BigInt64Array([BigInt(largestNodeId) + 1n]);
				this.idIncrementer = new BigInt64Array(
					this.indexStore.getUserSharedBuffer('next-id', this.idIncrementer.buffer)
				);
			}
			nodeId = Number(Atomics.add(this.idIncrementer, 0, 1n));
			this.indexStore.put(safeKey, nodeId);
		}
		const updatedNodes = new Map<number, Node>();
		let oldNode: Node;
		// If this is the first entry, create it as the entry point
		let entryPointId = this.indexStore.get(ENTRY_POINT);
		if (existingVector) {
			// If we are updating an existing entry, we need to update the entry point
			// if the new entry is closer to the entry point than the old one
			oldNode = { ...this.indexStore.get(nodeId) };
		} else oldNode = {} as Node;
		if (vector) {
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
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				console.log('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId);
				return;
			}

			let entryPoint = this.indexStore.get(entryPointId);
			// Generate random level for this new element
			const level = oldNode.level ?? Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);
			let currentLevel = entryPoint.level;
			if (level >= currentLevel) {
				// if we are at this level or higher, make this the new entry point
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				console.log('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId);
			}

			// For each level from top to bottom
			while (currentLevel > level) {
				// Search for closest neighbors at current level
				const neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, currentLevel, 0);

				if (neighbors.length > 0) {
					entryPointId = neighbors[0].id; // closest neighbor becomes new entry point
					entryPoint = neighbors[0].node;
				}
				currentLevel--;
			}
			const connections = new Array(level + 1);
			for (let i = 0; i <= level; i++) {
				connections[i] = [];
			}
			const similarityThreshold = 1 + this.indirectnessFactor;
			// Connect the new element to neighbors at its level and below
			for (let l = Math.min(level, currentLevel); l >= 0; l--) {
				const neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, l, 0);

				if (neighbors.length === 0 && l === 0) {
					console.log('should not have zero connections here');
				}
				const connectionsAtLevel = connections[l];
				let skipping = false;
				// Create bidirectional connections
				for (let i = 0; i < neighbors.length; i++) {
					const { id, similarity, node } = neighbors[i];
					if (id === nodeId) continue; // don't connect to self
					const neighborNeighbors = node[l];
					const adjustedM = (this.M >> 1) - connectionsAtLevel.length;
					const connectionsToBeReplaced: { fromId: number; toId: number }[] = [];
					for (let i2 = 0; i2 < neighborNeighbors.length; i2++) {
						const { id: neighborId, similarity: neighborSimilarity } = neighborNeighbors[i2];
						for (let i3 = 0; i3 < connectionsAtLevel.length; i3++) {
							const { id: addedId, similarity: addedSimilarity } = connectionsAtLevel[i3];
							if (addedId === neighborId) {
								if (
									-similarity * (1 + (this.indirectnessFactor * i) / this.M) >
									-addedSimilarity - neighborSimilarity
								) {
									// if the new similarity is relatively low compared to existing indirect connections,
									// we skip this neighbor since it is of less value
									skipping = true;
								} else if (
									(-neighborSimilarity * (this.indirectnessFactor * i2)) / this.M >
									-similarity - addedSimilarity
								) {
									// potentially remove the neighbor's neighbor, because we are adding a better route (if we do add it)
									connectionsToBeReplaced.push({ fromId: addedId, toId: id });
									connectionsToBeReplaced.push({ fromId: id, toId: addedId });
								}
								break;
							}
						}
						if (skipping) break;
					}
					if (skipping) continue;
					// Add connection to the new element
					connectionsAtLevel.push({ id, similarity });

					for (const { fromId, toId } of connectionsToBeReplaced) {
						let from = updateNode(fromId);
						if (!from) from = updateNode(fromId, this.indexStore.get(fromId));
						for (let i = 0; i < from[l].length; i++) {
							if (from[l][i].id === toId) {
								from[l].splice(i, 1);
								break;
							}
						}
					}

					// Add reverse connection from neighbor to new element if it didn't exist before
					// First check to see if we had an existing neighbor connection before. If we did we can
					// just remove from the list of the connections to remove (don't remove, leave it in place)
					let oldConnections = oldNode[l] as WithCopied;
					const oldPosition = oldConnections?.indexOf(id);
					if (oldPosition > -1) {
						if (!oldConnections.copied) {
							// make a copy, it is likely frozen
							oldConnections = [...oldConnections] as WithCopied;
							oldConnections.copied = true;
							oldNode[l] = oldConnections;
						}
						oldConnections.splice(oldPosition, 1);
					} else {
						// add new connection since this is truly a new connection now
						this.addConnection(id, updateNode(id, node), nodeId, l, similarity, updateNode);
					}
				}
			}

			// Store the new element
			this.indexStore.put(nodeId, {
				vector,
				level,
				primaryKey,
				...connections,
			});
		} else {
			// removal of this node, but first make sure we have a valid entry point
			if (entryPointId === nodeId) {
				// if this is the entry point, find a new entry point
				const lastLevel = oldNode.level ?? 0;
				for (let l = lastLevel; l >= 0; l--) {
					entryPointId = oldNode[l][0]?.id;
					if (entryPointId !== undefined) break;
				}
				if (entryPointId === undefined) {
					// scan through all nodes to find one with highest level
					let highestLevel = -1;
					for (const { key, value } of this.indexStore.getRange({
						start: 0,
						end: Infinity,
					})) {
						if (value.level > highestLevel) {
							entryPointId = key;
							if (value.level === lastLevel) break; // if we found a node at the same level as the last entry point, we can stop
							highestLevel = value.level;
						}
					}
				}
				if (entryPointId === undefined) {
					// no nodes left in index
					this.indexStore.remove(ENTRY_POINT);
				} else {
					// set the new entry point
					if (typeof entryPointId !== 'number') {
						throw new Error('Invalid nodeId: ' + entryPointId);
					}
					console.log('setting entry point to', entryPointId);
					this.indexStore.put(ENTRY_POINT, entryPointId);
				}
			}
			this.indexStore.remove(nodeId);
		}
		const needsReindexing = new Map();
		// remove connections to this node that are no longer valid
		if (oldNode.level !== undefined) {
			for (let l = 0; l <= oldNode.level; l++) {
				const oldConnections = oldNode[l];
				if (!oldConnections) {
					console.log('oldNode', oldNode);
				}
				for (const { id: neighborId } of oldConnections) {
					// get and copy the neighbor node so we can modify it
					const neighborNode = updateNode(neighborId, this.indexStore.get(neighborId));
					for (let l2 = 0; l2 <= l; l2++) {
						// remove the connection to this node from the neighbor node
						neighborNode[l2] = neighborNode[l2]?.filter(({ id: nid }) => {
							return nid !== nodeId;
						});
						if (neighborNode[l2].length === 0) {
							console.log('node was left orphaned, will reindex', neighborId);
							needsReindexing.set(neighborNode.primaryKey, neighborNode.vector);
						}
					}
					/*if (found) {
						this.indexStore.put(neighborId, neighborNode);
						this.verifyMap.set(neighborId, neighborNode);
					}*/
				}
			}
		}
		function updateNode(id: number, node?: Node) {
			// keep a record of all our changes, maintaining any changes that are queued to be written
			let updatedNode: Node = updatedNodes.get(id)!;
			if (!updatedNode && node) {
				// copy the node so we can modify it
				updatedNode = { ...node };
				updatedNodes.set(id, updatedNode);
			}
			return updatedNode;
		}
		for (const [id, updatedNode] of updatedNodes) {
			this.indexStore.put(id, updatedNode);
		}
		for (const [key, vector] of needsReindexing) {
			this.index(key, vector, vector);
		}
		this.checkSymmetry(nodeId, this.indexStore.get(nodeId));
	}

	private getEntryPoint() {
		// Get entry point
		const entryPointId = this.indexStore.get(ENTRY_POINT);

		const node = this.indexStore.get(entryPointId);
		return { id: entryPointId, ...node };
	}

	private searchLayer(
		queryVector: number[],
		entryPointId: number,
		entryPoint: any,
		ef: number,
		level: number,
		antiCliqueFactor: number
	): SearchResults {
		const visited = new Set([entryPointId]);
		const candidates = [
			{
				id: entryPointId,
				similarity: this.similarity(queryVector, entryPoint.vector),
				node: entryPoint,
			},
		];
		let results = [...candidates] as SearchResults;

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
			for (const { id: neighborId } of currentNode[level] || []) {
				if (visited.has(neighborId) || neighborId === undefined) continue;
				visited.add(neighborId);

				const neighbor = this.indexStore.get(neighborId);
				this.nodesVisitedCount++;
				const similarity = this.similarity(queryVector, neighbor.vector);

				if (similarity > leastSimilarity || results.length < ef) {
					const candidate = {
						id: neighborId,
						similarity,
						node: neighbor,
					};
					candidates.push(candidate);
					results.push(candidate);
				}
			}
			results.sort((a, b) => b.similarity - a.similarity);
			if (results.length > ef) results.splice(ef, results.length - ef);
		}
		if (antiCliqueFactor) {
			// when anti-clique measures are applied, we skip nodes that are reachable through other nodes
			const included = new Set<number>(); // track which nodes are directly included or reachable
			const reachable = new Set<number>();
			results = results.filter(({ id, node }, rank) => {
				for (let l = node.level; l >= 0; l--) {
					const level = node[l];
					for (let i = 0; i < level.length; i++) {
						// if already reachable, we skip this one
						if (included.has(level[i])) {
							return false;
						}
						if (reachable.has(level[i]) && rank > antiCliqueFactor) {
							return false;
						}
					}
				}
				included.add(id);
				for (let l = node.level; l >= 0; l--) {
					const level = node[l];
					for (let i = 0; i < level.length; i++) {
						reachable.add(level[i]);
					}
				}
				return true;
			}) as SearchResults;
		}
		results.visited = visited.size;
		return results;
	}

	search(comparator: string, value: number[]) {
		if (comparator !== 'similarity') return;
		let entryPoint = this.getEntryPoint();
		if (!entryPoint) return [];
		let entryPointId = entryPoint.id;
		let results: Candidate[] = [];
		// For each level from top to bottom
		for (let l = entryPoint.level; l >= 0; l--) {
			// Search for closest neighbors at current level
			results = this.searchLayer(value, entryPointId, entryPoint, this.efConstruction >> 1, l, 0);

			if (results.length > 0) {
				const neighbor = results[0]; // closest neighbor becomes new entry point
				entryPoint = neighbor.node;
				entryPointId = neighbor.id;
			}
		}

		return results.map((candidate) => ({
			key: candidate.node.primaryKey, // return values
			similarity: candidate.similarity,
		}));
	}
	private checkSymmetry(id, node) {
		if (!node) return;
		let l = 0;
		let connections;
		while ((connections = node[l])) {
			// verify that the level is not empty, otherwise this means we have an orphaned node
			if (connections.length === 0) break;
			for (const { id: neighbor } of connections) {
				const neighborNode = this.indexStore.get(neighbor);
				if (!neighborNode) {
					console.log('could not find neighbor node', neighborNode);
				}
				// verify that the connection is symmetrical
				const symmetrical = neighborNode[l]?.find(({ id: nid }) => nid == id);
				if (!symmetrical) {
					console.log('asymmetry detected', neighborNode[l]);
				}
				//assert(symmetrical);
			}
			l++;
		}
	}
	private addConnection(
		fromId: number,
		node: any,
		toId: number,
		level: number,
		similarity: number,
		updateNode: (id: number, node?: Node) => any
	) {
		if (!node[level]) {
			node[level] = [];
		}

		const maxConnections = level === 0 ? this.M << 3 : this.M << 2;
		if (node[level].length >= maxConnections) {
			console.log('maxConnections reached, removing some connections', maxConnections);
			// Get all connections with their similarities

			// Sort by similarity but prioritize nodes that have reverse connections
			node[level].sort((a, b) => {
				return b.similarity - a.similarity;
			});

			// Keep the best connections
			const keptConnections = node[level].slice(0, maxConnections - (maxConnections >> 2));
			const removedConnections = node[level].slice(maxConnections - (maxConnections >> 2));

			// Update this node's connections
			node[level] = keptConnections;
			// For removed connections, ensure there's still a path to them
			for (const removed of removedConnections) {
				let removedNode = updateNode(removed.id) ?? this.indexStore.get(removed.id);
				if (removedNode) {
					// Remove the reverse connection if it exists
					if (removedNode[level]) {
						removedNode = updateNode(removed.id, removedNode);
						removedNode[level] = removedNode[level].filter(({ id }) => id !== fromId);
						if (level === 0 && removedNode[level].length === 0) {
							console.log('should not remove last connection');
						}
					}
				}
			}
		}
		if (node[level].find(({ id }) => id === toId)) {
			console.log('already connected');
		} else {
			node[level].push({ id: toId, similarity }); // add
		}

		//this.indexStore.put(fromId, node);
		//this.checkSymmetry(fromId, node);
	}
	validateConnectivity(startLevel: number = 0) {
		const entryPoint = this.getEntryPoint();
		const visited = new Set<number>();

		// BFS from entry point to ensure all nodes are reachable
		const queue = [entryPoint.id];
		visited.add(entryPoint.id);
		let connections = 0;

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const current = this.indexStore.get(currentId);

			for (let level = startLevel; level <= current.level; level++) {
				for (const { id: neighborId } of current[level] || []) {
					connections++;
					if (!visited.has(neighborId)) {
						visited.add(neighborId);
						queue.push(neighborId);
					}
				}
			}
		}

		// Check if all nodes are reachable
		// This would require maintaining a separate set/count of all nodes
		if (visited.size !== this.totalNodes) {
			console.log('visited', visited.size, 'total', this.totalNodes);
		}
		return {
			isFullyConnected: visited.size === this.totalNodes,
			averageConnections: connections / visited.size,
		};
	}
	get totalNodes() {
		return Array.from(this.indexStore.getKeys({ start: 0, end: Infinity })).length;
	}
	get totalConnections() {
		let count = 0;
		for (const key of this.indexStore.getKeys({ reverse: true, limit: 1, start: KEY_PREFIX, exclusiveStart: true })) {
			if (typeof key === 'number' || typeof key === 'bigint') count++;
		}
	}
}
type WithCopied = number[] & { copied: boolean };
type Candidate = {
	id: number;
	similarity: number;
	node: Node;
};
type SearchResults = Candidate[] & { visited: number };
