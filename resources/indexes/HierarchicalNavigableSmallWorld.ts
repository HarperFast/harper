import { cosineDistance, euclideanDistance } from './vector.ts';
import { FLOAT32_OPTIONS } from 'msgpackr';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { ClientError } from '../../utility/errors/hdbError.js';
import type { Id } from '../../resources/ResourceInterface.ts';

const logger = loggerWithTag('HNSW');
/**
 * Implementation of a vector index for HarperDB, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
type Connection = {
	id: number;
	distance: number;
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
	M: number = 16; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	efConstructionSearch: number = 50; // size of dynamic candidate list for search
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation
	// how aggressive do we avoid connections that have alternate indirect routes; a value of 0 never avoids connections,
	// a value of 1 is extremely aggressive.
	optimizeRouting = 0.5;
	nodesVisitedCount = 0;

	idIncrementer: BigInt64Array | undefined;
	distance: (a: number[], b: number[]) => number;
	constructor(indexStore: any, options: any) {
		this.indexStore = indexStore;
		if (indexStore) {
			// use float32 representation of numbers as it is twice as space efficient as typical float64 and plenty accurate
			// (we would actually like to use float16 if it were available)
			this.indexStore.encoder.useFloat32 = FLOAT32_OPTIONS.ALWAYS;
		}
		this.distance = options?.distance === 'euclidean' ? euclideanDistance : cosineDistance;
		if (options) {
			// allow all the HNSW parameters to be configured/tuned
			if (options.M !== undefined) {
				this.M = options.M;
				this.mL = 1 / Math.log(this.M); // recalculate
			}
			if (options.efConstruction !== undefined)
				this.efConstruction = this.efConstructionSearch = options.efConstruction;
			if (options.efConstructionSearch !== undefined) this.efConstructionSearch = options.efConstructionSearch;
			if (options.mL !== undefined) this.mL = options.mL;
			if (options.optimizeRouting !== undefined) this.optimizeRouting = options.optimizeRouting;
		}
	}
	index(primaryKey: Id, vector: number[], existingVector?: number[]) {
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
			let entryPoint = entryPointId && this.indexStore.get(entryPointId);
			if (entryPoint === undefined) {
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
				logger.debug?.('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId);
				return;
			}

			// Generate random level for this new element
			const level = oldNode.level ?? Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);
			let currentLevel = entryPoint.level;
			if (level >= currentLevel) {
				// if we are at this level or higher, make this the new entry point
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				logger.debug?.('setting entry point to', nodeId);
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
			const connections = new Array(level + 1);
			for (let i = 0; i <= level; i++) {
				connections[i] = [];
			}

			// Connect the new element to neighbors at its level and below
			for (let l = Math.min(level, currentLevel); l >= 0; l--) {
				let neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, l);
				neighbors = neighbors.slice(0, this.M << 1) as SearchResults;

				if (neighbors.length === 0 && l === 0) {
					logger.info?.('should not have zero connections for', entryPointId);
				}
				const connectionsAtLevel = connections[l];
				// Create bidirectional connections
				for (let i = 0; i < neighbors.length; i++) {
					const { id, distance, node } = neighbors[i];
					if (id === nodeId) continue; // don't connect to self
					const connectionsToBeReplaced: { fromId: number; toId: number }[] = [];
					if (this.optimizeRouting) {
						// if we have existing connections through other nodes, we deprioritize new connections through them.
						// I believe this yields better HNSW graphs, avoiding redundant paths, with better directed connectivity
						// towards desired results
						let skipping = false;
						const neighborNeighbors = node[l];
						const distanceThreshold = 1 + this.optimizeRouting * (1 + (0.5 * i) / this.M);
						for (let i2 = 0; i2 < neighborNeighbors.length; i2++) {
							const { id: neighborId, distance: neighborDistance } = neighborNeighbors[i2];
							const neighborDistanceThreshold = 1 + this.optimizeRouting * (1 + (0.5 * i2) / this.M);
							for (let i3 = 0; i3 < connectionsAtLevel.length; i3++) {
								const { id: addedId, distance: addedDistance } = connectionsAtLevel[i3];
								if (addedId === neighborId) {
									if (distance * distanceThreshold > addedDistance + neighborDistance) {
										// if the new distance is relatively low compared to existing indirect connections,
										// we skip this neighbor since it is of less value
										skipping = true;
									} else if (neighborDistance * neighborDistanceThreshold > distance + addedDistance) {
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
					} else if (i >= (l > 0 ? this.M : this.M << 1)) {
						// fallback to traditional HNSW level limiting; if we are at the maximum number of neighbors, we skip this one
						continue;
					}
					// Add connection to the new element
					connectionsAtLevel.push({ id, distance });

					for (const { fromId, toId } of connectionsToBeReplaced) {
						let from = updateNode(fromId);
						if (!from) from = updateNode(fromId, this.indexStore.get(fromId));
						for (let i = 0; i < from[l].length; i++) {
							if (from[l][i].id === toId) {
								if (Object.isFrozen(from[l])) {
									from[l] = from[l].slice();
								}
								from[l].splice(i, 1);
								break;
							}
						}
					}

					// Add reverse connection from neighbor to new element if it didn't exist before
					// First check to see if we had an existing neighbor connection before. If we did we can
					// just remove from the list of the connections to remove (don't remove, leave it in place)
					let oldConnections = oldNode[l] as WithCopied;
					const oldConnection = oldConnections?.find(({ id: nid }) => nid === id);
					if (oldConnection) {
						const oldPosition = oldConnections?.indexOf(oldConnection);
						if (!oldConnections.copied) {
							// make a copy, it is likely frozen
							oldConnections = [...oldConnections] as WithCopied;
							oldConnections.copied = true;
							oldNode[l] = oldConnections;
						}
						oldConnections.splice(oldPosition, 1);
					} else {
						// add new connection since this is truly a new connection now
						this.addConnection(id, updateNode(id, node), nodeId, l, distance, updateNode);
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
					logger.debug?.('setting entry point to', entryPointId);
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
				for (const { id: neighborId } of oldConnections) {
					// get and copy the neighbor node so we can modify it
					const neighborNode = updateNode(neighborId, this.indexStore.get(neighborId));
					for (let l2 = 0; l2 <= l; l2++) {
						// remove the connection to this node from the neighbor node
						neighborNode[l2] = neighborNode[l2]?.filter(({ id: nid }) => {
							return nid !== nodeId;
						});
						if (neighborNode[l2].length === 0) {
							logger.info?.('node was left orphaned, will reindex', neighborId);
							needsReindexing.set(neighborNode.primaryKey, neighborNode.vector);
						}
					}
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

	/**
	 * Search one layer of the skip-list using HNSW algorithm for creating a candidate list and navigating the graph
	 * TODO: This should be async, but we can't really do that with lmdb-js's transaction system right now. Should be
	 * doable with RocksDB. We could also create an async version for searching.
	 * @param queryVector
	 * @param entryPointId
	 * @param entryPoint
	 * @param ef
	 * @param level
	 * @param distanceFunction
	 * @private
	 */
	private searchLayer(
		queryVector: number[],
		entryPointId: number,
		entryPoint: any,
		ef: number,
		level: number,
		distanceFunction = this.distance
	): SearchResults {
		const visited = new Set([entryPointId]);
		const candidates = [
			{
				id: entryPointId,
				distance: this.distance(queryVector, entryPoint.vector),
				node: entryPoint,
			},
		];
		const results = [...candidates] as SearchResults;

		while (candidates.length > 0) {
			// Get closest unvisited element
			candidates.sort((a, b) => a.distance - b.distance);
			const current = candidates.shift()!;

			// Get least result distance
			const furthestDistance = results[results.length - 1].distance;

			// If current candidate is less similar than our worst result, we're done
			if (current.distance > furthestDistance) break;

			// Check neighbors of current point
			const currentNode = current.node;
			for (const { id: neighborId } of currentNode[level] || []) {
				if (visited.has(neighborId) || neighborId === undefined) continue;
				visited.add(neighborId);

				const neighbor = this.indexStore.get(neighborId);
				this.nodesVisitedCount++;
				const distance = distanceFunction(queryVector, neighbor.vector);

				if (distance < furthestDistance || results.length < ef) {
					const candidate = {
						id: neighborId,
						distance,
						node: neighbor,
					};
					candidates.push(candidate);
					results.push(candidate);
				}
			}
			results.sort((a, b) => a.distance - b.distance);
			if (results.length > ef) results.splice(ef, results.length - ef);
		}
		results.visited = visited.size;
		return results;
	}

	/**
	 * This the main entry from Harper's query functionality, where we actually search for an ordered list of nearest
	 * neighbors, using the provided sort/order definition object and performing the multi-layer skip-list search.
	 * This returns an iterable of the nearest neighbors to the provided target vector, with nearest ordered first.
	 * @param target
	 * @param value
	 * @param descending
	 * @param distance
	 * @param comparator
	 * @param context
	 */
	search(
		{
			target,
			value,
			descending,
			distance,
			comparator,
		}: {
			target: number[];
			value: number;
			descending: boolean;
			distance: string;
			comparator: string;
		},
		context: any
	) {
		let limit = 0; // zero is ignored, only used if set below
		switch (comparator) {
			case 'lt':
			case 'le':
				limit = value;
			// fallthrough
			case 'sort':
				break;
			default:
				throw new ClientError(`Can not use "${comparator}" comparator with HNSW`);
		}
		if (descending) throw new ClientError(`Can not use descending sort order with HNSW`);
		let distanceFunction: (a: number[], b: number[]) => number;
		if (distance === 'cosine') distanceFunction = cosineDistance;
		else if (distance === 'euclidean') distanceFunction = euclideanDistance;
		else if (distance) throw new ClientError('Unknown distance function');
		else distanceFunction = this.distance;
		if (!target) throw new ClientError('A target vector must be provided for an HNSW query');
		if (!Array.isArray(target)) throw new ClientError('The target vector must be an array');

		let entryPoint = this.getEntryPoint();
		if (!entryPoint) return [];
		let entryPointId = entryPoint.id;
		let results: Candidate[] = [];
		// For each level from top to bottom
		for (let l = entryPoint.level; l >= 0; l--) {
			// Search for closest neighbors at current level
			results = this.searchLayer(target, entryPointId, entryPoint, this.efConstructionSearch, l, distanceFunction);

			if (results.length > 0) {
				const neighbor = results[0]; // closest neighbor becomes new entry point
				entryPoint = neighbor.node;
				entryPointId = neighbor.id;
			}
		}
		if (limit) results = results.filter((candidate) => candidate.distance < limit);
		return results.map((candidate) => ({
			// we return the result as an entry so we can provide distance as metadata
			key: candidate.node.primaryKey, // return value
			distance: candidate.distance,
		}));
	}
	private checkSymmetry(id, node) {
		if (!node) return;
		let l = 0;
		let connections: Candidate[];
		while ((connections = node[l])) {
			// verify that the level is not empty, otherwise this means we have an orphaned node
			if (connections.length === 0) break;
			for (const { id: neighbor } of connections) {
				const neighborNode = this.indexStore.get(neighbor);
				if (!neighborNode) {
					logger.info?.('could not find neighbor node', neighborNode);
					continue;
				}
				// verify that the connection is symmetrical
				const symmetrical = neighborNode[l]?.find(({ id: nid }) => nid == id);
				if (!symmetrical) {
					logger.info?.('asymmetry detected', neighborNode[l]);
				}
			}
			l++;
		}
	}
	private addConnection(
		fromId: number,
		node: any,
		toId: number,
		level: number,
		distance: number,
		updateNode: (id: number, node?: Node) => any
	) {
		if (!node[level]) {
			node[level] = [];
		}

		let maxConnections = level === 0 ? this.M << 1 : this.M;
		if (this.optimizeRouting) maxConnections <<= 2; // bump up the max connections beyond traditional HNSW because we are naturally limiting
		// have we exceeded the max connections (with 25% grace period)
		if (node[level].length >= maxConnections + (maxConnections >> 2)) {
			logger.warn?.('maxConnections reached, removing some connections', maxConnections);
			// Get all connections with their similarities

			// Sort by distance but prioritize nodes that have reverse connections
			const connections = [...node[level]];
			connections.sort((a, b) => {
				return a.distance - b.distance;
			});

			// Keep the best connections
			const keptConnections = connections.slice(0, maxConnections);
			const removedConnections = connections.slice(maxConnections);

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
							logger.info?.('should not remove last connection', fromId, toId);
						}
					}
				}
			}
		}
		if (node[level].find(({ id }) => id === toId)) {
			logger.debug?.('already connected', fromId, toId);
		} else {
			node[level] = [...node[level], { id: toId, distance }]; // add
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

	/**
	 * This is used by the query planner to determine what order to apply conditions. Our best guess at an estimated count.
	 */
	estimateCount() {
		return Math.sqrt(this.indexStore.getStats().entryCount) * 2;
	}

	/**
	 * This is used to resolve the vector property, which should be resolved to the distance when used in a sort comparator
	 * We also want to cache distance calculations so they can be accessed efficently later
	 * @param vector
	 * @param context
	 * @param entry
	 */
	propertyResolver(vector: number[], context: any, entry: any) {
		const sortDefinition = context?.sort;
		if (sortDefinition) {
			// set up a cache for these so they can be accessed by $distance and not be recalculated during a sort
			let vectorDistances = sortDefinition.vectorDistances;
			if (vectorDistances) {
				const difference = vectorDistances.get(entry);
				if (difference) return difference;
			} else vectorDistances = context.vectorDistances = sortDefinition.vectorDistances = new Map();

			let distanceFunction = this.distance;
			if (sortDefinition.type)
				distanceFunction = sortDefinition.distance === 'euclidean' ? euclideanDistance : cosineDistance;
			const distance = distanceFunction(sortDefinition.target, vector);
			vectorDistances.set(entry, distance);
			return distance;
		}
		return vector;
	}
}
type WithCopied = Connection[] & { copied: boolean };
type Candidate = {
	id: number;
	distance: number;
	node: Node;
};
type SearchResults = Candidate[] & { visited: number };
