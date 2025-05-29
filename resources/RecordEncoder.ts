/**
 * This module is responsible for handling metadata encoding and decoding in database records, which is
 * used for local timestamps (that lmdb-js can assign during a transaction for guaranteed monotonic
 * assignment across threads) and can be used for storing residency information as well. This
 * patches the primary store to properly get the metadata and assign it to the entries.
 */

import { Encoder } from 'msgpackr';
import {
	createAuditEntry,
	readAuditEntry,
	HAS_PREVIOUS_RESIDENCY_ID,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_EXPIRATION_EXTENDED_TYPE,
	HAS_ORIGINATING_OPERATION,
	HAS_BLOBS,
	ACTION_32_BIT,
} from './auditStore.ts';
import * as harperLogger from '../utility/logging/harper_logger.js';
import './blob.ts';
import { blobsWereEncoded, decodeFromDatabase, deleteBlobsInObject, encodeBlobsWithFilePath } from './blob.ts';
export type Entry = {
	key: any;
	value: any;
	version: number;
	localTime: number;
	expiresAt: number;
	metadataFlags: number;
	deref?: () => any;
};

// these are matched by lmdb-js for timestamp replacement. the first byte here is used to xor with the first byte of the date as a double so that it ends up less than 32 for easier identification (otherwise dates start with 66)
export const TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 4, 0x40, 0, 0]);
// the first byte here indicates that we use the last timestamp
export const LAST_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 1, 0, 0, 0]);
export const PREVIOUS_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 3, 0x40, 0, 0]);
export const NEW_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 0, 0x40, 0, 0]);
export const LOCAL_TIMESTAMP = Symbol('local-timestamp');
export const METADATA = Symbol('metadata');
export const ENTRY = Symbol('entry');
const TIMESTAMP_HOLDER = new Uint8Array(8);
const TIMESTAMP_VIEW = new DataView(TIMESTAMP_HOLDER.buffer, 0, 8);
export const NO_TIMESTAMP = 0;
export const TIMESTAMP_ASSIGN_NEW = 0;
export const TIMESTAMP_ASSIGN_LAST = 1;
export const TIMESTAMP_ASSIGN_PREVIOUS = 3;
export const TIMESTAMP_RECORD_PREVIOUS = 4;
export const HAS_EXPIRATION = 16;
export const HAS_RESIDENCY_ID = 32;
export const PENDING_LOCAL_TIME = 1;
export const HAS_STRUCTURE_UPDATE = 0x100;

// For now we use this as the private property mechanism for mapping records to entries.
// WeakMaps are definitely not the fastest form of private properties, but they are the only
// way to do this with how the objects are frozen for now.
export const entryMap = new WeakMap<any, Entry>();
let lastEncoding,
	lastValueEncoding,
	timestampNextEncoding = 0,
	metadataInNextEncoding = -1,
	expiresAtNextEncoding = -1,
	residencyIdAtNextEncoding = 0;
