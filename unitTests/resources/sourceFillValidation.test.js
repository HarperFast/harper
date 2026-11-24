require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

describe('Source fills and the table schema', function () {
	this.timeout(10_000);
	let Validated, Loose, responses, calls;

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
		Loose = table({
			database: 'test',
			table: 'SourceFillValidatedLoose',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		for (const Table of [Validated, Loose]) sourceFor(Table);
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

	it('rejects a source that returns something other than a record', async () => {
		for (const [id, response] of [
			['array', [{ name: 'n' }]],
			['array-buffer', new ArrayBuffer(8)],
			['shared-array-buffer', new SharedArrayBuffer(8)],
			['buffer', Buffer.from('binary')],
			['blob', new Blob(['binary'])],
			['primitive', 'n'],
			['json-array', { toJSON: () => [{ name: 'n' }] }],
			['json-primitive', { toJSON: () => 'n' }],
		]) {
			responses.set(id, response);
			await assert.rejects(Loose.get(id), (error) => {
				assert.equal(error.statusCode, 502);
				assert.match(error.message, /^Source for SourceFillValidatedLoose returned a record that is not an object/);
				return true;
			});
			assert.equal((await settled(Loose, id))?.value ?? undefined, undefined);
		}
	});

	it('still treats a falsy result as no record', async () => {
		responses.set('missing', undefined);
		assert.equal(await Loose.get('missing'), undefined);
	});

	it('keeps the cached record on a 304 revalidation', async () => {
		await Validated.put('revalidated', { id: 'revalidated', name: 'cached' }, { expiresAt: Date.now() + 20 });
		await waitFor(() => Validated.primaryStore.getEntry('revalidated').expiresAt < Date.now());
		responses.set('revalidated', { status: 304, headers: new Map() });
		assert.equal((await Validated.get('revalidated')).name, 'cached');
		assert.deepEqual(calls, ['revalidated']);
	});
});
