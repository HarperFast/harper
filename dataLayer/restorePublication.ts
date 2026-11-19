/**
 * The one protocol every restore route publishes through (online and offline): reserve the target,
 * record a durable decision, apply and prove the restored generation in a bounded child process,
 * commit the decision, then — and only then — clear the marker that keeps the target undiscoverable.
 * Clearing the marker is the publication boundary: before it, any failure leaves the target blocked
 * and rerunnable; after it, the generation is live and is only ever finished, never re-applied. The
 * startup hooks at the end finish what a crash left on the committed side of that boundary. See
 * dataLayer/DESIGN.md.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { databaseRoots, resetDatabases } from '../resources/databases.ts';
import { acquireMembershipFence, assertNoReplicationPeers } from '../server/replicationMembership.ts';
import { JobCompletion } from '../server/jobs/deferredJobCompletion.ts';
import { pinBackup, unpinBackup, readBackupPins } from './backupRepository.ts';
import { assertBlobSnapshotRestorable, assertEngineOnlyRestoreAllowed } from './blobBackup.ts';
import type { BackupManifest } from './backupManifest.ts';
import {
	RESTORE_META_DIR,
	acquireRestoreLock,
	clearRestoringMarker,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	type RestoreLock,
} from './restoreMarker.ts';
import {
	RESTORE_RECEIPT_SUFFIX,
	describeRestoreSource,
	newRestoreReceipt,
	readRestoreReceipt,
	readRestoreReceiptFile,
	receiptBlocksDiscovery,
	removeRestoreReceipt,
	restoreReceiptPath,
	writeRestoreReceipt,
	type RestoreReceipt,
	type RestoreReceiptRead,
	type RestoreRoute,
} from './restoreReceipt.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import type { RestoreEvidence } from './restoreChildCommands.ts';
import {
	acquireRestoreLockFor,
	assertTargetClaimable,
	beginRestoreForDatabase,
	logCompatibilityWaived,
	resolveCompleteBackup,
	restorePinId,
	restoreSourceHint,
	warnImmutableSource,
	withRepository,
} from './rocksdbBackup.ts';

export interface OnlineRestoreHooks {
	/** Fences blob saves and closes the target on every thread, then proves no handle remains. */
	close(): Promise<void>;
	/** Releases the fence after a failure; `generationReplaced` says whether anything was destroyed. */
	release(generationReplaced: boolean): Promise<void>;
	/** Lets every thread's rescan open the published generation. */
	publish(): Promise<void>;
}

export interface PublishRestoreRequest {
	route: RestoreRoute;
	sourceDatabase: string;
	targetDatabase: string;
	inPlace: boolean;
	backupDir: string;
	databaseDir: string;
	blobRoots: string[];
	requestedBackupId?: number;
	allowEngineOnly: boolean;
	acceptIncompatible: boolean;
	acceptUnverifiedBlobs: boolean;
	immutableSource: boolean;
	/** `routes`: configured routes only — a restore of `system` replaces the node list itself. */
	checkPeers: boolean | 'routes';
	/**
	 * Probe RocksDB's own LOCK from the child before purging: being another process, it sees any handle
	 * still open here — a component that reopened the path — or in a server the offline CLI cannot see.
	 */
	probeEngineLock: boolean;
	jobId?: string;
	requestedBy?: string;
	online?: OnlineRestoreHooks;
}

/**
 * Finishes a receipt that reached `committed`: the generation is already whole, so only bookkeeping
 * remains, each step safe to repeat. Called with the target's lock held. The receipt goes last: until
 * it is gone, a crash re-runs exactly this and nothing else.
 */
export async function finishCommittedRestore(lock: RestoreLock, receipt: RestoreReceipt): Promise<void> {
	publishCommittedRestore(lock, receipt);
	await settleCommittedRestore(lock, receipt);
}

function publishCommittedRestore(lock: RestoreLock, receipt: RestoreReceipt): void {
	clearRestoringMarker(lock);
	releaseReceiptPins(receipt);
}