let lastMetadata: Entry = null;
export class RecordEncoder extends Encoder {
	constructor(options) {
		options.useBigIntExtension = true;
		/**
		 * The base class for records that provides the read-only methods for accessing
		 * metadata and will be assigned computed property getters. On its own, these instances
		 * are usually frozen, but this can be extended (by the Updatable class) for providing
		 * mutation methods.
		 */
		class RecordObject {
			getUpdatedTime() {
				return entryMap.get(this)?.version;
			}
			getExpiresAt() {
				return entryMap.get(this)?.expiresAt;
			}
		}

		options.structPrototype = RecordObject.prototype;
		super(options);
		const superEncode = this.encode;
		this.encode = function (record, options?) {
			// this handles our custom metadata encoding, prefixing the record with metadata, including the local
			// timestamp into the audit record, invalidation status and residency information
			if (timestampNextEncoding || metadataInNextEncoding >= 0) {
				let valueStart = 0;
				const timestamp = timestampNextEncoding;
				if (timestamp) {
					valueStart += 8; // make room for local timestamp
					timestampNextEncoding = 0;
				}
				let metadata = metadataInNextEncoding;
				const expiresAt = expiresAtNextEncoding;
				const residencyId = residencyIdAtNextEncoding;
				if (metadata >= 0) {
					valueStart += 4; // make room for metadata bytes
					metadataInNextEncoding = -1; // reset indicator to mean no metadata
					if (expiresAt >= 0) {
						valueStart += 8; // make room for expiration timestamp
						expiresAtNextEncoding = -1; // reset indicator to mean no expiration
					}
					if (residencyId) {
						valueStart += 4; // make room for residency id
						residencyIdAtNextEncoding = 0; // reset indicator to mean no residency id
					}
				}
				const encoded = (lastEncoding = superEncode.call(this, record, options | 2048 | valueStart)); // encode with 8 bytes reserved space for txnId
				lastValueEncoding = encoded.subarray((encoded.start || 0) + valueStart, encoded.end);
				let position = encoded.start || 0;
				if (timestamp) {
					// we apply the special instruction bytes that tell lmdb-js how to assign the timestamp
					TIMESTAMP_PLACEHOLDER[4] = timestamp;
					TIMESTAMP_PLACEHOLDER[5] = timestamp >> 8;
					encoded.set(TIMESTAMP_PLACEHOLDER, position);
					position += 8;
				}
				if (blobsWereEncoded) metadata |= HAS_BLOBS;
				if (metadata >= 0) {
					const dataView =
						encoded.dataView ||
						(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
					dataView.setUint32(position, metadata | (ACTION_32_BIT << 24)); // use the extended action byte
					position += 4;
					if (expiresAt >= 0) {
						const dataView =
							encoded.dataView ||
							(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
						dataView.setFloat64(position, expiresAt);
						position += 8;
					}
					if (residencyId) {
						const dataView =
							encoded.dataView ||
							(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
						dataView.setUint32(position, residencyId);
					}
				}
				return encoded;
			} else {
				lastValueEncoding = superEncode.call(this, record, options);
				return lastValueEncoding;
			}
		};
		const superSaveStructures = this.saveStructures;
		this.saveStructures = function (structures, isCompatible) {
			const result = superSaveStructures.call(this, structures, isCompatible);
			this.hasStructureUpdate = true;
			return result;
		};
	}
	decode(buffer, options) {
		const start = options?.start || 0;
		const end = options > -1 ? options : options?.end || buffer.length;
		let nextByte = buffer[start];
		let metadataFlags = 0;
		try {
			if (nextByte < 32 && end > 2) {
				// record with metadata
				// this means that the record starts with a local timestamp (that was assigned by lmdb-js).
				// we copy it so we can decode it as float-64; we need to do it first because if structural data
				// is loaded during decoding the buffer can actually mutate
				let position = start;
				let localTime;
				if (nextByte === 2) {
					if (buffer.copy) {
						buffer.copy(TIMESTAMP_HOLDER, 0, position);
						position += 8;
					} else {
						for (let i = 0; i < 8; i++) TIMESTAMP_HOLDER[i] = buffer[position++];
					}
					localTime = getTimestamp();
					nextByte = buffer[position];
				}
				let expiresAt, residencyId;
				if (nextByte < 32) {
					if (nextByte === ACTION_32_BIT) {
						const dataView =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						metadataFlags = dataView.getUint32(position);
						position += 4;
					} else {
						metadataFlags = nextByte | (buffer[position + 1] << 5);
						position += 2;
					}
					if (metadataFlags & HAS_EXPIRATION) {
						const dataView =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						expiresAt = dataView.getFloat64(position);
						position += 8;
					}
					if (metadataFlags & HAS_RESIDENCY_ID) {
						// we need to read the residency id
						const dataView =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						residencyId = dataView.getUint32(position);
						position += 4;
					}
				}

				const value = decodeFromDatabase(
					() =>
						options?.valueAsBuffer
							? buffer.subarray(position, end)
							: super.decode(buffer.subarray(position, end), end - position),
					this.rootStore
				);
				lastMetadata = {
					localTime,
					[METADATA]: metadataFlags,
					expiresAt,
					residencyId,
				};
				return value;
			} // else a normal entry
			return options?.valueAsBuffer ? buffer : decodeFromDatabase(() => super.decode(buffer, options), this.rootStore);
		} catch (error) {
			harperLogger.error('Error decoding record', error, 'data: ' + buffer.slice(0, 40).toString('hex'));
			return null;
		}
	}
}
function getTimestamp() {
	TIMESTAMP_HOLDER[0] = TIMESTAMP_HOLDER[0] ^ 0x40; // restore the first byte, we xor to differentiate the first byte from structures
	return TIMESTAMP_VIEW.getFloat64(0);
}

export function handleLocalTimeForGets(store, rootStore) {
	const storeGetEntry = store.getEntry;
	store.readCount = 0;
	store.cachePuts = false;
	store.rootStore = rootStore;
	store.encoder.rootStore = rootStore;
	store.getEntry = function (id, options) {
		store.readCount++;
		lastMetadata = null;
		const entry = storeGetEntry.call(this, id, options);
		// if we have decoded with metadata, we want to pull it out and assign to this entry
		if (entry) {
			if (lastMetadata) {
				entry.metadataFlags = lastMetadata[METADATA];
				entry.localTime = lastMetadata.localTime;
				entry.residencyId = lastMetadata.residencyId;
				if (lastMetadata.expiresAt >= 0) {
					entry.expiresAt = lastMetadata.expiresAt;
				}
				lastMetadata = null;
			}
			if (entry.value) {
				entryMap.set(entry.value, entry); // allow the record to access the entry
			}
			entry.key = id;
		}
		return entry;
	};
	const storeGet = store.get;
	store.get = function (id, options) {
		lastMetadata = null;
		const value = storeGet.call(this, id, options);
		if (lastMetadata && value) {
			entryMap.set(value, lastMetadata);
			lastMetadata = null;
		}
		return value;
	};
	//store.pendingTimestampUpdates = new Map();
	const storeGetRange = store.getRange;
	store.getRange = function (options) {
		const iterable = storeGetRange.call(this, options);
		if (options.valuesForKey) {
			return iterable.map((value) => value?.value);
		}
		if (options.values === false || options.onlyCount) return iterable;
		return iterable.map((entry) => {
			// if we have metadata, move the metadata to the entry
			if (lastMetadata) {
				entry.metadataFlags = lastMetadata[METADATA];
				entry.localTime = lastMetadata.localTime;
				entry.residencyId = lastMetadata.residencyId;
				if (lastMetadata.expiresAt >= 0) entry.expiresAt = lastMetadata.expiresAt;
				lastMetadata = null;
			}
			return entry;
		});
	};
	// add read transaction tracking
	const txn = store.useReadTransaction();
	txn.done();
	if (!txn.done.isTracked) {
		const Txn = txn.constructor;
		const use = txn.use;
		const done = txn.done;
		Txn.prototype.use = function () {
			if (!this.timerTracked) {
				this.timerTracked = true;
				trackedTxns.push(new WeakRef(this));
			}
			use.call(this);
		};
		Txn.prototype.done = function () {
			done.call(this);
			if (this.isDone) {
				for (let i = 0; i < trackedTxns.length; i++) {
					const txn = trackedTxns[i].deref();
					if (!txn || txn.isDone || txn.isCommitted) {
						trackedTxns.splice(i--, 1);
					}
				}
			}
		};
		Txn.prototype.done.isTracked = true;
	}

	return store;
}
const trackedTxns: WeakRef<any>[] = [];
setInterval(() => {
	for (let i = 0; i < trackedTxns.length; i++) {
		const txn = trackedTxns[i].deref();
		if (!txn || txn.isDone || txn.isCommitted) trackedTxns.splice(i--, 1);
		else if (txn.notCurrent) {
			if (txn.openTimer) {
				if (txn.openTimer > 3) {
					if (txn.openTimer > 60) {
						harperLogger.error(
							'Read transaction detected that has been open too long (over 15 minutes), ending transaction',
							txn
						);
						txn.done();
					} else
						harperLogger.error(
							'Read transaction detected that has been open too long (over one minute), make sure read transactions are quickly closed',
							txn
						);
				}
				txn.openTimer++;
			} else txn.openTimer = 1;
		}
	}
}, 15000).unref();
export function recordUpdater(store, tableId, auditStore) {
	return function (
		id,
		record,
		existingEntry,
		newVersion,
		assignMetadata = -1, // when positive, this has a set of metadata flags for the record
		audit?: boolean, // true -> audit this record. false -> do not. null -> retain any audit timestamp
		options?,
		type = 'put',
		resolveRecord?: boolean, // indicates that we are resolving (from source) record that was previously invalidated
		auditRecord?: any
	) {
		// determine if and how we apply the local timestamp
		if (resolveRecord || audit == null)
			// preserve existing timestamp
			timestampNextEncoding = existingEntry?.localTime
				? TIMESTAMP_RECORD_PREVIOUS | TIMESTAMP_ASSIGN_PREVIOUS
				: NO_TIMESTAMP;
		else
			timestampNextEncoding = audit // for audit, we need it
				? existingEntry?.localTime // we already have a timestamp, we need to record the previous one in the audit log
					? TIMESTAMP_RECORD_PREVIOUS | 0x4000
					: TIMESTAMP_ASSIGN_NEW | 0x4000 // or just assign a new one
				: NO_TIMESTAMP;
		const expiresAt = options?.expiresAt;
		if (expiresAt >= 0) assignMetadata |= HAS_EXPIRATION;
		metadataInNextEncoding = assignMetadata;
		expiresAtNextEncoding = expiresAt;
		if (existingEntry?.version === newVersion && audit === false)
			throw new Error('Must retain local time if version is not changed');
		const putOptions = {
			version: newVersion,
			instructedWrite: timestampNextEncoding > 0,
		};
		let ifVersion;
		let extendedType = 0;
		try {
			let previousResidencyId = existingEntry?.residencyId;
			const residencyId = options?.residencyId; //getResidency(record, previousResidencyId);
			if (residencyId) {
				residencyIdAtNextEncoding = residencyId;
				metadataInNextEncoding |= HAS_RESIDENCY_ID;
				extendedType |= HAS_CURRENT_RESIDENCY_ID;
			} // else residencyIdAtNextEncoding = 0;
			if (previousResidencyId !== residencyId) {
				extendedType |= HAS_PREVIOUS_RESIDENCY_ID;
				if (!previousResidencyId) previousResidencyId = 0;
			}
			if (assignMetadata & HAS_EXPIRATION) extendedType |= HAS_EXPIRATION_EXTENDED_TYPE; // we need to record the expiration in the audit log
			if (options?.originatingOperation) extendedType |= HAS_ORIGINATING_OPERATION;
			// we use resolveRecord outside of transaction, so must explicitly make it conditional
			if (resolveRecord) putOptions.ifVersion = ifVersion = existingEntry?.version ?? null;
			if (existingEntry && existingEntry.value && existingEntry.metadataFlags & HAS_BLOBS) {
				if (!auditStore.getBinaryFast(existingEntry.localTime)) {
					// if it used to have blobs, and it doesn't exist in the audit store, we need to delete the old blobs
					deleteBlobsInObject(existingEntry.value);
				}
			}
			let result: Promise<void>;
			if (record !== undefined) {
				result = encodeBlobsWithFilePath(() => store.put(id, record, putOptions), id, store.rootStore);
				if (blobsWereEncoded) {
					extendedType |= HAS_BLOBS;
				}
			}
			if (audit) {
				const username = options?.user?.username;
				if (auditRecord) {
					encodeBlobsWithFilePath(() => store.encoder.encode(auditRecord), id, store.rootStore);
					if (blobsWereEncoded) {
						extendedType |= HAS_BLOBS;
					}
				}
				if (store.encoder.hasStructureUpdate) {
					extendedType |= HAS_STRUCTURE_UPDATE;
					store.encoder.hasStructureUpdate = false;
				}
				if (resolveRecord && existingEntry?.localTime) {
					const replacingId = existingEntry?.localTime;
					const replacingEntry = auditStore.get(replacingId);
					if (replacingEntry) {
						const previousLocalTime = readAuditEntry(replacingEntry).previousLocalTime;
						result = auditStore.put(
							replacingId,
							createAuditEntry(
								newVersion,
								tableId,
								id,
								previousLocalTime,
								options?.nodeId ?? server.replication.getThisNodeId(auditStore) ?? 0,
								username,
								type,
								lastValueEncoding,
								extendedType,
								residencyId,
								previousResidencyId,
								expiresAt
							),
							{ ifVersion: ifVersion }
						);
						return result;
					}
				}
				result = auditStore.put(
					record === undefined ? NEW_TIMESTAMP_PLACEHOLDER : LAST_TIMESTAMP_PLACEHOLDER,
					createAuditEntry(
						newVersion,
						tableId,
						id,
						existingEntry?.localTime ? 1 : 0,
						options?.nodeId ?? server.replication?.getThisNodeId(auditStore) ?? 0,
						username,
						type,
						lastValueEncoding,
						extendedType,
						residencyId,
						previousResidencyId,
						expiresAt,
						options?.originatingOperation
					),
					{
						append: type !== 'invalidate', // for invalidation, we expect the record to be rewritten, so we don't want to necessarily expect pure sequential writes that create full pages
						instructedWrite: true,
						ifVersion,
					}
				);
			}
			return result;
		} catch (error) {
			error.message += ' id: ' + id + ' options: ' + putOptions;
			throw error;
		}
	};
}
export function removeEntry(store: any, entry: any, existingVersion?: number) {
	if (!entry) return;
	if (entry.value && entry.metadataFlags & HAS_BLOBS && !store.auditStore.getBinaryFast(entry.localTime)) {
		// if it used to have blobs, and it doesn't exist in the audit store, we need to delete the old blobs
		deleteBlobsInObject(entry.value);
	}
	return store.remove(entry.key, existingVersion);
}
export interface RecordObject {
	getUpdatedTime(): number;
	getExpiresAt(): number;
}
