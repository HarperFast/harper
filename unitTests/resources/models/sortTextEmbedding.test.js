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
});
