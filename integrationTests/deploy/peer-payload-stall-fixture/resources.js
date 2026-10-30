import { Resource, databases, logger } from 'harper';
import { basename, dirname } from 'node:path';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';

const HEADER_SIZE = 8;
const RELEASE_POLL_MS = 50;
const MAX_WITHHOLD_MS = 60_000;

// Components see only the `harper` package exports, so the blob's file id is recovered from its path: the inverse of
// resources/blob.ts getFilePath. A wrong id locks an unrelated key, so the read sees no writer and fails the deploy as
// an incomplete blob (500) instead of stalling.
function fileIdFromPath(path) {
	const outer = basename(dirname(dirname(path)));
	const inner = basename(dirname(path));
	const leaf = basename(path);
	if (leaf.length > 3) return leaf.slice(0, -3) + outer + inner + leaf.slice(-3);
	return [outer, inner].filter((segment) => segment !== '0').join('') + leaf;
}

/**
 * Puts a stored payload blob into the state a peer's replication receive leaves it in while the content is in flight —
 * the header (with the final size) on disk, no content bytes, the writer lock held — until a file appears at
 * `releasePath`. Then it writes the content back and releases the lock, as the receive does when the bytes land. The
 * thread holding the lock does the release, so the signal is a file the test writes rather than a second request.
 */
export class WithholdPayloadBlob extends Resource {
	static async post(target, data) {
		const { path, releasePath } = await data;
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
		const giveUpAt = Date.now() + MAX_WITHHOLD_MS;
		const land = () => {
			if (!existsSync(releasePath) && Date.now() < giveUpAt) {
				setTimeout(land, RELEASE_POLL_MS).unref();
				return;
			}
			try {
				const written = writeSync(fd, content, 0, content.length, HEADER_SIZE);
				if (written !== content.length) throw new Error(`wrote ${written} of ${content.length} bytes`);
			} catch (error) {
				logger.error?.(`WithholdPayloadBlob could not write the content of ${path} back`, error);
			} finally {
				closeSync(fd);
				store.unlock(lockKey);
			}
		};
		land();
		return { lockKey, contentSize: content.length };
	}
}
