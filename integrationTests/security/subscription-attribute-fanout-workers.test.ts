/**
 * Attribute read permissions on subscription deliveries under concurrent mixed-role fan-out (PR #3307): a restricted
 * role (`secret` unreadable) and a super user share topics across 4 worker threads over MQTT (QoS 0, QoS 1 durable with
 * a mid-run reconnect, `$share` refused by design), REST WebSocket and SSE, while writers drive `Doc/hot` through REST
 * PUT/PATCH and MQTT publishes (JSON, number, raw bytes, JSON string). Every restricted frame is a projection without
 * `secret`; every super-user record frame carries the matching secret; non-JSON messages reach super users
 * byte-unchanged and the restricted role as {}; no subscriber closes unplanned.
 *
 * Env: QA3307_LOAD_MS (per run, default 15000), QA3307_RUNS (default 1). Linux only: the four-worker layout needs
 * reusePort on the HTTP listener. Throughput is reported, not asserted; every oracle has a per-subscriber frame floor.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-attribute-fanout-workers.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { Agent, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import WebSocket from 'ws';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-attribute-fanout-workers');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform !== 'linux';
const LOAD_MS = Number(process.env.QA3307_LOAD_MS ?? 15_000);
const RUNS = Number(process.env.QA3307_RUNS ?? 1);
const MIN_RECORD_FRAMES_PER_RUN = Math.min(10, Math.max(1, Math.floor(LOAD_MS / 2000)));
const THREADS = 4;

type Role = 'r' | 's';
type Proto = 'mqtt0' | 'mqttDurable' | 'mqttShare' | 'ws' | 'sse' | 'sseRelated';
interface Frame {
	run: number; // 0 = control phase, 1..RUNS = load runs
	phase: string; // durable clients: pre | post
	raw: Buffer;
	text: string;
	topic?: string;
	dup?: boolean;
}
interface Sub {
	id: string;
	role: Role;
	proto: Proto;
	idx: number;
	frames: Frame[];
	worker?: number | string;
	workerNote?: string;
	status?: number; // SSE HTTP status
	suback?: string;
	clientId?: string;
	client?: MqttClient;
	ws?: WebSocket;
	req?: ReturnType<typeof httpRequest>;
	planned: boolean;
	phase: string;
	reconnected?: { sessionPresent: boolean; worker?: number | string };
	events: string[]; // closes / errors seen
	unplannedClose: boolean;
}

suite('PR 3307 mixed-role subscription fan-out over 4 workers', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let api: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let wsBase: string;
	let mqttURL: string;
	const rUser = { username: 'qa3307_r', password: `Rr1!${randomUUID()}` };
	const sUser = { username: 'qa3307_s', password: `Ss1!${randomUUID()}` };
	const auth = (u: { username: string; password: string }) =>
		`Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}`;
	const creds = { r: rUser, s: sUser };
	const subs: Sub[] = [];
	const publishers: MqttClient[] = [];
	const workersSeen = new Set<number>();
	let currentRun = 0;
	let shuttingDown = false;
	let logStart = 0;
	const stats = { runs: [] as any[] };
	const written = { n: 0 };
	const publishedOpaque = { num: 0, bytes: 0, str: 0, retained: 0, put: 0, patch: 0, errors: 0 };
	const OPAQUE_NUM = Buffer.from('22.5');
	const OPAQUE_BYTES = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

	const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(25);
		}
		return predicate();
	};

	function logFile() {
		return join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
	}

	// ---- plain HTTP over a fresh connection each time (so requests spread across workers) ----
	function httpCall(method: string, path: string, authHeader: string, body?: unknown) {
		return new Promise<{ status: number; text: string }>((res, reject) => {
			const url = new URL(httpURL);
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const req = httpRequest(
				{
					agent: new Agent({ keepAlive: false }),
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port,
					path,
					method,
					headers: {
						Authorization: authHeader,
						Connection: 'close',
						...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
					},
				},
				(response) => {
					let text = '';
					response.setEncoding('utf8');
					response.on('data', (c) => (text += c));
					response.on('end', () => res({ status: response.statusCode ?? 0, text }));
				}
			);
			req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
			req.on('error', reject);
			req.end(payload);
		});
	}
	const probeWorker = async () => {
		const r = await httpCall('GET', '/WorkerProbe/x', auth(sUser));
		if (r.status !== 200) throw new Error(`WorkerProbe ${r.status}: ${r.text}`);
		const threadId = JSON.parse(r.text).threadId;
		workersSeen.add(threadId);
		return threadId as number;
	};

	// ---- MQTT helpers ----
	function mqttOptions(role: Role, extra: Partial<IClientOptions>): IClientOptions {
		return {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 10_000,
			clean: true,
			...creds[role],
			...extra,
		};
	}
	function connectMqtt(
		role: Role,
		extra: Partial<IClientOptions>,
		onMessage?: (t: string, p: Buffer, pk: any) => void
	) {
		return new Promise<{ client: MqttClient; sessionPresent: boolean }>((res, reject) => {
			const client = mqtt.connect(mqttURL, mqttOptions(role, extra));
			if (onMessage) client.on('message', onMessage); // before CONNACK: a resumed session replays immediately
			const timer = setTimeout(() => reject(new Error('mqtt connect timed out')), 15_000);
			client.once('connect', (connack) => {
				clearTimeout(timer);
				res({ client, sessionPresent: connack.sessionPresent });
			});
			client.once('error', (e) => {
				clearTimeout(timer);
				client.end(true);
				reject(e);
			});
		});
	}
	function subscribeMqtt(client: MqttClient, topic: string, qos: 0 | 1) {
		return new Promise<{ ok: boolean; code: string }>((res) => {
			const timer = setTimeout(() => res({ ok: false, code: 'timeout' }), 10_000);
			client.subscribe(topic, { qos }, (err: any, granted: any) => {
				clearTimeout(timer);
				if (err) {
					const raw = err?.packet?.granted;
					res({
						ok: false,
						code: `refused ${Array.isArray(raw) ? '0x' + raw[0].toString(16) : (err.code ?? err.message)}`,
					});
				} else res({ ok: true, code: `granted qos ${JSON.stringify(granted?.map((g: any) => g.qos))}` });
			});
		});
	}
	async function mqttWorker(client: MqttClient): Promise<number | undefined> {
		let threadId: number | undefined;
		const onMessage = (topic: string, payload: Buffer) => {
			if (topic.startsWith('WorkerProbe/')) {
				try {
					threadId = JSON.parse(payload.toString()).threadId;
				} catch {}
			}
		};
		client.on('message', onMessage);
		try {
			const sub = await subscribeMqtt(client, 'WorkerProbe/x', 0);
			if (!sub.ok) return undefined;
			await waitFor(() => threadId !== undefined, 5_000);
			await Promise.race([new Promise<void>((res) => client.unsubscribe('WorkerProbe/x', () => res())), sleep(5_000)]);
			if (threadId !== undefined) workersSeen.add(threadId);
			return threadId;
		} finally {
			client.removeListener('message', onMessage);
		}
	}
	function collector(sub: Sub) {
		return (topic: string, payload: Buffer, packet?: any) => {
			if (topic.startsWith('WorkerProbe/')) return;
			sub.frames.push({
				run: currentRun,
				phase: sub.phase,
				raw: payload,
				text: payload.toString('utf8'),
				topic,
				dup: Boolean(packet?.dup),
			});
		};
	}
	function trackMqttClose(sub: Sub, client: MqttClient) {
		client.on('error', (e) => sub.events.push(`error: ${e?.message ?? e}`));
		client.on('close', () => {
			if (shuttingDown || sub.planned || sub.client !== client) return;
			sub.unplannedClose = true;
			sub.events.push('unplanned close');
		});
	}

	async function addMqtt(role: Role, proto: 'mqtt0' | 'mqttDurable' | 'mqttShare', idx: number) {
		const sub: Sub = {
			id: `${role}/${proto}/${idx}`,
			role,
			proto,
			idx,
			frames: [],
			planned: false,
			phase: 'pre',
			events: [],
			unplannedClose: false,
		};
		const durable = proto === 'mqttDurable';
		if (durable) sub.clientId = `qa3307-${role}-dur-${idx}`;
		const { client } = await connectMqtt(role, durable ? { clean: false, clientId: sub.clientId } : {}, collector(sub));
		sub.client = client;
		trackMqttClose(sub, client);
		sub.worker = await mqttWorker(client);
		if (sub.worker === undefined) sub.workerNote = 'WorkerProbe subscribe refused/timeout on this connection';
		const topic = proto === 'mqtt0' ? 'Doc/hot' : proto === 'mqttDurable' ? 'Doc/#' : '$share/g/Doc/hot';
		const r = await subscribeMqtt(client, topic, durable ? 1 : 0);
		sub.suback = `${topic}: ${r.code}`;
		subs.push(sub);
		return sub;
	}
	async function addWs(role: Role, idx: number) {
		const sub: Sub = {
			id: `${role}/ws/${idx}`,
			role,
			proto: 'ws',
			idx,
			frames: [],
			planned: false,
			phase: 'pre',
			events: [],
			unplannedClose: false,
		};
		const ws = new WebSocket(`${wsBase}/Doc/hot`, { headers: { Authorization: auth(creds[role]) } });
		ws.on('message', (data: Buffer) => {
			const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
			sub.frames.push({ run: currentRun, phase: sub.phase, raw, text: raw.toString('utf8') });
		});
		ws.on('error', (e) => sub.events.push(`error: ${e.message}`));
		ws.on('close', (code, reason) => {
			if (shuttingDown) return;
			sub.unplannedClose = true;
			sub.events.push(`unplanned close ${code} ${reason}`);
		});
		await new Promise((res, rej) => {
			ws.once('open', res);
			ws.once('error', rej);
		});
		sub.ws = ws;
		sub.workerNote = 'REST WebSocket connection cannot be attributed to a worker';
		subs.push(sub);
	}
	async function addSse(role: Role, proto: 'sse' | 'sseRelated', idx: number) {
		const sub: Sub = {
			id: `${role}/${proto}/${idx}`,
			role,
			proto,
			idx,
			frames: [],
			planned: false,
			phase: 'pre',
			events: [],
			unplannedClose: false,
		};
		const url = new URL(httpURL);
		const path = proto === 'sse' ? '/Doc/hot' : '/Doc/hot.related';
		const status = new Promise<void>((res) => {
			const req = httpRequest(
				{
					agent: new Agent({ keepAlive: false }),
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port,
					path,
					headers: { Accept: 'text/event-stream', Authorization: auth(creds[role]) },
				},
				(response) => {
					sub.status = response.statusCode;
					res();
					response.setEncoding('utf8');
					let pending = '';
					response.on('data', (chunk: string) => {
						const blocks = (pending + chunk).split('\n\n');
						pending = blocks.pop()!;
						for (const block of blocks) {
							const data = block
								.split('\n')
								.filter((l) => l.startsWith('data:'))
								.map((l) => l.slice(5).trimStart())
								.join('\n');
							if (data) sub.frames.push({ run: currentRun, phase: sub.phase, raw: Buffer.from(data), text: data });
						}
					});
					response.on('close', () => {
						if (shuttingDown) return;
						sub.unplannedClose = true;
						sub.events.push(`unplanned close (status ${response.statusCode})`);
					});
				}
			);
			req.on('error', (e) => {
				if (!shuttingDown) sub.events.push(`error: ${e.message}`);
				res();
			});
			sub.req = req;
			req.end();
			setTimeout(res, 4_000);
		});
		await status;
		sub.workerNote = 'SSE connection cannot be attributed to a worker';
		subs.push(sub);
	}

	// ---- frame classification ----
	const TITLE = /"title"\s*:\s*"T-([^"]+)"/;
	const SECRET_VAL = /"secret"\s*:\s*"S3CR3T-([^"]+)"/;
	// REST WebSocket and SSE deliver an envelope {id, localTime, value, version, type, size}; MQTT delivers the value.
	function inner(f: Frame): { text: string; raw: Buffer } {
		try {
			const v = JSON.parse(f.text);
			if (v && typeof v === 'object' && 'type' in v && 'localTime' in v && 'value' in v) {
				const val = v.value;
				if (
					val &&
					typeof val === 'object' &&
					typeof val.contentType === 'string' &&
					val.data &&
					typeof val.data === 'object'
				) {
					const d = val.data;
					const bytes = Buffer.from(
						Array.isArray(d) ? d : Array.isArray(d.data) ? d.data : (Object.values(d) as number[])
					);
					return { text: bytes.toString('utf8'), raw: bytes };
				}
				const text = JSON.stringify(val);
				return { text, raw: Buffer.from(text) };
			}
		} catch {}
		return { text: f.text, raw: f.raw };
	}
	function classify(f: Frame): 'record' | 'empty' | 'num' | 'bytes' | 'str' | 'other' {
		const { text, raw } = inner(f);
		if (TITLE.test(text)) return 'record';
		if (text.trim() === '{}') return 'empty';
		if (raw.equals(OPAQUE_NUM)) return 'num';
		if (raw.equals(OPAQUE_BYTES)) return 'bytes';
		if (/^"MSG-\d+"$/.test(text)) return 'str';
		return 'other';
	}
	const keysOf = (f: Frame) => {
		try {
			const v = JSON.parse(inner(f).text);
			return v && typeof v === 'object' ? Object.keys(v).sort().join(',') : typeof v;
		} catch {
			return 'unparseable';
		}
	};
	const leaks = (f: Frame) => f.text.includes('secret') || f.text.includes('S3CR3T-');
	const of = (role: Role, ...protos: Proto[]) =>
		subs.filter((s) => s.role === role && (!protos.length || protos.includes(s.proto)));
	const hotRecordSubs = (role: Role) => of(role).filter((s) => s.proto !== 'sseRelated' && s.proto !== 'mqttShare');
	const short = (f: Frame) => JSON.stringify(f.text.length > 200 ? f.text.slice(0, 200) + '...' : f.text);

	// ---- writes ----
	const rec = (n: string | number, extra: object = {}) => ({
		id: 'hot',
		title: `T-${n}`,
		secret: `S3CR3T-${n}`,
		relatedId: 'rel1',
		...extra,
	});

	function publishMqtt(client: MqttClient, payload: Buffer | string, retain: boolean): Promise<number> {
		return new Promise((res) => {
			const timer = setTimeout(() => res(-2), 10_000);
			client.publish('Doc/hot', payload, { qos: 1, retain }, (error: any, packet: any) => {
				clearTimeout(timer);
				res(error ? (error.code ?? -1) : (packet?.reasonCode ?? 0));
			});
		});
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: THREADS } }, env: {} });
		api = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		wsBase = httpURL.replace(/^http/, 'ws');
		mqttURL = `${wsBase}/mqtt`;
		await waitForRouteReady(api, '/Doc/', 120_000);
		await waitForRouteReady(api, '/WorkerProbe/x', 60_000);
		try {
			logStart = readFileSync(logFile()).length;
		} catch {
			logStart = 0;
		}
		const role = await api.req().send({
			operation: 'add_role',
			role: 'qa3307_restricted',
			permission: {
				super_user: false,
				data: {
					tables: {
						Doc: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'id', read: true, insert: false, update: false },
								{ attribute_name: 'title', read: true, insert: false, update: false },
								{ attribute_name: 'related', read: true, insert: false, update: false },
								{ attribute_name: 'relatedId', read: true, insert: false, update: false },
								{ attribute_name: 'secret', read: false, insert: false, update: false },
							],
						},
						Rel: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
					},
				},
			},
		});
		strictEqual(role.status, 200, role.text);
		const ru = await api.req().send({ operation: 'add_user', role: 'qa3307_restricted', ...rUser, active: true });
		strictEqual(ru.status, 200, ru.text);
		const su = await api.req().send({ operation: 'add_user', role: 'super_user', ...sUser, active: true });
		strictEqual(su.status, 200, su.text);
		const adminAuth = api.headers.Authorization;
		const rel = await httpCall('PUT', '/Rel/rel1', adminAuth, { id: 'rel1', name: 'related one' });
		ok(rel.status < 300, `seed Rel: ${rel.status} ${rel.text}`);
		const doc = await httpCall('PUT', '/Doc/hot', adminAuth, rec('seed'));
		ok(doc.status < 300, `seed Doc: ${doc.status} ${doc.text}`);
	});

	after(async () => {
		shuttingDown = true;
		for (const s of subs) {
			try {
				s.client?.end(true);
				s.ws?.terminate();
				s.req?.destroy();
			} catch {}
		}
		for (const p of publishers) p.end(true);
		await teardownHarper(ctx);
	});

	test('4 worker threads serve fresh connections', async () => {
		const seen = new Set<number>();
		for (let i = 0; i < 400 && seen.size < THREADS; i++) seen.add(await probeWorker());
		console.log(`[QA3307] workers seen via fresh GET /WorkerProbe/x connections: ${[...seen].sort()}`);
		strictEqual(seen.size, THREADS, `distinct worker ids seen: ${[...seen]}`);
	});

	test('open 40 subscribers; positive and negative controls', async () => {
		// interleave roles so both land across workers
		for (let i = 0; i < 4; i++) for (const role of ['r', 's'] as Role[]) await addMqtt(role, 'mqtt0', i);
		for (let i = 0; i < 4; i++) for (const role of ['r', 's'] as Role[]) await addMqtt(role, 'mqttDurable', i);
		for (let i = 0; i < 3; i++) for (const role of ['r', 's'] as Role[]) await addMqtt(role, 'mqttShare', i);
		for (let i = 0; i < 3; i++) for (const role of ['r', 's'] as Role[]) await addWs(role, i);
		for (let i = 0; i < 3; i++) for (const role of ['r', 's'] as Role[]) await addSse(role, 'sse', i);
		for (let i = 0; i < 3; i++) for (const role of ['r', 's'] as Role[]) await addSse(role, 'sseRelated', i);
		strictEqual(subs.length, 40);
		for (const s of subs.filter((x) => x.proto.startsWith('mqtt')))
			console.log(`[QA3307] ${s.id} worker=${s.worker ?? 'unknown'} suback=${s.suback}`);
		for (const s of subs.filter((x) => x.proto === 'sse' || x.proto === 'sseRelated'))
			console.log(`[QA3307] ${s.id} http status=${s.status}`);
		const nonShare = subs.filter((s) => s.proto !== 'mqttShare');
		for (const s of nonShare.filter((x) => x.proto.startsWith('mqtt')))
			ok(s.suback!.includes('granted'), `${s.id} SUBACK: ${s.suback}`);
		for (const s of subs.filter((x) => x.proto === 'sse')) strictEqual(s.status, 200, `${s.id} status`);

		// positive control: a known write reaches every hot subscriber, and super users see the secret
		const w = await httpCall('PUT', '/Doc/hot', api.headers.Authorization, rec('ctrl'));
		ok(w.status < 300, `control PUT ${w.status} ${w.text}`);
		const recs = [...hotRecordSubs('r'), ...hotRecordSubs('s')];
		const got = await waitFor(() => recs.every((s) => s.frames.some((f) => f.text.includes('"T-ctrl"'))), 15_000);
		const missing = recs.filter((s) => !s.frames.some((f) => f.text.includes('"T-ctrl"'))).map((s) => s.id);
		console.log(`[QA3307] control: subscribers lacking T-ctrl: ${JSON.stringify(missing)}`);
		ok(got, `control write not delivered to: ${missing}`);
		const sWithSecret = hotRecordSubs('s').filter((s) => s.frames.some((f) => f.text.includes('S3CR3T-ctrl')));
		strictEqual(
			sWithSecret.length,
			hotRecordSubs('s').length,
			`s subscribers that saw S3CR3T-ctrl: ${sWithSecret.map((s) => s.id)}`
		);
		const rLeaks = hotRecordSubs('r').flatMap((s) => s.frames.filter(leaks));
		strictEqual(rLeaks.length, 0, `r frames leaking during control: ${rLeaks.map(short)}`);
		// negative control: the leak check, applied to what super users received, must fire
		const sFramesLeaking = hotRecordSubs('s').flatMap((s) => s.frames.filter(leaks)).length;
		ok(sFramesLeaking > 0, `leak oracle fired on ${sFramesLeaking} super-user frames (oracle can fail)`);
		console.log(`[QA3307] control: ${sFramesLeaking} super-user frames trip the leak oracle (non-vacuous)`);
		// colocation of r and s MQTT QoS0 subscribers on one worker (shared-encoding path)
		const byWorker = new Map<string, string[]>();
		for (const s of subs.filter((x) => x.proto === 'mqtt0' || x.proto === 'mqttDurable'))
			byWorker.set(`${s.proto}@${s.worker}`, [...(byWorker.get(`${s.proto}@${s.worker}`) ?? []), s.role]);
		console.log(`[QA3307] mqtt colocation (proto@worker -> roles): ${JSON.stringify([...byWorker])}`);
	});

	async function loadRun(run: number) {
		currentRun = run;
		const counts = { put: 0, patch: 0, retained: 0, num: 0, bytes: 0, str: 0, errors: 0, probes: 0 };
		const errorSamples: string[] = [];
		const pubs: MqttClient[] = [];
		for (let i = 0; i < 4; i++) {
			const { client } = await connectMqtt('s', { clientId: `qa3307-pub-${run}-${i}` });
			client.on('error', () => {});
			pubs.push(client);
			publishers.push(client);
			await mqttWorker(client);
		}
		const [pRetained, pNum, pBytes, pStr] = pubs;
		const sAuth = auth(sUser);
		const start = Date.now();
		const endAt = start + LOAD_MS;
		const LANE_HZ = 200 / 6;
		const lane = async (kind: string, op: (n: number) => Promise<boolean | string>) => {
			const interval = 1000 / LANE_HZ;
			for (let k = 0; Date.now() < endAt; k++) {
				const n = ++written.n;
				try {
					const r = await op(n);
					if (r !== true) {
						counts.errors++;
						if (errorSamples.length < 5) errorSamples.push(`${kind} n=${n}: ${r}`);
					} else (counts as any)[kind]++;
				} catch (e: any) {
					counts.errors++;
					if (errorSamples.length < 5) errorSamples.push(`${kind} n=${n}: ${e?.message}`);
				}
				const wait = start + (k + 1) * interval - Date.now();
				if (wait > 0) await sleep(wait);
			}
		};
		const httpOk = async (m: string, body: object) => {
			const r = await httpCall(m, '/Doc/hot', sAuth, body);
			return r.status < 300 ? true : `${r.status} ${r.text}`;
		};
		const pubOk = async (p: MqttClient, payload: Buffer | string, retain: boolean) => {
			const code = await publishMqtt(p, payload, retain);
			return code === 0 ? true : `PUBACK ${code}`;
		};
		const probes = (async () => {
			while (Date.now() < endAt) {
				try {
					await probeWorker();
					counts.probes++;
				} catch {}
				await sleep(200);
			}
		})();
		const midway = (async () => {
			await sleep(LOAD_MS / 2);
			const victims = subs.filter((s) => s.proto === 'mqttDurable' && s.idx % 2 === run % 2);
			await Promise.all(
				victims.map(async (s) => {
					s.planned = true;
					const old = s.client!;
					await new Promise<void>((res) => {
						const t = setTimeout(res, 3_000);
						old.end(false, {}, () => {
							clearTimeout(t);
							res();
						});
					});
					await sleep(800); // writes continue while it is offline
					s.phase = `post${run}`;
					const { client, sessionPresent } = await connectMqtt(
						s.role,
						{ clean: false, clientId: s.clientId },
						collector(s)
					);
					s.client = client;
					s.planned = false;
					trackMqttClose(s, client);
					let worker: number | string | undefined = await mqttWorker(client);
					if (!sessionPresent) await subscribeMqtt(client, 'Doc/#', 1);
					s.reconnected = { sessionPresent, worker };
					s.events.push(`planned reconnect run ${run}: sessionPresent=${sessionPresent} worker=${worker}`);
				})
			);
		})();
		await Promise.all([
			lane('put', (n) => httpOk('PUT', rec(n))),
			lane('patch', (n) => httpOk('PATCH', { title: `T-${n}`, secret: `S3CR3T-${n}` })),
			lane('retained', (n) => pubOk(pRetained, JSON.stringify(rec(n)), true)),
			lane('num', () => pubOk(pNum, '22.5', false)),
			lane('bytes', () => pubOk(pBytes, OPAQUE_BYTES, false)),
			lane('str', (n) => pubOk(pStr, JSON.stringify(`MSG-${n}`), false)),
			probes,
			midway,
		]);
		const elapsed = (Date.now() - start) / 1000;
		// drain: wait for deliveries to stop
		let last = -1;
		let stable = 0;
		for (let i = 0; i < 600 && stable < 60; i++) {
			const total = subs.reduce((n, s) => n + s.frames.length, 0);
			stable = total === last ? stable + 1 : 0;
			last = total;
			await sleep(25);
		}
		for (const p of pubs) p.end(true);
		const ops = counts.put + counts.patch + counts.retained + counts.num + counts.bytes + counts.str;
		const summary = { run, elapsed, ops, opsPerSec: +(ops / elapsed).toFixed(1), ...counts };
		stats.runs.push(summary);
		publishedOpaque.num += counts.num;
		publishedOpaque.bytes += counts.bytes;
		publishedOpaque.str += counts.str;
		publishedOpaque.retained += counts.retained;
		publishedOpaque.put += counts.put;
		publishedOpaque.patch += counts.patch;
		publishedOpaque.errors += counts.errors;
		console.log(`[QA3307] load run ${run}: ${JSON.stringify(summary)} errorSamples=${JSON.stringify(errorSamples)}`);
	}

	test(
		`load: ${RUNS} runs x ${LOAD_MS} ms at ~200 ops/s`,
		{ timeout: RUNS * (LOAD_MS + 60_000) + 60_000 },
		async () => {
			for (let run = 1; run <= RUNS; run++) await loadRun(run);
			const total = stats.runs.reduce((n, r) => n + r.ops, 0);
			console.log(`[QA3307] run count=${RUNS}, total successful ops=${total}, errors=${publishedOpaque.errors}`);
			ok(total > 0 && publishedOpaque.errors <= total * 0.01, `publish errors ${publishedOpaque.errors} of ${total}`);
			for (const r of stats.runs) console.log(`[QA3307] run ${r.run}: ${r.opsPerSec} ops/s (reported, not asserted)`);
		}
	);

	test('oracle 1: no restricted-role frame carries `secret` or an S3CR3T- value', () => {
		const rSubs = of('r');
		let frames = 0;
		const bad: string[] = [];
		for (const s of rSubs)
			for (const f of s.frames) {
				frames++;
				if (leaks(f)) bad.push(`${s.id} run${f.run}: ${short(f)}`);
			}
		console.log(
			`[QA3307] O1: ${frames} r frames scanned across ${rSubs.length} subscribers; violations=${bad.length}; ${JSON.stringify(bad.slice(0, 3))}`
		);
		strictEqual(bad.length, 0, bad.slice(0, 3).join('\n'));
		ok(
			frames >= MIN_RECORD_FRAMES_PER_RUN * RUNS * rSubs.length,
			`only ${frames} r frames scanned across ${rSubs.length} subscribers`
		);
	});

	test('oracle 2 + 6: every super-user record frame carries the matching secret', () => {
		let recordFrames = 0;
		const bad: string[] = [];
		const restrictedShape: string[] = [];
		const shapes = new Map<string, number>();
		for (const s of hotRecordSubs('s'))
			for (const f of s.frames) {
				if (classify(f) !== 'record') continue;
				recordFrames++;
				const k = `${s.proto}: ${keysOf(f)}`;
				shapes.set(k, (shapes.get(k) ?? 0) + 1);
				const it = inner(f).text;
				const t = TITLE.exec(it)![1];
				const sec = SECRET_VAL.exec(it);
				if (!sec || sec[1] !== t) bad.push(`${s.id} run${f.run}: ${short(f)}`);
				if (!it.includes('secret')) restrictedShape.push(`${s.id}: ${short(f)}`);
			}
		console.log(`[QA3307] O2: s record frames=${recordFrames}; s record key-shapes=${JSON.stringify([...shapes])}`);
		console.log(`[QA3307] O2: violations=${bad.length} ${JSON.stringify(bad.slice(0, 3))}`);
		console.log(
			`[QA3307] O6: s record frames lacking secret (restricted-projection-shaped)=${restrictedShape.length} ${JSON.stringify(restrictedShape.slice(0, 3))}`
		);
		strictEqual(bad.length, 0, bad.slice(0, 3).join('\n'));
		strictEqual(restrictedShape.length, 0, restrictedShape.slice(0, 3).join('\n'));
		ok(
			recordFrames >= MIN_RECORD_FRAMES_PER_RUN * RUNS * hotRecordSubs('s').length,
			`only ${recordFrames} s record frames across ${hotRecordSubs('s').length} subscribers`
		);
	});

	test('oracle 3: restricted-role record frames carry title and are only projections', () => {
		let recordFrames = 0;
		const bad: string[] = [];
		const shapes = new Map<string, number>();
		for (const s of hotRecordSubs('r'))
			for (const f of s.frames) {
				const c = classify(f);
				if (c === 'record') {
					recordFrames++;
					const k = `${s.proto}: ${keysOf(f)}`;
					shapes.set(k, (shapes.get(k) ?? 0) + 1);
					if (!/"title"/.test(inner(f).text)) bad.push(`${s.id}: ${short(f)}`);
				} else if (c !== 'empty')
					bad.push(`${s.id} run${f.run} unexpected non-record non-{} frame class=${c}: ${short(f)}`);
			}
		console.log(
			`[QA3307] O3: r record frames=${recordFrames}; shapes=${JSON.stringify([...shapes])}; violations=${bad.length} ${JSON.stringify(bad.slice(0, 3))}`
		);
		strictEqual(bad.length, 0, bad.slice(0, 3).join('\n'));
		// each r hot subscriber got at least N record frames in each load run
		const starved: string[] = [];
		for (const s of hotRecordSubs('r'))
			for (let run = 1; run <= RUNS; run++) {
				const n = s.frames.filter((f) => f.run === run && classify(f) === 'record').length;
				if (n < MIN_RECORD_FRAMES_PER_RUN) starved.push(`${s.id} run${run}=${n}`);
			}
		console.log(
			`[QA3307] O3: r subscribers below ${MIN_RECORD_FRAMES_PER_RUN} record frames in a run: ${JSON.stringify(starved)}`
		);
		strictEqual(starved.length, 0, starved.join(', '));
	});

	test('oracle 4: non-JSON MQTT payloads reach super users byte-unchanged and the restricted role as {}', () => {
		const sMqtt = of('s', 'mqtt0', 'mqttDurable');
		const rMqtt = of('r', 'mqtt0', 'mqttDurable');
		const rows: string[] = [];
		const bad: string[] = [];
		for (const s of [...sMqtt, ...rMqtt]) {
			const c = { record: 0, empty: 0, num: 0, bytes: 0, str: 0, other: 0 };
			const others: string[] = [];
			for (const f of s.frames) {
				const k = classify(f);
				c[k]++;
				if (k === 'other' && others.length < 3) others.push(short(f));
			}
			rows.push(
				`${s.id} total=${s.frames.length} ${JSON.stringify(c)}${others.length ? ' other=' + others.join(' | ') : ''}`
			);
			if (c.other) bad.push(`${s.id}: ${c.other} unclassified frames ${others}`);
			if (s.role === 's') {
				if (c.empty) bad.push(`${s.id}: ${c.empty} '{}' frames to a super user`);
				if (!(c.num > 0 && c.bytes > 0 && c.str > 0)) bad.push(`${s.id}: missing opaque class ${JSON.stringify(c)}`);
			} else {
				if (c.num || c.bytes || c.str) bad.push(`${s.id}: opaque data leaked to restricted role ${JSON.stringify(c)}`);
				if (!(c.empty > 0)) bad.push(`${s.id}: no '{}' envelopes ${JSON.stringify(c)}`);
			}
		}
		console.log(
			`[QA3307] O4 published: ${JSON.stringify(publishedOpaque)}\n[QA3307] O4 per-subscriber classes:\n${rows.join('\n')}`
		);
		strictEqual(bad.length, 0, bad.slice(0, 5).join('\n'));
	});

	test('oracle 4b: REST WebSocket and SSE subscribers get non-JSON messages decoded, the restricted role as {}', () => {
		const rNoEmpty: string[] = [];
		for (const role of ['s', 'r'] as Role[])
			for (const proto of ['ws', 'sse', 'sseRelated'] as Proto[]) {
				const classes = { record: 0, empty: 0, num: 0, bytes: 0, str: 0, other: 0 };
				const samples: string[] = [];
				for (const s of of(role, proto))
					for (const f of s.frames) {
						const k = classify(f);
						classes[k]++;
						if (k !== 'record' && samples.length < 3) samples.push(short(f));
					}
				console.log(
					`[QA3307] O4b ${role}/${proto}: ${JSON.stringify(classes)} nonrecord samples=${JSON.stringify(samples)}`
				);
				if (role === 'r' && proto !== 'sseRelated' && classes.empty === 0) rNoEmpty.push(`${role}/${proto}`);
			}
		deepStrictEqual(rNoEmpty, [], 'restricted ws/sse subscribers received no {} frame for the non-JSON publishes');
		const sBad = subs
			.filter((s) => s.role === 's' && (s.proto === 'ws' || s.proto === 'sse'))
			.map(
				(s) =>
					`${s.id}: ${s.frames.filter((f) => classify(f) === 'other').length} other / ${s.frames.filter((f) => classify(f) === 'num').length} num`
			)
			.filter((l) => !/^\S+: 0 other \/ [1-9]/.test(l));
		strictEqual(sBad.length, 0, `super-user ws/sse opaque decode: ${sBad}`);
		const rBad = subs
			.filter((s) => s.role === 'r' && s.proto !== 'mqtt0')
			.flatMap((s) =>
				s.frames
					.filter((f) => ['num', 'bytes', 'str', 'other'].includes(classify(f)))
					.map((f) => `${s.id}: ${short(f)}`)
			);
		strictEqual(rBad.length, 0, `restricted ws/sse non-{} opaque: ${rBad.slice(0, 3)}`);
		const wsSse = subs.filter((s) => s.proto === 'ws' || s.proto === 'sse');
		const empty = wsSse.filter((s) => s.frames.filter((f) => classify(f) === 'record').length === 0).map((s) => s.id);
		strictEqual(empty.length, 0, `ws/sse subscribers with no record frames: ${empty}`);
	});

	test('oracle 5: no unplanned closes or errors; per-subscriber frame counts', async () => {
		const lines: string[] = [];
		const bad: string[] = [];
		for (const s of subs) {
			const perRun = Array.from({ length: RUNS + 1 }, (_, run) => s.frames.filter((f) => f.run === run).length);
			lines.push(
				`${s.id.padEnd(22)} worker=${String(s.worker ?? 'n/a').padEnd(4)} frames=${String(s.frames.length).padStart(6)} perRun[ctrl,1..]=${JSON.stringify(perRun)}` +
					`${s.status !== undefined ? ' status=' + s.status : ''}${s.suback && s.proto === 'mqttShare' ? ' suback=' + s.suback : ''}` +
					`${s.events.length ? ' events=' + JSON.stringify(s.events) : ''}`
			);
			if (s.unplannedClose && s.proto !== 'sseRelated' && s.proto !== 'mqttShare')
				bad.push(`${s.id}: ${s.events.join('; ')}`);
			if (s.events.some((e) => e.startsWith('error')) && s.proto !== 'mqttShare')
				bad.push(`${s.id}: ${s.events.join('; ')}`);
		}
		console.log(`[QA3307] O5 per-subscriber:\n${lines.join('\n')}`);
		console.log(`[QA3307] workers seen (probes + MQTT attribution): ${[...workersSeen].sort()}`);
		const log = readFileSync(logFile()).subarray(logStart).toString('utf8');
		const errorLines = log
			.split('\n')
			.filter((l) => /\[error\].*(mqtt|subscri|deliver|websocket|sse|session)/i.test(l));
		console.log(`[QA3307] hdb.log (${logFile()}) [error] lines since test start: ${errorLines.length}`);
		for (const l of errorLines.slice(0, 25)) console.log(`[QA3307] LOG ${l}`);
		strictEqual(bad.length, 0, bad.join('\n'));
		ok(workersSeen.size >= 3, `distinct workers seen ${[...workersSeen]}`);
		strictEqual(errorLines.length, 0, `hdb.log has ${errorLines.length} delivery-related [error] lines`);
	});

	test('durable reconnect: resumed sessions are present and keep receiving', () => {
		for (const s of of('r', 'mqttDurable').concat(of('s', 'mqttDurable'))) {
			const byPhase = new Map<string, number>();
			for (const f of s.frames) byPhase.set(f.phase, (byPhase.get(f.phase) ?? 0) + 1);
			console.log(
				`[QA3307] durable ${s.id}: byPhase=${JSON.stringify([...byPhase])} reconnected=${JSON.stringify(s.reconnected)}`
			);
		}
		const resumed = subs.filter((s) => s.proto === 'mqttDurable' && s.reconnected);
		ok(resumed.length > 0);
		const notPresent = resumed.filter((s) => !s.reconnected!.sessionPresent).map((s) => s.id);
		strictEqual(notPresent.length, 0, `sessions not present on reconnect: ${notPresent}`);
		const silentAfter = resumed.filter((s) => !s.frames.some((f) => f.phase.startsWith('post'))).map((s) => s.id);
		strictEqual(silentAfter.length, 0, `resumed sessions that received nothing after reconnect: ${silentAfter}`);
	});

	test('oracle 7: SSE /Doc/hot.related delivers and $share is refused, both without leaks', () => {
		for (const role of ['s', 'r'] as Role[]) {
			const related = of(role, 'sseRelated');
			const shapes = new Map<string, number>();
			const samples: string[] = [];
			for (const s of related)
				for (const f of s.frames) {
					shapes.set(keysOf(f), (shapes.get(keysOf(f)) ?? 0) + 1);
					if (samples.length < 3) samples.push(short(f));
				}
			console.log(
				`[QA3307] O7 ${role} sseRelated: status=${JSON.stringify(related.map((s) => s.status))} frames=${JSON.stringify(related.map((s) => s.frames.length))} shapes=${JSON.stringify([...shapes])} samples=${JSON.stringify(samples)} events=${JSON.stringify(related.map((s) => s.events))}`
			);
		}
		for (const s of of('r', 'mqttShare').concat(of('s', 'mqttShare'))) {
			console.log(
				`[QA3307] $share ${s.id}: suback=${s.suback} frames=${s.frames.length} events=${JSON.stringify(s.events)}`
			);
			ok(String(s.suback).includes('refused'), `${s.id}: $share subscribe was not refused: ${s.suback}`);
		}
		for (const s of of('r', 'sseRelated').concat(of('s', 'sseRelated'))) {
			strictEqual(s.status, 200, `${s.id}: SSE /Doc/hot.related status ${s.status}`);
			ok(s.frames.length > 0, `${s.id}: SSE /Doc/hot.related delivered nothing`);
		}
		const bad = of('r', 'sseRelated', 'mqttShare').flatMap((s) =>
			s.frames.filter(leaks).map((f) => `${s.id}: ${short(f)}`)
		);
		strictEqual(bad.length, 0, bad.slice(0, 3).join('\n'));
	});

	test('completeness: every super-user QoS 1 durable subscriber, reconnected or not, saw every opaque publish', () => {
		const bad: string[] = [];
		const rows: string[] = [];
		const durable = of('s', 'mqttDurable');
		for (const s of durable) {
			const c = { num: 0, bytes: 0, str: 0 };
			const dups = { num: 0, bytes: 0, str: 0 };
			for (const f of s.frames) {
				const k = classify(f);
				if (k === 'num' || k === 'bytes' || k === 'str') {
					c[k]++;
					if (f.dup) dups[k]++;
				}
			}
			rows.push(
				`${s.id} reconnects=${s.events.filter((e) => e.startsWith('planned')).length} received=${JSON.stringify(c)} dupFlagged=${JSON.stringify(dups)} allDupFlagged=${s.frames.filter((f) => f.dup).length}`
			);
			// QoS 1 is at-least-once: no loss; a resume may redeliver what was in flight, so a surplus is reported, not asserted
			for (const k of ['num', 'bytes', 'str'] as const)
				if (c[k] < publishedOpaque[k])
					bad.push(`${s.id} ${k}: LOST ${publishedOpaque[k] - c[k]} (received ${c[k]} of ${publishedOpaque[k]})`);
		}
		console.log(
			`[QA3307] completeness (published ${publishedOpaque.num}/${publishedOpaque.bytes}/${publishedOpaque.str}):\n${rows.join('\n')}`
		);
		strictEqual(durable.length, 4);
		deepStrictEqual(bad, []);
	});
});
