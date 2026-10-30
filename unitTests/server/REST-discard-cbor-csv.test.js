const assert = require('node:assert');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { versionToEtag } = require('#src/server/serverHelpers/preconditions');
require('#src/server/serverHelpers/serverUtilities');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { decode } = require('cbor-x');
const { unpackMultiple } = require('msgpackr');
const { setupTestDBPath } = require('../testUtils');

const ROW_COUNT = 20;
const LAST_MODIFIED_TS = Date.UTC(2026, 0, 1);
const EXPECTED_ETAG = versionToEtag(LAST_MODIFIED_TS);
const DATABASE_NAME = 'test_discard_cbor_csv';
const reader = {
	role: {
		permission: {
			[DATABASE_NAME]: {
				tables: {
					DiscardProbeRow: { read: true, insert: false, update: false, delete: false },
					AsyncComputedRow: { read: true, insert: false, update: false, delete: false },
				},
			},
		},
	},
};

class CustomAsyncIterable {
	constructor(factory) {
		this._factory = factory;
	}
	[Symbol.asyncIterator]() {
		return this._factory();
	}
}

function makeAsyncIterable(factory) {
	return new CustomAsyncIterable(factory);
}

describe('REST discarded reads with CBOR and CSV content types', () => {
	let handler;
	let resources;
	let DiscardProbeRow;
	let AsyncDiscardProbeRow;
	let state;
	let activeIterators = [];

	function resetState() {
		state = {
			iteratorsOpened: 0,
			stepped: 0,
			returned: 0,
			mappedRows: 0,
			stepsAfterOnDone: 0,
			postDoneError: null,
			trackedContexts: new Set(),
		};
	}

	function trackContext(ctx) {
		if (ctx && typeof ctx === 'object') {
			state.trackedContexts.add(ctx);
		}
	}

	function getTxnMetrics() {
		let readTxnsUsed = 0;
		let hasOpenTxn = false;
		for (const ctx of state.trackedContexts) {
			const txn = ctx.transaction;
			if (txn) {
				if (typeof txn.readTxnsUsed === 'number') {
					readTxnsUsed += txn.readTxnsUsed;
				}
				if (txn.transaction !== null && txn.transaction !== undefined) {
					hasOpenTxn = true;
				}
			}
		}
		return { readTxnsUsed, hasOpenTxn };
	}

	function cleanupTrackedContexts() {
		for (const it of activeIterators.splice(0)) {
			try {
				it.aborted = true;
				it.rawIterator?.return?.();
			} catch {}
		}
		for (const ctx of state.trackedContexts) {
			const txn = ctx.transaction;
			if (txn && typeof txn.doneReadTxn === 'function') {
				while (txn.readTxnsUsed > 0) {
					try {
						txn.doneReadTxn();
					} catch {
						break;
					}
				}
			}
		}
	}

	function instrumentSearchResult(results, track) {
		if (!results || typeof results[Symbol.asyncIterator] !== 'function') {
			return results;
		}
		let doneCalled = false;
		const origOnDone = typeof results.onDone === 'function' ? results.onDone.bind(results) : null;
		if (origOnDone) {
			results.onDone = function () {
				doneCalled = true;
				return origOnDone();
			};
		}
		const origMap = typeof results.map === 'function' ? results.map.bind(results) : null;
		if (origMap) {
			results.map = function (fn) {
				return origMap((item) => {
					state.mappedRows += 1;
					return fn(item);
				});
			};
		}
		const origAsyncIter = results[Symbol.asyncIterator].bind(results);
		results[Symbol.asyncIterator] = function () {
			track?.();
			state.iteratorsOpened += 1;
			const rawIterator = origAsyncIter();
			let closed = false;
			const tracker = { aborted: false, rawIterator };
			activeIterators.push(tracker);
			return {
				next() {
					track?.();
					if (tracker.aborted) {
						return { value: undefined, done: true };
					}
					if (doneCalled) {
						state.stepsAfterOnDone += 1;
					}
					state.stepped += 1;
					try {
						const nextVal = rawIterator.next();
						if (nextVal && typeof nextVal.then === 'function') {
							return nextVal.catch((err) => {
								if (doneCalled || tracker.aborted) {
									state.postDoneError = err?.name ?? String(err);
									return { value: undefined, done: true };
								}
								throw err;
							});
						}
						return nextVal;
					} catch (err) {
						if (doneCalled || tracker.aborted) {
							state.postDoneError = err?.name ?? String(err);
							return { value: undefined, done: true };
						}
						throw err;
					}
				},
				return(value) {
					track?.();
					doneCalled = true;
					if (!closed) {
						closed = true;
						state.returned += 1;
					}
					return rawIterator.return ? rawIterator.return(value) : { value, done: true };
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		};
		return results;
	}

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetState();

		DiscardProbeRow = table({
			table: 'DiscardProbeRow',
			database: 'test_discard_cbor_csv',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'seq', indexed: true }, { name: 'label' }],
		});
		DiscardProbeRow.loadAsInstance = false;

		const origSearch = DiscardProbeRow.prototype.search;
		DiscardProbeRow.prototype.search = function (target, context) {
			const results = origSearch.call(this, target, context);
			const track = () => {
				trackContext(this.getContext?.());
				trackContext(context);
			};
			track();
			return instrumentSearchResult(results, track);
		};

		for (let i = 1; i <= ROW_COUNT; i++) {
			const id = `row-${String(i).padStart(2, '0')}`;
			await DiscardProbeRow.put({ id, seq: i, label: `label-${i}` });
		}

		class AsyncDiscardProbeRowClass extends DiscardProbeRow {
			static loadAsInstance = false;
			async allowRead() {
				await new Promise((r) => setImmediate(r));
				return true;
			}
			get(target) {
				const ctx = this.getContext?.();
				trackContext(ctx);
				ctx?.responseHeaders?.set('ETag', EXPECTED_ETAG);
				return this.search(target).map((row) => ({
					id: row.id,
					seq: row.seq,
					label: row.label,
				}));
			}
		}
		AsyncDiscardProbeRow = AsyncDiscardProbeRowClass;

		class MappedDiscardProbeRow extends DiscardProbeRow {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			get(target) {
				const ctx = this.getContext?.();
				trackContext(ctx);
				ctx?.responseHeaders?.set('ETag', EXPECTED_ETAG);
				return this.search(target).map((row) => ({
					id: row.id,
					seq: row.seq,
					label: row.label,
				}));
			}
		}

		class DirectDiscardProbeRow extends DiscardProbeRow {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			get(target) {
				const ctx = this.getContext?.();
				trackContext(ctx);
				ctx?.responseHeaders?.set('ETag', EXPECTED_ETAG);
				return this.search(target);
			}
		}

		class ClosedUnstepped extends Resource {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			static get(_target, context) {
				if (context) context.lastModified = LAST_MODIFIED_TS;
				return makeAsyncIterable(() => {
					state.iteratorsOpened += 1;
					let idx = 0;
					let closed = false;
					return {
						async next() {
							if (closed || idx >= ROW_COUNT) {
								return { value: undefined, done: true };
							}
							state.stepped += 1;
							idx += 1;
							return {
								value: { id: `row-${String(idx).padStart(2, '0')}`, seq: idx },
								done: false,
							};
						},
						async return(value) {
							if (!closed) {
								closed = true;
								state.returned += 1;
							}
							return { value, done: true };
						},
						[Symbol.asyncIterator]() {
							return this;
						},
					};
				});
			}
		}

		class AsyncIterableSearchCbor extends Resource {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			static get(_target, context) {
				if (context) context.lastModified = LAST_MODIFIED_TS;
				return makeAsyncIterable(() => {
					const iter = DiscardProbeRow.search(new RequestTarget('?seq=gt=0'))[Symbol.asyncIterator]();
					return {
						async next() {
							await new Promise((r) => setImmediate(r));
							return iter.next();
						},
						async return(value) {
							return iter.return ? iter.return(value) : { value, done: true };
						},
						[Symbol.asyncIterator]() {
							return this;
						},
					};
				});
			}
		}

		class AsyncIterableSearchCsv extends Resource {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			static get(_target, context) {
				if (context) context.lastModified = LAST_MODIFIED_TS;
				return makeAsyncIterable(() => DiscardProbeRow.search(new RequestTarget('?seq=gt=0'))[Symbol.asyncIterator]());
			}
		}

		resources = new Resources();
		resources.set('DiscardProbeRow', MappedDiscardProbeRow, { rest: true });
		resources.set('DirectDiscardProbeRow', DirectDiscardProbeRow, { rest: true });
		resources.set('AsyncDiscardProbeRow', AsyncDiscardProbeRow, { rest: true });
		resources.set('ClosedUnstepped', ClosedUnstepped, { rest: true });
		resources.set('AsyncIterableSearchCbor', AsyncIterableSearchCbor, { rest: true });
		resources.set('AsyncIterableSearchCsv', AsyncIterableSearchCsv, { rest: true });

		const AsyncComputedRow = table({
			table: 'AsyncComputedRow',
			database: DATABASE_NAME,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'label', computed: true }],
		});
		AsyncComputedRow.setComputedAttribute('label', async (record) => {
			await new Promise((r) => setImmediate(r));
			return record.name + ' label';
		});
		for (let i = 0; i < 5; i++) await AsyncComputedRow.put({ id: `computed-${i}`, name: `name-${i}` });
		resources.set('AsyncComputedRow', AsyncComputedRow, { rest: true });

		class ArrayRows extends Resource {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			static get() {
				return [{ id: 'a' }, { id: 'b' }];
			}
		}
		resources.set('ArrayRows', ArrayRows, { rest: true });

		class PromiseRows extends Resource {
			static loadAsInstance = false;
			allowRead() {
				return true;
			}
			static get() {
				return new Set([Promise.resolve({ id: 'p1' }), { id: 'p2' }]);
			}
		}
		resources.set('PromiseRows', PromiseRows, { rest: true });
		resources.isListening = true;

		handleApplication({
			resources,
			options: {
				getAll() {
					return { webSocket: false, lastModified: true };
				},
			},
			routeFor() {
				return { urlPath: '/discard-cbor-csv' };
			},
			server: {
				http(listener) {
					handler = listener;
				},
			},
		});
	});

	beforeEach(() => {
		resetState();
	});

	afterEach(() => {
		cleanupTrackedContexts();
	});

	async function dispatchRequest(
		method,
		url,
		{ accept = 'application/json', headers: extraHeaders = {}, destroyOnFirstChunk = false, unread = false } = {}
	) {
		const hdrs = {
			accept,
			...extraHeaders,
		};
		const request = {
			method,
			url,
			user: reader,
			headers: new Headers(hdrs),
		};
		request.headers.asObject = hdrs;

		const response = await handler(request, () => ({ status: 404 }));
		const chunks = [];
		let unreadMetrics;
		if (unread) {
			for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
			unreadMetrics = { iteratorsOpened: state.iteratorsOpened, stepped: state.stepped };
			response.body.on('error', () => {});
			response.body.destroy();
		} else if (response.body) {
			if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) {
				chunks.push(Buffer.from(response.body));
			} else if (destroyOnFirstChunk) {
				await new Promise((resolve, reject) => {
					response.body.on('data', (chunk) => {
						chunks.push(Buffer.from(chunk));
						if (state.stepped >= 1) {
							response.body.destroy();
							resolve();
						}
					});
					response.body.on('end', resolve);
					response.body.on('close', resolve);
					response.body.on('error', reject);
				});
			} else {
				for await (const chunk of response.body) {
					chunks.push(Buffer.from(chunk));
				}
			}
		}

		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const txnMetrics = getTxnMetrics();
		return {
			statusCode: response.status,
			headers: response.headers,
			body: Buffer.concat(chunks),
			unreadMetrics,
			metrics: {
				iteratorsOpened: state.iteratorsOpened,
				stepped: state.stepped,
				returned: state.returned,
				mappedRows: state.mappedRows,
				stepsAfterOnDone: state.stepsAfterOnDone,
				postDoneError: state.postDoneError,
				readTxnsUsed: txnMetrics.readTxnsUsed,
				hasOpenTxn: txnMetrics.hasOpenTxn,
			},
		};
	}

	function conditionalHeadersFor(kind) {
		if (kind === '304') {
			return { method: 'GET', headers: { 'if-none-match': EXPECTED_ETAG } };
		}
		if (kind === '412') {
			return { method: 'GET', headers: { 'if-match': '"mismatch"' } };
		}
		return { method: 'HEAD', headers: {} };
	}

	it('completes CBOR and CSV GET roundtrips and closes JSON, MsgPack, and NDJSON discarded reads cleanly', async () => {
		resetState();
		const cborGet = await dispatchRequest('GET', '/DiscardProbeRow/?seq=gt=0', {
			accept: 'application/cbor',
		});
		assert.strictEqual(cborGet.statusCode, 200);
		const decodedCbor = decode(cborGet.body);
		assert.strictEqual(Array.isArray(decodedCbor), true);
		assert.strictEqual(decodedCbor.length, ROW_COUNT);
		assert.strictEqual(decodedCbor[0].id, 'row-01');
		assert.strictEqual(decodedCbor[ROW_COUNT - 1].id, 'row-20');
		assert.strictEqual(cborGet.metrics.readTxnsUsed, 0);
		assert.strictEqual(cborGet.metrics.hasOpenTxn, false);

		resetState();
		const csvGet = await dispatchRequest('GET', '/DiscardProbeRow/?seq=gt=0', {
			accept: 'text/csv',
		});
		assert.strictEqual(csvGet.statusCode, 200);
		const csvLines = csvGet.body.toString('utf8').trim().split(/\r?\n/);
		assert.strictEqual(csvLines.length, ROW_COUNT + 1);
		assert.strictEqual(csvGet.metrics.readTxnsUsed, 0);
		assert.strictEqual(csvGet.metrics.hasOpenTxn, false);

		for (const accept of ['application/json', 'application/x-msgpack']) {
			for (const kind of ['HEAD', '304', '412']) {
				const { method, headers } = conditionalHeadersFor(kind);

				resetState();
				const closedRes = await dispatchRequest(method, '/ClosedUnstepped/', {
					accept,
					headers,
				});
				assert.deepStrictEqual(
					{
						iteratorsOpened: closedRes.metrics.iteratorsOpened,
						stepped: closedRes.metrics.stepped,
						returned: closedRes.metrics.returned,
					},
					{ iteratorsOpened: 1, stepped: 0, returned: 1 },
					`${accept} ${kind} on ClosedUnstepped`
				);

				resetState();
				const tableRes = await dispatchRequest(method, '/DiscardProbeRow/?seq=gt=0', {
					accept,
					headers,
				});
				assert.deepStrictEqual(
					{
						iteratorsOpened: tableRes.metrics.iteratorsOpened,
						stepped: tableRes.metrics.stepped,
						returned: tableRes.metrics.returned,
						mappedRows: tableRes.metrics.mappedRows,
						stepsAfterOnDone: tableRes.metrics.stepsAfterOnDone,
						readTxnsUsed: tableRes.metrics.readTxnsUsed,
						hasOpenTxn: tableRes.metrics.hasOpenTxn,
					},
					{
						iteratorsOpened: 1,
						stepped: 0,
						returned: 1,
						mappedRows: 0,
						stepsAfterOnDone: 0,
						readTxnsUsed: 0,
						hasOpenTxn: false,
					},
					`${accept} ${kind} on DiscardProbeRow`
				);
			}
		}

		resetState();
		const ndjsonHead = await dispatchRequest('HEAD', '/ClosedUnstepped/', {
			accept: 'application/x-ndjson',
		});
		assert.deepStrictEqual(
			{
				iteratorsOpened: ndjsonHead.metrics.iteratorsOpened,
				stepped: ndjsonHead.metrics.stepped,
				returned: ndjsonHead.metrics.returned,
			},
			{ iteratorsOpened: 1, stepped: 1, returned: 1 }
		);
	});

	it('does not iterate or leak search iterators on discarded reads or aborted streams with Accept: application/cbor', async () => {
		const observed = {};
		const expected = {};

		for (const kind of ['HEAD', '304', '412']) {
			const { method, headers } = conditionalHeadersFor(kind);

			resetState();
			const closedRes = await dispatchRequest(method, '/ClosedUnstepped/', {
				accept: 'application/cbor',
				headers,
			});
			observed[`ClosedUnstepped_${kind}`] = {
				iteratorsOpened: closedRes.metrics.iteratorsOpened,
				stepped: closedRes.metrics.stepped,
				returned: closedRes.metrics.returned,
			};
			expected[`ClosedUnstepped_${kind}`] = {
				iteratorsOpened: 1,
				stepped: 0,
				returned: 1,
			};
			cleanupTrackedContexts();

			for (const route of ['DiscardProbeRow', 'DirectDiscardProbeRow', 'AsyncDiscardProbeRow']) {
				resetState();
				const tableRes = await dispatchRequest(method, `/${route}/?seq=gt=0`, {
					accept: 'application/cbor',
					headers,
				});
				observed[`${route}_${kind}`] = {
					iteratorsOpened: tableRes.metrics.iteratorsOpened,
					stepped: tableRes.metrics.stepped,
					mappedRows: tableRes.metrics.mappedRows,
					stepsAfterOnDone: tableRes.metrics.stepsAfterOnDone,
					postDoneError: tableRes.metrics.postDoneError,
					readTxnsUsed: tableRes.metrics.readTxnsUsed,
					hasOpenTxn: tableRes.metrics.hasOpenTxn,
				};
				expected[`${route}_${kind}`] = {
					iteratorsOpened: route === 'DirectDiscardProbeRow' ? 0 : 1,
					stepped: 0,
					mappedRows: 0,
					stepsAfterOnDone: 0,
					postDoneError: null,
					readTxnsUsed: 0,
					hasOpenTxn: false,
				};
				cleanupTrackedContexts();
			}
		}

		resetState();
		const asyncIterHead = await dispatchRequest('HEAD', '/AsyncIterableSearchCbor/', {
			accept: 'application/cbor',
		});
		observed.AsyncIterableSearchCbor_HEAD = {
			iteratorsOpened: asyncIterHead.metrics.iteratorsOpened,
			stepped: asyncIterHead.metrics.stepped,
			returned: asyncIterHead.metrics.returned,
			readTxnsUsed: asyncIterHead.metrics.readTxnsUsed,
			hasOpenTxn: asyncIterHead.metrics.hasOpenTxn,
		};
		expected.AsyncIterableSearchCbor_HEAD = {
			iteratorsOpened: 1,
			stepped: 0,
			returned: 1,
			readTxnsUsed: 0,
			hasOpenTxn: false,
		};
		cleanupTrackedContexts();

		resetState();
		const abortedGet = await dispatchRequest('GET', '/AsyncIterableSearchCbor/', {
			accept: 'application/cbor',
			destroyOnFirstChunk: true,
		});
		observed.AsyncIterableSearchCbor_GET_destroy = {
			returned: abortedGet.metrics.returned,
			readTxnsUsed: abortedGet.metrics.readTxnsUsed,
			hasOpenTxn: abortedGet.metrics.hasOpenTxn,
		};
		expected.AsyncIterableSearchCbor_GET_destroy = {
			returned: 1,
			readTxnsUsed: 0,
			hasOpenTxn: false,
		};
		cleanupTrackedContexts();

		assert.deepStrictEqual(observed, expected);
	});

	it('does not iterate or leak search transactions on discarded reads with Accept: text/csv', async () => {
		const observed = {};
		const expected = {};

		for (const kind of ['HEAD', '304', '412']) {
			const { method, headers } = conditionalHeadersFor(kind);

			resetState();
			const closedRes = await dispatchRequest(method, '/ClosedUnstepped/', {
				accept: 'text/csv',
				headers,
			});
			observed[`ClosedUnstepped_${kind}`] = {
				iteratorsOpened: closedRes.metrics.iteratorsOpened,
				stepped: closedRes.metrics.stepped,
				returned: closedRes.metrics.returned,
			};
			expected[`ClosedUnstepped_${kind}`] = {
				iteratorsOpened: 1,
				stepped: 0,
				returned: 1,
			};
			cleanupTrackedContexts();

			for (const route of ['DiscardProbeRow', 'AsyncDiscardProbeRow']) {
				resetState();
				const tableRes = await dispatchRequest(method, `/${route}/?seq=gt=0`, {
					accept: 'text/csv',
					headers,
				});
				observed[`${route}_${kind}`] = {
					iteratorsOpened: tableRes.metrics.iteratorsOpened,
					stepped: tableRes.metrics.stepped,
					mappedRows: tableRes.metrics.mappedRows,
					stepsAfterOnDone: tableRes.metrics.stepsAfterOnDone,
					postDoneError: tableRes.metrics.postDoneError,
					readTxnsUsed: tableRes.metrics.readTxnsUsed,
					hasOpenTxn: tableRes.metrics.hasOpenTxn,
				};
				expected[`${route}_${kind}`] = {
					iteratorsOpened: 1,
					stepped: 0,
					mappedRows: 0,
					stepsAfterOnDone: 0,
					postDoneError: null,
					readTxnsUsed: 0,
					hasOpenTxn: false,
				};
				cleanupTrackedContexts();
			}

			resetState();
			const asyncIterCsv = await dispatchRequest(method, '/AsyncIterableSearchCsv/', {
				accept: 'text/csv',
				headers,
			});
			observed[`AsyncIterableSearchCsv_${kind}`] = {
				iteratorsOpened: asyncIterCsv.metrics.iteratorsOpened,
				stepped: asyncIterCsv.metrics.stepped,
				returned: asyncIterCsv.metrics.returned,
				readTxnsUsed: asyncIterCsv.metrics.readTxnsUsed,
				hasOpenTxn: asyncIterCsv.metrics.hasOpenTxn,
			};
			expected[`AsyncIterableSearchCsv_${kind}`] = {
				iteratorsOpened: 1,
				stepped: 0,
				returned: 1,
				readTxnsUsed: 0,
				hasOpenTxn: false,
			};
			cleanupTrackedContexts();
		}

		assert.deepStrictEqual(observed, expected);
	});
	it('opens no source for an unread streamed body', async () => {
		const observed = {};
		const expected = {};
		for (const accept of ['application/cbor', 'application/x-msgpack', 'text/csv', 'text/plain']) {
			resetState();
			const res = await dispatchRequest('GET', '/ClosedUnstepped/', { accept, unread: true });
			observed[accept] = { ...res.unreadMetrics, returned: res.metrics.returned };
			expected[accept] = { iteratorsOpened: 0, stepped: 0, returned: 0 };
		}
		assert.deepStrictEqual(observed, expected);
	});

	it('closes the source of an aborted msgpack or CSV stream', async () => {
		const observed = {};
		const expected = {};
		for (const accept of ['application/x-msgpack', 'text/csv']) {
			resetState();
			const res = await dispatchRequest('GET', '/AsyncIterableSearchCbor/', { accept, destroyOnFirstChunk: true });
			observed[accept] = { readTxnsUsed: res.metrics.readTxnsUsed, hasOpenTxn: res.metrics.hasOpenTxn };
			expected[accept] = { readTxnsUsed: 0, hasOpenTxn: false };
			cleanupTrackedContexts();
		}
		assert.deepStrictEqual(observed, expected);
	});

	it('returns the rows of an async @computed selection over msgpack and CBOR as over JSON', async () => {
		const url = '/AsyncComputedRow/?select(id,name,label)';
		const json = JSON.parse((await dispatchRequest('GET', url)).body);
		assert.strictEqual(json.length, 5);
		assert.strictEqual(json[0].label, 'name-0 label');
		const msgpack = await dispatchRequest('GET', url, { accept: 'application/x-msgpack' });
		assert.strictEqual(msgpack.statusCode, 200);
		assert.deepStrictEqual(unpackMultiple(msgpack.body), json);
		const cbor = await dispatchRequest('GET', url, { accept: 'application/cbor' });
		assert.deepStrictEqual(decode(cbor.body), json);
	});

	it('awaits the Promise rows of a sync iterable in CSV', async () => {
		const csv = await dispatchRequest('GET', '/PromiseRows/', { accept: 'text/csv' });
		assert.deepStrictEqual(csv.body.toString().trim().split(/\r?\n/), ['"id"', '"p1"', '"p2"']);
	});

	it('streams a CBOR array with a definite length and an iterable as an indefinite one', async () => {
		const array = await dispatchRequest('GET', '/ArrayRows/', { accept: 'application/cbor' });
		assert.strictEqual(array.body[0], 0x82);
		assert.deepStrictEqual(decode(array.body), [{ id: 'a' }, { id: 'b' }]);
		const iterable = await dispatchRequest('GET', '/ClosedUnstepped/', { accept: 'application/cbor' });
		assert.strictEqual(iterable.body[0], 0x9f);
		assert.strictEqual(decode(iterable.body).length, ROW_COUNT);
	});
});
