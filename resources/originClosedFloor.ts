import { threadId } from 'node:worker_threads';
import type { Transaction as RocksTransaction, RocksDatabase } from '@harperfast/rocksdb-js';
import * as harperLogger from '../utility/logging/harper_logger.ts';

/**
 * Origin-closed timestamp floor (harper-pro#922, item 1).
 *
 * Every key that reaches this node's `local` transaction log is reserved on its thread before it is
 * minted or adopted. Each thread publishes, in a per-root-store shared buffer, a lower bound on every
 * key it may still append; a certifier publishes `F ≤ min(a clock sample taken first, every thread's
 * bound)`, so no transaction can later append below `F`. Persisted before it is advertised; the
 * issuance ratchet keeps keys unique and at or above the recovered floor after a restart or a backward
 * clock step. Design: resources/DESIGN.md "Origin-closed timestamp floor".
 */

const SLOTS = 1024;
const WORD_PROPOSED = 0;
const WORD_PUBLISHED = 1;
const WORD_RATCHET = 2;
const HEADER_WORDS = 4;
const THREAD_WORDS_OFFSET = HEADER_WORDS;
const BOUND_WORDS_OFFSET = HEADER_WORDS + SLOTS;
const BUFFER_BYTES = (HEADER_WORDS + 2 * SLOTS) * 8;
const BUFFER_KEY = 'origin-closed-floor';
export const ORIGIN_FLOOR_TICK_MS = 5000;
const SENTINEL_RETRIES = 8;
const MAX_TIMESTAMP = 8.64e15;

const RESERVATION = Symbol('originFloorReservation');
const REGISTRY = Symbol('originFloorRegistry');

// Positive doubles order the same as their bit patterns read as signed 64-bit integers, so a
// compare-and-swap maximum on the bits is a maximum on the values, and +1 on the bits is nextafter.
const FLOAT_SCRATCH = new Float64Array(1);
const BITS_SCRATCH = new BigInt64Array(FLOAT_SCRATCH.buffer);
function toBits(value: number): bigint {
	FLOAT_SCRATCH[0] = value;
	return BITS_SCRATCH[0];
}
function fromBits(bits: bigint): number {
	BITS_SCRATCH[0] = bits;
	return FLOAT_SCRATCH[0];
}
const INFINITY_BITS = toBits(Infinity);

function storeMax(words: BigInt64Array, index: number, value: number): number {
	const bits = toBits(value);
	for (;;) {
		const current = Atomics.load(words, index);
		if (current >= bits) return fromBits(current);
		if (Atomics.compareExchange(words, index, current, bits) === current) return value;
	}
}

type Reservation = { registry: ThreadRegistry; key: number; handles: number };

/** One thread's view of one root store's floor registry. */
class ThreadRegistry {
	readonly words: BigInt64Array;
	readonly slot: number;
	readonly rootStore: RocksDatabase;
	private readonly reserved = new Set<Reservation>();
	private cachedMin = Infinity;

	constructor(rootStore: RocksDatabase) {
		this.rootStore = rootStore;
		this.words = new BigInt64Array(rootStore.getUserSharedBuffer(BUFFER_KEY, new ArrayBuffer(BUFFER_BYTES)));
		this.slot = this.claimSlot();
	}

	private claimSlot(): number {
		const owner = BigInt(threadId + 1);
		for (let slot = 0; slot < SLOTS; slot++) {
			const index = THREAD_WORDS_OFFSET + slot;
			if (Atomics.load(this.words, index) === owner) return slot;
			if (Atomics.compareExchange(this.words, index, 0n, owner) === 0n) {
				Atomics.store(this.words, BOUND_WORDS_OFFSET + slot, INFINITY_BITS);
				return slot;
			}
		}
		throw new Error(`No origin-floor slot is free for thread ${threadId} on ${this.rootStore.path}`);
	}

	private publish(): void {
		Atomics.store(this.words, BOUND_WORDS_OFFSET + this.slot, toBits(this.cachedMin));
	}

