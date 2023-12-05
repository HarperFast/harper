/**
 * This module is responsible for handling metadata encoding and decoding in database records, which is
 * used for local timestamps (that lmdb-js can assign during a transaction for guaranteed monotonic
 * assignment across threads) and can be used for storing residency information as well. This
 * patches the primary store to properly get the metadata and assign it to the entries.
 */

import { Encoder } from 'msgpackr';
import { createAuditEntry, readAuditEntry } from './auditStore';
import * as harper_logger from '../utility/logging/harper_logger';

// these are matched by lmdb-js for timestamp replacement. the first byte here is used to xor with the first byte of the date as a double so that it ends up less than 32 for easier identification (otherwise dates start with 66)
export const TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 4, 0x40, 0, 0]);
// the first byte here indicates that we use the last timestamp
export const LAST_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 1, 0, 0, 0]);
export const PREVIOUS_TIMESTAMP_PLACEHOLDER = new Uint8Array([1, 1, 1, 1, 3, 0x40, 0, 0]);
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

let last_encoding,
	last_value_encoding,
	timestamp_next_encoding = 0,
	metadata_in_next_encoding = -1,
	expires_at_next_encoding = 0;
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
				const metadata = metadata_in_next_encoding;
				const expires_at = expires_at_next_encoding;
				if (metadata >= 0) {
					value_start += 2; // make room for metadata bytes
					metadata_in_next_encoding = -1;
					if (expires_at) {
						value_start += 8; // make room for expiration timestamp
						expires_at_next_encoding = 0;
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
				if (metadata >= 0) {
					encoded[position++] = metadata;
					encoded[position++] = 0;
					if (expires_at) {
						const data_view =
							encoded.dataView ||
							(encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
						data_view.setFloat64(position, expires_at);
					}
				}
				return encoded;
			} else return super_encode.call(this, record, options);
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
				let expires_at;
				if (next_byte < 32) {
					metadata_flags = next_byte;
					position += 2;
					if (metadata_flags & HAS_EXPIRATION) {
						const data_view =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						expires_at = data_view.getFloat64(position);
						position += 8;
					}
				}
				const value = super.decode(buffer.subarray(position, end), end - position);
				return {
					localTime: local_time,
					value,
					[METADATA]: metadata_flags,
					expiresAt: expires_at,
				};
			} // else a normal entry
			return super.decode(buffer, options);
		} catch (error) {
			error.message += ', data: ' + buffer.slice(0, 40).toString('hex');
			throw error;
		}
	}
}
function getTimestamp() {
	TIMESTAMP_HOLDER[0] = TIMESTAMP_HOLDER[0] ^ 0x40; // restore the first byte, we xor to differentiate the first byte from structures
	return TIMESTAMP_VIEW.getFloat64(0);
}
const mapGet = Map.prototype.get;

