'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { waitFor } = require('../../waitFor');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { __setEmbedFnForTest } = require('#src/resources/models/embedHook');
const { searchByValue, searchByConditions } = require('#src/dataLayer/search');
const { isReleasedTransaction } = require('#src/resources/DatabaseTransaction');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { searchOpening } = require('#src/resources/Resource');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
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
// Written mid-test, so not part of the starting rows.
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

// the model answers with a Float32Array
const queryVector = (text) => Array.from(new Float32Array(QUERY_VECTORS[text]));

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
				(async () =>
					fromAsync(
						Doc.search({
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

		it('refuses an undefined or missing sort head before a text sort after it calls the model', () => {
			const next = { attribute: 'embedding', text: 'red fruit' };
			assert.throws(
				() => Doc.search({ sort: { attribute: 'nope', next } }),
				(error) => error.statusCode === 404 && /nope is not a defined attribute/.test(error.message)
			);
			assert.throws(() => Doc.search({ sort: { next } }), /Sort requires an attribute/);
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
			class GatedMappedDoc extends Doc {
				static loadAsInstance = false;
				async allowRead() {
					await new Promise((resolve) => setImmediate(resolve));
					return true;
				}
				get(target) {
					target.sort = { attribute: 'embedding', text: 'red fruit' };
					return this.search(target).map((row) => row);
				}
			}
			const response = await rest([GatedMappedDoc])('GET', '/SortTextEmbedDoc/', undefined, {
				accept: 'application/json',
			}).catch((error) => error);
			assert.equal(response.statusCode ?? response.status, 502);
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
		it('fails the opening, and a REST QUERY with its 503, while a native index stays behind', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) this.skip(); // the native plane needs RocksDB
			const Lagging = table({
				table: 'SortTextLaggingDoc',
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
			Lagging.updatedAttributes();
			const index = Lagging.indices.embedding.customIndex;
			const current = { attribute: 'embedding', target: [1, 0, 0], maxIndexLagMilliseconds: 0 };
			await waitFor(async () => {
				try {
					await fromAsync(Lagging.search({ sort: current }));
					return true;
				} catch (error) {
					if (error.statusCode === 503) return false;
					throw error;
				}
			});
			const { flushDerived } = index;
			const gate = Promise.withResolvers();
			index.flushDerived = async function (...args) {
				await gate.promise;
				return flushDerived.apply(this, args);
			};
			try {
				await Lagging.put(1, { content: 'apple' });
				const sort = { attribute: 'embedding', text: 'red fruit', waitForIndexMilliseconds: Number.MIN_VALUE };
				await assert.rejects(searchOpening(Lagging.search({ sort })), { code: 'DERIVED_INDEX_LAGGING' });
				// an index the planner drives from a condition starts as the opening does too
				const threshold = {
					attribute: 'embedding',
					comparator: 'lt',
					value: 2,
					target: [1, 0, 0],
					waitForIndexMilliseconds: Number.MIN_VALUE,
				};
				await assert.rejects(
					searchOpening(
						Lagging.search({ conditions: [threshold], sort: { attribute: 'embedding', text: 'red fruit' } })
					),
					{ code: 'DERIVED_INDEX_LAGGING' }
				);
				// a search discarded while its index waits stops that wait, which would otherwise outlive it
				const calls = embed.calls.length;
				const waiting = Lagging.search({
					sort: { attribute: 'embedding', text: 'red fruit', waitForIndexMilliseconds: 20_000 },
				})[Symbol.asyncIterator]();
				const step = waiting.next();
				step.catch(() => {});
				await waitFor(() => embed.calls.length > calls);
				await new Promise((resolve) => setImmediate(resolve));
				const discardedAt = Date.now();
				await waiting.return();
				assert.deepEqual(await step, { value: undefined, done: true });
				assert.ok(Date.now() - discardedAt < 5_000, 'the discard did not wait out the index');
				const response = await rest([Lagging])(
					'QUERY',
					'/SortTextLaggingDoc/',
					{ sort, select: ['id'] },
					{ accept: 'application/json' }
				).catch((error) => error);
				assert.equal(response.statusCode ?? response.status, 503);
			} finally {
				gate.resolve();
				delete index.flushDerived;
			}
		});

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
				assert.equal(error.name, 'AbortError');
				assert.notEqual(error.statusCode, 502);
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
			await rejectsWith(fromAsync(results), (error) => assert.equal(error.name, 'AbortError'));
			assert.deepEqual(
				context.installed.slice(installedBeforeAbort).filter((txn) => !isReleasedTransaction(txn)),
				[]
			);
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
			// an LMDB search's transaction is not reachable from the context once its scope is released
			if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb')
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

	describe('row errors', () => {
		let Tagged;
		const sort = { attribute: 'embedding', text: 'red fruit' };
		const select = ['content', 'tag'];
		// an LMDB search's transaction is not reachable from the context once its scope is released
		const observesSnapshot = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
		// a native index answers asynchronously, so a row error rejects a step rather than throwing from it
		const native = observesSnapshot && Boolean(getPlaneBinding());
		before(async () => {
			Tagged = table({
				table: 'SortTextFailingRowDoc',
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
			for (const [index, content] of Object.keys(DOCUMENT_VECTORS).entries()) await Tagged.put(index + 1, { content });
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
