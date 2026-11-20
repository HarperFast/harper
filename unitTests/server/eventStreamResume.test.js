const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils.js');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { transaction } = require('#src/resources/transaction');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { membersDigest } = require('#src/resources/subscriptionCheckpoint');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { handleApplication } = require('#src/server/REST');
const { Headers } = require('#src/server/serverHelpers/Headers');
const { setEventStreamCheckpointIntervalForTests } = require('#src/server/serverHelpers/eventStreamResume');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { EVENT_STREAM_CURSOR, tableEventSerializer } = require('#src/server/serverHelpers/eventStreamIds');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const admin = { role: { permission: { super_user: true } } };
const SCALAR_ID = isRocksDB ? /^\d+(\.\d+)?@[0-9a-f]{32}\.[0-9a-f]{16}$/ : /^\d+(\.\d+)?$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{40,}$/;
let sequence = 0;

function tableInOwnDatabase() {
	const name = `EventStream${++sequence}`;
	return table({
		table: name,
		database: `event_stream_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

function rest(resources) {
	let handler;
	handleApplication({
		resources,
		options: { getAll: () => ({ webSocket: false }) },
		routeFor: () => ({ urlPath: `/event-stream-resume-${sequence++}` }),
		server: { http: (listener) => (handler = listener) },
	});
	const send = (url, headers = {}) => {
		const request = (send.last = { method: 'GET', url, user: admin, headers: new Headers(headers) });
		request.headers.asObject = headers;
		return handler(request, () => ({ status: 404 }));
	};
	return send;
}

function parseFrame(text) {
	const frame = {};
	for (const line of text.split('\n')) {
		const colon = line.indexOf(':');
		const field = line.slice(0, colon);
		const value = line.slice(colon + 1).replace(/^ /, '');
		if (field === 'data') frame.data = JSON.parse(value);
		else if (field) frame[field] = value;
	}
	return frame;
}

const open = [];
async function connect(request, url, lastEventId) {
	const headers = { accept: 'text/event-stream' };
	if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
	const response = await request(url, headers);
	const stream = { status: response.status, frames: [], lastEventId, close() {} };
	if (typeof response.body?.on !== 'function') {
		stream.frames.push(parseFrame(String(response.body ?? '').trim()));
		return stream;
	}
	let buffer = '';
	response.body.on('data', (chunk) => {
		buffer += chunk;
		for (let end; (end = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(end + 2)) {
			const frame = parseFrame(buffer.slice(0, end));
			if (frame.id !== undefined) stream.lastEventId = frame.id;
			stream.frames.push(frame);
		}
	});
	response.body.on('error', () => {});
	stream.ended = new Promise((resolve) => response.body.on('close', resolve));
	stream.close = () => response.body.destroy();
	stream.values = () => stream.frames.map((frame) => frame.data?.value?.value).filter((value) => value !== undefined);
	stream.frameOf = (value) => stream.frames.find((frame) => frame.data?.value?.value === value);
	stream.tokens = () => stream.frames.filter((frame) => frame.data === undefined && TOKEN_ID.test(frame.id ?? ''));
	open.push(stream);
	return stream;
}

function decodeToken(id) {
	return JSON.parse(Buffer.from(id, 'base64url').toString());
}

function encodeToken(checkpoint) {
	return Buffer.from(JSON.stringify(checkpoint)).toString('base64url');
}

/** One certification round, as the maintenance tick runs it. */
function certify(T) {
	const rootStore = T.primaryStore.rootStore;
	// a floor certifies only once synced; the pinned engine may predate syncWal, so the tick's sync is stood in for
	if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
	let floor = certifyOriginFloor(rootStore);
	for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
	if (floor) {
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
	}
	return getOriginClosedFloor(rootStore)?.floor ?? 0;
}

async function certifiedToken(T, stream) {
	await sleep(2);
	const floor = certify(T);
	let id;
	await waitFor(() => {
		id = stream.tokens().findLast((frame) => decodeToken(frame.id).time >= floor)?.id;
		return id;
	}, 15_000);
	return id;
}

// its writes take its log key now, so it commits below whatever commits before the returned function is called
async function heldTransaction(T, ...ids) {
	let commit;
	const committed = transaction({}, async (context) => {
		for (const id of ids) await T.put(id, { value: id }, context);
		await new Promise((resolve) => (commit = resolve));
	});
	await waitFor(() => commit);
	return () => {
		commit();
		return committed;
	};
}

describe('Table event stream resume (harper#515)', function () {
	let resources, request;
	function served(Class) {
		const path = `Served${++sequence}`;
		resources.set(path, Class, { rest: true, sse: true });
		return `/${path}/`;
	}
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setOriginCaptureIntervalForTests(100);
		setEventStreamCheckpointIntervalForTests(1000);
		resources = new Resources();
		request = rest(resources);
	});
	after(() => {
		setOriginCaptureIntervalForTests();
		setEventStreamCheckpointIntervalForTests();
	});
	afterEach(() => {
		for (const stream of open.splice(0)) stream.close();
	});

	it('gives each logged event its log key as the id, and a snapshot row none', async () => {
		const T = tableInOwnDatabase();
		const url = served(T);
		await T.put('seed', { value: 'seed' });
		const stream = await connect(request, url);
		assert.strictEqual(stream.status, 200);
		await waitFor(() => stream.frameOf('seed'));
		await T.put('a', { value: 'a' });
		await waitFor(() => stream.frameOf('a'));
		assert.strictEqual(stream.frameOf('seed').data.fromScan, true);
		assert.strictEqual(stream.frameOf('seed').id, undefined);
		const frame = stream.frameOf('a');
		assert.match(frame.id, SCALAR_ID);
		assert.strictEqual(Number(frame.id.split('@')[0]), frame.data.localTime, 'the id round-trips the fractional key');
		assert.deepStrictEqual(Object.keys(frame).sort(), ['data', 'id'], 'the data line is the event, as before');
	});

	it('resumes from a scalar id, redelivering its own event and every one after it', async () => {
		const T = tableInOwnDatabase();
		const url = served(T);
		const first = await connect(request, url);
		await T.put('a', { value: 'a' });
		await waitFor(() => first.frameOf('a'));
		const id = first.lastEventId;
		first.close();
		await T.put('b', { value: 'b' });
		await T.put('c', { value: 'c' });
		const resumed = await connect(request, url, id);
		assert.strictEqual(resumed.status, 200);
		await waitFor(() => resumed.frameOf('c'));
		assert.deepStrictEqual(resumed.values(), ['a', 'b', 'c']);
		assert.ok(
			resumed.frames.every((frame) => !frame.data?.fromScan),
			'a resume replays the log and takes no snapshot'
		);
	});

	it('refuses an id it did not issue with 400, before any event', async () => {
		const url = served(tableInOwnDatabase());
		for (const id of [
			'not an id',
			'abc',
			encodeToken({ v: 2 }),
			encodeToken(null),
			'0',
			'12@short',
			'A'.repeat(5000),
		]) {
			const stream = await connect(request, url, id);
			assert.strictEqual(stream.status, 400, id.slice(0, 20));
		}
		// a repeated header, as uWS hands it over
		const repeated = await request(url, { 'accept': 'text/event-stream', 'last-event-id': ['12', '13'] });
		assert.strictEqual(repeated.status, 400);
	});

	it('passes the header to a custom resource as request.lastEventId, and reads none of it', async () => {
		const seen = [];
		class Feed extends Resource {
			static loadAsInstance = false;
			static async *connect(_target, _incomingMessages, context) {
				seen.push(['connect', context.lastEventId]);
				yield { event: 'turn', data: { n: 1 }, id: 'turn-1' };
			}
			static async *get(_target, context) {
				seen.push(['get', context.lastEventId]);
				yield { event: 'turn', data: { n: 1 }, id: 'turn-1' };
			}
		}
		const url = served(Feed);
		const stream = await connect(request, url, 'turn-0');
		await stream.ended;
		assert.deepStrictEqual(stream.frames, [{ event: 'turn', data: { n: 1 }, id: 'turn-1' }]);
		// an Accept list negotiates the event stream for an ordinary GET
		const response = await request(url, {
			'accept': 'text/event-stream, application/json;q=0.5',
			'last-event-id': '7',
		});
		assert.strictEqual(response.headers.get('Content-Type'), 'text/event-stream');
		for await (const _chunk of response.body);
		await request(url, { accept: 'text/event-stream' });
		await request(url, { 'accept': 'text/event-stream', 'last-event-id': ['a', 'b'] });
		assert.deepStrictEqual(seen, [
			['connect', 'turn-0'],
			['get', '7'],
			['connect', undefined],
			['connect', 'a, b'],
		]);
	});

	it('leaves a table subclass that overrides subscribe or connect alone, however it declares the override', async () => {
		const T = tableInOwnDatabase();
		const requests = [];
		const seen = (subscriptionRequest) => requests.push({ ...subscriptionRequest });
		const overriding = {
			'a subscribe method': class extends T {
				subscribe(subscriptionRequest) {
					seen(subscriptionRequest);
					return super.subscribe(subscriptionRequest);
				}
			},
			'a subscribe field': class extends T {
				subscribe = (subscriptionRequest) => {
					seen(subscriptionRequest);
					return T.prototype.subscribe.call(this, subscriptionRequest);
				};
			},
			'a connect method': class extends T {
				connect(target, incomingMessages) {
					seen(incomingMessages ?? target);
					return super.connect(target, incomingMessages);
				}
			},
			'a connect field': class extends T {
				connect = (target, incomingMessages) => {
					seen(incomingMessages ?? target);
					return Resource.prototype.connect.call(this, target, incomingMessages);
				};
			},
			'a static connect': class extends T {
				static connect(target, incomingMessages, context) {
					seen(target);
					return super.connect(target, incomingMessages, context);
				}
			},
		};
		for (const [override, Class] of Object.entries(overriding)) {
			// its own id format is not ours to refuse
			const stream = await connect(request, served(Class), 'application-cursor-17');
			assert.strictEqual(stream.status, 200, override);
			await T.put(override, { value: override });
			await waitFor(() => stream.frameOf(override));
			assert.strictEqual(stream.frameOf(override).id, undefined, override);
			const subscriptionRequest = requests.pop();
			assert.strictEqual(subscriptionRequest.reportProgress, undefined, override);
			assert.strictEqual(subscriptionRequest.startTime, undefined, override);
			stream.close();
		}
		// a subclass that overrides neither keeps the table's own stream
		const inherited = await connect(request, served(class extends T {}), 'application-cursor-17');
		assert.strictEqual(inherited.status, 400);
	});

	it('leaves a table stream that another resource opens with the request alone', async () => {
		const T = tableInOwnDatabase();
		const delegating = {
			'a new target': class extends Resource {
				connect() {
					return T.connect(new RequestTarget(), null, this.getContext());
				}
			},
			'the request target': class extends Resource {
				static loadAsInstance = false;
				connect(target) {
					return T.connect(target, null, this.getContext());
				}
			},
			// its Collection class is the receiver of a collection request only, and this one is keyed
			'its own Collection class': class extends T {
				static loadAsInstance = false;
				static Collection = class extends T {
					static loadAsInstance = false;
				};
				connect(target) {
					return this.constructor.Collection.connect(target, null, this.getContext());
				}
			},
		};
		for (const [passing, Class] of Object.entries(delegating)) {
			const keyed = passing === 'its own Collection class' ? passing : '';
			const stream = await connect(request, served(Class) + keyed, 'application-cursor-17');
			assert.strictEqual(stream.status, 200, passing);
			assert.strictEqual(request.last[EVENT_STREAM_CURSOR], undefined, passing);
			await T.put(passing, { value: passing });
			await waitFor(() => stream.frameOf(passing));
			assert.strictEqual(stream.frameOf(passing).id, undefined, passing);
			stream.close();
		}
	});

	it('still resumes the request when its authorization opened other streams first', async () => {
		const T = tableInOwnDatabase();
		const Other = tableInOwnDatabase();
		class Checking extends T {
			async allowRead(_user, _target, context) {
				for (const Table of [Other, T]) (await Table.connect(new RequestTarget(), null, context)).end();
				return true;
			}
		}
		const url = served(Checking);
		const first = await connect(request, url);
		await T.put('a', { value: 'a' });
		await waitFor(() => first.frameOf('a'));
		const id = first.lastEventId;
		assert.match(id, SCALAR_ID);
		first.close();
		await T.put('b', { value: 'b' });
		const resumed = await connect(request, url, id);
		await waitFor(() => resumed.frameOf('b'));
		assert.deepStrictEqual(resumed.values(), ['a', 'b']);
	});

	it('leaves a stream alone when the path chooses another format than the event stream', async () => {
		const T = tableInOwnDatabase();
		const url = served(T);
		await T.put('a', { value: 'a' });
		const response = await request(`${url}a.json`, { accept: 'text/event-stream' });
		assert.strictEqual(response.headers.get('Content-Type'), 'application/json');
		assert.strictEqual(request.last[EVENT_STREAM_CURSOR], undefined);
		response.body.destroy?.();
		await connect(request, url);
		assert.ok(request.last[EVENT_STREAM_CURSOR]);
	});

	describe('the per-event serializer', () => {
		const serialize = (message) => JSON.stringify(message);
		it('withholds scalar ids until a checked resume is verified, and never writes to the event', async () => {
			let verify;
			const subscription = { resumeVerified: new Promise((resolve) => (verify = resolve)), databaseGeneration: 'g' };
			const serializeEvent = tableEventSerializer(subscription, { holdsToken: false, logKeyScope: '@g' }, serialize);
			const event = Object.freeze({ id: 'a', localTime: 5.5, value: {} });
			assert.strictEqual(serializeEvent(event), serialize(event));
			verify(true);
			await subscription.resumeVerified;
			assert.strictEqual(serializeEvent(event), serialize({ data: event, id: '5.5@g' }));
		});
		it('withholds a token too long for a request header, and issues no scalar id after a token', () => {
			const cursor = { holdsToken: false, logKeyScope: '' };
			const serializeEvent = tableEventSerializer({}, cursor, serialize);
			const exceptions = {};
			for (let i = 0; i < 200; i++) exceptions[`origin-${i}-${'x'.repeat(20)}`] = i;
			assert.strictEqual(serializeEvent({ type: 'checkpoint', checkpoint: { v: 1, exceptions } }), ':\n\n');
			assert.strictEqual(cursor.holdsToken, false);
			const event = { id: 'a', localTime: 7, value: {} };
			assert.strictEqual(serializeEvent(event), serialize({ data: event, id: '7' }));
			assert.match(serializeEvent({ type: 'checkpoint', checkpoint: { v: 1 } }), /^id: [A-Za-z0-9_-]+\n\n$/);
			assert.strictEqual(cursor.holdsToken, true);
			assert.strictEqual(serializeEvent(event), serialize(event));
		});
		it('issues no log key where the engine has generations and this database has none to name', () => {
			const serializeEvent = tableEventSerializer({}, { holdsToken: false, logKeyScope: undefined }, serialize);
			const event = { id: 'a', localTime: 7, value: {} };
			assert.strictEqual(serializeEvent(event), serialize(event));
		});
	});

	describe('a stream that fails', () => {
		const { serialize } = require('#src/server/serverHelpers/contentTypes');
		function serialized(source, method = 'POST') {
			const context = { method, headers: new Headers({}) };
			context.headers.asObject = { accept: 'text/event-stream' };
			context[EVENT_STREAM_CURSOR] = { holdsToken: false, logKeyScope: '' };
			return serialize(source, context, { headers: new Headers() });
		}
		async function framesOf(body) {
			let text = '';
			for await (const chunk of body) text += chunk;
			return text.trim().split('\n\n').map(parseFrame);
		}
		it('keeps the id when the source throws', async () => {
			const frames = await framesOf(
				serialized(
					(async function* () {
						yield { id: 'a', localTime: 7, value: { value: 'a' } };
						throw new Error('transient');
					})()
				)
			);
			assert.strictEqual(frames[0].id, '7');
			assert.strictEqual(frames[1].event, 'harper-error');
			assert.strictEqual(frames[1].id, undefined);
		});
		it('ends with harper-error, id kept, when the subscription closes with an error that voids no position', async () => {
			const queue = new IterableEventQueue();
			queue.send({ id: 'a', localTime: 7, value: { value: 'a' } });
			const frames = framesOf(serialized(queue));
			await sleep(10);
			// what a subscription closes with need not be an Error
			const unavailable = { message: 'The transaction log could not be read', statusCode: 503 };
			queue.close(unavailable);
			assert.deepStrictEqual(
				(await frames).map((frame) => [frame.event, frame.id, frame.data.status]),
				[
					[undefined, '7', undefined],
					['harper-error', undefined, 503],
				]
			);
		});
		it('still sends the error frame of a first step that failed after the status went out, before the first read', async () => {
			const { waitForStreamStartup } = require('#src/server/serverHelpers/contentTypes');
			const { ResumeHistoryUnavailableError } = require('#src/utility/errors/hdbError');
			const queue = new IterableEventQueue();
			const body = serialized(queue, 'GET');
			await waitForStreamStartup(body);
			queue.close(new ResumeHistoryUnavailableError());
			await sleep(10);
			const frames = await framesOf(body);
			assert.deepStrictEqual(
				frames.map((frame) => [frame.event, frame.id, frame.data.status]),
				[['harper-error', '', 410]]
			);
		});
	});

	describe('on RocksDB', function () {
		if (!isRocksDB) return;

		it('issues the checkpoint token as a frame with only an id, then no scalar id', async () => {
			const T = tableInOwnDatabase();
			const stream = await connect(request, served(T));
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			const id = await certifiedToken(T, stream);
			assert.strictEqual(decodeToken(id).v, 1);
			assert.strictEqual(stream.lastEventId, id);
			await T.put('b', { value: 'b' });
			await waitFor(() => stream.frameOf('b'));
			assert.strictEqual(stream.frameOf('b').id, undefined, 'a scalar id would replace the token the client holds');
		});

		it('resumes from the token with a transaction that committed below it, which a scalar id skips', async () => {
			const T = tableInOwnDatabase();
			const url = served(T);
			const first = await connect(request, url);
			const commitLate = await heldTransaction(T, 'late');
			await T.put('early', { value: 'early' });
			await waitFor(() => first.frameOf('early'));
			const scalarId = first.lastEventId;
			const token = await certifiedToken(T, first);
			first.close();
			await commitLate();
			await T.put('after', { value: 'after' });

			const resumed = await connect(request, url, token);
			assert.strictEqual(resumed.status, 200);
			await waitFor(() => resumed.frameOf('after'));
			assert.ok(resumed.frameOf('late'), 'the token waited for the open transaction');
			assert.ok(resumed.frameOf('late').data.localTime < resumed.frameOf('early').data.localTime);
			assert.ok(
				resumed.frames.every((frame) => frame.data === undefined || frame.id === undefined),
				'a stream resumed from a token issues no scalar id'
			);

			const scalar = await connect(request, url, scalarId);
			await waitFor(() => scalar.frameOf('after'));
			assert.strictEqual(scalar.frameOf('late'), undefined, 'the scalar position is already past its key');
		});

		it('resumes a transaction cut after its first record with every record of it', async () => {
			const T = tableInOwnDatabase();
			const url = served(T);
			const first = await connect(request, url);
			await transaction({}, async (context) => {
				await T.put('x', { value: 'x' }, context);
				await T.put('y', { value: 'y' }, context);
			});
			await waitFor(() => first.frameOf('y'));
			assert.strictEqual(first.frameOf('x').id, first.frameOf('y').id, 'both records carry the transaction key');
			const resumed = await connect(request, url, first.frameOf('x').id);
			await waitFor(() => resumed.frameOf('y'));
			assert.deepStrictEqual(resumed.values(), ['x', 'y']);
		});

		it('refuses a token of another table with 409 and of another origin set with 410', async () => {
			const T = tableInOwnDatabase();
			const stream = await connect(request, served(T));
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			const token = await certifiedToken(T, stream);
			const otherTable = await connect(request, served(tableInOwnDatabase()), token);
			assert.strictEqual(otherTable.status, 409);
			const foreign = encodeToken({ ...decodeToken(token), members: membersDigest([['someone-else', 'g']]) });
			const refused = await connect(request, served(T), foreign);
			assert.strictEqual(refused.status, 410);
			assert.strictEqual(refused.frames[0].data.code, 'RESUME_HISTORY_UNAVAILABLE');
		});

		it('refuses a log key of another database generation, or with none, with 409', async () => {
			const T = tableInOwnDatabase();
			const url = served(T);
			const stream = await connect(request, url);
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			const [key, scope] = stream.lastEventId.split('@');
			const [generation, table] = scope.split('.');
			// another database generation, no generation, another table or incarnation of it
			for (const id of [`${key}@${'f'.repeat(32)}.${table}`, key, `${key}@${generation}.0123456789abcdef`]) {
				const refused = await connect(request, url, id);
				assert.strictEqual(refused.status, 409, id);
				assert.strictEqual(refused.frames[0].data.code, 'DATABASE_GENERATION_CHANGED');
			}
		});

		it('answers a refusal the replay finds before its first event with the status, not a stream', async () => {
			const T = tableInOwnDatabase();
			const url = served(T);
			const stream = await connect(request, url);
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			const id = stream.lastEventId;
			stream.close();
			await T.writeReloadMarker();
			// the write the id came from is superseded, so the marker is the first entry the replay acts on
			await T.put('a', { value: 'again' });
			const refused = await connect(request, url, id);
			assert.strictEqual(refused.status, 410);
			assert.strictEqual(refused.frames[0].data.code, 'RESUME_HISTORY_UNAVAILABLE');
		});

		it('ends a stream whose position is voided with harper-error and an empty id', async () => {
			const T = tableInOwnDatabase();
			const stream = await connect(request, served(T));
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			assert.match(stream.lastEventId, SCALAR_ID);
			// a base copy back-fills rows with no history, so no position can pass its marker
			await T.writeReloadMarker();
			await stream.ended;
			const last = stream.frames.at(-1);
			assert.strictEqual(last.event, 'harper-error');
			assert.strictEqual(last.data.status, 410);
			assert.strictEqual(last.id, '', 'an EventSource reconnects without Last-Event-ID');
			assert.strictEqual(stream.lastEventId, '');
		});
	});

	describe('on LMDB', function () {
		if (isRocksDB) return;

		it('issues bare scalar ids and no token, and refuses a token with 409', async () => {
			const T = tableInOwnDatabase();
			const url = served(T);
			const stream = await connect(request, url);
			await T.put('a', { value: 'a' });
			await waitFor(() => stream.frameOf('a'));
			await T.put('b', { value: 'b' });
			await waitFor(() => stream.frameOf('b'));
			assert.match(stream.frameOf('a').id, /^\d+(\.\d+)?$/);
			assert.match(stream.frameOf('b').id, /^\d+(\.\d+)?$/);
			assert.deepStrictEqual(stream.tokens(), []);
			const token = encodeToken({
				v: 1,
				scope: 'x',
				time: 1,
				overlap: 0,
				exceptions: {},
				members: 'a'.repeat(64),
			});
			assert.strictEqual((await connect(request, url, token)).status, 409);
			// a RocksDB log key names a database generation, which this engine has none of
			assert.strictEqual((await connect(request, url, `1@${'a'.repeat(32)}.${'b'.repeat(16)}`)).status, 409);
		});
	});
});
