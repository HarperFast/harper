const { setupTestDBPath } = require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs-extra');
const { waitFor } = require('../waitFor');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const {
	RecordEncoder,
	recordUpdater,
	setNextEncoding,
	NULL_RECORD,
	FULL_WRITE_HEAD,
	VERSION_REUSED,
	HAS_EXPIRATION,
	HAS_RESIDENCY_ID,
	HAS_RESIDENCY_SLOT,
	HAS_NODE_ID,
	HAS_STRUCTURE_UPDATE,
	HAS_ADDITIONAL_AUDIT_REFS,
} = require('#src/resources/RecordEncoder');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const auditStoreModule = require('#src/resources/auditStore');
const { table } = require('#src/resources/databases');
const { INVALIDATED, REPLICA, EVICTED } = require('#src/resources/Table');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const { ACTION_32_BIT, HAS_BLOBS, LOCAL_ONLY, createAuditEntry, readAuditEntry } = auditStoreModule;
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const VERSION_FIRST_BYTE = 0x42;
const WORD_MASK = [0xff, 0x08, 0x00, 0x00];
const WORD_MATCH = [0x0e, 0x08, 0x00, 0x00];
function wordMatches(bytes) {
	return WORD_MASK.every((mask, index) => (bytes[8 + index] & mask) === WORD_MATCH[index]);
}
function matchesFilterRule(bytes) {
	return bytes.length >= 13 && bytes[0] === VERSION_FIRST_BYTE && wordMatches(bytes);
}

