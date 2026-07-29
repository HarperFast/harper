import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

export const COMPONENT_PREPARATION_LOCK_DIR = '.component-preparation-locks';
const LOCK_POLL_INTERVAL_MS = 50;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface ComponentPreparationLockOwner {
	pid: number;
	threadId: number;
	token: string;
}

export interface ComponentPreparationLockOptions {
	timeoutMs?: number;
	onWait?: (owner: ComponentPreparationLockOwner | null) => void;
	onReleaseError?: (error: unknown) => void;
	isOwnerAlive?: (owner: ComponentPreparationLockOwner) => boolean | Promise<boolean>;
}

export function componentPreparationLockIdentity(
	componentDirPath: string,
	platform: NodeJS.Platform = process.platform
): string {
	const canonicalPath = resolve(componentDirPath);
	return platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error.code === 'EPERM';
	}
}

async function readOwner(lockPath: string): Promise<ComponentPreparationLockOwner | null> {
	try {
		return JSON.parse(await readFile(lockPath, 'utf8'));
	} catch (error: any) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
		throw error;
	}
}

async function removeStaleLock(lockPath: string, options: ComponentPreparationLockOptions): Promise<boolean> {
	const owner = await readOwner(lockPath);
	if (!owner) return false;
	// All worker threads share a PID. Treat our own PID as authoritative instead of probing it:
	// process.kill is commonly wrapped by embedders/test harnesses, and a false negative here would
	// permit exactly the concurrent mutation this lock exists to prevent.
	let ownerExited = owner.pid !== process.pid && !isProcessAlive(owner.pid);
	if (owner.pid === process.pid && options.isOwnerAlive) {
		try {
			ownerExited = !(await options.isOwnerAlive(owner));
		} catch {
			// An unknown owner state is not permission to remove its lock.
			return false;
		}
	}
	if (!ownerExited) return false;

	const stalePath = `${lockPath}.stale-${randomUUID()}`;
	try {
		await rename(lockPath, stalePath);
	} catch (error: any) {
		if (error.code === 'ENOENT') return true;
		throw error;
	}
	await rm(stalePath, { force: true });
	return true;
}

async function acquireComponentPreparationLock(
	componentDirPath: string,
	options: ComponentPreparationLockOptions
): Promise<() => Promise<void>> {
	// Keep the key stable while a preparation replaces the path. realpath() would change from the
	// literal path to a symlink target (or back) mid-deploy and let a same-path waiter bypass the lock.
	const canonicalPath = resolve(componentDirPath);
	// Windows resolves path aliases without normalizing case. Hash a case-folded identity so two
	// accepted component names cannot bypass serialization while targeting the same directory.
	const lockIdentity = componentPreparationLockIdentity(canonicalPath);
	const lockName = createHash('sha256').update(lockIdentity).digest('hex');
	const lockRoot = join(dirname(canonicalPath), COMPONENT_PREPARATION_LOCK_DIR);
	const lockPath = join(lockRoot, lockName);
	const owner: ComponentPreparationLockOwner = {
		pid: process.pid,
		threadId,
		token: randomUUID(),
	};
	const temporaryLockPath = join(lockRoot, `.${lockName}.${owner.token}.tmp`);
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
	let deadline = performance.now() + timeoutMs;

	await mkdir(lockRoot, { recursive: true, mode: 0o700 });
	let waitingReported = false;
	let nextOwnerLivenessCheck = 0;
	for (;;) {
		try {
			// Publish a fully-written owner record atomically. A process that dies before link() can
			// leave only its uniquely-named temporary file; contenders never mistake a partial owner
			// record for the common lock.
			await writeFile(temporaryLockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
			try {
				await link(temporaryLockPath, lockPath);
			} finally {
				// The common hard link, not this uniquely-named staging file, carries ownership.
				// A cleanup failure must not turn a successfully acquired lock into an orphan.
				await rm(temporaryLockPath, { force: true }).catch(() => {});
			}
			break;
		} catch (error: any) {
			if (error.code !== 'EEXIST') throw error;
			const now = performance.now();
			if (now >= nextOwnerLivenessCheck) {
				nextOwnerLivenessCheck = now + 500;
				if (await removeStaleLock(lockPath, options)) continue;
			}
			if (!waitingReported) {
				waitingReported = true;
				options.onWait?.(await readOwner(lockPath));
			}
			if (now >= deadline) {
				const currentOwner = await readOwner(lockPath);
				if (currentOwner && options.isOwnerAlive) {
					try {
						if (await options.isOwnerAlive(currentOwner)) {
							// A known-live holder is allowed to finish; the deadline is only a backstop for an
							// owner whose liveness cannot be established.
							deadline = performance.now() + timeoutMs;
							continue;
						}
					} catch {}
				}
				throw new Error(
					`Timed out waiting for component preparation lock for ${canonicalPath}` +
						(currentOwner ? ` held by process ${currentOwner.pid}, thread ${currentOwner.threadId}` : '')
				);
			}
			await delay(LOCK_POLL_INTERVAL_MS);
		}
	}

	return async () => {
		const currentOwner = await readOwner(lockPath);
		if (currentOwner?.token !== owner.token) {
			throw new Error(`Lost ownership of component preparation lock for ${canonicalPath}`);
		}
		await rm(lockPath, { force: true });
	};
}

/**
 * Serialize destructive preparation work for one component path across Harper
 * worker threads. Different component directories remain independent and can prepare in parallel.
 */
export async function withComponentPreparationLock<T>(
	componentDirPath: string,
	prepare: () => Promise<T>,
	options: ComponentPreparationLockOptions = {}
): Promise<T> {
	const release = await acquireComponentPreparationLock(componentDirPath, options);
	let preparationFailed = false;
	try {
		return await prepare();
	} catch (error) {
		preparationFailed = true;
		throw error;
	} finally {
		try {
			await release();
		} catch (error) {
			if (!preparationFailed) throw error;
			// Preserve the preparation failure as the primary error. Reporting a secondary release
			// failure is best-effort because even an error-reporting callback must not mask it.
			try {
				options.onReleaseError?.(error);
			} catch {}
		}
	}
}
