// Caller impact of the subscribe read gate: the built-in Table.subscribe() of a `loadAsInstance = false`
// table runs allowRead before any subscription setup (v5.1.24: 2691413dd, harper#1914; main: harper#1915,
// first released in v5.2.0). Through v5.1.23 that handler ran no read check, so every subscribe refused
// on a false-mode table below was admitted. Instance-mode tables were already gated once by Resource's
// transactional wrapper and are unchanged.
const testUtils = require('../testUtils');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { AccessViolation } = require('#src/utility/errors/hdbError');
const { handleApplication: handleMqtt } = require('#src/server/mqtt');
const { handleApplication: handleRest } = require('#src/server/REST');
const { _sweepNow } = require('#src/server/liveSubscriptionAuth');
const userModule = require('#src/security/user');
const { generate, parser: mqttParser } = require('mqtt-packet');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const DATABASE = 'subscribe_read_gate';
const TABLE = 'GateRecords';

function withTablePermission(tablePermission, extra) {
	return { ...extra, role: { permission: { [DATABASE]: { tables: { [TABLE]: tablePermission } } } } };
}
// No `username`: main's live re-authorization (v5.2.0+) registers only named principals, which the
// last section covers with seeded users.
const reader = withTablePermission({
	read: true,
	insert: false,
	update: false,
	delete: false,
	attribute_permissions: [],
});
const nonReader = withTablePermission({ read: false, insert: false, update: false, delete: false });
const superUser = { role: { permission: { super_user: true } } };

const armed = (user) => ({ user, authorize: true });

// the async wrapper also catches a gate that throws synchronously (an instance-mode record already in cache)
function refused(subscribe, statusCode = 403) {
	return assert.rejects(
		async () => subscribe(),
		(error) => error instanceof AccessViolation && error.statusCode === statusCode
	);
}

async function admitted(subscriptionPromise) {
	const subscription = await subscriptionPromise;
	assert.strictEqual(typeof subscription?.[Symbol.asyncIterator], 'function', 'subscribe returned an iterable');
	subscription.end();
	return subscription;
}

// bounded, so a regression that delivers fewer events fails the assertion instead of hanging (mocha timeout is 0)
async function firstValues(subscription, count) {
	const iterator = subscription[Symbol.asyncIterator]();
	const deadline = new AbortController();
	const timedOut = delay(5000, { done: true }, { signal: deadline.signal });
	const values = [];
	try {
		while (values.length < count) {
			const next = await Promise.race([iterator.next(), timedOut]);
			if (next.done) break;
			values.push(next.value);
		}
	} finally {
		deadline.abort();
		subscription.end();
	}
	return values;
}

