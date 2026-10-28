/**
 * The one protocol every restore route publishes through (online, offline, and the restart route's
 * startup hook): reserve the target, record a durable decision, apply and prove the restored
 * generation in a bounded child process, commit the decision, then — and only then — clear the marker
 * that keeps the target undiscoverable. Clearing the marker is the publication boundary: before it,
 * any failure leaves the target blocked and rerunnable; after it, the generation is live and is only
 * ever finished, never re-applied. See dataLayer/DESIGN.md.
 */
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { acquireMembershipFence, assertNoReplicationPeers } from '../server/replicationMembership.ts';
import { pinBackup, unpinBackup, readBackupPins } from './backupRepository.ts';
import { assertEngineOnlyRestoreAllowed } from './blobBackup.ts';
import type { BackupManifest } from './backupManifest.ts';
import {
	acquireRestoreLock,
	clearRestoringMarker,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	type RestoreLock,
} from './restoreMarker.ts';
import {
	describeRestoreSource,
	newRestoreReceipt,
	readRestoreReceipt,
	rollbackDirOf,
	removeRestoreReceipt,
	writeRestoreReceipt,
	type RestoreReceipt,
	type RestoreRoute,
	type RestoreSourceKind,
} from './restoreReceipt.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import { releaseArchiveStaging, resolveRestoreSource } from './restoreArchive.ts';
import type { RestoreEvidence } from './restoreChildCommands.ts';
import {
	assertTargetClaimable,
	beginRestoreForDatabase,
	logCompatibilityWaived,
	restorePinId,
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
	route: Exclude<RestoreRoute, 'on_restart'>;
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
	/** Set for an archive: what to report instead of its backup id. */
	restoredFrom?: string;
	/** `staged_tree` when `backupDir` is a staging area holding an extracted archive. */
	sourceKind?: RestoreSourceKind;
	/** A restore of `system` itself replaces the peer list, so it is the one route that skips the check. */
	checkPeers: boolean;
	/**
	 * Probe RocksDB's own LOCK from the child before purging: being another process, it sees any handle
	 * still open here — a component that reopened the path — or in a server the offline CLI cannot see.
	 * Only the startup hook skips it, since a corrupt old directory must stay replaceable there.
	 */
	probeEngineLock: boolean;
	jobId?: string;
	requestedBy?: string;
	online?: OnlineRestoreHooks;
}

export const PRE_RESTORE_PIN_PREFIX = 'pre-restore-';

export function preRestorePinId(operationId: string): string {
	return `${PRE_RESTORE_PIN_PREFIX}${operationId}`;
}

/**
 * Finishes a receipt that reached `committed`: the generation is already whole, so only bookkeeping
 * remains — clear the marker, release the pins, settle the job row, delete the receipt — each step safe
 * to repeat. Called with the target's lock held. The receipt goes last: until it is gone, a crash
 * re-runs exactly this and nothing else.
 */
export async function finishCommittedRestore(lock: RestoreLock, receipt: RestoreReceipt): Promise<void> {
	clearRestoringMarker(lock);
	releaseReceiptPins(receipt);
	if (receipt.job_id) await settleRestoreJob(receipt, hdbTerms.JOB_STATUS_ENUM.COMPLETE);
	removeRestoreReceipt(lock, receipt.operation_id);
	releaseArchiveStaging(receipt.backup_dir);
}

