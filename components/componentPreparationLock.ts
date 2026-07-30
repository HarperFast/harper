import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isMainThread, threadId } from 'node:worker_threads';

export const COMPONENT_PREPARATION_LOCK_DIR = '.component-preparation-locks';
const PROCESS_INSTANCE_ENV = 'HARPER_COMPONENT_PREPARATION_PROCESS_INSTANCE';
// Worker threads inherit the main thread's environment snapshot; child/restarted processes execute
// this main-thread branch and replace any inherited value, so PID reuse cannot inherit identity.
if (isMainThread) process.env[PROCESS_INSTANCE_ENV] = randomUUID();
export const COMPONENT_PREPARATION_PROCESS_INSTANCE_ID = process.env[PROCESS_INSTANCE_ENV] ?? randomUUID();
const LOCK_POLL_INTERVAL_MS = 50;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// publishClaim's write-then-rename is two syscalls with no suspension point in between, so a
// `.publishing` file surviving this long can only be a crash orphan (a write that was never
// followed by its rename), never an in-flight publish.
const STALE_PUBLISHING_SWEEP_AGE_MS = 60_000;

export interface ComponentPreparationLockOwner {
	pid: number;
	threadId: number;
	processInstanceId: string;
	token: string;
	ticket?: number;
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

export function componentPreparationLockPaths(componentDirPath: string) {
	const canonicalPath = resolve(componentDirPath);
	const lockIdentity = componentPreparationLockIdentity(canonicalPath);
	const lockName = createHash('sha256').update(lockIdentity).digest('hex');
	return {
		canonicalPath,
		lockRoot: join(dirname(canonicalPath), COMPONENT_PREPARATION_LOCK_DIR),
		lockName,
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error.code === 'EPERM';
	}
}

async function readOwner(claimPath: string): Promise<ComponentPreparationLockOwner | null> {
	try {
		return JSON.parse(await readFile(claimPath, 'utf8'));
	} catch (error: any) {
		if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
		throw error;
	}
}

async function ownerIsAlive(
	owner: ComponentPreparationLockOwner,
	options: ComponentPreparationLockOptions
): Promise<boolean> {
	if (owner.pid !== process.pid) return isProcessAlive(owner.pid);
	// A PID (especially container PID 1) and worker thread id can be reused after a restart. The
	// per-process nonce makes an owner from an earlier Harper instance unambiguously stale.
	if (owner.processInstanceId !== COMPONENT_PREPARATION_PROCESS_INSTANCE_ID) return false;
	if (!options.isOwnerAlive) return true;
	try {
		return await options.isOwnerAlive(owner);
	} catch {
		// An unknown owner state is not permission to ignore its ticket.
		return true;
	}
}

// Stricter than ownerIsAlive: used only to decide whether a wait deadline may be renewed. A bare
// `kill(pid, 0)` on a *foreign* process proves some process holds that PID, not that it is the
// original owner — the PID can be recycled by an unrelated long-lived process after a hard crash,
// which would otherwise renew the deadline forever. Likewise, a rejected isOwnerAlive check is an
// unknown state, not a live one. ownerIsAlive's conservative "assume alive" is still correct for
// claim removal (it must not delete a possibly-live claim), but renewal has the opposite failure
// mode: renewing on unconfirmed liveness makes the "bounded wait is a backstop when liveness can't
// be established" invariant (DESIGN.md) unbounded. Only a same-process, same-instance owner that
// the caller's own liveness check *positively confirms* is alive may renew; everything else falls
// through to the bounded timeout, which only fails this waiter and never steals the lock.
async function ownerLivenessConfirmed(
	owner: ComponentPreparationLockOwner,
	options: ComponentPreparationLockOptions
): Promise<boolean> {
	if (owner.pid !== process.pid || owner.processInstanceId !== COMPONENT_PREPARATION_PROCESS_INSTANCE_ID) {
		return false;
	}
	if (!options.isOwnerAlive) return false;
	try {
		return await options.isOwnerAlive(owner);
	} catch {
		return false;
	}
}

interface LiveClaims {
	choosing: ComponentPreparationLockOwner[];
	tickets: ComponentPreparationLockOwner[];
}

// Exported only so a test can force the exact interleaving below (readdir() observes a choosing
// claim, then the read of that claim races against its removal) without a mocking library.
export async function scanLiveClaims(
	lockRoot: string,
	lockName: string,
	options: ComponentPreparationLockOptions,
	ownToken?: string,
	onEntriesListed?: () => Promise<void> | void
): Promise<LiveClaims> {
	let entries: string[];
	try {
		entries = await readdir(lockRoot);
	} catch (error: any) {
		if (error.code === 'ENOENT') return { choosing: [], tickets: [] };
		throw error;
	}
	await onEntriesListed?.();
	const choosingPrefix = `${lockName}.choosing.`;
	const ticketPrefix = `${lockName}.ticket.`;
	const claimNames = entries.filter((name) => name.startsWith(choosingPrefix) || name.startsWith(ticketPrefix));
	const claims = await Promise.all(
		claimNames.map(async (name) => {
			let claimPath = join(lockRoot, name);
			let owner = await readOwner(claimPath);
			let isTicket = name.startsWith(ticketPrefix);
			if (!owner && !isTicket) {
				// acquireComponentPreparationLock always durably publishes its ticket before removing
				// its choosing claim (never the reverse), so a choosing claim that vanished between
				// readdir() and this read is not proof its contender is gone — it just finished
				// choosing in that exact window. Look for the ticket it published under the same
				// token (embedded in the filename, so no read is needed to recover it) before
				// discarding it as stale.
				const token = name.slice(choosingPrefix.length, -'.json'.length);
				const ticketSuffix = `.${token}.json`;
				let freshEntries: string[];
				try {
					freshEntries = await readdir(lockRoot);
				} catch {
					freshEntries = [];
				}
				const ticketName = freshEntries.find(
					(candidate) => candidate.startsWith(ticketPrefix) && candidate.endsWith(ticketSuffix)
				);
				if (ticketName) {
					claimPath = join(lockRoot, ticketName);
					owner = await readOwner(claimPath);
					isTicket = true;
				}
			}
			return { claimPath, owner, isTicket, alive: owner ? await ownerIsAlive(owner, options) : false };
		})
	);
	const choosing: ComponentPreparationLockOwner[] = [];
	const tickets: ComponentPreparationLockOwner[] = [];
	for (const claim of claims) {
		if (claim.owner?.token === ownToken) continue;
		if (!claim.owner || !claim.alive) {
			// Claim filenames contain a random owner token and are never reused. Removing this exact
			// stale claim therefore cannot delete a fresh acquisition, unlike renaming a common lock path.
			await rm(claim.claimPath, { force: true }).catch(() => {});
			continue;
		}
		if (claim.isTicket) tickets.push(claim.owner);
		else choosing.push(claim.owner);
	}
	return { choosing, tickets };
}

function ticketPrecedes(left: ComponentPreparationLockOwner, right: ComponentPreparationLockOwner): boolean {
	const leftTicket = left.ticket ?? Number.MAX_SAFE_INTEGER;
	const rightTicket = right.ticket ?? Number.MAX_SAFE_INTEGER;
	return leftTicket < rightTicket || (leftTicket === rightTicket && left.token < right.token);
}

// Best-effort cleanup for `.publishing` staging files orphaned by a crash between writeFile and
// rename in publishClaim. Age-gated rather than identity-based (the filename's second UUID isn't
// correlatable to any live owner) so a sweep can never race a genuinely in-flight publish.
async function sweepStalePublishingFiles(lockRoot: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(lockRoot);
	} catch {
		return;
	}
	await Promise.all(
		entries
			.filter((name) => name.endsWith('.publishing'))
			.map(async (name) => {
				const path = join(lockRoot, name);
				try {
					const stats = await stat(path);
					if (Date.now() - stats.mtimeMs >= STALE_PUBLISHING_SWEEP_AGE_MS) {
						await rm(path, { force: true }).catch(() => {});
					}
				} catch {}
			})
	);
}

