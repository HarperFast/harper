import { join } from 'path';
import tar from 'tar-fs';
import { createGzip } from 'node:zlib';

/**
 * Package a directory into a tarball, base64 encoded
 * @param directory
 */
export function packageDirectory(
	directory: string,
	options: { skipNodeModules?: boolean; skipSymlinks?: boolean } = { skipNodeModules: false, skipSymlinks: false }
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// for deployComponent to a remote server, we need to tar the local directory
		const chunks = [];
		// pack the directory
		tar
			.pack(directory, {
				dereference: !options.skip_symlinks,
				ignore: options.skip_node_modules
					? (name: string) => {
							return name.includes('node_modules') || name.includes(join('cache', 'webpack'));
						}
					: undefined,
			})
			.pipe(createGzip())
			.on('data', (chunk: Buffer) => chunks.push(chunk))
			.on('end', () => {
				resolve(Buffer.concat(chunks));
			})
			.on('error', reject);
	});
}
