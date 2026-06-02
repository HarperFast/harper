import { cosineDistance, euclideanDistance, dotProductDistance } from './vector.ts';
import { FLOAT32_OPTIONS } from 'msgpackr';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { ClientError } from '../../utility/errors/hdbError.ts';
import type { Id } from '../../resources/ResourceInterface.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';

const logger = loggerWithTag('HNSW');

// Optional int8 scalar quantization of stored vectors, enabled per-index via the
// schema directive: `@indexed(type: "HNSW", quantization: "int8")`. The stored
// graph node holds the vector as a compact int8 `bin` plus a per-vector `scale`,
// roughly a 5x size reduction over the float32 array and ~10x cheaper to decode
// (a single typed-array view instead of decoding 768 individually-tagged floats
// into a boxed Array). The full-precision vector still lives on the record, so
// only graph navigation is approximate; quantization recall loss is ~1%.
//
// Decode auto-detects the stored format (number[] = float, bin = int8), so an
// int8-enabled index transparently reads legacy float nodes written before the
// option was set.

/** Symmetric int8 scalar-quantize a float vector. scale = max|component| / 127. */
function quantizeInt8(vector: number[]): { bytes: Buffer; scale: number } {
	let max = 0;
	for (let i = 0; i < vector.length; i++) {
		const a = vector[i] < 0 ? -vector[i] : vector[i];
		if (a > max) max = a;
	}
	const scale = max / 127 || 1;
	const inv = 1 / scale;
	const q = new Int8Array(vector.length);
	// clamp guards against a float-rounding edge landing on 128 (which Int8Array would wrap to -128)
	for (let i = 0; i < vector.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * inv)));
	return { bytes: Buffer.from(q.buffer, q.byteOffset, q.byteLength), scale };
}

/** Reconstruct an approximate float array from an int8 vector + scale. */
function dequantizeInt8(q: Int8Array, scale: number): number[] {
	const out = new Array(q.length);
	for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
	return out;
}

// Auto-scaled search ef, used only when an index does not explicitly configure efConstructionSearch
// and a query does not pass its own ef. A fixed ef makes recall decay as the graph grows (it explores
// a shrinking fraction of the graph), so ef grows with sqrt(node count), capped to bound search cost.
// Constants from a recall/latency-vs-N sweep (768-dim cosine, int8): ef≈400 holds ~0.8 recall@10 from
// 5K–30K, and the recall/latency tradeoff is steep (ef 800 at 30K ≈ 0.92 recall but ~2s p50), so the
// cap deliberately favors latency — apps wanting higher recall set efConstructionSearch or a per-query
// ef. Tune as graph build quality / larger-N data improves.
const AUTO_EF_BASE = 100;
const AUTO_EF_REF = 1000;
const AUTO_EF_MAX = 512;
function autoScaleEf(nodeCount: number): number {
	const scaled = Math.round(AUTO_EF_BASE * Math.sqrt(Math.max(1, nodeCount / AUTO_EF_REF)));
	return Math.min(AUTO_EF_MAX, Math.max(AUTO_EF_BASE, scaled));
}

class MinHeap {
	private data: Candidate[] = [];
	get size() {
		return this.data.length;
	}
	push(item: Candidate) {
		this.data.push(item);
		let i = this.data.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (this.data[p].distance <= this.data[i].distance) break;
			const tmp = this.data[p];
			this.data[p] = this.data[i];
			this.data[i] = tmp;
			i = p;
		}
	}
	pop(): Candidate | undefined {
		if (this.data.length === 0) return undefined;
		const top = this.data[0];
		const last = this.data.pop()!;
		if (this.data.length > 0) {
			this.data[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1,
					r = l + 1;
				let min = i;
				if (l < this.data.length && this.data[l].distance < this.data[min].distance) min = l;
				if (r < this.data.length && this.data[r].distance < this.data[min].distance) min = r;
				if (min === i) break;
				const tmp = this.data[min];
				this.data[min] = this.data[i];
				this.data[i] = tmp;
				i = min;
			}
		}
		return top;
	}
}

