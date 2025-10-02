import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as env_get } from '../utility/environment/environmentManager';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads';
import { convertToMS } from '../utility/common_utils';
import { PREVIOUS_TIMESTAMP_PLACEHOLDER, LAST_TIMESTAMP_PLACEHOLDER } from './RecordEncoder';
import * as harper_logger from '../utility/logging/harper_logger';
import { getRecordAtTime } from './crdt';
import { isMainThread } from 'worker_threads';
import { decodeFromDatabase, deleteBlobsInObject } from './blob';
import { onStorageReclamation } from '../server/storageReclamation';

/**
 * This module is responsible for the binary representation of audit records in an efficient form.
 * This includes a custom key encoder that specifically encodes arrays with the first element (timestamp) as a
 * 64-bit float, second (table id) as a 32-unsigned int, and third using standard ordered-binary encoding
 *
 * This also defines a binary representation for the audit records themselves which is:
 * 1 or 2 bytes: action, describes the action of this record and any flags for which other parts are included
 * table_id
 * record_id
 * origin version
 * previous local version
 * 1 or 2 bytes: position of end of the username section. 0 if there is no username
 * 2 or 4 bytes: node-id
 * 8 bytes (optional): last version timestamp (allows for backwards traversal through history of a record)
 * username
 * remaining bytes (optional, not included for deletes/invalidation): the record itself, using the same encoding as its primary store
 */
initSync();

const ENTRY_HEADER = Buffer.alloc(2816); // this is sized to be large enough for the maximum key size (1976) plus large usernames. We may want to consider some limits on usernames to ensure this all fits
const ENTRY_DATAVIEW = new DataView(ENTRY_HEADER.buffer, ENTRY_HEADER.byteOffset, 2816);
export const transactionKeyEncoder = {
	writeKey(key, buffer, position) {
		if (key === LAST_TIMESTAMP_PLACEHOLDER) {
			buffer.set(LAST_TIMESTAMP_PLACEHOLDER, position);
			return position + 8;
		}
		if (typeof key === 'number') {
			const data_view =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			data_view.setFloat64(position, key);
			return position + 8;
		} else {
			return writeKey(key, buffer, position);
		}
	},
	readKey(buffer, start, end) {
		if (buffer[start] === 66) {
			const data_view =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			return data_view.getFloat64(start);
		} else {
			return readKey(buffer, start, end);
		}
	},
};
export const AUDIT_STORE_OPTIONS = {
	encoding: 'binary',
	keyEncoder: transactionKeyEncoder,
};

