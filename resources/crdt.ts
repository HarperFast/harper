import { compareKeys } from 'ordered-binary';
import type { HistoryMemo } from './historyReader.ts';

// Single definition of the numeric `add` fold, shared by the storage-time merge (crdt.add, via
// updateAndFreeze) and the read/serialize path (tracked.ts Addition.update). One implementation
// keeps the two from diverging: a numeric string was concatenated on the storage path but coerced
// on the read path, and a bigint folded on the storage path but threw (`+bigint`) on the read path.
export function addValues(previousValue: any, value: any) {
	if (typeof previousValue === 'bigint') return previousValue + BigInt(value);
	if (previousValue == null) return value; // no prior value: the add establishes it
	const previous = +previousValue; // coerce so a numeric string adds instead of concatenating
	if (isNaN(previous)) return value; // non-numeric prior: the add establishes it
	// A number-typed field stays a number even if a stray bigint delta arrives, rather than throwing
	// a number+bigint TypeError on the apply path.
	return previous + (typeof value === 'bigint' ? Number(value) : value);
}
export function add(record, property, action) {
	record[property] = addValues(record[property], action.value);
}
add.reverse = function (record, property, action) {
	const previousValue = record[property];
	if (typeof previousValue === 'bigint') {
		record[property] = previousValue - BigInt(action.value);
	} else if (!isNaN(record[property])) {
		// addValues keeps a number field a number under a bigint delta
		record[property] = previousValue - Number(action.value);
	}
};
// The CRDT operation registry. Exported so the storage/apply path (tracked.ts updateAndFreeze)
// resolves ops against this explicit set rather than the module's export namespace — otherwise a
// crafted/corrupt `__op__` naming any exported function (addValues, getRecordAtTime, …) would
// resolve truthy and be invoked with the wrong arguments (throwing and wedging the apply path, or
// silently corrupting the field). applyReverse/applyForward below already resolve through this.
// Null-prototype so a crafted `__op__` naming an Object.prototype member (toString, valueOf,
// constructor, …) resolves to undefined rather than an inherited function.
export const operations = Object.assign(Object.create(null), {
	add,
});
export const OPERATION_TYPES = new Set(['Int', 'Long', 'Float', 'Number', 'BigInt', 'Any']);

/**
 * Rebuild a record update that has a timestamp before the provided newer update
 * @param update
 * @param newerUpdate
 */
export function rebuildUpdateBefore(update: any, newerUpdate: any, fullUpdate?: boolean) {
	// nothing newer to rebuild against (e.g. the basis is a chained delete's staged
	// `{ value: undefined }` on an audit-off table): nothing is superseded, keep every field
	if (newerUpdate == null) return update;
	let newUpdate = null;
	for (const key in update) {
		if (key in newerUpdate) {
			const newerValue = newerUpdate[key];
			if (newerValue?.__op__) {
				const value = update[key];
				if (value?.__op__) {
					if (value.__op__ === newerValue.__op__) {
						// we only have add right now
						if (!newUpdate) newUpdate = {};
						newUpdate[key] = value;
					} else throw new Error('Can not merge updates with different operations');
				} else {
					if (!newUpdate) newUpdate = {};
					// start with the older value
					newUpdate[key] = value;
					// and apply the newer update
					add(newUpdate, key, newerValue);
				}
			} else if (fullUpdate) {
				// if the newer update has a direct non-CRDT value, it overwrites the older update, but if we are using a full copy, we need to include it
				if (!newUpdate) newUpdate = {};
				newUpdate[key] = newerValue;
			} // else we can skip for a patch
		} else {
			// if the newer update does not have a value for this key, we can include it
			if (!newUpdate) newUpdate = {};
			newUpdate[key] = update[key];
		}
	}
	return newUpdate;
}

/**
 * The commutative operations in an out-of-order `update` — the only part of it whose outcome does not
 * depend on where it lands in the write order. Used when the audit history the update would have been
 * resequenced against is no longer retained.
 *
 * Not `rebuildUpdateBefore`, which folds an update against another UPDATE: against a materialized
 * record its plain-newer-value rule drops the incoming `add` on any key the record already has a
 * value for.
 */
export function commutativeOpsOf(update: any) {
	let ops = null;
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			if (!ops) ops = {};
			ops[key] = value;
		}
	}
	return ops;
}

