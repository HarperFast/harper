import { join, relative, sep } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { Readable, pipeline } from 'node:stream';
import tar from 'tar-fs';
import { createGzip } from 'node:zlib';

interface PackageOptions {
	skip_node_modules?: boolean;
	skip_symlinks?: boolean;
}

const DEFAULT_OPTIONS: PackageOptions = { skip_node_modules: false, skip_symlinks: false };

const WEBPACK_CACHE_SEGMENT = join('cache', 'webpack');

/**
 * Whether `fullPath` (an absolute path under `directory`) should be excluded from the package when
 * `skip_node_modules` is set. The path is first made relative to `directory`, so packaging a component
 * that itself lives under a `node_modules/` path — i.e. any npm-installed component — does not match
 * every entry. tar-fs invokes `ignore` with the absolute path, so a substring test on it wrongly
 * excluded the whole tree. Shared by the stream packer and the directory walk so they cannot diverge.
 */
function isExcluded(directory: string, fullPath: string, options: PackageOptions): boolean {
	if (!options.skip_node_modules) return false;
	const rel = relative(directory, fullPath);
	return rel.split(sep).includes('node_modules') || rel.includes(WEBPACK_CACHE_SEGMENT);
}

export interface PackageDirectoryScan {
	/** Total uncompressed byte size of the files `streamPackagedDirectory` would pack. */
	totalSize: number;
	/**
	 * Relative paths of symlinks whose target does not exist. Under tar-fs's `dereference: true`
	 * (our default), such a link makes the walker's stat() throw ENOENT, which tar-fs treats as
	 * end-of-stream: it *finalizes the archive early*, silently dropping every entry queued after
	 * the link. `streamPackagedDirectory` skips these paths so the walk continues past them.
	 */
	danglingSymlinks: string[];
}

/**
 * Walk `directory` once, computing both the packable size total and the dangling-symlink list —
 * the two pieces of metadata the CLI's pre-deploy checks and the packer's ignore-set both need.
 * A single shared walker keeps size accounting and dangling-link detection from silently
 * diverging (e.g. one recursing into symlinked directories and the other not).
 *
 * Recurses into a *valid* symlinked directory the same way tar-fs's own dereferenced walk does
 * (readdir through the link), so a dangling symlink nested inside one is still found — otherwise
 * tar-fs would hit that nested ENOENT and truncate the archive regardless of this scan's result.
 * This mirrors tar-fs's own lack of symlink-cycle protection under `dereference`; a circular
 * symlink can already hang tar-fs's real pack walk today, so this scan doesn't guard against it
 * either — fixing that is a separate, pre-existing limitation outside this change's scope.
 */
export async function scanPackageDirectory(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<PackageDirectoryScan> {
	let totalSize = 0;
	const danglingSymlinks: string[] = [];
	const dereference = !options.skip_symlinks;

	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory — skip
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (isExcluded(directory, fullPath, options)) continue;
			if (entry.isSymbolicLink()) {
				// Without dereference, tar-fs packs the link literally and never stats the
				// target, so an unresolved link is neither a size contributor nor a hazard.
				if (!dereference) continue;
				let target;
				try {
					target = await stat(fullPath); // follows the link; throws if missing
				} catch {
					danglingSymlinks.push(relative(directory, fullPath));
					continue;
				}
				if (target.isDirectory()) {
					await walk(fullPath);
				} else {
					totalSize += target.size;
				}
			} else if (entry.isDirectory()) {
				await walk(fullPath);
			} else {
				try {
					totalSize += (await stat(fullPath)).size;
				} catch {
					// inaccessible file — skip
				}
			}
		}
	};
	await walk(directory);
	return { totalSize, danglingSymlinks };
}

/**
 * Package a directory into a tar+gzip stream. The returned Readable can be
 * piped directly into an HTTP request body, avoiding the Node.js 2GB Buffer
 * cap that the buffered variant runs into for large components.
 *
 * @param onBytes - Optional callback invoked with the byte length of each raw
 *   tar chunk *before* gzip compression. Useful for tracking upload progress
 *   against an uncompressed-size total (e.g. from `getPackagedDirectorySize`).
 * @param knownDanglingSymlinks - Skip this function's own directory scan and reuse a
 *   dangling-symlink list the caller already computed (e.g. via `scanPackageDirectory`
 *   during a prior CLI step), avoiding a second full-tree walk before packing starts.
 */
export function streamPackagedDirectory(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS,
	onBytes?: (n: number) => void,
	knownDanglingSymlinks?: string[]
): Readable {
	const dereference = !options.skip_symlinks;
	const gzip = createGzip();
	// Resolving the dangling-symlink set up front — rather than stat-ing candidates
	// synchronously from tar-fs's `ignore` callback — keeps the pack walk free of blocking
	// I/O. That matters here because this also runs server-side, inline on the shared event
	// loop, via the package_component operation.
	const dangling = knownDanglingSymlinks
		? Promise.resolve(knownDanglingSymlinks)
		: scanPackageDirectory(directory, options).then((scan) => scan.danglingSymlinks);
	dangling
		.then((danglingSymlinks) => {
			// The consumer may have already aborted (destroying gzip) while the prescan was
			// still resolving — skip starting a directory walk nothing will read.
			if (gzip.destroyed) return;
			const danglingSet = new Set(danglingSymlinks);
			const packStream = tar.pack(directory, {
				dereference,
				ignore: (name: string) =>
					isExcluded(directory, name, options) || (dereference && danglingSet.has(relative(directory, name))),
				map: (header) => {
					if (header.type === 'directory') {
						header.mode = 0o755;
					}
					return header;
				},
			});
			if (onBytes) {
				packStream.on('data', (chunk: Buffer) => onBytes(chunk.length));
			}
			// pipeline (rather than a bare .pipe()) destroys both streams on either side
			// erroring or the consumer aborting mid-stream, so an aborted upload doesn't leave
			// the directory walk running in the background. The callback is a no-op: pipeline
			// already surfaces the failure by destroying `gzip` with the error itself.
			pipeline(packStream, gzip, () => {});
		})
		.catch((err) => gzip.destroy(err));
	return gzip;
}

/**
 * Total uncompressed size of the files `streamPackagedDirectory` would include with the same
 * options. Used by the CLI to give the upload progress bar a realistic total. The uncompressed
 * size won't equal the gzipped wire size, but it gives the bar a steady trajectory: the bar
 * moves as bytes are sent and snaps to 100% when the upload finishes.
 */
export async function getPackagedDirectorySize(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<number> {
	return (await scanPackageDirectory(directory, options)).totalSize;
}

/**
 * Relative paths of dangling symlinks that `streamPackagedDirectory` would skip. The CLI uses
 * this to warn the user before deploy, since a dangling link means its intended content is
 * absent from the package (and, before the skip guard, would have silently truncated the whole
 * tarball). Returns `[]` when `skip_symlinks` is set, because links are then packed literally
 * with no dereference.
 */
export async function findDanglingSymlinks(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<string[]> {
	return (await scanPackageDirectory(directory, options)).danglingSymlinks;
}

/**
 * Package a directory into a tar+gzip buffer. Retained for callers that need
 * an in-memory payload (small deploys, tests). For large directories prefer
 * `streamPackagedDirectory` to avoid the Buffer size ceiling.
 */
export function packageDirectory(directory: string, options: PackageOptions = DEFAULT_OPTIONS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const stream = streamPackagedDirectory(directory, options);
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}
