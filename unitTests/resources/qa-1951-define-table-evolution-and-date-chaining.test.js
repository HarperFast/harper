require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { defineTable, types } = require('#src/resources/defineTable');
const { transaction } = require('#src/resources/transaction');

describe('QA-1951: defineTable schema evolution and types.date modifier chaining', function () {
	this.timeout(30000);

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	describe('Arm 1 — Positive control: initial registration, date.createdTime.indexed, relationships, and additive evolution', () => {
		const DB = 'qa_1951_arm1';

		it('1a. registers tables with date.createdTime.indexed and relationships, then evolves by adding an indexed field', async () => {
			let Author;
			const Book = defineTable(
				'Book',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.id.indexed.nullable,
					author: types.relation(() => Author, { from: 'authorId' }),
					createdAt: types.date.createdTime.indexed,
					updatedAt: types.date.updatedTime,
				},
				{ database: DB }
			);
			Author = defineTable(
				'Author',
				{
					id: types.id.primaryKey,
					name: types.string,
					books: types.hasMany(() => Book, { to: 'authorId' }),
				},
				{ database: DB }
			);

			await Author.put({ id: 'a1', name: 'Ursula K. Le Guin' });
			await Book.put({ id: 'b1', title: 'A Wizard of Earthsea', authorId: 'a1' });

			const book1 = await Book.get('b1');
			assert.strictEqual(book1.title, 'A Wizard of Earthsea');
			assert.ok(book1.createdAt instanceof Date, 'createdAt should be auto-assigned as a Date');
			assert.ok(book1.updatedAt instanceof Date, 'updatedAt should be auto-assigned as a Date');

			const resolvedAuthor = await book1.author;
			assert.ok(resolvedAuthor, 'forward relation should resolve');
			assert.strictEqual(resolvedAuthor.name, 'Ursula K. Le Guin');

			const author1 = await Author.get('a1');
			const authorBooks = await author1.books;
			assert.strictEqual(authorBooks.length, 1);
			assert.strictEqual(authorBooks[0].title, 'A Wizard of Earthsea');

			const BookEvolved = defineTable(
				'Book',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.id.indexed.nullable,
					author: types.relation(() => Author, { from: 'authorId' }),
					createdAt: types.date.createdTime.indexed,
					updatedAt: types.date.updatedTime,
					genre: types.string.indexed.nullable,
				},
				{ database: DB }
			);
			assert.strictEqual(BookEvolved, Book, 're-declaring returns the same live table class');
			assert.ok(
				Book.attributes.some((a) => a.name === 'genre' && a.indexed === true),
				'newly added genre attribute should be present and indexed'
			);
			await Book.indexingOperation;

			await Book.put({ id: 'b2', title: 'The Left Hand of Darkness', authorId: 'a1', genre: 'sci-fi' });
			const matches = [];
			for await (const rec of Book.search({ conditions: [{ attribute: 'genre', value: 'sci-fi' }] })) {
				matches.push(rec);
			}
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].id, 'b2');
		});
	});

	describe('Arm 2 — types.date modifier chaining order (.indexed / .nullable before .createdTime / .updatedTime)', () => {
		const DB = 'qa_1951_arm2';

		it('2a. chains .indexed before .createdTime or .updatedTime and registers a working table', async () => {
			const createdDescriptor = types.date.indexed.createdTime;
			const updatedDescriptor = types.date.indexed.updatedTime;

			assert.ok(createdDescriptor, 'types.date.indexed.createdTime must not be undefined');
			assert.strictEqual(createdDescriptor.kind, 'Date');
			assert.strictEqual(createdDescriptor.meta.indexed, true);
			assert.strictEqual(createdDescriptor.meta.assignCreatedTime, true);

			assert.ok(updatedDescriptor, 'types.date.indexed.updatedTime must not be undefined');
			assert.strictEqual(updatedDescriptor.kind, 'Date');
			assert.strictEqual(updatedDescriptor.meta.indexed, true);
			assert.strictEqual(updatedDescriptor.meta.assignUpdatedTime, true);

			const EventLog = defineTable(
				'EventLog',
				{
					id: types.id.primaryKey,
					label: types.string,
					createdAt: types.date.indexed.createdTime,
					updatedAt: types.date.indexed.updatedTime,
				},
				{ database: DB }
			);

			const byName = Object.fromEntries(EventLog.attributes.map((a) => [a.name, a]));
			assert.strictEqual(byName.createdAt.indexed, true);
			assert.strictEqual(byName.createdAt.assignCreatedTime, true);
			assert.strictEqual(byName.updatedAt.indexed, true);
			assert.strictEqual(byName.updatedAt.assignUpdatedTime, true);

			await EventLog.put({ id: 'ev1', label: 'boot' });
			const stored = await EventLog.get('ev1');
			assert.ok(stored.createdAt instanceof Date);
			assert.ok(stored.updatedAt instanceof Date);
		});

		it('2b. chains .nullable before .createdTime / .updatedTime and chains .createdTime.updatedTime', () => {
			const nullableCreated = types.date.nullable.createdTime;
			const nullableUpdated = types.date.nullable.updatedTime;
			const bothTimestamps = types.date.createdTime.updatedTime;

			assert.ok(nullableCreated, 'types.date.nullable.createdTime must not be undefined');
			assert.strictEqual(nullableCreated.kind, 'Date');
			assert.strictEqual(nullableCreated.meta.nullable, true);
			assert.strictEqual(nullableCreated.meta.assignCreatedTime, true);

			assert.ok(nullableUpdated, 'types.date.nullable.updatedTime must not be undefined');
			assert.strictEqual(nullableUpdated.kind, 'Date');
			assert.strictEqual(nullableUpdated.meta.nullable, true);
			assert.strictEqual(nullableUpdated.meta.assignUpdatedTime, true);

			assert.ok(bothTimestamps, 'types.date.createdTime.updatedTime must not be undefined');
			assert.strictEqual(bothTimestamps.kind, 'Date');
			assert.strictEqual(bothTimestamps.meta.assignCreatedTime, true);
			assert.strictEqual(bothTimestamps.meta.assignUpdatedTime, true);

			const fullChain = types.date.indexed.nullable.createdTime.updatedTime;
			assert.ok(fullChain, 'types.date.indexed.nullable.createdTime.updatedTime must not be undefined');
			assert.strictEqual(fullChain.kind, 'Date');
			assert.strictEqual(fullChain.meta.indexed, true);
			assert.strictEqual(fullChain.meta.nullable, true);
			assert.strictEqual(fullChain.meta.assignCreatedTime, true);
			assert.strictEqual(fullChain.meta.assignUpdatedTime, true);
		});
	});

	describe('Arm 3 — Relationship removal / replacement on primaryStore.encoder.structPrototype during schema evolution', () => {
		it('3a. removes a types.relation getter/setter from primaryStore.encoder.structPrototype when removed on re-declaration', async () => {
			const DB = 'qa_1951_arm3a';
			const Author = defineTable(
				'Author',
				{
					id: types.id.primaryKey,
					name: types.string,
				},
				{ database: DB }
			);
			const Book = defineTable(
				'Book',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.string.indexed.nullable,
					author: types.relation(() => Author, { from: 'authorId' }),
				},
				{ database: DB }
			);

			await Author.put({ id: 'a1', name: 'Ursula' });
			await Book.put({ id: 'b1', title: 'Earthsea', authorId: 'a1' });

			assert.ok(
				Book.primaryStore.encoder.resolvedAttributeNames?.has('author'),
				'Book.primaryStore.encoder.resolvedAttributeNames should initially include author'
			);
			const initialBook = await Book.get('b1');
			const initialAuthor = await initialBook.author;
			assert.ok(initialAuthor, 'initial relationship should resolve');
			assert.strictEqual(initialAuthor.name, 'Ursula');

			defineTable(
				'Book',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.string.indexed.nullable,
				},
				{ database: DB }
			);

			assert.strictEqual(
				Book.attributes.some((a) => a.name === 'author'),
				false,
				'author attribute should be removed from Book.attributes'
			);
			assert.strictEqual(
				Book.primaryStore.encoder.resolvedAttributeNames,
				undefined,
				'Book.primaryStore.encoder.resolvedAttributeNames should be undefined when all relationships are removed'
			);

			const afterBook = await Book.get('b1');
			assert.strictEqual(
				await afterBook.author,
				undefined,
				'reading removed relationship property on fetched record should return undefined'
			);
			assert.strictEqual(
				Object.getOwnPropertyDescriptor(Book.primaryStore.encoder.structPrototype, 'author'),
				undefined,
				'stale relationship accessor on primaryStore.encoder.structPrototype should be removed'
			);
		});

		it('3b. replaces a types.hasMany relationship with a stored scalar/array attribute on re-declaration without stale structPrototype interception', async () => {
			const DB = 'qa_1951_arm3b';
			let Book;
			const Author = defineTable(
				'Author',
				{
					id: types.id.primaryKey,
					name: types.string,
					books: types.hasMany(() => Book, { to: 'authorId' }),
				},
				{ database: DB }
			);
			Book = defineTable(
				'Book',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.string.indexed.nullable,
				},
				{ database: DB }
			);

			await Author.put({ id: 'a1', name: 'Ursula' });
			await Book.put({ id: 'b1', title: 'Earthsea', authorId: 'a1' });

			const initialBooks = Array.from(await (await Author.get('a1')).books);
			assert.strictEqual(initialBooks.length, 1);
			assert.strictEqual(initialBooks[0].title, 'Earthsea');

			defineTable(
				'Author',
				{
					id: types.id.primaryKey,
					name: types.string,
					books: types.any.nullable,
				},
				{ database: DB }
			);

			await Author.put({ id: 'a1', name: 'Ursula', books: ['Earthsea', 'Lathe of Heaven'] });
			const updatedAuthor = await Author.get('a1');
			assert.deepStrictEqual(
				updatedAuthor.books,
				['Earthsea', 'Lathe of Heaven'],
				'stored books array should round-trip instead of invoking stale hasMany resolver'
			);
			assert.strictEqual(
				Object.getOwnPropertyDescriptor(Author.primaryStore.encoder.structPrototype, 'books'),
				undefined,
				'stale hasMany accessor on primaryStore.encoder.structPrototype must be removed when converted to stored attribute'
			);
		});
	});

	describe('Arm 4 — Tracked accessor cleanup on the table prototype during schema evolution', () => {
		it('4a. removes typed scalar tracked accessor from the table prototype when attribute is removed on an unsealed table', async () => {
			const DB = 'qa_1951_arm4a';
			const Item = defineTable(
				'Item',
				{
					id: types.id.primaryKey,
					name: types.string,
					legacyCode: types.int.nullable,
				},
				{ database: DB, sealed: false }
			);

			await Item.put({ id: 'i1', name: 'Widget', legacyCode: 42 });
			assert.strictEqual(
				Object.getOwnPropertyDescriptor(Item.prototype, 'legacyCode')?.get?.isAttribute,
				true,
				'legacyCode tracked accessor should initially be installed on Item.prototype'
			);

			defineTable(
				'Item',
				{
					id: types.id.primaryKey,
					name: types.string,
				},
				{ database: DB, sealed: false }
			);

			await transaction(async () => {
				const rec = await Item.update('i1');
				rec.name = 'Updated';
				rec.legacyCode = 'ALPHA-99';
			});

			const updated = await Item.get('i1');
			assert.strictEqual(updated.name, 'Updated');
			assert.strictEqual(updated.legacyCode, 'ALPHA-99');
			assert.strictEqual(
				Object.getOwnPropertyDescriptor(Item.prototype, 'legacyCode'),
				undefined,
				'removed attribute tracked accessor should be deleted from Item.prototype'
			);
		});

		it('4b. removes relationship tracked accessor from the table prototype when relationship is removed on re-declaration', async () => {
			const DB = 'qa_1951_arm4b';
			const Author = defineTable(
				'Author',
				{
					id: types.id.primaryKey,
					name: types.string,
				},
				{ database: DB }
			);
			const Article = defineTable(
				'Article',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.id.indexed.nullable,
					author: types.relation(() => Author, { from: 'authorId' }),
				},
				{ database: DB, sealed: false }
			);

			await Author.put({ id: 'a1', name: 'Ursula' });
			await Article.put({ id: 'art1', title: 'Essay', authorId: 'a1' });

			const initialResolved = await transaction(async () => {
				const rec = await Article.update('art1');
				return await rec.author;
			});
			assert.ok(initialResolved, 'initial relationship should resolve on the updated record');
			assert.strictEqual(initialResolved.name, 'Ursula');

			defineTable(
				'Article',
				{
					id: types.id.primaryKey,
					title: types.string,
					authorId: types.id.indexed.nullable,
				},
				{ database: DB, sealed: false }
			);

			const afterResolved = await transaction(async () => {
				const rec = await Article.update('art1');
				return await rec.author;
			});
			assert.strictEqual(
				afterResolved,
				undefined,
				'removed relationship should not resolve on the updated record after schema re-declaration'
			);
			assert.strictEqual(
				Object.getOwnPropertyDescriptor(Article.prototype, 'author'),
				undefined,
				'removed relationship tracked accessor should be deleted from Article.prototype'
			);
		});
	});
});
