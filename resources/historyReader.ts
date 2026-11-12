import { compareKeys, toBufferKey } from 'ordered-binary';
import { readAuditEntry, getAuditFloor, getDatabaseGeneration } from './auditStore.ts';
import { applyForward, getRecordAtTime, readAuditFrame } from './crdt.ts';

type Snapshot = {
	encoded: Buffer;
	txnLogKey: number;
	previousVersion: number;
	previousResidencyId: number;
	structureVersion: number;
	endTxn: boolean;
};
class HistoryImageUnavailable extends Error {
	readonly tooLarge: boolean;
	constructor(tooLarge: boolean) {
		super('History image unavailable');
		this.tooLarge = tooLarge;
	}
}

type Retained = { kind: string; value: any; bytes: number; entries: number };
/**
 * `cachesFrames: false`: the memo holds only what its reader admits, so a refusal declines the item instead of
 * exhausting the memo, and frames are read uncached.
 */
export type HistoryReadLimits = { maxEntries?: number; maxBytes?: number; cachesFrames?: boolean };

function copyEntry(entry): Snapshot {
	const source = entry.encoded;
	const encoded = Buffer.allocUnsafeSlow(source.byteLength);
	encoded.set(source);
	return {
		encoded,
		txnLogKey: entry.txnLogKey,
		previousVersion: entry.previousVersion,
		previousResidencyId: entry.previousResidencyId,
		structureVersion: entry.structureVersion,
		endTxn: entry.endTxn,
	};
}

function readSnapshot(snapshot: Snapshot, encoded: Buffer) {
	const entry = readAuditEntry(encoded);
	if (entry.type === undefined) return entry;
	entry.txnLogKey = snapshot.txnLogKey;
	entry.previousVersion = snapshot.previousVersion;
	entry.previousResidencyId = snapshot.previousResidencyId;
	entry.structureVersion = snapshot.structureVersion;
	entry.endTxn = snapshot.endTxn;
	return entry;
}

/** A copy of an audit entry that stays readable after the read that returned it reuses its buffer. */
export function detachAuditEntry(entry) {
	if (entry.type === undefined || !entry.encoded) return entry;
	const snapshot = copyEntry(entry);
	const detached = readSnapshot(snapshot, snapshot.encoded);
	return detached.type === undefined ? entry : detached;
}

export class HistoryMemo {
	readonly maxEntries: number;
	readonly maxBytes: number;
	readonly cachesFrames: boolean;
	readonly store: any;
	readonly tableId: number;
	readonly recordId: any;
	exhausted = false;
	closed = false;
	fallbacks = 0;
	visits = 0;
	newer = 0;
	lowest = Infinity;
	#retained = new Map<string, Retained>();
	#bytes = 0;
	#entries = 0;
	#images = 0;
	#carries = 0;
	#building = new Set<string>();
	#active = new Map<number, string>();
	#sequence = 0;
	#streamKey: number;
	#ended = new Set<number>();
	#tainted = false;
	#floor: number;
	#generation: string;
	#miss = new Error('History memo unavailable');

	constructor(store, tableId: number, limits: HistoryReadLimits = {}, recordId?) {
		this.store = store;
		this.tableId = tableId;
		this.recordId = recordId;
		this.maxEntries = limits.maxEntries ?? 16_384;
		this.maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
		this.cachesFrames = limits.cachesFrames !== false;
		try {
			this.#floor = getAuditFloor(store.rootStore.auditStore);
			this.#generation = getDatabaseGeneration(store.rootStore.auditStore)?.id;
		} catch {
			this.stopOptimizing();
		}
	}