let audit_retention = convertToMS(env_get(CONFIG_PARAMS.LOGGING_AUDITRETENTION)) || 86400 * 3;
const MAX_DELETES_PER_CLEANUP = 1000;
const FLOAT_TARGET = new Float64Array(1);
const FLOAT_BUFFER = new Uint8Array(FLOAT_TARGET.buffer);
let DEFAULT_AUDIT_CLEANUP_DELAY = 10000; // default delay of 10 seconds
let timestamp_errored = false;
export function openAuditStore(root_store) {
	let audit_store = (root_store.auditStore = root_store.openDB(AUDIT_STORE_NAME, {
		create: false,
		...AUDIT_STORE_OPTIONS,
	}));
	if (!audit_store) {
		// this means we are creating a new audit store. Initialize with the last removed timestamp (we don't want to put this in legacy audit logs since we don't know if they have had deletions or not).
		audit_store = root_store.auditStore = root_store.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
		updateLastRemoved(audit_store, 1);
	}
	audit_store.rootStore = root_store;
	audit_store.tableStores = [];
	const delete_callbacks = [];
	audit_store.addDeleteRemovalCallback = function (table_id, table, callback) {
		delete_callbacks[table_id] = callback;
		audit_store.tableStores[table_id] = table;
		audit_store.deleteCallbacks = delete_callbacks;
		return {
			remove() {
				delete delete_callbacks[table_id];
			},
		};
	};
	let pending_cleanup = null;
	let last_cleanup_resolution: Promise<void>;
	let cleanup_priority = 0;
	let audit_cleanup_delay = DEFAULT_AUDIT_CLEANUP_DELAY;
	onStorageReclamation(audit_store.env.path, (priority) => {
		cleanup_priority = priority; // update the priority
		if (priority) {
			// and if we have a priority, schedule cleanup soon
			return scheduleAuditCleanup(100);
		}
	});
	function scheduleAuditCleanup(new_cleanup_delay?: number): Promise<void> {
		if (new_cleanup_delay) audit_cleanup_delay = new_cleanup_delay;
		clearTimeout(pending_cleanup);
		const resolution = new Promise<void>((resolve) => {
			pending_cleanup = setTimeout(async () => {
				await last_cleanup_resolution;
				last_cleanup_resolution = resolution;
				// query for audit entries that are old
				if (audit_store.rootStore.status === 'closed' || audit_store.rootStore.status === 'closing') return;
				let deleted = 0;
				let committed: Promise<void>;
				let last_key: any;
				try {
					for (const { key, value } of audit_store.getRange({
						start: 1, // must not be zero or it will be interpreted as null and overlap with symbols in search
						snapshot: false,
						end: Date.now() - audit_retention / (1 + cleanup_priority * cleanup_priority), // remove up until the audit retention time, reducing audit retention time if cleanup is higher priority
					})) {
						try {
							committed = removeAuditEntry(audit_store, key, value);
						} catch (error) {
							harper_logger.warn('Error removing audit entry', error);
						}
						last_key = key;
						await new Promise(setImmediate);
						if (++deleted >= MAX_DELETES_PER_CLEANUP) {
							// limit the amount we cleanup per event turn so we don't use too much memory/CPU
							audit_cleanup_delay = 10; // and keep trying very soon
							break;
						}
					}
					await committed;
				} finally {
					if (deleted === 0) {
						// if we didn't delete anything, we can increase the delay (double until we get to one tenth of the retention time)
						audit_cleanup_delay = Math.min(audit_cleanup_delay << 1, audit_retention / 10);
					} else {
						// if we did delete something, update our updates since timestamp
						updateLastRemoved(audit_store, last_key);
						// and do updates faster
						if (audit_cleanup_delay > 100) audit_cleanup_delay = audit_cleanup_delay >> 1;
					}
					resolve(undefined);
					scheduleAuditCleanup();
				}
				// we can run this pretty frequently since there is very little overhead to these queries
			}, audit_cleanup_delay).unref();
		});
		return resolution;
	}
	audit_store.scheduleAuditCleanup = scheduleAuditCleanup;
	if (getWorkerIndex() === getWorkerCount() - 1) {
		scheduleAuditCleanup();
	}
	if (getWorkerIndex() === 0 && !timestamp_errored) {
		// make sure the timestamp is valid
		for (const time of audit_store.getKeys({ reverse: true, limit: 1 })) {
			if (time > Date.now()) {
				timestamp_errored = true;
				harper_logger.error(
					'The current time is before the last recorded entry in the audit log. Time reversal can undermine the integrity of data tracking and certificate validation and the time must be corrected.'
				);
			}
		}
	}
	return audit_store;
}

export function removeAuditEntry(audit_store: any, key: number, value: any): Promise<void> {
	const type = readAction(value);
	let audit_record;
	if (type & HAS_BLOBS) {
		// if it has blobs, and isn't in use from the main record, we need to delete them as well
		audit_record = readAuditEntry(value);
		const primary_store = audit_store.tableStores[audit_record.tableId];
		if (primary_store) {
			const entry =
				audit_record.type === 'message'
					? null // if the audit record is a message, then the record won't contain any of the same referenced data, so we should always remove everything
					: primary_store?.getEntry(audit_record.recordId); // otherwise, we need to check if the record is still in use
			if (!entry || entry.version !== audit_record.version || !entry.value) {
				// if the versions don't match or the record has been removed/null-ed, then this should be the only/last reference to any blob
				decodeFromDatabase(() => deleteBlobsInObject(audit_record.getValue(primary_store)), primary_store.rootStore);
			}
		}
	}

	if ((type & 15) === DELETE) {
		// if this is a delete, we remove the delete entry from the primary table
		// at the same time so the audit table the primary table are in sync, assuming the entry matches this audit record version
		audit_record = audit_record || readAuditEntry(value);
		const table_id = audit_record.tableId;
		const primary_store = audit_store.tableStores[audit_record.tableId];
		if (primary_store?.getEntry(audit_record.recordId)?.version === audit_record.version)
			audit_store.deleteCallbacks?.[table_id]?.(audit_record.recordId, audit_record.version);
	}
	return audit_store.remove(key);
}

function updateLastRemoved(audit_store, last_key) {
	FLOAT_TARGET[0] = last_key;
	audit_store.put(Symbol.for('last-removed'), FLOAT_BUFFER);
}

export function getLastRemoved(audit_store) {
	const last_removed = audit_store.get(Symbol.for('last-removed'));
	if (last_removed) {
		FLOAT_BUFFER.set(last_removed);
		return FLOAT_TARGET[0];
	}
}
export function setAuditRetention(retention_time, default_delay = DEFAULT_AUDIT_CLEANUP_DELAY) {
	audit_retention = retention_time;
	DEFAULT_AUDIT_CLEANUP_DELAY = default_delay;
}