async function settleCommittedRestore(lock: RestoreLock, receipt: RestoreReceipt): Promise<void> {
	const again = readRestoreReceipt(lock.dbPath);
	if (again.kind !== 'valid' || again.receipt.operation_id !== receipt.operation_id) return;
	if (receipt.job_id) await settleRestoreJob(receipt, hdbTerms.JOB_STATUS_ENUM.COMPLETE);
	removeRestoreReceipt(lock, receipt.operation_id);
}

export function releaseReceiptPins(receipt: RestoreReceipt): void {
	const sourcePinId = receipt.source_pin_id;
	// immutable_source pins nothing of its own, but still retires what the attempts it took over pinned
	if (!sourcePinId && !receipt.superseded_pin_ids?.length && !receipt.pre_restore_pin_id) return;
	try {
		// Only a pin this receipt's backup holds: another restore of the same target pins the same id.
		const pin = sourcePinId && readBackupPins(receipt.backup_dir).find((candidate) => candidate.pin_id === sourcePinId);
		if (pin && pin.backup_id === receipt.backup_id) unpinBackup(receipt.backup_dir, sourcePinId!);
		for (const superseded of receipt.superseded_pin_ids ?? []) unpinBackup(receipt.backup_dir, superseded);
		if (receipt.pre_restore_pin_id) unpinBackup(receipt.backup_dir, receipt.pre_restore_pin_id);
	} catch (error) {
		logger.error(`Could not release the source pin of the restore of '${receipt.database}'`, error);
	}
}

export async function settleRestoreJob(receipt: RestoreReceipt, status: string, message?: string): Promise<void> {
	const { updateJob } = await import('../server/jobs/jobs.ts');
	const succeeded = status === hdbTerms.JOB_STATUS_ENUM.COMPLETE;
	await updateJob({
		id: receipt.job_id,
		status,
		message:
			message ??
			(succeeded
				? `Restored database '${receipt.database}' from ${describeRestoreSource(receipt)}`
				: `Restore of database '${receipt.database}' failed: ${receipt.last_error ?? 'unknown error'}`),
		deferred_to: null,
		...(succeeded ? { result: restoreResult(receipt) } : {}),
	});
}

function restoreResult(receipt: RestoreReceipt): Record<string, unknown> {
	const evidence = (receipt.evidence ?? {}) as Partial<RestoreEvidence> & { compatibility_waived?: string[] };
	return {
		database: receipt.database,
		backup_id: receipt.backup_id,
		...(receipt.database !== receipt.source_database ? { source_database: receipt.source_database } : {}),
		...(receipt.pre_restore_backup_id !== undefined ? { pre_restore_backup_id: receipt.pre_restore_backup_id } : {}),
		...(receipt.route === 'on_restart' && receipt.retain_previous === false ? { retain_previous: false } : {}),
		...(receipt.options.allow_engine_only ? { allow_engine_only: true } : {}),
		...(evidence.compatibility_waived?.length ? { compatibility_waived: evidence.compatibility_waived } : {}),
		...(evidence.tables ? { tables: evidence.tables } : {}),
		...(evidence.blobs ? { blob_integrity: evidence.blobs.blob_integrity } : {}),
		...(receipt.options.accept_unverified_blobs ? { accept_unverified_blobs: true } : {}),
		...(evidence.durability ? { durability: evidence.durability } : {}),
	};
}

/**
 * Before a new claim of a target: a committed receipt an earlier restore left is finished first, so a
 * new restore never starts over a generation whose bookkeeping is still pending. Online, `reload`
 * publishes the generation to every thread before the job row says COMPLETE, as the original restore
 * would have; the claim that follows may refuse the target, so nothing later would reload it.
 */
