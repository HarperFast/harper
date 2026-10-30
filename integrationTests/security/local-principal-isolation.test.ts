/**
 * Local trust is a principal, not a stored user (harper#3755).
 *
 * A request trusted by its transport (authorizeLocal from 127.x/::1, loopback raw-TCP MQTT) runs as the
 * `local` super user, recognized only by a `_localPrincipal: true` marker set by trusted server code.
 * Nothing in a request from a non-loopback source address may become that principal: not a forwarding
 * header, not a body-supplied `hdb_user`, not the pre-auth header, not a replayed session cookie, not a
 * token minted from a loopback request, not a stored user or token named `local`.
 *
 * Setup: Harper's HTTP/operations/MQTT listeners are bound to a non-loopback address of this host
 * (HARPER_TEST_NON_LOOPBACK_ADDRESS, else the first external IPv4 interface; the suite is skipped when there
 * is none). A "loopback" request is sent to that address with localAddress = the harness 127.0.0.x address
 * (the peer then reads as 127.0.0.x); a "remote" one with localAddress = the same non-loopback address.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/local-principal-isolation.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import mqttPacket from 'mqtt-packet';
import WebSocket from 'ws';

const FIXTURE_PATH = resolve(import.meta.dirname, 'local-principal-isolation');
const REPEAT = 12;

function externalIPv4(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('127.')) return address.address;
		}
	}
}

const REMOTE_ADDRESS = process.env.HARPER_TEST_NON_LOOPBACK_ADDRESS ?? externalIPv4() ?? '';
const skipReason: string | false =
	process.env.HARPER_RUNTIME === 'bun'
		? 'Bun/uWS trusts the pre-auth header, so the Node-side isolation asserted here does not apply'
		: process.platform !== 'linux'
			? 'a 127.0.0.x client source reaches a local non-loopback listener only on Linux'
			: !REMOTE_ADDRESS
				? 'no non-loopback IPv4 address on this host; set HARPER_TEST_NON_LOOPBACK_ADDRESS'
				: false;

const note = (what: string, value: unknown) => console.log(`[local-principal] ${what}: ${JSON.stringify(value)}`);
const generatedPassword = () => `Qa-${randomBytes(9).toString('base64url')}-1!`;
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const isLoopback = (ip: string) => /^(127\.|::1$|::ffff:127\.)/.test(ip);

type Source = 'loopback' | 'remote';
interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	text: string;
	json: any;
}

interface Ports {
	http: number;
	ops: number;
	mqtt: number;
}

/** Free ports on the non-loopback address; all are held open together so they are distinct. */
async function freePorts(): Promise<Ports> {
	const servers = await Promise.all(
		[0, 1, 2].map(
			() =>
				new Promise<{ close(): void; port: number }>((resolvePromise, reject) => {
					const server = createServer();
					server.on('error', reject);
					server.listen(0, REMOTE_ADDRESS, () =>
						resolvePromise({ port: (server.address() as { port: number }).port, close: () => server.close() })
					);
				})
		)
	);
	for (const server of servers) server.close();
	return { http: servers[0].port, ops: servers[1].port, mqtt: servers[2].port };
}

function startConfig(ports: Ports, requireAuthentication: boolean) {
	return {
		authentication: { authorizeLocal: true, enableSessions: true },
		threads: { count: 2 },
		http: { port: `${REMOTE_ADDRESS}:${ports.http}` },
		operationsApi: { network: { port: `${REMOTE_ADDRESS}:${ports.ops}` } },
		mqtt: { network: { port: `${REMOTE_ADDRESS}:${ports.mqtt}`, securePort: null }, requireAuthentication },
	};
}

/** One HTTP exchange on a fresh connection, from a chosen source address. */
function send(
	ctx: ContextWithHarper,
	source: Source,
	port: number,
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Reply> {
	const localAddress = source === 'remote' ? REMOTE_ADDRESS : ctx.harper.hostname;
	const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
	const headers: Record<string, string> = { Connection: 'close', ...options.headers };
	if (payload !== undefined) {
		headers['Content-Type'] = 'application/json';
		headers['Content-Length'] = String(Buffer.byteLength(payload));
	}
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{
				host: REMOTE_ADDRESS,
				port,
				localAddress,
				path,
				method: options.method ?? (payload === undefined ? 'GET' : 'POST'),
				headers,
				agent: false,
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => {
					let json: any;
					try {
						json = text ? JSON.parse(text) : undefined;
					} catch {}
					resolvePromise({ status: res.statusCode!, headers: res.headers, text, json });
				});
			}
		);
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`no response for ${path}`)));
		req.end(payload);
	});
}

const basic = (username: string, password: string) =>
	'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