const HAS_RECORD = 16;
const HAS_PARTIAL_RECORD = 32; // will be used for CRDTs
const PUT = 1;
const DELETE = 2;
const MESSAGE = 3;
const INVALIDATE = 4;
const PATCH = 5;
const RELOCATE = 6;
export const ACTION_32_BIT = 14;
export const ACTION_64_BIT = 15;
/** Used to indicate we have received a remote local time update */
export const REMOTE_SEQUENCE_UPDATE = 11;
const HAS_PREVIOUS_VERSION = 64;
const HAS_EXTENDED_TYPE = 128;
export const HAS_CURRENT_RESIDENCY_ID = 512;
export const HAS_PREVIOUS_RESIDENCY_ID = 1024;
export const HAS_ORIGINATING_OPERATION = 2048;
export const HAS_EXPIRATION_EXTENDED_TYPE = 0x1000;
export const HAS_BLOBS = 0x2000;
const EVENT_TYPES = {
	put: PUT | HAS_RECORD,
	[PUT]: 'put',
	delete: DELETE,
	[DELETE]: 'delete',
	message: MESSAGE | HAS_RECORD,
	[MESSAGE]: 'message',
	invalidate: INVALIDATE | HAS_PARTIAL_RECORD,
	[INVALIDATE]: 'invalidate',
	patch: PATCH | HAS_PARTIAL_RECORD,
	[PATCH]: 'patch',
	relocate: RELOCATE,
	[RELOCATE]: 'relocate',
};
const ORIGINATING_OPERATIONS = {
	insert: 1,
	update: 2,
	upsert: 3,
	1: 'insert',
	2: 'update',
	3: 'upsert',
};

/**
 * Creates a binary audit entry
 * @param txn_time
 * @param table_id
 * @param record_id
 * @param previous_local_time
 * @param node_id
 * @param username
 * @param type
 * @param encoded_record
 * @param extended_type
 * @param residency_id
 * @param previous_residency_id
 */
export function createAuditEntry(
	txn_time,
	table_id,
	record_id,
	previous_local_time,
	node_id,
	username,
	type,
	encoded_record,
	extended_type,
	residency_id,
	previous_residency_id,
	expires_at,
	originating_operation?: string
) {
	const action = EVENT_TYPES[type];
	if (!action) {
		throw new Error(`Invalid audit entry type ${type}`);
	}
	let position = 1;
	if (previous_local_time) {
		if (previous_local_time > 1) ENTRY_DATAVIEW.setFloat64(0, previous_local_time);
		else ENTRY_HEADER.set(PREVIOUS_TIMESTAMP_PLACEHOLDER);
		position = 9;
	}
	if (extended_type) {
		if (extended_type & 0xff) {
			throw new Error('Illegal extended type');
		}
		position += 3;
	}

	writeInt(node_id);
	writeInt(table_id);
	writeValue(record_id);
	ENTRY_DATAVIEW.setFloat64(position, txn_time);
	position += 8;
	if (extended_type & HAS_CURRENT_RESIDENCY_ID) writeInt(residency_id);
	if (extended_type & HAS_PREVIOUS_RESIDENCY_ID) writeInt(previous_residency_id);
	if (extended_type & HAS_EXPIRATION_EXTENDED_TYPE) {
		ENTRY_DATAVIEW.setFloat64(position, expires_at);
		position += 8;
	}
	if (extended_type & HAS_ORIGINATING_OPERATION) {
		writeInt(ORIGINATING_OPERATIONS[originating_operation]);
	}

	if (username) writeValue(username);
	else ENTRY_HEADER[position++] = 0;
	if (extended_type) ENTRY_DATAVIEW.setUint32(previous_local_time ? 8 : 0, action | extended_type | 0xc0000000);
	else ENTRY_HEADER[previous_local_time ? 8 : 0] = action;
	const header = ENTRY_HEADER.subarray(0, position);
	if (encoded_record) {
		return Buffer.concat([header, encoded_record]);
	} else return header;
	function writeValue(value) {
		const value_length_position = position;
		position += 1;
		position = writeKey(value, ENTRY_HEADER, position);
		const key_length = position - value_length_position - 1;
		if (key_length > 0x7f) {
			if (key_length > 0x3fff) {
				harper_logger.error('Key or username was too large for audit entry', value);
				position = value_length_position + 1;
				ENTRY_HEADER[value_length_position] = 0;
			} else {
				// requires two byte length header, need to move the value/key to make room for it
				ENTRY_HEADER.copyWithin(value_length_position + 2, value_length_position + 1, position);
				// now write a two-byte length header
				ENTRY_DATAVIEW.setUint16(value_length_position, key_length | 0x8000);
				// must adjust the position by one since we moved everything one position
				position++;
			}
		} else {
			// one byte length header, as expected
			ENTRY_HEADER[value_length_position] = key_length;
		}
	}
	function writeInt(number) {
		if (number < 128) {
			ENTRY_HEADER[position++] = number;
		} else if (number < 0x4000) {
			ENTRY_DATAVIEW.setUint16(position, number | 0x8000);
			position += 2;
		} else if (number < 0x3f000000) {
			ENTRY_DATAVIEW.setUint32(position, number | 0xc0000000);
			position += 4;
		} else {
			ENTRY_HEADER[position] = 0xff;
			ENTRY_DATAVIEW.setUint32(position + 1, number);
			position += 5;
		}
	}
}

