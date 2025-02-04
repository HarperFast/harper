import path from 'path';
import tar from 'tar-fs';
import { lstatSync } from 'node:fs';
import { createGzip } from 'node:zlib';

/**
 * Package a directory into a tarball, base64 encoded
 * @param directory
 */
export function packageDirectory(
	directory: string,
	options: { skip_node_modules?: boolean; hidden_folders?: boolean }
): Promise<Buffer> {
	const { skip_node_modules, hidden_folders } = options;
	return new Promise((resolve, reject) => {
		// for deploy_component to a remote server, we need to tar the local directory
		const tar_opts = skip_node_modules
			? {
					ignore: (name: string) => {
						return name.includes(path.join('node_modules')) || name.includes(path.join('cache', 'webpack'));
					},
				}
			: {};
		const chunks = [];
		// pack the directory
		tar
			.pack(directory, tar_opts)
			.pipe(createGzip())
			.on('data', (chunk: Buffer) => chunks.push(chunk))
			.on('end', () => {
				const tarball = Buffer.concat(chunks);
				resolve(tarball);
			})
			.on('error', reject);
	});
}
function isDirectory(path) {
	return lstatSync(path).isDirectory();
}
