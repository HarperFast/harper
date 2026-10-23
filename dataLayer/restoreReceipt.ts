import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClientError } from '../utility/errors/hdbError.ts';
import { removeFileDurably, writeFileDurably } from '../utility/durableFile.ts';
import { restoreMetaFilePath, type RestoreLock } from './restoreMarker.ts';

export const RESTORE_RECEIPT_SUFFIX = '.intent';
// Not a `.intent` suffix, so a torn temp is never read as a receipt.
const RESTORE_RECEIPT_TEMP_SUFFIX = '.intent-tmp';
export const RESTORE_RECEIPT_VERSION = 1;
export const DEFAULT_RESTORE_MAX_ATTEMPTS = 3;

export type RestoreRoute = 'online' | 'offline' | 'on_restart';
export type RestoreReceiptState = 'pending' | 'applying' | 'committed' | 'terminal';

export interface RestoreReceiptOptions {
	accept_unverified_blobs?: boolean;
	allow_engine_only?: boolean;
	accept_incompatible_backup?: boolean;
}

/**
 * The durable decision record of one restore attempt on one target. Every route writes it before
 * anything destructive and moves it to `committed` before the marker clears, so a crash at any point
 * leaves a record that says whether the target must be re-applied or only finished.
 */
export interface RestoreReceipt {
	version: number;
	operation_id: string;
	route: RestoreRoute;
	state: RestoreReceiptState;
	database: string;
	database_path: string;
	source_database: string;
	backup_dir: string;
	backup_id: number;
	job_id?: string;
	retain_previous?: boolean;
	pre_restore_started_at?: number;
	pre_restore_backup_id?: number;
	superseded_from?: string;
	expected_tables?: string[];
	options: RestoreReceiptOptions;
	requested_by?: string;
	requested_at: number;
	attempts: number;
	max_attempts: number;
	last_error?: string;
	pre_terminal_state?: 'pending' | 'applying';
	evidence?: Record<string, unknown>;
	updated_at: number;
}

export type RestoreReceiptRead =
	{ kind: 'absent' } | { kind: 'valid'; receipt: RestoreReceipt } | { kind: 'unreadable'; reason: string };

const STATES = new Set<RestoreReceiptState>(['pending', 'applying', 'committed', 'terminal']);
const ROUTES = new Set<RestoreRoute>(['online', 'offline', 'on_restart']);

export function restoreReceiptPath(dbPath: string): string {
	return restoreMetaFilePath(dbPath, RESTORE_RECEIPT_SUFFIX);
}

export function readRestoreReceipt(dbPath: string): RestoreReceiptRead {
	return readRestoreReceiptFile(restoreReceiptPath(dbPath));
}

export function readRestoreReceiptFile(receiptPath: string): RestoreReceiptRead {
	let text: string;
	try {
		text = readFileSync(receiptPath, 'utf8');
	} catch (error: any) {
		if (error.code === 'ENOENT') return { kind: 'absent' };
		return { kind: 'unreadable', reason: `${error.code ?? 'read error'}: ${error.message}` };
	}
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: 'unreadable', reason: 'not valid JSON' };
	}
	if (!parsed || typeof parsed !== 'object') return { kind: 'unreadable', reason: 'not an object' };
	if (parsed.version !== RESTORE_RECEIPT_VERSION) {
		// a newer Harper wrote it; reading it as this version could re-apply or drop a decision
		return { kind: 'unreadable', reason: `receipt version ${parsed.version} is not ${RESTORE_RECEIPT_VERSION}` };
	}
	if (
		typeof parsed.operation_id !== 'string' ||
		!STATES.has(parsed.state) ||
		!ROUTES.has(parsed.route) ||
		typeof parsed.database !== 'string' ||
		typeof parsed.database_path !== 'string' ||
		typeof parsed.backup_dir !== 'string' ||
		!Number.isInteger(parsed.backup_id) ||
		!Number.isInteger(parsed.attempts)
	) {
		return { kind: 'unreadable', reason: 'missing or malformed fields' };
	}
	return { kind: 'valid', receipt: parsed as RestoreReceipt };
}

/** A receipt that is not `committed` — or that cannot be read — keeps the target undiscoverable. */
export function receiptBlocksDiscovery(read: RestoreReceiptRead): boolean {
	if (read.kind === 'absent') return false;
	if (read.kind === 'unreadable') return true;
	return read.receipt.state !== 'committed';
}

export function newRestoreReceipt(
	fields: Omit<
		RestoreReceipt,
		'version' | 'operation_id' | 'attempts' | 'max_attempts' | 'requested_at' | 'updated_at'
	> &
		Partial<Pick<RestoreReceipt, 'max_attempts'>>
): RestoreReceipt {
	const now = Date.now();
	return {
		version: RESTORE_RECEIPT_VERSION,
		operation_id: randomUUID(),
		attempts: 0,
		max_attempts: DEFAULT_RESTORE_MAX_ATTEMPTS,
		requested_at: now,
		updated_at: now,
		...fields,
	};
}

function assertLockMatches(lock: RestoreLock, receipt: { database_path: string }): void {
	if (lock.dbPath !== receipt.database_path) {
		throw new Error(`A restore receipt for ${receipt.database_path} was written under the lock of ${lock.dbPath}`);
	}
}

/** Written only under the target's exclusive restore lock, which is what serializes transitions. */
export function writeRestoreReceipt(lock: RestoreLock, receipt: RestoreReceipt): RestoreReceipt {
	assertLockMatches(lock, receipt);
	const written = { ...receipt, updated_at: Date.now() };
	writeFileDurably(restoreReceiptPath(receipt.database_path), JSON.stringify(written), RESTORE_RECEIPT_TEMP_SUFFIX);
	return written;
}

/**
 * Removes the receipt only if it is still this operation's. A delayed finalizer whose target has since
 * been claimed by another restore must never delete that restore's record.
 */
export function removeRestoreReceipt(lock: RestoreLock, operationId: string): void {
	const read = readRestoreReceipt(lock.dbPath);
	if (read.kind === 'absent') return;
	if (read.kind === 'valid' && read.receipt.operation_id === operationId) {
		removeFileDurably(restoreReceiptPath(lock.dbPath));
		return;
	}
	throw new ClientError(
		`The restore record for ${lock.dbPath} now belongs to another operation; operation ${operationId} left it in place`,
		409
	);
}

/** Removes an unreadable receipt, the one case where no operation id can prove ownership. */
export function removeUnreadableRestoreReceipt(lock: RestoreLock): void {
	if (readRestoreReceipt(lock.dbPath).kind !== 'unreadable') {
		throw new Error(`The restore record for ${lock.dbPath} is readable; remove it by its operation id`);
	}
	removeFileDurably(restoreReceiptPath(lock.dbPath));
}
