import { readKey, writeKey } from 'ordered-binary';
import { initSync, get as envGet } from '../utility/environment/environmentManager.js';
import { AUDIT_STORE_NAME } from '../utility/lmdb/terms.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { getWorkerIndex, getWorkerCount } from '../server/threads/manageThreads.js';
import { convertToMS } from '../utility/common_utils.js';
import { PREVIOUS_TIMESTAMP_PLACEHOLDER, LAST_TIMESTAMP_PLACEHOLDER } from './RecordEncoder.ts';
import * as harperLogger from '../utility/logging/harper_logger.js';
import { getRecordAtTime } from './crdt.ts';
import { isMainThread } from 'worker_threads';
import { decodeFromDatabase, deleteBlobsInObject } from './blob.ts';
import { onStorageReclamation } from '../server/storageReclamation.ts';

/**
 * This module is responsible for the binary representation of audit records in an efficient form.
 * This includes a custom key encoder that specifically encodes arrays with the first element (timestamp) as a
 * 64-bit float, second (table id) as a 32-unsigned int, and third using standard ordered-binary encoding
 *
 * This also defines a binary representation for the audit records themselves which is:
 * 1 or 2 bytes: action, describes the action of this record and any flags for which other parts are included
 * tableId
 * recordId
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
			const dataView =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			dataView.setFloat64(position, key);
			return position + 8;
		} else {
			return writeKey(key, buffer, position);
		}
	},
	readKey(buffer, start, end) {
		if (buffer[start] === 66) {
			const dataView =
				buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
			return dataView.getFloat64(start);
		} else {
			return readKey(buffer, start, end);
		}
	},
};
export const AUDIT_STORE_OPTIONS = {
	encoding: 'binary',
	keyEncoder: transactionKeyEncoder,
};

let auditRetention = convertToMS(envGet(CONFIG_PARAMS.LOGGING_AUDITRETENTION)) || 86400 * 3;
const MAX_DELETES_PER_CLEANUP = 1000;
const FLOAT_TARGET = new Float64Array(1);
const FLOAT_BUFFER = new Uint8Array(FLOAT_TARGET.buffer);
let DEFAULT_AUDIT_CLEANUP_DELAY = 10000; // default delay of 10 seconds
let timestampErrored = false;
export function openAuditStore(rootStore) {
	let auditStore = (rootStore.auditStore = rootStore.openDB(AUDIT_STORE_NAME, {
		create: false,
		...AUDIT_STORE_OPTIONS,
	}));
	if (!auditStore) {
		// this means we are creating a new audit store. Initialize with the last removed timestamp (we don't want to put this in legacy audit logs since we don't know if they have had deletions or not).
		auditStore = rootStore.auditStore = rootStore.openDB(AUDIT_STORE_NAME, AUDIT_STORE_OPTIONS);
		updateLastRemoved(auditStore, 1);
	}
	auditStore.rootStore = rootStore;
	auditStore.tableStores = [];
	const deleteCallbacks = [];
	auditStore.addDeleteRemovalCallback = function (tableId, table, callback) {
		deleteCallbacks[tableId] = callback;
		auditStore.tableStores[tableId] = table;
		auditStore.deleteCallbacks = deleteCallbacks;
		return {
			remove() {
				delete deleteCallbacks[tableId];
			},
		};
	};
	let pendingCleanup = null;
	let lastCleanupResolution: Promise<void>;
	let cleanupPriority = 0;
	let auditCleanupDelay = DEFAULT_AUDIT_CLEANUP_DELAY;
	onStorageReclamation(auditStore.env.path, (priority) => {
		cleanupPriority = priority; // update the priority
		if (priority) {
			// and if we have a priority, schedule cleanup soon
			return scheduleAuditCleanup(100);
		}
	});
	function scheduleAuditCleanup(newCleanupDelay?: number): Promise<void> {
		if (newCleanupDelay) auditCleanupDelay = newCleanupDelay;
		clearTimeout(pendingCleanup);
		const resolution = new Promise<void>((resolve) => {
			pendingCleanup = setTimeout(async () => {
				await lastCleanupResolution;
				lastCleanupResolution = resolution;
				// query for audit entries that are old
				if (auditStore.rootStore.status === 'closed' || auditStore.rootStore.status === 'closing') return;
				let deleted = 0;
				let committed: Promise<void>;
				let lastKey: any;
				try {
					for (const { key, value } of auditStore.getRange({
						start: 1, // must not be zero or it will be interpreted as null and overlap with symbols in search
						snapshot: false,
						end: Date.now() - auditRetention / (1 + cleanupPriority * cleanupPriority), // remove up until the audit retention time, reducing audit retention time if cleanup is higher priority
					})) {
						try {
							committed = removeAuditEntry(auditStore, key, value);
						} catch (error) {
							harperLogger.warn('Error removing audit entry', error);
						}
						lastKey = key;
						await new Promise(setImmediate);
						if (++deleted >= MAX_DELETES_PER_CLEANUP) {
							// limit the amount we cleanup per event turn so we don't use too much memory/CPU
							auditCleanupDelay = 10; // and keep trying very soon
							break;
						}
					}
					await committed;
				} finally {
					if (deleted === 0) {
						// if we didn't delete anything, we can increase the delay (double until we get to one tenth of the retention time)
						auditCleanupDelay = Math.min(auditCleanupDelay << 1, auditRetention / 10);
					} else {
						// if we did delete something, update our updates since timestamp
						updateLastRemoved(auditStore, lastKey);
						// and do updates faster
						if (auditCleanupDelay > 100) auditCleanupDelay = auditCleanupDelay >> 1;
					}
					resolve(undefined);
					scheduleAuditCleanup();
				}
				// we can run this pretty frequently since there is very little overhead to these queries
			}, auditCleanupDelay).unref();
		});
		return resolution;
	}
	auditStore.scheduleAuditCleanup = scheduleAuditCleanup;
	if (getWorkerIndex() === getWorkerCount() - 1) {
		scheduleAuditCleanup();
	}
	if (getWorkerIndex() === 0 && !timestampErrored) {
		// make sure the timestamp is valid
		for (const time of auditStore.getKeys({ reverse: true, limit: 1 })) {
			if (time > Date.now()) {
				timestampErrored = true;
				harperLogger.error(
					'The current time is before the last recorded entry in the audit log. Time reversal can undermine the integrity of data tracking and certificate validation and the time must be corrected.'
				);
			}
		}
	}
	return auditStore;
}

export function removeAuditEntry(auditStore: any, key: number, value: any): Promise<void> {
	const type = readAction(value);
	let auditRecord;
	if (type & HAS_BLOBS) {
		// if it has blobs, and isn't in use from the main record, we need to delete them as well
		auditRecord = readAuditEntry(value);
		const primaryStore = auditStore.tableStores[auditRecord.tableId];
		const entry = primaryStore?.getEntry(auditRecord.recordId);
		if (!entry || entry.version !== auditRecord.version || !entry.value) {
			// if the versions don't match or the record has been removed/null-ed, then this should be the only/last reference to any blob
			decodeFromDatabase(() => deleteBlobsInObject(auditRecord.getValue(primaryStore)), primaryStore.rootStore);
		}
	}

	if ((type & 15) === DELETE) {
		// if this is a delete, we remove the delete entry from the primary table
		// at the same time so the audit table the primary table are in sync, assuming the entry matches this audit record version
		auditRecord = auditRecord || readAuditEntry(value);
		const tableId = auditRecord.tableId;
		const primaryStore = auditStore.tableStores[auditRecord.tableId];
		if (primaryStore?.getEntry(auditRecord.recordId).version === auditRecord.version)
			auditStore.deleteCallbacks?.[tableId]?.(auditRecord.recordId, auditRecord.version);
	}
	return auditStore.remove(key);
}

function updateLastRemoved(auditStore, lastKey) {
	FLOAT_TARGET[0] = lastKey;
	auditStore.put(Symbol.for('last-removed'), FLOAT_BUFFER);
}

export function getLastRemoved(auditStore) {
	const lastRemoved = auditStore.get(Symbol.for('last-removed'));
	if (lastRemoved) {
		FLOAT_BUFFER.set(lastRemoved);
		return FLOAT_TARGET[0];
	}
}
export function setAuditRetention(retentionTime, defaultDelay = DEFAULT_AUDIT_CLEANUP_DELAY) {
	auditRetention = retentionTime;
	DEFAULT_AUDIT_CLEANUP_DELAY = defaultDelay;
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
 * @param txnTime
 * @param tableId
 * @param recordId
 * @param previousLocalTime
 * @param nodeId
 * @param username
 * @param type
 * @param encodedRecord
 * @param extendedType
 * @param residencyId
 * @param previousResidencyId
 */
