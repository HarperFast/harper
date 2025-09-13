import { join } from 'path';
import tar from 'tar-fs';
import { createGzip } from 'node:zlib';

/**
 * Package a directory into a tarball, base64 encoded
 * @param directory
 */
export function packageDirectory(
	directory: string,
	options: { skip_node_modules?: boolean, skip_symlinks?: boolean } = { skip_node_modules: false, skip_symlinks: false }
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// for deploy_component to a remote server, we need to tar the local directory
		const chunks = [];
		// pack the directory
		tar
			.pack(directory, {
				dereference: !options.skip_symlinks,
				ignore: options.skip_node_modules ? (name: string) => {
					return name.includes('node_modules') || name.includes(join('cache', 'webpack'));
				} : undefined,
				map: (header) => {
					if (header.type === 'directory') {
						header.mode = 0o755;
					}
					return header;
				}
			})
			.pipe(createGzip())
			.on('data', (chunk: Buffer) => chunks.push(chunk))
			.on('end', () => {
				resolve(Buffer.concat(chunks));
			})
			.on('error', reject);
	});
}
