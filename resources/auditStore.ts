import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as env_get } from '../utility/environment/environmentManager';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads';
import { convertToMS } from '../utility/common_utils';
import { PREVIOUS_TIMESTAMP_PLACEHOLDER, LAST_TIMESTAMP_PLACEHOLDER } from './RecordEncoder';
import * as harper_logger from '../utility/logging/harper_logger';
import { getRecordAtTime } from './crdt';

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

const ENTRY_HEADER = Buffer.alloc(1024); // enough room for all usernames?
const ENTRY_DATAVIEW = new DataView(ENTRY_HEADER.buffer, ENTRY_HEADER.byteOffset, 1024);
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
let DEFAULT_AUDIT_CLEANUP_DELAY = 10000; // default delay of 10 seconds
export function openAuditStore(root_store) {
	const audit_store = (root_store.auditStore = root_store.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS));
	audit_store.rootStore = root_store;
	const delete_callbacks = [];
	audit_store.addDeleteRemovalCallback = function (table_id, callback) {
		delete_callbacks[table_id] = callback;
		return {
			remove() {
				delete delete_callbacks[table_id];
			},
		};
	};
	let pending_cleanup = null;
	function scheduleAuditCleanup(audit_cleanup_delay = DEFAULT_AUDIT_CLEANUP_DELAY) {
		clearTimeout(pending_cleanup);
		pending_cleanup = setTimeout(async () => {
			// query for audit entries that are old
			if (audit_store.rootStore.status === 'closed' || audit_store.rootStore.status === 'closing') return;
			let deleted = 0;
			let committed;
			try {
				for (const { key, value } of audit_store.getRange({
					start: 0,
					snapshot: false,
					end: Date.now() - audit_retention,
				})) {
					if ((readAction(value) & 15) === DELETE) {
						// if this is a delete, we remove the delete entry from the primary table
						// at the same time so the audit table the primary table are in sync
						const audit_record = readAuditEntry(value);
						const table_id = audit_record.tableId;
						delete_callbacks[table_id]?.(audit_record.recordId);
					}
					committed = audit_store.remove(key);
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
				}
				scheduleAuditCleanup(audit_cleanup_delay);
			}
			// we can run this pretty frequently since there is very little overhead to these queries
		}, audit_cleanup_delay).unref();
	}
	audit_store.scheduleAuditCleanup = scheduleAuditCleanup;
	if (getWorkerIndex() === getWorkerCount() - 1) {
		scheduleAuditCleanup(DEFAULT_AUDIT_CLEANUP_DELAY);
	}

	return audit_store;
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
const HAS_PREVIOUS_VERSION = 64;

const EVENT_TYPES = {
	put: PUT | HAS_RECORD,
	[PUT]: 'put',
	delete: DELETE,
	[DELETE]: 'delete',
	message: MESSAGE | HAS_RECORD,
	[MESSAGE]: 'message',
	invalidate: INVALIDATE,
	[INVALIDATE]: 'invalidate',
	patch: PATCH | HAS_PARTIAL_RECORD,
	[PATCH]: 'patch',
};
export function createAuditEntry(txn_time, table_id, record_id, previous_local_time, username, type, encoded_record) {
	const action = EVENT_TYPES[type];
	if (!action) throw new Error(`Invalid audit entry type ${type}`);
	let position = 1;
	if (previous_local_time) {
		if (previous_local_time > 1) ENTRY_DATAVIEW.setFloat64(0, previous_local_time);
		else ENTRY_HEADER.set(PREVIOUS_TIMESTAMP_PLACEHOLDER);
		position = 9;
	}

	const node_id = 0;
	writeInt(node_id);
	writeInt(table_id);
	writeValue(record_id);
	ENTRY_DATAVIEW.setFloat64(position, txn_time);
	position += 8;
	if (username) writeValue(username);
	else ENTRY_HEADER[position++] = 0;
	ENTRY_HEADER[previous_local_time ? 8 : 0] = action;
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
function readAction(buffer) {
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
		let previous_local_time;
		if (buffer[0] == 66) {
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
		length = decoder.readInt();
		const username_start = decoder.position;
		const username_end = (decoder.position += length);
		return {
			type: EVENT_TYPES[action & 7],
			tableId: table_id,
			get recordId() {
				return readKeySafely(buffer, record_id_start, record_id_end);
			},
			version,
			previousLocalTime: previous_local_time,
			get user() {
				return username_end > username_start ? readKeySafely(buffer, username_start, username_end) : undefined;
			},
			getValue(store, full_record?, audit_time?) {
				if (action & HAS_RECORD || (action & HAS_PARTIAL_RECORD && !full_record))
					return store.decoder.decode(buffer.subarray(decoder.position));
				if (action & HAS_PARTIAL_RECORD && audit_time) {
					return getRecordAtTime(store.getEntry(this.recordId), audit_time, store);
				} // TODO: If we store a partial and full record, may need to read both sequentially
			},
		};
	} catch (error) {
		harper_logger.error('Reading audit entry error', error, buffer);
		return {};
	}
}

class Decoder extends DataView {
	position = 0;
	readInt() {
		let number = this.getUint8(this.position++);
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
			debugger;
		}
	}
}
function readKeySafely(buffer, start, end) {
	// ordered-binary's read key actually modifies the byte at end to be zero, we have to subarray this
	// TODO: Can we fix this in ordered-binary?
	const safe_buffer = buffer.subarray(start, end);
	return readKey(safe_buffer, 0, end - start);
}
