const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setTimeout: delay } = require('node:timers/promises');

// An instance delete(query) outside transaction() commits each row on its own native transaction.
describe('delete(query) outside transaction()', function () {
	this.timeout(20000);
	let Rows;
	let nextGroup = 1;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			table: 'DeleteQueryImmediate',
			database: 'delete_query_immediate',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'group', indexed: true }, { name: 'n' }],
		});
	});

	after(async function () {
		await resetDatabases();
	});

	async function seed(count) {
		const group = `g${nextGroup++}`;
		await transaction(async (context) => {
			for (let i = 0; i < count; i++) Rows.put({ id: `${group}-${i}`, group, n: i }, context);
		});
		const target = new RequestTarget(`?group=${group}`);
		target.isCollection = true;
		target.conditions = [{ attribute: 'group', value: group }];
		const context = {};
		const resource = await Rows.getResource(target, context, { isCollection: true });
		return { group, target, context, resource };
	}

	async function remaining(group) {
		let count = 0;
		for await (const _ of Rows.search([{ attribute: 'group', value: group }])) count++;
		return count;
	}

	function trackRowCommits(resource, wrapRow = (write) => write()) {
		const stats = { issued: 0, outstanding: 0, maxOutstanding: 0 };
		const writeDelete = resource._writeDelete;
		resource._writeDelete = function (id, options) {
			stats.issued++;
			const deletion = wrapRow(() => writeDelete.call(this, id, options));
			if (!(deletion instanceof Promise)) return deletion;
			stats.outstanding++;
			stats.maxOutstanding = Math.max(stats.maxOutstanding, stats.outstanding);
			deletion.then(
				() => stats.outstanding--,
				() => stats.outstanding--
			);
			return deletion;
		};
		return stats;
	}

	it('overlaps a bounded number of row commits and deletes every row', async function () {
		const { group, context, resource, target } = await seed(100);
		const stats = trackRowCommits(resource);
		assert.strictEqual(await resource.delete(target), true);
		assert.strictEqual(context.transaction.constructor.name, 'ImmediateTransaction');
		assert.strictEqual(stats.issued, 100);
		assert.strictEqual(stats.outstanding, 0, 'every row commit settled before delete() resolved');
		assert.ok(stats.maxOutstanding > 1, `row commits overlap (max in flight ${stats.maxOutstanding})`);
		assert.ok(stats.maxOutstanding <= 16, `row commits in flight stay bounded (max ${stats.maxOutstanding})`);
		assert.strictEqual(await remaining(group), 0);
	});

	for (const failure of ['rejected row commit', 'synchronous throw']) {
		it(`a ${failure} stops the scan, settles issued rows, then rejects`, async function () {
			const { group, resource, target } = await seed(100);
			const unhandled = [];
			const onUnhandled = (error) => unhandled.push(error);
			process.on('unhandledRejection', onUnhandled);
			try {
				let row = 0;
				const stats = trackRowCommits(resource, (write) => {
					if (++row !== 20) return write();
					if (failure === 'synchronous throw') throw new Error('row failed');
					return Promise.reject(new Error('row failed'));
				});
				await assert.rejects(() => resource.delete(target), /row failed/);
				assert.strictEqual(stats.outstanding, 0, 'issued rows settled before the rejection');
				assert.ok(stats.issued < 100, `the scan stopped after the failure (issued ${stats.issued})`);
				assert.strictEqual(await remaining(group), 100 - (stats.issued - 1));
				await delay(10);
			} finally {
				process.removeListener('unhandledRejection', onUnhandled);
			}
			assert.deepStrictEqual(unhandled, []);
		});
	}
});