/** Source and rollback pins can live in different repositories, so a failure on one never skips the other. */
export function releaseReceiptPins(receipt: RestoreReceipt): void {
	const sourcePinId = receipt.source_pin_id ?? restorePinId(receipt.database_path);
	try {
		// Only a pin this receipt's backup holds: another restore of the same target pins the same id.
		const pin = readBackupPins(receipt.backup_dir).find((candidate) => candidate.pin_id === sourcePinId);
		if (pin && pin.backup_id === receipt.backup_id) unpinBackup(receipt.backup_dir, sourcePinId);
	} catch (error) {
		logger.error(`Could not release the source pin of the restore of '${receipt.database}'`, error);
	}
	if (!receipt.pre_restore_pin_id) return;
	try {
		unpinBackup(rollbackDirOf(receipt), receipt.pre_restore_pin_id);
	} catch (error) {
		logger.error(`Could not release the rollback pin of the restore of '${receipt.database}'`, error);
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

export function restoreResult(receipt: RestoreReceipt): Record<string, unknown> {
	const evidence = (receipt.evidence ?? {}) as Partial<RestoreEvidence> & { compatibility_waived?: string[] };
	return {
		database: receipt.database,
		...(receipt.restored_from !== undefined
			? { restored_from: receipt.restored_from }
			: { backup_id: receipt.backup_id }),
		...(receipt.database !== receipt.source_database ? { source_database: receipt.source_database } : {}),
		...(receipt.pre_restore_backup_id !== undefined ? { pre_restore_backup_id: receipt.pre_restore_backup_id } : {}),
		...(receipt.options.allow_engine_only ? { allow_engine_only: true } : {}),
		...(evidence.compatibility_waived?.length ? { compatibility_waived: evidence.compatibility_waived } : {}),
		...(evidence.tables ? { tables: evidence.tables } : {}),
		...(evidence.blobs ? { blob_integrity: evidence.blobs.blob_integrity } : {}),
		...(evidence.blobs?.waived ? { accept_unverified_blobs: true } : {}),
		...(evidence.durability ? { durability: evidence.durability } : {}),
	};
}

/**
 * Before a new claim of a target: a committed receipt an earlier restore left is finished first, so a
 * new restore never starts over a generation whose bookkeeping is still pending.
 */
export async function finishOutstandingRestore(databaseDir: string): Promise<void> {
	const read = readRestoreReceipt(databaseDir);
	if (read.kind !== 'valid' || read.receipt.state !== 'committed') return;
	const lock = acquireRestoreLock(databaseDir);
	try {
		const again = readRestoreReceipt(databaseDir);
		if (again.kind === 'valid' && again.receipt.state === 'committed')
			await finishCommittedRestore(lock, again.receipt);
	} finally {
		releaseRestoreLock(lock);
	}
}

/** Under the claim: what an earlier receipt on this target allows; returns the source a taken-over attempt used. */
function admitOverEarlierReceipt(databaseDir: string, databaseName: string): string | undefined {
	const read = readRestoreReceipt(databaseDir);
	if (read.kind === 'absent') return undefined;
	if (read.kind === 'unreadable') {
		throw new ClientError(
			`Database '${databaseName}' has a restore record that cannot be read (${read.reason}); remove it with restore_backup cancel=true before restoring again`,
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
	if (earlier.route === 'on_restart') {
		throw new ClientError(
			`Database '${databaseName}' has a pending restart restore (job ${earlier.job_id ?? earlier.operation_id}, ${earlier.state}); use restore_backup resume=true or cancel=true`,
			409
		);
	}
	// A failed online or offline attempt: its marker (kept by the claim) blocks the target, and this
	// claim takes it over exactly as a rerun took over the marker before receipts existed.
	return earlier.backup_dir;
}

export async function publishRestore(request: PublishRestoreRequest): Promise<Record<string, unknown>> {
	await finishOutstandingRestore(request.databaseDir);
	const releaseMembership = request.checkPeers ? await acquireMembershipFence() : undefined;
	try {
		if (request.checkPeers) assertNoReplicationPeers(request.targetDatabase);
		return await publishUnderFence(request);
	} finally {
		releaseMembership?.();
	}
}

async function publishUnderFence(request: PublishRestoreRequest): Promise<Record<string, unknown>> {
	const { backupDir, databaseDir, targetDatabase, sourceDatabase } = request;
	const pinId = request.immutableSource ? undefined : restorePinId(databaseDir);
	if (request.immutableSource) warnImmutableSource(targetDatabase, backupDir);
	let receipt!: RestoreReceipt;
	let takenOverSource: string | undefined;
	const { lock, backupId, manifest, waived } = await withRepository(request.immutableSource)(
		backupDir,
		sourceDatabase,
		async () => {
			const selected = await resolveRestoreSource({
				kind: request.sourceKind,
				backupDir,
				requestedBackupId: request.requestedBackupId,
				sourceDatabase,
				acceptIncompatible: request.acceptIncompatible,
				blobRoots: request.blobRoots,
			});
			assertEngineOnlyRestoreAllowed(targetDatabase, {
				backupHasBlobs: selected.manifest.blobs,
				allowEngineOnly: request.allowEngineOnly,
			});
			const claimed = beginRestoreForDatabase(databaseDir, targetDatabase, backupDir, (preexisting, claimLock) => {
				takenOverSource = admitOverEarlierReceipt(databaseDir, targetDatabase);
				assertTargetClaimable(
					{ databaseDir, databaseName: targetDatabase, inPlace: request.inPlace },
					backupDir,
					preexisting
				);
				if (pinId) {
					pinBackup(backupDir, pinId, selected.backupId, `restore of database '${targetDatabase}'`, databaseDir);
				}
				receipt = writeRestoreReceipt(claimLock, {
					...newRestoreReceipt({
						route: request.route,
						state: 'applying',
						database: targetDatabase,
						database_path: databaseDir,
						source_database: sourceDatabase,
						backup_dir: backupDir,
						backup_id: selected.backupId,
						...(request.restoredFrom !== undefined ? { restored_from: request.restoredFrom } : {}),
						...(request.sourceKind !== undefined ? { source_kind: request.sourceKind } : {}),
						job_id: request.jobId,
						requested_by: request.requestedBy,
						options: {
							accept_unverified_blobs: request.acceptUnverifiedBlobs,
							allow_engine_only: request.allowEngineOnly,
							accept_incompatible_backup: request.acceptIncompatible,
						},
					}),
					attempts: 1,
				});
			});
			return { lock: claimed, ...selected };
		}
	);
	logCompatibilityWaived(targetDatabase, backupId, manifest, waived);
	let destructionStarted = false;
	let evidence: RestoreEvidence;
	try {
		await request.online?.close();
		evidence = await runRestoreChild<RestoreEvidence>(
			'apply-and-prove',
			applyArgs(request, backupId, manifest, lock.preexisting, receipt.operation_id),
			{
				databasePath: databaseDir,
				receipt: { databasePath: databaseDir, operationId: receipt.operation_id, attempt: receipt.attempts },
				beforeDestruction: () => {
					markRestoreDestructive(lock);
					destructionStarted = true;
				},
			}
		);
		if (request.checkPeers) assertNoReplicationPeers(targetDatabase);
		receipt = writeRestoreReceipt(lock, {
			...receipt,
			state: 'committed',
			evidence: { ...evidence, ...(waived.length > 0 ? { compatibility_waived: waived } : {}) },
		});
	} catch (error: any) {
		await abandonOrRelease(lock, receipt, request, pinId, destructionStarted, error);
		if (destructionStarted || lock.preexisting) {
			throw new Error(
				`Restore of database '${targetDatabase}' from ${describeRestoreSource({ restored_from: request.restoredFrom, backup_id: backupId })} failed (rerun restore_backup to recover): ${error.message}`,
				{ cause: error }
			);
		}
		throw error;
	}
	try {
		await finishCommittedRestore(lock, receipt);
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
		logger.error(`Restore of '${targetDatabase}' is published, but finishing its record failed`, error);
	} finally {
		releaseRestoreLock(lock);
	}
	// a staged archive an earlier failed attempt kept for this rerun is no longer anyone's source
	if (takenOverSource !== undefined && takenOverSource !== backupDir) releaseArchiveStaging(takenOverSource);
	try {
		await request.online?.publish();
	} catch (error) {
		logger.error(`Restore of '${targetDatabase}' is published, but not every thread reloaded it`, error);
	}
	return {
		...restoreResult(receipt),
		...(request.route === 'offline' ? { restored_to: databaseDir } : {}),
		...(request.immutableSource ? { immutable_source: true } : {}),
	};
}

function applyArgs(
	request: PublishRestoreRequest,
	backupId: number,
	manifest: BackupManifest,
	interrupted: boolean,
	operationId: string
) {
	return {
		sourceKind: request.sourceKind,
		operationId,
		databaseName: request.targetDatabase,
		sourceDatabase: request.sourceDatabase,
		databasePath: request.databaseDir,
		backupDir: request.backupDir,
		backupId,
		manifest,
		blobRoots: request.blobRoots,
		probe: request.probeEngineLock,
		interrupted,
		expectedTables: manifest.tables,
		acceptUnverifiedBlobs: request.acceptUnverifiedBlobs,
	};
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
		releaseArchiveStaging(request.backupDir);
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
