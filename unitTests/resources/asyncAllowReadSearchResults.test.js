const assert = require('node:assert');
const { waitFor } = require('../waitFor.js');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { Resources } = require('#src/resources/Resources');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
require('#src/server/serverHelpers/serverUtilities');

// A loadAsInstance=false table whose allowRead returns a promise searches through a lazy authorization gate.
// Once authorized it must answer exactly as the same table with a synchronous allowRead does.
describe('Search results behind an async allowRead', () => {
	const database = 'test_async_allow_read';
	const page = '?category=books&limit(1,3)';
	let reader, request;
	let readTxns = [];
	const classes = {};
	const modes = ['Sync', 'Async'];

	function captureReadTxns(resource) {
		readTxns = [];
		for (let txn = resource.getContext().transaction; txn; txn = txn.next) if (txn.db) readTxns.push(txn);
	}

	async function snapshotReleased(label) {
		assert.ok(readTxns.length > 0, `${label}: the search ran`);
		const txns = readTxns;
		await waitFor(() => txns.every((txn) => txn.readTxnsUsed === 0), {
			message: () => `${label}: read snapshot still held (${txns.map((txn) => txn.readTxnsUsed)})`,
		});
	}

	async function bodyOf(response) {
		if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) return response.body.toString();
		if (!response.body) return '';
		const chunks = [];
		for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString();
	}

	const rowsOf = (raw, accept) =>
		accept === 'application/x-ndjson'
			? raw
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			: JSON.parse(raw);
	const ids = (rows) => rows.map((row) => row.id);
	const directContext = () => ({ user: reader, authorize: true });
	const countTarget = (count) => Object.assign(new RequestTarget(page), { count, checkPermission: true });

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Item = table({
			table: 'AsyncAllowReadItem',
			database,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'category', indexed: true },
				{ name: 'score', type: 'Int', indexed: true },
			],
		});
		for (let i = 1; i <= 5; i++)
			await Item.put({ id: `item-${i}`, category: i <= 4 ? 'books' : 'games', score: i * 10 });
		reader = {
			role: {
				permission: {
					[database]: {
						tables: { AsyncAllowReadItem: { read: true, insert: false, update: false, delete: false } },
					},
				},
			},
		};
		const gates = {
			Sync: class extends Item {
				static loadAsInstance = false;
				allowRead() {
					captureReadTxns(this);
					return true;
				}
			},
			Async: class extends Item {
				static loadAsInstance = false;
				async allowRead() {
					captureReadTxns(this);
					await new Promise((resolve) => setImmediate(resolve));
					return true;
				}
			},
			Denied: class extends Item {
				static loadAsInstance = false;
				async allowRead() {
					return false;
				}
			},
			Rejected: class extends Item {
				static loadAsInstance = false;
				allowRead() {
					return Promise.reject(new Error('policy lookup failed'));
				}
			},
		};
		const shapes = {
			Item: (Gate) => Gate,
			Envelope: (Gate) =>
				class extends Gate {
					get(target) {
						return { headers: new Headers({ 'X-Envelope': 'true' }), data: this.search(target) };
					}
				},
			FrozenEnvelope: (Gate) =>
				class extends Gate {
					get(target) {
						return Object.freeze({ headers: new Headers({ 'X-Envelope': 'true' }), data: this.search(target) });
					}
				},
			Mapped: (Gate) =>
				class extends Gate {
					get(target) {
						this.getContext().responseHeaders?.set('ETag', '"mapped"');
						return this.search(target).map(({ id, score }) => ({ id, score }));
					}
				},
			Explain: (Gate) =>
				class extends Gate {
					get(target) {
						target.explain = true;
						return this.search(target);
					}
				},
		};
		const resources = new Resources();
		for (const [gate, Gate] of Object.entries(gates)) {
			for (const [shape, extend] of Object.entries(shapes)) {
				classes[gate + shape] = extend(Gate);
				resources.set(gate + shape, classes[gate + shape], { rest: true });
			}
		}
		let handler;
		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false, lastModified: true, exactCount: true }) },
			routeFor: () => ({ urlPath: '/async-allow-read' }),
			server: { http: (listener) => (handler = listener) },
		});
		request = (method, url, headers = {}) => {
			readTxns = [];
			const context = { method, url, user: reader, headers: new Headers(headers) };
			context.headers.asObject = headers;
			return handler(context, () => ({ status: 404 }));
		};
	});

	it('returns the count page from the Resource API', async () => {
		for (const mode of modes) {
			for (const method of ['search', 'get']) {
				const result = await classes[mode + 'Item'][method](countTarget('exact'), directContext());
				assert.ok(Array.isArray(result), `${mode} ${method}`);
				assert.deepStrictEqual(ids(result), ['item-2', 'item-3']);
				assert.strictEqual(result.recordCount, 4);
				assert.strictEqual(result.recordCountExact, true);
			}
		}
		for (const shape of ['Envelope', 'FrozenEnvelope']) {
			const envelope = await classes['Async' + shape].get(countTarget('estimated'), directContext());
			assert.ok(Array.isArray(envelope.data), shape);
			assert.strictEqual(envelope.data.recordCount, 4);
			assert.strictEqual(envelope.headers.get('X-Envelope'), 'true');
		}
	});

	it('returns the explain plan from the Resource API', async () => {
		for (const mode of modes) {
			for (const method of ['search', 'get']) {
				const target = Object.assign(new RequestTarget('?category=books'), { explain: true, checkPermission: true });
				const plan = await classes[mode + 'Item'][method](target, directContext());
				assert.ok(Array.isArray(plan.conditions), `${mode} ${method}`);
			}
		}
	});

	it('answers Prefer: count with the page and its Content-Range on GET and HEAD', async () => {
		// a synchronous search's count page is a promise, which an envelope's data does not await
		for (const [mode, shape] of [
			['Sync', 'Item'],
			['Async', 'Item'],
			['Async', 'Envelope'],
			['Async', 'FrozenEnvelope'],
		]) {
			for (const [prefer, accept] of [
				['count=exact', 'application/x-ndjson'],
				['count=estimated', 'application/json'],
			]) {
				for (const method of ['GET', 'HEAD']) {
					const label = `${method} ${mode}${shape} ${prefer} ${accept}`;
					const response = await request(method, `/${mode}${shape}/${page}`, { prefer, accept });
					const raw = await bodyOf(response);
					assert.strictEqual(response.status, 200, label);
					if (shape === 'Item') {
						assert.strictEqual(response.headers.get('Content-Range'), 'items 1-2/4', label);
						assert.strictEqual(response.headers.get('Preference-Applied'), prefer, label);
					} else assert.strictEqual(response.headers.get('X-Envelope'), 'true', label);
					if (method === 'GET') assert.deepStrictEqual(ids(rowsOf(raw, accept)), ['item-2', 'item-3'], label);
					else assert.strictEqual(raw, '', label);
				}
			}
		}
	});

	it('iterates a transform of a count page', async () => {
		const response = await request('GET', `/AsyncMapped/${page}`, {
			prefer: 'count=exact',
			accept: 'application/x-ndjson',
		});
		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(rowsOf(await bodyOf(response), 'application/x-ndjson'), [
			{ id: 'item-2', score: 20 },
			{ id: 'item-3', score: 30 },
		]);
	});

	it('serializes an explain plan', async () => {
		for (const mode of modes) {
			for (const accept of ['application/json', 'application/x-ndjson']) {
				for (const method of ['GET', 'HEAD']) {
					const response = await request(method, `/${mode}Explain/?category=books`, { accept });
					const raw = await bodyOf(response);
					assert.strictEqual(response.status, 200, `${method} ${mode} ${accept}`);
					if (method === 'GET') assert.ok(Array.isArray(JSON.parse(raw).conditions), `${mode} ${accept}`);
				}
			}
		}
	});

	it('releases the read snapshot of a HEAD whose serializer never starts', async () => {
		for (const mode of modes) {
			for (const shape of ['Item', 'Envelope', 'Mapped']) {
				const response = await request('HEAD', `/${mode}${shape}/?category=books`, { accept: 'application/json' });
				assert.strictEqual(response.status, 200);
				assert.strictEqual(response.body, undefined);
				await snapshotReleased(`HEAD ${mode}${shape}`);
			}
		}
	});

	it('releases the read snapshot of a transformed search answered 304 or 412', async () => {
		for (const mode of modes) {
			for (const method of ['GET', 'HEAD']) {
				for (const [headers, status] of [
					[{ 'if-none-match': '"mapped"' }, 304],
					[{ 'if-match': '"stale"' }, 412],
				]) {
					const response = await request(method, `/${mode}Mapped/?category=books`, {
						accept: 'application/json',
						...headers,
					});
					assert.strictEqual(response.status, status, `${method} ${mode}Mapped`);
					await snapshotReleased(`${status} ${method} ${mode}Mapped`);
				}
			}
		}
	});

	it('still refuses a denied or failed authorization before any status', async () => {
		for (const gate of ['Denied', 'Rejected']) {
			for (const shape of ['Item', 'Envelope', 'Mapped']) {
				for (const method of ['GET', 'HEAD']) {
					const response = await request(method, `/${gate}${shape}/${page}`, {
						prefer: 'count=exact',
						accept: 'application/json',
					});
					assert.strictEqual(response.status, 403, `${method} ${gate}${shape}`);
				}
			}
			await assert.rejects(classes[gate + 'Item'].get(countTarget('exact'), directContext()), { statusCode: 403 });
		}
	});
});
