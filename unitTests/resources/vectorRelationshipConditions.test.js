const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { derivedIndexReadiness } = require('#src/resources/indexes/hnswDerivedIndex');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

// The HNSW indexes here are euclidean, which Harper measures squared (resources/indexes/vector.ts).
const TARGET = [1, 0];
const near = (attribute = 'embedding', extra) => ({
	attribute,
	comparator: 'lt',
	value: 0.5,
	target: TARGET,
	...extra,
});

async function ids(Table, query, context) {
	const found = [];
	for await (const row of Table.search(query, context)) found.push(row.id);
	return found.sort();
}
function syncIds(Table, query) {
	return Array.from(Table.search(query))
		.map((row) => row.id)
		.sort();
}
async function count(Table, query) {
	let rows = 0;
	for await (const _row of Table.search(query)) rows++;
	return rows;
}

describe('HNSW conditions inside relationship queries and as non-leading filters', function () {
	this.timeout(60000);
	let Shelf, Book, Note;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const books = { name: 'books', elements: { type: 'VRBook', definition: {} }, relationship: { to: 'shelfId' } };
		const shelf = { name: 'shelf', type: 'VRShelf', definition: {}, relationship: { from: 'shelfId' } };
		const book = { name: 'book', type: 'VRBook', definition: {}, relationship: { from: 'bookId' } };
		Shelf = table({
			table: 'VRShelf',
			database: 'vector_relationships',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'room', indexed: true },
				{ name: 'embedding', indexed: { type: 'HNSW', distance: 'euclidean' }, type: 'Array' },
				books,
			],
		});
		Book = table({
			table: 'VRBook',
			database: 'vector_relationships',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'shelfId', indexed: true },
				{ name: 'genre', indexed: true },
				{ name: 'embedding', indexed: { type: 'HNSW', distance: 'euclidean' }, type: 'Array' },
				shelf,
			],
		});
		Note = table({
			table: 'VRNote',
			database: 'vector_relationships',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'bookId', indexed: true }, book],
		});
		books.elements.definition.tableClass = Book;
		shelf.definition.tableClass = Shelf;
		book.definition.tableClass = Book;
		// `far` has a coordinate below 0.5, so comparing coordinates instead of distance admits it
		await Shelf.put({ id: 'near', room: 'a', embedding: [1, 0.1] });
		await Shelf.put({ id: 'far', room: 'a', embedding: [0, 3] });
		await Shelf.put({ id: 'bare', room: 'a' });
		for (let i = 0; i < 20; i++) await Shelf.put({ id: `filler${i}`, room: 'b', embedding: [5 + i, 5] });
		await Book.put({ id: 'b-near', shelfId: 'near', genre: 'poetry', embedding: [1.1, 0] });
		await Book.put({ id: 'b-far', shelfId: 'far', genre: 'poetry', embedding: [0.2, 4] });
		await Book.put({ id: 'b-near-2', shelfId: 'far', genre: 'history', embedding: [0.9, 0.1] });
		for (let i = 0; i < 20; i++)
			await Book.put({ id: `book${i}`, shelfId: `filler${i}`, genre: 'fiction', embedding: [5 + i, 5] });
		await Note.put({ id: 'n-near', bookId: 'b-near' });
		await Note.put({ id: 'n-near-b', bookId: 'b-near' });
		await Note.put({ id: 'n-far', bookId: 'b-far' });
		await Note.put({ id: 'n-near-2', bookId: 'b-near-2' });
	});

	it('runs an HNSW condition inside a relationship[...] group', async () => {
		assert.deepStrictEqual(await ids(Shelf, { conditions: [{ attribute: 'books', conditions: [near()] }] }), [
			'far',
			'near',
		]);
		assert.deepStrictEqual(
			await ids(Shelf, {
				conditions: [{ attribute: 'books', conditions: [near(), { attribute: 'genre', value: 'poetry' }] }],
			}),
			['near']
		);
	});

	it('runs an HNSW condition on a to-many relationship path', async () => {
		assert.deepStrictEqual(await ids(Shelf, { conditions: [near(['books', 'embedding'])] }), ['far', 'near']);
		assert.deepStrictEqual(syncIds(Shelf, { conditions: [near(['books', 'embedding'])] }), ['far', 'near']);
	});

	it('runs an HNSW condition on a to-one and a many-to-one relationship path', async () => {
		assert.deepStrictEqual(await ids(Book, { conditions: [near(['shelf', 'embedding'])] }), ['b-near']);
		assert.deepStrictEqual(await ids(Book, { conditions: [{ attribute: 'shelf', conditions: [near()] }] }), ['b-near']);
		const notes = { conditions: [near(['book', 'embedding'])] };
		assert.deepStrictEqual(await ids(Note, notes), ['n-near', 'n-near-2', 'n-near-b']);
		assert.deepStrictEqual(syncIds(Note, notes), ['n-near', 'n-near-2', 'n-near-b']);
		assert.strictEqual(await count(Note, { ...notes, limit: 1 }), 1);
	});

	it('evaluates a non-leading HNSW threshold by distance', async () => {
		for (const enforceExecutionOrder of [true, false]) {
			const label = `enforceExecutionOrder: ${enforceExecutionOrder}`;
			const inRoom = (...conditions) => ({
				conditions: [{ attribute: 'room', value: 'a' }, ...conditions],
				enforceExecutionOrder,
			});
			assert.deepStrictEqual(await ids(Shelf, inRoom(near())), ['near'], label);
			assert.deepStrictEqual(
				await ids(Book, {
					conditions: [{ attribute: 'genre', value: 'poetry' }, near(['shelf', 'embedding'])],
					enforceExecutionOrder,
				}),
				['b-near'],
				`relationship path, ${label}`
			);
			// two thresholds on one attribute, each against its own target
			assert.deepStrictEqual(
				await ids(Shelf, inRoom(near(), { attribute: 'embedding', comparator: 'lt', value: 20, target: [0, 3] })),
				['near'],
				label
			);
			assert.deepStrictEqual(
				await ids(Shelf, inRoom(near(), { attribute: 'embedding', comparator: 'lt', value: 1, target: [0, 3] })),
				[],
				label
			);
			// `le` admits a distance equal to the threshold, `lt` does not
			const exact = { attribute: 'embedding', value: 0, target: [1, 0.1] };
			assert.deepStrictEqual(await ids(Shelf, inRoom({ ...exact, comparator: 'le' })), ['near'], label);
			assert.deepStrictEqual(await ids(Shelf, inRoom({ ...exact, comparator: 'lt' })), [], label);
			// a query's own metric overrides the index's
			assert.deepStrictEqual(
				await ids(Shelf, inRoom(near('embedding', { value: 0.01, distance: 'cosine' }))),
				['near'],
				label
			);
			// inside an OR nested in the AND
			assert.deepStrictEqual(
				await ids(Shelf, inRoom({ operator: 'or', conditions: [near(), { attribute: 'id', value: 'bare' }] })),
				['bare', 'near'],
				label
			);
			// negation excludes the rows within the threshold, a row without a vector included
			assert.deepStrictEqual(await ids(Shelf, inRoom(near('embedding', { negated: true }))), ['bare', 'far'], label);
		}
		// a presence check is not a distance condition and compares the stored value (the planner cannot
		// estimate one on an HNSW attribute, so the order is pinned)
		assert.deepStrictEqual(
			await ids(Shelf, {
				conditions: [
					{ attribute: 'room', value: 'a' },
					{ attribute: 'embedding', comparator: 'ne', value: null },
				],
				enforceExecutionOrder: true,
			}),
			['far', 'near']
		);
		const leading = await ids(Shelf, { conditions: [near('embedding', { negated: true })] });
		assert.deepStrictEqual(
			leading.filter((id) => !id.startsWith('filler')),
			['bare', 'far'],
			'a leading negated threshold matches the same rows'
		);
	});

	it('validates a non-leading HNSW condition as the leading form does, with no row reaching it', async () => {
		const behind = (condition, lead = { attribute: 'room', value: 'none' }) => ({
			conditions: [lead, condition],
			enforceExecutionOrder: true,
		});
		await assert.rejects(
			() => ids(Shelf, behind({ attribute: 'embedding', comparator: 'lt', value: 0.5 })),
			/A target vector must be provided/
		);
		await assert.rejects(() => ids(Shelf, behind(near('embedding', { target: 1 }))), /must be an array/);
		await assert.rejects(
			() => ids(Shelf, behind(near('embedding', { comparator: 'gt' }))),
			/Can not use "gt" comparator/
		);
		await assert.rejects(() => ids(Shelf, behind(near('embedding', { value: undefined }))), /must have a value/);
		await assert.rejects(
			() => ids(Shelf, behind(near('embedding', { distance: 'manhattan' }))),
			/Unknown distance function/
		);
		await assert.rejects(
			() =>
				ids(Book, behind(near(['shelf', 'embedding'], { comparator: 'gt' }), { attribute: 'genre', value: 'none' })),
			/Can not use "gt" comparator/
		);
	});

	it('unions an HNSW condition with another condition, either first, and stops early', async () => {
		const room = { attribute: 'room', value: 'b' };
		for (const conditions of [
			[near(), room],
			[room, near()],
		]) {
			const query = { operator: 'or', conditions };
			const expected = ['near', ...Array.from({ length: 20 }, (_, i) => `filler${i}`)].sort();
			assert.deepStrictEqual(await ids(Shelf, query), expected);
			assert.deepStrictEqual(syncIds(Shelf, query), expected);
			assert.strictEqual(await count(Shelf, { ...query, limit: 1 }), 1);
		}
	});
});

