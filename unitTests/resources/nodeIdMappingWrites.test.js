const assert = require('node:assert');
const { pack, unpack } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { asBinary } = require('#src/resources/asBinary');
const { exportIdMapping, getIdOfRemoteNode, remoteToLocalNodeId } = require('#src/resources/nodeIdMapping');

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
let databaseCount = 0;
const freshStore = () =>
	table({
		table: 'Orphans',
		database: `idMappingWrites_${databaseCount++}`,
		attributes: [{ name: 'id', isPrimaryKey: true }],
	}).auditStore;

// a write committed by another worker between this worker's lock-free read and its transaction
function interleaveForeignMint(auditStore, name, id) {
	const rootStore = auditStore.rootStore;
	const transactionSync = rootStore.transactionSync;
	rootStore.transactionSync = function (...args) {
		rootStore.transactionSync = transactionSync;
		const stored = auditStore.getBinary(REMOTE_NODE_IDS);
		const record = stored ? unpack(stored) : { remoteNameToId: {} };
		record.remoteNameToId[name] = id;
		if (auditStore.reusableIterable) rootStore.putSync(REMOTE_NODE_IDS, asBinary(pack(record)));
		else auditStore.putSync(REMOTE_NODE_IDS, pack(record));
		return transactionSync.apply(this, args);
	};
}

describe('node id mapping writes', function () {
	this.timeout(10000);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('gives the mapping commit a retry budget for workers minting at once', function () {
		const auditStore = freshStore();
		if (!auditStore.reusableIterable) return this.skip(); // LMDB serializes writers instead
		const rootStore = auditStore.rootStore;
		const transactionSync = rootStore.transactionSync;
		let options;
		rootStore.transactionSync = function (callback, transactionOptions) {
			options = transactionOptions;
			return transactionSync.call(this, callback, transactionOptions);
		};
		try {
			getIdOfRemoteNode('budgeted-peer', auditStore);
		} finally {
			rootStore.transactionSync = transactionSync;
		}
		// each attempt re-reads the record; rocksdb-js's default budget runs out with two workers minting at once
		assert.ok(options?.maxRetries >= 100, `maxRetries ${options?.maxRetries}`);
	});

	it('does not hand one id to two names when another worker mints between the read and the write', () => {
		const auditStore = freshStore();
		const before = getIdOfRemoteNode('seed-node', auditStore);
		interleaveForeignMint(auditStore, 'foreign-node', before + 1);
		const mine = getIdOfRemoteNode('my-node', auditStore);
		const mapping = exportIdMapping(auditStore);
		assert.strictEqual(mapping['foreign-node'], before + 1, "the other worker's name survives");
		assert.notStrictEqual(mine, before + 1);
		assert.strictEqual(mapping['my-node'], mine);
	});

	it("keeps another worker's mint when this worker takes over the local id on a fresh mapping", () => {
		const auditStore = freshStore();
		interleaveForeignMint(auditStore, 'foreign-node', 1);
		const mine = getIdOfRemoteNode('my-node', auditStore);
		const mapping = exportIdMapping(auditStore);
		assert.strictEqual(mapping['foreign-node'], 1);
		assert.notStrictEqual(mine, 1);
		assert.strictEqual(Object.values(mapping).filter((id) => id === 0).length, 1, 'one name holds the local id');
	});

	it('mints every missing name of a peer map in one transaction, keeping a concurrent addition', () => {
		const auditStore = freshStore();
		const seed = getIdOfRemoteNode('seed-node', auditStore);
		interleaveForeignMint(auditStore, 'foreign-node', seed + 1);
		const translated = remoteToLocalNodeId({ 'peer-a': 4, 'peer-b': 5, 'seed-node': 6 }, auditStore);
		const mapping = exportIdMapping(auditStore);
		assert.strictEqual(mapping['foreign-node'], seed + 1);
		assert.strictEqual(translated.get(6), seed);
		const ids = new Set([translated.get(4), translated.get(5), seed, seed + 1]);
		assert.strictEqual(ids.size, 4, 'every name has its own id');
	});
});
