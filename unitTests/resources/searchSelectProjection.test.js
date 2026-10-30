const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource, transformForSelect } = require('#src/resources/Resource');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('search select projection matches single-record projection', function () {
	let Article, Author, Comment, previousMainIsWorker;
	const article = {
		id: 'a1',
		title: 'Main Article',
		authorId: 'u-alice',
		meta: {
			note: 'keep-meta',
			summary: 'Nested plain summary',
			asyncDigest: 'nested-plain-digest',
			author: 'Plain Nested Author',
			comments: ['inline-note-1', 'inline-note-2'],
			$id: 'nested-dollar-id',
			$score: 0.875,
			$updatedtime: 'nested-updated',
			hidden: 'omit',
		},
		citation: { authorId: 'u-bob', author: 'Citation Label Only' },
		wrapper: { citation: { authorId: 'u-bob', author: 'Citation Label Only' } },
		sections: [
			{ heading: 'One', summary: 'Section 1 plain summary', asyncDigest: 'sec-1-digest', hidden: 'omit' },
			{ heading: 'Two', summary: 'Section 2 plain summary', asyncDigest: 'sec-2-digest', hidden: 'omit' },
		],
		protoKeys: JSON.parse(
			'{"hasOwnProperty":"ordinary data","valueOf":"ordinary data","toString":"ordinary data","constructor":{"city":"Denver","hidden":"omit"},"city":"Denver"}'
		),
	};

	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		Author = table({
			database: 'search_select_projection',
			table: 'Author',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'clearance', type: 'String' },
			],
		});
		Comment = table({
			database: 'search_select_projection',
			table: 'Comment',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'articleId', indexed: true },
				{ name: 'body', type: 'String' },
			],
		});
		Article = table({
			database: 'search_select_projection',
			table: 'Article',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'authorId', type: 'String' },
				{ name: 'meta', type: 'Any' },
				{ name: 'citation', type: 'Any' },
				{ name: 'wrapper', type: 'Any' },
				{ name: 'bin', type: 'Bytes' },
				{ name: 'dates', elements: { type: 'Date' } },
				{ name: 'sections', elements: { type: 'Any' } },
				{ name: 'protoKeys', type: 'Any' },
				{ name: 'summary', computed: true },
				{ name: 'asyncDigest', computed: true },
				{ name: 'computedMeta', computed: true },
				{ name: 'asyncComputedMeta', computed: true },
				{ name: 'asyncPendingMeta', computed: true },
				{ name: 'failingComputed', computed: true },
				{ name: 'thenableShapedMeta', computed: true },
				{ name: 'asyncDate', computed: true },
				{ name: 'author', type: 'Author', relationship: { from: 'authorId' }, definition: { tableClass: Author } },
				{
					name: 'comments',
					relationship: { to: 'articleId' },
					elements: { type: 'Comment', definition: { tableClass: Comment } },
				},
			],
		});
		Article.setComputedAttribute('summary', (record) => 'TOP_SUMMARY:' + (record.title ?? 'NO_TITLE'));
		Article.setComputedAttribute('asyncDigest', async (record) => 'ASYNC_DIGEST:' + (record.title ?? 'NO_TITLE'));
		Article.setComputedAttribute('computedMeta', (record) => ({
			publicSummary: 'PUBLIC:' + record.title,
			internalSecret: 'DO_NOT_LEAK',
		}));
		Article.setComputedAttribute('asyncComputedMeta', async (record) => ({
			publicSummary: 'ASYNC_PUBLIC:' + record.title,
			internalSecret: 'DO_NOT_LEAK',
		}));
		Article.setComputedAttribute('asyncPendingMeta', async () => ({
			child: new Promise((resolve) => setTimeout(() => resolve('settled'), 5)),
			hidden: 'omit',
		}));
		Article.setComputedAttribute('thenableShapedMeta', () => ({ label: 'kept', then: 'next-step', hidden: 'omit' }));
		Article.setComputedAttribute('asyncDate', async () => new Date('2026-01-01T00:00:00.000Z'));
		Article.setComputedAttribute('failingComputed', async () => {
			throw new Error('computed failure');
		});
		await Author.put({ id: 'u-alice', name: 'Alice', clearance: 'public' });
		await Author.put({ id: 'u-bob', name: 'Bob Reviewer', clearance: 'restricted' });
		await Comment.put({ id: 'c1', articleId: 'a1', body: 'first comment' });
		await Article.put(article);
		await Article.put({ id: 'a2', title: 'Second', meta: { note: 'second-meta', summary: 'Second nested summary' } });
	});

	after(async function () {
		try {
			await Article?.dropTable();
			await Author?.dropTable();
			await Comment?.dropTable();
		} finally {
			setMainIsWorker(previousMainIsWorker);
		}
	});

	async function projectBothWays(select) {
		const target = new RequestTarget();
		target.id = article.id;
		target.select = select;
		const single = await Article.get(target);
		const searched = await search(select);
		assert.strictEqual(searched.length, 1);
		assert.deepStrictEqual(searched[0], single, 'search row must equal the single-record projection');
		return searched[0];
	}

	async function search(select) {
		const rows = [];
		for await (const row of Article.search({ conditions: [{ attribute: 'id', value: article.id }], select }))
			rows.push(row);
		return rows;
	}

	const nested = (name, select) => ({ name, select });

	const cases = [
		{
			name: 'nested key named like a sync @computed',
			select: ['id', nested('meta', ['note', 'summary']), nested('sections', ['heading', 'summary'])],
			expected: {
				id: 'a1',
				meta: { note: 'keep-meta', summary: 'Nested plain summary' },
				sections: [
					{ heading: 'One', summary: 'Section 1 plain summary' },
					{ heading: 'Two', summary: 'Section 2 plain summary' },
				],
			},
		},
		{
			name: 'nested key named like an async @computed',
			select: ['id', nested('meta', ['note', 'asyncDigest']), nested('sections', ['heading', 'asyncDigest'])],
			expected: {
				id: 'a1',
				meta: { note: 'keep-meta', asyncDigest: 'nested-plain-digest' },
				sections: [
					{ heading: 'One', asyncDigest: 'sec-1-digest' },
					{ heading: 'Two', asyncDigest: 'sec-2-digest' },
				],
			},
		},
		{
			name: 'nested key named like a @relationship(from)',
			select: ['id', nested('meta', ['note', 'author']), nested('citation', ['author'])],
			expected: {
				id: 'a1',
				meta: { note: 'keep-meta', author: 'Plain Nested Author' },
				citation: { author: 'Citation Label Only' },
			},
		},
		{
			name: 'nested key named like a @relationship(to)',
			select: ['id', nested('meta', ['note', 'comments'])],
			expected: { id: 'a1', meta: { note: 'keep-meta', comments: ['inline-note-1', 'inline-note-2'] } },
		},
		{
			name: 'nested keys named like $id, $score and $updatedtime',
			select: ['id', nested('meta', ['note', '$id', '$score', '$updatedtime'])],
			expected: {
				id: 'a1',
				meta: { note: 'keep-meta', $id: 'nested-dollar-id', $score: 0.875, $updatedtime: 'nested-updated' },
			},
		},
		{
			name: 'nested sub-select on a nested key named like a @relationship(from)',
			select: ['id', nested('citation', [nested('author', ['name'])])],
			expected: { id: 'a1', citation: { author: 'Citation Label Only' } },
		},
		{
			name: 'sub-select on an object-returning @computed',
			select: ['id', nested('computedMeta', ['publicSummary'])],
			expected: { id: 'a1', computedMeta: { publicSummary: 'PUBLIC:Main Article' } },
		},
		{
			name: 'sub-select on an async object-returning @computed',
			select: ['id', nested('asyncComputedMeta', ['publicSummary'])],
			expected: { id: 'a1', asyncComputedMeta: { publicSummary: 'ASYNC_PUBLIC:Main Article' } },
		},
		{
			name: 'sub-select on an async @computed whose projection is itself async',
			select: ['id', nested('asyncPendingMeta', ['child'])],
			expected: { id: 'a1', asyncPendingMeta: { child: 'settled' } },
		},
		{
			name: 'nested wildcard returns the whole plain sub-object',
			select: ['id', nested('meta', ['*']), nested('sections', ['*'])],
			expected: { id: 'a1', meta: article.meta, sections: article.sections },
		},
		{
			name: 'non-callable then fields are data',
			select: ['id', 'thenableShapedMeta', nested('computedMeta', ['publicSummary', 'then'])],
			expected: {
				id: 'a1',
				thenableShapedMeta: { label: 'kept', then: 'next-step', hidden: 'omit' },
				computedMeta: { publicSummary: 'PUBLIC:Main Article', then: undefined },
			},
		},
		{
			name: 'top-level Object.prototype member names with a sub-select',
			select: ['id', nested('constructor', ['city']), nested('toString', ['city'])],
			expected: { id: 'a1', constructor: undefined, toString: undefined },
		},
		{
			name: 'nested Object.prototype member names',
			select: ['id', nested('protoKeys', ['city', 'hasOwnProperty', 'valueOf', 'toString', 'constructor'])],
			expected: {
				id: 'a1',
				protoKeys: {
					city: 'Denver',
					hasOwnProperty: 'ordinary data',
					valueOf: 'ordinary data',
					toString: 'ordinary data',
					constructor: { city: 'Denver', hidden: 'omit' },
				},
			},
		},
		{
			name: 'nested Object.prototype member names that are not stored',
			select: ['id', nested('meta', ['note', 'hasOwnProperty', 'valueOf', 'toString'])],
			expected: {
				id: 'a1',
				meta: { note: 'keep-meta', hasOwnProperty: undefined, valueOf: undefined, toString: undefined },
			},
		},
		{
			name: 'top-level Object.prototype member names',
			select: ['id', 'hasOwnProperty', 'valueOf', 'toString', 'constructor'],
			expected: {
				id: 'a1',
				hasOwnProperty: undefined,
				valueOf: undefined,
				toString: undefined,
				constructor: undefined,
			},
		},
		{
			name: 'actual outer resolvers still resolve',
			select: ['id', 'summary', 'asyncDigest', nested('author', ['name']), nested('comments', ['body'])],
			expected: {
				id: 'a1',
				summary: 'TOP_SUMMARY:Main Article',
				asyncDigest: 'ASYNC_DIGEST:Main Article',
				author: { name: 'Alice' },
				comments: [{ body: 'first comment' }],
			},
		},
	];

	for (const { name, select, expected } of cases) {
		it(name, async function () {
			assert.deepStrictEqual(await projectBothWays(select), expected);
		});
	}

	it('projects every row of a multi-row search with the plain nested projection', async function () {
		const select = ['id', nested('meta', ['note', 'summary'])];
		const rows = [];
		for await (const row of Article.search({
			conditions: [{ attribute: 'id', comparator: 'starts_with', value: 'a' }],
			select,
		}))
			rows.push(row);
		rows.sort((a, b) => (a.id < b.id ? -1 : 1));
		assert.deepStrictEqual(rows, [
			{ id: 'a1', meta: { note: 'keep-meta', summary: 'Nested plain summary' } },
			{ id: 'a2', meta: { note: 'second-meta', summary: 'Second nested summary' } },
		]);
	});

	it('keeps repeated selections of one attribute distinct', async function () {
		const select = [nested('meta', ['note']), nested('meta', ['summary'])];
		select.asArray = true;
		assert.deepStrictEqual(await search(select), [[{ note: 'keep-meta' }, { summary: 'Nested plain summary' }]]);
	});

	it('keeps repeated selections inside a plain sub-object distinct', async function () {
		const inner = [nested('citation', ['authorId']), nested('citation', ['author'])];
		inner.asArray = true;
		assert.deepStrictEqual(await projectBothWays([nested('wrapper', inner)]), {
			wrapper: [{ authorId: 'u-bob' }, { author: 'Citation Label Only' }],
		});
	});

	it('keeps repeated selections of one relationship distinct', async function () {
		const select = [nested('author', ['id']), nested('author', ['name'])];
		select.asArray = true;
		assert.deepStrictEqual(await search(select), [[{ id: 'u-alice' }, { name: 'Alice' }]]);
	});

	it('returns a nested selector without a select list unchanged on both paths', async function () {
		assert.deepStrictEqual(await projectBothWays(['id', { name: 'meta' }]), { id: article.id, meta: article.meta });
	});

	it('applies forceNulls inside a plain nested projection', async function () {
		const metaSelect = ['note', 'summary', 'absent'];
		metaSelect.forceNulls = true;
		assert.deepStrictEqual(await projectBothWays(['id', nested('meta', metaSelect)]), {
			id: 'a1',
			meta: { note: 'keep-meta', summary: 'Nested plain summary', absent: null },
		});
	});

	it('a rejected @computed rejects its row and leaves later searches working', async function () {
		await assert.rejects(search(['id', 'failingComputed']), { message: 'computed failure' });
		assert.deepStrictEqual(await projectBothWays(['id', nested('computedMeta', ['publicSummary'])]), {
			id: 'a1',
			computedMeta: { publicSummary: 'PUBLIC:Main Article' },
		});
	});

	it('selecting __proto__ on a table record yields no data', async function () {
		assert.deepStrictEqual(JSON.stringify(await projectBothWays(['id', '__proto__'])), '{"id":"a1"}');
		assert.deepStrictEqual(
			JSON.stringify(await projectBothWays(['id', nested('meta', ['note', '__proto__', nested('__proto__', ['x'])])])),
			'{"id":"a1","meta":{"note":"keep-meta"}}'
		);
	});

	it('a positional select with a wildcard keeps the selector intact across rows', async function () {
		const select = ['id', '*'];
		select.asArray = true;
		const rows = [];
		for await (const row of Article.search({
			conditions: [{ attribute: 'id', comparator: 'starts_with', value: 'a' }],
			select,
		}))
			rows.push(row);
		assert.deepStrictEqual(select, Object.assign(['id', '*'], { asArray: true }));
		assert.deepStrictEqual(rows.map((row) => [row[0], row[1].id]).sort(), [
			['a1', 'a1'],
			['a2', 'a2'],
		]);
		const [single, searched] = [await projectBothWays(select), rows.find((row) => row[0] === 'a1')];
		assert.deepStrictEqual(single, searched);
	});

	it('a wildcard sub-select keeps Date and binary values intact', async function () {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');
		await Article.put({ id: 'a-binary', bin: Buffer.from([1, 2, 3]), dates: [createdAt] });
		const projectBinary = async (select) => {
			const target = new RequestTarget();
			target.id = 'a-binary';
			target.select = select;
			const single = await Article.get(target);
			const rows = [];
			for await (const row of Article.search({ conditions: [{ attribute: 'id', value: 'a-binary' }], select }))
				rows.push(row);
			return [single, rows[0]];
		};
		try {
			for (const row of await projectBinary(['id', nested('bin', ['*']), nested('dates', ['*'])])) {
				assert.ok(Buffer.isBuffer(row.bin) || row.bin instanceof Uint8Array);
				assert.deepStrictEqual([...row.bin], [1, 2, 3]);
				assert.ok(row.dates[0] instanceof Date);
				assert.strictEqual(row.dates[0].getTime(), createdAt.getTime());
			}
			for (const row of await projectBinary(['id', nested('bin', ['length', '*']), nested('dates', ['getTime', '*'])]))
				assert.deepStrictEqual(row, { id: 'a-binary', bin: { length: 3 }, dates: [{ getTime: undefined }] });
		} finally {
			await Article.delete('a-binary');
		}
	});

	it('treats a string wildcard sub-select like a wildcard list', async function () {
		assert.deepStrictEqual(await projectBothWays(['id', { name: 'meta', select: '*' }]), {
			id: 'a1',
			meta: article.meta,
		});
	});

	it('projects a wildcard alongside names on table records and relationships', async function () {
		const select = ['id', '*', nested('author', ['*'])];
		const target = new RequestTarget();
		target.id = article.id;
		target.select = select;
		const [searched] = await search(select);
		for (const row of [await Article.get(target), searched]) {
			assert.strictEqual(row.title, 'Main Article');
			assert.deepStrictEqual(row.meta, article.meta);
			assert.deepStrictEqual({ ...row.author }, { id: 'u-alice', name: 'Alice', clearance: 'public' });
		}
		const positional = ['*'];
		positional.asArray = true;
		const [record] = await projectBothWays(positional);
		assert.strictEqual(record.id, 'a1');
	});

	it('keeps a positional wildcard sub-select on plain JSON positional', async function () {
		const positional = ['*'];
		positional.asArray = true;
		assert.deepStrictEqual(await projectBothWays(['id', nested('meta', positional)]), {
			id: 'a1',
			meta: [article.meta],
		});
	});

	it('returns the whole record for a string wildcard select', async function () {
		const target = new RequestTarget();
		target.id = article.id;
		target.select = '*';
		const single = await Article.get(target);
		const [searched] = await search('*');
		for (const row of [single, searched]) {
			assert.strictEqual(row.id, 'a1');
			assert.deepStrictEqual(row.meta, article.meta);
		}
	});

	it('keeps a Date resolved from an async @computed under a sub-select', async function () {
		const row = await projectBothWays(['id', nested('asyncDate', ['x'])]);
		assert.ok(row.asyncDate instanceof Date);
		assert.strictEqual(row.asyncDate.toISOString(), '2026-01-01T00:00:00.000Z');
	});

	it('projects a mutable instance with pending changes through a wildcard and prototype-named keys', function () {
		const instance = new Article(article.id, {});
		instance.setRecord({ id: 'a1', title: 'Stored', constructor: 'stored-data' });
		instance._setChanges({ title: 'Changed' });
		instance.undeclared = 'own field';
		const projected = transformForSelect(['id', 'constructor', 'title', '*'], Article)(instance);
		assert.strictEqual(projected.title, 'Changed');
		assert.strictEqual(projected.undeclared, 'own field');
		assert.strictEqual(projected.constructor, 'stored-data');
		assert.strictEqual(projected.id, 'a1');
	});

	it('omits Object.prototype methods when projecting a mutable resource instance', async function () {
		const loadAsInstance = Article.loadAsInstance;
		Article.loadAsInstance = true;
		Article.getReturnMutable = true;
		try {
			const target = new RequestTarget();
			target.id = article.id;
			target.select = ['id', 'toString', 'constructor'];
			assert.deepStrictEqual(await Article.get(target), { id: 'a1', toString: undefined, constructor: undefined });
		} finally {
			Article.getReturnMutable = false;
			Article.loadAsInstance = loadAsInstance;
		}
	});

	it('settles async rows of a custom Resource array result', async function () {
		class AsyncRows extends Resource {
			static loadAsInstance = true;
			get() {
				return [{ label: 'first', later: Promise.resolve('resolved'), hidden: 'omit' }];
			}
		}
		const target = new RequestTarget();
		target.id = 'rows';
		target.select = ['label', 'later'];
		assert.deepStrictEqual(await AsyncRows.get(target), [{ label: 'first', later: 'resolved' }]);
	});

	it('settles async child selections and applies forceNulls after settlement in a custom Resource', async function () {
		class AsyncChildren extends Resource {
			static loadAsInstance = true;
			get() {
				return {
					children: [{ name: Promise.resolve('first') }, { name: Promise.resolve('second') }],
					missing: Promise.resolve(undefined),
				};
			}
		}
		const select = [nested('children', ['name']), 'missing'];
		select.forceNulls = true;
		const target = new RequestTarget();
		target.id = 'children';
		target.select = select;
		assert.deepStrictEqual(await AsyncChildren.get(target), {
			children: [{ name: 'first' }, { name: 'second' }],
			missing: null,
		});
	});

	it('settles async values inside positional and array projections', async function () {
		const positional = ['id', 'asyncDigest'];
		positional.asArray = true;
		assert.deepStrictEqual(await projectBothWays(positional), ['a1', 'ASYNC_DIGEST:Main Article']);
		assert.deepStrictEqual(await projectBothWays(['id', nested('asyncComputedMeta', ['publicSummary'])]), {
			id: 'a1',
			asyncComputedMeta: { publicSummary: 'ASYNC_PUBLIC:Main Article' },
		});
	});

	it('selecting __proto__ does not change the search row prototype', async function () {
		for (const select of [
			['id', '__proto__'],
			['id', nested('meta', ['note', '__proto__'])],
		]) {
			const [row] = await search(select);
			assert.strictEqual(row.id, 'a1');
			assert.strictEqual(Object.getPrototypeOf(row), Object.prototype);
			if (row.meta) assert.strictEqual(Object.getPrototypeOf(row.meta), Object.prototype);
		}
	});

	it('property resolvers do not inherit Object.prototype members', function () {
		assert.strictEqual(Object.getPrototypeOf(Article.propertyResolvers), null);
	});
});