/**
 * Reads an action from an audit entry binary data, quickly
 * @param buffer
 */
function readAction(buffer: Buffer) {
	let position = 0;
	if (buffer[0] == 66) {
		// 66 is the first byte in a date double, so we need to skip it
		position = 8;
	}
	const action = buffer[position];
	if (action < 0x80) {
		// simple case of a single byte
		return action;
	}
	// otherwise, we need to decode the number
	const decoder =
		buffer.dataView || (buffer.dataView = new Decoder(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	decoder.position = position;
	return decoder.readInt();
}

/**
 * Reads a audit entry from binary data
 * @param buffer
 * @param start
 * @param end
 */
export function readAuditEntry(buffer: Uint8Array, start = 0, end = undefined) {
	try {
		const decoder =
			buffer.dataView || (buffer.dataView = new Decoder(buffer.buffer, buffer.byteOffset, buffer.byteLength));
		decoder.position = start;
		let previous_local_time;
		if (buffer[decoder.position] == 66) {
			// 66 is the first byte in a date double.
			previous_local_time = decoder.readFloat64();
		}
		const action = decoder.readInt();
		const node_id = decoder.readInt();
		const table_id = decoder.readInt();
		let length = decoder.readInt();
		const record_id_start = decoder.position;
		const record_id_end = (decoder.position += length);
		const version = decoder.readFloat64();
		let residency_id, previous_residency_id, expires_at, originating_operation;
		if (action & HAS_CURRENT_RESIDENCY_ID) {
			residency_id = decoder.readInt();
		}
		if (action & HAS_PREVIOUS_RESIDENCY_ID) {
			previous_residency_id = decoder.readInt();
		}
		if (action & HAS_EXPIRATION_EXTENDED_TYPE) {
			expires_at = decoder.readFloat64();
		}
		if (action & HAS_ORIGINATING_OPERATION) {
			const operation_id = decoder.readInt();
			originating_operation = ORIGINATING_OPERATIONS[operation_id];
		}
		length = decoder.readInt();
		const username_start = decoder.position;
		const username_end = (decoder.position += length);
		let value: any;
		return {
			type: EVENT_TYPES[action & 7],
			tableId: table_id,
			nodeId: node_id,
			get recordId() {
				return readKey(buffer, record_id_start, record_id_end);
			},
			getBinaryRecordId() {
				return buffer.subarray(record_id_start, record_id_end);
			},
			version,
			previousLocalTime: previous_local_time,
			get user() {
				return username_end > username_start ? readKey(buffer, username_start, username_end) : undefined;
			},
			get encoded() {
				return start ? buffer.subarray(start, end) : buffer;
			},
			getValue(store, full_record?, audit_time?) {
				if (action & HAS_RECORD || (action & HAS_PARTIAL_RECORD && !full_record)) {
					if (!value) {
						value = decodeFromDatabase(
							() => store.decoder.decode(buffer.subarray(decoder.position, end)),
							store.rootStore
						);
					}
					return value;
				}
				if (action & HAS_PARTIAL_RECORD && audit_time) {
					return getRecordAtTime(store.getEntry(this.recordId), audit_time, store);
				} // TODO: If we store a partial and full record, may need to read both sequentially
			},
			getBinaryValue() {
				return action & (HAS_RECORD | HAS_PARTIAL_RECORD) ? buffer.subarray(decoder.position, end) : undefined;
			},
			extendedType: action,
			residencyId: residency_id,
			previousResidencyId: previous_residency_id,
			expiresAt: expires_at,
			originatingOperation: originating_operation,
		};
	} catch (error) {
		harper_logger.error('Reading audit entry error', error, buffer);
		return {};
	}
}

export class Decoder extends DataView {
	position = 0;
	readInt() {
		let number;
		number = this.getUint8(this.position++);
		if (number >= 0x80) {
			if (number >= 0xc0) {
				if (number === 0xff) {
					number = this.getUint32(this.position);
					this.position += 4;
					return number;
				}
				number = this.getUint32(this.position - 1) & 0x3fffffff;
				this.position += 3;
				return number;
			}
			number = this.getUint16(this.position - 1) & 0x7fff;
			this.position++;
			return number;
		}
		return number;
	}
	readFloat64() {
		try {
			const value = this.getFloat64(this.position);
			this.position += 8;
			return value;
		} catch (error) {
			error.message = `Error reading float64: ${error.message} at position ${this.position}`;
			throw error;
		}
	}
}