export async function finishOutstandingRestore(databaseDir: string, reload?: () => Promise<void>): Promise<void> {
	const read = readRestoreReceipt(databaseDir);
	if (read.kind !== 'valid' || read.receipt.state !== 'committed') return;
	let published: RestoreReceipt | undefined;
	const lock = acquireRestoreLockFor(read.receipt.database, databaseDir);
	try {
		const again = readRestoreReceipt(databaseDir);
		if (again.kind === 'valid' && again.receipt.state === 'committed') {
			publishCommittedRestore(lock, again.receipt);
			published = again.receipt;
		}
	} finally {
		releaseRestoreLock(lock);
	}
	if (!published) return;
	try {
		await reload?.();
	} catch (error) {
		logger.error(`Restore of '${published.database}' is published, but not every thread reloaded it`, error);
	}
	const settling = acquireRestoreLockFor(published.database, databaseDir);
	try {
		await settleCommittedRestore(settling, published);
	} finally {
		releaseRestoreLock(settling);
	}
}

/** Under the claim: what an earlier receipt on this target allows; returns the attempt taken over. */
function admitOverEarlierReceipt(
	databaseDir: string,
	databaseName: string,
	route: RestoreRoute
): RestoreReceipt | undefined {
	const read = readRestoreReceipt(databaseDir);
	if (read.kind === 'absent') return undefined;
	if (read.kind === 'unreadable') {
		// the path is for an operator on this host; a client gets the operation that removes it
		const remove = route === 'offline' ? restoreReceiptPath(databaseDir) : 'it with restore_backup cancel=true';
		throw new ClientError(
			`Database '${databaseName}' has a restore record that cannot be read (${read.reason}); remove ${remove} before restoring again`,
			409
		);
	}
	const earlier = read.receipt;
	if (earlier.state === 'committed') {
		throw new ClientError(
			`Database '${databaseName}' is finishing an earlier restore; retry once it has been published`,
			409
		);
	}
	// a terminal restart restore is no longer scheduled, so any restore may take its target over
	if (earlier.route === 'on_restart' && earlier.state !== 'terminal') {
		const pending = `Database '${databaseName}' has a pending restart restore (job ${earlier.job_id ?? earlier.operation_id}, ${earlier.state})`;
		throw new ClientError(
			route === 'offline'
				? `${pending}, which runs when Harper starts; to restore now instead, first withdraw it with restore_backup cancel=true`
				: `${pending}; use restore_backup resume=true, cancel=true, or another backup_id with on_restart=true`,
			409
		);
	}
	// A failed online or offline attempt: its marker (kept by the claim) blocks the target, and this
	// claim takes it over exactly as a rerun took over the marker before receipts existed.
	return earlier;
}

/** The backup a restore reads: the requested id, or the latest complete one, with its blob snapshot restorable here. */
async function resolveRestoreSource(
	request: PublishRestoreRequest
): Promise<{ backupId: number; manifest: BackupManifest; waived: string[] }> {
	let selected: Awaited<ReturnType<typeof resolveCompleteBackup>>;
	try {
		selected = await resolveCompleteBackup(
			request.backupDir,
			request.requestedBackupId,
			request.sourceDatabase,
			request.acceptIncompatible
		);
	} catch (error) {
		throw restoreSourceHint(error, request.sourceDatabase, request.requestedBackupId);
	}
	await assertBlobSnapshotRestorable(request.backupDir, selected.backupId, request.blobRoots);
	return selected;
}

export async function publishRestore(request: PublishRestoreRequest): Promise<Record<string, unknown> | JobCompletion> {
	const releaseMembership = request.checkPeers ? await acquireMembershipFence() : undefined;
	let result: Record<string, unknown>;
	try {
		if (request.checkPeers) assertNoReplicationPeers(request.targetDatabase, request.checkPeers === 'routes');
		await finishOutstandingRestore(request.databaseDir, request.online && (() => request.online!.publish()));
		result = await publishUnderFence(request);
	} catch (error) {
		// a takeover that failed before replacing anything has removed the record that kept components off
		if (request.online && restoreSafeModeLifted()) error.afterRecorded = await drainedRestart();
		throw error;
	} finally {
		releaseMembership?.();
	}
	if (!request.online || !restoreSafeModeLifted()) return result;
	return new JobCompletion({ ...result, restarting: true }, await drainedRestart());
}

async function drainedRestart(): Promise<() => void> {
	return (await import('./restoreIntent.ts')).requestDrainedRestart;
}