describe('Subscribe read gate: caller impact', () => {
	let Records;
	let FalseModeRecords;

	before(async function () {
		testUtils.setupTestDBPath();
		setMainIsWorker(true);
		await testUtils.ensureSystemTables();
		Records = table({
			table: TABLE,
			database: DATABASE,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'owner' }, { name: 'tenant' }],
		});
		await Records.put({ id: 'rec-alice', owner: 'alice', tenant: 't1' });
		await Records.put({ id: 'rec-bob', owner: 'bob', tenant: 't2' });
		FalseModeRecords = class extends Records {
			static loadAsInstance = false;
		};
	});

	describe('built-in role check (no allowRead override)', () => {
		it('a role with table read subscribes', async function () {
			await admitted(FalseModeRecords.subscribe({ omitCurrent: true }, undefined, armed(reader)));
		});

		it('a role without table read is refused with 403', async function () {
			await refused(() => FalseModeRecords.subscribe({ omitCurrent: true }, undefined, armed(nonReader)));
		});

		it('a super_user subscribes', async function () {
			await admitted(FalseModeRecords.subscribe({ omitCurrent: true }, undefined, armed(superUser)));
		});

		it('a request with no principal is refused with 401', async function () {
			await refused(() => FalseModeRecords.subscribe({ omitCurrent: true }, undefined, armed(undefined)), 401);
		});
	});

	describe('allowRead override shapes', () => {
		it('sync override returning false: refused before any event is delivered', async function () {
			let allowReadCalls = 0;
			let listenerCalled = false;
			class Denying extends FalseModeRecords {
				allowRead() {
					allowReadCalls++;
					return false;
				}
			}
			await refused(() => Denying.subscribe({ listener: () => (listenerCalled = true) }, undefined, armed(superUser)));
			assert.strictEqual(allowReadCalls, 1);
			assert.strictEqual(listenerCalled, false);
		});

		it('sync override returning true: one allowRead call, and the request is disarmed afterwards', async function () {
			let allowReadCalls = 0;
			class Allowing extends FalseModeRecords {
				allowRead() {
					allowReadCalls++;
					return true;
				}
			}
			const request = { omitCurrent: true };
			await admitted(Allowing.subscribe(request, undefined, armed(nonReader)));
			assert.strictEqual(allowReadCalls, 1);
			// v5.1.x leaves checkPermission armed after its gate; main (harper#1915) clears it so a
			// delegated read with the same request is not authorized twice.
			assert.strictEqual(request.checkPermission, false);
		});

		it('async override: the verdict is awaited', async function () {
			class AsyncDenying extends FalseModeRecords {
				async allowRead() {
					return false;
				}
			}
			class AsyncAllowing extends FalseModeRecords {
				async allowRead() {
					return true;
				}
			}
			await refused(() => AsyncDenying.subscribe({ omitCurrent: true }, undefined, armed(superUser)));
			await admitted(AsyncAllowing.subscribe({ omitCurrent: true }, undefined, armed(nonReader)));
		});

		it('throwing override: refused with AccessViolation, not the thrown error', async function () {
			// v5.1.24-v5.1.29 propagate the override's own error (a TypeError here: 500, WebSocket close 1011,
			// MQTT SUBACK 0x80); main fails closed to AccessViolation since harper#1915.
			class Throwing extends FalseModeRecords {
				allowRead(user) {
					return user.role.permission.tenants.includes('t1');
				}
			}
			class Rejecting extends FalseModeRecords {
				async allowRead() {
					throw new Error('policy service unavailable');
				}
			}
			await refused(() => Throwing.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			await refused(() => Rejecting.subscribe({ omitCurrent: true }, undefined, armed(reader)));
		});

		it('override with a missing return path refuses the users it falls through for', async function () {
			class SuperOnly extends FalseModeRecords {
				allowRead(user) {
					if (user?.role?.permission?.super_user) return true;
				}
			}
			await refused(() => SuperOnly.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			await admitted(SuperOnly.subscribe({ omitCurrent: true }, undefined, armed(superUser)));
		});

		it('override keyed on target.id: same verdict as get() per record, and a collection (no id) is refused', async function () {
			const seenIds = [];
			class OwnRecordOnly extends FalseModeRecords {
				allowRead(user, target) {
					seenIds.push(target.id);
					return target.id === `rec-${user.owns}`;
				}
			}
			const alice = { ...reader, owns: 'alice' };
			assert.strictEqual((await OwnRecordOnly.get({ id: 'rec-alice' }, armed(alice))).owner, 'alice');
			await admitted(OwnRecordOnly.subscribe({ id: 'rec-alice', omitCurrent: true }, undefined, armed(alice)));
			await refused(() => OwnRecordOnly.get({ id: 'rec-bob' }, armed(alice)));
			await refused(() => OwnRecordOnly.subscribe({ id: 'rec-bob', omitCurrent: true }, undefined, armed(alice)));
			await refused(() => OwnRecordOnly.subscribe({ omitCurrent: true }, undefined, armed(alice)));
			assert.deepStrictEqual(seenIds, ['rec-alice', 'rec-alice', 'rec-bob', 'rec-bob', undefined]);
		});

		it('override keyed on target.isCollection: whole-table subscriptions refused, record subscriptions admitted', async function () {
			class NoCollections extends FalseModeRecords {
				allowRead(_user, target) {
					return !target.isCollection;
				}
			}
			await refused(() => NoCollections.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			await admitted(NoCollections.subscribe({ id: 'rec-alice', omitCurrent: true }, undefined, armed(reader)));
		});

		it('override reading the record through `this`: no record is loaded in false mode, so get() and subscribe() both refuse', async function () {
			const seenThis = [];
			class OwnerViaThis extends FalseModeRecords {
				allowRead(user) {
					seenThis.push({ id: this.getId(), owner: this.owner, isRecords: this instanceof OwnerViaThis });
					return this.owner === user.owns;
				}
			}
			const alice = { ...reader, owns: 'alice' };
			await refused(() => OwnerViaThis.get({ id: 'rec-alice' }, armed(alice)));
			await refused(() => OwnerViaThis.subscribe({ id: 'rec-alice', omitCurrent: true }, undefined, armed(alice)));
			assert.deepStrictEqual(seenThis, [
				{ id: 'rec-alice', owner: undefined, isRecords: true },
				{ id: 'rec-alice', owner: undefined, isRecords: true },
			]);
		});

		it('instance mode: the same `this`-reading override sees the loaded record, gated once by the transactional wrapper', async function () {
			let allowReadCalls = 0;
			class InstanceOwnerViaThis extends Records {
				allowRead(user) {
					allowReadCalls++;
					return this.owner === user.owns;
				}
			}
			const alice = { ...reader, owns: 'alice' };
			await admitted(InstanceOwnerViaThis.subscribe({ id: 'rec-alice', omitCurrent: true }, undefined, armed(alice)));
			await refused(() =>
				InstanceOwnerViaThis.subscribe({ id: 'rec-bob', omitCurrent: true }, undefined, armed(alice))
			);
			assert.strictEqual(allowReadCalls, 2, 'one gate per subscribe, in the transactional wrapper');
		});

		it('override keyed on a query parameter: refused when the target has none, and an admitting parameter does not narrow delivery', async function () {
			class TenantParam extends FalseModeRecords {
				allowRead(user, target) {
					return typeof target.get === 'function' && target.get('tenant') === user.tenant;
				}
			}
			const tenantOne = { ...reader, tenant: 't1' };
			await refused(() => TenantParam.subscribe({ omitCurrent: true }, undefined, armed(tenantOne)));
			const subscription = await TenantParam.subscribe(new RequestTarget('/?tenant=t1'), undefined, armed(tenantOne));
			// subscriptions are scoped by id/path only; row narrowing needs an explicit rowFilter (harper#1915)
			const delivered = await firstValues(subscription, 2);
			assert.deepStrictEqual(delivered.map((event) => event.value.tenant).sort(), ['t1', 't2']);
		});

		it('override keyed on context.method: an in-process context carries no method', async function () {
			class HttpGetOnly extends FalseModeRecords {
				allowRead(_user, _target, context) {
					return context.method === 'GET';
				}
			}
			await refused(() => HttpGetOnly.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			await admitted(HttpGetOnly.subscribe({ omitCurrent: true }, undefined, { ...armed(reader), method: 'GET' }));
		});
	});

	describe('entry paths', () => {
		let GatedRecords;
		const seen = [];
		let routeCounter = 0;

		before(function () {
			GatedRecords = class extends FalseModeRecords {
				allowRead(user, target, context) {
					seen.push({ target, context });
					return Boolean(user?.role?.permission?.super_user);
				}
			};
			if (!Resources.resources) Resources.resetResources();
			Resources.resources.set('GateEntry', GatedRecords);
		});
		after(() => Resources.resources.delete('GateEntry'));
		beforeEach(() => (seen.length = 0));

		function restListeners() {
			const listeners = {};
			handleRest({
				resources: Resources.resources,
				options: { getAll: () => ({ webSocket: {} }) },
				routeFor: () => ({ host: undefined, urlPath: `/subscribe-read-gate-${routeCounter++}` }),
				server: {
					http: (listener) => (listeners.http = listener),
					ws: (listener) => ((listeners.ws = listener), []),
				},
			});
			return listeners;
		}

		function httpRequest(url, user, headerObject, extra) {
			return {
				method: 'GET',
				url,
				pathname: url.split('?')[0],
				ip: '127.0.0.1',
				user,
				headers: { asObject: headerObject, get: (name) => headerObject[name.toLowerCase()] },
				...extra,
			};
		}

		it('SSE: a refused event-stream GET answers 403; the override sees the URL query and method GET', async function () {
			const { http } = restListeners();
			const accept = { accept: 'text/event-stream' };
			const refusal = await http(httpRequest('/GateEntry/?tenant=t1', reader, accept), () => {});
			assert.strictEqual(refusal.status, 403);
			const [{ target, context }] = seen;
			assert.ok(target instanceof RequestTarget);
			assert.strictEqual(target.id, null);
			assert.strictEqual(target.isCollection, true);
			assert.strictEqual(target.get('tenant'), 't1');
			assert.strictEqual(context.method, 'GET');

			const stream = await http(httpRequest('/GateEntry/', superUser, accept), () => {});
			try {
				assert.strictEqual(stream.status, 200);
			} finally {
				stream.body?.destroy();
			}
		});

		it('WebSocket: a refused upgrade closes with 3003; the override sees method GET and no isCollection on a record URL', async function () {
			const { ws: wsListener } = restListeners();
			const closes = [];
			const handlers = {};
			const socket = {
				close: (code, reason) => closes.push({ code, reason }),
				send: () => {},
				on: (event, handler) => (handlers[event] = handler),
				_socket: {},
			};
			try {
				await wsListener(
					socket,
					httpRequest('/GateEntry/rec-alice', reader, {}, { isWebSocket: true }),
					Promise.resolve(undefined)
				);
			} finally {
				// the socket's own close event is what releases REST's connection count
				handlers.close?.();
			}
			assert.strictEqual(closes[0].code, 3003);
			const [{ target, context }] = seen;
			assert.strictEqual(target.id, 'rec-alice');
			assert.strictEqual(target.isCollection, undefined);
			assert.strictEqual(context.method, 'GET');
		});

		it('MQTT: a refused SUBSCRIBE gets SUBACK 0x87; the override sees no topic query and a session context without method', async function () {
			let listener;
			const server = {
				ws: (fn) => ((listener = fn), []),
				socket: () => ({}),
				mqtt: { sessions: new Set(), events: new EventEmitter() },
			};
			handleMqtt({ options: { getAll: () => ({ webSocket: {} }) }, server });
			const socket = { sends: [], handlers: {}, _socket: { remoteAddress: '127.0.0.1' } };
			socket.close = () => {};
			socket.terminate = () => {};
			socket.send = (message) => socket.sends.push(message);
			socket.on = (event, handler) => (socket.handlers[event] = handler);
			const headers = { 'sec-websocket-protocol': 'mqtt' };
			listener(
				socket,
				{ headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user: reader },
				Promise.resolve({ status: 200 }),
				() => {}
			);
			const topics = ['GateEntry/#', 'GateEntry/rec-alice', 'GateEntry/?tenant=t1'];
			let suback;
			try {
				socket.handlers.message(
					Buffer.concat([
						generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId: 'gate-mqtt', clean: true }),
						generate(
							{ cmd: 'subscribe', messageId: 1, subscriptions: topics.map((topic) => ({ topic, qos: 0 })) },
							{ protocolVersion: 5 }
						),
					])
				);
				suback = await waitFor(() => {
					const packets = [];
					const parser = mqttParser({ protocolVersion: 5 });
					parser.on('packet', (packet) => packets.push(packet));
					for (const sent of socket.sends) parser.parse(sent);
					return packets.find((packet) => packet.cmd === 'suback');
				});
			} finally {
				socket.handlers.close?.();
			}
			assert.deepStrictEqual(suback.granted, [0x87, 0x87, 0x87]);
			assert.deepStrictEqual(
				seen.map(({ target }) => [target.id, target.isCollection, target.get('tenant')]),
				[
					[null, true, null],
					['rec-alice', false, null],
					[null, false, null],
				]
			);
			for (const { context } of seen) {
				assert.ok(context.session, 'an MQTT session context');
				assert.strictEqual(context.method, undefined);
				// present only because this session rides a WebSocket upgrade; an MQTT-over-TCP session has none
				assert.strictEqual(context.headers.get('sec-websocket-protocol'), 'mqtt');
			}
		});

		it('in-process: armed by context.authorize or by target.checkPermission; an unarmed call skips the gate', async function () {
			await refused(() => GatedRecords.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			await refused(() =>
				GatedRecords.subscribe({ omitCurrent: true, checkPermission: reader.role.permission }, undefined, {
					user: reader,
				})
			);
			assert.strictEqual(seen.length, 2);
			await admitted(GatedRecords.subscribe({ omitCurrent: true }, undefined, { user: reader }));
			await admitted(GatedRecords.subscribe({ omitCurrent: true }));
			assert.strictEqual(seen.length, 2);
		});

		it('in-process: a plain { user, authorize } object as the second argument is not a context, so the gate does not run', async function () {
			await admitted(GatedRecords.subscribe({ omitCurrent: true }, armed(reader)));
			assert.strictEqual(seen.length, 0);
		});
	});

	describe('custom handlers on a false-mode table', () => {
		let allowReadCalls;
		let DenyingRecords;

		before(function () {
			DenyingRecords = class extends FalseModeRecords {
				allowRead() {
					allowReadCalls++;
					return false;
				}
			};
		});
		beforeEach(() => (allowReadCalls = 0));

		it('a subscribe() override that never calls super owns authorization: allowRead is not consulted', async function () {
			class OwnFeed extends DenyingRecords {
				subscribe() {
					return Records.subscribe({ omitCurrent: true });
				}
			}
			await admitted(OwnFeed.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			assert.strictEqual(allowReadCalls, 0);
		});

		it('a subscribe() override delegating with a fresh request: allowRead is not consulted', async function () {
			class FreshRequest extends DenyingRecords {
				subscribe(request) {
					return super.subscribe({ id: request.id, omitCurrent: true });
				}
			}
			await admitted(FreshRequest.subscribe({ omitCurrent: true }, undefined, armed(reader)));
			assert.strictEqual(allowReadCalls, 0);
		});

		it('a subscribe() override delegating the armed request: refused', async function () {
			class Delegating extends DenyingRecords {
				subscribe(request) {
					request.omitCurrent = true;
					return super.subscribe(request);
				}
			}
			await refused(() => Delegating.subscribe({}, undefined, armed(reader)));
			assert.strictEqual(allowReadCalls, 1);
		});

		it('a connect() override delegating to super.connect (the SSE/WebSocket path): refused', async function () {
			class Connecting extends DenyingRecords {
				connect(target, incomingMessages) {
					target.omitCurrent = true;
					return super.connect(target, incomingMessages);
				}
			}
			await refused(() => Connecting.connect(new RequestTarget('/'), null, armed(reader)));
			assert.strictEqual(allowReadCalls, 1);
		});

		it('a false-mode resource forwarding its armed request to this table: refused by this table’s gate', async function () {
			const { Resource } = require('#src/resources/Resource');
			class Proxy extends Resource {
				static loadAsInstance = false;
				subscribe(request) {
					request.omitCurrent = true;
					return DenyingRecords.subscribe(request);
				}
			}
			await refused(() => Proxy.subscribe({}, undefined, armed(reader)));
			assert.strictEqual(allowReadCalls, 1);
		});
	});

	// since v5.2.0; v5.1.x has no live re-authorization
	describe('live re-authorization', () => {
		const ROLE_ID = 'subscribe_read_gate_role';
		let grant;
		let Revocable;

		before(async function () {
			Revocable = class extends FalseModeRecords {
				allowRead() {
					return grant;
				}
			};
			await testUtils.seedUsers([
				{
					username: 'subscribe_read_gate_user',
					active: true,
					role: {
						id: ROLE_ID,
						role: ROLE_ID,
						permission: {
							super_user: false,
							[DATABASE]: {
								tables: {
									[TABLE]: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
								},
							},
						},
					},
				},
			]);
		});
		after(() => testUtils.seedUsers());
		beforeEach(() => (grant = true));

		async function revokedBySweep(subscription) {
			await _sweepNow();
			assert.strictEqual(subscription.closed, false, 'still authorized');
			grant = false;
			await _sweepNow();
			assert.strictEqual(subscription.closed, true, 'ended by the recheck');
		}

		it('an admitted subscription ends when a later recheck of the same allowRead denies', async function () {
			const user = await userModule.findAndValidateUser('subscribe_read_gate_user', undefined, false);
			const subscription = await Revocable.subscribe({ omitCurrent: true }, undefined, armed(user));
			await revokedBySweep(subscription);
		});

		it('an unarmed in-process subscription with a named principal is not gated at admission, but is rechecked', async function () {
			const user = await userModule.findAndValidateUser('subscribe_read_gate_user', undefined, false);
			grant = false;
			const subscription = await Revocable.subscribe({ omitCurrent: true }, undefined, { user });
			grant = true;
			await revokedBySweep(subscription);
		});
	});
});