export function handleLocalTimeForGets(store) {
	const storeGetEntry = store.getEntry;
	store.getEntry = function (id, options) {
		const entry = storeGetEntry.call(this, id, options);
		// if we have decoded with metadata, we want to pull it out and assign to this entry
		const record_entry = entry?.value;
		const metadata = record_entry?.[METADATA];
		if (metadata >= 0) {
			entry.metadataFlags = metadata;
			entry.localTime = record_entry.localTime;
			entry.value = record_entry.value;
			if (record_entry.expiresAt > 0) entry.expiresAt = record_entry.expiresAt;
		}
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
				if (record_entry.expiresAt > 0) entry.expiresAt = record_entry.expiresAt;
			}
			return entry;
		});
	};

	if (!store.env.metadataRetriever) {
		store.env.metadataRetriever = true;
		store.on('aftercommit', ({ next, last }) => {
			do {
				const meta = next.meta;
				const store = meta && meta.store;
				if (
					store &&
					// don't do anything on a failure code
					!(next.flag & 0x4000000)
				) {
					const cache = store.cache;
					if (meta.key) {
						const entry = mapGet.call(cache, meta.key);
						if (entry && entry.timestampBytes) {
							const offset = entry.timestampOffset;
							// note that if there are multiple writes to the same entry, this offset will point
							// to the latest entry, so previous writes may finish prior to the latest entry being updated
							// so we verify the starting byte for date that has been assigned:
							if (entry.timestampBytes[offset] === 2) {
								entry.timestampBytes.copy(TIMESTAMP_HOLDER, 0, offset);
								entry.timestampBytes = null;
								entry.localTime = getTimestamp();
							}
						}
					}
				}
			} while (next != last && (next = next.next));
		});
	}
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
					if (!txn || txn === this || txn.isDone || txn.isCommitted) {
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
				if (txn.openTimer > 3)
					harper_logger.error(
						'Read transaction detected that has been open too long (over one minute), make sure read transactions are quickly closed',
						txn
					);
				txn.openTimer++;
			} else txn.openTimer = 1;
		}
	}
}, 15000).unref();
export function getUpdateRecord(store, table_id, audit_store) {
	return function (
		id,
		record,
		existing_entry,
		new_version,
		assign_metadata = -1, // when positive, this has a set of metadata flags for the record
		audit?: boolean, // true -> audit this record. false -> do not. null -> retain any audit timestamp
		context?,
		expires_at?: number,
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
		if (expires_at > 0) assign_metadata |= HAS_EXPIRATION;
		metadata_in_next_encoding = assign_metadata;
		expires_at_next_encoding = expires_at;
		if (existing_entry?.version === new_version && audit === false)
			throw new Error('Must retain local time if version is not changed');
		const options = {
			version: new_version,
			instructedWrite: timestamp_next_encoding > 0,
		};
		let ifVersion;
		try {
			// we use resolve_record outside of transaction, so must explicitly make it conditional
			if (resolve_record) options.ifVersion = ifVersion = existing_entry?.version ?? null;
			const result = store.put(id, record, options);
			if (store.cache && result.result !== false) {
				// if we have a cache and the put didn't immediately fail
				const new_entry = store.cache.get(id);
				if (new_entry) {
					// we can immediately update the metadata flags on the new entry
					if (assign_metadata >= 0) new_entry.metadataFlags = assign_metadata;
					else if (new_entry.metadataFlags >= 0) new_entry.metadataFlags = undefined;
					if (expires_at || !new_entry.expiresAt) new_entry.expiresAt = expires_at;

					// we have to wait for the commit to assign the localTime because it is assigned in the lmdb-js write thread
					if (options.instructedWrite) {
						// TODO: Add support for id as arrays to lmdb-js
						if (!new_entry.localTime) {
							new_entry.localTime = 1;
						} // placeholder
						// record the buffer/position so we can read it after commit
						new_entry.timestampBytes = last_encoding;
						new_entry.timestampOffset = last_encoding.start || 0;
					}
				}
			}

			/**
			 TODO: We will need to pass in the node id, whether that is locally generated from node name, or there is a global registory
			let node_id = audit_information.nodeName ? node_ids.get(audit_information.nodeName) : 0;
			if (node_id == undefined) {
				// store the node name to node id mapping
			}
			*/
			if (audit) {
				const username = context?.user?.username;
				if (audit_record) last_value_encoding = store.encoder.encode(audit_record);
				if (resolve_record && existing_entry?.localTime) {
					const replacing_id = existing_entry?.localTime;
					const replacing_entry = audit_store.get(replacing_id);
					if (replacing_entry) {
						const previous_local_time = readAuditEntry(replacing_entry).previousLocalTime;
						audit_store.put(
							replacing_id,
							createAuditEntry(new_version, table_id, id, previous_local_time, username, type, last_value_encoding),
							{ ifVersion }
						);
						return result;
					}
				}
				audit_store.put(
					LAST_TIMESTAMP_PLACEHOLDER,
					createAuditEntry(
						new_version,
						table_id,
						id,
						existing_entry?.localTime ? 1 : 0,
						username,
						type,
						last_value_encoding
					),
					{
						append: type !== 'invalidate', // for invalidation, we expect the record to be rewritten, so we don't want to necessary create full pages
						instructedWrite: true,
						ifVersion,
					}
				);
			}
			return result;
		} catch (error) {
			error.message += ' id: ' + id + ' options: ' + options;
			throw error;
		}
	};
}
