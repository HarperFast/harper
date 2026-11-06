/**
 * Attribute read permissions on the subscription surfaces `subscription-attribute-permissions.test.ts` (PR #3307)
 * does not drive, on 4 worker threads:
 *
 *   A  native MQTT TCP listener (mqtt://host:1883), QoS 1, single topic + wildcard, live PUT/PATCH; a `read: false`
 *      role is refused on TCP (SUBACK >= 0x80); delete pass-through observed
 *   B  MQTT over WebSocket negotiated to CBOR (Accept: application/cbor on the upgrade), decoded + raw bytes
 *   C1 non-retained MQTT PUBLISH by an admin: JSON {title, secret} -> the restricted subscriber gets exactly {title}
 *   C2 payloads the socket's default deserializer stores as {contentType, data} (text/plain, JSON array, JSON string):
 *      delivered to all six open subscribers across the workers (PR #3446), and to the restricted subscriber as {}
 *   D  custom resource TicketView68 (loadAsInstance: false, super.subscribe) over SSE and MQTT: still narrowed
 *
 * Every restricted arm asserts >= 1 delivery AND no `secret` key or value; every open arm asserts the secret.
 * `mqtt/opaque-payload-across-workers.test.ts` (PR #3446) pins C2's delivery for an admin alone and measures the
 * worker placement; C2 adds the restricted subscriber's `{}` projection on the same messages.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-attribute-surfaces.test.ts"
 *   QA68_THREADS=1 npm run test:integration -- "integrationTests/security/subscription-attribute-surfaces.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import request from 'supertest';
import { decode as decodeCbor } from 'cbor-x';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-attribute-surfaces');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const RESTRICTED = { username: 'sqa68_restricted', password: 'Sqa68-restricted-pw!' };
const OPEN = { username: 'sqa68_open', password: 'Sqa68-open-pw!' };
const NOREAD = { username: 'sqa68_noread', password: 'Sqa68-noread-pw!' };
// QA68_THREADS selects the worker count (default 4); an unparseable value fails loudly rather than defaulting
const THREADS = process.env.QA68_THREADS === undefined ? 4 : Number(process.env.QA68_THREADS);
if (!Number.isInteger(THREADS) || THREADS < 0) throw new Error(`QA68_THREADS unparseable: ${process.env.QA68_THREADS}`);

const basic = (u: { username: string; password: string }) =>
	'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(40);
	}
	return predicate();
}

interface Msg {
	topic: string;
	raw: Buffer;
	text: string;
	enc: 'json' | 'cbor' | 'empty' | 'other';
	value: unknown;
}
function decodeBytes(topic: string, buf: Buffer): Msg {
	if (buf.length === 0) return { topic, raw: buf, text: '', enc: 'empty', value: undefined };
	const s = buf.toString('utf8');
	try {
		return { topic, raw: buf, text: s, enc: 'json', value: JSON.parse(s) };
	} catch {
		/* not json */
	}
	try {
		const value = decodeCbor(buf);
		return { topic, raw: buf, text: JSON.stringify(value), enc: 'cbor', value };
	} catch {
		return { topic, raw: buf, text: s, enc: 'other', value: s };
	}
}
const leaked = (m: Msg) => /secret/i.test(m.raw.toString('latin1')) || /secret/i.test(m.text);
const dump = (msgs: Msg[]) => msgs.map((m) => `${m.topic} [${m.enc}] ${m.text}`).join('\n  ');
const obs = (arm: string, msgs: Msg[]) => console.log(`OBS [${arm}] (${msgs.length} msgs)\n  ${dump(msgs)}`);

function assertNoLeak(arm: string, msgs: Msg[], minMsgs = 1) {
	ok(msgs.length >= minMsgs, `${arm}: expected >= ${minMsgs} deliveries, got ${msgs.length} (inconclusive)`);
	const bad = msgs.filter(leaked);
	ok(
		bad.length === 0,
		`ATTRIBUTE LEAK on ${arm}: ${bad.length}/${msgs.length} payload(s) carry secret:\n  ${dump(bad)}`
	);
}
function assertPositive(arm: string, msgs: Msg[]) {
	ok(msgs.some(leaked), `${arm}: open role never saw the secret — the control is dead:\n  ${dump(msgs)}`);
}