	checkState() {
		if (this.closed || this.exhausted) return false;
		try {
			const audit = this.store.rootStore.auditStore;
			const floor = getAuditFloor(audit);
			const generation = getDatabaseGeneration(audit)?.id;
			if (Object.is(this.#floor, floor) && this.#generation === generation) return true;
			if (!this.cachesFrames) {
				for (const key of [...this.#retained.keys()]) this.forget(key);
				this.#floor = floor;
				this.#generation = generation;
				return true;
			}
		} catch {}
		this.stopOptimizing();
		return false;
	}

	get hasImages() {
		return this.#images > 0;
	}

	get carries() {
		return this.#carries;
	}

	get stats() {
		return { entries: this.#entries, bytes: this.#bytes, exhausted: this.exhausted, fallbacks: this.fallbacks };
	}

	key(kind: string, id, position: any = '', origin: any = undefined, committedRef = false) {
		return `${kind}|${this.tableId}|${toBufferKey(id).toString('base64')}|${origin ?? '*'}|${position}|${+committedRef}`;
	}

	unavailable(): never {
		throw this.#miss;
	}

	get(key: string) {
		return this.closed || this.exhausted ? undefined : this.#retained.get(key)?.value;
	}

	forget(key: string) {
		const old = this.#retained.get(key);
		if (!old) return;
		this.#retained.delete(key);
		this.#building.delete(key);
		if (old.kind === 'image') this.#images--;
		else if (old.kind === 'carry') this.#carries--;
		this.#bytes -= old.bytes;
		this.#entries -= old.entries;
	}

	stopOptimizing() {
		this.#exhaust();
	}

	#exhaust() {
		this.exhausted = true;
		for (const [key, item] of this.#retained) if (item.kind !== 'pending') this.forget(key);
		this.#ended.clear();
		this.#active.clear();
		this.#building.clear();
	}

	canFit(bytes: number, entries: number) {
		if (this.closed || this.exhausted) return false;
		if (this.#bytes + bytes <= this.maxBytes && this.#entries + entries <= this.maxEntries) return true;
		if (this.cachesFrames) this.#exhaust();
		return false;
	}

	keep(key: string, kind: string, value, bytes: number, entries = 1) {
		this.forget(key);
		bytes += key.length * 2 + 128;
		if (!this.canFit(bytes, entries)) return false;
		this.#retained.set(key, { kind, value, bytes, entries });
		if (kind === 'image') this.#images++;
		else if (kind === 'carry') this.#carries++;
		if (kind === 'building') this.#building.add(key);
		this.#bytes += bytes;
		this.#entries += entries;
		return true;
	}

	snapshot(entry): Snapshot {
		if (this.closed || this.exhausted || entry.type === undefined || !entry.encoded) this.unavailable();
		if (!this.canFit(entry.encoded.byteLength + 256, 1)) this.unavailable();
		return copyEntry(entry);
	}

	restore(snapshot: Snapshot) {
		const encoded = Buffer.allocUnsafeSlow(snapshot.encoded.byteLength);
		encoded.set(snapshot.encoded);
		const entry = readSnapshot(snapshot, encoded);
		if (entry.type === undefined) this.unavailable();
		return entry;
	}

	#frameAt(key: string) {
		const item = this.#retained.get(key);
		return item?.kind === 'frame' ? item.value : undefined;
	}

	frame(key: string) {
		if (this.closed || this.exhausted) this.unavailable();
		let frame = this.#frameAt(key) ?? (key.endsWith('|1') ? this.#frameAt(`${key.slice(0, -1)}0`) : undefined);
		if (!frame && key.split('|')[3] === '*') {
			const selected = this.get(`first|${key.slice(6, -1)}0`);
			if (selected) frame = this.#frameAt(selected);
		}
		return frame?.complete ? frame.snapshots.map((snapshot) => this.restore(snapshot)) : undefined;
	}

	rememberFrame(key: string, snapshots: Snapshot[], complete: boolean) {
		if (!complete || snapshots.length === 0) this.unavailable();
		const bytes = snapshots.reduce((sum, snapshot) => sum + snapshot.encoded.byteLength + 64, 0);
		if (!this.keep(key, 'frame', { snapshots, complete }, bytes, snapshots.length)) this.unavailable();
		return snapshots.map((snapshot) => this.restore(snapshot));
	}

	beginRange() {
		this.finishRange();
		this.#streamKey = undefined;
	}

	#finishKey() {
		for (const key of this.#building) {
			const item = this.#retained.get(key);
			if (!item) continue;
			if (item.value.complete && !this.#tainted && !item.value.tainted) item.kind = 'frame';
			else this.forget(key);
		}
		const firstKey = this.#active.values().next().value;
		if (firstKey && !this.#tainted && this.#frameAt(firstKey))
			this.keep(this.key('first', this.recordId, this.#streamKey), 'first', firstKey, firstKey.length * 2);
		this.#building.clear();
		this.#active.clear();
		this.#ended.clear();
		this.#tainted = false;
	}

	finishRange(range?: any) {
		if (range?.failedLogs?.size || range?.corruptFrameStop?.breaks) this.stopOptimizing();
		this.#finishKey();
	}

	observe(entry, matches?: boolean) {
		if (this.recordId === undefined || this.exhausted || this.closed) return;
		try {
			if (entry.txnLogKey !== this.#streamKey) {
				this.#finishKey();
				this.#streamKey = entry.txnLogKey;
			}
			if (entry.type === undefined) this.#tainted = true;
			const origin = entry.nodeId ?? 0;
			matches ??= entry.tableId === this.tableId && compareKeys(entry.recordId, this.recordId) === 0;
			let key = this.#active.get(origin);
			if (!key && matches) {
				if (this.#active.size >= 32) {
					this.#tainted = true;
					return;
				}
				key = this.key('frame', this.recordId, entry.txnLogKey, origin);
				this.#active.set(origin, key);
			}
			let frame = key && this.get(key);
			if (frame && this.#retained.get(key)?.kind === 'frame') return;
			if (this.#ended.has(origin) && frame) frame.tainted = true;
			if (matches) {
				const snapshot = this.snapshot(entry);
				frame ??= { snapshots: [], complete: false, tainted: this.#ended.has(origin) };
				frame.snapshots.push(snapshot);
				const bytes = frame.snapshots.reduce((sum, item) => sum + item.encoded.byteLength + 64, 0);
				if (!this.keep(key, 'building', frame, bytes, frame.snapshots.length)) return;
			}
			if (entry.endTxn || typeof this.store.rootStore.auditStore.logById !== 'function') {
				if (frame) frame.complete = true;
				if (this.#ended.size >= 32) this.#tainted = true;
				else this.#ended.add(origin);
			}
		} catch {
			this.#tainted = true;
		}
	}

	pending(entry) {
		try {
			const snapshot = this.snapshot(entry);
			const key = `pending|${++this.#sequence}`;
			return this.keep(key, 'pending', snapshot, snapshot.encoded.byteLength + 64) ? key : undefined;
		} catch {
			return undefined;
		}
	}

	takePending(key: string) {
		const snapshot = this.#retained.get(key)?.value;
		this.forget(key);
		return snapshot && this.restore(snapshot);
	}

	close() {
		this.#retained.clear();
		this.#ended.clear();
		this.#building.clear();
		this.#active.clear();
		this.#bytes = this.#entries = this.#images = this.#carries = 0;
		this.closed = true;
	}
}

function copyImage(value, limit: number) {
	let bytes = 0;
	const seen = new Map<object, any>();
	const account = (amount: number) => {
		bytes += amount;
		if (bytes > limit) throw new HistoryImageUnavailable(true);
	};
	const copy = (input) => {
		account(16);
		if (input === null || typeof input !== 'object') {
			if (typeof input === 'string') account(input.length * 2);
			if (typeof input === 'bigint') account(input.toString(16).length);
			if (typeof input === 'symbol' || typeof input === 'function') throw new HistoryImageUnavailable(false);
			return input;
		}
		if (seen.has(input)) return seen.get(input);
		if (Buffer.isBuffer(input)) {
			account(input.byteLength);
			return Buffer.from(input);
		}
		if (Object.getPrototypeOf(input) === Date.prototype) return new Date(input.getTime());
		if (ArrayBuffer.isView(input)) {
			account(input.byteLength);
			if (Object.getPrototypeOf(input) === DataView.prototype)
				return new DataView(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
			const constructor = input.constructor;
			if (Object.getPrototypeOf(constructor) !== Object.getPrototypeOf(Uint8Array))
				throw new HistoryImageUnavailable(false);
			return new (constructor as any)(input);
		}
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
			throw new HistoryImageUnavailable(false);
		const output = Array.isArray(input) ? [] : Object.create(prototype);
		seen.set(input, output);
		for (const key of Object.keys(input)) {
			account(key.length * 2 + 16);
			Object.defineProperty(output, key, {
				value: copy(input[key]),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return output;
	};
	return { record: copy(value), bytes };
}

function recordStamp(current) {
	return `${current?.version}|${current?.localTime}|${current?.nodeId}|${current?.metadataFlags}|${current?.size}`;
}

function isMutation(entry) {
	return entry.type === 'put' || entry.type === 'patch' || entry.type === 'delete' || entry.type === 'invalidate';
}

export class HistoryReader {
	readonly memo: HistoryMemo;
	#eligible: (id: any, current: any, memo: HistoryMemo) => boolean;

	constructor(
		store,
		tableId: number,
		eligible: (id, current, memo: HistoryMemo) => boolean,
		limits?: HistoryReadLimits,
		recordId?
	) {
		this.memo = new HistoryMemo(store, tableId, limits, recordId);
		this.#eligible = eligible;
	}

	#canCarry(id) {
		const current = this.memo.store.getEntry(id);
		if (current?.additionalAuditRefs?.length) return false;
		if (current?.size > this.memo.maxBytes) {
			this.memo.stopOptimizing();
			return false;
		}
		const stamp = recordStamp(current);
		const key = this.memo.key('eligible', id);
		let answer = this.memo.get(key);
		if (answer && answer.stamp !== stamp) {
			this.memo.stopOptimizing();
			return false;
		}
		if (answer?.stamp !== stamp) {
			answer = { stamp, allowed: this.#eligible(id, current, this.memo) };
			if (!this.memo.keep(key, 'eligible', answer, stamp.length * 2)) return false;
		}
		return answer.allowed;
	}

	read(entry, time = entry.txnLogKey) {
		const { memo } = this;
		if (entry.type === 'patch' || entry.type === 'invalidate') memo.checkState();
		const id = entry.recordId;
		const imageKey = entry.type === 'patch' || memo.hasImages ? memo.key('image', id) : undefined;
		const rebuild = () => entry.getValue?.(memo.store, true, time, memo.exhausted || memo.closed ? undefined : memo);
		if (entry.type !== 'patch' || memo.exhausted || memo.closed) {
			if (entry.type !== 'message' && imageKey) memo.forget(imageKey);
			return rebuild();
		}
		let eligible = false;
		try {
			eligible = this.#canCarry(id);
		} catch {
			memo.forget(imageKey);
		}
		if (!eligible) {
			memo.forget(imageKey);
			return rebuild();
		}
		const before = memo.fallbacks;
		let record;
		let computed = false;
		try {
			const image = memo.get(imageKey);
			const frame = readAuditFrame(memo.store.rootStore.auditStore, memo.tableId, id, time, entry.nodeId, true, memo);
			const mutations = frame.filter(isMutation);
			if (
				image &&
				mutations.length === 1 &&
				mutations[0].type === 'patch' &&
				!entry.previousAdditionalAuditRefs?.length &&
				entry.version > image.version &&
				entry.previousVersion === image.time &&
				(entry.previousNodeId ?? 0) === image.origin
			) {
				record = copyImage(image.record, memo.maxBytes).record;
				const update = entry.getValue(memo.store, false);
				if (update == null || Object.prototype.toString.call(update) !== '[object Object]')
					throw new Error('Unreadable history patch');
				applyForward(record, update);
			} else record = rebuild();
			computed = true;
			if (record && memo.fallbacks === before) {
				const image = copyImage(record, memo.maxBytes);
				if (
					!memo.keep(
						imageKey,
						'image',
						{ record: image.record, time, origin: entry.nodeId ?? 0, version: entry.version },
						image.bytes
					)
				)
					return entry.getValue(memo.store, true, time);
			} else memo.forget(imageKey);
			return record;
		} catch (error) {
			memo.forget(imageKey);
			const answer = memo.get(memo.key('eligible', id));
			if (answer) answer.allowed = false;
			if (error instanceof HistoryImageUnavailable && error.tooLarge) memo.stopOptimizing();
			return computed ? record : rebuild();
		}
	}

	defer(entry, time = entry.txnLogKey): (() => any) | undefined {
		if (entry.type !== 'patch' && entry.type !== 'invalidate') return;
		const key = this.memo.pending(entry);
		if (!key) return;
		const id = entry.recordId;
		const origin = entry.nodeId;
		return () => {
			try {
				const captured = this.memo.takePending(key);
				if (captured) return this.read(captured, time);
			} catch {
				this.memo.forget(key);
			}
			return getRecordAtTime(this.memo.store.getEntry(id), time, this.memo.store, this.memo.tableId, id, origin);
		};
	}
}

export const CARRY_SCAN_LIMIT = 16_384;
// with fewer later versions than this, the rebuilds left cost less than the walk that would replace them
const CARRY_MIN_NEWER = 3;

type CarryImage = { record: any; time: number; origin: number; version: number };
type Carry = { stamp: string; allowed: boolean; image?: CarryImage };

/**
 * Reads a replay's entries in log order, carrying each eligible record's image from one patch to the next. A
 * record's carry state (its current entry's stamp, its eligibility and its image, in one memo entry) is admitted
 * while it fits and is never evicted, so a record walks for eligibility at most once per current entry. A record
 * is decided only once its first rebuild crossed enough later versions to repay the walk, and the walk is
 * limited to the rebuild work it would save. `eligible` must accept only chains whose carry equals the plain
 * rebuild.
 */
export class ReplayReader {
	readonly memo: HistoryMemo;
	#eligible: (id: any, current: any, memo: HistoryMemo, limit: number) => boolean;

	constructor(
		store,
		tableId: number,
		eligible: (id: any, current: any, memo: HistoryMemo, limit: number) => boolean,
		limits: HistoryReadLimits = {}
	) {
		this.memo = new HistoryMemo(store, tableId, { ...limits, cachesFrames: false });
		this.#eligible = eligible;
	}

	read(entry, time = entry.txnLogKey) {
		const { memo } = this;
		if (entry.type === 'patch' || entry.type === 'invalidate') memo.checkState();
		const rebuild = () => entry.getValue?.(memo.store, true, time, memo.exhausted || memo.closed ? undefined : memo);
		if (entry.type !== 'patch' || memo.exhausted || memo.closed) {
			if (entry.type !== 'message' && memo.carries > 0 && entry.recordId !== undefined)
				this.#dropImage(memo.key('carry', entry.recordId), entry);
			return rebuild();
		}
		const id = entry.recordId;
		const key = memo.carries > 0 ? memo.key('carry', id) : undefined;
		let carry: Carry | undefined = key && memo.get(key);
		let current;
		if (carry) {
			current = memo.store.getEntry(id);
			if (carry.stamp !== recordStamp(current)) {
				memo.forget(key);
				carry = undefined;
			}
		}
		let record = carry?.image ? this.#carried(entry, time, carry.image) : undefined;
		if (record === undefined) {
			const visits = memo.visits;
			const newer = memo.newer;
			const fallbacks = memo.fallbacks;
			record = rebuild();
			if (memo.fallbacks !== fallbacks || memo.exhausted || memo.closed) return record;
			if (record == null || typeof record !== 'object') {
				if (carry) memo.forget(key);
				return record;
			}
			if (!carry) {
				const later = memo.newer - newer;
				if (later >= CARRY_MIN_NEWER) {
					const limit = Math.min(CARRY_SCAN_LIMIT, ((later - 1) * (memo.visits - visits)) / 2);
					this.#decide(id, current ?? memo.store.getEntry(id), record, time, entry, limit);
				}
				return record;
			}
		}
		if (entry.version >= current.version) memo.forget(key);
		else if (carry.allowed) this.#keepImage(key, carry.stamp, record, time, entry);
		return record;
	}

	#carried(entry, time: number, image: CarryImage) {
		if (
			entry.previousAdditionalAuditRefs?.length ||
			!(entry.version > image.version) ||
			entry.previousVersion !== image.time ||
			(entry.nodeId ?? 0) !== image.origin
		)
			return;
		const { memo } = this;
		try {
			const frame = readAuditFrame(
				memo.store.rootStore.auditStore,
				memo.tableId,
				entry.recordId,
				time,
				entry.nodeId,
				true,
				memo
			);
			const mutations = frame.filter(isMutation);
			if (mutations.length !== 1 || mutations[0].type !== 'patch') return;
			const update = entry.getValue(memo.store, false);
			if (update == null || Object.prototype.toString.call(update) !== '[object Object]') return;
			const record = copyImage(image.record, memo.maxBytes).record;
			applyForward(record, update);
			return record;
		} catch {
			return;
		}
	}

	#decide(id, current, record, time: number, entry, limit: number) {
		const { memo } = this;
		if (!current || current.additionalAuditRefs?.length || !(current.size <= memo.maxBytes)) return;
		if (!memo.canFit(current.size + 256, 1)) return;
		const stamp = recordStamp(current);
		const key = memo.key('carry', id);
		const overhead = stamp.length * 2 + key.length * 2 + 128;
		let image: ReturnType<typeof copyImage>;
		try {
			image = copyImage(record, memo.maxBytes - memo.stats.bytes - overhead);
		} catch {
			memo.keep(key, 'carry', { stamp, allowed: false }, stamp.length * 2);
			return;
		}
		const bytes = image.bytes + stamp.length * 2;
		let allowed = false;
		try {
			allowed = this.#eligible(id, current, memo, limit);
		} catch {}
		const carry: Carry = { stamp, allowed };
		if (allowed) carry.image = { record: image.record, time, origin: entry.nodeId ?? 0, version: entry.version };
		memo.keep(key, 'carry', carry, allowed ? bytes : stamp.length * 2);
	}

	#keepImage(key: string, stamp: string, record, time: number, entry) {
		const { memo } = this;
		let image: ReturnType<typeof copyImage> | undefined;
		try {
			image = copyImage(record, memo.maxBytes);
		} catch {}
		if (image) {
			const carry: Carry = {
				stamp,
				allowed: true,
				image: { record: image.record, time, origin: entry.nodeId ?? 0, version: entry.version },
			};
			if (memo.keep(key, 'carry', carry, image.bytes + stamp.length * 2)) return;
		}
		memo.keep(key, 'carry', { stamp, allowed: false }, stamp.length * 2);
	}

	#dropImage(key: string, entry) {
		const { memo } = this;
		const carry: Carry | undefined = memo.get(key);
		if (!carry) return;
		const current = memo.store.getEntry(entry.recordId);
		if (!current || entry.version >= current.version) memo.forget(key);
		else if (carry.image)
			memo.keep(key, 'carry', { stamp: carry.stamp, allowed: carry.allowed }, carry.stamp.length * 2);
	}
}
