require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, database: openDatabase, databases, resetDatabases, table } = require('#src/resources/databases');
const { suspendDerivedIndexActivation } = require('#src/resources/derivedIndexes');

function attributes() {
	return [
		{ name: 'id', type: 'ID', isPrimaryKey: true },
		{ name: 'title', type: 'String' },
	];
}

function definition(name = 'search') {
	return { name, fields: [{ name: 'title', weight: 1 }] };
}

const rocksOnly = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

rocksOnly('durable full-text field declarations', () => {
	let database;
	let release;
	let sequence = 0;

	before(() => setupTestDBPath());

	beforeEach(() => {
		database = `fulltext-fields-${process.pid}-${Date.now()}-${sequence++}`;
		release = suspendDerivedIndexActivation(openDatabase({ database }));
	});

	afterEach(async () => {
		await closeDatabase(database);
		release();
	});

	function declare(options = {}) {
		return table({ database, table: 'Product', audit: true, attributes: attributes(), ...options });
	}

	function descriptor(Product) {
		return Product.dbisDB.getSync('Product/');
	}

	it('persists virtual names outside the index definition and retains generation when adopting field syntax', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const original = descriptor(Product);
		Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		const adopted = descriptor(Product);
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.deepStrictEqual(adopted.fullTextFields, ['search']);
		assert.deepStrictEqual(adopted.fullTextIndexes, original.fullTextIndexes);
		assert.deepStrictEqual(adopted.fullTextIndexGenerations, original.fullTextIndexGenerations);
		assert.strictEqual(
			Product.attributes.some(({ name }) => name === 'search'),
			false
		);
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);
	});

	it('retains names on omitted programmatic options and removes them on explicit empty options', () => {
		let Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		const generation = Product.fullTextIndexGenerations.search;
		Product = declare();
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, ['search']);
		Product = declare({ fullTextFields: [] });
		assert.deepStrictEqual(Product.fullTextFields, []);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, []);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
	});

	it('filters retained names when their definitions are removed', () => {
		let Product = declare({
			fullTextIndexes: [definition(), definition('other')],
			fullTextFields: ['search', 'other'],
		});
		Product = declare({ fullTextIndexes: [definition('other')] });
		assert.deepStrictEqual(Product.fullTextFields, ['other']);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, ['other']);
		Product = declare({ fullTextIndexes: [] });
		assert.deepStrictEqual(Product.fullTextFields, []);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, []);
	});

	it('hydrates names after a schema reload and database reopen while preserving the storage generation', async () => {
		let Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		const generation = Product.fullTextIndexGenerations.search;
		Product.fullTextFields = [];
		resetDatabases();
		assert.deepStrictEqual(databases[database].Product.fullTextFields, ['search']);
		await closeDatabase(database);
		release();
		release = suspendDerivedIndexActivation(openDatabase({ database }));
		resetDatabases();
		Product = databases[database].Product;
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, ['search']);
	});

	it('retains names when the persisted index is temporarily unavailable', async () => {
		const Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		Product.dbisDB.putSync('Product/', { ...descriptor(Product), audit: false });
		resetDatabases();
		const reloaded = databases[database].Product;
		assert.deepStrictEqual(reloaded.fullTextIndexes, []);
		assert.deepStrictEqual(reloaded.fullTextFields, ['search']);
		await assert.rejects(async () => reloaded.put('shadow', { id: 'shadow', title: 'valid', search: 'injected' }), {
			statusCode: 400,
		});
	});

	it('rejects malformed field metadata before changing durable definitions or retiring an index', () => {
		const Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		const original = descriptor(Product);
		for (const fullTextFields of [null, 'search', [null], ['missing'], ['search', 'search']]) {
			assert.throws(() => declare({ fullTextIndexes: [], fullTextFields }), { statusCode: 400 });
			assert.deepStrictEqual(descriptor(Product), original);
			assert.deepStrictEqual(Product.fullTextFields, ['search']);
			assert.deepStrictEqual(Product.fullTextIndexes, original.fullTextIndexes);
		}
	});

	it('rejects stored-field collisions atomically, including retained markers and primary keys', () => {
		const Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		const original = descriptor(Product);
		assert.throws(
			() => declare({ attributes: [...attributes(), { name: 'search', type: 'String' }] }),
			/stored attribute/
		);
		assert.deepStrictEqual(descriptor(Product), original);
		assert.strictEqual(
			Product.attributes.some(({ name }) => name === 'search'),
			false
		);
		assert.throws(() => declare({ fullTextIndexes: [definition('id')], fullTextFields: ['id'] }), /stored attribute/);
		assert.deepStrictEqual(descriptor(Product), original);
	});

	it('rejects replacing a durable stored attribute with a virtual field without discarding its data', async () => {
		const Product = declare({ attributes: [...attributes(), { name: 'search', type: 'String' }] });
		await Product.put('one', { title: 'trail shoes', search: 'stored value' });
		const original = descriptor(Product);
		assert.throws(() => declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] }), /stored attribute/);
		assert.deepStrictEqual(descriptor(Product), original);
		assert.strictEqual((await Product.get('one')).search, 'stored value');
		assert.deepStrictEqual(Product.fullTextFields, []);
	});

	it('validates names before publishing a table or pinning audit logging on an existing one', () => {
		assert.throws(() => declare({ fullTextIndexes: [definition()], fullTextFields: null }), { statusCode: 400 });
		assert.strictEqual(databases[database]?.Product, undefined);
		const Product = declare({ audit: false });
		const original = descriptor(Product);
		assert.throws(() => declare({ fullTextIndexes: [definition()], fullTextFields: ['missing'] }), { statusCode: 400 });
		assert.deepStrictEqual(descriptor(Product), original);
		assert.strictEqual(Product.audit, false);
		assert.deepStrictEqual(Product.fullTextFields, []);
	});

	it('preserves local names when an older peer omits metadata or a peer sends an empty list', () => {
		let Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		for (const options of [{}, { fullTextFields: [] }]) {
			Product = declare({ origin: 'cluster', fullTextIndexes: [definition()], ...options });
			assert.deepStrictEqual(Product.fullTextFields, ['search']);
			assert.deepStrictEqual(descriptor(Product).fullTextFields, ['search']);
		}
	});

	it('accepts new peer fields while preserving existing local legacy declarations', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		Product = declare({
			origin: 'cluster',
			fullTextIndexes: [definition(), definition('peerSearch')],
			fullTextFields: ['search', 'peerSearch'],
		});
		assert.deepStrictEqual(Product.fullTextFields, ['peerSearch']);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, ['peerSearch']);
	});

	it('ignores peer stored attributes that conflict with a local virtual declaration', () => {
		let Product = declare({ fullTextIndexes: [definition()], fullTextFields: ['search'] });
		Product = declare({ origin: 'cluster', attributes: [...attributes(), { name: 'search', type: 'String' }] });
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.strictEqual(
			Product.attributes.some(({ name }) => name === 'search'),
			false
		);
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);
	});
});
