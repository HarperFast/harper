const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { databases } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('REST condition value conversion', () => {
	let Brand, Product;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		await loadGQLSchema(`
			type CoercionBrand @table(database: "restConditionCoercion") {
				id: Int @primaryKey
				name: String @indexed
				products: [CoercionProduct] @relationship(to: "brandId")
			}
			type CoercionProduct @table(database: "restConditionCoercion") {
				id: Int @primaryKey
				brandId: Int @indexed
				brand: CoercionBrand @relationship(from: "brandId")
				price: Int @indexed
				pricePlain: Int
				weight: Float
				sizes: [Int] @indexed
				sizesPlain: [Int]
				matrix: [[Int]]
				code: String
				extra: Any
			}
		`);
		Brand = databases.restConditionCoercion.CoercionBrand;
		Product = databases.restConditionCoercion.CoercionProduct;
		for (const brand of [
			{ id: 1, name: 'Acme' },
			{ id: 2, name: 'Bolt' },
			{ id: 3, name: 'Core' },
		])
			await Brand.put(brand);
		const products = [
			{ id: 1, brandId: 1, price: 5, weight: 1.5, sizes: [5, 40], code: '007', matrix: [[176, 0]] },
			{
				id: 2,
				brandId: 1,
				price: 25,
				weight: 2.5,
				sizes: [25],
				code: '25',
				extra: { tag: '123' },
			},
			{ id: 3, brandId: 2, price: 30, weight: 3.5, sizes: [17, 107], code: '30' },
			{ id: 4, brandId: 2, price: 31, weight: 10.25, sizes: [31, 17], code: '31' },
			{ id: 5, brandId: 3, price: 100, weight: 20, sizes: [100, 200], code: '100' },
		];
		for (const product of products)
			await Product.put({ ...product, pricePlain: product.price, sizesPlain: product.sizes });
	});

	async function collectIds(iterable) {
		const ids = [];
		for await (const record of iterable) ids.push(record.id);
		return ids.sort((a, b) => a - b);
	}
	const rest = async (Table, queryString) => collectIds(Table.search(new RequestTarget('?' + queryString)));
	async function assertRejects400(Table, queryString, attributeName) {
		await assert.rejects(rest(Table, queryString), (error) => {
			assert.strictEqual(error.statusCode, 400);
			assert.match(error.message, new RegExp(`attribute ${attributeName}:`));
			return true;
		});
	}

	describe('chained range legs (harper#2433)', () => {
		for (const attribute of ['price', 'pricePlain']) {
			it(`${attribute}: both legs are converted, in either order`, async function () {
				assert.deepStrictEqual(await rest(Product, `${attribute}=ge=25&=le=30`), [2, 3]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=le=30&=ge=25`), [2, 3]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=gt=25&=lt=31`), [3]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=ge=number:25&=le=number:30`), [2, 3]);
			});
			it(`${attribute}: an invalid chained leg is a 400 in either order`, async function () {
				await assertRejects400(Product, `${attribute}=ge=25&=le=abc`, attribute);
				await assertRejects400(Product, `${attribute}=le=abc&=ge=25`, attribute);
			});
		}
		it('Float: a fractional chained bound is kept', async function () {
			assert.deepStrictEqual(await rest(Product, 'weight=ge=2.5&=lt=10.25'), [2, 3]);
		});
		it("does not write converted values onto the caller's chained children", async function () {
			const chained = Object.freeze({ comparator: 'le', value: '30' });
			const condition = { attribute: 'price', comparator: 'ge', value: '25', chainedConditions: [chained] };
			assert.deepStrictEqual(await collectIds(Product.search({ conditions: [condition] })), [2, 3]);
			assert.strictEqual(condition.value, '25');
			assert.strictEqual(chained.value, '30');
			const onString = { attribute: 'code', comparator: 'ge', value: '25', chainedConditions: [chained] };
			assert.deepStrictEqual(await collectIds(Product.search({ conditions: [onString] })), [2, 3]);
		});
	});

	describe('array attributes compare their elements (harper#2481)', () => {
		for (const attribute of ['sizes', 'sizesPlain']) {
			it(`${attribute}: value comparators convert with the element type`, async function () {
				assert.deepStrictEqual(await rest(Product, `${attribute}=ge=100`), [3, 5]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=lt=10`), [1]);
				assert.deepStrictEqual(await rest(Product, `${attribute}==25`), [2]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=25`), [2]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=ge=20&=le=30`), [2]);
				assert.deepStrictEqual(await rest(Product, `${attribute}=ge=number:100`), [3, 5]);
			});
			it(`${attribute}: pattern comparators keep a string operand`, async function () {
				// as a string, 07 matches 107 but not 17
				assert.deepStrictEqual(await rest(Product, `${attribute}=ct=07`), [3]);
			});
			it(`${attribute}: an invalid element value is a 400 naming the attribute`, async function () {
				await assertRejects400(Product, `${attribute}=ge=abc`, attribute);
			});
		}
		it('a nested array compares immediate elements, which are arrays', async function () {
			const condition = {
				attribute: 'matrix',
				comparator: 'between',
				value: [
					[175, 0],
					[180, 0],
				],
			};
			assert.deepStrictEqual(await collectIds(Product.search({ conditions: [condition] })), [1]);
		});
	});

	describe('paths convert with the leaf type (harper#3940)', () => {
		it('to-many relationship', async function () {
			assert.deepStrictEqual(await rest(Brand, 'products.price=ge=30'), [2, 3]);
			assert.deepStrictEqual(await rest(Brand, 'products.price=ge=number:30'), [2, 3]);
			assert.deepStrictEqual(await rest(Brand, 'products.price=ge=25&=le=30'), [1, 2]);
			assert.deepStrictEqual(await rest(Brand, 'products.sizes=ge=150'), [3]);
			assert.deepStrictEqual(await rest(Brand, 'products.price==5'), [1]);
		});
		it('to-one relationship', async function () {
			assert.deepStrictEqual(await rest(Product, 'brand.id=ge=2'), [3, 4, 5]);
			assert.deepStrictEqual(await rest(Product, 'brand.name==Acme'), [1, 2]);
		});
		it('an invalid related leaf value is a 400', async function () {
			await assertRejects400(Brand, 'products.price=ge=abc', 'price');
		});
		it('an undeclared JSON leaf keeps the decoded string', async function () {
			assert.deepStrictEqual(await rest(Product, 'extra.tag==123'), [2]);
		});
	});

	it('strict equality on a typed attribute is converted, as before', async function () {
		assert.deepStrictEqual(await rest(Product, 'price===25'), [2]);
		assert.deepStrictEqual(await rest(Product, 'code===007'), [1]);
		assert.deepStrictEqual(await rest(Product, 'sizes===25'), [2]);
	});
});
