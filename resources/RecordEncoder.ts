/**
 * This module is responsible for handling metadata encoding and decoding in database records, which is
 * used for local timestamps (that lmdb-js can assign during a transaction for guaranteed monotonic
 * assignment across threads) and can be used for storing residency information as well. This
 * patches the primary store to properly get the metadata and assign it to the entries.
 */

import { Encoder } from 'msgpackr';
import { createStructon } from 'structon';
import {
	HAS_PREVIOUS_RESIDENCY_ID,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_EXPIRATION_EXTENDED_TYPE,
	HAS_ORIGINATING_OPERATION,
	HAS_BLOBS,
	ACTION_32_BIT,
	HAS_ADDITIONAL_AUDIT_REFS as HAS_ADDITIONAL_AUDIT_REFS_AUDIT,
	LOCAL_ONLY,
} from './auditStore.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import './blob.ts';
import {
	blobsWereEncoded,
	decodeFromDatabase,
	deleteBlobsInObject,
	encodeBlobsWithFilePath,
	findBlobsInObject,
	getFileId,
} from './blob.ts';
import { getThisNodeId } from './nodeIdMapping.ts';
import { recordAction } from './analytics/write.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { when } from '../utility/when.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as envMngr from '../utility/environment/environmentManager.js';

const StructonEncoder = createStructon(Encoder) as typeof Encoder;

// Analytics counter incremented whenever a record cannot be decoded because its shared structure is
// missing on this node (see HarperFast/harper#1163). Surfaces the otherwise-silent condition in
// monitoring; the store name is passed as the metric path.
const MISSING_STRUCTURE_METRIC = 'decode-missing-structure';

// Terminal error messages msgpackr/structon throw when a record references a shared structure that
// is not in this node's structures buffer. Both the typed (random-access) path (structon's
// readStruct) and the classic path (msgpackr's createSecondByteReader) reload the structures from
// durable storage and retry before throwing, so reaching one of these means the structure is
// genuinely absent on this node — not merely stale in memory. Matched by message prefix because
// neither dependency throws a typed error.
const MISSING_TYPED_STRUCTURE_PREFIX = 'Could not find typed structure ';
const MISSING_CLASSIC_STRUCTURE_PREFIX = 'Record id is not defined for ';

