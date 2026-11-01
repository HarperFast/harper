import { statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { ClientError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';
import { getStorageSpaceStats, type StorageSpaceStats } from '../server/storageReclamation.ts';

const GIB = 1024 ** 3;

const DEFAULT_RESAMPLE_BYTES = 256 * 1024 * 1024;
const DEFAULT_RESAMPLE_INTERVAL_MS = 10_000;

export function defaultReserve({ size }: StorageSpaceStats): number {
	return Math.max(GIB, Math.ceil(size * 0.05));
}

function defaultInodeReserve(files: number): number {
	return Math.max(1024, Math.ceil(files * 0.01));
}

export interface FilesystemShape {
	bsize: number;
	files: number;
	ffree: number;
}

export interface DiskLedgerOptions {
	stats?: (path: string) => Promise<StorageSpaceStats>;
	statfs?: (path: string) => FilesystemShape;
	deviceOf?: (path: string) => number;
	reserve?: (stats: StorageSpaceStats) => number;
	inodeReserve?: (files: number) => number;
	resampleBytes?: number;
	resampleIntervalMs?: number;
	now?: () => number;
}

export interface LedgerHold {
	/** Return the hold, recording what the planned write actually used (default: all of it) as debited. */
	release(usedBytes?: number, usedInodes?: number): void;
}

interface DeviceBudget {
	device: number;
	bsize: number;
	basis: StorageSpaceStats['basis'];
	available: number;
	sampledAt: number;
	reserve: number;
	debited: number;
	inodesFree: number;
	inodesSampledAt: number;
	inodeReserve: number;
	inodesDebited: number;
	heldBytes: number;
	heldInodes: number;
	lastDebitAt: number;
	bytesSinceResample: number;
	resampledAt: number;
}

/** The nearest existing ancestor of `path`, so a path not yet created resolves to the volume it will land on. */
function existingAncestor(path: string): string {
	let current = path;
	while (!statSync(current, { throwIfNoEntry: false })) {
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

/**
 * One space budget per device for a long-running write (an import, a restore), charged before
 * each write. `getStorageSpaceStats` can return the same quota sample for minutes, so re-reading it
 * cannot see bytes written since: the budget is `available` at the last distinct sample, minus
 * every byte charged since that sample, minus a reserve for serving writes. A sample re-bases the
 * budget only when it was measured after the last charge. Grouping is by device id, never by path
 * prefix — a mount below a root is a different budget. The budget gates admission; a write's own
 * ENOSPC/EDQUOT remains authoritative.
 */
/**
 * The block a charge rounds to: the reported size, capped, because ZFS reports its record size and NFS
 * its write size there, and rounding small files to either would refuse writes that fit.
 */
export function allocationUnit(bsize: number): number {
	return Math.min(bsize, 64 * 1024);
}

export class DiskLedger {
	#stats: (path: string) => Promise<StorageSpaceStats>;
	#statfs: (path: string) => FilesystemShape;
	#deviceOf: (path: string) => number;
	#reserve: (stats: StorageSpaceStats) => number;
	#inodeReserve: (files: number) => number;
	#resampleBytes: number;
	#resampleIntervalMs: number;
	#now: () => number;
	#devices = new Map<number, Promise<DeviceBudget>>();

	constructor(options: DiskLedgerOptions = {}) {
		this.#stats = options.stats ?? ((path) => getStorageSpaceStats(existingAncestor(path)));
		this.#statfs = options.statfs ?? ((path) => statfsSync(existingAncestor(path)));
		this.#deviceOf = options.deviceOf ?? ((path) => statSync(existingAncestor(path)).dev);
		this.#reserve = options.reserve ?? defaultReserve;
		this.#inodeReserve = options.inodeReserve ?? defaultInodeReserve;
		this.#resampleBytes = options.resampleBytes ?? DEFAULT_RESAMPLE_BYTES;
		this.#resampleIntervalMs = options.resampleIntervalMs ?? DEFAULT_RESAMPLE_INTERVAL_MS;
		this.#now = options.now ?? Date.now;
	}

	/** Charge `bytes` (and `inodes`) about to be written under `path`; throws 507 if they do not fit. */
	async debit(path: string, bytes: number, inodes = 0): Promise<void> {
		const { budget } = await this.#admit(path, inodes, () => bytes);
		this.#record(budget, bytes, inodes);
	}

	/** Charge a file of `size` bytes in whole allocation blocks, plus its inode. Returns the bytes charged. */
	async debitEntry(path: string, size: number): Promise<number> {
		const { budget, bytes } = await this.#admit(path, 1, (bsize) => Math.ceil(size / bsize) * bsize);
		this.#record(budget, bytes, 1);
		return bytes;
	}

	/** Charge a directory: one allocation block and one inode. Returns the bytes charged. */
	async debitDirectory(path: string): Promise<number> {
		const { budget, bytes } = await this.#admit(path, 1, (bsize) => bsize);
		this.#record(budget, bytes, 1);
		return bytes;
	}

	/**
	 * Hold `bytes` for a planned write the ledger will not see entry by entry (a native backup, a blob
	 * copy), refusing before it starts. A held amount survives re-basing until released, so a sample
	 * taken mid-write cannot hand the unwritten remainder back.
	 */
	async reserve(path: string, bytes: number, inodes = 0): Promise<LedgerHold> {
		const { budget } = await this.#admit(path, inodes, () => bytes);
		budget.heldBytes += bytes;
		budget.heldInodes += inodes;
		budget.lastDebitAt = this.#now();
		let released = false;
		return {
			release: (usedBytes = bytes, usedInodes = inodes) => {
				if (released) return;
				released = true;
				budget.heldBytes -= bytes;
				budget.heldInodes -= inodes;
				this.#record(budget, Math.min(usedBytes, bytes), Math.min(usedInodes, inodes));
			},
		};
	}

	async remaining(path: string): Promise<{ bytes: number; inodes: number; basis: StorageSpaceStats['basis'] }> {
		const budget = await this.#budgetFor(path);
		return { bytes: remainingBytes(budget), inodes: remainingInodes(budget), basis: budget.basis };
	}

	async #admit(
		path: string,
		inodes: number,
		charge: (bsize: number) => number
	): Promise<{ budget: DeviceBudget; bytes: number }> {
		const budget = await this.#budgetFor(path);
		if (
			budget.bytesSinceResample >= this.#resampleBytes ||
			this.#now() - budget.resampledAt >= this.#resampleIntervalMs
		) {
			await this.#resample(budget, path);
		}
		let bytes = charge(budget.bsize);
		if (!(bytes >= 0) || !(inodes >= 0)) throw new RangeError(`Cannot charge ${bytes} bytes and ${inodes} inodes`);
		if (bytes > remainingBytes(budget) || inodes > remainingInodes(budget)) {
			// space may have been freed since the last sample; only a sample newer than the last charge can show it
			await this.#resample(budget, path);
			bytes = charge(budget.bsize);
		}
		if (bytes > remainingBytes(budget)) {
			throw insufficient(
				`Insufficient storage on the volume holding ${path}: this needs ${bytes} bytes, ` +
					`${Math.max(0, remainingBytes(budget))} remain after a ${budget.reserve}-byte reserve ` +
					`(${budget.basis} sample from ${new Date(budget.sampledAt).toISOString()})`
			);
		}
		if (inodes > remainingInodes(budget)) {
			throw insufficient(
				`Insufficient inodes on the volume holding ${path}: this needs ${inodes}, ` +
					`${Math.max(0, remainingInodes(budget))} remain after a ${budget.inodeReserve}-inode reserve`
			);
		}
		return { budget, bytes };
	}

	#record(budget: DeviceBudget, bytes: number, inodes: number): void {
		budget.debited += bytes;
		budget.inodesDebited += inodes;
		budget.bytesSinceResample += bytes;
		budget.lastDebitAt = this.#now();
	}

	#budgetFor(path: string): Promise<DeviceBudget> {
		const device = this.#deviceOf(path);
		let budget = this.#devices.get(device);
		if (!budget) {
			budget = this.#createBudget(device, path);
			this.#devices.set(device, budget);
			budget.catch(() => this.#devices.delete(device));
		}
		return budget;
	}

	async #createBudget(device: number, path: string): Promise<DeviceBudget> {
		const budget: DeviceBudget = {
			device,
			bsize: 0,
			basis: 'filesystem',
			available: 0,
			sampledAt: -Infinity,
			reserve: 0,
			debited: 0,
			inodesFree: 0,
			inodesSampledAt: -Infinity,
			inodeReserve: 0,
			inodesDebited: 0,
			heldBytes: 0,
			heldInodes: 0,
			lastDebitAt: -Infinity,
			bytesSinceResample: 0,
			resampledAt: -Infinity,
		};
		await this.#resample(budget, path);
		return budget;
	}

	async #resample(budget: DeviceBudget, path: string): Promise<void> {
		budget.resampledAt = this.#now();
		budget.bytesSinceResample = 0;
		const inodesSampledAt = this.#now();
		const fs = this.#statfs(path);
		budget.bsize = allocationUnit(fs.bsize);
		if (inodesSampledAt > budget.lastDebitAt) {
			// a filesystem with no fixed inode table (btrfs) reports files = 0
			budget.inodesFree = fs.files > 0 ? fs.ffree : Infinity;
			budget.inodeReserve = fs.files > 0 ? this.#inodeReserve(fs.files) : 0;
			budget.inodesDebited = 0;
			budget.inodesSampledAt = inodesSampledAt;
		}
		const stats = await this.#stats(path);
		if (stats.updatedAt > budget.sampledAt && stats.updatedAt > budget.lastDebitAt) {
			budget.available = stats.available;
			budget.basis = stats.basis;
			budget.reserve = this.#reserve(stats);
			budget.sampledAt = stats.updatedAt;
			budget.debited = 0;
		}
	}
}

