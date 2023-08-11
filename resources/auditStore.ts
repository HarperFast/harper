import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as env_get } from '../utility/environment/environmentManager';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { getWorkerIndex } from '../server/threads/manageThreads';
import { convertToMS } from '../utility/common_utils';
/**
 * This module is responsible for the binary representation of audit records in an efficient form.
 * This includes a custom key encoder that specifically encodes arrays with the first element (timestamp) as a
 * 64-bit float, second (table id) as a 32-unsigned int, and third using standard ordered-binary encoding
 *
 * This also defines a binary representation for the audit records themselves which is:
 * 1 or 2 bytes: action, describes the action of this record and any flags for which other parts are included
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
		if (Array.isArray(key)) {
			const data_view =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			data_view.setFloat64(position, key[0]);
			data_view.setUint32(position + 8, key[1]);
			return writeKey(key[2], buffer, position + 12);
		} else {
			return writeKey(key, buffer, position);
		}
	},
	readKey(buffer, start, end) {
		if (buffer[start] > 40) {
			const data_view =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			return [data_view.getFloat64(start), data_view.getUint32(start + 8), readKey(buffer, start + 12, end)];
		} else {
			return readKey(buffer, start, end);
		}
	},
};
const AUDIT_STORE_OPTIONS = {
	encoding: 'binary',
	keyEncoder: transactionKeyEncoder,
};

let audit_retention = convertToMS(env_get(CONFIG_PARAMS.LOGGING_AUDIT_RETENTION)) || (86400 * 3);
let pending_cleanup = null;
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
	if (getWorkerIndex() === 0) {
		root_store.on('aftercommit', () => {
			// TODO: Maybe determine there were really any audits in here
			if (!pending_cleanup) {
				pending_cleanup = setTimeout(() => {
					pending_cleanup = null;
					// query for audit entries that are old and
					if (audit_store.rootStore.status === 'closed') return;
					for (const { key, value } of audit_store.getRange({
						start: [0, 0],
						end: [Date.now() - audit_retention, 0],
					})) {
						if ((value[0] & 15) === DELETE) {
							// if this is a delete, we remove the delete entry from the primary table
							// at the same time so the audit table the primary table are in sync
							const table_id = key[1];
							delete_callbacks[table_id]?.(key[2]);
						}
						audit_store.remove(key);
					}
					// we can run this pretty frequently since there is very little overhead to these queries
				}, audit_retention / 10).unref();
			}
		});
	}
	return audit_store;
}

export function setAuditRetention(retention_time) {
	clearTimeout(pending_cleanup);
	pending_cleanup = null;
	audit_retention = retention_time;
}


const HAS_FULL_RECORD = 16;
const HAS_PARTIAL_RECORD = 32; // will be used for CRDTs
const PUT = 1;
const DELETE = 2;
const MESSAGE = 3;
const INVALIDATE = 4;
const HAS_SIX_BYTE_HEADER = 128;
const HAS_PREVIOUS_VERSION = 64;

const OPERATIONS = {
	put: PUT | HAS_FULL_RECORD,
	[PUT]: 'put',
	delete: DELETE,
	[DELETE]: 'delete',
	message: MESSAGE | HAS_FULL_RECORD,
	[MESSAGE]: 'message',
	invalidate: INVALIDATE,
	[INVALIDATE]: 'invalidate',
};
export function createAuditEntry(last_version, username, audit_information) {
	let action = OPERATIONS[audit_information.operation];

	let position = 3;
	if (username) {
		if (username.length > 80) {
			action |= HAS_SIX_BYTE_HEADER;
			position = writeKey(username, ENTRY_HEADER, last_version ? 14 : 6);
			ENTRY_DATAVIEW.setUint16(2, position);
		} else {
			position = writeKey(username, ENTRY_HEADER, last_version ? 11 : 3);
			ENTRY_HEADER[1] = position;
		}
	} else {
		ENTRY_HEADER[1] = 0;
	}
	if (last_version) {
		action |= HAS_PREVIOUS_VERSION;
		const version_position = action & HAS_SIX_BYTE_HEADER ? 6 : 3;
		ENTRY_DATAVIEW.setFloat64(version_position, last_version);
		if (!username) position = version_position + 8;
	}
	ENTRY_HEADER[0] = action;
	// TODO: This is reserved for the node id
	if (action & HAS_SIX_BYTE_HEADER) ENTRY_DATAVIEW.setUint16(4, 0);
	else ENTRY_HEADER[2] = 0;
	if (audit_information.value) return Buffer.concat([ENTRY_HEADER.slice(0, position), audit_information.value]);
	else return ENTRY_HEADER.slice(0, position);
}
export function readAuditEntry(buffer, store) {
	const action = buffer[0];
	const data_view =
		buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
	const has_six_byte_header = action & HAS_SIX_BYTE_HEADER;
	let position = has_six_byte_header ? 6 : 3;
	let last_version;
	if (action & HAS_PREVIOUS_VERSION) {
		last_version = data_view.getFloat64(position);
		position += 8;
	}
	let username_end;
	if (has_six_byte_header) username_end = data_view.getUint16(2);
	else username_end = buffer[1];
	const value = action & HAS_FULL_RECORD ? store.decoder.decode(buffer.subarray(username_end || position)) : undefined;
	return {
		operation: OPERATIONS[action & 7],
		value,
		lastVersion: last_version,
		get user() {
			return username_end ? readKey(buffer, position, username_end) : undefined;
		},
	};
}