suite(
	'attribute read permissions on the remaining subscription surfaces',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL: string;
		let wsBase: string;
		let tcpURL: string;
		let adminAuth: { username: string; password: string };
		const clients: MqttClient[] = [];
		const sseClose: Array<() => void> = [];

		function connectMqtt(
			url: string,
			auth: { username: string; password: string },
			clientId: string,
			extra: Partial<IClientOptions> = {}
		): Promise<{ client: MqttClient; msgs: Msg[] }> {
			const msgs: Msg[] = [];
			const options: IClientOptions = {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8000,
				clean: true,
				clientId,
				...auth,
				...extra,
			};
			return new Promise((res, reject) => {
				const c = mqtt.connect(url, options);
				c.on('message', (topic, payload) => msgs.push(decodeBytes(topic, Buffer.from(payload))));
				c.once('connect', () => {
					c.on('error', () => {});
					clients.push(c);
					res({ client: c, msgs });
				});
				c.once('error', reject);
			});
		}
		/** SUBACK reason code; on a refused SUBACK mqtt.js echoes the request in `granted`, so read err.packet.granted */
		function subscribe(c: MqttClient, topic: string, qos: 0 | 1 = 1): Promise<number> {
			return new Promise((res, reject) => {
				const timer = setTimeout(() => reject(new Error(`no SUBACK for ${topic} within 10 s`)), 10_000);
				c.subscribe(topic, { qos }, (err: any, granted: any) => {
					clearTimeout(timer);
					if (err && !err.packet) return reject(err);
					const codes = err?.packet?.granted ?? granted?.map((g: any) => g.qos);
					res(codes?.[0] ?? -1);
				});
			});
		}
		function publish(c: MqttClient, topic: string, payload: string | Buffer, opts: any = {}): Promise<number> {
			return new Promise((res, reject) => {
				const timer = setTimeout(() => reject(new Error(`no PUBACK for ${topic} within 10s`)), 10_000);
				c.publish(topic, payload, { qos: 1, retain: false, ...opts }, (error: any, packet: any) => {
					clearTimeout(timer);
					res(error ? (error.code ?? -1) : (packet?.reasonCode ?? 0));
				});
			});
		}
		function openSse(path: string, authorization: string): { msgs: Msg[]; status: () => number } {
			const url = new URL(restURL);
			const msgs: Msg[] = [];
			let status = 0;
			let buffer = '';
			const req = httpRequest(
				{
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port,
					method: 'GET',
					path,
					headers: { Accept: 'text/event-stream', Authorization: authorization },
				},
				(res) => {
					status = res.statusCode ?? 0;
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => {
						buffer += chunk;
						let sep: number;
						while ((sep = buffer.indexOf('\n\n')) >= 0) {
							const frame = buffer.slice(0, sep);
							buffer = buffer.slice(sep + 2);
							const data = frame
								.split('\n')
								.filter((l) => l.startsWith('data:'))
								.map((l) => l.slice(5).trimStart())
								.join('\n');
							if (data) msgs.push(decodeBytes(path, Buffer.from(data)));
						}
					});
				}
			);
			req.on('error', () => {});
			req.end();
			sseClose.push(() => req.destroy());
			return { msgs, status: () => status };
		}
		const adminHeaders = () => client.headers as Record<string, string>;
		const put = (table: string, id: string, body: object) =>
			request(restURL).put(`/${table}/${id}`).set(adminHeaders()).send(body);
		const patch = (table: string, id: string, body: object) =>
			request(restURL).patch(`/${table}/${id}`).set(adminHeaders()).send(body);
		const del = (table: string, id: string) => request(restURL).delete(`/${table}/${id}`).set(adminHeaders());
		const seed = (id: string, tag: string) => ({
			id,
			title: `title-${tag}-v1`,
			owner: 'ownerA',
			secret: `SECRET-${tag}-v1`,
		});

		/** admin PUT then PATCH on `id`; returns the final title a subscriber must have seen (the PUT may be superseded) */
		async function drive(table: string, id: string, tag: string) {
			await put(table, id, { id, title: `title-${tag}-v2`, owner: 'ownerA', secret: `SECRET-${tag}-v2` }).expect(204);
			await sleep(150);
			const p = await patch(table, id, { title: `title-${tag}-v3`, secret: `SECRET-${tag}-v3` });
			ok(p.status < 300, `PATCH ${table}/${id} ${p.status} ${p.text}`);
			return [`title-${tag}-v3`];
		}
		const sawAll = (msgs: Msg[], titles: string[]) => titles.every((t) => msgs.some((m) => m.text.includes(t)));

		let privateTmp: string;
		before(async () => {
			privateTmp = mkdtempSync(join(tmpdir(), 'subscription-attribute-surfaces-'));
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: THREADS } },
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false', TMPDIR: privateTmp },
			});
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			wsBase = restURL.replace(/^http/, 'ws');
			tcpURL = `mqtt://${ctx.harper.hostname}:1883`;
			adminAuth = { username: ctx.harper.admin.username, password: ctx.harper.admin.password };

			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Ticket68/').timeout(3000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
			const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
			strictEqual(cfg.body.threads?.count, THREADS, `threads.count: ${JSON.stringify(cfg.body.threads)}`);

			const attr = (attribute_name: string) => ({ attribute_name, read: true, insert: true, update: true });
			const table = (read: boolean, attribute_permissions: object[]) => ({
				read,
				insert: read,
				update: read,
				delete: false,
				attribute_permissions,
			});
			const perm = (read: boolean, attribute_permissions: object[]) => ({
				super_user: false,
				data: { tables: { Ticket68: table(read, attribute_permissions) } },
			});
			for (const [role, permission] of [
				['sqa68_restricted', perm(true, [attr('title'), attr('owner')])],
				['sqa68_open', perm(true, [])],
				['sqa68_noread', perm(false, [])],
			] as const) {
				await client.req().send({ operation: 'add_role', role, permission }).expect(200);
			}
			for (const [u, role] of [
				[RESTRICTED, 'sqa68_restricted'],
				[OPEN, 'sqa68_open'],
				[NOREAD, 'sqa68_noread'],
			] as const) {
				await client
					.req()
					.send({ operation: 'add_user', role, username: u.username, password: u.password, active: true })
					.expect(200);
			}
			const records = ['tcp', 'tcpw', 'cbor', 'msg', 'view', 'open'].map((t) => seed(`${t}-1`, t));
			await client.req().send({ operation: 'insert', schema: 'data', table: 'Ticket68', records }).expect(200);
		});

		after(async () => {
			for (const close of sseClose) close();
			for (const c of clients) await new Promise<void>((r) => c.end(true, {}, () => r()));
			await teardownHarper(ctx);
			if (privateTmp) rmSync(privateTmp, { recursive: true, force: true });
		});

		test('CONTROL: restricted REST GET omits secret; open GET has it', async () => {
			const r = await client.reqRest('/Ticket68/tcp-1').set('Authorization', basic(RESTRICTED));
			const o = await client.reqRest('/Ticket68/tcp-1').set('Authorization', basic(OPEN));
			console.log(`OBS [rest] restricted ${r.status} ${r.text} | open ${o.status} ${o.text}`);
			strictEqual(r.status, 200);
			ok(!/secret/i.test(r.text), `restricted GET leaks: ${r.text}`);
			ok(r.text.includes('title-tcp-v1'));
			strictEqual(o.status, 200);
			ok(/SECRET-tcp-v1/.test(o.text));
		});

		test('A: native MQTT TCP listener — credentials honoured, single + wildcard at QoS 1, live PUT/PATCH', async () => {
			// a read:false user is refused on TCP too (guards against local auto-authorization masking the role)
			const nr = await connectMqtt(tcpURL, NOREAD, 'sqa68-tcp-noread');
			const nrCode = await subscribe(nr.client, 'Ticket68/tcp-1');
			console.log(`OBS [A] noread TCP SUBACK ${nrCode}`);
			ok(
				nrCode >= 0x80,
				`TCP listener did not honour read:false credentials (SUBACK ${nrCode}) — local auto-authorization?`
			);

			const rSingle = await connectMqtt(tcpURL, RESTRICTED, 'sqa68-tcp-r-single');
			const rWild = await connectMqtt(tcpURL, RESTRICTED, 'sqa68-tcp-r-wild');
			const oSingle = await connectMqtt(tcpURL, OPEN, 'sqa68-tcp-o-single');
			strictEqual(await subscribe(rSingle.client, 'Ticket68/tcp-1'), 1, 'restricted single SUBACK');
			strictEqual(await subscribe(rWild.client, 'Ticket68/#'), 1, 'restricted wildcard SUBACK');
			strictEqual(await subscribe(oSingle.client, 'Ticket68/tcp-1'), 1, 'open single SUBACK');
			ok(
				await waitFor(() => rSingle.msgs.length >= 1 && oSingle.msgs.length >= 1),
				'retained current record delivered'
			);
			const titles = await drive('Ticket68', 'tcp-1', 'tcp');
			const live = await waitFor(
				() => sawAll(rSingle.msgs, titles) && sawAll(oSingle.msgs, titles) && sawAll(rWild.msgs, titles)
			);
			// a new row and its delete, seen by the wildcard subscriber (delete arrives as an empty payload if at all)
			await put('Ticket68', 'tcpw-2', {
				id: 'tcpw-2',
				title: 'title-tcpw-n1',
				owner: 'ownerB',
				secret: 'SECRET-tcpw-n1',
			}).expect(204);
			const newRow = await waitFor(() => rWild.msgs.some((m) => m.topic === 'Ticket68/tcpw-2' && m.enc !== 'empty'));
			const d = await del('Ticket68', 'tcpw-2');
			ok(d.status < 300, `DELETE ${d.status}`);
			await waitFor(() => rWild.msgs.some((m) => m.topic === 'Ticket68/tcpw-2' && m.enc === 'empty'), 4000);
			obs('A tcp restricted single', rSingle.msgs);
			obs('A tcp restricted wildcard', rWild.msgs);
			obs('A tcp open single', oSingle.msgs);
			ok(live, 'live PUT/PATCH delivered to every TCP subscriber');
			ok(newRow, 'new row delivered to the wildcard TCP subscriber');
			assertNoLeak('A tcp restricted single', rSingle.msgs, 3);
			assertNoLeak('A tcp restricted wildcard', rWild.msgs, 4);
			assertPositive('A tcp open single', oSingle.msgs);
			for (const m of rSingle.msgs) ok(m.enc === 'json', `tcp single payload not json: ${m.enc}`);
		});

		test('B: MQTT over WebSocket negotiated to CBOR — decoded and raw bytes carry no secret', async () => {
			const cbor = { wsOptions: { headers: { accept: 'application/cbor' } } } as Partial<IClientOptions>;
			const r = await connectMqtt(`${wsBase}/mqtt`, RESTRICTED, 'sqa68-cbor-r', cbor);
			const o = await connectMqtt(`${wsBase}/mqtt`, OPEN, 'sqa68-cbor-o', cbor);
			strictEqual(await subscribe(r.client, 'Ticket68/cbor-1'), 1);
			strictEqual(await subscribe(o.client, 'Ticket68/cbor-1'), 1);
			ok(await waitFor(() => r.msgs.length >= 1 && o.msgs.length >= 1), 'current record delivered');
			const titles = await drive('Ticket68', 'cbor-1', 'cbor');
			const live = await waitFor(() => sawAll(r.msgs, titles) && sawAll(o.msgs, titles));
			obs('B cbor restricted', r.msgs);
			obs('B cbor open', o.msgs);
			ok(live, 'live events delivered');
			ok(
				o.msgs.some((m) => m.enc === 'cbor'),
				`negotiation did not take: open encodings ${o.msgs.map((m) => m.enc)}`
			);
			ok(
				r.msgs.some((m) => m.enc === 'cbor'),
				`negotiation did not take: restricted encodings ${r.msgs.map((m) => m.enc)}`
			);
			assertNoLeak('B cbor restricted', r.msgs, 3);
			assertPositive('B cbor open', o.msgs);
		});

		test('C1: non-retained MQTT PUBLISH by admin — JSON message narrowed to {title} for the restricted subscriber', async () => {
			const r = await connectMqtt(`${wsBase}/mqtt`, RESTRICTED, 'sqa68-msg-r');
			const o = await connectMqtt(`${wsBase}/mqtt`, OPEN, 'sqa68-msg-o');
			const pub = await connectMqtt(`${wsBase}/mqtt`, adminAuth, 'sqa68-msg-admin');
			strictEqual(await subscribe(r.client, 'Ticket68/msg-1'), 1);
			strictEqual(await subscribe(o.client, 'Ticket68/msg-1'), 1);
			ok(await waitFor(() => r.msgs.length >= 1 && o.msgs.length >= 1), 'current record delivered');
			const before = { r: r.msgs.length, o: o.msgs.length };
			strictEqual(
				await publish(pub.client, 'Ticket68/msg-1', JSON.stringify({ title: 'msg-json', secret: 'SECRET-msg-json' })),
				0
			);
			const jsonToOpen = await waitFor(() => o.msgs.some((m) => m.text.includes('msg-json')));
			const jsonToRestricted = await waitFor(() => r.msgs.length > before.r);
			const rJson = r.msgs.find((m) => m.text.includes('msg-json'));

			obs('C msg restricted', r.msgs);
			obs('C msg open', o.msgs);

			ok(jsonToOpen, 'json message delivered to open');
			ok(jsonToRestricted && rJson, 'json message delivered to restricted');
			deepStrictEqual(rJson!.value, { title: 'msg-json' }, `restricted json message not narrowed: ${rJson!.text}`);
			assertNoLeak('C msg restricted', r.msgs, 2);
			assertPositive('C msg open', o.msgs);
			// stored record untouched by non-retained messages
			const stored = await client.reqRest('/Ticket68/msg-1');
			strictEqual(stored.body.title, 'title-msg-v1', stored.text);
		});

		test('C2: opaque MQTT payloads (first byte not `{`) reach every open subscriber, and the restricted subscriber as {}', async () => {
			// Order-dependent: a delivering worker's first decode of the opaque record shape is what went wrong before
			// PR #3446, so no earlier arm may publish an opaque payload.
			const r = await connectMqtt(`${wsBase}/mqtt`, RESTRICTED, 'sqa68-opq-r');
			const opens: Array<{ label: string; client: MqttClient; msgs: Msg[] }> = [];
			for (let i = 0; i < 5; i++) {
				const c = await connectMqtt(`${wsBase}/mqtt`, OPEN, `sqa68-opq-o-ws${i}`);
				opens.push({ label: `ws${i}`, ...c });
			}
			opens.push({ label: 'tcp', ...(await connectMqtt(tcpURL, OPEN, 'sqa68-opq-o-tcp')) });
			const pub = await connectMqtt(`${wsBase}/mqtt`, adminAuth, 'sqa68-opq-admin');
			strictEqual(await subscribe(r.client, 'Ticket68/msg-1'), 1);
			for (const o of opens) strictEqual(await subscribe(o.client, 'Ticket68/msg-1'), 1, `${o.label} SUBACK`);
			ok(await waitFor(() => r.msgs.length >= 1 && opens.every((o) => o.msgs.length >= 1)), 'current record delivered');
			// control: a JSON object message reaches every subscriber
			strictEqual(await publish(pub.client, 'Ticket68/msg-1', JSON.stringify({ title: 'opq-control' })), 0);
			const controlAll = await waitFor(() => opens.every((o) => o.msgs.some((m) => m.text.includes('opq-control'))));
			// payloads the socket's default deserializer does not parse as a JSON object (first byte not `{`)
			const opaque: Array<[string, Buffer, any]> = [
				['text/plain', Buffer.from('SECRET-msg-plain'), { properties: { contentType: 'text/plain' } }],
				['json-array', Buffer.from('["SECRET-msg-array"]'), {}],
				['json-string', Buffer.from('"SECRET-msg-string"'), {}],
			];
			const delivered: Record<string, { open: string[]; missed: string[]; restricted: number }> = {};
			for (const [label, payload, opts] of opaque) {
				const marker = payload.toString().replace(/[^A-Za-z-]/g, '');
				const rBefore = r.msgs.length;
				strictEqual(await publish(pub.client, 'Ticket68/msg-1', payload, opts), 0, `PUBACK ${label}`);
				await waitFor(() => opens.every((o) => o.msgs.some((m) => m.text.includes(marker))), 4000);
				await waitFor(() => r.msgs.length > rBefore, 4000);
				const rNew = r.msgs.slice(rBefore);
				strictEqual(rNew.length, 1, `${label}: restricted subscriber received ${rNew.length} frame(s), expected one`);
				deepStrictEqual(rNew[0].value, {}, `${label}: restricted projection is not {}: ${rNew[0].text}`);
				const got = opens.filter((o) => o.msgs.some((m) => m.text.includes(marker))).map((o) => o.label);
				delivered[label] = {
					open: got,
					missed: opens.map((o) => o.label).filter((l) => !got.includes(l)),
					restricted: r.msgs.length - rBefore,
				};
			}
			obs('C2 opaque restricted', r.msgs);
			for (const o of opens) obs(`C2 opaque open ${o.label}`, o.msgs);
			console.log(`OBS [C2] opaque payload delivery (threads=${THREADS}): ${JSON.stringify(delivered)}`);
			ok(controlAll, 'the JSON-object control message did not reach every open subscriber (inconclusive)');
			assertNoLeak('C2 opaque restricted', r.msgs, 1);
			for (const [label] of opaque)
				strictEqual(
					delivered[label].missed.length,
					0,
					`${label} message never reached open subscriber(s) ${delivered[label].missed.join(',')} (threads=${THREADS})`
				);
		});

		test('D: custom resource TicketView68 (loadAsInstance:false, super.subscribe) — SSE and MQTT still narrowed', async () => {
			const rSse = openSse('/TicketView68/view-1', basic(RESTRICTED));
			const oSse = openSse('/TicketView68/view-1', basic(OPEN));
			const rMq = await connectMqtt(`${wsBase}/mqtt`, RESTRICTED, 'sqa68-view-r');
			const oMq = await connectMqtt(`${wsBase}/mqtt`, OPEN, 'sqa68-view-o');
			const rCode = await subscribe(rMq.client, 'TicketView68/view-1');
			const oCode = await subscribe(oMq.client, 'TicketView68/view-1');
			console.log(`OBS [D] SUBACK restricted=${rCode} open=${oCode}`);
			ok(
				await waitFor(() => rSse.status() !== 0 && oSse.status() !== 0, 8000),
				'SSE on the custom resource did not answer'
			);
			console.log(`OBS [D] SSE status restricted=${rSse.status()} open=${oSse.status()}`);
			const titles = await drive('Ticket68', 'view-1', 'view');
			await waitFor(() => sawAll(oSse.msgs, titles) && sawAll(rSse.msgs, titles), 8000);
			await waitFor(() => sawAll(oMq.msgs, titles) && sawAll(rMq.msgs, titles), 8000);
			obs('D view SSE restricted', rSse.msgs);
			obs('D view SSE open', oSse.msgs);
			obs('D view MQTT restricted', rMq.msgs);
			obs('D view MQTT open', oMq.msgs);
			strictEqual(rSse.status(), 200, 'restricted SSE on the custom resource');
			strictEqual(oSse.status(), 200, 'open SSE on the custom resource');
			assertNoLeak('D view SSE restricted', rSse.msgs, 2);
			assertPositive('D view SSE open', oSse.msgs);
			ok(
				rCode <= 1 && oCode <= 1,
				`MQTT subscribe to the custom resource refused (restricted ${rCode}, open ${oCode})`
			);
			assertNoLeak('D view MQTT restricted', rMq.msgs, 2);
			assertPositive('D view MQTT open', oMq.msgs);
		});
	}
);
