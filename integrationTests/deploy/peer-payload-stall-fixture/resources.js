import { Resource, databases, logger } from 'harper';
import { basename, dirname } from 'node:path';
import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';

const HEADER_SIZE = 8;

// Components see only the `harper` package exports, so the blob's file id is recovered from its path: the inverse of
// resources/blob.ts getFilePath, `<root>/<id[-9:-6] || '0'>/<id[-6:-3] || '0'>/<id[-3:]>`. A wrong id locks an
// unrelated key, so the read sees no writer and fails the deploy as an incomplete blob (500) instead of stalling.
function fileIdFromPath(path) {
	const outer = basename(dirname(dirname(path)));
	const inner = basename(dirname(path));
	return [outer, inner].filter((segment) => segment !== '0').join('') + basename(path);
}

/**
 * POST puts a stored payload blob into the state a peer's replication receive leaves it in while the content is in
 * flight: the header (with the final size) on disk, no content bytes, and the writer lock held. After `delayMs` it
 * writes the content back and releases the lock, as the receive does when the bytes land.
 */
export class WithholdPayloadBlob extends Resource {
	static async post(target, data) {
		const { path, delayMs } = await data;
		const store = databases.system.hdb_deployment.primaryStore.rootStore;
		const lockKey = fileIdFromPath(path) + ':blob';
		const content = readFileSync(path).subarray(HEADER_SIZE);
		if (!store.tryLock(lockKey)) throw new Error(`blob write lock ${lockKey} is already held`);
		let fd;
		try {
			fd = openSync(path, 'r+');
			ftruncateSync(fd, HEADER_SIZE);
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			store.unlock(lockKey);
			throw error;
		}
		setTimeout(() => {
			try {
				writeSync(fd, content, 0, content.length, HEADER_SIZE);
			} catch (error) {
				logger.error?.(`WithholdPayloadBlob could not write the content of ${path} back`, error);
			} finally {
				closeSync(fd);
				store.unlock(lockKey);
			}
		}, delayMs).unref();
		return { lockKey, contentSize: content.length };
	}
}
