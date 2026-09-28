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
rocksOnly('durable full-text declarations', () => {
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
	function names(Product) {
		return Product.fullTextIndexes.map(({ name }) => name);
	}

	it('persists the declaration without a stored attribute and retains its unchanged generation', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const original = descriptor(Product);
		Product = declare({ fullTextIndexes: [definition()] });
		assert.deepStrictEqual(descriptor(Product).fullTextIndexes, original.fullTextIndexes);
		assert.deepStrictEqual(descriptor(Product).fullTextIndexGenerations, original.fullTextIndexGenerations);
		assert.deepStrictEqual(names(Product), ['search']);
		assert(!Product.attributes.some(({ name }) => name === 'search'));
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);
	});

	it('retains omitted indexes and removes declarations only when explicitly emptied', async () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const generation = Product.fullTextIndexGenerations.search;
		Product = declare();
		assert.deepStrictEqual(names(Product), ['search']);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
		await assert.rejects(async () => Product.put('one', { title: 'shoes', search: 'not writable' }), /query-only/);
		Product = declare({ fullTextIndexes: [] });
		assert.deepStrictEqual(Product.fullTextIndexes, []);
		assert.strictEqual(descriptor(Product).fullTextIndexes, undefined);
		assert.strictEqual(descriptor(Product).fullTextFields, undefined);
		await Product.put('one', { title: 'shoes', search: 'ordinary dynamic value' });
		assert.strictEqual((await Product.get('one')).search, 'ordinary dynamic value');
	});

	it('rejects incomplete field metadata before publishing a table', () => {
		for (const fullTextFields of [[], ['search']]) {
			assert.throws(
				() => declare({ fullTextIndexes: [definition(), definition('other')], fullTextFields }),
				/include every declared @fullText index/
			);
			assert.strictEqual(databases[database]?.Product, undefined);
		}
	});

	it('rejects incomplete field metadata without changing an existing declaration', async () => {
		const fullTextIndexes = [definition(), definition('other')];
		const Product = declare({ fullTextIndexes });
		const original = descriptor(Product);
		for (const fullTextFields of [[], ['search']]) {
			for (const options of [{ fullTextFields }, { fullTextIndexes, fullTextFields }]) {
				assert.throws(() => declare(options), /include every declared @fullText index/);
				assert.deepStrictEqual(descriptor(Product), original);
				assert.deepStrictEqual(names(Product), ['other', 'search']);
				assert.deepStrictEqual(Product.fullTextFields, ['other', 'search']);
			}
		}
		await assert.rejects(async () => Product.put('one', { title: 'shoes', other: 'not writable' }), /query-only/);
	});

	it('updates reserved names when an index is removed', async () => {
		let Product = declare({ fullTextIndexes: [definition(), definition('other')] });
		Product = declare({ fullTextIndexes: [definition('other')] });
		assert.deepStrictEqual(names(Product), ['other']);
		await Product.put('one', { title: 'shoes', search: 'ordinary dynamic value' });
		await assert.rejects(async () => Product.put('two', { title: 'shoes', other: 'not writable' }), /query-only/);
	});

	it('restores declarations and write guards after reload and database reopen', async () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const generation = Product.fullTextIndexGenerations.search;
		resetDatabases();
		Product = databases[database].Product;
		assert.deepStrictEqual(names(Product), ['search']);
		await assert.rejects(async () => Product.put('one', { title: 'shoes', search: 'not writable' }), /query-only/);
		await closeDatabase(database);
		release();
		release = suspendDerivedIndexActivation(openDatabase({ database }));
		resetDatabases();
		Product = databases[database].Product;
		assert.deepStrictEqual(names(Product), ['search']);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
		await assert.rejects(async () => Product.put('two', { title: 'shoes', search: 'not writable' }), /query-only/);
	});

	it('protects declared names before the native query index is available', async () => {
		const Product = declare({ fullTextIndexes: [definition()] });
		assert(!Product.fullTextQueryIndexes.search);
		await assert.rejects(async () => Product.put('one', { title: 'shoes', search: 'not writable' }), /query-only/);
	});

	it('keeps write guards when persisted audit eligibility disables the query index', async () => {
		const Product = declare({ fullTextIndexes: [definition()] });
		Product.dbisDB.putSync('Product/', { ...descriptor(Product), audit: false });
		resetDatabases();
		const reloaded = databases[database].Product;
		assert.deepStrictEqual(reloaded.fullTextIndexes, []);
		await assert.rejects(async () => reloaded.put('one', { title: 'shoes', search: 'not writable' }), /query-only/);
		await assert.rejects(async () => reloaded.get({ id: 'one', select: ['search'] }), /query-only/);
		await assert.rejects(
			async () => {
				for await (const _record of reloaded.search({
					conditions: [{ attribute: 'search', comparator: 'matches', value: 'shoes' }],
				})) {
				}
			},
			(error) => error.statusCode === 503 && /unavailable/.test(error.message)
		);
	});

	it('fails closed when persisted field metadata is missing or malformed', async () => {
		let Product = declare({ fullTextIndexes: [definition(), definition('other')] });
		const original = descriptor(Product);
		for (const fullTextFields of [undefined, null, ['search'], ['unknown']]) {
			const corrupted = { ...original, fullTextFields };
			if (fullTextFields === undefined) delete corrupted.fullTextFields;
			Product.dbisDB.putSync('Product/', corrupted);
			resetDatabases();
			Product = databases[database].Product;
			assert.deepStrictEqual(Product.fullTextFields, ['other', 'search']);
			for (const name of ['other', 'search'])
				await assert.rejects(async () => Product.put(name, { title: 'shoes', [name]: 'not writable' }), /query-only/);
		}
	});

	it('rejects malformed declarations without changing durable definitions', () => {
		const Product = declare({ fullTextIndexes: [definition()] });
		const original = descriptor(Product);
		for (const fullTextIndexes of [null, 'search', [null], [definition(), definition()]]) {
			assert.throws(() => declare({ fullTextIndexes }), { statusCode: 400 });
			assert.deepStrictEqual(descriptor(Product), original);
			assert.deepStrictEqual(Product.fullTextIndexes, original.fullTextIndexes);
		}
	});

	it('rejects current stored-attribute and primary-key collisions atomically', () => {
		const Product = declare({ fullTextIndexes: [definition()] });
		const original = descriptor(Product);
		assert.throws(
			() => declare({ attributes: [...attributes(), { name: 'search', type: 'String' }] }),
			/stored attribute/
		);
		assert.deepStrictEqual(descriptor(Product), original);
		assert(!Product.attributes.some(({ name }) => name === 'search'));
		assert.throws(() => declare({ fullTextIndexes: [definition('id')] }), /stored attribute/);
		assert.deepStrictEqual(descriptor(Product), original);
	});

	it('validates declarations before publishing a table or enabling audit logging', () => {
		assert.throws(() => declare({ fullTextIndexes: [definition('id')] }), { statusCode: 400 });
		assert.strictEqual(databases[database]?.Product, undefined);
		const Product = declare({ audit: false });
		const original = descriptor(Product);
		assert.throws(() => declare({ fullTextIndexes: [definition('id')] }), { statusCode: 400 });
		assert.deepStrictEqual(descriptor(Product), original);
		assert.strictEqual(Product.audit, false);
		assert.deepStrictEqual(Product.fullTextIndexes, []);
	});

	it('preserves local declarations when a peer omits or empties its index list', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const original = descriptor(Product);
		for (const options of [{}, { fullTextIndexes: [] }]) {
			Product = declare({ origin: 'cluster', ...options });
			assert.deepStrictEqual(names(Product), ['search']);
			assert.deepStrictEqual(descriptor(Product).fullTextIndexes, original.fullTextIndexes);
		}
	});

	it('accepts a new peer index without replacing the local declaration', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		Product = declare({ origin: 'cluster', fullTextIndexes: [definition(), definition('peerSearch')] });
		assert.deepStrictEqual(names(Product), ['peerSearch', 'search']);
	});

	for (const fullTextFields of [[], ['peerSearch'], null]) {
		it(`guards a new peer index with field metadata ${JSON.stringify(fullTextFields)}`, async () => {
			let Product = declare({ fullTextIndexes: [definition()] });
			const generation = Product.fullTextIndexGenerations.search;
			Product = declare({ origin: 'cluster', fullTextIndexes: [definition('peerSearch')], fullTextFields });
			assert.deepStrictEqual(names(Product), ['peerSearch', 'search']);
			assert.deepStrictEqual(descriptor(Product).fullTextFields, ['peerSearch', 'search']);
			assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
			for (const name of ['peerSearch', 'search'])
				await assert.rejects(async () => Product.put(name, { title: 'shoes', [name]: 'not writable' }), /query-only/);
		});
	}

	it('ignores peer stored attributes that conflict with a local declaration', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		Product = declare({ origin: 'cluster', attributes: [...attributes(), { name: 'search', type: 'String' }] });
		assert.deepStrictEqual(names(Product), ['search']);
		assert(!Product.attributes.some(({ name }) => name === 'search'));
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);
	});

	it('derives peer collision guards when persisted field metadata is missing', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const persisted = { ...descriptor(Product) };
		delete persisted.fullTextFields;
		Product.dbisDB.putSync('Product/', persisted);

		Product = declare({ origin: 'cluster', attributes: [...attributes(), { name: 'search', type: 'String' }] });

		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.deepStrictEqual(descriptor(Product).fullTextFields, ['search']);
		assert(!Product.attributes.some(({ name }) => name === 'search'));
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);
	});

	it('uses the live declaration to guard peer collisions when the primary descriptor is absent', () => {
		let Product = declare({ fullTextIndexes: [definition()] });
		const generation = Product.fullTextIndexGenerations.search;
		Product.dbisDB.removeSync('Product/');

		Product = declare({ origin: 'cluster', attributes: [...attributes(), { name: 'search', type: 'String' }] });

		assert.strictEqual(Product.audit, true);
		assert.deepStrictEqual(names(Product), ['search']);
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
		assert(!Product.attributes.some(({ name }) => name === 'search'));
		assert.strictEqual(Product.dbisDB.getSync('Product/search'), undefined);

		Product = declare({ origin: 'cluster', attributes: attributes() });
		assert.strictEqual(Product.audit, true);
		assert.deepStrictEqual(names(Product), ['search']);
		assert.deepStrictEqual(Product.fullTextFields, ['search']);
		assert.strictEqual(Product.fullTextIndexGenerations.search, generation);
	});
});