/** Whether `commutativeOpsOf(update)` finds any operation, without allocating its result. */
export function hasCommutativeOp(update: any): boolean {
	for (const key in update) {
		if (update[key]?.__op__) return true;
	}
	return false;
}

/**
 * What an out-of-order `update` still contributes to a materialized `record` that already includes
 * newer writes: commutative operations and keys the record lacks. Null when nothing remains, `update`
 * itself when nothing was dropped.
 * Not `rebuildUpdateBefore`: a stored value carries no `__op__`, so it drops an incoming `add` on any
 * key the record holds.
 */
export function remainingAgainstRecord(update: any, record: any) {
	if (record == null) return update;
	let remaining = null;
	let dropped = false;
	for (const key in update) {
		const value = update[key];
		if (value?.__op__ || !holdsField(record, key)) {
			remaining ??= {};
			// a JSON-parsed '__proto__' key must stay a data property, not become the prototype
			if (key === '__proto__')
				Object.defineProperty(remaining, key, { value, enumerable: true, writable: true, configurable: true });
			else remaining[key] = value;
		} else dropped = true;
	}
	return dropped || !remaining ? remaining : update;
}

// Stored fields are own properties, or accessors on a decoder-installed prototype; Object.prototype
// members and prototype methods (toJSON, getUpdatedTime) are not fields.
function holdsField(record: any, key: string) {
	for (let object = record; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (descriptor) return object === record || descriptor.get !== undefined;
	}
	return false;
}

// A plain set has no inverse, so its key is left to older history (`unknowns`), and an older add
// under it is not reversed: subtracting from the set's value would invent one. An add reverses
// exactly in safe-integer arithmetic, except one that established its field from absent or null,
// which reverses to 0; such keys wait in `reversedAdds` for getRecordAtTime to keep only a nonzero
// result (a coerced numeric string or boolean comes back as its number).
export function applyReverse(
	record,
	update,
	unknowns: Set<string>,
	reversedAdds: Set<string>,
	overwritten: Set<string>
) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			if (overwritten.has(key)) continue;
			const reverse = operations[value.__op__]?.reverse;
			if (!reverse) throw new Error(`Unsupported operation ${value.__op__}`);
			const exact = value.__op__ === 'add' && isExactInteger(record[key]) && isExactInteger(value.value);
			reverse(record, key, { value: value.value });
			(exact ? reversedAdds : unknowns).add(key);
		} else {
			unknowns.add(key);
			overwritten.add(key);
		}
	}
}

function isExactInteger(value: unknown) {
	return typeof value === 'bigint' || Number.isSafeInteger(value);
}

// Apply an audit update onto a record moving forward in time (the inverse of applyReverse). When
// `skipUnseededOps` is true (a partial replay whose base was pruned), CRDT operations on keys not
// yet present on `record` are skipped rather than folded onto undefined.
export function applyForward(record, update, skipUnseededOps = false) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			if (skipUnseededOps && !Object.hasOwn(record, key)) continue;
			const operation = operations[value.__op__];
			if (operation) operation(record, key, { value: value.value });
			else throw new Error(`Unsupported operation ${value.__op__}`);
		} else {
			record[key] = value;
		}
	}
}

/**
 * Reconstruct the record state at `timestamp` by walking the audit history forward from the most
 * recent full `put` at or before `timestamp`. Used when `getRecordAtTime` has no usable live base
 * (missing/evicted `currentEntry`, a reverse walk that crosses a `put` or `delete`, or a post-eviction
 * re-insert with a broken `previousVersion` chain) and when filling `unknowns` on a live record.
 *
 * `fromPosition` is the starting audit position, carrying its decoded frame when available.
 * The walk follows previous links and skips entries newer than `timestamp` (which may fall
 * between entries). Returns `null` if the record did not exist at `timestamp` (the nearest in-range
 * history boundary is a delete with no surviving writes, or there is no in-range history).
 * Incomplete whole-record history can return `undefined`. Partial reconstruction replays surviving
 * writes and marks `partial.truncated` so the caller preserves unresolved fields.
 */