export function createAuditEntry(
	txnTime,
	tableId,
	recordId,
	previousLocalTime,
	nodeId,
	username,
	type,
	encodedRecord,
	extendedType,
	residencyId,
	previousResidencyId,
	expiresAt,
	originatingOperation?: string
) {
	const action = EVENT_TYPES[type];
	if (!action) {
		throw new Error(`Invalid audit entry type ${type}`);
	}
	let position = 1;
	if (previousLocalTime) {
		if (previousLocalTime > 1) ENTRY_DATAVIEW.setFloat64(0, previousLocalTime);
		else ENTRY_HEADER.set(PREVIOUS_TIMESTAMP_PLACEHOLDER);
		position = 9;
	}
	if (extendedType) {
		if (extendedType & 0xff) throw new Error('Illegal extended type');
		position += 3;
	}

	writeInt(nodeId);
	writeInt(tableId);
	writeValue(recordId);
	ENTRY_DATAVIEW.setFloat64(position, txnTime);
	position += 8;
	if (extendedType & HAS_CURRENT_RESIDENCY_ID) writeInt(residencyId);
	if (extendedType & HAS_PREVIOUS_RESIDENCY_ID) writeInt(previousResidencyId);
	if (extendedType & HAS_EXPIRATION_EXTENDED_TYPE) {
		ENTRY_DATAVIEW.setFloat64(position, expiresAt);
		position += 8;
	}
	if (extendedType & HAS_ORIGINATING_OPERATION) {
		writeInt(ORIGINATING_OPERATIONS[originatingOperation]);
	}

	if (username) writeValue(username);
	else ENTRY_HEADER[position++] = 0;
	if (extendedType) ENTRY_DATAVIEW.setUint32(previousLocalTime ? 8 : 0, action | extendedType | 0xc0000000);
	else ENTRY_HEADER[previousLocalTime ? 8 : 0] = action;
	const header = ENTRY_HEADER.subarray(0, position);
	if (encodedRecord) {
		return Buffer.concat([header, encodedRecord]);
	} else return header;
	function writeValue(value) {
		const valueLengthPosition = position;
		position += 1;
		position = writeKey(value, ENTRY_HEADER, position);
		const keyLength = position - valueLengthPosition - 1;
		if (keyLength > 0x7f) {
			if (keyLength > 0x3fff) {
				harperLogger.error('Key or username was too large for audit entry', value);
				position = valueLengthPosition + 1;
				ENTRY_HEADER[valueLengthPosition] = 0;
			} else {
				// requires two byte length header, need to move the value/key to make room for it
				ENTRY_HEADER.copyWithin(valueLengthPosition + 2, valueLengthPosition + 1, position);
				// now write a two-byte length header
				ENTRY_DATAVIEW.setUint16(valueLengthPosition, keyLength | 0x8000);
				// must adjust the position by one since we moved everything one position
				position++;
			}
		} else {
			// one byte length header, as expected
			ENTRY_HEADER[valueLengthPosition] = keyLength;
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
		let previousLocalTime;
		if (buffer[decoder.position] == 66) {
			// 66 is the first byte in a date double.
			previousLocalTime = decoder.readFloat64();
		}
		const action = decoder.readInt();
		const nodeId = decoder.readInt();
		const tableId = decoder.readInt();
		let length = decoder.readInt();
		const recordIdStart = decoder.position;
		const recordIdEnd = (decoder.position += length);
		const version = decoder.readFloat64();
		let residencyId, previousResidencyId, expiresAt, originatingOperation;
		if (action & HAS_CURRENT_RESIDENCY_ID) {
			residencyId = decoder.readInt();
		}
		if (action & HAS_PREVIOUS_RESIDENCY_ID) {
			previousResidencyId = decoder.readInt();
		}
		if (action & HAS_EXPIRATION_EXTENDED_TYPE) {
			expiresAt = decoder.readFloat64();
		}
		if (action & HAS_ORIGINATING_OPERATION) {
			const operationId = decoder.readInt();
			originatingOperation = ORIGINATING_OPERATIONS[operationId];
		}
		length = decoder.readInt();
		const usernameStart = decoder.position;
		const usernameEnd = (decoder.position += length);
		let value: any;
		return {
			type: EVENT_TYPES[action & 7],
			tableId,
			nodeId,
			get recordId() {
				return readKey(buffer, recordIdStart, recordIdEnd);
			},
			getBinaryRecordId() {
				return buffer.subarray(recordIdStart, recordIdEnd);
			},
			version,
			previousLocalTime,
			get user() {
				return usernameEnd > usernameStart ? readKey(buffer, usernameStart, usernameEnd) : undefined;
			},
			get encoded() {
				return start ? buffer.subarray(start, end) : buffer;
			},
			get size() {
				return start ? end - start : buffer.byteLength;
			},
			getValue(store, fullRecord?, auditTime?) {
				if (action & HAS_RECORD || (action & HAS_PARTIAL_RECORD && !fullRecord)) {
					if (!value) {
						value = decodeFromDatabase(
							() => store.decoder.decode(buffer.subarray(decoder.position, end)),
							store.rootStore
						);
					}
					return value;
				}
				if (action & HAS_PARTIAL_RECORD && auditTime) {
					return getRecordAtTime(store.getEntry(this.recordId), auditTime, store);
				} // TODO: If we store a partial and full record, may need to read both sequentially
			},
			getBinaryValue() {
				return action & (HAS_RECORD | HAS_PARTIAL_RECORD) ? buffer.subarray(decoder.position, end) : undefined;
			},
			extendedType: action,
			residencyId,
			previousResidencyId,
			expiresAt,
			originatingOperation,
		};
	} catch (error) {
		harperLogger.error('Reading audit entry error', error, buffer);
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