async function publishUnderFence(request: PublishRestoreRequest): Promise<Record<string, unknown>> {
	const { backupDir, databaseDir, targetDatabase, sourceDatabase } = request;
	let pinId = request.immutableSource ? undefined : restorePinId(databaseDir);
	let minted = false;
	if (request.immutableSource) warnImmutableSource(targetDatabase, backupDir);
	let receipt!: RestoreReceipt;
	const { lock, backupId, manifest, waived } = await withRepository(request.immutableSource)(
		backupDir,
		sourceDatabase,
		async () => {
			const selected = await resolveRestoreSource(request);
			assertEngineOnlyRestoreAllowed(targetDatabase, {
				backupHasBlobs: selected.manifest.blobs,
				allowEngineOnly: request.allowEngineOnly,
			});
			const claimed = beginRestoreForDatabase(databaseDir, targetDatabase, backupDir, (preexisting, claimLock) => {
				const earlier = admitOverEarlierReceipt(databaseDir, targetDatabase, request.route);
				assertTargetClaimable(
					{ databaseDir, databaseName: targetDatabase, inPlace: request.inPlace },
					backupDir,
					preexisting
				);
				const fresh = newRestoreReceipt({
					route: request.route,
					state: 'applying',
					database: targetDatabase,
					database_path: databaseDir,
					source_database: sourceDatabase,
					backup_dir: backupDir,
					backup_id: selected.backupId,
					job_id: request.jobId,
					requested_by: request.requestedBy,
					options: {
						accept_unverified_blobs: request.acceptUnverifiedBlobs,
						allow_engine_only: request.allowEngineOnly,
						accept_incompatible_backup: request.acceptIncompatible,
					},
				});
				// An interrupted attempt's source stays pinned until this one proves its own: until then the
				// earlier backup may be the blocked database's only usable recovery source. A pin on this
				// attempt's own backup is reused; the rest are retired once this attempt commits.
				const inherited = new Set(
					[
						restorePinId(databaseDir),
						earlier?.source_pin_id,
						earlier?.pre_restore_pin_id,
						...(earlier?.superseded_pin_ids ?? []),
					].filter(Boolean)
				);
				// immutable_source writes nothing in the repository, so it neither reuses nor retires a pin there;
				// the earlier pins lapse on their own once nothing marks or records the target
				const held = preexisting && pinId ? readBackupPins(backupDir).filter((pin) => inherited.has(pin.pin_id)) : [];
				const same = pinId ? held.find((pin) => pin.backup_id === selected.backupId) : undefined;
				const supersededPinIds = held.filter((pin) => pin !== same).map((pin) => pin.pin_id);
				if (pinId) {
					if (same) pinId = same.pin_id;
					else if (held.length > 0) pinId = `${pinId}-${fresh.operation_id}`;
					minted = !same;
					pinBackup(backupDir, pinId, selected.backupId, `restore of database '${targetDatabase}'`, databaseDir);
				}
				receipt = writeRestoreReceipt(claimLock, {
					...fresh,
					// taking over a restart restore keeps its trail, so safe mode still covers the target if this fails
					...(earlier?.route === 'on_restart' || earlier?.superseded_from
						? { superseded_from: earlier.operation_id }
						: {}),
					...(pinId !== undefined ? { source_pin_id: pinId } : {}),
					...(supersededPinIds.length > 0 ? { superseded_pin_ids: supersededPinIds } : {}),
					attempts: 1,
				});
			});
			return { lock: claimed, ...selected };
		}
	);
	logCompatibilityWaived(targetDatabase, backupId, manifest, waived);
	let destructionStarted = false;
	try {
		await request.online?.close();
		receipt = await applyProveAndCommit(lock, receipt, {
			manifest,
			blobRoots: request.blobRoots,
			probe: request.probeEngineLock,
			acceptUnverifiedBlobs: request.acceptUnverifiedBlobs,
			waived,
			checkPeers: request.checkPeers,
			onDestruction: () => {
				destructionStarted = true;
			},
		});
	} catch (error: any) {
		await abandonOrRelease(lock, receipt, request, minted ? pinId : undefined, destructionStarted, error);
		if (destructionStarted || lock.preexisting) {
			throw withRecoveryGuidance(
				error,
				`Restore of database '${targetDatabase}' from ${describeRestoreSource({ backup_id: backupId })} failed (rerun restore_backup to recover): ${error.message}`
			);
		}
		throw error;
	}
	try {
		clearRestoringMarker(lock);
	} catch (error) {
		// The committed receipt survives either way, so the next claim or startup finishes the rest. Only a
		// cleared marker means the restore is published; if it is still there, this restore has not been.
		if (restoreMarkerPresent(databaseDir)) {
			// the marker still blocks the database, so lifting the fence admits no saves; keeping it would
			// carry the replaced generation's queued unlinks into whatever restore runs next
			await releaseFence(request, true);
			throw new Error(
				`Restore of database '${targetDatabase}' was applied and proven but could not be published; it is published by the next restore_backup of it or the next restart`,
				{ cause: error }
			);
		}
		logger.error(`Restore of '${targetDatabase}' is published, but flushing the cleared marker failed`, error);
	} finally {
		releaseReceiptPins(receipt);
		releaseRestoreLock(lock);
	}
	// the job row says COMPLETE only once the reload broadcast has returned, so a client that polls the
	// job finds the restored generation; the receipt stays until then, and a crash here settles the job
	// at the next claim or startup
	try {
		await request.online?.publish();
	} catch (error) {
		logger.error(`Restore of '${targetDatabase}' is published, but not every thread reloaded it`, error);
	}
	try {
		const settling = acquireRestoreLock(databaseDir);
		try {
			await settleCommittedRestore(settling, receipt);
		} finally {
			releaseRestoreLock(settling);
		}
	} catch (error) {
		logger.error(`Restore of '${targetDatabase}' is published, but finishing its record failed`, error);
	}
	return {
		...restoreResult(receipt),
		...(request.route === 'offline' ? { restored_to: databaseDir } : {}),
		...(request.immutableSource ? { immutable_source: true } : {}),
	};
}