function reconstructForward(
	auditStore,
	store,
	tableId: number,
	recordId: any,
	fromPosition,
	timestamp,
	partial?: { truncated: boolean },
	memo?: HistoryMemo
) {
	// Collect the in-range entries (at or before `timestamp`) back to a base boundary, newest-first.
	// The boundary is a full `put` (snapshot) or a `delete` (everything older is erased); a record
	// whose first write was a `patch` has no put and bottoms out at the start of history. Only
	// `put`/`patch` contribute to the value; other partial types such as `invalidate` are ignored by a
	// whole-record caller and end a partial one's history.
	const entries = [];
	let truncated = false;
	let { txnLogKey: auditTime, nodeId: auditNodeId, frame } = fromPosition;
	const visitedFrames = new Set<string>();
	frames: while (auditTime > 0) {
		frame ??= readAuditFrame(auditStore, tableId, recordId, auditTime, auditNodeId, true, memo);
		const identity = `${frame[0]?.nodeId ?? auditNodeId ?? 0}:${auditTime}`;
		if (frame.length === 0 || visitedFrames.has(identity)) {
			if (partial) {
				truncated = true;
				break;
			}
			return entries.length === 0 ? null : undefined;
		}
		visitedFrames.add(identity);
		for (let index = frame.length - 1; index >= 0; index--) {
			const auditEntry = frame[index];
			// a corrupt entry reads with no type and no previous link, which must not pass for the start of history
			if (partial && auditEntry.type === undefined) {
				truncated = true;
				break frames;
			}
			if (auditEntry.type === 'delete') {
				// A delete at or before `timestamp` bounds the history; the record is rebuilt from the
				// writes collected after it (an empty base). A delete newer than `timestamp` (a later
				// delete/re-insert cycle) is irrelevant and skipped, like any other newer entry.
				if (auditTime <= timestamp) break frames;
			} else if (auditTime <= timestamp) {
				if (auditEntry.type === 'put') {
					entries.push(auditEntry);
					break frames; // full snapshot reached; nothing older is needed
				} else if (auditEntry.type === 'patch') {
					entries.push(auditEntry);
				} else if (partial && auditEntry.type === 'invalidate') {
					// an invalidate replaced the record with a stub (projection and indexed fields): older writes
					// no longer describe it, and a field the stub lacks is unknown, not absent
					partial.truncated = truncated = true;
					break frames;
				}
			}
			if (partial) {
				const previousPosition = previousAuditPosition(auditStore, tableId, recordId, auditEntry);
				if (mergesBranchBy(auditEntry.previousAdditionalAuditRefs, previousPosition, timestamp))
					partial.truncated = true;
			}
		}
		// Later mutations link back to this frame; only its first entry leads out.
		const previousPosition = previousAuditPosition(auditStore, tableId, recordId, frame[0]);
		auditTime = previousPosition.txnLogKey;
		auditNodeId = previousPosition.nodeId;
		frame = undefined;
	}
	if (partial && truncated) partial.truncated = true;
	if (entries.length === 0) return null; // record did not exist at `timestamp`
	// Replay oldest-first. The base is the put if the chain reached one; otherwise an empty record
	// (the first in-range write was a patch, or a delete bounds the history) onto which patches apply.
	let record = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const auditEntry = entries[i];
		const value = auditEntry.getValue(store);
		if (value == null && partial) {
			// an entry with no readable body (minted without one, or undecodable) hides what it wrote, so
			// nothing before it can settle a key either: restart as after a pruned link
			partial.truncated = truncated = true;
			record = {};
			continue;
		}
		// Copy the base put: applyForward mutates `record`, and getValue may return a cached
		// object shared with the audit entry.
		if (auditEntry.type === 'put') record = { ...value };
		else {
			if (record == null) record = {};
			applyForward(record, value, truncated);
		}
	}
	return record;
}

