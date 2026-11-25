'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { __setEmbedFnForTest } = require('#src/resources/models/embedHook');
const { searchByValue, searchByConditions } = require('#src/dataLayer/search');
const { isReleasedTransaction, DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { searchOpening, releaseSearchOpening, SEARCH_AUTHORIZATION } = require('#src/resources/Resource');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { ClientError } = require('#src/utility/errors/hdbError');
require('#src/server/serverHelpers/serverUtilities');

const admin = { role: { permission: { super_user: true } } };

// Documents and queries embed differently, as with an asymmetric model: the query vector of a text is
// not its document vector, so a search that embedded its text as a document would rank differently.
const DOCUMENT_VECTORS = {
	apple: [1, 0, 0],
	apricot: [0.9, 0.3, 0],
	banana: [0, 1, 0],
	cherry: [0, 0, 1],
};
const LATE_DOCUMENT_VECTORS = { pear: [1, 0.2, 0] };
const QUERY_VECTORS = {
	'red fruit': [0.2, 0.1, 1],
	'orchard fruit': [1, 0.2, 0],
	'yellow fruit': [0.1, 1, 0.1],
};

function fakeEmbed() {
	const calls = [];
	let pending;
	let honorsAbort = true;
	const embed = async (input, opts) => {
		calls.push({ input, opts });
		if (pending && opts.inputType === 'query') {
			const { signal } = opts;
			await (honorsAbort && signal
				? Promise.race([
						pending,
						new Promise((_resolve, reject) => {
							if (signal.aborted) reject(signal.reason);
							signal.addEventListener('abort', () => reject(signal.reason), { once: true });
						}),
					])
				: pending);
		}
		const texts = Array.isArray(input) ? input : [input];
		return texts.map(
			(text) =>
				new Float32Array(
					(opts.inputType === 'query' ? QUERY_VECTORS : { ...DOCUMENT_VECTORS, ...LATE_DOCUMENT_VECTORS })[text] ?? [
						0, 0, 0,
					]
				)
		);
	};
	embed.calls = calls;
	embed.hold = ({ ignoreAbort = false } = {}) => {
		let release;
		honorsAbort = !ignoreAbort;
		pending = new Promise((resolve) => (release = resolve));
		return () => {
			pending = undefined;
			honorsAbort = true;
			release();
		};
	};
	return embed;
}

const queryVector = (text) => Array.from(new Float32Array(QUERY_VECTORS[text]));
// an LMDB search's transaction is not reachable from the context once its scope is released
const observesSnapshot = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

async function fromAsync(iterable) {
	const out = [];
	for await (const item of iterable) out.push(item);
	return out;
}

function recordingContext() {
	const installed = [];
	let current;
	const context = {
		installed,
		storeLinks: () =>
			installed
				.filter((txn) => !isReleasedTransaction(txn))
				.flatMap((root) => {
					const links = [];
					for (let txn = root; txn; txn = txn.next) if (txn.db) links.push(txn);
					return links;
				}),
	};
	Object.defineProperty(context, 'transaction', {
		get: () => current,
		set: (txn) => {
			current = txn;
			installed.push(txn);
		},
	});
	return context;
}

let mounts = 0;
function rest(tables) {
	const resources = new Resources();
	for (const Table of tables) resources.set(Table.tableName, Table, { rest: true });
	let handler;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false }) },
		routeFor: () => ({ urlPath: `/sort-text-${mounts++}` }),
		server: { http: (listener) => (handler = listener) },
	});
	return (method, url, data, headers = {}) => {
		const request = { method, url, user: admin, headers: new Headers(headers), data };
		request.headers.asObject = headers;
		return handler(request, () => ({ status: 404 }));
	};
}

async function bodyOf(response) {
	if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) return response.body.toString();
	if (!response.body) return '';
	const chunks = [];
	for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

function rejectsWith(promise, check) {
	return assert.rejects(promise, (error) => {
		check(error);
		return true;
	});
}

