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

// A plain set has no inverse, so its key is left to older history (`unknowns`). An add reverses
// exactly in safe-integer arithmetic, except one that established its field from absent or null,
// which reverses to 0; such keys wait in `reversedAdds` for getRecordAtTime to keep only a nonzero
// result (a coerced numeric string or boolean comes back as its number).
export function applyReverse(record, update, unknowns: Set<string>, reversedAdds: Set<string>) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			const reverse = operations[value.__op__]?.reverse;
			if (!reverse) throw new Error(`Unsupported operation ${value.__op__}`);
			const exact = value.__op__ === 'add' && isExactInteger(record[key]) && isExactInteger(value.value);
			reverse(record, key, { value: value.value });
			(exact ? reversedAdds : unknowns).add(key);
		} else {
			unknowns.add(key);
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
 * `fromPosition` is the starting audit position; the walk follows the previous links from there.
 * Entries newer than `timestamp` are skipped (the cutoff may fall between entries). Returns `null`
 * if the record did not exist at `timestamp` (the nearest in-range history boundary is a delete
 * with no surviving writes, or there is no in-range history). When a prior link leads to a pruned
 * entry, returns `undefined` without `partial` (history is incomplete for a whole-record caller);
 * with `partial` (the `unknowns` fill on a live record) it replays the surviving writes and sets
 * `partial.truncated` when the history it read was incomplete.
 */
function reconstructForward(
	auditStore,
	store,
	tableId: number,
	recordId: any,
	fromPosition,
	timestamp,
	partial?: { truncated: boolean }
) {
	// Collect the in-range entries (at or before `timestamp`) back to a base boundary, newest-first.
	// The boundary is a full `put` (snapshot) or a `delete` (everything older is erased); a record
	// whose first write was a `patch` has no put and bottoms out at the start of history. Only
	// `put`/`patch` contribute to the value, matching the reverse walk's switch (other partial types
	// such as `invalidate` are ignored).
	const entries = [];
	let truncated = false;
	let { txnLogKey: auditTime, nodeId: auditNodeId } = fromPosition;
	while (auditTime > 0) {
		const auditEntry = auditStore.get(auditTime, tableId, recordId, auditNodeId);
		if (!auditEntry) {
			if (partial) {
				truncated = true;
				break;
			}
			return entries.length === 0 ? null : undefined;
		}
		// a corrupt entry reads with no type and no previous link, which must not pass for the start of history
		if (partial && auditEntry.type === undefined) {
			truncated = true;
			break;
		}
		if (auditEntry.type === 'delete') {
			// A delete at or before `timestamp` bounds the history; the record is rebuilt from the
			// writes collected after it (an empty base). A delete newer than `timestamp` (a later
			// delete/re-insert cycle) is irrelevant and skipped, like any other newer entry.
			if (auditTime <= timestamp) break;
		} else if (auditTime <= timestamp) {
			if (auditEntry.type === 'put') {
				entries.push(auditEntry);
				break; // full snapshot reached; nothing older is needed
			} else if (auditEntry.type === 'patch') {
				entries.push(auditEntry);
			}
		}
		const previousPosition = previousAuditPosition(auditStore, tableId, recordId, auditEntry);
		if (partial && mergesBranchBy(auditEntry.previousAdditionalAuditRefs, previousPosition, timestamp))
			partial.truncated = true;
		auditTime = previousPosition.txnLogKey;
		auditNodeId = previousPosition.nodeId;
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

function resolveAuditPosition(auditStore, tableId: number, recordId: any, version, nodeId, refs) {
	if (!refs?.length) return { txnLogKey: version, nodeId };
	const visited = new Set<string>();
	const pending = refs.slice().reverse();
	while (pending.length > 0) {
		const ref = pending.pop();
		const identity = `${ref.nodeId ?? 0}:${ref.version}`;
		if (visited.has(identity)) continue;
		visited.add(identity);
		const entry = auditStore.get(ref.version, tableId, recordId, ref.nodeId);
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
export function getRecordAtTime(currentEntry, timestamp, store, tableId: number, recordId: any, nodeId?: number) {
	const auditStore = store.rootStore.auditStore;
	if (!currentEntry) {
		return reconstructForward(auditStore, store, tableId, recordId, { txnLogKey: timestamp, nodeId }, timestamp);
	}
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
	let replaced = false;
	while (auditTime > timestamp) {
		const auditEntry = auditStore.get(auditTime, tableId, recordId, auditNodeId);
		if (!auditEntry) break;
		switch (auditEntry.type) {
			case 'put':
			case 'delete':
				replaced = true;
				break;
			case 'patch':
				if (!replaced) {
					const update = auditEntry.getValue(store);
					// a patch with no readable body cannot be reversed, but the state before it does not need it
					if (update == null) replaced = true;
					else applyReverse(record, update, unknowns, reversedAdds);
				}
				break;
		}
		const previousPosition = previousAuditPosition(auditStore, tableId, recordId, auditEntry);
		branched ||= mergesBranchBy(auditEntry.previousAdditionalAuditRefs, previousPosition, timestamp);
		auditTime = previousPosition.txnLogKey;
		auditNodeId = previousPosition.nodeId;
	}
	if (!(auditTime > 0 && auditTime <= timestamp)) {
		return reconstructForward(auditStore, store, tableId, recordId, { txnLogKey: timestamp, nodeId }, timestamp);
	}
	if (replaced) {
		return reconstructForward(
			auditStore,
			store,
			tableId,
			recordId,
			{ txnLogKey: auditTime, nodeId: auditNodeId },
			timestamp
		);
	}
	// If the most recent entry at or before `timestamp` is a delete, the record did not exist then.
	// (A delete reached as a boundary — rather than crossed, which returns via reconstructForward —
	// is otherwise missed, leaving `record` holding a newer re-inserted value. See issue #1330.)
	if (auditTime > 0) {
		const boundaryEntry = auditStore.get(auditTime, tableId, recordId, auditNodeId);
		if (boundaryEntry?.type === 'delete') return null;
	}
	for (const key of reversedAdds) {
		const value = record[key];
		if (!isExactInteger(value) || value === 0 || value === 0n) unknowns.add(key);
	}
	if (unknowns.size > 0 && auditTime > 0) {
		const partial = { truncated: branched };
		// null: no state-bearing write survives at or before `timestamp` (e.g. an invalidate after a delete)
		const priorRecord =
			reconstructForward(
				auditStore,
				store,
				tableId,
				recordId,
				{ txnLogKey: auditTime, nodeId: auditNodeId },
				timestamp,
				partial
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
