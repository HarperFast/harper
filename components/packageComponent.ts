import { join, relative, sep } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { lstatSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
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
 * excluded the whole tree. Shared by the stream packer and the size walk so the two cannot diverge.
 */
function isExcluded(directory: string, fullPath: string, options: PackageOptions): boolean {
	if (!options.skip_node_modules) return false;
	const rel = relative(directory, fullPath);
	return rel.split(sep).includes('node_modules') || rel.includes(WEBPACK_CACHE_SEGMENT);
}

/**
 * A dangling symlink is one whose target does not exist. Under tar-fs's `dereference: true`
 * mode (our default), such a link makes the walker's `fs.stat` throw ENOENT, which tar-fs
 * treats as end-of-stream: it *finalizes the archive early*, silently dropping every entry
 * queued after the link — with no error emitted. Detecting and skipping these links keeps the
 * package complete. Returns `false` for non-symlinks and for symlinks whose target resolves.
 */
function isDanglingSymlink(fullPath: string): boolean {
	try {
		if (!lstatSync(fullPath).isSymbolicLink()) return false;
	} catch {
		return false; // unreadable — leave it for the packer's own stat handling
	}
	try {
		statSync(fullPath); // follows the link; throws if the target is missing
		return false;
	} catch {
		return true;
	}
}

/**
 * Package a directory into a tar+gzip stream. The returned Readable can be
 * piped directly into an HTTP request body, avoiding the Node.js 2GB Buffer
 * cap that the buffered variant runs into for large components.
 *
 * @param onBytes - Optional callback invoked with the byte length of each raw
 *   tar chunk *before* gzip compression. Useful for tracking upload progress
 *   against an uncompressed-size total (e.g. from `getPackagedDirectorySize`).
 */
export function streamPackagedDirectory(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS,
	onBytes?: (n: number) => void
): Readable {
	const dereference = !options.skip_symlinks;
	const packStream = tar.pack(directory, {
		dereference,
		ignore: (name: string) => {
			if (isExcluded(directory, name, options)) return true;
			// Under dereference a dangling symlink silently truncates the archive (tar-fs
			// finalizes early on the target's ENOENT), so skip it. When not dereferencing,
			// tar-fs packs the link literally and never stats the target — nothing to guard.
			return dereference && isDanglingSymlink(name);
		},
		map: (header) => {
			if (header.type === 'directory') {
				header.mode = 0o755;
			}
			return header;
		},
	});
	const gzip = createGzip();
	// Propagate pack errors onto the gzip stream so a single consumer can listen
	packStream.on('error', (err) => gzip.destroy(err));
	if (onBytes) {
		// Attaching a 'data' listener after pipe() is safe — the stream is already
		// in flowing mode and Node's EventEmitter supports multiple listeners.
		packStream.on('data', (chunk: Buffer) => onBytes(chunk.length));
	}
	return packStream.pipe(gzip);
}

/**
 * Walk `directory` and return the total uncompressed size of all files that
 * `streamPackagedDirectory` would include with the same options. Used by the
 * CLI to give the upload progress bar a realistic total. The uncompressed size
 * won't equal the gzipped wire size, but it gives the bar a steady trajectory:
 * the bar moves as bytes are sent and snaps to 100% when the upload finishes.
 */
export async function getPackagedDirectorySize(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<number> {
	let total = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory — skip
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (isExcluded(directory, fullPath, options)) {
				continue;
			}
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else {
				if (options.skip_symlinks && entry.isSymbolicLink()) continue;
				try {
					const s = await stat(fullPath); // follows symlinks, matching tar dereference
					total += s.size;
				} catch {
					// inaccessible file — skip
				}
			}
		}
	};
	await walk(directory);
	return total;
}

/**
 * Walk `directory` and return the relative paths of dangling symlinks that
 * `streamPackagedDirectory` would skip. The CLI uses this to warn the user before deploy,
 * since a dangling link means its intended content is absent from the package (and, before
 * the skip guard, would have silently truncated the whole tarball). Returns `[]` when
 * `skip_symlinks` is set, because links are then packed literally with no dereference.
 */
export async function findDanglingSymlinks(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<string[]> {
	if (options.skip_symlinks) return [];
	const found: string[] = [];
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
				if (isDanglingSymlink(fullPath)) found.push(relative(directory, fullPath));
			} else if (entry.isDirectory()) {
				await walk(fullPath);
			}
		}
	};
	await walk(directory);
	return found;
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