async function publishClaim(claimPath: string, owner: ComponentPreparationLockOwner): Promise<void> {
	// Keep the staging name outside the public `<lockName>.choosing|ticket.*` namespace so a
	// contender cannot observe or clean it while its JSON write is still in progress.
	const publishingPath = join(dirname(claimPath), `.${owner.token}.${randomUUID()}.publishing`);
	await writeFile(publishingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
	try {
		// The unique public name appears only after the complete owner record has been written.
		await rename(publishingPath, claimPath);
	} catch (error) {
		await rm(publishingPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Acquire a filesystem implementation of Lamport's bakery lock. Every contender publishes an
 * immutable, uniquely-named ticket; stale tickets are ignored/removed by their exact path. This
 * avoids the compare-then-rename race inherent in reclaiming a single common lock filename.
 */
async function acquireComponentPreparationLock(
	componentDirPath: string,
	options: ComponentPreparationLockOptions
): Promise<() => Promise<void>> {
	const { canonicalPath, lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
	const owner: ComponentPreparationLockOwner = {
		pid: process.pid,
		threadId,
		processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
		token: randomUUID(),
	};
	const choosingPath = join(lockRoot, `${lockName}.choosing.${owner.token}.json`);
	let ticketPath: string | undefined;
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
	let deadline = performance.now() + timeoutMs;

	await mkdir(lockRoot, { recursive: true, mode: 0o700 });
	await sweepStalePublishingFiles(lockRoot);
	try {
		// Bakery "choosing" flag: an earlier contender will wait for this file to disappear before
		// comparing tickets, while a later contender necessarily observes our published ticket.
		await publishClaim(choosingPath, owner);
		const initialClaims = await scanLiveClaims(lockRoot, lockName, options, owner.token);
		owner.ticket = initialClaims.tickets.reduce((max, contender) => Math.max(max, contender.ticket ?? 0), 0) + 1;
		ticketPath = join(lockRoot, `${lockName}.ticket.${owner.ticket}.${owner.token}.json`);
		await publishClaim(ticketPath, owner);
	} finally {
		await rm(choosingPath, { force: true }).catch(() => {});
	}

	let waitingReported = false;
	try {
		for (;;) {
			const claims = await scanLiveClaims(lockRoot, lockName, options, owner.token);
			const precedingTicket = claims.tickets
				.filter((contender) => ticketPrecedes(contender, owner))
				.sort((a, b) => {
					if (a.ticket !== b.ticket) return (a.ticket ?? 0) - (b.ticket ?? 0);
					return a.token.localeCompare(b.token);
				})[0];
			const blocker = claims.choosing[0] ?? precedingTicket;
			if (!blocker) break;
			if (!waitingReported) {
				waitingReported = true;
				options.onWait?.(blocker);
			}
			if (performance.now() >= deadline) {
				if (await ownerLivenessConfirmed(blocker, options)) {
					// A confirmed-live holder is allowed to finish; the deadline only bounds owners whose
					// liveness cannot be positively established.
					deadline = performance.now() + timeoutMs;
				} else {
					throw new Error(
						`Timed out waiting for component preparation lock for ${canonicalPath}` +
							` held by process ${blocker.pid}, thread ${blocker.threadId}`
					);
				}
			}
			await delay(LOCK_POLL_INTERVAL_MS);
		}
	} catch (error) {
		if (ticketPath) await rm(ticketPath, { force: true }).catch(() => {});
		throw error;
	}

	return async () => {
		const currentOwner = await readOwner(ticketPath!);
		if (currentOwner?.token !== owner.token) {
			throw new Error(`Lost ownership of component preparation lock for ${canonicalPath}`);
		}
		await rm(ticketPath!, { force: true });
	};
}

/** Serialize destructive preparation work for one component path across Harper worker threads. */
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
			try {
				options.onReleaseError?.(error);
			} catch {}
		}
	}
}
