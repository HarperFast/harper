require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const PARENTS = 2000;
const ROUNDS = 30;

describe('warm relationship query cost', function () {
	this.timeout(0);
	let WarmParent, WarmChild;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const childAttribute = { name: 'child', type: 'WarmChild', relationship: { from: 'childId' }, definition: {} };
		WarmParent = table({
			table: 'WarmParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'childId' },
				{ name: 'score' },
				childAttribute,
			],
		});
		WarmChild = table({
			table: 'WarmChild',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		childAttribute.definition.tableClass = WarmChild;
		for (let i = 0; i < PARENTS; i++) {
			await WarmChild.put({ id: 'c' + i, name: 'child ' + (i % 97) });
			await WarmParent.put({ id: 'p' + i, group: 'g', childId: 'c' + i, score: i % 13 });
		}
	});

	async function time(name, query) {
		const run = async () => {
			let count = 0;
			for await (const _record of WarmParent.search(query())) count++;
			return count;
		};
		for (let i = 0; i < 5; i++) await run(); // warm every cache
		const samples = [];
		let count;
		for (let i = 0; i < ROUNDS; i++) {
			const start = process.hrtime.bigint();
			count = await run();
			samples.push(Number(process.hrtime.bigint() - start) / 1e6);
		}
		samples.sort((a, b) => a - b);
		console.log(
			`BENCH ${name}: median ${samples[ROUNDS >> 1].toFixed(2)}ms p90 ${samples[Math.floor(ROUNDS * 0.9)].toFixed(2)}ms rows ${count}`
		);
	}

	it('measures', async function () {
		const lead = { attribute: 'group', value: 'g' };
		await time('select child', () => ({ conditions: [lead], select: ['id', { name: 'child', select: ['name'] }] }));
		await time('filter child.name', () => ({
			conditions: [lead, { attribute: ['child', 'name'], value: 'child 5' }],
			select: ['id'],
		}));
		await time('sort child.name', () => ({
			conditions: [lead],
			sort: { attribute: ['child', 'name'] },
			select: ['id'],
		}));
		await time('plain filter score', () => ({ conditions: [lead, { attribute: 'score', value: 5 }], select: ['id'] }));
	});
});