/** The session id in a Set-Cookie; the cookie name is partitioned by the request's Host (<address with the first dot as _>:<port>-hdb-session). */
function sessionIdOf(reply: Reply): string | undefined {
	const set = reply.headers['set-cookie'];
	const first = Array.isArray(set) ? set[0] : set;
	return first?.match(/hdb-session=([^;]+)/)?.[1];
}

/** The cookie a client holding session `id` sends to the listener on `port`. */
const cookieFor = (id: string, port: number) => `${REMOTE_ADDRESS.replace(/\W/, '_')}:${port}-hdb-session=${id}`;

async function repeated<T>(count: number, run: () => Promise<T>): Promise<T[]> {
	const out: T[] = [];
	for (let at = 0; at < count; at += 4) {
		out.push(...(await Promise.all(Array.from({ length: Math.min(4, count - at) }, run))));
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// A minimal MQTT 5 client over a raw socket or a WebSocket, so the source address and every reason code
// are under the test's control.

interface MqttLink {
	write(buffer: Buffer): void;
	close(): void;
}

class MqttClientLite {
	packets: any[] = [];
	closed = false;
	#waiters: (() => void)[] = [];
	#parser = mqttPacket.parser({ protocolVersion: 5 });
	link!: MqttLink;

	constructor() {
		this.#parser.on('packet', (packet: any) => {
			this.packets.push(packet);
			this.#wake();
		});
		this.#parser.on('error', (error: Error) => {
			this.packets.push({ cmd: 'parse-error', message: error.message });
			this.#wake();
		});
	}

	#wake() {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}

	feed(buffer: Buffer) {
		this.#parser.parse(buffer);
	}

	markClosed() {
		this.closed = true;
		this.#wake();
	}

	send(packet: any) {
		this.link.write(mqttPacket.generate(packet, { protocolVersion: 5 }) as Buffer);
	}

	/** The first packet of one of `cmds`, or 'closed' / 'timeout'. */
	async next(cmds: string[], ms = 8_000): Promise<any> {
		const deadline = Date.now() + ms;
		for (;;) {
			const at = this.packets.findIndex((packet) => cmds.includes(packet.cmd));
			if (at >= 0) return this.packets.splice(at, 1)[0];
			if (this.closed) return { cmd: 'closed' };
			const remaining = deadline - Date.now();
			if (remaining <= 0) return { cmd: 'timeout' };
			await new Promise<void>((resolveWait) => {
				const timer = setTimeout(resolveWait, remaining);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolveWait();
				});
			});
		}
	}
}

function openMqtt(kind: 'tcp' | 'ws', source: Source, ctx: ContextWithHarper, ports: Ports): Promise<MqttClientLite> {
	const localAddress = source === 'remote' ? REMOTE_ADDRESS : ctx.harper.hostname;
	const client = new MqttClientLite();
	return new Promise((resolvePromise, reject) => {
		if (kind === 'tcp') {
			const socket = createConnection({ host: REMOTE_ADDRESS, port: ports.mqtt, localAddress });
			client.link = { write: (buffer) => socket.write(buffer), close: () => socket.destroy() };
			socket.on('data', (buffer: Buffer) => client.feed(buffer));
			socket.on('close', () => client.markClosed());
			socket.on('error', (error) => {
				client.markClosed();
				reject(error);
			});
			socket.on('connect', () => resolvePromise(client));
		} else {
			const socket = new WebSocket(`ws://${REMOTE_ADDRESS}:${ports.http}/`, 'mqtt', { localAddress });
			client.link = { write: (buffer) => socket.send(buffer), close: () => socket.terminate() };
			socket.on('message', (data: any) => client.feed(Buffer.isBuffer(data) ? data : Buffer.from(data)));
			socket.on('close', () => client.markClosed());
			socket.on('error', (error) => {
				client.markClosed();
				reject(error);
			});
			socket.on('open', () => resolvePromise(client));
		}
	});
}

interface MqttOutcome {
	connack: { reasonCode?: number; returnCode?: number } | 'closed' | 'timeout';
	suback?: { granted: unknown } | 'closed' | 'timeout';
	puback?: { reasonCode?: number } | 'closed' | 'timeout';
	delivered?: boolean;
	itemId: string;
}

