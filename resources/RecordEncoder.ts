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
} from './auditStore';
import * as harper_logger from '../utility/logging/harper_logger';
import './blob';
import { blobsWereEncoded, decodeFromDatabase, deleteBlobsInObject, encodeBlobsWithFilePath } from './blob';

// these are matched by lmdb-js for timestamp replacement. the first byte here is used to xor with the first byte of the date as a double so that it ends up less than 32 for easier identification (otherwise dates start with 66)
export const TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 4, 0x40, 0, 0]);
// the first byte here indicates that we use the last timestamp
export const LAST_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 1, 0, 0, 0]);
export const PREVIOUS_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 3, 0x40, 0, 0]);
export const NEW_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 0, 0x40, 0, 0]);
export const LOCAL_TIMESTAMP = Symbol('local-timestamp');
export const METADATA = Symbol('metadata');
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

let last_encoding,
	last_value_encoding,
	timestamp_next_encoding = 0,
	metadata_in_next_encoding = -1,
	expires_at_next_encoding = -1,
	residency_id_at_next_encoding = 0;
export class RecordEncoder extends Encoder {
	constructor(options) {
		options.useBigIntExtension = true;
		super(options);
		const super_encode = this.encode;
		this.encode = function (record, options?) {
			// this handles our custom metadata encoding, prefixing the record with metadata, including the local
			// timestamp into the audit record, invalidation status and residency information
			if (timestamp_next_encoding || metadata_in_next_encoding >= 0) {
				let value_start = 0;
				const timestamp = timestamp_next_encoding;
				if (timestamp) {
					value_start += 8; // make room for local timestamp
					timestamp_next_encoding = 0;
				}
				let metadata = metadata_in_next_encoding;
				const expires_at = expires_at_next_encoding;
				const residency_id = residency_id_at_next_encoding;
				if (metadata >= 0) {
					value_start += 4; // make room for metadata bytes
					metadata_in_next_encoding = -1; // reset indicator to mean no metadata
					if (expires_at >= 0) {
						value_start += 8; // make room for expiration timestamp
						expires_at_next_encoding = -1; // reset indicator to mean no expiration
					}
					if (residency_id) {
						value_start += 4; // make room for residency id
						residency_id_at_next_encoding = 0; // reset indicator to mean no residency id
					}
				}
				const encoded = (last_encoding = super_encode.call(this, record, options | 2048 | value_start)); // encode with 8 bytes reserved space for txn_id
				last_value_encoding = encoded.subarray((encoded.start || 0) + value_start, encoded.end);
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
					const data_view =
						encoded.dataView ||
						(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
					data_view.setUint32(position, metadata | (ACTION_32_BIT << 24)); // use the extended action byte
					position += 4;
					if (expires_at >= 0) {
						const data_view =
							encoded.dataView ||
							(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
						data_view.setFloat64(position, expires_at);
						position += 8;
					}
					if (residency_id) {
						const data_view =
							encoded.dataView ||
							(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
						data_view.setUint32(position, residency_id);
					}
				}
				return encoded;
			} else return (last_value_encoding = super_encode.call(this, record, options));
		};
		const super_saveStructures = this.saveStructures;
		this.saveStructures = function (structures, isCompatible) {
			const result = super_saveStructures.call(this, structures, isCompatible);
			this.hasStructureUpdate = true;
			return result;
		};
	}
	decode(buffer, options) {
		const start = options?.start || 0;
		const end = options > -1 ? options : options?.end || buffer.length;
		let next_byte = buffer[start];
		let metadata_flags = 0;
		try {
			if (next_byte < 32 && end > 2) {
				// record with metadata
				// this means that the record starts with a local timestamp (that was assigned by lmdb-js).
				// we copy it so we can decode it as float-64; we need to do it first because if structural data
				// is loaded during decoding the buffer can actually mutate
				let position = start;
				let local_time;
				if (next_byte === 2) {
					if (buffer.copy) {
						buffer.copy(TIMESTAMP_HOLDER, 0, position);
						position += 8;
					} else {
						for (let i = 0; i < 8; i++) TIMESTAMP_HOLDER[i] = buffer[position++];
					}
					local_time = getTimestamp();
					next_byte = buffer[position];
				}
				let expires_at, residency_id;
				if (next_byte < 32) {
					if (next_byte === ACTION_32_BIT) {
						const data_view =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						metadata_flags = data_view.getUint32(position);
						position += 4;
					} else {
						metadata_flags = next_byte | (buffer[position + 1] << 5);
						position += 2;
					}
					if (metadata_flags & HAS_EXPIRATION) {
						const data_view =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						expires_at = data_view.getFloat64(position);
						position += 8;
					}
					if (metadata_flags & HAS_RESIDENCY_ID) {
						// we need to read the residency id
						const data_view =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						residency_id = data_view.getUint32(position);
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
				return {
					localTime: local_time,
					value,
					[METADATA]: metadata_flags,
					expiresAt: expires_at,
					residencyId: residency_id,
				};
			} // else a normal entry
			return options?.valueAsBuffer ? buffer : decodeFromDatabase(() => super.decode(buffer, options), this.rootStore);
		} catch (error) {
			harper_logger.error('Error decoding record', error, 'data: ' + buffer.slice(0, 40).toString('hex'));
			return null;
		}
	}
}
function getTimestamp() {
	TIMESTAMP_HOLDER[0] = TIMESTAMP_HOLDER[0] ^ 0x40; // restore the first byte, we xor to differentiate the first byte from structures
	return TIMESTAMP_VIEW.getFloat64(0);
}

export function handleLocalTimeForGets(store, root_store) {
	const storeGetEntry = store.getEntry;
	store.readCount = 0;
	store.cachePuts = false;
	store.rootStore = root_store;
	store.encoder.rootStore = root_store;
	store.getEntry = function (id, options) {
		store.readCount++;
		const entry = storeGetEntry.call(this, id, options);
		// if we have decoded with metadata, we want to pull it out and assign to this entry
		const record_entry = entry?.value;
		const metadata = record_entry?.[METADATA];
		if (metadata >= 0) {
			entry.metadataFlags = metadata;
			entry.localTime = record_entry.localTime;
			entry.value = record_entry.value;
			entry.residencyId = record_entry.residencyId;
			if (record_entry.expiresAt >= 0) entry.expiresAt = record_entry.expiresAt;
		}
		if (entry) entry.key = id;
		return entry;
	};
	const storeGet = store.get;
	store.get = function (id, options) {
		const value = storeGet.call(this, id, options);
		// an object with metadata, but we want to just return the value
		return value?.[METADATA] >= 0 ? value.value : value;
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
			const record_entry = entry.value;
			// if we have metadata, move the metadata to the entry
			const metadata = record_entry[METADATA];
			if (metadata >= 0) {
				entry.metadataFlags = metadata;
				entry.localTime = record_entry.localTime;
				entry.value = record_entry.value;
				entry.residencyId = record_entry.residencyId;
				if (record_entry.expiresAt >= 0) entry.expiresAt = record_entry.expiresAt;
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
				tracked_txns.push(new WeakRef(this));
			}
			use.call(this);
		};
		Txn.prototype.done = function () {
			done.call(this);
			if (this.isDone) {
				for (let i = 0; i < tracked_txns.length; i++) {
					const txn = tracked_txns[i].deref();
					if (!txn || txn.isDone || txn.isCommitted) {
						tracked_txns.splice(i--, 1);
					}
				}
			}
		};
		Txn.prototype.done.isTracked = true;
	}

	return store;
}
const tracked_txns: WeakRef<any>[] = [];
setInterval(() => {
	for (let i = 0; i < tracked_txns.length; i++) {
		const txn = tracked_txns[i].deref();
		if (!txn || txn.isDone || txn.isCommitted) tracked_txns.splice(i--, 1);
		else if (txn.notCurrent) {
			if (txn.openTimer) {
				if (txn.openTimer > 3) {
					if (txn.openTimer > 60) {
						harper_logger.error(
							'Read transaction detected that has been open too long (over 15 minutes), ending transaction',
							txn
						);
						txn.done();
					} else
						harper_logger.error(
							'Read transaction detected that has been open too long (over one minute), make sure read transactions are quickly closed',
							txn
						);
				}
				txn.openTimer++;
			} else txn.openTimer = 1;
		}
	}
}, 15000).unref();
export function recordUpdater(store, table_id, audit_store) {
	return function (
		id,
		record,
		existing_entry,
		new_version,
		assign_metadata = -1, // when positive, this has a set of metadata flags for the record
		audit?: boolean, // true -> audit this record. false -> do not. null -> retain any audit timestamp
		options?,
		type = 'put',
		resolve_record?: boolean, // indicates that we are resolving (from source) record that was previously invalidated
		audit_record?: any
	) {
		// determine if and how we apply the local timestamp
		if (resolve_record || audit == null)
			// preserve existing timestamp
			timestamp_next_encoding = existing_entry?.localTime
				? TIMESTAMP_RECORD_PREVIOUS | TIMESTAMP_ASSIGN_PREVIOUS
				: NO_TIMESTAMP;
		else
			timestamp_next_encoding = audit // for audit, we need it
				? existing_entry?.localTime // we already have a timestamp, we need to record the previous one in the audit log
					? TIMESTAMP_RECORD_PREVIOUS | 0x4000
					: TIMESTAMP_ASSIGN_NEW | 0x4000 // or just assign a new one
				: NO_TIMESTAMP;
		const expires_at = options?.expiresAt;
		if (expires_at >= 0) assign_metadata |= HAS_EXPIRATION;
		metadata_in_next_encoding = assign_metadata;
		expires_at_next_encoding = expires_at;
		if (existing_entry?.version === new_version && audit === false)
			throw new Error('Must retain local time if version is not changed');
		const put_options = {
			version: new_version,
			instructedWrite: timestamp_next_encoding > 0,
		};
		let if_version;
		let extended_type = 0;
		try {
			let previous_residency_id = existing_entry?.residencyId;
			const residency_id = options?.residencyId; //get_residency(record, previous_residency_id);
			if (residency_id) {
				residency_id_at_next_encoding = residency_id;
				metadata_in_next_encoding |= HAS_RESIDENCY_ID;
				extended_type |= HAS_CURRENT_RESIDENCY_ID;
			} // else residency_id_at_next_encoding = 0;
			if (previous_residency_id !== residency_id) {
				extended_type |= HAS_PREVIOUS_RESIDENCY_ID;
				if (!previous_residency_id) previous_residency_id = 0;
			}
			if (assign_metadata & HAS_EXPIRATION) extended_type |= HAS_EXPIRATION_EXTENDED_TYPE; // we need to record the expiration in the audit log
			if (options?.originatingOperation) extended_type |= HAS_ORIGINATING_OPERATION;
			// we use resolve_record outside of transaction, so must explicitly make it conditional
			if (resolve_record) put_options.ifVersion = if_version = existing_entry?.version ?? null;
			if (existing_entry && existing_entry.value && existing_entry.metadataFlags & HAS_BLOBS) {
				if (!audit_store.getBinaryFast(existing_entry.localTime)) {
					// if it used to have blobs, and it doesn't exist in the audit store, we need to delete the old blobs
					deleteBlobsInObject(existing_entry.value);
				}
			}
			let result;
			if (options?.omitLocalRecord) {
				// if we aren't writing the local record (as is the case for sharding that doesn't include ourselves in the shard), we still need to write the audit record
				audit_record ??= record;
			} else {
				result = encodeBlobsWithFilePath(() => store.put(id, record, put_options), id, store.rootStore);
				if (blobsWereEncoded) {
					extended_type |= HAS_BLOBS;
				}
			}
			if (audit) {
				const username = options?.user?.username;
				if (audit_record) {
					encodeBlobsWithFilePath(() => store.encoder.encode(audit_record), id, store.rootStore);
					if (blobsWereEncoded) {
						extended_type |= HAS_BLOBS;
					}
				}
				if (store.encoder.hasStructureUpdate) {
					extended_type |= HAS_STRUCTURE_UPDATE;
					store.encoder.hasStructureUpdate = false;
				}
				if (resolve_record && existing_entry?.localTime) {
					const replacing_id = existing_entry?.localTime;
					const replacing_entry = audit_store.get(replacing_id);
					if (replacing_entry) {
						const previous_local_time = readAuditEntry(replacing_entry).previousLocalTime;
						result = audit_store.put(
							replacing_id,
							createAuditEntry(
								new_version,
								table_id,
								id,
								previous_local_time,
								options?.nodeId ?? server.replication.getThisNodeId(audit_store) ?? 0,
								username,
								type,
								last_value_encoding,
								extended_type,
								residency_id,
								previous_residency_id,
								expires_at
							),
							{ ifVersion: if_version }
						);
						return result;
					}
				}
				result = audit_store.put(
					options?.omitLocalRecord ? NEW_TIMESTAMP_PLACEHOLDER : LAST_TIMESTAMP_PLACEHOLDER,
					createAuditEntry(
						new_version,
						table_id,
						id,
						existing_entry?.localTime ? 1 : 0,
						options?.nodeId ?? server.replication?.getThisNodeId(audit_store) ?? 0,
						username,
						type,
						last_value_encoding,
						extended_type,
						residency_id,
						previous_residency_id,
						expires_at,
						options?.originatingOperation
					),
					{
						append: type !== 'invalidate', // for invalidation, we expect the record to be rewritten, so we don't want to necessarily expect pure sequential writes that create full pages
						instructedWrite: true,
						ifVersion: if_version,
					}
				);
			}
			return result;
		} catch (error) {
			error.message += ' id: ' + id + ' options: ' + put_options;
			throw error;
		}
	};
}
export function removeEntry(store: any, entry: any, existing_version?: number) {
	if (!entry) return;
	if (entry.value && entry.metadataFlags & HAS_BLOBS && !store.auditStore.getBinaryFast(entry.localTime)) {
		// if it used to have blobs, and it doesn't exist in the audit store, we need to delete the old blobs
		deleteBlobsInObject(entry.value);
	}
	return store.remove(entry.key, existing_version);
}
