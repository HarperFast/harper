const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { clearThisNodeName } = require('#src/server/nodeName');
const { getThisNodeId, exportIdMapping, getNodeNameForId } = require('#src/resources/nodeIdMapping');
require('#src/server/serverHelpers/serverUtilities');

const REMOTE_NODE_IDS = Symbol.for('remote-ids');

describe('getThisNodeId', () => {
	let previousHostname;
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		previousHostname = env.get(CONFIG_PARAMS.NODE_HOSTNAME);
	});
	after(() => {
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, previousHostname);
		clearThisNodeName();
	});
	function useNodeName(name) {
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, name);
		clearThisNodeName();
	}
	function freshTable() {
		// a database of its own, so each test starts from its own audit store and mapping record
		return table({
			database: `thisnodeid${++sequence}`,
			table: 'Node',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	}
	function countMappingReads(auditStore) {
		const getBinary = auditStore.getBinary;
		const counter = { reads: 0 };
		auditStore.getBinary = function (key, ...rest) {
			if (key === REMOTE_NODE_IDS) counter.reads++;
			return getBinary.call(this, key, ...rest);
		};
		counter.restore = () => (auditStore.getBinary = getBinary);
		return counter;
	}

	it('reads the mapping record at most once for repeated lookups of the same name', () => {
		useNodeName('node-a');
		const { auditStore } = freshTable();
		const counter = countMappingReads(auditStore);
		try {
			for (let i = 0; i < 100; i++) assert.strictEqual(getThisNodeId(auditStore), 0);
		} finally {
			counter.restore();
		}
		assert.ok(counter.reads <= 1, `${counter.reads} mapping reads for 100 lookups`);
	});

	it('lets audited writes skip the mapping read once confirmed', async () => {
		useNodeName('node-a');
		const Node = freshTable();
		const { auditStore } = Node;
		// a frozen clock keeps a slow run from outliving the confirmation mid-loop
		const now = performance.now;
		const frozen = now.call(performance);
		performance.now = () => frozen;
		try {
			assert.strictEqual(getThisNodeId(auditStore), 0);
			const counter = countMappingReads(auditStore);
			try {
				for (let i = 0; i < 20; i++) await Node.put(`write-${i}`, { value: i });
			} finally {
				counter.restore();
			}
			assert.strictEqual(counter.reads, 0);
		} finally {
			performance.now = now;
		}
	});

	it('confirms each audit store separately', () => {
		useNodeName('node-a');
		const first = freshTable().auditStore;
		const second = freshTable().auditStore;
		assert.strictEqual(getThisNodeId(first), 0);
		const counter = countMappingReads(second);
		try {
			assert.strictEqual(getThisNodeId(second), 0);
		} finally {
			counter.restore();
		}
		assert.strictEqual(counter.reads, 1);
	});

	it('re-reads and remaps when the node name changes', async () => {
		useNodeName('node-a');
		const Node = freshTable();
		const { auditStore } = Node;
		assert.strictEqual(getThisNodeId(auditStore), 0);
		useNodeName('node-b');
		const counter = countMappingReads(auditStore);
		try {
			assert.strictEqual(getThisNodeId(auditStore), 0);
		} finally {
			counter.restore();
		}
		assert.strictEqual(counter.reads, 1);
		const reconfirmed = countMappingReads(auditStore);
		try {
			assert.strictEqual(getThisNodeId(auditStore), 0);
		} finally {
			reconfirmed.restore();
		}
		assert.strictEqual(reconfirmed.reads, 0);
		const mapping = exportIdMapping(auditStore);
		assert.strictEqual(mapping['node-b'], 0);
		assert.ok(mapping['node-a'] > 0, `the previous name keeps a non-zero id, got ${mapping['node-a']}`);

		const beforeWrite = Date.now() - 1;
		await Node.put('renamed', { value: 1 });
		let written;
		for (const entry of auditStore.getRange({ start: beforeWrite })) {
			if (entry.recordId === 'renamed') written = entry;
		}
		assert.strictEqual(getNodeNameForId(auditStore, written.nodeId, true), 'node-b');
	});

	it('does not confirm a lookup whose read failed', () => {
		useNodeName('node-a');
		const { auditStore } = freshTable();
		assert.strictEqual(getThisNodeId(auditStore), 0);
		useNodeName('node-c');
		const getBinary = auditStore.getBinary;
		auditStore.getBinary = () => {
			throw new Error('read failed');
		};
		try {
			assert.throws(() => getThisNodeId(auditStore), /read failed/);
		} finally {
			auditStore.getBinary = getBinary;
		}
		const counter = countMappingReads(auditStore);
		try {
			assert.strictEqual(getThisNodeId(auditStore), 0);
		} finally {
			counter.restore();
		}
		assert.strictEqual(counter.reads, 1);
	});

	it('re-reads once the confirmation expires', () => {
		useNodeName('node-a');
		const { auditStore } = freshTable();
		assert.strictEqual(getThisNodeId(auditStore), 0);
		const now = performance.now;
		const counter = countMappingReads(auditStore);
		performance.now = () => now.call(performance) + 2000;
		try {
			assert.strictEqual(getThisNodeId(auditStore), 0);
			assert.strictEqual(getThisNodeId(auditStore), 0);
		} finally {
			performance.now = now;
			counter.restore();
		}
		assert.strictEqual(counter.reads, 1);
	});
});