describe('Vector search by sort text on an @embed attribute', () => {
	let Doc;
	let embed;
	const queryCalls = () => embed.calls.filter((call) => call.opts.inputType === 'query');

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		embed = fakeEmbed();
		__setEmbedFnForTest(embed);
		Doc = table({
			table: 'SortTextEmbedDoc',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'content', type: 'String' },
				{ name: 'tag', indexed: true },
				{
					name: 'embedding',
					type: 'Array',
					embed: { source: 'content', model: 'doc-model' },
					indexed: { type: 'HNSW', distance: 'cosine' },
				},
				{ name: 'rawVector', type: 'Array', indexed: { type: 'HNSW' } },
			],
		});
		Doc.updatedAttributes();
		let id = 0;
		for (const content of Object.keys(DOCUMENT_VECTORS)) {
			id++;
			await Doc.put(id, { content, tag: id % 2 ? 'odd' : 'even', rawVector: DOCUMENT_VECTORS[content] });
		}
	});

	beforeEach(() => {
		embed.calls.length = 0;
	});

	after(() => {
		__setEmbedFnForTest(undefined);
	});

	it('embeds the text once, as a query, with the attribute’s @embed model', async () => {
		await fromAsync(Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, limit: 2 }));
		assert.equal(embed.calls.length, 1);
		assert.deepEqual(embed.calls[0].input, ['red fruit']);
		assert.equal(embed.calls[0].opts.model, 'doc-model');
		assert.equal(embed.calls[0].opts.inputType, 'query');
	});

	it('ranks and reports $distance exactly as the same search given the embedded vector as target', async () => {
		for (const text of Object.keys(QUERY_VECTORS)) {
			const select = ['id', 'content', '$distance'];
			const byText = await fromAsync(Doc.search({ sort: { attribute: 'embedding', text }, select, limit: 4 }));
			const byTarget = await fromAsync(
				Doc.search({ sort: { attribute: 'embedding', target: queryVector(text) }, select, limit: 4 })
			);
			assert.equal(byText.length, 4, text);
			assert.deepEqual(byText, byTarget, text);
			assert.ok(
				byText.every((row) => typeof row.$distance === 'number'),
				`${text}: every row has a $distance`
			);
		}
		assert.equal(
			(await fromAsync(Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, limit: 1 })))[0].content,
			'cherry'
		);
	});

	it('embeds text on a later sort of the chain, and batches the texts of one attribute into one call', async () => {
		const select = ['id', '$distance'];
		const byText = await fromAsync(
			Doc.search({
				conditions: [{ attribute: 'tag', value: 'odd' }],
				sort: { attribute: 'tag', next: { attribute: 'embedding', text: 'yellow fruit' } },
				select,
			})
		);
		const byTarget = await fromAsync(
			Doc.search({
				conditions: [{ attribute: 'tag', value: 'odd' }],
				sort: { attribute: 'tag', next: { attribute: 'embedding', target: queryVector('yellow fruit') } },
				select,
			})
		);
		assert.deepEqual(byText, byTarget);
		embed.calls.length = 0;
		await fromAsync(
			Doc.search({
				sort: { attribute: 'embedding', text: 'red fruit', next: { attribute: 'embedding', text: 'orchard fruit' } },
				limit: 2,
			})
		);
		assert.equal(embed.calls.length, 1);
		assert.deepEqual(embed.calls[0].input, ['red fruit', 'orchard fruit']);
	});

	it('leaves the caller’s query and sort objects untouched', async () => {
		const next = Object.freeze({ attribute: 'id' });
		const sort = Object.freeze({ attribute: 'embedding', text: 'red fruit', next });
		const query = { sort, limit: 2 };
		await fromAsync(Doc.search(query));
		assert.equal(query.sort, sort);
		assert.deepEqual(sort, { attribute: 'embedding', text: 'red fruit', next: { attribute: 'id' } });
	});

	describe('refused descriptors', () => {
		const refused = [
			['text and target together', { text: 'red fruit', target: [1, 0, 0] }, /text or a target, not both/],
			['an empty text', { text: '  ' }, /must be a non-empty string/],
			['a non-string text', { text: 42 }, /must be a non-empty string/],
			['a model override', { text: 'red fruit', model: 'other-model' }, /can not set a model/],
			['an unknown distance', { text: 'red fruit', distance: 'manhattan' }, /Unknown distance function/],
		];
		for (const [label, descriptor, message] of refused) {
			it(`refuses ${label} with a 400 and never calls the model`, () => {
				assert.throws(
					() => Doc.search({ sort: { attribute: 'embedding', ...descriptor } }),
					(error) => error.statusCode === 400 && message.test(error.message)
				);
				assert.equal(embed.calls.length, 0);
			});
		}

		it('refuses an HNSW attribute without @embed, naming it', () => {
			assert.throws(
				() => Doc.search({ sort: { attribute: 'rawVector', text: 'red fruit' } }),
				(error) => error.statusCode === 400 && /"rawVector" is not one/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('accepts the attribute as a one-element path', async () => {
			const rows = await fromAsync(
				Doc.search({ sort: { attribute: ['embedding'], text: 'red fruit' }, select: ['content'], limit: 1 })
			);
			assert.deepEqual(rows, [{ content: 'cherry' }]);
		});

		it('refuses text beside a full-text condition before it calls the model', function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip(); // full-text indexes need RocksDB
			const Article = table({
				table: 'SortTextFullTextDoc',
				database: 'test',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{
						name: 'embedding',
						type: 'Array',
						embed: { source: 'title', model: 'doc-model' },
						indexed: { type: 'HNSW' },
					},
				],
				fullTextIndexes: [{ name: 'search', fields: [{ name: 'title', weight: 1 }], analyzer: 'english@2' }],
			});
			const fullText = { attribute: 'search', comparator: 'matches', value: 'fruit' };
			for (const conditions of [[fullText], fullText])
				assert.throws(
					() => Article.search({ conditions, sort: { attribute: 'embedding', text: 'red fruit' } }),
					(error) => error.statusCode === 400 && /descending \$score order/.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses an invalid condition before it calls the model', () => {
			assert.throws(
				() =>
					Doc.search({
						conditions: [{ attribute: 'nope', value: 1 }],
						sort: { attribute: 'embedding', text: 'red fruit' },
					}),
				(error) => error.statusCode === 404 && /nope is not a defined attribute/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('prepares the conditions as the search does, with the id prefix', async () => {
			const query = (sort) =>
				// a search with an id resolves that resource first, which a cold read answers with a Promise
				(async () =>
					fromAsync(
						await Doc.search({
							id: 1,
							operator: 'or',
							conditions: [{ attribute: 'tag', value: 'even' }],
							sort,
							select: ['id'],
						})
					))().then(
					(rows) => ({ rows }),
					(error) => ({ error: error.message })
				);
			const byTarget = await query({ attribute: 'embedding', target: queryVector('red fruit') });
			assert.deepEqual(await query({ attribute: 'embedding', text: 'red fruit' }), byTarget);
		});

		it('refuses an undefined or missing sort head ahead of a text sort before it calls the model', () => {
			const next = { attribute: 'embedding', text: 'red fruit' };
			assert.throws(
				() => Doc.search({ sort: { attribute: 'nope', next } }),
				(error) => error.statusCode === 404 && /nope is not a defined attribute/.test(error.message)
			);
			assert.throws(() => Doc.search({ sort: { next } }), /Sort requires an attribute/);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses an unindexed sort head with nothing else to lead before it calls the model, as for a target', () => {
			for (const next of [
				{ attribute: 'embedding', text: 'red fruit' },
				{ attribute: 'embedding', target: queryVector('red fruit') },
			])
				assert.throws(
					() => Doc.search({ sort: { attribute: 'content', next } }),
					(error) => error.statusCode === 404 && /content is not indexed/.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses a vector clause without a target ahead of a text clause before it calls the model', () => {
			for (const attribute of ['embedding', ['embedding']])
				assert.throws(
					() => Doc.search({ sort: { attribute, next: { attribute: 'embedding', text: 'red fruit' } } }),
					(error) => error.statusCode === 400 && /target vector must be provided/.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses a text sort beside a condition on its attribute, which would order the search instead', () => {
			const threshold = { attribute: 'embedding', comparator: 'lt', value: 2, target: [1, 0, 0] };
			function* once() {
				yield threshold;
			}
			const sort = { attribute: 'embedding', text: 'red fruit' };
			for (const target of [
				{ conditions: [threshold], sort },
				{ conditions: once(), sort },
				Object.freeze({ conditions: once(), sort }),
			])
				assert.throws(
					() => new Doc(null, {}).search(target),
					(error) =>
						error.statusCode === 400 && /can not be combined with a condition on "embedding"/.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
		});

		it('searches by the one-shot conditions the preflight read', async () => {
			function* odd() {
				yield { attribute: 'tag', value: 'odd' };
			}
			const rows = await fromAsync(
				Doc.search({ conditions: odd(), sort: { attribute: 'embedding', text: 'red fruit' }, select: ['id'] })
			);
			assert.deepEqual(rows.map((row) => row.id).sort(), [1, 3]);
		});

		it('leaves a sort chain without text, and its one-shot conditions, to the search as before', async () => {
			function* odd() {
				yield { attribute: 'tag', value: 'odd' };
			}
			const target = { sort: { attribute: 'tag', next: { attribute: 'id' } }, select: ['id'] };
			Object.defineProperty(target, 'conditions', { value: odd(), enumerable: true });
			assert.deepEqual(await fromAsync(Doc.search(target)), [{ id: 1 }, { id: 3 }]);
		});

		it('on a sealed table, refuses an undefined later sort level before it calls the model', () => {
			const Sealed = table({
				table: 'SortTextSealedDoc',
				database: 'test',
				sealed: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'content', type: 'String' },
					{
						name: 'embedding',
						type: 'Array',
						embed: { source: 'content', model: 'doc-model' },
						indexed: { type: 'HNSW' },
					},
				],
			});
			assert.throws(
				() => Sealed.search({ sort: { attribute: 'embedding', text: 'red fruit', next: { attribute: 'nope' } } }),
				(error) => error.statusCode === 404 && /nope is not a defined attribute/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('beside a filter that drives no index, refuses what the leading index refuses', async () => {
			const sort = { attribute: 'embedding', text: 'red fruit', descending: true };
			await assert.rejects(
				async () =>
					fromAsync(Doc.search({ conditions: [{ attribute: 'content', comparator: 'contains', value: 'a' }], sort })),
				(error) => error.statusCode === 400 && /descending sort order with HNSW/.test(error.message)
			);
			const rows = await fromAsync(
				Doc.search({ conditions: [{ attribute: 'tag', value: 'odd' }], sort, select: ['id'] })
			);
			assert.equal(rows.length, 2);
		});

		it('leaves a descending sort to the in-memory order when a filter on its attribute takes the lead', async () => {
			const search = (next) =>
				fromAsync(
					Doc.search({
						conditions: [{ attribute: 'embedding', comparator: 'ne', value: [9, 9, 9] }],
						allowFullScan: true,
						sort: { attribute: 'embedding', target: queryVector('red fruit'), descending: true, next },
						select: ['id'],
					})
				);
			const ids = (rows) => rows.map((row) => row.id);
			assert.deepEqual(
				ids(await search({ attribute: 'embedding', text: 'orchard fruit' })),
				ids(await search({ attribute: 'embedding', target: queryVector('orchard fruit') }))
			);
		});

		it('refuses a sort with more texts than one search embeds, before it calls the model', () => {
			let sort;
			for (let i = 0; i < 9; i++) sort = { attribute: 'embedding', text: 'red fruit', next: sort };
			assert.throws(
				() => Doc.search({ sort }),
				(error) => error.statusCode === 400 && /at most 8 texts/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses an unknown attribute with a 404', () => {
			assert.throws(
				() => Doc.search({ sort: { attribute: 'nope', text: 'red fruit' } }),
				(error) => error.statusCode === 404 && /nope is not a defined attribute/.test(error.message)
			);
		});

		it('validates every sort of the chain before it calls the model', () => {
			assert.throws(
				() =>
					Doc.search({
						sort: { attribute: 'embedding', text: 'red fruit', next: { attribute: 'rawVector', text: 'x' } },
					}),
				/"rawVector" is not one/
			);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses an @embed attribute without a vector index, naming it', () => {
			const Unindexed = table({
				table: 'SortTextUnindexedDoc',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'content', type: 'String' },
					{ name: 'embedding', type: 'Array', embed: { source: 'content', model: 'doc-model' } },
				],
			});
			assert.throws(
				() => Unindexed.search({ sort: { attribute: 'embedding', text: 'red fruit' } }),
				(error) => error.statusCode === 400 && /vector index, and "embedding" has none/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('with no condition, refuses what the leading index refuses before it calls the model', () => {
			assert.throws(
				() => Doc.search({ sort: { attribute: 'embedding', text: 'red fruit', descending: true } }),
				(error) => error.statusCode === 400 && /descending sort order with HNSW/.test(error.message)
			);
			assert.equal(embed.calls.length, 0);
		});

		it('with no condition, refuses what a nativePlane index refuses before it calls the model', function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip(); // the native plane needs RocksDB
			const Native = table({
				table: 'SortTextNativePlaneDoc',
				database: 'test',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'content', type: 'String' },
					{
						name: 'embedding',
						type: 'Array',
						embed: { source: 'content', model: 'doc-model' },
						indexed: { type: 'HNSW', nativePlane: true },
					},
				],
			});
			for (const [options, message] of [
				[{ distance: 'euclidean' }, /only supports its configured cosine distance/],
				[{ distance: 'dotProduct' }, /only supports its configured cosine distance/],
				[{ waitForIndexMilliseconds: 30001 }, /waitForIndexMilliseconds must be a finite number/],
				[{ maxIndexLagMilliseconds: -1 }, /maxIndexLagMilliseconds must be a finite nonnegative number/],
			])
				assert.throws(
					() => Native.search({ sort: { attribute: 'embedding', text: 'red fruit', ...options } }),
					(error) => error.statusCode === 400 && message.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
		});

		it('refuses text in the sort of a relationship in the select, which a target sorts', async () => {
			const Shelf = table({
				table: 'SortTextShelf',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'docIds', indexed: true, elements: { type: 'ID' } },
					{
						name: 'docs',
						elements: { type: 'SortTextEmbedDoc', definition: { tableClass: Doc } },
						relationship: { from: 'docIds' },
					},
				],
			});
			await Shelf.put({ id: 'shelf', docIds: [1, 2, 3, 4] });
			const select = (sort) => ['id', { name: 'docs', select: ['content'], sort }];
			for (const search of [
				() => Shelf.search({ select: select({ attribute: 'embedding', text: 'red fruit' }) }),
				() =>
					Shelf.get({
						id: 'shelf',
						select: select({ attribute: 'content', next: { attribute: 'embedding', text: 'red fruit' } }),
					}),
			])
				// a get on LMDB answers asynchronously, so its refusal is a rejection
				await assert.rejects(
					async () => search(),
					(error) => error.statusCode === 400 && /select of "docs" can not sort by text/.test(error.message)
				);
			assert.equal(embed.calls.length, 0);
			const [shelf] = await fromAsync(
				Shelf.search({ select: select({ attribute: 'embedding', target: queryVector('red fruit') }) })
			);
			assert.equal(shelf.docs[0].content, 'cherry');
		});
	});

	describe('model failures', () => {
		let failure;
		beforeEach(() => {
			failure = undefined;
		});
		const failingEmbed = (input, opts) => {
			if (opts.inputType !== 'query') return embed(input, opts);
			embed.calls.push({ input, opts });
			return Promise.reject(failure);
		};
		before(() => __setEmbedFnForTest(failingEmbed));
		after(() => __setEmbedFnForTest(embed));

		it('surfaces a model error as a 502 with the model error as its cause', async () => {
			failure = Object.assign(new Error('upstream said: key sk-live-123 is invalid'), {
				name: 'OpenAIBackendError',
				upstreamStatus: 401,
			});
			await rejectsWith(fromAsync(Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } })), (error) => {
				assert.equal(error.statusCode, 502);
				assert.equal(error.cause, failure);
				assert.doesNotMatch(JSON.stringify(error), /sk-live/, 'serializing the error leaves the backend error out');
				assert.match(error.message, /sort text embedding for attribute "embedding" \[OpenAIBackendError\]/);
				assert.match(error.message, /backend HTTP 401/);
				assert.doesNotMatch(error.message, /sk-live|target vector/);
			});
		});

		it('reports a text too long for the model as a 400', async () => {
			failure = Object.assign(new Error('maximum context length exceeded'), { contextWindowExceeded: true });
			await rejectsWith(fromAsync(Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } })), (error) => {
				assert.equal(error.statusCode, 400);
				assert.equal(error.cause, failure);
				assert.match(error.message, /too long for model "doc-model"/);
			});
		});

		it('reports a model that returns no vector as a 502', async () => {
			__setEmbedFnForTest(async (input, opts) => (opts.inputType === 'query' ? [] : embed(input, opts)));
			try {
				await rejectsWith(fromAsync(Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } })), (error) => {
					assert.equal(error.statusCode, 502);
					assert.match(error.message, /returned no embedding/);
				});
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		it('lets no rejection escape from a failed search that is never iterated', async () => {
			failure = new Error('backend down');
			const escaped = [];
			const onUnhandled = (reason) => escaped.push(reason);
			process.on('unhandledRejection', onUnhandled);
			try {
				Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } });
				await waitFor(() => queryCalls().length === 1);
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.deepEqual(
					escaped.filter((reason) => reason === failure || reason?.cause === failure),
					[]
				);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('fails search_by_conditions itself, before it returns rows to stream', async () => {
			failure = new Error('backend down');
			await rejectsWith(
				searchByConditions({
					operation: 'search_by_conditions',
					database: 'test',
					table: 'SortTextEmbedDoc',
					conditions: [{ attribute: 'tag', comparator: 'equals', value: 'even' }],
					sort: { attribute: 'embedding', text: 'red fruit' },
					get_attributes: ['content'],
				}),
				(error) => assert.equal(error.statusCode, 502)
			);
		});

		it('answers a REST QUERY with the failure as its status, in every streamed format', async () => {
			failure = new Error('backend down');
			const request = rest([Doc]);
			for (const accept of ['application/json', 'application/x-ndjson', 'text/csv', 'application/cbor']) {
				const response = await request(
					'QUERY',
					'/SortTextEmbedDoc/',
					{ sort: { attribute: 'embedding', text: 'red fruit' }, select: ['content'] },
					{ accept }
				).catch((error) => error);
				assert.equal(response.statusCode ?? response.status, 502, accept);
			}
		});

		it('answers a REST GET with the failure as its status when a resource maps a search behind an async allowRead', async () => {
			failure = new Error('backend down');
			for (const freeze of [false, true]) {
				class GatedMappedDoc extends Doc {
					static loadAsInstance = false;
					async allowRead() {
						await new Promise((resolve) => setImmediate(resolve));
						return true;
					}
					get(target) {
						target.sort = { attribute: 'embedding', text: 'red fruit' };
						const mapped = this.search(target).map((row) => row);
						return freeze ? Object.freeze(mapped) : mapped;
					}
				}
				const response = await rest([GatedMappedDoc])('GET', '/SortTextEmbedDoc/', undefined, {
					accept: 'application/json',
				}).catch((error) => error);
				assert.equal(response.statusCode ?? response.status, 502, freeze ? 'frozen' : 'extensible');
			}
		});

		it('leaves the status of a write that answers with a text search alone', async () => {
			failure = new Error('backend down');
			class SearchingPostDoc extends Doc {
				async post() {
					await Doc.put(99, { content: 'pear' });
					return this.search({ sort: { attribute: 'embedding', text: 'red fruit' } });
				}
			}
			const response = await rest([SearchingPostDoc])(
				'POST',
				'/SortTextEmbedDoc/',
				{},
				{ accept: 'application/json' }
			).catch((error) => error);
			try {
				assert.equal(response.status ?? 200, 200);
				await assert.rejects(bodyOf(response));
				assert.equal((await Doc.get(99))?.content, 'pear');
			} finally {
				await Doc.delete(99);
			}
		});

		it('answers a REST QUERY with the failure of either search a table concatenates', async () => {
			__setEmbedFnForTest((input, opts) =>
				opts.inputType === 'query' && input.includes('unlucky')
					? Promise.reject(new Error('backend down'))
					: embed(input, opts)
			);
			try {
				class TwoSearches extends Doc {
					search(target) {
						const first = super.search({ ...target, sort: { attribute: 'embedding', text: 'red fruit' } });
						return first.concat(super.search({ ...target, sort: { attribute: 'embedding', text: 'unlucky' } }));
					}
				}
				const response = await rest([TwoSearches])(
					'QUERY',
					'/SortTextEmbedDoc/',
					{ select: ['content'] },
					{ accept: 'application/json' }
				).catch((error) => error);
				assert.equal(response.statusCode ?? response.status, 502);
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		for (const [side, join] of [
			['first', (opened, failed) => opened.concat(failed)],
			['second', (opened, failed) => failed.concat(opened)],
		])
			it(`a caller that answers a failed concatenation releases the search that opened ${side}`, async () => {
				__setEmbedFnForTest((input, opts) =>
					opts.inputType === 'query' && input.includes('unlucky')
						? Promise.reject(new Error('backend down'))
						: embed(input, opts)
				);
				try {
					const context = recordingContext();
					const opened = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
					await searchOpening(opened);
					if (observesSnapshot) assert.ok(context.storeLinks().some((txn) => txn.readTxnsUsed > 0));
					const failed = Doc.search({ sort: { attribute: 'embedding', text: 'unlucky' } }, {});
					const opening = searchOpening(join(opened, failed).map((row) => row));
					await assert.rejects(opening, (error) => error.statusCode === 502);
					releaseSearchOpening(opening);
					await waitFor(() => context.storeLinks().every((txn) => !txn.readTxnsUsed), {
						message: 'the opened search kept its snapshot',
					});
				} finally {
					__setEmbedFnForTest(failingEmbed);
				}
			});

		it('releasing a failed concatenation reaches each search it joined, text or ordinary', async () => {
			__setEmbedFnForTest((input, opts) =>
				opts.inputType === 'query' && input.includes('unlucky')
					? Promise.reject(new Error('backend down'))
					: embed(input, opts)
			);
			try {
				const context = recordingContext();
				const opened = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
				await searchOpening(opened);
				const plain = Doc.search({ conditions: [{ attribute: 'tag', value: 'odd' }] }, context);
				let plainClosed = false;
				const close = plain.onDone;
				plain.onDone = function () {
					plainClosed = true;
					return close.call(this);
				};
				const failed = Doc.search({ sort: { attribute: 'embedding', text: 'unlucky' } }, {});
				const opening = searchOpening(opened.concat(failed).concat(plain));
				await assert.rejects(opening, (error) => error.statusCode === 502);
				releaseSearchOpening(opening);
				assert.ok(plainClosed, 'the ordinary search kept its snapshot');
				if (observesSnapshot)
					await waitFor(() => context.storeLinks().every((txn) => !txn.readTxnsUsed), {
						message: 'the opened text search kept its snapshot',
					});
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		it('releasing a failed concatenation reaches its first search however long the chain', async () => {
			if (!observesSnapshot) return;
			__setEmbedFnForTest((input, opts) =>
				opts.inputType === 'query' && input.includes('unlucky')
					? Promise.reject(new Error('backend down'))
					: embed(input, opts)
			);
			try {
				const ready = Doc.search({ sort: { attribute: 'embedding', text: 'orchard fruit' } }, {});
				for (const grow of [(chain) => chain.concat([]), (chain) => ready.map((row) => row).concat(chain)]) {
					const context = recordingContext();
					const opened = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
					await searchOpening(opened);
					assert.ok(context.storeLinks().some((txn) => txn.readTxnsUsed > 0));
					let chain = opened.concat(Doc.search({ sort: { attribute: 'embedding', text: 'unlucky' } }, {}));
					for (let i = 0; i < 10_000; i++) chain = grow(chain);
					const opening = searchOpening(chain);
					await assert.rejects(opening, (error) => error.statusCode === 502);
					releaseSearchOpening(opening);
					await waitFor(() => context.storeLinks().every((txn) => !txn.readTxnsUsed), {
						message: 'the opened text search kept its snapshot',
					});
				}
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		it('releasing a failed concatenation reused on both sides closes each search once', async () => {
			__setEmbedFnForTest((input, opts) =>
				opts.inputType === 'query' && input.includes('unlucky')
					? Promise.reject(new Error('backend down'))
					: embed(input, opts)
			);
			try {
				let closes = 0;
				let releases = 0;
				const shared = { onDone: () => closes++, [Symbol.asyncIterator]: () => [][Symbol.iterator]() };
				const failing = Doc.search({ sort: { attribute: 'embedding', text: 'unlucky' } }, {});
				const base = searchOpening(failing);
				const release = base.release;
				base.release = () => {
					releases++;
					return release();
				};
				const other = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, {});
				let chain = failing
					.concat(shared)
					.map((row) => row)
					.concat(other.map((row) => row).concat(shared));
				for (let level = 0; level < 12; level++)
					chain = chain.map((row) => row).concat(other.map((row) => row).concat(chain));
				const opening = searchOpening(chain);
				await assert.rejects(opening, (error) => error.statusCode === 502);
				releaseSearchOpening(opening);
				assert.equal(closes, 1);
				assert.equal(releases, 1);
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		it('releasing a failed opening logs a release that rejects instead of letting it escape', async () => {
			const failure = new Error('release failed');
			const escaped = [];
			const onUnhandled = (reason) => {
				if (reason === failure) escaped.push(reason);
			};
			const opening = Promise.reject(new ClientError('backend down', 502));
			opening.release = async () => {
				throw failure;
			};
			process.on('unhandledRejection', onUnhandled);
			try {
				await assert.rejects(opening, (error) => error.statusCode === 502);
				releaseSearchOpening(opening);
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.deepEqual(escaped, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		for (const database of ['its own', 'another'])
			it(`answers a failed text search with its status and releases a search on ${database} database concatenated beside it`, async () => {
				if (!observesSnapshot) return;
				const Other =
					database === 'another' &&
					table({
						table: 'SortTextOtherPlain',
						database: 'sort_text_other',
						attributes: [
							{ name: 'id', isPrimaryKey: true },
							{ name: 'tag', indexed: true },
						],
					});
				if (Other) await Other.put(1, { tag: 'odd' });
				__setEmbedFnForTest((input, opts) =>
					opts.inputType === 'query' && input.includes('unlucky')
						? Promise.reject(new Error('backend down'))
						: embed(input, opts)
				);
				let plainClosed = false;
				let transaction;
				try {
					class TextThenPlain extends Doc {
						search(target) {
							const conditions = [{ attribute: 'tag', value: 'odd' }];
							const plain = Other
								? Other.search({ conditions }, this.getContext())
								: super.search({ ...target, conditions });
							const close = plain.onDone;
							plain.onDone = function () {
								plainClosed = true;
								return close.call(this);
							};
							transaction = this.getContext().transaction;
							return super.search({ ...target, sort: { attribute: 'embedding', text: 'unlucky' } }).concat(plain);
						}
					}
					const response = await rest([TextThenPlain])(
						'QUERY',
						'/SortTextEmbedDoc/',
						{ select: ['content'] },
						{ accept: 'application/json' }
					).catch((error) => error);
					assert.equal(response.statusCode ?? response.status, 502);
					assert.ok(plainClosed, 'the concatenated search kept its snapshot');
					for (let link = transaction; link; link = link.next) assert.equal(link.readTxnsUsed, 0);
				} finally {
					__setEmbedFnForTest(failingEmbed);
				}
			});

		it('a direct reader of a concatenation reads the search that opens though the other failed first', async () => {
			const firstModel = Promise.withResolvers();
			__setEmbedFnForTest((input, opts) => {
				if (opts.inputType !== 'query') return embed(input, opts);
				if (input.includes('unlucky')) return Promise.reject(new Error('backend down'));
				return firstModel.promise.then(() => embed(input, opts));
			});
			try {
				const failed = Doc.search({ sort: { attribute: 'embedding', text: 'unlucky' } });
				const joined = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, select: ['content'] }).concat(
					failed
				);
				await assert.rejects(searchOpening(joined), (error) => error.statusCode === 502);
				firstModel.resolve();
				const rows = [];
				await assert.rejects(
					async () => {
						for await (const row of joined) rows.push(row);
					},
					(error) => error.statusCode === 502
				);
				assert.ok(rows.length > 0, 'the first search was discarded');
			} finally {
				__setEmbedFnForTest(failingEmbed);
			}
		});

		it('answers a REST QUERY with the failure as its status when the table maps its search', async () => {
			failure = new Error('backend down');
			class MappedDoc extends Doc {
				search(target) {
					return super.search(target).map((row) => row);
				}
			}
			const response = await rest([MappedDoc])(
				'QUERY',
				'/SortTextEmbedDoc/',
				{ sort: { attribute: 'embedding', text: 'red fruit' }, select: ['content'] },
				{ accept: 'application/json' }
			).catch((error) => error);
			assert.equal(response.statusCode ?? response.status, 502);
		});
	});

	describe('authorization comes before the model call', () => {
		it('a synchronously denied read never calls the model', () => {
			class Denied extends Doc {
				allowRead() {
					return false;
				}
			}
			assert.throws(
				() =>
					Denied.search(
						{ sort: { attribute: 'embedding', text: 'red fruit' }, checkPermission: true },
						{ user: { username: 'reader' } }
					),
				(error) => error.statusCode === 403 || error.statusCode === 401
			);
			assert.equal(embed.calls.length, 0);
		});

		it('an asynchronously denied read never calls the model', async () => {
			class Denied extends Doc {
				async allowRead() {
					return false;
				}
			}
			await assert.rejects(
				async () =>
					fromAsync(
						await Denied.search(
							{ sort: { attribute: 'embedding', text: 'red fruit' }, checkPermission: true },
							{ user: { username: 'reader' } }
						)
					),
				(error) => error.statusCode === 403 || error.statusCode === 401
			);
			assert.equal(embed.calls.length, 0);
		});

		it('a gate closed before its verdict never calls the model', async () => {
			const verdict = Promise.withResolvers();
			class Pending extends Doc {
				allowRead() {
					return verdict.promise;
				}
			}
			const iterator = new Pending(null, { user: { username: 'reader' } })
				.search({ sort: { attribute: 'embedding', text: 'red fruit' }, checkPermission: true })
				[Symbol.asyncIterator]();
			await iterator.return();
			verdict.resolve(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(embed.calls.length, 0);
		});

		for (const [shape, project] of [
			['', (results) => results],
			[' and mapped', (results) => results.map((row) => row)],
			[' behind iterate()', (results) => ({ iterate: (options) => results.iterate(options) })],
		]) {
			it(`a gate closed while its granted search${shape} is handed over releases that search`, async () => {
				if (!observesSnapshot) return;
				let close;
				class Racing extends Doc {
					async allowRead() {
						return true;
					}
					search(target) {
						if (target.checkPermission === false && close) {
							const closeNow = close;
							close = undefined;
							closeNow();
						}
						return target.checkPermission === false ? project(super.search(target)) : super.search(target);
					}
				}
				const transaction = new DatabaseTransaction();
				try {
					const iterator = new Racing(null, { transaction, user: { username: 'reader' } })
						.search({ conditions: [{ attribute: 'tag', value: 'odd' }], checkPermission: true })
						[Symbol.asyncIterator]();
					close = () => iterator.return();
					await waitFor(() => transaction.readTxnsUsed === 1, {
						message: () => `read snapshot still held (${transaction.readTxnsUsed})`,
					});
				} finally {
					transaction.abort();
				}
			});

			it(`a search the gate granted${shape}, closed before its first step, releases its snapshot`, async () => {
				// this reads the root transaction's count; an LMDB search counts its snapshot on the linked one it reads through
				if (!observesSnapshot) return;
				class Granted extends Doc {
					async allowRead() {
						return true;
					}
					search(target) {
						return target.checkPermission === false ? project(super.search(target)) : super.search(target);
					}
				}
				const transaction = new DatabaseTransaction();
				try {
					const iterator = new Granted(null, { transaction, user: { username: 'reader' } })
						.search({ conditions: [{ attribute: 'tag', value: 'odd' }], checkPermission: true })
						[Symbol.asyncIterator]();
					await waitFor(() => transaction.readTxnsUsed > 1);
					const held = transaction.readTxnsUsed;
					await iterator.return();
					await waitFor(() => transaction.readTxnsUsed === held - 1, {
						message: () => `read snapshot still held (${transaction.readTxnsUsed} of ${held})`,
					});
				} finally {
					transaction.abort();
				}
			});
			it(`a search the gate granted${shape}, read to its end, releases its snapshot and keeps it released`, async () => {
				if (!observesSnapshot) return;
				class Granted extends Doc {
					async allowRead() {
						return true;
					}
					search(target) {
						return target.checkPermission === false ? project(super.search(target)) : super.search(target);
					}
				}
				const transaction = new DatabaseTransaction();
				try {
					const rows = await fromAsync(
						new Granted(null, { transaction, user: { username: 'reader' } }).search({
							conditions: [{ attribute: 'tag', value: 'odd' }],
							checkPermission: true,
						})
					);
					assert.ok(rows.length > 0);
					await waitFor(() => transaction.readTxnsUsed === 1, {
						message: () => `read snapshot still held (${transaction.readTxnsUsed})`,
					});
					await new Promise((resolve) => setTimeout(resolve, 20));
					assert.equal(transaction.readTxnsUsed, 1);
				} finally {
					transaction.abort();
				}
			});
		}

		it('a gate closed before its first step releases both text searches its override concatenates', async () => {
			if (!observesSnapshot) return;
			const release = embed.hold();
			class Joined extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					if (target.checkPermission !== false) return super.search(target);
					const first = super.search({ ...target, sort: { attribute: 'embedding', text: 'red fruit' } });
					return first.concat(super.search({ ...target, sort: { attribute: 'embedding', text: 'yellow fruit' } }));
				}
			}
			const transaction = new DatabaseTransaction();
			try {
				const iterator = new Joined(null, { transaction, user: { username: 'reader' } })
					.search({ conditions: [{ attribute: 'tag', value: 'odd' }], checkPermission: true })
					[Symbol.asyncIterator]();
				await waitFor(() => embed.calls.length === 2);
				await iterator.return();
				const held = transaction.readTxnsUsed;
				release();
				await new Promise((resolve) => setTimeout(resolve, 30));
				assert.equal(transaction.readTxnsUsed, held, 'a search opened after the gate closed');
			} finally {
				release();
				transaction.abort();
			}
		});

		it('a gate closed after its reader took a row closes that cursor and asks for no other', async () => {
			if (!observesSnapshot) return;
			let cursors = 0;
			class OneCursor extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					if (target.checkPermission !== false) return super.search(target);
					const results = super.search(target);
					return {
						[Symbol.asyncIterator]() {
							if (cursors++) throw new Error('one cursor only');
							return results[Symbol.asyncIterator]();
						},
					};
				}
			}
			const transaction = new DatabaseTransaction();
			try {
				const gated = new OneCursor(null, { transaction, user: { username: 'reader' } }).search({
					conditions: [{ attribute: 'tag', value: 'odd' }],
					checkPermission: true,
				});
				const iterator = gated[Symbol.asyncIterator]();
				assert.ok((await iterator.next()).value);
				gated.onDone();
				await iterator.return();
				await waitFor(() => transaction.readTxnsUsed === 1, {
					message: () => `read snapshot still held (${transaction.readTxnsUsed})`,
				});
				assert.equal(cursors, 1);
			} finally {
				transaction.abort();
			}
		});

		it('a reader that starts after the gate closed reads nothing, and a factory that closes it is not asked twice', async () => {
			if (!observesSnapshot) return;
			let cursors = 0;
			let gated;
			class Closing extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					if (target.checkPermission !== false) return super.search(target);
					const results = super.search(target);
					return {
						[Symbol.asyncIterator]() {
							cursors++;
							gated.onDone?.();
							return results[Symbol.asyncIterator]();
						},
					};
				}
			}
			const transaction = new DatabaseTransaction();
			const target = () => ({ conditions: [{ attribute: 'tag', value: 'odd' }], checkPermission: true });
			try {
				gated = new Closing(null, { transaction, user: { username: 'reader' } }).search(target());
				const iterator = gated[Symbol.asyncIterator]();
				assert.ok((await iterator.next()).value);
				await iterator.return();
				assert.equal(cursors, 1);
				await waitFor(() => transaction.readTxnsUsed === 1, {
					message: () => `read snapshot still held (${transaction.readTxnsUsed})`,
				});
				gated = new Closing(null, { transaction, user: { username: 'reader' } }).search(target());
				await gated[SEARCH_AUTHORIZATION];
				gated.onDone();
				assert.equal(cursors, 2);
				assert.deepEqual(await fromAsync(gated), []);
				assert.equal(cursors, 2);
				assert.equal(transaction.readTxnsUsed, 1);
			} finally {
				transaction.abort();
			}
		});

		describe('a granted result whose cursor is being opened', () => {
			let disposed, factories, factory, withDisposer, Wrapped;
			before(() => {
				Wrapped = class extends Doc {
					async allowRead() {
						return true;
					}
					search(target) {
						if (target.checkPermission !== false) return super.search(target);
						const results = super.search(target);
						const wrapper = {
							[Symbol.asyncIterator]() {
								factories++;
								return factory(results);
							},
						};
						if (withDisposer)
							wrapper.onDone = () => {
								disposed++;
								results.onDone?.();
							};
						return wrapper;
					}
				};
			});
			const open = async (transaction, { withoutDisposer = false } = {}) => {
				withDisposer = !withoutDisposer;
				disposed = 0;
				factories = 0;
				const gated = new Wrapped(null, { transaction, user: { username: 'reader' } }).search({
					conditions: [{ attribute: 'tag', value: 'odd' }],
					checkPermission: true,
				});
				await gated[SEARCH_AUTHORIZATION];
				return gated;
			};

			it('is never both disposed and read when the gate closes in between', async () => {
				factory = (results) => results[Symbol.asyncIterator]();
				const gated = await open();
				const iterator = gated[Symbol.asyncIterator]();
				const step = iterator.next();
				queueMicrotask(() => gated.onDone());
				const result = await step;
				await iterator.return();
				assert.ok(!(disposed && factories), `disposed ${disposed}, factories ${factories}`);
				assert.ok(!(disposed && !result.done), 'read a row from a disposed result');
			});

			it('fails, and is disposed, when its factory returns no iterator', async () => {
				factory = () => undefined;
				const gated = await open();
				await assert.rejects(fromAsync(gated), /returned no iterator/);
				assert.equal(disposed, 1);
			});

			it('is disposed when its factory throws', async () => {
				factory = () => {
					throw new Error('no cursor');
				};
				const gated = await open();
				await assert.rejects(fromAsync(gated), /no cursor/);
				assert.equal(disposed, 1);
			});

			it('without a disposer, is not asked for a cursor again after its factory throws', async () => {
				if (!observesSnapshot) return;
				factory = () => {
					throw new Error('no cursor');
				};
				const transaction = new DatabaseTransaction();
				try {
					const gated = await open(transaction, { withoutDisposer: true });
					await assert.rejects(fromAsync(gated), /no cursor/);
					assert.equal(factories, 1);
				} finally {
					transaction.abort();
				}
			});

			it('is disposed when its factory closes the gate and then throws', async () => {
				let gated;
				factory = () => {
					gated.onDone();
					throw new Error('no cursor');
				};
				gated = await open();
				await assert.rejects(fromAsync(gated), /no cursor/);
				assert.equal(disposed, 1);
			});

			it('is disposed when its factory returns the reader and hands over a cursor that can not close', async () => {
				let reader;
				factory = () => {
					reader.return();
					return { next: () => Promise.resolve({ value: undefined, done: true }) };
				};
				const gated = await open();
				reader = gated[Symbol.asyncIterator]();
				assert.equal((await reader.next()).done, true);
				assert.equal(disposed, 1);
			});

			it('closes the cursor a factory hands over after returning the reader', async () => {
				if (!observesSnapshot) return;
				let reader;
				factory = (results) => {
					reader.return();
					return results[Symbol.asyncIterator]();
				};
				const transaction = new DatabaseTransaction();
				try {
					const gated = await open(transaction);
					reader = gated[Symbol.asyncIterator]();
					assert.equal((await reader.next()).done, true);
					await waitFor(() => transaction.readTxnsUsed === 1, {
						message: () => `read snapshot still held (${transaction.readTxnsUsed})`,
					});
				} finally {
					transaction.abort();
				}
			});
		});

		it('a gated result that can be read again is read again after its first reader finishes', async () => {
			class Replayable extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					if (target.checkPermission !== false) return super.search(target);
					return [{ id: 1 }, { id: 2 }];
				}
			}
			const gated = new Replayable(null, { user: { username: 'reader' } }).search({ checkPermission: true });
			const first = await fromAsync(gated);
			assert.deepEqual(first, [{ id: 1 }, { id: 2 }]);
			assert.deepEqual(await fromAsync(gated), first);
		});

		it('a gate closed before its first step logs a cleanup that rejects instead of letting it escape', async () => {
			const failure = new Error('cursor close failed');
			const escaped = [];
			const onUnhandled = (reason) => {
				if (reason === failure) escaped.push(reason);
			};
			let searched = false;
			let closed = false;
			class Rejecting extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					if (target.checkPermission !== false) return super.search(target);
					searched = true;
					const results = super.search(target);
					return {
						[Symbol.asyncIterator]: () => results[Symbol.asyncIterator](),
						onDone: async () => {
							closed = true;
							results.onDone?.();
							throw failure;
						},
					};
				}
			}
			process.on('unhandledRejection', onUnhandled);
			try {
				const iterator = new Rejecting(null, { user: { username: 'reader' } })
					.search({ conditions: [{ attribute: 'tag', value: 'odd' }], checkPermission: true })
					[Symbol.asyncIterator]();
				await waitFor(() => searched);
				await iterator.return();
				await waitFor(() => closed);
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.deepEqual(escaped, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('an asynchronously granted read embeds and searches', async () => {
			class Granted extends Doc {
				async allowRead() {
					return true;
				}
			}
			const rows = await fromAsync(
				await Granted.search(
					{ sort: { attribute: 'embedding', text: 'red fruit' }, select: ['content'], limit: 1, checkPermission: true },
					{ user: { username: 'reader' } }
				)
			);
			assert.deepEqual(rows, [{ content: 'cherry' }]);
			assert.equal(queryCalls().length, 1);
		});
	});

	describe('results that are not ready yet', () => {
		it('refuses synchronous iteration, and that ends the search', async () => {
			const release = embed.hold();
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } });
			try {
				await waitFor(() => queryCalls().length === 1);
				assert.throws(() => Array.from(results), /synchronously iterate a search whose sort embeds text/);
				assert.equal(queryCalls()[0].opts.signal.aborted, true);
			} finally {
				release();
			}
		});

		it('a next() still waiting when return() is called settles as done', async () => {
			const release = embed.hold();
			const iterator = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } })[Symbol.asyncIterator]();
			try {
				await waitFor(() => queryCalls().length === 1);
				const pending = iterator.next();
				await iterator.return();
				assert.deepEqual(await pending, { value: undefined, done: true });
			} finally {
				release();
			}
		});

		it('closes at once while a model that ignores the abort is still answering', async () => {
			const release = embed.hold({ ignoreAbort: true });
			try {
				const iterator = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } })[Symbol.asyncIterator]();
				const pending = iterator.next();
				await waitFor(() => queryCalls().length === 1);
				const closed = await Promise.race([
					iterator.return().then(() => 'closed'),
					new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
				]);
				assert.equal(closed, 'closed');
				release();
				assert.deepEqual(await pending, { value: undefined, done: true });
			} finally {
				release();
			}
		});

		it('a step that fails after return() settles as done', async () => {
			const verdict = Promise.withResolvers();
			class SlowlyDenied extends Doc {
				allowRead() {
					return verdict.promise;
				}
			}
			const iterator = new SlowlyDenied(null, { user: { username: 'reader' } })
				.search({ sort: { attribute: 'embedding', text: 'red fruit' }, checkPermission: true })
				[Symbol.asyncIterator]();
			const pending = iterator.next();
			await iterator.return();
			verdict.resolve(false);
			assert.deepEqual(await pending, { value: undefined, done: true });
			assert.equal(embed.calls.length, 0);
		});

		it('a request aborted while its text is embedded fails as an abort, not a model failure', async () => {
			const release = embed.hold();
			const request = new AbortController();
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, { signal: request.signal });
			try {
				await waitFor(() => queryCalls().length === 1);
				request.abort();
			} finally {
				release();
			}
			await rejectsWith(fromAsync(results), (error) => {
				assert.equal(error.statusCode, 499);
				assert.equal(error.cause?.name, 'AbortError');
			});
		});

		it('drops a row that arrives after return(), which a destroyed stream calls mid-step (iterator shared with the async-allowRead gate)', async () => {
			let releaseRow;
			let stepStarted = false;
			const heldResults = {
				[Symbol.asyncIterator]: () => ({
					next: () => {
						stepStarted = true;
						return new Promise((resolve) => (releaseRow = () => resolve({ value: { id: 'late' }, done: false })));
					},
					return: (value) => Promise.resolve({ value, done: true }),
				}),
			};
			class Held extends Doc {
				async allowRead() {
					return true;
				}
				search(target) {
					return target.checkPermission ? super.search(target) : heldResults;
				}
			}
			const results = new Held(null, { user: { username: 'reader' } }).search({ checkPermission: true });
			const iterator = results[Symbol.asyncIterator]();
			const step = iterator.next();
			await waitFor(() => stepStarted);
			await iterator.return();
			releaseRow();
			assert.deepEqual(await step, { value: undefined, done: true });
		});

		it('an explain or counted page whose client disconnects while its text is embedded fails with 499', async () => {
			for (const shape of [{ explain: true }, { count: 'exact', limit: 2 }]) {
				const release = embed.hold();
				const request = new AbortController();
				const result = Doc.search(
					{ sort: { attribute: 'embedding', text: 'red fruit' }, ...shape },
					{ signal: request.signal }
				);
				try {
					await waitFor(() => queryCalls().length > 0);
					request.abort();
				} finally {
					release();
				}
				await rejectsWith(result, (error) => assert.equal(error.statusCode, 499, JSON.stringify(shape)));
				embed.calls.length = 0;
			}
		});

		it('a disconnect fails the search at once while a model that ignores the abort is still answering', async () => {
			const release = embed.hold({ ignoreAbort: true });
			try {
				const request = new AbortController();
				const result = Doc.search(
					{ sort: { attribute: 'embedding', text: 'red fruit' }, explain: true },
					{ signal: request.signal }
				);
				result.catch(() => {});
				await waitFor(() => queryCalls().length > 0);
				request.abort();
				const outcome = await Promise.race([
					result.then(
						() => 'resolved',
						(error) => error.statusCode
					),
					new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
				]);
				assert.equal(outcome, 499);
			} finally {
				release();
			}
		});

		it('searches by the sort as it was when the search started, though the caller changes it after', async () => {
			const release = embed.hold();
			const sort = { attribute: 'embedding', text: 'red fruit' };
			const results = Doc.search({ sort, select: ['content'], limit: 1 });
			try {
				await waitFor(() => queryCalls().length > 0);
				sort.descending = true;
			} finally {
				release();
			}
			assert.deepEqual(await fromAsync(results), [{ content: 'cherry' }]);
		});

		it('a model that answers after the request was aborted opens no search', async () => {
			const release = embed.hold({ ignoreAbort: true });
			const request = new AbortController();
			const context = recordingContext();
			context.signal = request.signal;
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
			let installedBeforeAbort;
			try {
				await waitFor(() => queryCalls().length === 1);
				installedBeforeAbort = context.installed.length;
				request.abort();
			} finally {
				release();
			}
			await rejectsWith(fromAsync(results), (error) => assert.equal(error.statusCode, 499));
			assert.deepEqual(
				context.installed.slice(installedBeforeAbort).filter((txn) => !isReleasedTransaction(txn)),
				[]
			);
		});

		it('a request aborted after the model answered opens no search, in every return shape', async () => {
			for (const shape of [{}, { explain: true }, { count: 'exact', limit: 2 }]) {
				const context = recordingContext();
				context.signal = new AbortController().signal;
				let installedAtAnswer;
				// a caller aborts once the answer is in, past the model call's own abort race
				__setEmbedFnForTest((input, opts) => {
					const answer = embed(input, opts);
					if (opts.inputType !== 'query') return answer;
					return answer.then((vectors) => {
						installedAtAnswer = context.installed.length;
						context.signal = AbortSignal.abort();
						return vectors;
					});
				});
				try {
					const result = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, ...shape }, context);
					await rejectsWith(shape.explain || shape.count ? result : fromAsync(result), (error) =>
						assert.equal(error.statusCode, 499, JSON.stringify(shape))
					);
					assert.deepEqual(
						context.installed.slice(installedAtAnswer).filter((txn) => !isReleasedTransaction(txn)),
						[],
						JSON.stringify(shape)
					);
				} finally {
					__setEmbedFnForTest(embed);
				}
			}
		});

		it('reads from a snapshot taken after the text is embedded', async () => {
			const release = embed.hold();
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'orchard fruit' }, select: ['id'], limit: 1 });
			try {
				await waitFor(() => queryCalls().length === 1);
				await Doc.put(10, { content: 'pear' });
			} finally {
				release();
			}
			try {
				assert.deepEqual(await fromAsync(results), [{ id: 10 }]);
			} finally {
				await Doc.delete(10);
			}
		});

		it('discarded before the embedding resolves: aborts the model call and never starts the search', async () => {
			const release = embed.hold();
			const context = recordingContext();
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
			let installedBeforeDiscard;
			try {
				await waitFor(() => queryCalls().length === 1);
				installedBeforeDiscard = context.installed.length;
				results.onDone();
				assert.equal(queryCalls()[0].opts.signal.aborted, true);
			} finally {
				release();
			}
			assert.deepEqual(await fromAsync(results), []);
			const installedAfter = context.installed.slice(installedBeforeDiscard);
			assert.deepEqual(
				installedAfter.filter((txn) => !isReleasedTransaction(txn)),
				[],
				'no transaction was opened for the search'
			);
		});

		it('holds a read snapshot of its own while iterated, and an early return releases it', async () => {
			const context = recordingContext();
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' } }, context);
			const iterator = results[Symbol.asyncIterator]();
			assert.ok((await iterator.next()).value);
			const links = context.storeLinks();
			if (observesSnapshot)
				assert.ok(
					links.some((txn) => txn.readTxnsUsed > 0),
					'the search holds a read snapshot'
				);
			await iterator.return();
			await waitFor(() => links.every((txn) => !txn.readTxnsUsed), {
				message: () => `read snapshot still held (${links.map((txn) => txn.readTxnsUsed)})`,
			});
		});

		it('joins an open transaction scope: it reads what a target search in that scope reads', async () => {
			const context = {};
			const scopedSearch = (sort) =>
				fromAsync(Doc.search({ conditions: [{ attribute: 'tag', value: 'scoped' }], sort, select: ['id'] }, context));
			let byText, byTarget;
			await transaction(context, async () => {
				await Doc.put(11, { content: 'cherry', tag: 'scoped' }, context);
				byText = await scopedSearch({ attribute: 'embedding', text: 'red fruit' });
				byTarget = await scopedSearch({ attribute: 'embedding', target: queryVector('red fruit') });
			});
			await Doc.delete(11);
			assert.deepEqual(byText, byTarget);
			// RocksDB reads a scope's own staged writes; LMDB does not
			if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') assert.deepEqual(byText, [{ id: 11 }]);
		});
	});

	// a JS index answers synchronously, so a row error throws from a step; a native one rejects the step
	for (const native of [false, true])
		describe(`row errors on a ${native ? 'native' : 'JS'} index`, () => {
			let Tagged;
			const sort = { attribute: 'embedding', text: 'red fruit' };
			const select = ['content', 'tag'];
			before(async function () {
				if (native && !(observesSnapshot && getPlaneBinding())) this.skip(); // the native plane needs RocksDB
				Tagged = table({
					table: native ? 'SortTextFailingRowNativeDoc' : 'SortTextFailingRowDoc',
					database: 'test',
					audit: native,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'content', type: 'String' },
						{ name: 'tag', computed: true },
						{
							name: 'embedding',
							type: 'Array',
							embed: { source: 'content', model: 'doc-model' },
							indexed: native ? { type: 'HNSW', nativePlane: true } : { type: 'HNSW', distance: 'cosine' },
						},
					],
				});
				Tagged.updatedAttributes();
				Tagged.setComputedAttribute('tag', (record) => {
					if (record.content === 'banana') throw new Error('tag failed');
					return 'ok';
				});
				for (const [index, content] of Object.keys(DOCUMENT_VECTORS).entries())
					await Tagged.put(index + 1, { content });
				const current = { attribute: 'embedding', target: [1, 0, 0], maxIndexLagMilliseconds: 0 };
				await waitFor(async () => {
					try {
						return (await fromAsync(Tagged.search({ sort: current }))).length === 4;
					} catch (error) {
						if (error.statusCode === 503) return false;
						throw error;
					}
				});
			});

			it('reports a recovered row and keeps the search, and its snapshot, for the rows after it', async () => {
				const recovered = [];
				const context = recordingContext();
				const iterator = Tagged.search({ sort, select }, context)
					.mapError((error) => {
						recovered.push(error);
						return error;
					})
					[Symbol.asyncIterator]();
				const rows = [];
				let heldAfterTheError;
				for (let step; !(step = await iterator.next()).done;) {
					rows.push(step.value);
					if (recovered.length === 1) heldAfterTheError ??= context.storeLinks().some((txn) => txn.readTxnsUsed > 0);
				}
				assert.equal(rows.length, 4);
				assert.equal(recovered.length, 1);
				assert.match(recovered[0].message, /tag failed/);
				if (observesSnapshot) assert.equal(heldAfterTheError, true, 'the snapshot outlives a recovered row');
			});

			it('releases the snapshot of a search a row error ends', async () => {
				const context = recordingContext();
				await assert.rejects(fromAsync(Tagged.search({ sort, select }, context)), /tag failed/);
				const links = context.storeLinks();
				if (observesSnapshot) assert.ok(links.length > 0);
				await waitFor(() => links.every((txn) => !txn.readTxnsUsed), {
					message: () => `read snapshot still held (${links.map((txn) => txn.readTxnsUsed)})`,
				});
			});
		});

	describe('return shapes', () => {
		it('a counted page is a Promise, as without text', async () => {
			const page = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, limit: 2, count: 'exact' });
			assert.equal(typeof page.then, 'function');
			const rows = await page;
			assert.equal(rows.length, 2);
			assert.ok('recordCount' in rows);
		});

		it('a count without a bounded page streams, as without text', async () => {
			const results = Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, count: 'exact' });
			assert.equal(typeof results.then, 'undefined');
			assert.equal((await fromAsync(results)).length, 4);
		});

		it('explains a leading descending sort, which only running the index refuses, as for a target', async () => {
			for (const sort of [
				{ attribute: 'embedding', text: 'red fruit', descending: true },
				{ attribute: 'embedding', target: queryVector('red fruit'), descending: true },
			]) {
				const plan = await Doc.search({ sort, explain: true });
				assert.ok(Array.isArray(plan.conditions), JSON.stringify(sort));
			}
		});

		it('explain resolves to the plan with the embedded vector as the target', async () => {
			const plan = await Doc.search({ sort: { attribute: 'embedding', text: 'red fruit' }, explain: true });
			const sortCondition = plan.conditions.find((condition) => condition.comparator === 'sort');
			assert.deepEqual(sortCondition.target, queryVector('red fruit'));
			assert.equal(sortCondition.text, undefined);
		});
	});

	it('search_by_value (the operations API) ranks by sort text and returns $distance', async () => {
		const rows = await searchByValue({
			operation: 'search_by_value',
			database: 'test',
			table: 'SortTextEmbedDoc',
			attribute: 'id',
			value: '*',
			sort: { attribute: 'embedding', text: 'yellow fruit' },
			get_attributes: ['content', '$distance'],
			limit: 2,
		});
		assert.deepEqual(
			rows.map((row) => row.content),
			['banana', 'apricot']
		);
		assert.ok(rows.every((row) => typeof row.$distance === 'number'));
		assert.equal(queryCalls().length, 1);
	});

	it('search_by_conditions takes the same sort text', async () => {
		const rows = await fromAsync(
			await searchByConditions({
				operation: 'search_by_conditions',
				database: 'test',
				table: 'SortTextEmbedDoc',
				conditions: [{ attribute: 'tag', comparator: 'equals', value: 'even' }],
				sort: { attribute: 'embedding', text: 'orchard fruit' },
				get_attributes: ['content'],
			})
		);
		assert.deepEqual(
			rows.map((row) => row.content),
			['apricot', 'cherry']
		);
	});

	it('a REST QUERY ranks by sort text as by its vector', async () => {
		const request = rest([Doc]);
		const query = async (sort) => {
			const response = await request(
				'QUERY',
				'/SortTextEmbedDoc/',
				{ sort, select: ['content'], limit: 2 },
				{
					accept: 'application/json',
				}
			);
			assert.equal(response.status ?? 200, 200);
			return JSON.parse(await bodyOf(response));
		};
		const byText = await query({ attribute: 'embedding', text: 'red fruit' });
		assert.deepEqual(byText, await query({ attribute: 'embedding', target: queryVector('red fruit') }));
		assert.equal(byText.length, 2);
	});
});
