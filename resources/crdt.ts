export function add(record, property, action) {
	const previousValue = record[property];
	if (typeof previousValue === 'bigint') {
		record[property] = previousValue + BigInt(action.value);
	} else if (isNaN(record[property])) record[property] = action.value;
	else {
		record[property] = previousValue + action.value;
	}
}
add.reverse = function (record, property, action) {
	const previousValue = record[property];
	if (typeof previousValue === 'bigint') {
		record[property] = previousValue - BigInt(action.value);
	} else if (!isNaN(record[property])) {
		record[property] = previousValue - action.value;
	}
};
const operations = {
	add,
};

/**
 * Rebuild a record update that has a timestamp before the provided newer update
 * @param update
 * @param newerUpdate
 */
export function rebuildUpdateBefore(update: any, newerUpdate: any, fullUpdate?: boolean) {
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
export function applyReverse(record, update, unknowns: Set<string>) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			const reverse = operations[value.__op__]?.reverse;
			if (reverse) reverse(record, key, { value: value.value });
			else throw new Error(`Unsupported operation ${value.__op__}`);
		} else {
			unknowns.add(key);
		}
	}
}

// Apply an audit update onto a record moving forward in time (the inverse of applyReverse). Used
// when reconstructing a record from a known-good base after the reverse walk crosses a delete.
export function applyForward(record, update) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
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
 * recent full `put` at or before `timestamp`. Used when the reverse-from-current walk in
 * getRecordAtTime crosses a `delete`: a delete erases the record, leaving no base to keep reversing
 * against, and everything newer than the delete is irrelevant to a `timestamp` that precedes it (a
 * key that was deleted then re-inserted, see issue #1330).
 *
 * `fromVersion` is the newest pre-delete entry (the delete's previousVersion); the walk follows the
 * previousVersion chain from there. Entries newer than `timestamp` are skipped (the cutoff may fall
 * between entries). Returns null if the record did not exist at `timestamp` (the nearest in-range
 * history boundary is a delete with no surviving writes, or there is no in-range history).
 */
function reconstructForward(auditStore, store, tableId: number, recordId: any, fromVersion, timestamp) {
	// Collect the in-range entries (at or before `timestamp`) back to a base boundary, newest-first.
	// The boundary is a full `put` (snapshot) or a `delete` (everything older is erased); a record
	// whose first write was a `patch` has no put and bottoms out at the start of history. Only
	// `put`/`patch` contribute to the value, matching the reverse walk's switch (other partial types
	// such as `invalidate` are ignored).
	const entries = [];
	let auditTime = fromVersion;
	while (auditTime > 0) {
		const auditEntry = auditStore.get(auditTime, tableId, recordId);
		if (!auditEntry) break;
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
		auditTime = auditEntry.previousVersion;
	}
	if (entries.length === 0) return null; // record did not exist at `timestamp`
	// Replay oldest-first. The base is the put if the chain reached one; otherwise an empty record
	// (the first in-range write was a patch, or a delete bounds the history) onto which patches apply.
	let record = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const auditEntry = entries[i];
		const value = auditEntry.getValue(store);
		// Copy the base put: applyForward mutates `record`, and getValue may return a cached
		// object shared with the audit entry.
		if (auditEntry.type === 'put') record = { ...value };
		else {
			if (record == null) record = {};
			applyForward(record, value);
		}
	}
	return record;
}

/**
 * Reconstruct the record state at a given timestamp by going back through the audit history and reversing any changes
 * @param currentEntry
 * @param timestamp
 * @param store
 * @returns
 */
export function getRecordAtTime(currentEntry, timestamp, store, tableId: number, recordId: any) {
	const auditStore = store.rootStore.auditStore;
	let record = { ...currentEntry.value };
	let auditTime = currentEntry.localTime;
	// Iterate in reverse through the record history, trying to reverse all changes
	const unknowns = new Set<string>();
	while (auditTime > timestamp) {
		const auditEntry = auditStore.get(auditTime, tableId, recordId);
		if (!auditEntry) break;
		switch (auditEntry.type) {
			case 'put':
				record = auditEntry.getValue(store);
				break;
			case 'patch':
				applyReverse(record, auditEntry.getValue(store), unknowns);
				break;
			case 'delete':
				// The reverse walk reached a delete that is newer than `timestamp`. There is no
				// base record to keep reversing patches against, so reconstruct the pre-delete
				// state forward instead (issue #1330: a key deleted then re-inserted).
				return reconstructForward(auditStore, store, tableId, recordId, auditEntry.previousVersion, timestamp);
		}
		auditTime = auditEntry.previousVersion;
	}
	// If the most recent entry at or before `timestamp` is a delete, the record did not exist then.
	// (A delete reached as a boundary — rather than crossed, which returns via reconstructForward —
	// is otherwise missed, leaving `record` holding a newer re-inserted value. See issue #1330.)
	if (auditTime > 0) {
		const boundaryEntry = auditStore.get(auditTime, tableId, recordId);
		if (boundaryEntry?.type === 'delete') return null;
	}
	// some patches may leave properties in an unknown state, so we need to fill in the blanks
	// first we determine if there any unknown properties
	// then continue to iterate back through the audit history, filling in the blanks
	while (unknowns.size > 0 && auditTime > 0) {
		const auditEntry = auditStore.get(auditTime, tableId, recordId);
		// The history needed to resolve the remaining unknowns may have been pruned away; stop
		// rather than dereferencing a missing entry (mirrors the reverse-walk guard above).
		if (!auditEntry) break;
		let priorRecord: any;
		switch (auditEntry.type) {
			case 'put':
				priorRecord = auditEntry.getValue(store);
				break;
			case 'patch':
				priorRecord = auditEntry.getValue(store);
				break;
		}
		for (const key in priorRecord) {
			if (unknowns.has(key)) {
				record[key] = priorRecord[key];
				unknowns.delete(key);
			}
		}
		auditTime = auditEntry.previousVersion;
	}
	// finally return the record in the state it was at the requested timestamp
	return record;
}
