// Equal-version writes from distinct origins (harper#3516). Origin names order ties: order-a < order-b < order-c < order-d; ids 935/936 have no name.
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const add = (value) => ({ __op__: 'add', value });
const UNMAPPED = 935;
const UNMAPPED_2 = 936;

describe('Equal-version origin order', function () {
	this.timeout(10000);
	let T, A, B, C, D;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'EqualVersionOrigins',
			database: 'equalVersionOrigins',
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: true,
		});
		A = getIdOfRemoteNode('order-a', T.auditStore);
		B = getIdOfRemoteNode('order-b', T.auditStore);
		C = getIdOfRemoteNode('order-c', T.auditStore);
		D = getIdOfRemoteNode('order-d', T.auditStore);
	});

	// Future clocks: RocksDB stamps an audit floor at open, and a write below it skips the walk.
	const clocks = () => {
		const t0 = Date.now() + 86400000;
		return { t0, t1: t0 + 2000, t2: t0 + 5000 };
	};

	function apply(id, record, { version, nodeId, logKey = version, fullUpdate = false }) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const resource = await T.getResource(id, context);
			await resource._writeUpdate(id, record, fullUpdate, { isNotification: true, nodeId, version });
		});
	}

	async function record(id) {
		const { id: _id, ...fields } = (await T.get(id)) ?? {};
		return fields;
	}

	describe('mapped and unmapped origins at one version converge in both arrival orders', () => {
		const writes = (t1) => ({
			mappedPut: () => [{ name: 'mapped' }, { version: t1, nodeId: A, fullUpdate: true }],
			unmappedPut: () => [{ name: 'unmapped' }, { version: t1, nodeId: UNMAPPED, fullUpdate: true }],
			unmappedPatch: () => [{ unmapped: 'yes' }, { version: t1, nodeId: UNMAPPED }],
		});

		for (const [label, first, second] of [
			['put/put', 'mappedPut', 'unmappedPut'],
			['put/patch', 'mappedPut', 'unmappedPatch'],
		]) {
			it(label, async () => {
				const { t0, t1 } = clocks();
				const results = [];
				for (const order of [
					[first, second],
					[second, first],
				]) {
					const id = `${label}-${order.join('-')}`;
					await apply(id, { name: 'seed' }, { version: t0, nodeId: B, fullUpdate: true });
					for (const name of order) await apply(id, ...writes(t1)[name]());
					results.push(await record(id));
				}
				assert.deepStrictEqual(results[1], results[0], 'arrival order must not decide the winner');
				assert.deepStrictEqual(results[0], { name: 'mapped' }, 'a named origin outranks an unnamed one');
			});
		}
	});

	it('applies counter adds from two unmapped origins at one version', async () => {
		const { t0, t1 } = clocks();
		await apply('two-unmapped', { count: 10 }, { version: t0, nodeId: A, fullUpdate: true });
		await apply('two-unmapped', { count: add(5) }, { version: t1, nodeId: UNMAPPED });
		await apply('two-unmapped', { count: add(3) }, { version: t1, nodeId: UNMAPPED_2 });
		assert.equal((await record('two-unmapped')).count, 18);
	});

	it('reconciles an older mapped put under an unmapped origin’s patch through its audit entry', async () => {
		const { t0, t1, t2 } = clocks();
		await apply('unmapped-head', { count: 0 }, { version: t0, nodeId: A, fullUpdate: true });
		await apply('unmapped-head', { count: add(5), unmapped: 'yes' }, { version: t2, nodeId: UNMAPPED });
		await apply('unmapped-head', { base: 'mapped', count: 10 }, { version: t1, nodeId: B, fullUpdate: true });
		assert.deepStrictEqual(await record('unmapped-head'), { base: 'mapped', count: 15, unmapped: 'yes' });
	});
});