export function readAuditFrame(
	auditStore,
	tableId: number,
	recordId: any,
	key: number,
	nodeId,
	followingCommittedRef = false,
	memo?: HistoryMemo
) {
	if (memo && (memo.tableId !== tableId || memo.store.rootStore.auditStore !== auditStore)) memo = undefined;
	if (memo) {
		memo.visits++;
		if (!(key >= memo.lowest)) memo.lowest = key;
		if (!memo.cachesFrames) memo = undefined;
	}
	const cacheKey = memo?.key('frame', recordId, key, nodeId, followingCommittedRef);
	const cached = memo?.frame(cacheKey);
	if (cached) return cached;
	if (typeof auditStore.logById !== 'function') {
		const entry = auditStore.get(key, tableId, recordId, nodeId, followingCommittedRef);
		const entries = entry?.tableId === tableId && compareKeys(entry.recordId, recordId) === 0 ? [entry] : [];
		return memo
			? memo.rememberFrame(
					cacheKey,
					entries.map((entry) => ({ ...memo.snapshot(entry), txnLogKey: key })),
					entries.length > 0
				)
			: entries;
	}
	let origin = nodeId;
	const entries = [];
	const snapshots = [];
	const ended = memo ? new Set<number>() : undefined;
	let bad = false;
	let bytes = 0;
	const range = auditStore.getRange({
		start: key,
		end: Infinity,
		exactStart: true,
		log: origin,
		readUncommitted: followingCommittedRef,
	});
	for (const entry of range) {
		if (entry.txnLogKey !== key) break;
		const entryOrigin = entry.nodeId ?? 0;
		if (memo && (entry.type === undefined || (origin != null && entryOrigin === origin && ended.has(origin))))
			bad = true;
		const entryId = entry.tableId === tableId ? entry.recordId : undefined;
		if (
			memo &&
			entry.tableId === tableId &&
			entryId === undefined &&
			(STATE_TYPES.has(entry.type) || entry.type === 'invalidate')
		)
			bad = true;
		if (entry.tableId === tableId && compareKeys(entryId, recordId) === 0) {
			origin ??= entryOrigin;
			if (entryOrigin === origin) {
				if (memo) {
					if (ended.has(origin)) bad = true;
					const snapshot = memo.snapshot(entry);
					bytes += snapshot.encoded.byteLength + 64;
					if (!memo.canFit(bytes + cacheKey.length * 2 + 128, snapshots.length + 1)) memo.unavailable();
					snapshots.push(snapshot);
				} else entries.push(entry);
			}
		}
		if (memo && entry.endTxn) {
			if (ended.size >= 32) bad = true;
			else ended.add(entryOrigin);
		}
	}
	if (memo) {
		const complete = !bad && ended.has(origin) && !range.failedLogs?.size && !range.corruptFrameStop?.breaks;
		return memo.rememberFrame(cacheKey, snapshots, complete);
	}
	return entries;
}

function reconstructAtTimestamp(
	auditStore,
	store,
	tableId: number,
	recordId: any,
	timestamp,
	nodeId,
	memo?: HistoryMemo
) {
	const isOfRecord = (auditEntry) => auditEntry.tableId === tableId && compareKeys(auditEntry.recordId, recordId) === 0;
	let frame = readAuditFrame(auditStore, tableId, recordId, timestamp, nodeId, false, memo);
	let start = frame.at(-1);
	// An unlinked control entry has no record image to reconstruct.
	if (!(start && isOfRecord(start) && (STATE_TYPES.has(start.type) || start.previousVersion))) {
		start = undefined;
		let lowerBound = auditStore.getAuditFloor?.() ?? 1;
		if (lowerBound > 1) {
			// Native logs can append older keys later; the first yielded key is not a lower bound.
			for (const retained of auditStore.getRange({ start: 1, end: Math.min(lowerBound, timestamp + 0.001) })) {
				if (retained.txnLogKey > 0 && Number.isFinite(retained.txnLogKey))
					lowerBound = Math.min(lowerBound, retained.txnLogKey);
			}
		}
		lowerBound = Math.max(1, lowerBound);
		let windowEnd = timestamp + 0.001;
		let windowStart = Number.isFinite(timestamp) ? timestamp : lowerBound;
		const hasState = (entry) => STATE_TYPES.has(entry.type) || entry.previousVersion;
		for (let width = 100; !start && windowEnd > lowerBound; windowStart -= width, width *= 2) {
			for (const auditEntry of auditStore.getRange({ start: Math.max(windowStart, lowerBound), end: windowEnd })) {
				if (auditEntry.txnLogKey > timestamp || !isOfRecord(auditEntry) || !hasState(auditEntry)) continue;
				if (
					start &&
					(auditEntry.txnLogKey < start.txnLogKey ||
						(auditEntry.txnLogKey === start.txnLogKey && nodeId != null && (start.nodeId ?? 0) === nodeId))
				)
					continue;
				let candidate = auditEntry;
				if (nodeId != null && (auditEntry.nodeId ?? 0) !== nodeId) {
					const preferredFrame = readAuditFrame(
						auditStore,
						tableId,
						recordId,
						auditEntry.txnLogKey,
						nodeId,
						false,
						memo
					);
					const preferredState = preferredFrame.findLast(hasState);
					if (preferredState) candidate = preferredState;
					else if (preferredFrame.some((entry) => entry.type === 'invalidate')) continue;
				}
				start = candidate;
			}
			windowEnd = windowStart;
		}
		if (!start) return null;
		frame = readAuditFrame(auditStore, tableId, recordId, start.txnLogKey, start.nodeId, false, memo);
	}
	return reconstructForward(
		auditStore,
		store,
		tableId,
		recordId,
		{ txnLogKey: start.txnLogKey ?? timestamp, nodeId: start.nodeId, frame },
		timestamp,
		undefined,
		memo
	);
}
const STATE_TYPES = new Set(['put', 'patch', 'delete']);