export function isMissingStructureError(error: any): boolean {
	const message = error?.message;
	return (
		typeof message === 'string' &&
		(message.startsWith(MISSING_TYPED_STRUCTURE_PREFIX) || message.startsWith(MISSING_CLASSIC_STRUCTURE_PREFIX))
	);
}
export type Entry = {
	key: any;
	value: any;
	version: number;
	localTime: number;
	expiresAt: number;
	metadataFlags: number;
	nodeId: number;
	residencyId: number;
	size: number;
	deref?: () => any;
	[METADATA]?: any;
	additionalAuditRefs?: Array<{ version: number; nodeId: number }>;
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
export const HAS_NODE_ID = 64;
export const PENDING_LOCAL_TIME = 1;
export const HAS_STRUCTURE_UPDATE = 0x100;
export const HAS_ADDITIONAL_AUDIT_REFS = 0x80;

const TRACKED_WRITE_TYPES = new Set(['put', 'patch', 'delete', 'message', 'publish']);
// For now we use this as the private property mechanism for mapping records to entries.
// WeakMaps are definitely not the fastest form of private properties, but they are the only
// way to do this with how the objects are frozen for now.
export const entryMap = new WeakMap<any, Entry>();
export let lastValueEncoding: Buffer | undefined;
let timestampNextEncoding = 0,
	metadataInNextEncoding = -1,
	expiresAtNextEncoding = -1,
	residencyIdAtNextEncoding = 0,
	nodeIdAtNextEncoding = -1,
	additionalAuditRefsNextEncoding: Array<{ version: number; nodeId: number }> | undefined;
// tracking metadata with a singleton works better than trying to alter response of getEntry/get and coordinating that across caching layers
export let lastMetadata: Entry | null = null;
export class RecordEncoder extends StructonEncoder {
	rootStore: any;
	declare saveStructures: any;
	declare getStructures: any;
	declare _writeStruct: any;
	structureUpdate?: any;
	isRocksDB: boolean;
	name: string;
	useVersions: boolean;
	constructor(options) {
		options.useBigIntExtension = true;
		// Bound the per-encoder typed-structure dictionary. It is append-only and pinned on the
		// long-lived primary store, so a wide/sparse schema (whose records vary by per-field value
		// width) can grow it unbounded and exhaust memory. Caller-overridable; default caps it.
		options.maxOwnStructures ??= 256;
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
		// Whether this store carries per-record version/timestamp metadata. Only versioned stores
		// (primary table DBIs) prefix records with the metadata header; non-versioned internal DBIs
		// (e.g. __dbis__, useVersions=false) must not — see the encode hook + harper#1307. Default to
		// true when unspecified so an option that doesn't propagate can't silently strip prefixes.
		this.useVersions = options.useVersions !== false;
		// structon (the StructonEncoder base) always installs the struct write hook. For DBIs
		// that don't opt into struct mode (non-primary, e.g. __dbis__), force it to bail (return
		// 0) so objects are written in plain msgpackr records mode — decodable by readers without
		// struct support (msgpackr v1 / Harper v4 downgrade). We make it bail rather than clear
		// it so msgpackr keeps the struct-safe integer boundary: top-level integers 0x20-0x3f are
		// written as uint8 rather than bare fixints, which the retained struct READ hook would
		// otherwise misread as struct headers (e.g. a scalar NEXT_TABLE_ID >= 32 in __dbis__).
		// The read hook stays intact so records already written in struct mode by a prior v5 still
		// decode.
		if (!options.randomAccessStructure) this._writeStruct = () => 0;
		const superEncode = this.encode;
		this.encode = function (record, options?) {
			if (!this.useVersions) {
				// harper#1307: this store does not carry version metadata, so it never prefixes its records.
				// Encode plainly and LEAVE any in-flight *NextEncoding globals untouched for their real owner:
				// they belong to a versioned write (recordUpdater staged the primary's metadata and a nested
				// __dbis__ write — e.g. via getThisNodeId — runs before the primary encode; or they leaked from
				// a versioned write whose encode was skipped). Consuming/clearing them here would strip the
				// primary record's prefix, and prefixing OUR record (e.g. a __dbis__ `seq` cursor) makes it
				// undecodable on the non-versioned read path (null → replication wedge).
				lastValueEncoding = superEncode.call(this, record, options);
				return lastValueEncoding;
			}
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
				const nodeId = nodeIdAtNextEncoding;
				const additionalAuditRefs = additionalAuditRefsNextEncoding;
				if (metadata >= 0) {
					valueStart += 4; // make room for metadata bytes
					metadataInNextEncoding = -1; // reset indicator to mean no metadata
					if (expiresAt >= 0) {
						valueStart += 8; // make room for expiration timestamp
						expiresAtNextEncoding = -1; // reset indicator to mean no expiration
						if (!(metadata & HAS_EXPIRATION)) {
							throw new Error('Expiration included, but not in metadata flags');
						}
					}
					if (residencyId) {
						valueStart += 4; // make room for residency id
						residencyIdAtNextEncoding = 0; // reset indicator to mean no residency id
						if (!(metadata & HAS_RESIDENCY_ID)) {
							throw new Error('Residency id included, but not in metadata flags');
						}
					}
					if (nodeId >= 0) {
						valueStart += 4; // make room for node id
						nodeIdAtNextEncoding = -1; // reset indicator to mean no node id
						if (!(metadata & HAS_NODE_ID)) {
							throw new Error('Node id included, but not in metadata flags');
						}
					}
					if (additionalAuditRefs && additionalAuditRefs.length > 0) {
						valueStart += 1 + additionalAuditRefs.length * 12; // 1 byte for count + 8 bytes version + 4 bytes nodeId per ref
						additionalAuditRefsNextEncoding = undefined;
					}
				}
				const encoded = superEncode.call(this, record, options | 2048 | valueStart); // encode with 8 bytes reserved space for txnId
				lastValueEncoding = encoded.subarray((encoded.start || 0) + valueStart, encoded.end);
				let position = encoded.start || 0;
				const dataView =
					encoded.dataView || (encoded.dataView = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength));
				if (timestamp) {
					if (this.isRocksDB) {
						// rocksdb, just store the version directly as the timestamp
						dataView.setFloat64(position, timestamp);
					} else {
						// we apply the special instruction bytes that tell lmdb-js how to assign the timestamp
						TIMESTAMP_PLACEHOLDER[4] = timestamp;
						TIMESTAMP_PLACEHOLDER[5] = timestamp >> 8;
						encoded.set(TIMESTAMP_PLACEHOLDER, position);
					}
					position += 8;
				}
				if (blobsWereEncoded) metadata |= HAS_BLOBS;
				if (additionalAuditRefs && additionalAuditRefs.length > 0) metadata |= HAS_ADDITIONAL_AUDIT_REFS;
				if (metadata >= 0) {
					dataView.setUint32(position, metadata | (ACTION_32_BIT << 24)); // use the extended action byte
					position += 4;
					if (expiresAt >= 0) {
						dataView.setFloat64(position, expiresAt);
						position += 8;
					}
					if (residencyId) {
						dataView.setUint32(position, residencyId);
						position += 4;
					}
					if (nodeId >= 0) {
						dataView.setUint32(position, nodeId);
						position += 4;
					}
					if (additionalAuditRefs && additionalAuditRefs.length > 0) {
						encoded[position++] = additionalAuditRefs.length;
						for (const ref of additionalAuditRefs) {
							dataView.setFloat64(position, ref.version);
							position += 8;
							dataView.setUint32(position, ref.nodeId);
							position += 4;
						}
					}
				}
				return encoded;
			} else {
				lastValueEncoding = superEncode.call(this, record, options);
				return lastValueEncoding;
			}
		};
		const superSaveStructures = this.saveStructures;
		const superGetStructures = this.getStructures;
		this.saveStructures = function (structures, isCompatible): boolean | undefined {
			if (this.isRocksDB) {
				// transactionSync returns the callback's value on commit, but returns `undefined`
				// when the txn was aborted (it swallows ERR_ALREADY_ABORTED). The success path here
				// returns an explicit `true`; anything else means the shared structures were NOT
				// durably committed (a CAS conflict → `false`, or a swallowed abort → `undefined`).
				//
				// We must report a non-commit as `false` (not the buggy `undefined`, which msgpackr
				// reads as success and then writes a record referencing a structure that was never
				// saved → later "Record id is not defined" on decode). Returning `false` makes msgpackr
				// re-pack; paired with the msgpackr fix that marks structures uninitialized on
				// save-failure, the re-pack reloads the durable structures, rebuilds the transition
				// trie, re-mints, and re-saves — so the record always references a persisted structure.
				const committed = this.rootStore.transactionSync(
					(txn) => {
						const sharedStructuresKey = [Symbol.for('structures'), this.name];
						const existingStructuresBuffer = txn.getBinarySync(sharedStructuresKey);
						const existingStructures = existingStructuresBuffer ? this.decode(existingStructuresBuffer) : undefined;
						if (typeof isCompatible == 'function') {
							if (!isCompatible(existingStructures)) {
								return false;
							}
						} else if (existingStructures && existingStructures.length !== isCompatible) {
							return false;
						}
						txn.putSync(sharedStructuresKey, structures);
						return true;
					},
					{ retryOnBusy: true }
				);
				// Only record the structure update once the txn has actually committed. Setting it
				// inside the callback would leave it dangling on an aborted txn and could flag a
				// HAS_STRUCTURE_UPDATE in the audit log for a structure that was never persisted.
				if (committed === true) {
					this.structureUpdate = structures;
					return true;
				}
				return false;
			} else {
				const result = superSaveStructures.call(this, structures, isCompatible);
				this.structureUpdate = structures;
				return result;
			}
		};
		this.getStructures = function (): any {
			if (this.isRocksDB) {
				const sharedStructuresKey = [Symbol.for('structures'), this.name];
				const buffer = this.rootStore.getBinarySync(sharedStructuresKey);
				return buffer ? this.decode(buffer) : undefined;
			} else {
				return superGetStructures.call(this);
			}
		};
	}
	decode(buffer, options) {
		lastMetadata = null;
		const start = options?.start || 0;
		const end = options > -1 ? options : options?.end || buffer.length;
		let nextByte = buffer[start];
		let metadataFlags = 0;
		try {
			// The metadata/timestamp prefix is detected heuristically by the first byte. For rocksdb a
			// local-timestamp prefix starts with 66 — but 66 (0x42) is also classic shared-structure
			// record-id #2, so a timestamp-less classic record beginning with that id is misread as a
			// timestamped record (8 bytes stripped → corrupt). Callers that pass a value known to have no
			// prefix (e.g. the audit store's getValue) set options.noMetadata to skip the heuristic. Typed
			// structs start at 0x20-0x3f and never hit this, which is why it only surfaces with classic
			// structures (typed structures off).
			if (!options?.noMetadata && ((this.isRocksDB && nextByte === 66) || (nextByte < 32 && end > 2))) {
				// record with metadata
				// this means that the record starts with a local timestamp (that was assigned by lmdb-js).
				// we copy it so we can decode it as float-64; we need to do it first because if structural data
				// is loaded during decoding the buffer can actually mutate
				let position = start;
				let localTime;
				if (this.isRocksDB) {
					buffer.copy(TIMESTAMP_HOLDER, 0, position);
					position += 8;
					localTime = TIMESTAMP_VIEW.getFloat64(0);
					nextByte = buffer[position];
				} else if (nextByte === 2) {
					if (buffer.copy) {
						buffer.copy(TIMESTAMP_HOLDER, 0, position);
						position += 8;
					} else {
						for (let i = 0; i < 8; i++) TIMESTAMP_HOLDER[i] = buffer[position++];
					}
					localTime = getTimestamp();
					nextByte = buffer[position];
				}
				let expiresAt, residencyId, nodeId, additionalAuditRefs;
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
					if (metadataFlags & HAS_NODE_ID) {
						// we need to read the node id
						const dataView =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						nodeId = dataView.getUint32(position);
						position += 4;
					}
					if (metadataFlags & HAS_ADDITIONAL_AUDIT_REFS) {
						// we need to read the additional audit refs
						const dataView =
							buffer.dataView || (buffer.dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength));
						const count = buffer[position++];
						additionalAuditRefs = [];
						for (let i = 0; i < count; i++) {
							const version = dataView.getFloat64(position);
							position += 8;
							const refNodeId = dataView.getUint32(position);
							position += 4;
							additionalAuditRefs.push({ version, nodeId: refNodeId });
						}
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
					version: localTime,
					[METADATA]: metadataFlags,
					expiresAt,
					residencyId,
					nodeId,
					additionalAuditRefs,
					size: end - start,
					value,
				} as any;
				if (this.isRocksDB) return lastMetadata;
				return value;
			} // else a normal entry
			return options?.valueAsBuffer ? buffer : decodeFromDatabase(() => super.decode(buffer, options), this.rootStore);
		} catch (error) {
			const hexPreview = buffer.slice(0, 40).toString('hex');
			if (isMissingStructureError(error)) {
				// This record references a shared structure that is genuinely absent on this node — the
				// dependency already reloaded from durable storage and retried before throwing (typically a
				// replica that received the record but not the structure-buffer update; see
				// HarperFast/harper#1163). We still return null so internal reads (e.g. the metadata/__dbis__
				// scan during initialization) remain non-fatal, but surface the otherwise-silent condition
				// distinctly — a dedicated warning plus an analytics counter — so the dropped record is
				// detectable and alertable rather than laundered as legitimate emptiness into query results,
				// caches, and downstream consumers.
				// this.name is set on the RocksDB encoder; for LMDB fall back to the root store's name so
				// the metric/warning still attribute the dropped record to a store.
				const storeName = this.name ?? this.rootStore?.name;
				recordAction(true, MISSING_STRUCTURE_METRIC, storeName);
				harperLogger.warn(
					'Record references a shared structure missing on this node; decoded as null (see HarperFast/harper#1163)',
					error,
					'store: ' + storeName,
					'data: ' + hexPreview
				);
				return null;
			}
			harperLogger.error('Error decoding record', error, 'data: ' + hexPreview);
			return null;
		}
	}
}
function getTimestamp() {
	TIMESTAMP_HOLDER[0] = TIMESTAMP_HOLDER[0] ^ 0x40; // restore the first byte, we xor to differentiate the first byte from structures
	return TIMESTAMP_VIEW.getFloat64(0);
}

