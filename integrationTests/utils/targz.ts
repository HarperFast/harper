import { pack } from 'tar-fs';
import { createGzip } from 'node:zlib';

/**
 * Packs and compresses a directory into a base64-encoded tar.gz string.
 *
 * @param dirPath path to directory to pack and compress
 */
export async function targz(dirPath: string): Promise<string> {
	const chunks: Buffer[] = [];
	return new Promise((resolve, reject) => {
		pack(dirPath)
			.pipe(createGzip())
			.on('data', (chunk: Buffer) => chunks.push(chunk))
			.on('end', () => {
				resolve(Buffer.concat(chunks).toString('base64'));
			})
			.on('error', reject);
	});
}