async function mqttAttempt(
	kind: 'tcp' | 'ws',
	source: Source,
	ctx: ContextWithHarper,
	ports: Ports,
	credentials?: { username: string; password: string }
): Promise<MqttOutcome> {
	const itemId = `mqtt-${kind}-${source}-${randomBytes(4).toString('hex')}`;
	const outcome: MqttOutcome = { connack: 'timeout', itemId };
	const client = await openMqtt(kind, source, ctx, ports);
	try {
		client.send({
			cmd: 'connect',
			protocolId: 'MQTT',
			protocolVersion: 5,
			clean: true,
			clientId: `local-principal-${itemId}`,
			keepalive: 60,
			...(credentials ? { username: credentials.username, password: Buffer.from(credentials.password) } : {}),
		});
		const connack = await client.next(['connack', 'closed', 'timeout']);
		outcome.connack =
			connack.cmd === 'connack'
				? { reasonCode: connack.reasonCode, returnCode: connack.returnCode }
				: (connack.cmd as 'closed' | 'timeout');
		if (connack.cmd !== 'connack' || (connack.reasonCode ?? connack.returnCode ?? 0) !== 0) return outcome;

		client.send({
			cmd: 'subscribe',
			messageId: 1,
			subscriptions: [{ topic: 'LocalPrincipalItem/#', qos: 1, nl: false, rap: false, rh: 0 }],
		});
		const suback = await client.next(['suback', 'closed', 'timeout']);
		outcome.suback = suback.cmd === 'suback' ? { granted: suback.granted } : (suback.cmd as 'closed' | 'timeout');

		client.send({
			cmd: 'publish',
			topic: `LocalPrincipalItem/${itemId}`,
			payload: Buffer.from(JSON.stringify({ id: itemId, value: `via ${kind} from ${source}` })),
			qos: 1,
			messageId: 2,
			retain: true, // a retained publish is what persists the record
			dup: false,
		});
		const puback = await client.next(['puback', 'closed', 'timeout']);
		outcome.puback = puback.cmd === 'puback' ? { reasonCode: puback.reasonCode } : (puback.cmd as 'closed' | 'timeout');
		const delivery = await client.next(['publish'], 1_500);
		outcome.delivered = delivery.cmd === 'publish';
		return outcome;
	} finally {
		client.link.close();
	}
}

// ---------------------------------------------------------------------------------------------------------

function harness(ctx: ContextWithHarper, ports: Ports, requireAuthentication: boolean) {
	const admin = () => basic(ctx.harper.admin.username, ctx.harper.admin.password);
	const ops = (source: Source, body: unknown, headers: Record<string, string> = {}) =>
		send(ctx, source, ports.ops, '/', { body, headers });
	const rest = (source: Source, path: string, headers: Record<string, string> = {}) =>
		send(ctx, source, ports.http, path, { headers });
	const start = async () => {
		Object.assign(ports, await freePorts());
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: startConfig(ports, requireAuthentication),
			env: {},
		});
		const deadline = Date.now() + 120_000;
		for (;;) {
			try {
				const itemRoute = await rest('loopback', '/LocalPrincipalItem/', { Authorization: admin() });
				const opsRoute = await ops('loopback', { operation: 'user_info' });
				if (itemRoute.status !== 404 && opsRoute.status === 200) return;
			} catch {}
			ok(Date.now() < deadline, 'Harper never became reachable on the non-loopback address');
			await sleep(500);
		}
	};
	/** Status of the item row, polled until it appears or `ms` pass (MQTT publish is asynchronous). */
	const itemStatus = async (id: string, ms: number) => {
		const deadline = Date.now() + ms;
		for (;;) {
			const reply = await rest('loopback', `/LocalPrincipalItem/${id}`, { Authorization: admin() });
			if (reply.status !== 404 || Date.now() >= deadline) return reply.status;
			await sleep(200);
		}
	};
	return { admin, ops, rest, start, itemStatus };
}