	/**
	 * A unique key above every clock sample so far: the native clock's next value, or, while that
	 * clock is still behind the ratchet (the recovered floor after a restart), the ratchet's next ulp.
	 * The native clock only ratchets forward, so once it passes the ratchet no JS-issued key can be
	 * repeated by it.
	 */
	freshKey(): number {
		const minted = this.rootStore.getMonotonicTimestamp();
		const mintedBits = toBits(minted);
		for (;;) {
			const ratchet = Atomics.load(this.words, WORD_RATCHET);
			if (mintedBits > ratchet) return minted;
			if (Atomics.compareExchange(this.words, WORD_RATCHET, ratchet, ratchet + 1n) === ratchet)
				return fromBits(ratchet + 1n);
		}
	}

	reserve(handle: RocksTransaction, explicit: number | undefined): number {
		const words = this.words;
		Atomics.store(words, BOUND_WORDS_OFFSET + this.slot, 0n);
		try {
			const current = handle.getTimestamp();
			const requested = explicit ?? current;
			const bits = toBits(requested);
			const key =
				bits >= Atomics.load(words, WORD_PROPOSED) && bits > Atomics.load(words, WORD_RATCHET)
					? requested
					: this.freshKey();
			if (key !== current) handle.setTimestamp(key);
			const reservation: Reservation = { registry: this, key, handles: 1 };
			(handle as any)[RESERVATION] = reservation;
			this.reserved.add(reservation);
			if (key < this.cachedMin) this.cachedMin = key;
			return key;
		} finally {
			this.publish();
		}
	}

	release(reservation: Reservation): void {
		if (--reservation.handles > 0) return;
		this.reserved.delete(reservation);
		if (reservation.key === this.cachedMin) {
			let min = Infinity;
			for (const other of this.reserved) if (other.key < min) min = other.key;
			this.cachedMin = min;
		}
		this.publish();
	}

	holders(): Array<{ threadId: number; bound: number }> {
		const result = [];
		for (let slot = 0; slot < SLOTS; slot++) {
			const owner = Atomics.load(this.words, THREAD_WORDS_OFFSET + slot);
			if (owner === 0n) continue;
			const bound = fromBits(Atomics.load(this.words, BOUND_WORDS_OFFSET + slot));
			if (bound !== Infinity) result.push({ threadId: Number(owner) - 1, bound });
		}
		return result;
	}

	/** The lowest published bound, 0 while any thread is mid-reservation. */
	minBound(): number {
		let min = Infinity;
		for (let slot = 0; slot < SLOTS; slot++) {
			if (Atomics.load(this.words, THREAD_WORDS_OFFSET + slot) === 0n) continue;
			const bits = Atomics.load(this.words, BOUND_WORDS_OFFSET + slot);
			if (bits === 0n) return 0;
			const bound = fromBits(bits);
			if (bound < min) min = bound;
		}
		return min;
	}
}

const registries = new Set<ThreadRegistry>();

function registryFor(rootStore: RocksDatabase): ThreadRegistry {
	let registry: ThreadRegistry = (rootStore as any)[REGISTRY];
	if (!registry) {
		registry = (rootStore as any)[REGISTRY] = new ThreadRegistry(rootStore);
		registries.add(registry);
	}
	return registry;
}

function assertValidTimestamp(value: number): void {
	if (!(typeof value === 'number' && Number.isFinite(value) && value > 0 && value < MAX_TIMESTAMP))
		throw new Error(`Invalid transaction timestamp: ${String(value)}`);
}

/**
 * Reserve the key `handle` will append to the `local` log with, before its first staged write. The
 * key — `explicit` (a context or lock timestamp) or else the handle's own minted one — is kept when it
 * is at or above the certifier's admission bound and above every key issued; otherwise a fresh unique
 * key is minted and installed on the handle. Returns the key the handle now carries.
 */
export function reserveLocalKey(rootStore: RocksDatabase, handle: RocksTransaction, explicit?: number): number {
	const existing: Reservation | undefined = (handle as any)[RESERVATION];
	if (existing) return existing.key;
	if (explicit !== undefined) assertValidTimestamp(explicit);
	return registryFor(rootStore).reserve(handle, explicit);
}

