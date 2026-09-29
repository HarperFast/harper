import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { ClientError } from '../utility/errors/hdbError.ts';
import { DEPLOYMENT_PROVENANCE_FILE } from './deploymentProvenance.ts';
import { streamPackagedDirectory } from './packageComponent.ts';

/**
 * What one deployment's tree is and what it needs to run. Written with every described build, replicated with a
 * published one, and checked wherever a node admits the build: a peer receiving it, a delayed activation, and boot.
 */
export type BuildManifest = { tree: string; platform: BuildPlatform };

export type HostPlatform = { os: string; arch: string; libc: string | null; abi: string };

type BoundField = 'os' | 'arch' | 'libc' | 'abi' | 'posix';

export type BuildPlatform = HostPlatform & {
	/** Each field the build cannot run without, with the path that requires it. */
	binds: Partial<Record<BoundField, string>>;
};

let host: HostPlatform | undefined;

export function hostPlatform(): HostPlatform {
	host ??= { os: process.platform, arch: process.arch, libc: runningLibc(), abi: process.versions.modules };
	return host;
}

function runningLibc(): string | null {
	if (process.platform !== 'linux') return null;
	const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
	if (!report) return null;
	return report.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

// Loadable modules keep the names they import and export, and an addon built against V8 cannot avoid V8's or node's
// C++ symbols, so their absence beside Node-API's is what makes an addon ABI-stable. Anything unclassified binds the ABI.
const NODE_API_MARKER = Buffer.from('napi_');
const V8_ABI_MARKERS = ['node_module_register', 'node_register_module_v', '_ZN2v8', '_ZN4node', '@v8@@', '@node@@'].map(
	(marker) => Buffer.from(marker)
);
const LONGEST_MARKER = Math.max(NODE_API_MARKER.length, ...V8_ABI_MARKERS.map((marker) => marker.length));

/** Reads an addon as it streams by, keeping enough of each chunk's end to find a marker a chunk boundary splits. */
class AddonLinkage {
	#tail = Buffer.alloc(0);
	#nodeApi = false;
	#v8 = false;

	update(chunk: Buffer): void {
		// Only the seam is copied: the previous chunk's end and this one's start.
		const seam = this.#tail.length ? Buffer.concat([this.#tail, chunk.subarray(0, LONGEST_MARKER - 1)]) : undefined;
		const holds = (marker: Buffer) => chunk.includes(marker) || !!seam?.includes(marker);
		this.#nodeApi ||= holds(NODE_API_MARKER);
		this.#v8 ||= V8_ABI_MARKERS.some(holds);
		const window = seam && chunk.length < LONGEST_MARKER - 1 ? seam : chunk;
		this.#tail = Buffer.from(window.subarray(Math.max(0, window.length - LONGEST_MARKER + 1)));
	}

	get bindsAbi(): boolean {
		return !this.#nodeApi || this.#v8;
	}
}

function isNativeBinary(head: Buffer): boolean {
	if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // PE
	if (head.length < 4) return false;
	const magic = head.readUInt32BE(0);
	return (
		magic === 0x7f454c46 || // ELF
		magic === 0xfeedface ||
		magic === 0xfeedfacf ||
		magic === 0xcefaedfe ||
		magic === 0xcffaedfe ||
		magic === 0xcafebabe // Mach-O, thin or fat
	);
}

function declaresPlatform(manifest: Buffer): boolean {
	let parsed: any;
	try {
		parsed = JSON.parse(manifest.toString('utf8'));
	} catch {
		return false;
	}
	return (
		!!parsed &&
		typeof parsed === 'object' &&
		['os', 'cpu', 'libc'].some((field) => {
			const value = parsed[field];
			return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
		})
	);
}

const INVENTORY_CONCURRENCY = 32;
// Only a package.json is held whole, to be parsed; one larger than this is bound as if it declared a platform.
const MANIFEST_READ_LIMIT = 1024 * 1024;

type InventoryRecord = { path: string; key: Buffer; fields: unknown[] };

/**
 * Derive a tree's manifest. The digest covers every path, file content, link target and owner-exec bit, in a canonical
 * encoding: one JSON record per line, so no name can spell another record, sorted by the path's UTF-8 bytes.
 *
 * Excluded exactly as the pack excludes: the provenance marker and the loader's `node_modules/harper`. The loader
 * re-points `node_modules/harperdb` whenever it exists, so only its presence is identity, and creates
 * `node_modules` itself, so only what it holds is. Sockets are skipped, as tar-fs skips them. Links are recorded,
 * never followed.
 */
export async function inventoryBuild(
	treePath: string,
	options: { uninspectableInstall?: string } = {}
): Promise<BuildManifest> {
	const records: InventoryRecord[] = [];
	const files: InventoryRecord[] = [];
	const binds: BuildPlatform['binds'] = {};
	const bind = (fields: readonly BoundField[], path: string) => {
		for (const field of fields) {
			const current = binds[field];
			if (current === undefined || path < current) binds[field] = path;
		}
	};
	if (options.uninspectableInstall) bind(['os', 'arch', 'libc', 'abi'], options.uninspectableInstall);
	// A tree built on Windows holds nothing Windows cannot, whatever its links and modes say.
	const bindPosix = process.platform === 'win32' ? () => {} : (path: string) => bind(['posix'], path);
	const record = (path: string, fields: unknown[]) => {
		const entry = { path, key: Buffer.from(path), fields };
		records.push(entry);
		return entry;
	};

	const walk = async (dirPath: string, relativeDir: string): Promise<void> => {
		for (const entry of await readdir(dirPath, { withFileTypes: true })) {
			const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (path === DEPLOYMENT_PROVENANCE_FILE || path === 'node_modules/harper') continue;
			const entryPath = join(dirPath, entry.name);
			if (path === 'node_modules/harperdb') {
				record(path, ['P', path]);
			} else if (entry.isSymbolicLink()) {
				record(path, ['L', path, await readlink(entryPath)]);
				bindPosix(path);
			} else if (entry.isDirectory()) {
				// Every load creates the component's own `node_modules`, to link the install into, so the directory
				// alone says nothing about the build.
				if (path !== 'node_modules') record(path, ['D', path]);
				await walk(entryPath, path);
			} else if (entry.isFile()) {
				files.push(record(path, []));
			} else if (!entry.isSocket()) {
				record(path, ['S', path]);
			}
		}
	};
	await walk(treePath, '');

	let next = 0;
	const hashFiles = async () => {
		while (next < files.length) {
			const file = files[next++];
			const filePath = join(treePath, ...file.path.split('/'));
			const stats = await lstat(filePath);
			const executable = (stats.mode & 0o100) !== 0;
			if (executable) bindPosix(file.path);
			const name = file.path.slice(file.path.lastIndexOf('/') + 1);
			const hash = createHash('sha256');
			let head: Buffer | undefined;
			if (name === 'package.json' && stats.size <= MANIFEST_READ_LIMIT) {
				const content = await readFile(filePath);
				hash.update(content);
				head = content;
				if (declaresPlatform(content)) bind(['os', 'arch', 'libc'], file.path);
			} else {
				const addon = name.endsWith('.node') ? new AddonLinkage() : undefined;
				for await (const chunk of createReadStream(filePath)) {
					head ??= chunk as Buffer;
					hash.update(chunk as Buffer);
					addon?.update(chunk as Buffer);
				}
				if (addon) bind(addon.bindsAbi ? ['os', 'arch', 'libc', 'abi'] : ['os', 'arch', 'libc'], file.path);
				else if (name === 'package.json') bind(['os', 'arch', 'libc'], file.path);
			}
			if (head && isNativeBinary(head)) bind(['os', 'arch', 'libc'], file.path);
			file.fields = ['F', file.path, executable ? 1 : 0, hash.digest('hex')];
		}
	};
	await Promise.all(Array.from({ length: Math.min(INVENTORY_CONCURRENCY, files.length) }, hashFiles));

	records.sort((left, right) => Buffer.compare(left.key, right.key));
	const tree = createHash('sha256');
	for (const entry of records) tree.update(`${JSON.stringify(entry.fields)}\n`);
	return { tree: tree.digest('hex'), platform: { ...hostPlatform(), binds } };
}

const FIELD_LABELS: Record<Exclude<BoundField, 'posix'>, string> = {
	os: 'OS',
	arch: 'CPU architecture',
	libc: 'libc',
	abi: 'Node ABI',
};

export function platformRefusal(
	built: BuildPlatform,
	here: HostPlatform = hostPlatform(),
	onWindows = process.platform === 'win32'
): string | undefined {
	const mismatches: string[] = [];
	for (const field of ['os', 'arch', 'libc', 'abi'] as const) {
		const requiredBy = built.binds[field];
		if (requiredBy !== undefined && built[field] !== here[field]) {
			mismatches.push(
				`${FIELD_LABELS[field]} ${built[field] ?? 'unknown'} (required by ${requiredBy}), and this node has ` +
					`${here[field] ?? 'an unknown one'}`
			);
		}
	}
	if (built.binds.posix !== undefined && onWindows) {
		mismatches.push(`links and executable permissions (required by ${built.binds.posix}), which Windows cannot hold`);
	}
	return mismatches.length ? `it was built for ${mismatches.join('; ')}` : undefined;
}

const TREE_DIGEST = /^[0-9a-f]{64}$/;
const BOUND_FIELDS = new Set<string>(['os', 'arch', 'libc', 'abi', 'posix']);

export function isBuildManifest(value: unknown): value is BuildManifest {
	const manifest = value as BuildManifest;
	if (!manifest || typeof manifest !== 'object' || typeof manifest.tree !== 'string') return false;
	if (!TREE_DIGEST.test(manifest.tree)) return false;
	const platform = manifest.platform;
	if (!platform || typeof platform !== 'object') return false;
	if (typeof platform.os !== 'string' || typeof platform.arch !== 'string' || typeof platform.abi !== 'string') {
		return false;
	}
	if (platform.libc !== null && typeof platform.libc !== 'string') return false;
	const binds = platform.binds;
	if (!binds || typeof binds !== 'object' || Array.isArray(binds)) return false;
	return Object.entries(binds).every(([field, path]) => BOUND_FIELDS.has(field) && typeof path === 'string');
}

/** `skip_symlinks` only stops links being followed: they are packed as links. */
export function packBuild(candidateDirPath: string): Readable {
	return streamPackagedDirectory(candidateDirPath, { skip_node_modules: false, skip_symlinks: true }, undefined, []);
}

/**
 * Pass an archive through unchanged, failing at its end when it is not the one the origin published. Only a whole
 * archive can be checked, so whatever consumed it must discard its output when this fails.
 */
export function verifiedArchive(expected: { sha256: string; size: number }): Transform {
	const hash = createHash('sha256');
	let size = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			size += chunk.length;
			callback(null, chunk);
		},
		flush(callback) {
			const sha256 = hash.digest('hex');
			if (sha256 === expected.sha256 && size === expected.size) return callback();
			callback(
				new ClientError(
					`The build received (${size} bytes, sha256 ${sha256}) is not the one its origin published ` +
						`(${expected.size} bytes, sha256 ${expected.sha256})`,
					409
				)
			);
		},
	});
}