describe('HNSW conditions through a cross-database relationship', function () {
	this.timeout(60000);
	let Rack, Box;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const rack = { name: 'rack', type: 'VRRack', definition: {}, relationship: { from: 'rackId' } };
		const boxes = { name: 'boxes', elements: { type: 'VRBox', definition: {} }, relationship: { to: 'rackId' } };
		Rack = table({
			table: 'VRRack',
			database: 'vector_relationships_racks',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW', distance: 'euclidean' }, type: 'Array' },
				boxes,
			],
		});
		Box = table({
			table: 'VRBox',
			database: 'vector_relationships_boxes',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'rackId', indexed: true },
				{ name: 'embedding', indexed: { type: 'HNSW', distance: 'euclidean' }, type: 'Array' },
				rack,
			],
		});
		rack.definition.tableClass = Rack;
		boxes.elements.definition.tableClass = Box;
		await Rack.put({ id: 'near', embedding: [1, 0.1] });
		await Rack.put({ id: 'far', embedding: [0, 3] });
		for (let i = 0; i < 4; i++)
			await Box.put({ id: `box${i}`, rackId: i % 2 ? 'near' : 'far', embedding: i % 2 ? [0, 3] : [1, 0] });
	});

	it('reads the related HNSW index with its own database transaction', async () => {
		assert.deepStrictEqual(await ids(Box, { conditions: [near(['rack', 'embedding'])] }), ['box1', 'box3']);
		assert.deepStrictEqual(await ids(Rack, { conditions: [near(['boxes', 'embedding'])] }), ['far']);
	});

	it('reads an HNSW index with its own database transaction after the scope wrote another database', async () => {
		const context = {};
		await transaction(context, async () => {
			await Box.put({ id: 'box-in-scope', rackId: 'far', embedding: [9, 9] }, context);
			assert.deepStrictEqual(await ids(Rack, { conditions: [near()] }, context), ['near']);
			assert.deepStrictEqual(await ids(Box, { conditions: [near(['rack', 'embedding'])] }, context), ['box1', 'box3']);
		});
	});
});