function resolveAuditPosition(auditStore, tableId: number, recordId: any, version, nodeId, refs) {
	if (!refs?.length) return { txnLogKey: version, nodeId };
	const visited = new Set<string>();
	const pending = refs.slice().reverse();
	while (pending.length > 0) {
		const ref = pending.pop();
		const identity = `${ref.nodeId ?? 0}:${ref.version}`;
		if (visited.has(identity)) continue;
		visited.add(identity);
		const entry = auditStore.get(ref.version, tableId, recordId, ref.nodeId, true);
		if (!entry) continue;
		if (entry.version === version && (nodeId == null || (entry.nodeId ?? 0) === nodeId))
			return { txnLogKey: ref.version, nodeId: ref.nodeId };
		const previousRefs = entry.previousAdditionalAuditRefs;
		if (previousRefs) {
			for (let index = previousRefs.length - 1; index >= 0; index--) pending.push(previousRefs[index]);
		}
	}
	return { txnLogKey: version, nodeId };
}

// An out-of-order write merged into the record sits on a branch the walks never visit (they follow
// one predecessor), so history that crosses one merged by `timestamp` cannot prove a key absent.
function mergesBranchBy(refs, followed, timestamp) {
	return refs?.some(
		(ref) =>
			ref.version <= timestamp && (ref.version !== followed.txnLogKey || (ref.nodeId ?? 0) !== (followed.nodeId ?? 0))
	);
}

function previousAuditPosition(auditStore, tableId: number, recordId: any, auditEntry) {
	return resolveAuditPosition(
		auditStore,
		tableId,
		recordId,
		auditEntry.previousVersion,
		auditEntry.previousNodeId,
		auditEntry.previousAdditionalAuditRefs
	);
}

/**
 * Reconstruct the record state at a given timestamp by going back through the audit history and reversing any changes
 * @param currentEntry
 * @param timestamp
 * @param store
 * @returns
 */
export function getRecordAtTime(
	currentEntry,
	timestamp,
	store,
	tableId: number,
	recordId: any,
	nodeId?: number,
	memo?: HistoryMemo
) {
	if (memo && memo.store === store && memo.tableId === tableId && memo.checkState()) {
		try {
			return recordAtTime(currentEntry, timestamp, store, tableId, recordId, nodeId, memo);
		} catch {
			memo.fallbacks++;
			// a memo that caches no frames took no part in the failed read
			if (memo.cachesFrames) memo.stopOptimizing();
		}
	}
	return recordAtTime(currentEntry, timestamp, store, tableId, recordId, nodeId);
}