function remainingBytes(budget: DeviceBudget): number {
	return budget.available - budget.debited - budget.heldBytes - budget.reserve;
}

function remainingInodes(budget: DeviceBudget): number {
	return budget.inodesFree - budget.inodesDebited - budget.heldInodes - budget.inodeReserve;
}

function insufficient(message: string): ClientError {
	return new ClientError(message, HTTP_STATUS_CODES.INSUFFICIENT_STORAGE);
}

const METER_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * A pass-through that charges every byte it carries to `ledger` against `path`, in batches so a
 * serving thread does not pay a device lookup per chunk, and — given `idleMs` — fails a stream that
 * stops delivering, which would otherwise hold its slot until a much longer outer timeout.
 */
export function ledgerMeter(
	ledger: DiskLedger,
	path: string,
	{ idleMs, onChunk }: { idleMs?: number; onChunk?: (chunk: Buffer) => void } = {}
): Transform {
	let pending = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			armIdle();
			onChunk?.(chunk);
			pending += chunk.length;
			if (pending < METER_BATCH_BYTES) return callback(null, chunk);
			const charge = pending;
			pending = 0;
			ledger.debit(path, charge).then(() => callback(null, chunk), callback);
		},
		flush(callback) {
			if (idleTimer) clearTimeout(idleTimer);
			if (pending === 0) return callback();
			ledger.debit(path, pending).then(() => callback(), callback);
		},
		destroy(error, callback) {
			if (idleTimer) clearTimeout(idleTimer);
			callback(error);
		},
	});
	function armIdle() {
		if (!idleMs) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => meter.destroy(new ClientError(`No data arrived for ${idleMs}ms`, 504)), idleMs);
		idleTimer.unref?.();
	}
	armIdle();
	return meter;
}