/** Adds recovery guidance without losing what a caller branches on: the client status and the phase. */
function withRecoveryGuidance(error: any, message: string): Error {
	const wrapped: any =
		error?.statusCode >= 400 && error.statusCode < 500
			? new ClientError(message, error.statusCode)
			: new Error(message);
	wrapped.cause = error;
	if (error?.phase !== undefined) wrapped.phase = error.phase;
	return wrapped;
}

export interface ApplyOptions {
	manifest: BackupManifest;
	blobRoots: string[];
	probe: boolean;
	acceptUnverifiedBlobs: boolean;
	waived: string[];
	checkPeers: boolean | 'routes';
	/** Runs once the child has announced the purge and the marker is published. */
	onDestruction?: () => void;
}

/**
 * The part of the protocol every route shares, over a receipt the caller already wrote and a lock it
 * holds: the child applies and proves the backup, the marker is published when the child announces the
 * purge, peers are re-checked, and the receipt moves to `committed`. Publication is the caller's.
 */
export async function applyProveAndCommit(
	lock: RestoreLock,
	receipt: RestoreReceipt,
	options: ApplyOptions
): Promise<RestoreReceipt> {
	const evidence = await runRestoreChild<RestoreEvidence>(
		'apply-and-prove',
		{
			operationId: receipt.operation_id,
			databaseName: receipt.database,
			sourceDatabase: receipt.source_database,
			databasePath: receipt.database_path,
			backupDir: receipt.backup_dir,
			backupId: receipt.backup_id,
			manifest: options.manifest,
			blobRoots: options.blobRoots,
			probe: options.probe,
			interrupted: lock.preexisting,
			acceptUnverifiedBlobs: options.acceptUnverifiedBlobs,
		},
		{
			databasePath: receipt.database_path,
			receipt: { databasePath: receipt.database_path, operationId: receipt.operation_id, attempt: receipt.attempts },
			beforeDestruction: () => {
				markRestoreDestructive(lock);
				options.onDestruction?.();
			},
		}
	);
	if (options.checkPeers) assertNoReplicationPeers(receipt.database, options.checkPeers === 'routes');
	return writeRestoreReceipt(lock, {
		...receipt,
		state: 'committed',
		evidence: { ...evidence, ...(options.waived.length > 0 ? { compatibility_waived: options.waived } : {}) },
	});
}

