const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');

// Search/collection select() projects rows through Table.transformEntryForSelect, while a single-record
// get projects through Resource.transformForSelect. These cases pin the two to the same result.
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
				{ name: 'sections', elements: { type: 'Any' } },
				{ name: 'protoKeys', type: 'Any' },
				{ name: 'summary', computed: true },
				{ name: 'asyncDigest', computed: true },
				{ name: 'computedMeta', computed: true },
				{ name: 'asyncComputedMeta', computed: true },
				{ name: 'failingComputed', computed: true },
				{ name: 'thenableShapedMeta', computed: true },
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
		Article.setComputedAttribute('thenableShapedMeta', () => ({ label: 'kept', then: 'next-step', hidden: 'omit' }));
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

	it('keeps repeated selections of one relationship distinct', async function () {
		const select = [nested('author', ['id']), nested('author', ['name'])];
		select.asArray = true;
		assert.deepStrictEqual(await search(select), [[{ id: 'u-alice' }, { name: 'Alice' }]]);
	});

	it('rejects a nested selector without a select list as a client error', async function () {
		const select = ['id', { name: 'meta' }];
		await assert.rejects(search(select), { statusCode: 400 });
		const target = new RequestTarget();
		target.id = article.id;
		target.select = select;
		await assert.rejects(
			Promise.resolve().then(() => Article.get(target)),
			{ statusCode: 400 }
		);
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
