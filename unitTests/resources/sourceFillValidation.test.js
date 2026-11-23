require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { logger } = require('#src/utility/logging/logger');
const { waitFor } = require('../waitFor.js');

describe('Source fill schema mismatches', function () {
	this.timeout(10_000);
	let Validated, Throttled, Stamped, LongStamped, BigIntKeyed, Embedded, Loose, Sealed, responses, calls;
	let warnings, traces, originalWarn, originalTrace;

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
				{ name: 'name', type: 'String', nullable: false, indexed: true },
				{ name: 'count', type: 'Int' },
				{ name: 'seen', type: 'Date' },
				{ name: 'big', type: 'BigInt' },
				{ name: 'secret', type: 'Int' },
				{ name: 'meta', type: 'Meta', properties: [{ name: 'at', type: 'Date' }] },
			],
		});
		Throttled = table({
			database: 'test',
			table: 'SourceFillValidatedThrottled',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
			],
		});
		Stamped = table({
			database: 'test',
			table: 'SourceFillValidatedStamps',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
				{ name: 'createdAt', type: 'Date', nullable: false, assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Date', nullable: false, assignUpdatedTime: true },
			],
		});
		LongStamped = table({
			database: 'test',
			table: 'SourceFillValidatedLongStamps',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
				{ name: 'createdAt', type: 'Long', assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Long', assignUpdatedTime: true },
			],
		});
		BigIntKeyed = table({
			database: 'test',
			table: 'SourceFillValidatedBigIntKey',
			attributes: [
				{ name: 'id', type: 'BigInt', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
			],
		});
		Embedded = table({
			database: 'test',
			table: 'SourceFillValidatedEmbed',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'text', type: 'String' },
				{
					name: 'embedding',
					type: 'array',
					elements: { type: 'Float' },
					nullable: false,
					embed: { source: 'text', model: 'default' },
				},
			],
		});
		Embedded.setEmbedAttribute('embedding', async () => [0.5, 0.25]);
		Loose = table({
			database: 'test',
			table: 'SourceFillValidatedLoose',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		Sealed = table({
			database: 'test',
			table: 'SourceFillValidatedSealed',
			sealed: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		for (const Table of [Validated, Throttled, Stamped, LongStamped, BigIntKeyed, Embedded, Loose, Sealed])
			sourceFor(Table);
		originalWarn = logger.warn;
		originalTrace = logger.trace;
		logger.warn = (...args) => warnings.push(args.join(' '));
		logger.trace = (...args) => traces.push(args.join(' '));
	});

	after(() => {
		logger.warn = originalWarn;
		logger.trace = originalTrace;
	});

	beforeEach(() => {
		calls = [];
		responses = new Map();
		warnings = [];
		traces = [];
	});

	async function settled(Table, id) {
		await waitFor(() => !Table.primaryStore.hasLock(id), { message: `the fill of ${id} never released its lock` });
		return Table.primaryStore.getEntry(id);
	}

	const mismatchesFor = (Table, id) =>
		traces.filter((line) => line.includes(`The source for ${Table.tableName} returned record '${id}'`));

	it('caches and serves a record that does not match the schema as the source returned it, and reports it', async () => {
		const record = { id: 'mismatched', count: 'three', secret: 'sentinel-secret-value' };
		await assert.rejects(async () => Validated.put('mismatched', record), { statusCode: 400 });
		responses.set('mismatched', record);
		const served = await Validated.get('mismatched');
		assert.equal(served.count, 'three');
		assert.equal((await settled(Validated, 'mismatched')).value.count, 'three');
		const [mismatch] = mismatchesFor(Validated, 'mismatched');
		assert.match(mismatch, /does not match the schema \(invalid: name, count, secret\); it is cached as returned/);
		const tableWarnings = warnings.filter((line) => line.includes('SourceFillValidated returned'));
		assert.equal(tableWarnings.length, 1);
		assert.ok(tableWarnings[0].startsWith(mismatch));
		for (const line of [...warnings, ...traces]) assert.doesNotMatch(line, /sentinel-secret-value|three/);
		await Validated.get('mismatched');
		assert.deepEqual(calls, ['mismatched'], 'the mismatched record was not cached');
	});

	it('warns once a minute per table, and traces every mismatch', async () => {
		for (const id of ['first', 'second']) responses.set(id, { id });
		await Throttled.get('first');
		await Throttled.get('second');
		assert.equal(mismatchesFor(Throttled, 'first').length, 1);
		assert.equal(mismatchesFor(Throttled, 'second').length, 1);
		assert.equal(warnings.filter((line) => line.includes('SourceFillValidatedThrottled')).length, 1);
	});

	it('does not check a fill while trace is off and the table warned within the minute', async () => {
		const validate = Throttled.prototype.validate;
		let checks = 0;
		try {
			Throttled.prototype.validate = function (...args) {
				checks++;
				return validate.apply(this, args);
			};
			responses.set('warned', { id: 'warned' });
			await Throttled.get('warned');
			assert.equal(checks, 1, 'premise: the fill ran the check');
			logger.trace = undefined;
			responses.set('unchecked', { id: 'unchecked' });
			await Throttled.get('unchecked');
		} finally {
			logger.trace = (...args) => traces.push(args.join(' '));
			Throttled.prototype.validate = validate;
		}
		assert.equal(checks, 1);
	});

	it('reports a BigInt the source sent that cannot be converted', async () => {
		for (const [id, big] of [
			['bad-bigint', 'n/a'],
			['sign-only-bigint', ' - '],
			['padded-bigint', ' '.repeat(100_000) + 'x'],
		]) {
			responses.set(id, { id, name: 'n', big });
			assert.equal((await Validated.get(id)).big, big);
			assert.match(mismatchesFor(Validated, id)[0], /\(invalid: big\)/);
		}
		responses.set('good-bigint', { id: 'good-bigint', name: 'n', big: ' -12 ' });
		await Validated.get('good-bigint');
		assert.deepEqual(mismatchesFor(Validated, 'good-bigint'), []);
	});

	it('neither converts nor writes any value the source returned', async () => {
		const meta = Object.freeze({ at: '2026-01-02T03:04:05.000Z' });
		responses.set('unconverted', { id: 'unconverted', name: 'n', seen: '2026-01-02', big: '12', meta });
		const served = await Validated.get('unconverted');
		assert.equal(served.seen, '2026-01-02');
		assert.equal(served.big, '12');
		assert.equal(served.meta.at, '2026-01-02T03:04:05.000Z');
		const stored = (await settled(Validated, 'unconverted')).value;
		assert.equal(stored.seen, '2026-01-02');
		assert.equal(stored.big, '12');
		assert.deepEqual(mismatchesFor(Validated, 'unconverted'), []);
	});

	it('counts the undeclared properties of a sealed table without naming them', async () => {
		responses.set('extra', { 'id': 'extra', 'name': 'n', 'private-name': true });
		assert.equal((await Sealed.get('extra'))['private-name'], true);
		const [mismatch] = mismatchesFor(Sealed, 'extra');
		assert.match(mismatch, /\(invalid: 1 undeclared property\)/);
		assert.doesNotMatch(mismatch, /private-name/);
	});

	it('reports nothing for the values Harper sets: the key, the record times and @embed vectors', async () => {
		const fills = [
			[Validated, 'keyless', { name: 'n' }],
			[Sealed, 42, { name: 'n' }],
			[Stamped, 'stamped', { name: 'n' }],
			[LongStamped, 'long-stamped', { name: 'n' }],
			[LongStamped, 'upstream-stamped', { name: 'n', createdAt: 1795291750105.197 }],
			[BigIntKeyed, 12, { id: 'not-a-number', name: 'n' }],
			[Embedded, 'embedded', { text: 't' }],
		];
		for (const [Table, id, record] of fills) {
			responses.set(id, record);
			await Table.get(id);
			await settled(Table, id);
		}
		assert.deepEqual(
			traces.filter((line) => line.includes('does not match the schema')),
			[]
		);
		assert.strictEqual(BigIntKeyed.primaryStore.getEntry(12).value.id, 12);
		assert.deepEqual([...Embedded.primaryStore.getEntry('embedded').value.embedding], [0.5, 0.25]);
	});

	it('rejects a source that returns something other than a record', async () => {
		for (const [id, response] of [
			['array', [{ name: 'n' }]],
			['array-buffer', new ArrayBuffer(8)],
			['shared-array-buffer', new SharedArrayBuffer(8)],
			['buffer', Buffer.from('binary')],
			['blob', new Blob(['binary'])],
			['json-array', { toJSON: () => [{ name: 'n' }] }],
			['json-primitive', { toJSON: () => 'n' }],
			['primitive', 'n'],
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

	it('keeps the cached record on a 304 revalidation', async () => {
		await Validated.put('revalidated', { id: 'revalidated', name: 'cached' }, { expiresAt: Date.now() + 20 });
		await waitFor(() => Validated.primaryStore.getEntry('revalidated').expiresAt < Date.now());
		responses.set('revalidated', { status: 304, headers: new Map() });
		assert.equal((await Validated.get('revalidated')).name, 'cached');
		assert.deepEqual(calls, ['revalidated']);
	});
});
