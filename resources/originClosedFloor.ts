import { threadId } from 'node:worker_threads';
import type { Transaction as RocksTransaction, RocksDatabase } from '@harperfast/rocksdb-js';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import { onMessageByType } from '../server/threads/manageThreads.js';

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

/** Main broadcasts it when a worker exits; each thread retires that worker's bounds in the stores it has open. */
export const ORIGIN_FLOOR_RETIRE = 'origin-floor-retire';

const RESERVATION = Symbol('originFloorReservation');
const REGISTRY = Symbol('originFloorRegistry');

// Positive doubles order as their bit patterns read as signed 64-bit integers: a compare-and-swap
// maximum on the bits is one on the values, and +1 on the bits is nextafter.
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

type Reservation = { registry: ThreadRegistry; key: number; released: boolean };

/**
 * One thread's view of one root store's floor registry. Outstanding reservations sit in a binary
 * min-heap by key with lazy deletion: commits settle roughly oldest-first, so the released key is
 * usually the minimum, and a rescan there would make draining a backlog quadratic.
 */
class ThreadRegistry {
	readonly words: BigInt64Array;
	readonly rootStore: RocksDatabase;
	private slot = -1;
	private readonly heap: Reservation[] = [];
	private outstanding = 0;
	private retired = false;

	constructor(rootStore: RocksDatabase) {
		this.rootStore = rootStore;
		this.words = new BigInt64Array(rootStore.getUserSharedBuffer(BUFFER_KEY, new ArrayBuffer(BUFFER_BYTES)));
	}

	/** A slot is taken the first time this thread reserves, so readers and certifiers hold none. */
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

	/** The store closed on this thread: a successor registry owns the slot from here on. */
	retire(): void {
		this.retired = true;
	}

	private minKey(): number {
		const heap = this.heap;
		while (heap.length > 0 && heap[0].released) this.popMin();
		return heap.length > 0 ? heap[0].key : Infinity;
	}