describe('native-plane HNSW conditions through a relationship', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) return;
	this.timeout(60000);
	let Item, Review;
	const target = [1, 0, 0, 0];
	const close = (extra) => ({
		attribute: ['item', 'vector'],
		comparator: 'lt',
		value: 0.01,
		target,
		distance: 'cosine',
		...extra,
	});

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const item = { name: 'item', type: 'VRPlaneItem', definition: {}, relationship: { from: 'itemId' } };
		Item = table({
			table: 'VRPlaneItem',
			database: 'vector_relationships_plane',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 }, type: 'Array' },
			],
		});
		Review = table({
			table: 'VRPlaneReview',
			database: 'vector_relationships_plane',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'itemId', indexed: true }, item],
		});
		item.definition.tableClass = Item;
		await Item.put({ id: 'close', vector: [1, 0.01, 0, 0] });
		await Item.put({ id: 'away', vector: [0, 1, 0, 0] });
		for (let i = 0; i < 6; i++) await Review.put({ id: `r${i}`, itemId: i % 3 ? 'close' : 'away' });
		await waitFor(() => derivedIndexReadiness(Item.auditStore, Item.indices.vector.name).state === 'ready', {
			timeout: 15_000,
			message: 'the native HNSW index never became ready',
		});
	});

	it('joins native-plane results through a many-to-one hop', async () => {
		assert(Item.indices.vector.customIndex.filePrimary, 'the native plane answers this index');
		const query = { conditions: [close({ waitForIndexMilliseconds: 10_000 })] };
		assert.deepStrictEqual(await ids(Review, query), ['r1', 'r2', 'r4', 'r5']);
		assert.strictEqual(await count(Review, { ...query, limit: 1 }), 1);
		assert.deepStrictEqual(
			await ids(Review, {
				conditions: [{ attribute: 'itemId', value: 'close' }, close()],
				enforceExecutionOrder: true,
			}),
			['r1', 'r2', 'r4', 'r5']
		);
	});
});