describe('NULL_RECORD metadata bit (harper#4515)', function () {
	describe('bit allocation', function () {
		it('is one bit of the flag bytes, apart from every other record flag', function () {
			assert.strictEqual(NULL_RECORD & (NULL_RECORD - 1), 0);
			assert.ok(NULL_RECORD > 0xff && NULL_RECORD < 0x1000000);
			const recordFlags = {
				INVALIDATED,
				REPLICA,
				EVICTED,
				HAS_EXPIRATION,
				HAS_RESIDENCY_ID,
				HAS_RESIDENCY_SLOT,
				HAS_NODE_ID,
				HAS_STRUCTURE_UPDATE,
				HAS_ADDITIONAL_AUDIT_REFS,
				HAS_BLOBS,
				LOCAL_ONLY,
				VERSION_REUSED,
				FULL_WRITE_HEAD,
			};
			for (const [name, flag] of Object.entries(recordFlags)) {
				assert.strictEqual(typeof flag, 'number', name);
				assert.strictEqual(flag & NULL_RECORD, 0, `${name} shares NULL_RECORD's bit`);
			}
			assert.deepStrictEqual(
				[...Buffer.from(new Uint32Array([NULL_RECORD | (ACTION_32_BIT << 24)]).buffer).reverse()],
				WORD_MATCH
			);
		});

		it('is undefined in the audit flag word, and an audit entry carrying it reads unchanged', function () {
			for (const [name, value] of Object.entries(auditStoreModule)) {
				if (typeof value !== 'number' || value <= 0xff || value & (value - 1)) continue;
				assert.notStrictEqual(value, NULL_RECORD, `audit flag ${name} takes the bit builds mirror NULL_RECORD into`);
			}
			const fields = {
				version: 1795000000000.5,
				tableId: 9,
				recordId: 'copied-null',
				previousVersion: null,
				nodeId: 4,
				type: 'put',
				encodedRecord: Buffer.from([0xc0]),
			};
			const plain = readAuditEntry(createAuditEntry({ ...fields, extendedType: 0 }));
			const mirrored = readAuditEntry(createAuditEntry({ ...fields, extendedType: NULL_RECORD }));
			for (const entry of [plain, mirrored]) {
				assert.strictEqual(entry.type, 'put');
				assert.strictEqual(entry.version, fields.version);
				assert.strictEqual(entry.tableId, fields.tableId);
				assert.strictEqual(entry.recordId, fields.recordId);
				assert.strictEqual(entry.nodeId, fields.nodeId);
				assert.strictEqual(entry.residencyId, undefined);
				assert.strictEqual(entry.residencySlot, undefined);
				assert.strictEqual(entry.expiresAt, undefined);
				assert.strictEqual(entry.getValue({ decoder: { decode: (bytes) => bytes[0] } }), 0xc0);
			}
		});
	});

	describe('encoder', function () {
		let dbPath, root, store, rawStore, indexStore, update;
		let nextVersion = Date.now();
		const optionalFields = [
			{ flag: HAS_EXPIRATION, bytes: 8, option: { expiresAt: Date.now() + 3600000 } },
			{ flag: HAS_RESIDENCY_ID, bytes: 4, option: { residencyId: 7 } },
			{ flag: HAS_RESIDENCY_SLOT, bytes: 2, option: { residencySlot: 513 } },
			{ flag: HAS_NODE_ID, bytes: 4, option: { nodeId: 3 } },
			{
				flag: HAS_ADDITIONAL_AUDIT_REFS,
				bytes: 1 + 12,
				option: { additionalAuditRefs: [{ version: Date.now() - 1000, nodeId: 3 }] },
			},
		];
		const combinations = Array.from({ length: 1 << optionalFields.length }, (_, mask) => {
			const present = optionalFields.filter((_field, index) => mask & (1 << index));
			return {
				mask,
				flags: present.reduce((flags, field) => flags | field.flag, 0),
				bodyOffset: 12 + present.reduce((bytes, field) => bytes + field.bytes, 0),
				options: Object.assign({}, ...present.map((field) => field.option)),
			};
		});
		const headerFlags = optionalFields.reduce((flags, field) => flags | field.flag, 0);

		before(function () {
			if (isLMDB) return this.skip();
			dbPath = path.join(setupTestDBPath(), 'null-record-flag');
			fs.removeSync(dbPath);
			root = RocksDatabase.open(dbPath, {});
			store = new PrimaryRocksDatabase(dbPath, { name: 'NullRecordFlag/', encoder: { Encoder: RecordEncoder } }).open();
			store.initStore(root);
			rawStore = RocksDatabase.open(dbPath, { name: 'NullRecordFlag/', encoding: false });
			indexStore = new PrimaryRocksDatabase(dbPath, {
				name: 'NullRecordFlagIndex/',
				encoder: { Encoder: RecordEncoder },
			}).open();
			indexStore.initStore(root);
			update = recordUpdater(store, 1, undefined);
		});

		after(function () {
			indexStore?.close();
			rawStore?.close();
			store?.close();
			root?.close();
		});

		function write(key, record, options, flags = 0) {
			update(key, record, undefined, ++nextVersion, flags, false, options);
			return store.getBinarySync(key);
		}

		it('marks a null record under every combination of optional header fields', function () {
			for (const { mask, flags, bodyOffset, options } of combinations) {
				const bytes = write(`null-${mask}`, null, options);
				const word = bytes.readUInt32BE(8);
				assert.strictEqual(word & headerFlags, flags, `combination ${mask} wrote other header fields`);
				assert.strictEqual(bytes.length, bodyOffset + 1, `combination ${mask}: the null body moved with the header`);
				assert.strictEqual(bytes[bodyOffset], 0xc0);
				assert.strictEqual(word & NULL_RECORD, NULL_RECORD, `combination ${mask}`);
				assert.ok(matchesFilterRule(bytes), `combination ${mask}`);
			}
		});

		it('never marks a row that holds a record', function () {
			for (const { mask, flags, bodyOffset, options } of combinations) {
				const bytes = write(`live-${mask}`, { id: mask, name: 'live' }, options);
				const word = bytes.readUInt32BE(8);
				assert.strictEqual(word & headerFlags, flags, `combination ${mask} wrote other header fields`);
				assert.ok(bytes.length > bodyOffset + 1);
				assert.strictEqual(word & NULL_RECORD, 0, `combination ${mask}`);
				assert.ok(!matchesFilterRule(bytes), `combination ${mask}`);
			}
		});

		it('clears a bit a caller staged for a row that holds a record', async function () {
			const viaUpdater = write('staged-live', { id: 1 }, {}, NULL_RECORD | FULL_WRITE_HEAD);
			assert.strictEqual(viaUpdater.readUInt32BE(8) & (NULL_RECORD | FULL_WRITE_HEAD), FULL_WRITE_HEAD);
			// copyDb stages a migrated row's flags as the source row decoded them
			const version = ++nextVersion;
			setNextEncoding(version, NULL_RECORD | HAS_NODE_ID | (ACTION_32_BIT << 24), -1, 3, 0);
			await store.put('migrated-live', { id: 2 }, version);
			const migrated = store.getBinarySync('migrated-live');
			assert.strictEqual(migrated.readUInt32BE(8) & (NULL_RECORD | HAS_NODE_ID), HAS_NODE_ID);
			assert.strictEqual(store.getEntry('migrated-live').value.id, 2);
		});

		it('follows the encoded body, not the value passed in', async function () {
			class SerializesToNull extends Error {
				toJSON() {
					return null;
				}
			}
			const serializedNull = write('serializes-to-null', new SerializesToNull(), {});
			assert.strictEqual(serializedNull.length, 13);
			assert.ok(matchesFilterRule(serializedNull));
			assert.strictEqual(store.getEntry('serializes-to-null').value, null);

			const version = ++nextVersion;
			setNextEncoding(version, 0, -1, -1, 0);
			await store.put('undefined-body', undefined, version);
			assert.ok(!matchesFilterRule(store.getBinarySync('undefined-body')));
			assert.strictEqual(store.getEntry('undefined-body').value, undefined);
		});

		it('needs the version byte: a row stored without a version can hold the same bytes at the word offset', async function () {
			await store.put('unversioned', '0123456\x0e\x08abc');
			const bytes = store.getBinarySync('unversioned');
			assert.strictEqual(bytes.length, 13);
			assert.ok(wordMatches(bytes));
			assert.ok(!matchesFilterRule(bytes));
			assert.strictEqual(store.getEntry('unversioned').value, '0123456\x0e\x08abc');
		});

		it('decodes a marked row to the entry the same row decodes to without the bit', function () {
			const entryFields = (entry) => ({
				value: entry.value,
				version: entry.version,
				localTime: entry.localTime,
				metadataFlags: entry.metadataFlags,
				expiresAt: entry.expiresAt,
				residencyId: entry.residencyId,
				residencySlot: entry.residencySlot,
				nodeId: entry.nodeId,
				additionalAuditRefs: entry.additionalAuditRefs,
				receivedIdentityRefs: entry.receivedIdentityRefs,
				copiedDeleteBoundary: entry.copiedDeleteBoundary,
				size: entry.size,
			});
			for (const { mask, flags, options } of combinations) {
				const marked = Buffer.from(write(`decode-${mask}`, null, options));
				const unmarked = Buffer.from(marked);
				unmarked[9] &= ~0x08;
				assert.notDeepStrictEqual(unmarked, marked);
				rawStore.putSync(`unmarked-${mask}`, unmarked);
				const entry = entryFields(store.getEntry(`decode-${mask}`));
				assert.deepStrictEqual(entry, entryFields(store.getEntry(`unmarked-${mask}`)), `combination ${mask}`);
				assert.strictEqual(entry.value, null);
				assert.strictEqual(entry.metadataFlags & NULL_RECORD, 0);
				assert.strictEqual(entry.metadataFlags & headerFlags, flags);
				for (const name of ['expiresAt', 'residencyId', 'residencySlot', 'nodeId'])
					assert.strictEqual(entry[name], options[name], `combination ${mask} ${name}`);
				assert.deepStrictEqual(entry.additionalAuditRefs, options.additionalAuditRefs);
			}
			const ranged = Array.from(store.getRange({ start: 'decode-', end: 'decode-~', versions: true }));
			assert.strictEqual(ranged.length, combinations.length);
			for (const { key, value, metadataFlags } of ranged) {
				assert.strictEqual(value, null, String(key));
				assert.strictEqual(metadataFlags & NULL_RECORD, 0, String(key));
			}
		});

		it('leaves a self-versioned index store row unmarked', function () {
			indexStore.encoder.autoVersion = true;
			indexStore.putSync('entry', null);
			const bytes = indexStore.getBinarySync('entry');
			assert.strictEqual(bytes.readUInt32BE(8), (ACTION_32_BIT << 24) >>> 0);
			assert.ok(!matchesFilterRule(bytes));
		});
	});

	describe('table writes', function () {
		let Local, Replicated, Indexed, origin, release;
		const now = Date.now() - 1000;

		function storedBytes(Table, id) {
			const store = Table.primaryStore;
			return isLMDB ? store.getBinary(id) : store.getBinarySync(id);
		}
		function isMarked(Table, id) {
			const bytes = storedBytes(Table, id);
			assert.ok(bytes, `no stored row for ${id}`);
			assert.strictEqual(bytes[8], ACTION_32_BIT, `row ${id} has no metadata word`);
			const marked = Boolean(bytes.readUInt32BE(8) & NULL_RECORD);
			if (!isLMDB) assert.strictEqual(matchesFilterRule(bytes), marked);
			return marked;
		}

		before(async function () {
			setupTestDBPath();
			setMainIsWorker(true);
			const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
			Local = table({ table: 'NullRecordLocal', audit: true, attributes });
			Indexed = table({
				table: 'NullRecordIndexed',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name', indexed: true },
				],
			});
			Replicated = table({ table: 'NullRecordReplicated', audit: true, attributes });
			origin = getIdOfRemoteNode('null-record-origin', Replicated.auditStore);
			const put = (id, version) => ({
				type: 'put',
				id,
				value: { id, name: 'live' },
				nodeId: origin,
				version,
				timestamp: version,
			});
			const remove = (id, version, isCopyApply) => ({
				type: 'delete',
				id,
				nodeId: origin,
				version,
				timestamp: version,
				isCopyApply,
			});
			const events = [
				put('replicated', now),
				remove('replicated', now + 1),
				remove('copied', now + 2, true),
				put('stamped-live', now + 20),
				remove('stamped-live', now + 10, true),
				remove('stamped-gone', now + 20),
				remove('stamped-gone', now + 10, true),
				put('marker', now + 30),
			];
			const held = new Promise((resolve) => (release = resolve));
			Replicated.sourcedFrom(
				{
					subscribeOnThisThread() {
						return true;
					},
					async *subscribe() {
						for (const event of events) yield event;
						await held;
					},
				},
				{ intermediateSource: true }
			);
			await waitFor(async () => Boolean(await Replicated.get('marker')), {
				timeout: 10000,
				message: 'the replicated events were not applied',
			});
		});

		after(function () {
			release?.();
		});

		it('a local delete stores a marked row, and a put over it stores an unmarked one', async function () {
			await Local.put({ id: 'kept', name: 'live' });
			await Local.put({ id: 'gone', name: 'live' });
			assert.strictEqual(isMarked(Local, 'gone'), false);
			await Local.delete('gone');
			assert.strictEqual(isMarked(Local, 'gone'), true);
			assert.strictEqual(isMarked(Local, 'kept'), false);
			const tombstone = Local.primaryStore.getEntry('gone');
			assert.strictEqual(tombstone.value, null);
			assert.strictEqual(tombstone.metadataFlags & NULL_RECORD, 0);
			await Local.put({ id: 'gone', name: 'back' });
			assert.strictEqual(isMarked(Local, 'gone'), false);
			assert.strictEqual((await Local.get('gone')).name, 'back');
		});

		it('a replicated delete stores a marked row', function () {
			assert.strictEqual(Replicated.primaryStore.getEntry('replicated').value, null);
			assert.strictEqual(isMarked(Replicated, 'replicated'), true);
			assert.strictEqual(isMarked(Replicated, 'marker'), false);
		});

		it('a copied delete stores a marked tombstone', function () {
			assert.strictEqual(Replicated.primaryStore.getEntry('copied').value, null);
			assert.strictEqual(isMarked(Replicated, 'copied'), true);
		});

		it('a copied delete recorded on a newer row leaves that row marked only if it is a tombstone', function () {
			if (isLMDB) return this.skip();
			const live = Replicated.primaryStore.getEntry('stamped-live');
			const gone = Replicated.primaryStore.getEntry('stamped-gone');
			assert.strictEqual(live.copiedDeleteBoundary?.version, now + 10, 'the live row was not stored again');
			assert.strictEqual(gone.copiedDeleteBoundary?.version, now + 10, 'the tombstone was not stored again');
			assert.strictEqual(live.value.name, 'live');
			assert.strictEqual(gone.value, null);
			assert.strictEqual(isMarked(Replicated, 'stamped-live'), false);
			assert.strictEqual(isMarked(Replicated, 'stamped-gone'), true);
		});

		it('a message published to an id that holds no record stores a marked row', async function () {
			await Local.publish('never-stored', { note: 'no record here' });
			assert.strictEqual(Local.primaryStore.getEntry('never-stored').value, null);
			assert.strictEqual(isMarked(Local, 'never-stored'), true);
		});

		it('an invalidation is marked only when it keeps no fields', async function () {
			await Local.put({ id: 'stale', name: 'live' });
			await Local.invalidate('stale');
			const bare = Local.primaryStore.getEntry('stale');
			assert.strictEqual(bare.value, null);
			assert.ok(bare.metadataFlags & INVALIDATED);
			assert.strictEqual(isMarked(Local, 'stale'), true);

			await Indexed.put({ id: 'stale', name: 'live' });
			await Indexed.invalidate('stale');
			const partial = Indexed.primaryStore.getEntry('stale');
			assert.strictEqual(partial.value.name, 'live');
			assert.ok(partial.metadataFlags & INVALIDATED);
			assert.strictEqual(isMarked(Indexed, 'stale'), false);
		});
	});
});
