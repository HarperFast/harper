import { join } from 'node:path';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const logger = loggerWithTag('HNSW');

export interface PlaneSearchHit {
	id: number;
	distance: number;
}

/**
 * NAPI surface of the native HNSW traversal plane (native/hnsw-plane). Dual-write phase 1 uses
 * only the raw mirroring calls (host-allocated ids; the plane's own insert()/remove() allocator
 * path is bypassed by design) plus the search entry points.
 */
export interface HnswPlane {
	writeNodeRaw(
		id: number,
		level: number,
		vector: Buffer,
		scale: number,
		invMag: number,
		neighbors: Uint32Array,
		upper: Uint32Array[] | null
	): void;
	clearNode(id: number): void;
	setEntryPoint(id: number, level: number): void;
	getEntryPoint(): number[];
	search(
		vector: Float32Array,
		k: number,
		ef: number,
		filter?: Uint8Array | null,
		filterExpansion?: number | null
	): Promise<PlaneSearchHit[]>;
	searchWithPredicate(
		vector: Float32Array,
		k: number,
		ef: number,
		predicate: (ids: number[]) => Uint8Array,
		filterExpansion?: number | null
	): Promise<PlaneSearchHit[]>;
	searchSync(vector: Float32Array, k: number, ef: number): PlaneSearchHit[];
	idHighWater(): number;
	getWatermark(): number;
	setWatermark(txn: number): void;
	flush(): void;
}

export interface HnswPlaneConstructor {
	create(path: string, dims: number, layer0Cap: number, maxNodes: number): HnswPlane;
	open(path: string): HnswPlane;
}

/** Entry-point id meaning "none" (u32::MAX in the plane header). */
export const PLANE_NO_ID = 0xffffffff;

/**
 * Where an index's plane file lives: next to its store, named by the dbiKey
 * (`table/attribute`, flattened to a single file name). Exposed separately from the index
 * instance so crash-recovery drop paths can remove the file without opening the index.
 */
export function planeFilePathFor(storePath: string, storeName: string): string {
	return join(storePath, `${storeName.replace(/[/\\]/g, '.')}.hnsw`);
}

// The compiled artifact is optional: harper installs carry no cargo toolchain, so absence just
// means nativePlane-flagged indexes run the existing JS path. Build locally with
// `npm run build:hnsw-plane`.
const BINDING_PATH = join(PACKAGE_ROOT, 'native', 'hnsw-plane', 'hnsw-plane.node');

let binding: HnswPlaneConstructor | null | undefined;

/** The native plane constructor, or null when the compiled artifact is unavailable (warns once). */
export function getPlaneBinding(): HnswPlaneConstructor | null {
	if (binding !== undefined) return binding;
	try {
		binding = require(BINDING_PATH).Plane as HnswPlaneConstructor;
	} catch (error) {
		binding = null;
		logger.warn?.(
			`The hnsw-plane native module is not available (${(error as Error).message}); ` +
				`indexes with nativePlane enabled will use the JS search path. Build it with: npm run build:hnsw-plane`
		);
	}
	return binding;
}
