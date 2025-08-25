import { readAuditEntry } from './auditStore.ts';

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
export function applyReverse(record, update) {
	for (const key in update) {
		const value = update[key];
		if (value?.__op__) {
			const reverse = operations[value.__op__]?.reverse;
			if (reverse) reverse(record, key, { value: value.value });
			else throw new Error(`Unsupported operation ${value.__op__}`);
		} else {
			record[key] = UNKNOWN;
		}
	}
}
const UNKNOWN = {};
/**
 * Reconstruct the record state at a given timestamp by going back through the audit history and reversing any changes
 * @param currentEntry
 * @param timestamp
 * @param store
 * @returns
 */
export function getRecordAtTime(currentEntry, timestamp, store) {
	const auditStore = store.rootStore.auditStore;
	let record = { ...currentEntry.value };
	let auditTime = currentEntry.localTime;
	// Iterate in reverse through the record history, trying to reverse all changes
	while (auditTime > timestamp) {
		const auditData = auditStore.get(auditTime);
		// TODO: Caching of audit entries
		const auditEntry = readAuditEntry(auditData);
		switch (auditEntry.type) {
			case 'put':
				record = auditEntry.getValue(store);
				break;
			case 'patch':
				applyReverse(record, auditEntry.getValue(store));
				break;
			case 'delete':
				record = null;
		}
		auditTime = auditEntry.previousLocalTime;
	}
	// some patches may leave properties in an unknown state, so we need to fill in the blanks
	// first we determine if there any unknown properties
	const unknowns = {};
	let unknownCount = 0;
	for (const key in record) {
		if (record[key] === UNKNOWN) {
			unknowns[key] = true;
			unknownCount++;
		}
	}
	// then continue to iterate back through the audit history, filling in the blanks
	while (unknownCount > 0 && auditTime > 0) {
		const auditData = auditStore.get(auditTime);
		const auditEntry = readAuditEntry(auditData);
		let priorRecord;
		switch (auditEntry.type) {
			case 'put':
				priorRecord = auditEntry.getValue(store);
				break;
			case 'patch':
				priorRecord = auditEntry.getValue(store);
				break;
		}
		for (const key in priorRecord) {
			if (unknowns[key]) {
				record[key] = priorRecord[key];
				unknowns[key] = false;
				unknownCount--;
			}
		}
		auditTime = auditEntry.previousLocalTime;
	}
	if (unknownCount > 0) {
		// if we were unable to determine the value of a property, set it to null
		for (const key in unknowns) record[key] = null;
	}
	// finally return the record in the state it was at the requested timestamp
	return record;
}