/** A second native handle that commits under a reserved key (a retry replay) shares the reservation. */
export function shareLocalKey(from: RocksTransaction, to: RocksTransaction): void {
	const reservation: Reservation | undefined = (from as any)[RESERVATION];
	if (!reservation || (to as any)[RESERVATION]) return;
	reservation.handles++;
	(to as any)[RESERVATION] = reservation;
}

/** Idempotent and never throws: a release runs on every terminal path of a handle. */
export function releaseLocalKey(handle: RocksTransaction | null | undefined): void {
	const reservation: Reservation | undefined = handle && (handle as any)[RESERVATION];
	if (!reservation) return;
	(handle as any)[RESERVATION] = undefined;
	try {
		reservation.registry.release(reservation);
	} catch (error) {
		harperLogger.warn('Error releasing an origin-floor reservation', error);
	}
}

export function isReservedForLocalAppend(handle: RocksTransaction): boolean {
	return (handle as any)[RESERVATION] !== undefined;
}

/** Raise the issuance bound: the recovered floor at open, or a key the replay tail found in `local`. */
export function raiseOriginFloorIssuance(rootStore: RocksDatabase, floor: number): void {
	if (!(Number.isFinite(floor) && floor > 0) || typeof rootStore?.getUserSharedBuffer !== 'function') return;
	const words = registryFor(rootStore).words;
	storeMax(words, WORD_RATCHET, floor);
	storeMax(words, WORD_PROPOSED, floor);
}

/** The persisted floor read at open is the advertised floor until the certifier advances it. */
export function publishOriginFloor(rootStore: RocksDatabase, floor: number): void {
	if (!(Number.isFinite(floor) && floor > 0) || typeof rootStore?.getUserSharedBuffer !== 'function') return;
	raiseOriginFloorIssuance(rootStore, floor);
	storeMax(registryFor(rootStore).words, WORD_PUBLISHED, floor);
}

/**
 * One certification round. The clock is sampled before the bounds are read, and the admission bound
 * is raised before as well, so a key minted or adopted after the read is above the candidate. Returns
 * the candidate when it advances the floor; the caller persists it and then publishes it.
 */
export function certifyOriginFloor(rootStore: RocksDatabase): number | undefined {
	const registry = registryFor(rootStore);
	const words = registry.words;
	const sample = Math.max(rootStore.getMonotonicTimestamp(), fromBits(Atomics.load(words, WORD_RATCHET)));
	storeMax(words, WORD_PROPOSED, sample);
	let bound = 0;
	for (let attempt = 0; attempt < SENTINEL_RETRIES && bound === 0; attempt++) bound = registry.minBound();
	if (bound === 0) return;
	const candidate = Math.min(sample, bound);
	if (toBits(candidate) <= Atomics.load(words, WORD_PUBLISHED)) return;
	return candidate;
}

export function getOriginClosedFloor(
	rootStore: RocksDatabase
): { floor: number; lagMs: number; holders: Array<{ threadId: number; bound: number }> } | undefined {
	if (typeof rootStore?.getUserSharedBuffer !== 'function') return;
	const registry = registryFor(rootStore);
	const floor = fromBits(Atomics.load(registry.words, WORD_PUBLISHED));
	if (!(floor > 0)) return;
	return { floor, lagMs: Date.now() - floor, holders: registry.holders() };
}

/** The store is closing on this thread: its buffer dies with the column family, so stop tracking it. */
export function forgetOriginFloorRegistry(rootStore: RocksDatabase): void {
	const registry: ThreadRegistry | undefined = (rootStore as any)?.[REGISTRY];
	if (!registry) return;
	registries.delete(registry);
	(rootStore as any)[REGISTRY] = undefined;
}

/** Retire every bound a thread that no longer runs may still hold; its handles are closed natively. */
export function retireOriginFloorSlots(exitedThreadId: number): void {
	const owner = BigInt(exitedThreadId + 1);
	for (const registry of registries) {
		for (let slot = 0; slot < SLOTS; slot++) {
			const index = THREAD_WORDS_OFFSET + slot;
			if (Atomics.load(registry.words, index) !== owner) continue;
			Atomics.store(registry.words, BOUND_WORDS_OFFSET + slot, INFINITY_BITS);
			Atomics.store(registry.words, index, 0n);
		}
	}
}

process.on('exit', () => retireOriginFloorSlots(threadId));
