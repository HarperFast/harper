import { closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const logger = loggerWithTag('HNSW');

export interface PlaneSearchHit {
	id: number;
	distance: number;
}

/**
 * NAPI surface of the native HNSW traversal plane (`@harperfast/hnsw`). Dual-write phase 1 uses
 * only the raw mirroring calls (host-allocated ids; the plane's own insert()/remove() allocator
 * path is bypassed by design) plus the search entry points.
 */
export interface HnswPlane {
	readonly dims: number;
	readonly layer0Cap: number;
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
		filterExpansion?: number | null,
		visitBudget?: number | null
	): Promise<PlaneSearchHit[]>;
	searchSync(vector: Float32Array, k: number, ef: number): PlaneSearchHit[];
	writeNodeRawIfAbsent(
		id: number,
		level: number,
		vector: Buffer,
		scale: number,
		invMag: number,
		neighbors: Uint32Array,
		upper: Uint32Array[] | null
	): boolean;
	openedClean(): boolean;
	idHighWater(): number;
	getWatermark(): number;
	setWatermark(txn: number): void;
	flush(watermark?: number): void;
	flushAsync(watermark?: number): Promise<void>;
	invalidateFile(): PlaneInvalidationOutcome;
	invalidated(): boolean;
}

export interface HnswPlaneConstructor {
	create(path: string, dims: number, layer0Cap: number, maxNodes: number): HnswPlane;
	open(path: string): HnswPlane;
}

export interface PlaneInvalidationOutcome {
	inBand: boolean;
	sidecar: boolean;
	inBandError?: string;
	sidecarError?: string;
}

interface HnswPlanePackage {
	Plane: HnswPlaneConstructor;
	invalidatePlane(path: string): PlaneInvalidationOutcome;
	stalePathFor(path: string): string;
}

/** Entry-point id meaning "none" (u32::MAX in the plane header). */
export const PLANE_NO_ID = 0xffffffff;

/**
 * Where an index's plane file lives: next to its store, named by the dbiKey
 * (`table/attribute`, flattened to a single file name). Exposed separately from the index
 * instance so crash-recovery drop paths can remove the file without opening the index.
 */
export function planeFilePathFor(storePath: string, storeName: string): string {
	// encodeURIComponent is injective and never emits a path separator: table `a` attribute
	// `b.c` and table `a.b` attribute `c` must not share a plane file (dot-flattening let two
	// indexes serve each other's node ids as their own primary keys)
	return join(storePath, `${encodeURIComponent(storeName)}.hnsw`);
}

/**
 * Tombstone marking a plane file that could not be deleted (e.g. Windows EBUSY while still
 * mapped). Its presence means the plane file is STALE: never open it — delete both when
 * possible and rebuild.
 */
export function planeStalePathFor(planePath: string): string {
	// the package owns the convention; the literal covers the calls that precede its load
	return binding?.stalePathFor(planePath) ?? `${planePath}.stale`;
}

let binding: HnswPlanePackage | null | undefined;

function getHnswPackage(): HnswPlanePackage | null {
	if (binding !== undefined) return binding;
	try {
		binding = require('@harperfast/hnsw') as HnswPlanePackage;
	} catch (error) {
		binding = null;
		logger.warn?.(
			`The @harperfast/hnsw native module is not available (${(error as Error).message}); ` +
				'indexes with nativePlane enabled will use the JS search path'
		);
	}
	return binding;
}

/** The native plane constructor, or null when the compiled artifact is unavailable (warns once). */
export function getPlaneBinding(): HnswPlaneConstructor | null {
	return getHnswPackage()?.Plane ?? null;
}

/** Make a derived plane unadoptable before mirroring stops. */
export function invalidatePlaneFile(filePath: string, attached?: HnswPlane | null): PlaneInvalidationOutcome {
	if (attached) return attached.invalidateFile();
	const hnswPackage = getHnswPackage();
	if (hnswPackage) return hnswPackage.invalidatePlane(filePath);
	// A plane can outlive the package that made it (uninstall, or a prebuild that stopped
	// loading), and a reinstall would then adopt it. Only the sidecar is reachable without the
	// package, and it has to survive a power loss to be worth writing, so fsync it and the
	// directory entry that names it — the same durability the package's own sidecar has.
	const fd = openSync(planeStalePathFor(filePath), 'w');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		const dirFd = openSync(dirname(filePath), 'r');
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// Windows cannot open a directory as a file; it also does not need this — the metadata
		// journal already orders the create ahead of anything that could read the sidecar
	}
	return { inBand: false, sidecar: true };
}