function bisectInsert(arr: Candidate[], distance: number): number {
	let lo = 0,
		hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid].distance <= distance) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Implementation of a vector index for Harper, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
type Connection = {
	id: number;
	distance: number;
};
type Node = {
	vector: number[] | Int8Array; // float nodes: number[]; quantized nodes: Int8Array (decoded from a bin)
	scale?: number; // int8 dequantization scale; undefined on float nodes
	invMag?: number; // cached 1/|vector| for cosine distance; undefined on legacy nodes
	level?: number;
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
	// Index options that only affect search, not the stored graph — changing them must not trigger a
	// reindex (databases.ts persists the new value but skips rebuilding). efConstructionSearch is the
	// search-time candidate-list size; the build uses efConstruction/M/distance, which are structural.
	static searchOnlyOptions = ['efConstructionSearch'];
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
	int8 = false; // store vectors as int8-quantized bins (set via the `quantization` index option)
	efSearchConfigured = false; // whether the schema set an explicit search ef; if not, search ef auto-scales with N
	constructor(indexStore: any, options: any) {
		this.indexStore = indexStore;
		if (indexStore) {
			// use float32 representation of numbers as it is twice as space efficient as typical float64 and plenty accurate
			// (we would actually like to use float16 if it were available)
			this.indexStore.encoder.useFloat32 = FLOAT32_OPTIONS.ALWAYS;
		}
		this.int8 = options?.quantization === 'int8';
		// Respect an explicitly-configured search ef (or efConstruction, which seeds it); otherwise auto-scale.
		this.efSearchConfigured = options?.efConstructionSearch !== undefined || options?.efConstruction !== undefined;
		this.distance =
			options?.distance === 'euclidean'
				? euclideanDistance
				: options?.distance === 'dotProduct'
					? dotProductDistance
					: cosineDistance;
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
	index(primaryKey: Id, vector: number[], existingVector?: number[], options: any = {}) {
		// first get the node id for the primary key; we use internal node ids for better efficiency,
		// but we must use a safe key that won't collide with the node ids
		const safeKey = typeof primaryKey === 'number' ? [KEY_PREFIX, primaryKey] : primaryKey;
		let nodeId = this.indexStore.getSync(safeKey, options);
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
					transaction: options.transaction,
				})) {
					if (typeof key === 'number') largestNodeId = key;
				}

				this.idIncrementer = new BigInt64Array([BigInt(largestNodeId) + 1n]);
				this.idIncrementer = new BigInt64Array(
					this.indexStore.getUserSharedBuffer('next-id', this.idIncrementer.buffer)
				);
			}
			nodeId = Number(Atomics.add(this.idIncrementer, 0, 1n));
			this.indexStore.put(safeKey, nodeId, options);
		}
		const updatedNodes = new Map<number, Node>();
		let oldNode: Node;
		// If this is the first entry, create it as the entry point
		let entryPointId = this.indexStore.getSync(ENTRY_POINT, options);
		if (existingVector) {
			// If we are updating an existing entry, we need to update the entry point
			// if the new entry is closer to the entry point than the old one
			oldNode = { ...this.safeGetSync(nodeId, options) };
		} else oldNode = {} as Node;
		if (vector) {
			// Pre-compute 1/|vector| for cosine distance so searchLayer can skip sqrt per neighbor
			let invMag: number | undefined;
			if (this.distance === cosineDistance) {
				let magSq = 0;
				for (const v of vector) magSq += v * v;
				invMag = 1 / (Math.sqrt(magSq) || 1);
			}
			// Quantized storage form. The float `vector` is still used as the query for every
			// searchLayer call below (asymmetric distance: float query x int8 stored); only what
			// we PUT to the store is quantized.
			const q = this.int8 ? quantizeInt8(vector) : undefined;
			const storedVector: number[] | Buffer = q ? q.bytes : vector;
			const storedScale = q ? q.scale : undefined;
			let entryPoint = entryPointId && this.safeGetSync(entryPointId, options);
			if (entryPoint == null) {
				const level = Math.floor(-Math.log(Math.random()) * this.mL);
				const node = {
					vector: storedVector,
					scale: storedScale,
					invMag,
					level,
					primaryKey,
				};
				for (let i = 0; i <= level; i++) {
					node[i] = [];
				}
				this.indexStore.put(nodeId, node, options);
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				logger.debug?.('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId, options);
				return;
			}

			// Generate random level for this new element
			const level = oldNode.level ?? Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);
			let currentLevel = entryPoint.level;
			if (level > currentLevel) {
				// if we are at a higher level, make this the new entry point
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				logger.debug?.('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId, options);
			}

			// For each level from top to bottom
			while (currentLevel > level) {
				// Search for closest neighbors at current level
				const neighbors = this.searchLayer(
					vector,
					entryPointId,
					entryPoint,
					this.efConstruction,
					currentLevel,
					options
				);

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
				let neighbors = this.searchLayer(vector, entryPointId, entryPoint, this.efConstruction, l, options);
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
						for (let i2 = 0; i2 < neighborNeighbors?.length; i2++) {
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
						if (!from) from = updateNode(fromId, this.safeGetSync(fromId, options));
						if (!from) continue;
						const fromAtLevel = from[l];
						if (!fromAtLevel) continue;
						for (let i = 0; i < fromAtLevel.length; i++) {
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
						// update the distance in the reverse connection if the vector changed
						if (oldConnection.distance !== distance) {
							const neighborNode = updateNode(id, node);
							if (neighborNode[l]) {
								if (Object.isFrozen(neighborNode[l])) {
									neighborNode[l] = neighborNode[l].slice();
								}
								const reverseIdx = neighborNode[l].findIndex(({ id: nid }) => nid === nodeId);
								if (reverseIdx >= 0) {
									neighborNode[l][reverseIdx] = { id: nodeId, distance };
								}
							}
						}
					} else {
						// add new connection since this is truly a new connection now
						this.addConnection(id, updateNode(id, node), nodeId, l, distance, updateNode, options);
					}
				}
			}

			// Store the new element
			this.indexStore.put(
				nodeId,
				{
					vector: storedVector,
					scale: storedScale,
					invMag,
					level,
					primaryKey,
					...connections,
				},
				options
			);
		} else {
			// removal of this node, but first make sure we have a valid entry point
			if (entryPointId === nodeId) {
				// if this is the entry point, find a new entry point
				const lastLevel = oldNode.level ?? 0;
				for (let l = lastLevel; l >= 0; l--) {
					entryPointId = oldNode[l]?.[0]?.id;
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
					this.indexStore.remove(ENTRY_POINT, options);
				} else {
					// set the new entry point
					if (typeof entryPointId !== 'number') {
						throw new Error('Invalid nodeId: ' + entryPointId);
					}
					logger.debug?.('setting entry point to', entryPointId);
					this.indexStore.put(ENTRY_POINT, entryPointId, options);
				}
			}
			this.indexStore.remove(nodeId, options);
		}
		const needsReindexing = new Map();
		// remove connections to this node that are no longer valid
		if (oldNode.level !== undefined) {
			for (let l = 0; l <= oldNode.level; l++) {
				const oldConnections = oldNode[l];
				for (const { id: neighborId } of oldConnections) {
					// get and copy the neighbor node so we can modify it
					const neighborNode = updateNode(neighborId, this.safeGetSync(neighborId, options));
					if (!neighborNode) continue;
					for (let l2 = 0; l2 <= l; l2++) {
						// remove the connection to this node from the neighbor node
						neighborNode[l2] = neighborNode[l2]?.filter(({ id: nid }) => {
							return nid !== nodeId;
						});
						if (neighborNode[l2]?.length === 0) {
							logger.trace?.('node was left orphaned, will reindex', neighborId);
							// reindex re-feeds this vector into index() as a float query, so dequantize int8 back to float
							needsReindexing.set(
								neighborNode.primaryKey,
								neighborNode.scale !== undefined
									? dequantizeInt8(neighborNode.vector as Int8Array, neighborNode.scale)
									: neighborNode.vector
							);
						}
					}
				}
			}
		}
		function updateNode(id: number, node?: Node) {
			// keep a record of all our changes, maintaining any changes that are queued to be written
			let updatedNode: Node = updatedNodes.get(id);
			if (!updatedNode && node) {
				// copy the node so we can modify it
				updatedNode = { ...node };
				updatedNodes.set(id, updatedNode);
			}
			return updatedNode;
		}
		for (const [id, updatedNode] of updatedNodes) {
			this.indexStore.put(id, updatedNode, options);
		}
		for (const [key, vector] of needsReindexing) {
			this.index(key, vector, vector, options);
		}
		this.checkSymmetry(nodeId, this.safeGetSync(nodeId, options), options);
	}

	private safeGetSync(key: any, options?: any): any {
		try {
			const node = this.indexStore.getSync(key, options);
			// A quantized vector decodes as a bin (Uint8Array/Buffer) that is a view into the
			// store's read buffer, which may be reused on the next getSync — so copy the bytes
			// into a retained Int8Array (raw two's-complement reinterpret). The Int8Array guard
			// skips re-conversion when the object store (useObjectStore) hands back an
			// already-converted cached node. Float nodes (vector is a number[]) pass through.
			if (node && node.vector && !Array.isArray(node.vector) && !(node.vector instanceof Int8Array)) {
				const u8 = node.vector as Uint8Array;
				node.vector = new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength).slice();
			}
			return node;
		} catch {
			logger.warn?.('Failed to decode HNSW node, skipping', key);
			return undefined;
		}
	}

	private getEntryPoint(options: { transaction?: any } = {}) {
		// Get entry point
		const entryPointId = this.indexStore.getSync(ENTRY_POINT, options);
		if (entryPointId === undefined) return;
		const node = this.safeGetSync(entryPointId, options);
		if (!node) return;
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
	 * @param options
	 * @private
	 */
	private searchLayer(
		queryVector: number[],
		entryPointId: number,
		entryPoint: any,
		ef: number,
		level: number,
		options: { transaction?: any } = {},
		distanceFunction = this.distance
	): SearchResults {
		// Pre-compute query magnitude for cosine; use cached invMag on stored nodes to skip sqrt per neighbor.
		// Asymmetric distance: the query stays full-precision float; a stored neighbor may be int8
		// (with per-vector `scaleB`) or float (`scaleB` undefined).
		let computeDistance: (b: number[] | Int8Array, invMagB?: number, scaleB?: number) => number;
		if (distanceFunction === cosineDistance) {
			let magASq = 0;
			for (const v of queryVector) magASq += v * v;
			const invMagA = 1 / (Math.sqrt(magASq) || 1);
			computeDistance = (b: number[] | Int8Array, invMagB?: number, scaleB?: number) => {
				let dot = 0;
				for (let i = 0; i < b.length; i++) dot += queryVector[i] * (b[i] as number);
				if (scaleB !== undefined) dot *= scaleB; // dequantize the int8 dot product
				if (invMagB !== undefined) return 1 - dot * invMagA * invMagB;
				// Fallback when the stored node has no cached invMag (a non-cosine index queried as
				// cosine). Compute the stored magnitude and dequantize it by scaleB so it matches the
				// already-dequantized dot product.
				let magBSq = 0;
				for (let i = 0; i < b.length; i++) magBSq += (b[i] as number) * (b[i] as number);
				let magB = Math.sqrt(magBSq) || 1;
				if (scaleB !== undefined) magB *= scaleB;
				return 1 - (dot * invMagA) / magB;
			};
		} else if (distanceFunction === euclideanDistance) {
			// Asymmetric squared-euclidean, dequantizing each int8 component inline (no allocation).
			computeDistance = (b: number[] | Int8Array, _invMagB?: number, scaleB?: number) => {
				if (scaleB === undefined) return distanceFunction(queryVector, b as number[]);
				let distanceSquared = 0;
				for (let i = 0; i < b.length; i++) {
					const diff = queryVector[i] - (b[i] as number) * scaleB;
					distanceSquared += diff * diff;
				}
				return distanceSquared;
			};
		} else {
			// Negated inner product, dequantizing the int8 dot product inline (no allocation).
			computeDistance = (b: number[] | Int8Array, _invMagB?: number, scaleB?: number) => {
				if (scaleB === undefined) return distanceFunction(queryVector, b as number[]);
				let dot = 0;
				for (let i = 0; i < b.length; i++) dot += queryVector[i] * (b[i] as number);
				return -(dot * scaleB);
			};
		}

		const visited = new Set([entryPointId]);
		const initialCandidate: Candidate = {
			id: entryPointId,
			distance: computeDistance(entryPoint.vector, entryPoint.invMag, entryPoint.scale),
			node: entryPoint,
		};

		const candidates = new MinHeap();
		candidates.push(initialCandidate);
		const results = [initialCandidate] as SearchResults;

		while (candidates.size > 0) {
			const current = candidates.pop()!;
			const furthestDistance = results[results.length - 1].distance;

			if (current.distance > furthestDistance) break;

			for (const { id: neighborId } of current.node[level] || []) {
				if (visited.has(neighborId) || neighborId === undefined) continue;
				visited.add(neighborId);

				const neighbor = this.safeGetSync(neighborId, options);
				if (!neighbor) continue;
				this.nodesVisitedCount++;
				const distance = computeDistance(neighbor.vector, neighbor.invMag, neighbor.scale);

				if (distance < furthestDistance || results.length < ef) {
					const candidate: Candidate = { id: neighborId, distance, node: neighbor };
					candidates.push(candidate);
					results.splice(bisectInsert(results, distance), 0, candidate);
					if (results.length > ef) results.pop();
				}
			}
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
			ef,
		}: {
			target: number[];
			value: number;
			descending: boolean;
			distance: string;
			comparator: string;
			ef?: number;
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
		else if (distance === 'dotProduct') distanceFunction = dotProductDistance;
		else if (distance) throw new ClientError('Unknown distance function');
		else distanceFunction = this.distance;
		if (!target) throw new ClientError('A target vector must be provided for an HNSW query');
		if (!Array.isArray(target)) throw new ClientError('The target vector must be an array');

		const options = context.transaction; // should have a nested RocksDB transaction
		// Resolve search ef: per-query ef wins; else an explicitly-configured efConstructionSearch;
		// else auto-scale with the graph size so recall holds as the table grows.
		let effectiveEf = this.efConstructionSearch;
		if (ef !== undefined && ef > 0) effectiveEf = ef;
		else if (!this.efSearchConfigured) {
			const nodeCount = this.indexStore.getKeysCount
				? this.indexStore.getKeysCount()
				: (this.indexStore.getStats?.().entryCount ?? 0);
			effectiveEf = autoScaleEf(nodeCount);
		}
		let entryPoint = this.getEntryPoint(options);
		if (!entryPoint) return [];
		let entryPointId = entryPoint.id;
		let results: Candidate[] = [];
		// For each level from top to bottom
		for (let l = entryPoint.level; l >= 0; l--) {
			// Search for closest neighbors at current level
			results = this.searchLayer(target, entryPointId, entryPoint, effectiveEf, l, options, distanceFunction);

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
	private checkSymmetry(id, node, options) {
		if (!node) return;
		let l = 0;
		let connections: Candidate[];
		while ((connections = node[l])) {
			// verify that the level is not empty, otherwise this means we have an orphaned node
			if (connections.length === 0) break;
			for (const { id: neighbor } of connections) {
				const neighborNode = this.safeGetSync(neighbor, options);
				if (!neighborNode) {
					logger.info?.('could not find neighbor node', neighbor);
					continue;
				}
				// verify that the connection is symmetrical
				const symmetrical = neighborNode[l]?.find(({ id: nid }) => nid == id);
				if (!symmetrical) {
					logger.info?.('asymmetry detected', neighborNode[l], 'does not have', id);
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
		updateNode: (id: number, node?: Node) => any,
		options: any
	) {
		if (!node[level]) {
			node[level] = [];
		}

		let maxConnections = level === 0 ? this.M << 1 : this.M;
		if (this.optimizeRouting) maxConnections <<= 2; // bump up the max connections beyond traditional HNSW because we are naturally limiting
		// have we exceeded the max connections (with 25% grace period)
		if (node[level].length >= maxConnections + (maxConnections >> 2)) {
			logger.debug?.('maxConnections reached, removing some connections', maxConnections);
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
				let removedNode = updateNode(removed.id) ?? this.safeGetSync(removed.id, options);
				if (removedNode) {
					// Remove the reverse connection if it exists
					if (removedNode[level]) {
						const filtered = removedNode[level].filter(({ id }) => id !== fromId);
						if (level === 0 && filtered.length === 0) {
							// don't remove the last connection at level 0 — it would orphan this node
							logger.info?.('skipping removal of last connection', fromId, toId);
						} else {
							removedNode = updateNode(removed.id, removedNode);
							removedNode[level] = filtered;
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

		//this.indexStore.put(fromId, node, options);
		//this.checkSymmetry(fromId, node, options);
	}
	validateConnectivity(startLevel: number = 0) {
		const entryPoint = this.getEntryPoint();
		if (!entryPoint) return;
		const visited = new Set<number>();

		// BFS from entry point to ensure all nodes are reachable. Asymmetric stale neighbor
		// references can survive deletes, so a referenced node may not actually exist anymore;
		// only count a node as visited once we confirm the underlying record is present.
		const queue: number[] = [entryPoint.id];
		const enqueued = new Set<number>([entryPoint.id]);
		let connections = 0;

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const current = this.safeGetSync(currentId);
			if (!current) continue;
			visited.add(currentId);

			for (let level = startLevel; level <= current.level; level++) {
				for (const { id: neighborId } of current[level] || []) {
					connections++;
					if (!enqueued.has(neighborId)) {
						enqueued.add(neighborId);
						queue.push(neighborId);
					}
				}
			}
		}

		// Check if all nodes are reachable
		// This would require maintaining a separate set/count of all nodes
		return {
			isFullyConnected: visited.size === this.totalNodes,
			averageConnections: connections / visited.size,
		};
	}
	get totalNodes() {
		return Array.from(this.indexStore.getKeys({ start: 0, end: Infinity })).length;
	}

	/**
	 * This is used by the query planner to determine what order to apply conditions. It is our best guess at an estimated count.
	 * This unit is typically the number of records that need to be accessed to satisfy the query. We know that we will visit
	 * a minimum of efConstructionSearch nodes and a maximum of the total nodes (in absolute worst case).
	 * The original paper described the complexity as polylogarithmic. From my testing, the
	 * best and simplest guess at the number of nodes that need to be accessed is the geometric mean of the total number of nodes
	 * and the efConstruction parameter (for search), which clearly constrains the estimate to the correct range and is
	 * similar to polylogarithmic for realistic values.
	 *
	 * @returns
	 */
	estimateCountAsSort() {
		const count =
			this.indexStore instanceof RocksDatabase ? this.indexStore.getKeysCount() : this.indexStore.getStats().entryCount;
		return Math.sqrt(count * this.efConstructionSearch);
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
				distanceFunction =
					sortDefinition.distance === 'euclidean'
						? euclideanDistance
						: sortDefinition.distance === 'dotProduct'
							? dotProductDistance
							: cosineDistance;
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
