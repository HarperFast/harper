import { join, relative, sep } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
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
	const packStream = tar.pack(directory, {
		dereference: !options.skip_symlinks,
		ignore: (name: string) => isExcluded(directory, name, options),
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