export function handleLocalTimeForGets(store, rootStore) {
	const isRocksDB = store instanceof RocksDatabase;
	store.readCount = 0;
	store.cachePuts = false;
	store.rootStore = rootStore;
	store.encoder.rootStore = rootStore;
	store.encoder.isRocksDB = isRocksDB;
	store.decoder = store.encoder;
	const storeGetEntry = store.getEntry;
	const storeGetSync = store.getSync;
	const storeGet = store.get;

	store.getEntry = function (id, options) {
		store.readCount++;
		lastMetadata = null;
		if (isRocksDB) {
			return when(
				options?.async ? storeGet.call(store, id, options) : storeGetSync.call(store, id, options),
				(entry) => {
					if (entry) {
						if (entry[METADATA]) {
							entry.metadataFlags = entry[METADATA];
							return withEntry(entry);
						} else return { value: entry };
					} else return entry;
				}
			);
		} else {
			let entry: Entry = storeGetEntry.call(this, id, options);
			if (lastMetadata) {
				entry.metadataFlags = lastMetadata[METADATA];
				entry.localTime = lastMetadata.localTime;
				entry.residencyId = lastMetadata.residencyId;
				entry.nodeId = lastMetadata.nodeId;
				entry.additionalAuditRefs = lastMetadata.additionalAuditRefs;
				entry.size = lastMetadata.size;
				if (lastMetadata.expiresAt >= 0) {
					entry.expiresAt = lastMetadata.expiresAt;
				}
				if (isRocksDB) entry.version = lastMetadata.localTime;
				if (entry.value) {
					entryMap.set(entry.value, entry); // allow the record to access the entry
				}
				entry.key = id;
			}
			return entry && withEntry(entry);
		}
		// if we have decoded with metadata, we want to pull it out and assign to this entry
		function withEntry(entry) {
			if (entry.value) {
				if (entry.value.constructor === Object) {
					// if an object was deserialized as a plain object, give it the right prototype for computed properties to be accessible
					const originalValue = entry.value;
					entry.value = new store.encoder.structPrototype.constructor();
					Object.assign(entry.value, originalValue);
				}
				entryMap.set(entry.value, entry); // allow the record to access the entry
			}
			entry.key = id;
			return entry;
		}
	};

	store.getSync = function (id, options) {
		const entry = store.getEntry(id, options);
		const value = entry?.value;
		if (value) {
			entryMap.set(value, entry);
		}
		return value;
	};
	store.get = function (id, options) {
		return when(store.getEntry(id, { ...options, async: true }), (entry) => {
			const value = entry?.value;
			if (value) {
				entryMap.set(value, entry);
			}
			return value;
		});
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
			if (isRocksDB) {
				if (entry.value?.[METADATA]) {
					entry.metadataFlags = entry.value[METADATA];
					Object.assign(entry, entry.value);
				}
			} else if (lastMetadata) {
				entry.metadataFlags = lastMetadata[METADATA];
				entry.localTime = lastMetadata.localTime;
				if (isRocksDB) entry.version = lastMetadata.localTime;
				entry.residencyId = lastMetadata.residencyId;
				entry.nodeId = lastMetadata.nodeId;
				entry.additionalAuditRefs = lastMetadata.additionalAuditRefs;
				entry.size = lastMetadata.size;
				if (lastMetadata.expiresAt >= 0) entry.expiresAt = lastMetadata.expiresAt;
				lastMetadata = null;
			}
			if (entry.value) {
				if (entry.value.constructor === Object) {
					// if an object was deserialized as a plain object, give it the right prototype for computed properties to be accessible
					const originalValue = entry.value;
					entry.value = new store.encoder.structPrototype.constructor();
					for (const key in originalValue) entry.value[key] = originalValue[key];
				}
			}
			return entry;
		});
	};

	if (!isRocksDB) {
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
				if (this.isDone) return;
				done.call(this);
				this.openTimer = 0; // reset so idle pool time doesn't accumulate toward the stale-open threshold
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
	}

	return store;
}
const trackedTxns: WeakRef<any>[] = [];
const configValue = envMngr.get(CONFIG_PARAMS.STORAGE_MAX_READ_TRANSACTION_OPEN_TIME) ?? 300000;
let READ_TXN_TIMEOUT_TICKS = Math.round(configValue / 15000);
export function checkReadTxnTimeouts() {
	for (let i = 0; i < trackedTxns.length; i++) {
		const txn = trackedTxns[i].deref();
		if (!txn || txn.isDone || txn.isCommitted) trackedTxns.splice(i--, 1);
		else if (txn.notCurrent) {
			if (txn.openTimer) {
				if (txn.openTimer > 3) {
					if (txn.openTimer > READ_TXN_TIMEOUT_TICKS) {
						harperLogger.error(
							`Read transaction detected that has been open too long (over ${Math.round(READ_TXN_TIMEOUT_TICKS * 15)} seconds), ending transaction`,
							txn
						);
						trackedTxns.splice(i--, 1);
						txn.timerTracked = false;
						txn.openTimer = 0;
						try {
							txn.done();
						} catch (error) {
							harperLogger.warn('Unexpected error force-closing stale LMDB read transaction', error);
						}
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
}
setInterval(checkReadTxnTimeouts, 15000).unref();
export function setReadTxnExpiration(ms: number) {
	READ_TXN_TIMEOUT_TICKS = Math.round(ms / 15000);
	return trackedTxns;
}
export function setNextEncoding(timestamp: number, metadata: number, expiresAt = -1, nodeId = -1, residencyId = 0) {
	timestampNextEncoding = timestamp;
	metadataInNextEncoding = metadata;
	expiresAtNextEncoding = expiresAt;
	nodeIdAtNextEncoding = nodeId;
	residencyIdAtNextEncoding = residencyId;
}
/**
 * Reset the module-level "next encoding" metadata to its no-metadata defaults. These globals are
 * set just before a versioned encode and consumed (and reset) by the encode hook. If the consuming
 * encode is skipped — e.g. a delete, whose record is never encoded — they would otherwise leak into
 * the next encode on ANY store, including a non-versioned DBI (__dbis__) that then prefixes its
 * record with another store's timestamp/nodeId and becomes undecodable. See harper#1307.
 */
export function clearNextEncoding() {
	timestampNextEncoding = 0;
	metadataInNextEncoding = -1;
	expiresAtNextEncoding = -1;
	nodeIdAtNextEncoding = -1;
	residencyIdAtNextEncoding = 0;
	additionalAuditRefsNextEncoding = undefined;
}
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
		// harper#1309: reset so a record===undefined call (delete/no-op) cannot carry stale bytes
		// into the audit encodedRecord or write-size analytics of this call.
		lastValueEncoding = undefined;
		const isRocksDB = store instanceof RocksDatabase;
		// determine if and how we apply the local timestamp
		if (isRocksDB) {
			// with rocksdb, we simplify to just storing the singular version/timestamp
			timestampNextEncoding = newVersion;
		} else if (audit == null)
			// if not auditing, there is no local timestamp to reference
			timestampNextEncoding = NO_TIMESTAMP;
		else if (resolveRecord)
			// preserve existing timestamp, if possible
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
		const putOptions: {
			version: number;
			instructedWrite?: boolean;
			ifVersion?: number;
			transaction?: any;
		} = {
			version: newVersion,
			instructedWrite: timestampNextEncoding > 0,
			transaction: options?.transaction,
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
			} else residencyIdAtNextEncoding = 0;
			const nodeId = options?.nodeId ?? (audit ? getThisNodeId(auditStore) : undefined);
			if (nodeId >= 0) {
				nodeIdAtNextEncoding = nodeId;
				metadataInNextEncoding |= HAS_NODE_ID;
			} else nodeIdAtNextEncoding = -1;
			const additionalAuditRefs = options?.additionalAuditRefs;
			if (additionalAuditRefs && additionalAuditRefs.length > 0) {
				additionalAuditRefsNextEncoding = additionalAuditRefs;
				metadataInNextEncoding |= HAS_ADDITIONAL_AUDIT_REFS;
			} else additionalAuditRefsNextEncoding = undefined;
			const previousAdditionalAuditRefs = existingEntry?.additionalAuditRefs;
			if (previousAdditionalAuditRefs && previousAdditionalAuditRefs.length > 0) {
				extendedType |= HAS_ADDITIONAL_AUDIT_REFS_AUDIT;
			}
			if (options?.localOnly) {
				// Mark this write as local-only: set the bit in BOTH the persisted record metadata
				// (so the full-copy send loop, which reads entry.metadataFlags, skips it) AND the audit
				// entry's extendedType (so the audit-forward send path skips it by bitmask without decode).
				metadataInNextEncoding |= LOCAL_ONLY;
				extendedType |= LOCAL_ONLY;
			}
			if (previousResidencyId !== residencyId) {
				extendedType |= HAS_PREVIOUS_RESIDENCY_ID;
				if (!previousResidencyId) previousResidencyId = 0;
			}
			if (assignMetadata & HAS_EXPIRATION) extendedType |= HAS_EXPIRATION_EXTENDED_TYPE; // we need to record the expiration in the audit log
			if (options?.originatingOperation) extendedType |= HAS_ORIGINATING_OPERATION;
			// we use resolveRecord outside of transaction, so must explicitly make it conditional
			if (resolveRecord) putOptions.ifVersion = ifVersion = existingEntry?.version ?? null;
			if (existingEntry && existingEntry.value && type !== 'message' && existingEntry.metadataFlags & HAS_BLOBS) {
				// Delete the prior row's blob files — except any the new record still references.
				// Without the retention check, updating an unrelated attribute on a row that
				// carries a file-backed blob unlinks the blob ~deletionDelay ms later, leaving
				// the new (otherwise valid) row pointing at a missing file. See HarperFast/harper#641
				// (deployment tracking) for the production repro.
				let retainedFileIds: Set<string> | undefined;
				if (record) {
					findBlobsInObject(record, (blob) => {
						const fileId = getFileId(blob);
						if (fileId) (retainedFileIds ??= new Set()).add(fileId);
					});
				}
				deleteBlobsInObject(existingEntry.value, retainedFileIds);
			}
			let result: Promise<void>;
			if (record !== undefined) {
				result = encodeBlobsWithFilePath(
					() => (isRocksDB ? store.putSync(id, record, putOptions) : store.put(id, record, putOptions)),
					id,
					store.rootStore
				);
				if (blobsWereEncoded) {
					extendedType |= HAS_BLOBS;
				}
			}
			if (audit) {
				const username = typeof options?.user === 'string' ? options.user : options?.user?.username;
				if (auditRecord) {
					encodeBlobsWithFilePath(() => store.encoder.encode(auditRecord), id, store.rootStore);
					if (blobsWereEncoded) {
						extendedType |= HAS_BLOBS;
					}
				}
				if (store.encoder?.structureUpdate) {
					extendedType |= HAS_STRUCTURE_UPDATE;
					store.encoder.structureUpdate = null;
				}
				const structureVersion = store.encoder.structures.length + (store.encoder.typedStructs?.length ?? 0);
				const nodeId = options?.nodeId ?? getThisNodeId(auditStore) ?? 0;
				const viaNodeId = options?.viaNodeId ?? nodeId;
				if (resolveRecord && existingEntry?.localTime) {
					const replacingId = existingEntry?.localTime;
					const replacingEntry = auditStore.get(replacingId, tableId, id);
					if (replacingEntry) {
						const previousVersion = replacingEntry.previousVersion;
						result = auditStore[isRocksDB ? 'putSync' : 'put'](
							replacingId,
							{
								version: newVersion,
								tableId,
								recordId: id,
								previousVersion,
								nodeId,
								user: username,
								type,
								encodedRecord: lastValueEncoding,
								extendedType,
								residencyId,
								previousResidencyId,
								expiresAt,
								structureVersion,
								previousAdditionalAuditRefs,
							},
							{ ifVersion: ifVersion, transaction: options.transaction, nodeId, viaNodeId }
						);
						return result;
					}
				}
				result = auditStore[isRocksDB ? 'putSync' : 'put'](
					record === undefined ? NEW_TIMESTAMP_PLACEHOLDER : LAST_TIMESTAMP_PLACEHOLDER,
					{
						version: newVersion,
						tableId,
						recordId: id,
						previousVersion: store instanceof RocksDatabase ? existingEntry?.version : existingEntry?.localTime ? 1 : 0,
						nodeId,
						user: username,
						type,
						encodedRecord: lastValueEncoding,
						extendedType,
						residencyId,
						previousResidencyId,
						expiresAt,
						structureVersion,
						originatingOperation: options?.originatingOperation,
						previousAdditionalAuditRefs,
					},
					{
						// turn off append flag, as we are concerned this may be related to db corruption issues
						// append: type !== 'invalidate', // for invalidation, we expect the record to be rewritten, so we don't want to necessarily expect pure sequential writes that create full pages
						instructedWrite: true,
						ifVersion,
						transaction: options.transaction,
						nodeId,
						viaNodeId,
					}
				);
			}
			if (options?.tableToTrack && TRACKED_WRITE_TYPES.has(type)) {
				recordAction(lastValueEncoding?.length ?? 1, 'db-write', options.tableToTrack, null);
			}

			return result;
		} catch (error) {
			error.message += ' id: ' + id + ' options: ' + putOptions;
			throw error;
		} finally {
			// harper#1307: clear the metadata globals staged above so they cannot leak past this call
			// into the next store's encode (notably a raw __dbis__ `seq`/residency write, which would
			// then be prefixed and become undecodable). Unconditional is safe: a successful put encodes
			// SYNCHRONOUSLY — rocksdb via putSync, and lmdb's put() also encodes inline at call time — so
			// the encode hook already consumed and reset these globals before this finally runs, making
			// the clear a no-op there. It only does work when no encode consumed them: a delete
			// (record === undefined, never encoded) or a write that threw before its encode.
			clearNextEncoding();
		}
	};
}
export function setAdditionalAuditRefs(refs: Array<{ version: number; nodeId: number }> | undefined) {
	additionalAuditRefsNextEncoding = refs;
}
export function removeEntry(store: any, entry: any, options?: any) {
	if (!entry) return;
	const removal = store.remove(entry.key, options);
	if (entry.value && entry.metadataFlags & HAS_BLOBS) {
		// Delete the old blobs only once the removal commits. Scheduling the unlink up front
		// (as before) orphaned the blob when the removal didn't actually land — an expiration
		// scan whose transaction is force-committed without this delete, or an aborted/version-
		// conflicted removal — leaving a record that references a now-missing blob and wedges
		// replication on ENOENT. The removal promise resolves when the write commits (false on
		// a conditional-version miss; rejects on abort), so gate the unlink on it. See #1364.
		const deleteOldBlobs = () => deleteBlobsInObject(entry.value);
		if (removal && typeof removal.then === 'function') {
			// Swallow rejections (aborted removal) — leave the blob in place in that case.
			removal.then(
				(committed: any) => {
					if (committed !== false) deleteOldBlobs();
				},
				() => {}
			);
		} else {
			// Synchronous (already-durable) removal: delete immediately.
			deleteOldBlobs();
		}
	}
	return removal;
}
export interface RecordObject {
	getUpdatedTime(): number;
	getExpiresAt(): number;
}