/**
 * A failure before the publication boundary. After destruction began, or over a target an earlier
 * attempt had already marked, the marker, pin and receipt all stay: the target is blocked and the
 * rerun has its source. Otherwise nothing was touched, so the claim is released whole.
 */
async function abandonOrRelease(
	lock: RestoreLock,
	receipt: RestoreReceipt,
	request: PublishRestoreRequest,
	pinId: string | undefined,
	destructionStarted: boolean,
	error: any
): Promise<void> {
	if (destructionStarted || lock.preexisting) {
		try {
			// a pin minted for a backup that never touched the target protects nothing the rerun needs
			if (!destructionStarted && pinId && receipt.source_pin_id === pinId) {
				unpinBackup(request.backupDir, pinId);
				receipt = { ...receipt, source_pin_id: undefined };
			}
			writeRestoreReceipt(lock, { ...receipt, last_error: error?.message ?? String(error) });
		} catch (recordError) {
			logger.error(`Could not record the failed restore of '${request.targetDatabase}'`, recordError);
		}
		releaseRestoreLock(lock);
		await releaseFence(request, true);
		return;
	}
	try {
		clearRestoringMarker(lock);
		// the receipt first: a pin left behind lapses on its own, an applying receipt reserves the database
		removeRestoreReceipt(lock, receipt.operation_id);
		if (pinId) unpinBackup(request.backupDir, pinId);
	} catch (cleanupError) {
		logger.error(`Could not release the claim of the failed restore of '${request.targetDatabase}'`, cleanupError);
	} finally {
		releaseRestoreLock(lock);
	}
	await releaseFence(request, false);
}

async function releaseFence(request: PublishRestoreRequest, generationReplaced: boolean): Promise<void> {
	try {
		await request.online?.release(generationReplaced);
	} catch (error) {
		logger.error(`Could not release the blob fence after a failed restore of '${request.targetDatabase}'`, error);
	}
}

// --- startup: finishing what a crash left on the committed side of the boundary ---

interface ScannedReceipt {
	file: string;
	read: RestoreReceiptRead;
}

export function scanRestoreReceipts(roots: string[] = databaseRoots()): ScannedReceipt[] {
	const scanned: ScannedReceipt[] = [];
	for (const root of roots) {
		const metaDir = join(root, RESTORE_META_DIR);
		if (!existsSync(metaDir)) continue;
		for (const name of readdirSync(metaDir)) {
			if (!name.endsWith(RESTORE_RECEIPT_SUFFIX)) continue;
			const file = join(metaDir, name);
			scanned.push({ file, read: readRestoreReceiptFile(file) });
		}
	}
	return scanned;
}

/** An online or offline attempt that did not commit leaves its job to the process that ran it, or to the sweep. */
function receiptSettlesJob(receipt: RestoreReceipt): boolean {
	return Boolean(receipt.job_id) && (receipt.route === 'on_restart' || receipt.state === 'committed');
}

export function jobsOwnedByRestoreReceipts(scanned: ScannedReceipt[] = scanRestoreReceipts()): Set<string> {
	const owned = new Set<string>();
	for (const { read } of scanned) {
		if (read.kind === 'valid' && receiptSettlesJob(read.receipt)) owned.add(read.receipt.job_id!);
	}
	return owned;
}

export function restoreReceiptOwnsJob(jobId: string): boolean {
	return jobsOwnedByRestoreReceipts().has(jobId);
}

/**
 * Finishes committed receipts that need nothing but files — no job row to settle — before anything
 * opens a database. An offline restore of `system` that committed and then crashed would otherwise
 * leave startup refusing a `system` it cannot load.
 */