suite('local trust is a principal, not a stored user', { skip: skipReason }, (ctx: ContextWithHarper) => {
	const ports: Ports = { http: 0, ops: 0, mqtt: 0 };
	const { admin, ops, rest, start, itemStatus } = harness(ctx, ports, true);
	const sessionIds: Record<string, string> = {};
	// system.hdb_session is created by the HTTP workers, so the operations API's schema does not know it; the
	// fixture's SessionRows resource reads it from inside a worker.
	const sessionRows = async (): Promise<any[]> => {
		const reply = await rest('remote', '/SessionRows/', { Authorization: admin() });
		strictEqual(reply.status, 200, reply.text);
		return reply.json;
	};

	before(async () => {
		await start();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ---- preconditions: prove the vantage points -------------------------------------------------------

	test('precondition: runtime, listeners, and source addresses', async () => {
		note('runtime', {
			node: process.versions.node,
			HARPER_RUNTIME: process.env.HARPER_RUNTIME ?? '(unset => node)',
			bunGlobal: typeof (globalThis as any).Bun !== 'undefined',
			harnessLoopback: ctx.harper.hostname,
		});
		strictEqual(typeof (globalThis as any).Bun, 'undefined');

		// the harness loopback address no longer carries the HTTP listener
		const refused = await new Promise<string>((resolvePromise) => {
			const socket = createConnection({ host: ctx.harper.hostname, port: ports.http });
			socket.on('connect', () => {
				socket.destroy();
				resolvePromise('connected');
			});
			socket.on('error', (error: any) => resolvePromise(error.code));
		});
		note('connect to harness loopback http port', refused);
		strictEqual(refused, 'ECONNREFUSED');

		const remote = await rest('remote', '/WhoAmI/');
		note('WhoAmI from remote source', remote.json);
		strictEqual(remote.status, 200, remote.text);
		ok(typeof remote.json.ip === 'string' && !isLoopback(remote.json.ip), `source reads ${remote.json.ip}`);
		note('observed non-loopback source address', remote.json.ip);
		strictEqual(remote.json.username, null);
		strictEqual(remote.json.superUser, false);

		const loop = await rest('loopback', '/WhoAmI/');
		note('WhoAmI from loopback source', loop.json);
		strictEqual(loop.status, 200, loop.text);
		ok(loop.json.ip.startsWith('127.0.0.'), `loopback source reads ${loop.json.ip}`);
		strictEqual(loop.json.username, 'local');
		strictEqual(loop.json.superUser, true);
		strictEqual(loop.json.localMarker, true);

		const remoteOps = await ops('remote', { operation: 'user_info' });
		note('ops user_info from remote, no credentials', { status: remoteOps.status, body: remoteOps.json });
		strictEqual(remoteOps.status, 401, remoteOps.text);
		const loopOps = await ops('loopback', { operation: 'user_info' });
		note('ops user_info from loopback, no credentials', { status: loopOps.status, body: loopOps.json });
		strictEqual(loopOps.status, 200, loopOps.text);
		strictEqual(loopOps.json.username, 'local');
	});

	// ---- arm 1 ---------------------------------------------------------------------------------------

	const SPOOFS: Record<string, Record<string, string>> = {
		'X-Forwarded-For': { 'X-Forwarded-For': '127.0.0.1' },
		'Forwarded': { Forwarded: 'for=127.0.0.1' },
		'X-Real-IP': { 'X-Real-IP': '127.0.0.1' },
		'Host: localhost': { Host: 'localhost' },
		'all four': {
			'X-Forwarded-For': '127.0.0.1',
			'Forwarded': 'for=127.0.0.1',
			'X-Real-IP': '127.0.0.1',
			'Host': 'localhost',
		},
	};

	test(`arm 1: spoofed loopback headers from the non-loopback address are not trusted (x${REPEAT} each)`, async () => {
		const threads = new Set<number>();
		for (const [label, headers] of Object.entries(SPOOFS)) {
			const seen = {
				userInfo: new Set<string>(),
				describeAll: new Set<string>(),
				whoAmI: new Set<string>(),
				item: new Set<string>(),
			};
			const replies = await repeated(REPEAT, async () => ({
				userInfo: await ops('remote', { operation: 'user_info' }, headers),
				describeAll: await ops('remote', { operation: 'describe_all' }, headers),
				whoAmI: await rest('remote', '/WhoAmI/', headers),
				item: await rest('remote', '/LocalPrincipalItem/', headers),
			}));
			for (const reply of replies) {
				seen.userInfo.add(String(reply.userInfo.status));
				seen.describeAll.add(String(reply.describeAll.status));
				seen.item.add(String(reply.item.status));
				seen.whoAmI.add(
					`${reply.whoAmI.status}/${reply.whoAmI.json?.username ?? null}/${reply.whoAmI.json?.superUser ?? null}`
				);
				strictEqual(reply.userInfo.status, 401, `${label}: ${reply.userInfo.text}`);
				strictEqual(reply.describeAll.status, 401, `${label}: ${reply.describeAll.text}`);
				ok([401, 403].includes(reply.item.status), `${label}: /LocalPrincipalItem/ -> ${reply.item.status}`);
				if (reply.whoAmI.status === 200) {
					strictEqual(reply.whoAmI.json.username, null, label);
					strictEqual(reply.whoAmI.json.superUser, false, label);
					threads.add(reply.whoAmI.json.threadId);
				} else {
					strictEqual(reply.whoAmI.status, 401, label);
				}
				for (const one of Object.values(reply))
					ok(!/"local"/.test(one.text), `${label}: a response names local: ${one.text}`);
			}
			note(`arm1 ${label} distinct outcomes`, Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]])));
		}
		note('arm1 distinct worker threadIds answering WhoAmI', [...threads]);
	});

	// ---- arm 2 ---------------------------------------------------------------------------------------

	test('arm 2: a body-supplied hdb_user is overwritten by authentication', async () => {
		const hdb_user = { username: 'local', _localPrincipal: true, role: { permission: { super_user: true } } };
		const attempts: Record<string, unknown> = {
			create_authentication_tokens: { operation: 'create_authentication_tokens', hdb_user },
			user_info: { operation: 'user_info', hdb_user },
			// a credentialed mint skips authHandler, so hdb_user reaches the operation unmodified
			create_authentication_tokens_with_credentials: {
				operation: 'create_authentication_tokens',
				username: 'local',
				password: generatedPassword(),
				hdb_user,
			},
			// scoped mint shape
			create_authentication_tokens_scoped: {
				operation: 'create_authentication_tokens',
				role: { permission: { super_user: false } },
				hdb_user,
			},
		};
		for (const [label, body] of Object.entries(attempts)) {
			for (const reply of await repeated(REPEAT, () => ops('remote', body))) {
				note(`arm2 ${label}`, { status: reply.status, body: reply.json ?? reply.text });
				strictEqual(reply.status, 401, `${label}: ${reply.text}`);
				ok(!reply.json?.operation_token && !reply.json?.refresh_token, `${label}: a token was minted`);
			}
		}
	});

	// ---- arm 3 ---------------------------------------------------------------------------------------

	test(`arm 3: the pre-auth header is ignored on Node (x${REPEAT})`, async () => {
		const forged = JSON.stringify({
			username: 'local',
			_localPrincipal: true,
			active: true,
			role: { role: 'super_user', permission: { super_user: true } },
		});
		const headers = { 'x-harper-internal-pre-auth-user': forged };
		const outcomes = new Set<string>();
		for (const reply of await repeated(REPEAT, async () => ({
			whoAmI: await rest('remote', '/WhoAmI/', headers),
			info: await ops('remote', { operation: 'user_info' }, headers),
			item: await rest('remote', '/LocalPrincipalItem/', headers),
		}))) {
			outcomes.add(
				`whoAmI=${reply.whoAmI.status}/${reply.whoAmI.json?.username ?? null}/${reply.whoAmI.json?.superUser ?? null} ops=${reply.info.status} item=${reply.item.status}`
			);
			if (reply.whoAmI.status === 200) {
				strictEqual(reply.whoAmI.json.username, null);
				strictEqual(reply.whoAmI.json.superUser, false);
			} else strictEqual(reply.whoAmI.status, 401);
			strictEqual(reply.info.status, 401, reply.info.text);
			ok([401, 403].includes(reply.item.status), `item ${reply.item.status}`);
		}
		note('arm3 distinct outcomes', [...outcomes]);
	});

	// ---- arm 4 ---------------------------------------------------------------------------------------

	test('arm 4: MQTT from the non-loopback address with no credentials (requireAuthentication default) vs loopback', async () => {
		for (const kind of ['tcp', 'ws'] as const) {
			const remote = await mqttAttempt(kind, 'remote', ctx, ports);
			note(`arm4 ${kind} remote no-credentials`, remote);
			ok(typeof remote.connack === 'object', `${kind}: connack ${JSON.stringify(remote.connack)}`);
			ok((remote.connack.reasonCode ?? remote.connack.returnCode ?? 0) !== 0, `${kind}: CONNECT was accepted`);
			strictEqual(remote.suback, undefined);
			strictEqual(await itemStatus(remote.itemId, 1_500), 404, `${kind}: a row landed from the non-loopback address`);

			const loop = await mqttAttempt(kind, 'loopback', ctx, ports);
			note(`arm4 ${kind} loopback no-credentials (positive control)`, loop);
			ok(typeof loop.connack === 'object');
			strictEqual(loop.connack.reasonCode ?? loop.connack.returnCode ?? 0, 0);
			deepStrictEqual((loop.suback as any).granted, [1]);
			strictEqual(loop.puback && (loop.puback as any).reasonCode, 0);
			strictEqual(await itemStatus(loop.itemId, 4_000), 200, `${kind}: loopback publish did not land`);

			// control: the non-loopback address works with real credentials, so the refusal above is about identity
			const authed = await mqttAttempt(kind, 'remote', ctx, ports, ctx.harper.admin);
			note(`arm4 ${kind} remote with admin credentials (control)`, authed);
			strictEqual(
				typeof authed.connack === 'object' && (authed.connack.reasonCode ?? authed.connack.returnCode ?? 0),
				0
			);
		}
	});

	// ---- arm 5 ---------------------------------------------------------------------------------------

	test('arm 5: a session stored from a loopback request never names the local principal', async () => {
		for (const name of ['SessionStore', 'SessionStoreSpread', 'SessionStoreName']) {
			const reply = await rest('loopback', `/${name}/`);
			note(`arm5 ${name} reply`, { status: reply.status, body: reply.json, setCookie: reply.headers['set-cookie'] });
			strictEqual(reply.status, 200, reply.text);
			strictEqual(sessionIdOf(reply), reply.json.sessionId, `${name}: no session cookie`);
			sessionIds[name] = reply.json.sessionId;
			strictEqual(reply.json.userKeySurvived, false, `${name}: user key was kept in the session update`);

			const rows = await sessionRows();
			const row = rows.find((candidate: any) => candidate.id === reply.json.sessionId);
			note(`arm5 ${name} hdb_session row`, row);
			ok(row, `${name}: the session row was not stored`);
			strictEqual('user' in row, false, `${name}: row has a user field`);
		}
		const all = await sessionRows();
		note('arm5 every hdb_session row', all);
		ok(all.length >= Object.keys(sessionIds).length);
		for (const row of all) strictEqual(row.user, undefined, `row ${row.id} has user ${row.user}`);
		for (const row of all) ok(!/local/.test(JSON.stringify(row)), `row ${row.id} mentions local`);
	});

	test(`arm 5: replaying those cookies from the non-loopback address grants nothing (x${REPEAT}); a real login cookie does`, async () => {
		for (const [name, id] of Object.entries(sessionIds)) {
			const outcomes = new Set<string>();
			for (const reply of await repeated(REPEAT, async () => ({
				whoAmI: await rest('remote', '/WhoAmI/', { Cookie: cookieFor(id, ports.http) }),
				info: await ops('remote', { operation: 'user_info' }, { Cookie: cookieFor(id, ports.ops) }),
				item: await rest('remote', '/LocalPrincipalItem/', { Cookie: cookieFor(id, ports.http) }),
			}))) {
				outcomes.add(
					`whoAmI=${reply.whoAmI.status}/${reply.whoAmI.json?.username ?? null}/${reply.whoAmI.json?.superUser ?? null} ops=${reply.info.status} item=${reply.item.status}`
				);
				if (reply.whoAmI.status === 200) {
					strictEqual(reply.whoAmI.json.username, null, name);
					strictEqual(reply.whoAmI.json.superUser, false, name);
				} else strictEqual(reply.whoAmI.status, 401, name);
				strictEqual(reply.info.status, 401, `${name}: ${reply.info.text}`);
				ok([401, 403].includes(reply.item.status), `${name}: item ${reply.item.status}`);
			}
			note(`arm5 replay ${name} outcomes`, [...outcomes]);
		}

		// positive control: the same replay mechanism does authenticate a real login
		const { username, password } = ctx.harper.admin;
		const login = await ops('remote', { operation: 'login', username, password });
		note('arm5 admin login', {
			status: login.status,
			body: login.json ?? login.text,
			setCookie: login.headers['set-cookie'],
		});
		strictEqual(login.status, 200, login.text);
		const loginId = sessionIdOf(login);
		ok(loginId, 'login set no cookie');
		// the session row is written after the login response, so wait for it before replaying the cookie
		const rowDeadline = Date.now() + 10_000;
		while (!(await sessionRows()).some((candidate: any) => candidate.id === loginId && candidate.user === username)) {
			ok(Date.now() < rowDeadline, 'the login session row never appeared');
			await sleep(100);
		}
		for (const reply of await repeated(REPEAT, async () => ({
			whoAmI: await rest('remote', '/WhoAmI/', { Cookie: cookieFor(loginId!, ports.http) }),
			info: await ops('remote', { operation: 'user_info' }, { Cookie: cookieFor(loginId!, ports.ops) }),
		}))) {
			strictEqual(reply.whoAmI.json?.username, username, reply.whoAmI.text);
			strictEqual(reply.whoAmI.json?.superUser, true);
			strictEqual(reply.info.status, 200, reply.info.text);
			strictEqual(reply.info.json.username, username);
		}
		const row = (await sessionRows()).find((candidate: any) => candidate.id === loginId);
		note('arm5 login session row (control: user field is visible when stored)', row);
		strictEqual(row?.user, username);
	});

	// ---- arm 7 ---------------------------------------------------------------------------------------

	test(`arm 7: a credential-free mint from loopback is for the stored admin, and works from the non-loopback address (x${REPEAT})`, async () => {
		const { username } = ctx.harper.admin;
		const minted = await repeated(REPEAT, () => ops('loopback', { operation: 'create_authentication_tokens' }));
		let refreshToken = '';
		for (const reply of minted) {
			strictEqual(reply.status, 200, reply.text);
			const claims = claimsOf(reply.json.operation_token);
			strictEqual(claims.username, username);
			strictEqual(claims.super_user, true);
			const refreshClaims = claimsOf(reply.json.refresh_token);
			strictEqual(refreshClaims.username, username);
			refreshToken = reply.json.refresh_token;
			ok(!/"local"/.test(JSON.stringify([claims, refreshClaims])));
		}
		note('arm7 operation_token claims', claimsOf(minted[0].json.operation_token));
		note('arm7 refresh_token claims', claimsOf(refreshToken));

		for (const reply of minted) {
			const bearer = { Authorization: `Bearer ${reply.json.operation_token}` };
			const info = await ops('remote', { operation: 'user_info' }, bearer);
			strictEqual(info.status, 200, info.text);
			strictEqual(info.json.username, username);
			const who = await rest('remote', '/WhoAmI/', bearer);
			strictEqual(who.json?.username, username);
		}

		// the stored refresh token is the latest mint's, so take it from a sequential mint
		const latest = await ops('loopback', { operation: 'create_authentication_tokens' });
		strictEqual(latest.status, 200, latest.text);
		refreshToken = latest.json.refresh_token;
		const refreshed = await repeated(REPEAT, () =>
			ops('remote', { operation: 'refresh_operation_token' }, { Authorization: `Bearer ${refreshToken}` })
		);
		for (const reply of refreshed) {
			strictEqual(reply.status, 200, reply.text);
			strictEqual(claimsOf(reply.json.operation_token).username, username);
			const info = await ops(
				'remote',
				{ operation: 'user_info' },
				{ Authorization: `Bearer ${reply.json.operation_token}` }
			);
			strictEqual(info.json.username, username);
		}
		note('arm7 refreshed operation_token claims', claimsOf(refreshed[0].json.operation_token));
	});

	// ---- arm 8 ---------------------------------------------------------------------------------------

	const scopedLocalToken = async () => {
		const minted = await ops(
			'remote',
			{ operation: 'create_authentication_tokens', username: 'local', role: { permission: { super_user: false } } },
			{ Authorization: admin() }
		);
		note('arm8 scoped mint', { status: minted.status, body: minted.json ?? minted.text });
		strictEqual(
			minted.status,
			200,
			`the scoped mint must succeed for the checks below to mean anything: ${minted.text}`
		);
		ok(minted.json.operation_token, 'the scoped mint returned no operation_token');
		note('arm8 scoped token claims', claimsOf(minted.json.operation_token));
		return { Authorization: `Bearer ${minted.json.operation_token}` };
	};

	test('arm 8: a scoped token with username "local" is not a super user and cannot mint', async () => {
		const bearer = await scopedLocalToken();
		for (const reply of await repeated(REPEAT, async () => ({
			info: await ops('remote', { operation: 'user_info' }, bearer),
			mint: await ops('remote', { operation: 'create_authentication_tokens' }, bearer),
			describe: await ops('remote', { operation: 'describe_all' }, bearer),
		}))) {
			note('arm8 scoped token use', {
				info: [reply.info.status, reply.info.json],
				mint: [reply.mint.status, reply.mint.json],
				describe: [reply.describe.status, reply.describe.json],
			});
			ok(reply.info.json?.role?.permission?.super_user !== true, 'scoped token reads as super user');
			ok(!reply.mint.json?.operation_token, 'scoped token minted a token');
			deepStrictEqual(reply.describe.json, {}, 'scoped token describes databases it has no grant on');
			ok([401, 403].includes(reply.mint.status), `mint status ${reply.mint.status}`);
		}
	});

	test('a principal named "local" without the _localPrincipal marker gets no local role', async () => {
		const bearer = await scopedLocalToken();
		const info = await ops('remote', { operation: 'user_info' }, bearer);
		strictEqual(info.status, 200, info.text);
		strictEqual(info.json.username, 'local');
		ok(
			info.json.role?.id !== '_local' && info.json.role?.id !== 'super_user',
			`local role: ${JSON.stringify(info.json.role)}`
		);
		ok(info.json.role?.permission?.super_user !== true, 'a token named local reads as super user');

		const who = await rest('remote', '/WhoAmI/', bearer);
		note('local-named token WhoAmI', who.json);
		strictEqual(who.status, 200, who.text);
		strictEqual(who.json.username, 'local');
		strictEqual(who.json.localMarker, false, 'a token named local carries the local marker');
		strictEqual(who.json.superUser, false);

		const rows = await rest('remote', '/SessionRows/', bearer);
		strictEqual(rows.status, 403, 'a super-user-only resource served a token named local');
	});

	// ---- arm 6 (last: it adds users) ------------------------------------------------------------------

	test('arm 6: add_user refuses "local"; look-alike names are ordinary users', async () => {
		const names = ['local', 'Local', ' local', 'local '];
		const accepted: { name: string; password: string }[] = [];
		for (const name of names) {
			const password = generatedPassword();
			const reply = await ops(
				'remote',
				{ operation: 'add_user', username: name, password, role: 'super_user', active: true },
				{ Authorization: admin() }
			);
			note(`arm6 add_user ${JSON.stringify(name)}`, { status: reply.status, body: reply.json ?? reply.text });
			if (name === 'local') {
				strictEqual(reply.status, 400, reply.text);
				ok(/reserved username/.test(reply.json?.error ?? ''), reply.text);
			}
			if (reply.status === 200) accepted.push({ name, password });
		}
		note(
			'arm6 accepted usernames (JSON-escaped)',
			accepted.map((a) => JSON.stringify(a.name))
		);
		const listed = await ops('remote', { operation: 'list_users' }, { Authorization: admin() });
		note(
			'arm6 stored usernames (JSON-escaped)',
			listed.json.map((u: any) => JSON.stringify(u.username))
		);
		ok(!listed.json.some((u: any) => u.username === 'local'), 'a user named exactly "local" is stored');

		try {
			const principal = await ops('loopback', { operation: 'user_info' });
			note('arm6 credential-free loopback user_info after the adds', principal.json);
			strictEqual(principal.json.username, 'local');
			strictEqual(principal.json.role.id, 'super_user');
			const who = await rest('loopback', '/WhoAmI/');
			strictEqual(who.json.username, 'local');
			strictEqual(who.json.localMarker, true);

			for (const { name, password } of accepted) {
				const asVariant = await ops('remote', { operation: 'user_info' }, { Authorization: basic(name, password) });
				note(`arm6 Basic as ${JSON.stringify(name)} user_info`, {
					status: asVariant.status,
					username: asVariant.json?.username,
					roleId: asVariant.json?.role?.id,
				});
				strictEqual(asVariant.status, 200, asVariant.text);
				strictEqual(asVariant.json.username, name, 'variant resolved to another principal');
				const web = await rest('remote', '/WhoAmI/', { Authorization: basic(name, password) });
				note(`arm6 Basic as ${JSON.stringify(name)} WhoAmI`, web.json);
				strictEqual(web.json.localMarker, false, 'variant carries the local marker');
				const mint = await ops(
					'remote',
					{ operation: 'create_authentication_tokens' },
					{ Authorization: basic(name, password) }
				);
				note(`arm6 credential-free mint as ${JSON.stringify(name)}`, {
					status: mint.status,
					claims: mint.json?.operation_token && claimsOf(mint.json.operation_token),
				});
				if (mint.status === 200) ok(claimsOf(mint.json.operation_token).username !== 'local');
			}
		} finally {
			for (const { name } of accepted) {
				const dropped = await ops('remote', { operation: 'drop_user', username: name }, { Authorization: admin() });
				note(`arm6 cleanup drop_user ${JSON.stringify(name)}`, dropped.status);
			}
		}
	});
});

