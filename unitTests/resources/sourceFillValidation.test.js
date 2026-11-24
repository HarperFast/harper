require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

describe('Source fills and the table schema', function () {
	this.timeout(10_000);
	let Validated, responses, calls;

	function sourceFor(Table) {
		Table.sourcedFrom({
			get(id) {
				calls.push(id);
				return responses.get(id);
			},
		});
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Validated = table({
			database: 'test',
			table: 'SourceFillValidated',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true, nullable: false },
				{ name: 'name', type: 'String', nullable: false },
				{ name: 'count', type: 'Int' },
			],
		});
		sourceFor(Validated);
	});

	beforeEach(() => {
		calls = [];
		responses = new Map();
	});

	async function settled(Table, id) {
		await waitFor(() => !Table.primaryStore.hasLock(id), { message: `the fill of ${id} never released its lock` });
		return Table.primaryStore.getEntry(id);
	}

	it('caches and serves a record that does not match the schema as the source returned it, unvalidated', async () => {
		const record = { id: 'mismatched', count: 'three' };
		await assert.rejects(async () => Validated.put('mismatched', record), { statusCode: 400 });
		const validate = Validated.prototype.validate;
		let checks = 0;
		try {
			Validated.prototype.validate = function (...args) {
				checks++;
				return validate.apply(this, args);
			};
			responses.set('mismatched', record);
			const served = await Validated.get('mismatched');
			assert.equal(served.count, 'three');
			const stored = (await settled(Validated, 'mismatched')).value;
			assert.equal(stored.count, 'three');
		} finally {
			Validated.prototype.validate = validate;
		}
		assert.equal(checks, 0, 'the fill ran the schema validator');
		await Validated.get('mismatched');
		assert.deepEqual(calls, ['mismatched'], 'the record was not served from the cache');
	});
});