	private pushHeap(reservation: Reservation): void {
		const heap = this.heap;
		heap.push(reservation);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (heap[parent].key <= heap[index].key) break;
			[heap[parent], heap[index]] = [heap[index], heap[parent]];
			index = parent;
		}
	}

	private popMin(): void {
		const heap = this.heap;
		const last = heap.pop()!;
		if (heap.length === 0) return;
		heap[0] = last;
		let index = 0;
		for (;;) {
			const left = 2 * index + 1;
			const right = left + 1;
			let smallest = index;
			if (left < heap.length && heap[left].key < heap[smallest].key) smallest = left;
			if (right < heap.length && heap[right].key < heap[smallest].key) smallest = right;
			if (smallest === index) break;
			[heap[smallest], heap[index]] = [heap[index], heap[smallest]];
			index = smallest;
		}
	}

	private publish(bound: number): void {
		if (!this.retired) Atomics.store(this.words, BOUND_WORDS_OFFSET + this.slot, toBits(bound));
	}

	/**
	 * Admit a natively minted key: it must beat the ratchet, the highest native key this process has
	 * issued through here or JS-issued above it, and it raises the ratchet to itself. Every native key
	 * passes this one word, so a JS-issued key can never be repeated by a native one, and a stale
	 * ratchet step can never repeat a native key another thread admitted in the meantime.
	 */
	private admitNative(bits: bigint): boolean {
		for (;;) {
			const ratchet = Atomics.load(this.words, WORD_RATCHET);
			if (bits <= ratchet) return false;
			if (Atomics.compareExchange(this.words, WORD_RATCHET, ratchet, bits) === ratchet) return true;
		}
	}

	/**
	 * A unique key above every clock sample so far: the native clock's next value, or, while that
	 * clock is still behind the ratchet (the recovered floor after a restart), the ratchet's next ulp.
	 */
	freshKey(): number {
		const minted = this.rootStore.getMonotonicTimestamp();
		if (this.admitNative(toBits(minted))) return minted;
		for (;;) {
			const ratchet = Atomics.load(this.words, WORD_RATCHET);
			if (Atomics.compareExchange(this.words, WORD_RATCHET, ratchet, ratchet + 1n) === ratchet)
				return fromBits(ratchet + 1n);
		}
	}

	reserve(handle: RocksTransaction, explicit: number | undefined): number {
		const words = this.words;
		if (this.slot < 0) this.slot = this.claimSlot();
		this.publish(0);
		try {
			const current = handle.getTimestamp();
			const requested = explicit ?? current;
			const bits = toBits(requested);
			// An explicit value never moves the ratchet (one far in the future would pin every later key)
			// and may repeat a key already issued, as a re-delivery does; a minted key may do neither.
			const admissible =
				bits >= Atomics.load(words, WORD_PROPOSED) &&
				(explicit !== undefined ? bits > Atomics.load(words, WORD_RATCHET) : this.admitNative(bits));
			const key = admissible ? requested : this.freshKey();
			if (key !== current) handle.setTimestamp(key);
			const reservation: Reservation = { registry: this, key, released: false };
			(handle as any)[RESERVATION] = reservation;
			this.pushHeap(reservation);
			this.outstanding++;
			return key;
		} finally {
			this.publish(this.minKey());
		}
	}

	release(reservation: Reservation): void {
		if (reservation.released) return;
		reservation.released = true;
		this.outstanding--;
		if (this.outstanding === 0) this.heap.length = 0;
		this.publish(this.minKey());
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
 * Reserve the key `handle` appends to the `local` log with, before its first staged write: `explicit`
 * (a context or lock timestamp) or the handle's own minted key when admissible, else a fresh one
 * installed on the handle. Returns the key the handle now carries.
 */
export function reserveLocalKey(rootStore: RocksDatabase, handle: RocksTransaction, explicit?: number): number {
	const existing: Reservation | undefined = (handle as any)[RESERVATION];
	if (existing) return existing.key;
	if (explicit !== undefined) assertValidTimestamp(explicit);
	return registryFor(rootStore).reserve(handle, explicit);
}

/**
 * The handle that re-stages a reserved handle's writes (a replay past an open iterator) takes over
 * the reservation and its admitted key, which can sit above the explicit timestamp the caller
 * installed on it; the retained handle's own batch is never appended, so it holds nothing further.
 */
export function transferLocalKey(from: RocksTransaction, to: RocksTransaction): void {
	const reservation: Reservation | undefined = (from as any)[RESERVATION];
	if (!reservation || (to as any)[RESERVATION]) return;
	if (to.getTimestamp() !== reservation.key) to.setTimestamp(reservation.key);
	(from as any)[RESERVATION] = undefined;
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

/** Raise the issuance bound to the recovered floor at open. */
export function raiseOriginFloorIssuance(rootStore: RocksDatabase, floor: number): void {
	if (!(Number.isFinite(floor) && floor > 0) || typeof rootStore?.getUserSharedBuffer !== 'function') return;
	const words = registryFor(rootStore).words;
	storeMax(words, WORD_RATCHET, floor);
	storeMax(words, WORD_PROPOSED, floor);
}

/** The persisted floor read at open is the advertised floor until the certifier advances it. */
export function publishOriginFloor(rootStore: RocksDatabase, floor: number): void {
	if (typeof rootStore?.getUserSharedBuffer !== 'function') return;
	registryFor(rootStore); // every opener can retire a dead thread's bounds, floor or no floor
	if (!(Number.isFinite(floor) && floor > 0)) return;
	raiseOriginFloorIssuance(rootStore, floor);
	storeMax(registryFor(rootStore).words, WORD_PUBLISHED, floor);
}

/**
 * One certification round: the clock sample and the admission bound come before the bounds are read,
 * so a key minted or adopted after the read is above the candidate. The caller persists, then publishes.
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

/** The buffer dies with the column family, so a closing store leaves the directory. */
export function forgetOriginFloorRegistry(rootStore: RocksDatabase): void {
	const registry: ThreadRegistry | undefined = (rootStore as any)?.[REGISTRY];
	if (!registry) return;
	registry.retire();
	registries.delete(registry);
	(rootStore as any)[REGISTRY] = undefined;
}

/**
 * Retire every bound a thread that no longer runs may still hold. Only after the worker's native env
 * teardown, which closes its handles with their commits drained (main's `worker.on('exit')`): the
 * worker's own exit event fires before that, while a queued commit can still append.
 */
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

onMessageByType(ORIGIN_FLOOR_RETIRE, (message: { threadId: number }) => retireOriginFloorSlots(message.threadId));