export async function finishCommittedRestoresBeforeStartup(roots?: string[]): Promise<void> {
	for (const { read } of scanRestoreReceipts(roots)) {
		if (read.kind !== 'valid') continue;
		try {
			if (read.receipt.state === 'committed' && !read.receipt.job_id) await finishWithLock(read.receipt);
			else if (claimAbandonedBeforeDestruction(read.receipt)) dropAbandonedClaim(read.receipt);
		} catch (error) {
			logger.error(`Could not settle the restore record of '${read.receipt.database}' before startup`, error);
		}
	}
}

/**
 * A restore whose process died before its child announced the purge: the marker is published before
 * anything is destroyed, so with none present the database was never touched, and its receipt must
 * not keep it reserved.
 */
function claimAbandonedBeforeDestruction(receipt: RestoreReceipt): boolean {
	// a restart restore's receipt is its request, kept until it publishes, fails for good, or is cancelled
	return receipt.route !== 'on_restart' && receipt.state === 'applying' && !restoreMarkerPresent(receipt.database_path);
}

function dropAbandonedClaim(receipt: RestoreReceipt): boolean {
	let lock: RestoreLock;
	try {
		lock = acquireRestoreLock(receipt.database_path);
	} catch {
		return false; // held: a restore is running, so this is not an abandoned claim
	}
	try {
		const again = readRestoreReceipt(receipt.database_path);
		if (
			again.kind !== 'valid' ||
			again.receipt.operation_id !== receipt.operation_id ||
			!claimAbandonedBeforeDestruction(again.receipt)
		)
			return false;
		removeRestoreReceipt(lock, receipt.operation_id);
		releaseReceiptPins(receipt);
		logger.warn(
			`Dropped the claim of a restore of '${receipt.database}' that stopped before replacing anything; the database loads as it was`
		);
		return true;
	} finally {
		releaseRestoreLock(lock);
	}
}

async function finishWithLock(receipt: RestoreReceipt): Promise<void> {
	const lock = acquireRestoreLock(receipt.database_path);
	try {
		const again = readRestoreReceipt(receipt.database_path);
		if (
			again.kind === 'valid' &&
			again.receipt.operation_id === receipt.operation_id &&
			again.receipt.state === 'committed'
		) {
			await finishCommittedRestore(lock, again.receipt);
		}
	} finally {
		releaseRestoreLock(lock);
	}
}

let startupRecovery: Promise<Set<string>> | undefined;
// Threads started after recovery inherit it, job workers included; a relaunched process starts without it.
const HELD_AT_BOOT_KEY = 'harper.restoresHeldAtBoot';

export function resetStartupRecoveryForTesting(): void {
	startupRecovery = undefined;
	setEnvironmentData(HELD_AT_BOOT_KEY, undefined);
}

export function restoreSafeModeLatched(): boolean {
	return process.env.HARPER_SAFE_MODE === 'restore-unpublished';
}

/**
 * Whether this boot started without the database because a restore record reserved it, so the components that
 * use it loaded without it and only a restart loads them.
 */
export function restoreHeldAtBoot(databaseDir: string): boolean {
	const held = getEnvironmentData(HELD_AT_BOOT_KEY);
	// recovery did not finish, so what it held is unknown; startup latched restore safe mode for the same reason
	if (!Array.isArray(held)) return restoreSafeModeLatched();
	return held.includes(resolve(restoreReceiptPath(databaseDir)));
}

/**
 * Startup only, once per process: `loadRootComponents` also runs on every worker-replacing reload,
 * while the old workers still hold the databases. Resolves to the job ids a restore receipt still owns,
 * for the interrupted-job sweep to leave alone. Later calls get the same outcome — the same set, or the
 * same failure, so a retried sweep never sees an empty set in place of one that could not be read.
 */
export function recoverRestoresAtStartup(): Promise<Set<string>> {
	return (startupRecovery ??= recoverRestoresOnce());
}

