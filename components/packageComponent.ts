import { join } from 'path';
import { Readable } from 'node:stream';
import { readdir, stat } from 'node:fs/promises';
import tar from 'tar-fs';
import { createGzip } from 'node:zlib';

interface PackageOptions {
	skip_node_modules?: boolean;
	skip_symlinks?: boolean;
}

const DEFAULT_OPTIONS: PackageOptions = { skip_node_modules: false, skip_symlinks: false };

/**
 * Package a directory into a tar+gzip stream. The returned Readable can be
 * piped directly into an HTTP request body, avoiding the Node.js 2GB Buffer
 * cap that the buffered variant runs into for large components.
 */
export function streamPackagedDirectory(directory: string, options: PackageOptions = DEFAULT_OPTIONS): Readable {
	const packStream = tar.pack(directory, {
		dereference: !options.skip_symlinks,
		ignore: options.skip_node_modules
			? (name: string) => {
					return name.includes('node_modules') || name.includes(join('cache', 'webpack'));
				}
			: undefined,
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
	return packStream.pipe(gzip);
}

/**
 * Compute the total uncompressed size in bytes of files that `streamPackagedDirectory`
 * would include for the same options. Used by the CLI to drive an upload progress bar:
 * we count bytes flowing through the tar source (pre-gzip), so a percentage against this
 * total represents "how much of the source tree has been read", which is what users want
 * to see during a long deploy. The on-the-wire (gzipped) size will be smaller, so the
 * bar may finish slightly before the request actually completes — acceptable trade-off
 * versus walking twice or buffering.
 *
 * Symlinks are stat'd (not lstat'd) when `skip_symlinks` is false, matching tar-fs's
 * `dereference: !skip_symlinks` behavior. Errors on individual entries are swallowed so
 * a transient stat failure doesn't block the deploy — total is best-effort.
 */
export async function getPackagedDirectorySize(
	directory: string,
	options: PackageOptions = DEFAULT_OPTIONS
): Promise<number> {
	const skipNodeModules = options.skip_node_modules === true;
	const dereference = options.skip_symlinks !== true;
	const statFn = dereference ? stat : (await import('node:fs/promises')).lstat;
	let total = 0;
	async function walk(current: string, rel: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relPath = rel ? join(rel, entry.name) : entry.name;
			if (skipNodeModules && (relPath.includes('node_modules') || relPath.includes(join('cache', 'webpack')))) {
				continue;
			}
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full, relPath);
			} else if (entry.isFile() || (dereference && entry.isSymbolicLink())) {
				try {
					const s = await statFn(full);
					if (s.isFile()) total += s.size;
				} catch {
					/* skip unreadable entries — don't block the deploy on a best-effort total */
				}
			}
		}
	}
	await walk(directory, '');
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
