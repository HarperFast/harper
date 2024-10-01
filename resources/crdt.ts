import { readAuditEntry } from './auditStore';

export function add(record, property, action) {
	const previous_value = record[property];
	if (typeof previous_value === 'bigint') {
		record[property] = previous_value + BigInt(action.value);
	} else if (isNaN(record[property])) record[property] = action.value;
	else {
		record[property] = previous_value + action.value;
	}
}
add.reverse = function (record, property, action) {
	const previous_value = record[property];
	if (typeof previous_value === 'bigint') {
		record[property] = previous_value - BigInt(action.value);
	} else if (!isNaN(record[property])) {
		record[property] = previous_value - action.value;
	}
};
const operations = {
	add,
};

/**
 * Rebuild a record update that has a timestamp before the provided newer update
 * @param update
 * @param newer_update
 */
export function rebuildUpdateBefore(update: any, newer_update: any, full_update?: boolean) {
	let new_update = null;
	for (const key in update) {
		if (key in newer_update) {
			const newer_value = newer_update[key];
			if (newer_value?.__op__) {
				const value = update[key];
				if (value?.__op__) {
					if (value.__op__ === newer_value.__op__) {
						// we only have add right now
						if (!new_update) new_update = {};
						new_update[key] = value;
					} else throw new Error('Can not merge updates with different operations');
				} else {
					if (!new_update) new_update = {};
					// start with the older value
					new_update[key] = value;
					// and apply the newer update
					add(new_update, key, newer_value);
				}
			} else if (full_update) {
				// if the newer update has a direct non-CRDT value, it overwrites the older update, but if we are using a full copy, we need to include it
				if (!new_update) new_update = {};
				new_update[key] = newer_value;
			} // else we can skip for a patch
		} else {
			// if the newer update does not have a value for this key, we can include it
			if (!new_update) new_update = {};
			new_update[key] = update[key];
		}
	}
	return new_update;
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
 * @param current_entry
 * @param timestamp
 * @param store
 * @returns
 */
export function getRecordAtTime(current_entry, timestamp, store) {
	const audit_store = store.rootStore.auditStore;
	let record = { ...current_entry.value };
	let audit_time = current_entry.localTime;
	// Iterate in reverse through the record history, trying to reverse all changes
	while (audit_time > timestamp) {
		const audit_data = audit_store.get(audit_time);
		// TODO: Caching of audit entries
		const audit_entry = readAuditEntry(audit_data);
		switch (audit_entry.type) {
			case 'put':
				record = audit_entry.getValue(store);
				break;
			case 'patch':
				applyReverse(record, audit_entry.getValue(store));
				break;
			case 'delete':
				record = null;
		}
		audit_time = audit_entry.previousLocalTime;
	}
	// some patches may leave properties in an unknown state, so we need to fill in the blanks
	// first we determine if there any unknown properties
	const unknowns = {};
	let unknown_count = 0;
	for (const key in record) {
		if (record[key] === UNKNOWN) {
			unknowns[key] = true;
			unknown_count++;
		}
	}
	// then continue to iterate back through the audit history, filling in the blanks
	while (unknown_count > 0 && audit_time > 0) {
		const audit_data = audit_store.get(audit_time);
		const audit_entry = readAuditEntry(audit_data);
		let prior_record;
		switch (audit_entry.type) {
			case 'put':
				prior_record = audit_entry.getValue(store);
				break;
			case 'patch':
				prior_record = audit_entry.getValue(store);
				break;
		}
		for (const key in prior_record) {
			if (unknowns[key]) {
				record[key] = prior_record[key];
				unknowns[key] = false;
				unknown_count--;
			}
		}
		audit_time = audit_entry.previousLocalTime;
	}
	if (unknown_count > 0) {
		// if we were unable to determine the value of a property, set it to null
		for (const key in unknowns) record[key] = null;
	}
	// finally return the record in the state it was at the requested timestamp
	return record;
}