suite('local principal: MQTT with requireAuthentication off', { skip: skipReason }, (ctx: ContextWithHarper) => {
	const ports: Ports = { http: 0, ops: 0, mqtt: 0 };
	const { itemStatus, start } = harness(ctx, ports, false);

	before(async () => {
		await start();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	for (const kind of ['tcp', 'ws'] as const) {
		test(`a credential-less ${kind} client from the non-loopback address is not the local principal`, async () => {
			const remote = await mqttAttempt(kind, 'remote', ctx, ports);
			note(`arm4b ${kind} remote no-credentials`, remote);
			ok(typeof remote.connack === 'object');
			strictEqual(
				remote.connack.reasonCode ?? remote.connack.returnCode ?? 0,
				0,
				'CONNECT should be accepted with requireAuthentication off'
			);
			ok(typeof remote.suback === 'object');
			const granted = (remote.suback as any).granted as number[];
			note(`arm4b ${kind} SUBACK reason codes`, granted);
			ok(
				granted.every((code) => code >= 0x80),
				`SUBACK granted ${JSON.stringify(granted)}`
			);
			ok(typeof remote.puback === 'object');
			ok(((remote.puback as any).reasonCode ?? 0) >= 0x80, `PUBACK ${JSON.stringify(remote.puback)}`);
			strictEqual(remote.delivered, false);
			strictEqual(await itemStatus(remote.itemId, 1_500), 404, 'a row landed from the non-loopback address');

			const loop = await mqttAttempt(kind, 'loopback', ctx, ports);
			note(`arm4b ${kind} loopback no-credentials (positive control)`, loop);
			deepStrictEqual((loop.suback as any).granted, [1]);
			strictEqual((loop.puback as any).reasonCode, 0);
			strictEqual(await itemStatus(loop.itemId, 4_000), 200, 'loopback publish did not land');
		});
	}
});