async function recoverRestoresOnce(): Promise<Set<string>> {
	const owned = new Set<string>();
	let published = false;
	for (const { file, read } of scanRestoreReceipts()) {
		if (read.kind === 'absent') continue;
		if (read.kind === 'unreadable') {
			logger.error(`Restore record ${file} cannot be read (${read.reason}); its database stays unloaded`);
			continue;
		}
		const receipt = read.receipt;
		try {
			if (receipt.state === 'committed') {
				await finishWithLock(receipt);
				published = true;
			} else if (receipt.route === 'on_restart' && receipt.state !== 'terminal') {
				const { runRestartAttempt } = await import('./restoreIntent.ts');
				if (await runRestartAttempt(receipt)) published = true;
				// still scheduled, so its job is the receipt's; a terminal one already settled its job as failed
				else if (receipt.job_id && restartRestoreStillScheduled(receipt)) owned.add(receipt.job_id);
			} else if (receipt.route === 'on_restart' && receipt.job_id) {
				// terminal: the job failed when the receipt did, but that settle may not have landed
				await settleRestoreJob(receipt, hdbTerms.JOB_STATUS_ENUM.ERROR);
			} else if (claimAbandonedBeforeDestruction(receipt) && dropAbandonedClaim(receipt)) {
				// the pre-startup pass can find the lock still held by an exiting predecessor or orphaned child
				published = true;
			}
		} catch (error) {
			logger.error(`Could not recover the restore of '${receipt.database}'`, error);
			if (receiptSettlesJob(receipt)) owned.add(receipt.job_id!);
			// a failure after its commit may already have published; rescanning a still-blocked name is harmless
			published = true;
		}
	}
	if (published) resetDatabases();
	const scanned = scanRestoreReceipts();
	setEnvironmentData(
		HELD_AT_BOOT_KEY,
		scanned.filter(({ read }) => receiptBlocksDiscovery(read)).map(({ file }) => resolve(file))
	);
	// a receipt withdrawn while a later one recovered no longer owns its job
	const stillOwned = jobsOwnedByRestoreReceipts(scanned);
	return new Set([...owned].filter((jobId) => stillOwned.has(jobId)));
}

function restartRestoreStillScheduled(receipt: RestoreReceipt): boolean {
	const read = readRestoreReceipt(receipt.database_path);
	return (
		read.kind === 'valid' && read.receipt.operation_id === receipt.operation_id && read.receipt.state !== 'terminal'
	);
}

/**
 * Whether this boot latched restore safe mode and no restore keeps components off any longer: the latch holds
 * on every thread until a restart. Unknown counts as lifted, since the next boot decides again.
 */
function restoreSafeModeLifted(): boolean {
	if (!restoreSafeModeLatched()) return false;
	try {
		return unpublishedRestoreBlocksComponents() === undefined;
	} catch (error) {
		logger.error(
			'Could not tell whether a restore still keeps components off; restarting so the next boot decides',
			error
		);
		return true;
	}
}

/**
 * Whether this boot must start without components: a restart restore that ran out of attempts, one
 * that began replacing its target and has not published, or one holding a rollback copy it has not yet
 * applied over. The restart route exists because a component opens the database itself, and such a
 * component ignores the restoring marker, so it could serve or write the unproved generation, or write
 * to the live one after its rollback copy was taken, which the next attempt would replace uncaptured.
 */
export function unpublishedRestoreBlocksComponents(): string | undefined {
	const blocker = restoreKeepingComponentsOff();
	return blocker && ('database' in blocker ? blocker.database : blocker.file);
}

/** As `unpublishedRestoreBlocksComponents`, telling a database a client may be told from a file it may not. */
export function restoreKeepingComponentsOff(): { database: string } | { file: string } | undefined {
	// a marker alone, as older versions leave one, blocks only its own database
	for (const { file, read } of scanRestoreReceipts()) {
		// what an unreadable record would have restored, or how far, is unknown
		if (read.kind === 'unreadable') return { file };
		if (read.kind !== 'valid') continue;
		const { receipt } = read;
		if (receipt.route !== 'on_restart' && !receipt.superseded_from) continue;
		if (receipt.state === 'terminal') return { database: receipt.database };
		if (
			receipt.state !== 'committed' &&
			(restoreMarkerPresent(receipt.database_path) ||
				receipt.pre_restore_backup_id !== undefined ||
				// a copy taken but not yet recorded is adopted by the next attempt all the same
				receipt.pre_restore_started_at !== undefined)
		)
			return { database: receipt.database };
	}
	return undefined;
}