function recordAtTime(
	currentEntry,
	timestamp,
	store,
	tableId: number,
	recordId: any,
	nodeId?: number,
	memo?: HistoryMemo
) {
	const auditStore = store.rootStore.auditStore;
	if (!currentEntry) return reconstructAtTimestamp(auditStore, store, tableId, recordId, timestamp, nodeId, memo);
	let record = { ...currentEntry.value };
	// `localTime` is the record's audit head on both engines: the audit-store key on LMDB, where it
	// is a different clock than the record version, and the transaction-log key on RocksDB. Only a
	// RocksDB record carrying `additionalAuditRefs` needs its head resolved from the version.
	const initialPosition = currentEntry.additionalAuditRefs?.length
		? resolveAuditPosition(
				auditStore,
				tableId,
				recordId,
				currentEntry.version,
				currentEntry.nodeId,
				currentEntry.additionalAuditRefs
			)
		: { txnLogKey: currentEntry.localTime ?? currentEntry.version, nodeId: currentEntry.nodeId };
	let auditTime = initialPosition.txnLogKey;
	let auditNodeId = initialPosition.nodeId;
	let branched = mergesBranchBy(currentEntry.additionalAuditRefs, initialPosition, timestamp);
	// Iterate in reverse through the record history, trying to reverse all changes
	const unknowns = new Set<string>();
	const reversedAdds = new Set<string>();
	const overwritten = new Set<string>();
	let replaced = false;
	const visitedFrames = new Set<string>();
	while (auditTime > timestamp) {
		if (memo) memo.newer++;
		const frame = readAuditFrame(auditStore, tableId, recordId, auditTime, auditNodeId, true, memo);
		const identity = `${frame[0]?.nodeId ?? auditNodeId ?? 0}:${auditTime}`;
		if (frame.length === 0 || visitedFrames.has(identity)) break;
		visitedFrames.add(identity);
		for (let index = frame.length - 1; index >= 0; index--) {
			const auditEntry = frame[index];
			switch (auditEntry.type) {
				case 'put':
				case 'delete':
				case 'invalidate': // the newer stub lacks unindexed fields, so it cannot be reversed from
					replaced = true;
					break;
				case 'patch':
					if (!replaced) {
						const update = auditEntry.getValue(store);
						// a patch with no readable body cannot be reversed, but the state before it does not need it
						if (update == null) replaced = true;
						else applyReverse(record, update, unknowns, reversedAdds, overwritten);
					}
					break;
			}
			const previousPosition = previousAuditPosition(auditStore, tableId, recordId, auditEntry);
			branched ||= mergesBranchBy(auditEntry.previousAdditionalAuditRefs, previousPosition, timestamp);
		}
		const previousPosition = previousAuditPosition(auditStore, tableId, recordId, frame[0]);
		auditTime = previousPosition.txnLogKey;
		auditNodeId = previousPosition.nodeId;
	}
	if (!(auditTime > 0 && auditTime <= timestamp)) {
		return reconstructAtTimestamp(auditStore, store, tableId, recordId, timestamp, nodeId, memo);
	}
	if (replaced) {
		return reconstructForward(
			auditStore,
			store,
			tableId,
			recordId,
			{ txnLogKey: auditTime, nodeId: auditNodeId },
			timestamp,
			undefined,
			memo
		);
	}
	// If the most recent entry at or before `timestamp` is a delete, the record did not exist then.
	// (A delete reached as a boundary — rather than crossed, which returns via reconstructForward —
	// is otherwise missed, leaving `record` holding a newer re-inserted value. See issue #1330.)
	const boundaryFrame = readAuditFrame(auditStore, tableId, recordId, auditTime, auditNodeId, true, memo);
	for (let index = boundaryFrame.length - 1; index >= 0; index--) {
		const type = boundaryFrame[index].type;
		if (type === 'delete') return null;
		if (STATE_TYPES.has(type)) break;
	}
	for (const key of reversedAdds) {
		const value = record[key];
		if (!isExactInteger(value) || value === 0 || value === 0n) unknowns.add(key);
	}
	if (unknowns.size > 0 && auditTime > 0) {
		const partial = { truncated: branched };
		// null: no put or patch survives at or before `timestamp` (e.g. only a message after a delete)
		const priorRecord =
			reconstructForward(
				auditStore,
				store,
				tableId,
				recordId,
				{ txnLogKey: auditTime, nodeId: auditNodeId, frame: boundaryFrame },
				timestamp,
				partial,
				memo
			) ?? {};
		for (const key of unknowns) {
			// Object.hasOwn, not `in`: an unknown field named like a prototype member (toString,
			// constructor, …) must not be filled from priorRecord's prototype chain.
			if (Object.hasOwn(priorRecord, key)) record[key] = priorRecord[key];
			else if (!partial.truncated) delete record[key]; // complete history: it did not exist then
		}
	}
	// finally return the record in the state it was at the requested timestamp
	return record;
}
