/**
 * Attribute read permissions on subscription collection streams, wildcard topics and caller selects: a role whose
 * `attribute_permissions` lists only `title` and `owner` of `Ticket` never receives `secret` over SSE (collection
 * and single record), REST WebSocket (collection and single record) or MQTT (`Ticket/#` and `Ticket/<id>`, QoS 0
 * and 1), and a caller `select(title)` or `select(title,secret)` from that role never widens past the permission
 * select. Positive control: the open role (`attribute_permissions: []`) receives the secret on the same surface.
 * Admission control: a role with table `read: false` is refused on each surface (403, or SUBACK >= 0x80).
 *
 * `subscription-attribute-permissions.test.ts` (PR #3307) pins the single-record streams and session replay; this
 * file pins the collection and wildcard streams and the caller-select interaction, with `authorizeLocal` off so
 * every request is authenticated as the role it names. Promoted from the qa-explorer bank (SQA-35, SP-28).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-attribute-collection-streams.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import request from 'supertest';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import WebSocket from 'ws';
import { decode as decodeCbor } from 'cbor-x';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-attribute-collection-streams');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const RESTRICTED = { username: 'sqa35_restricted', password: 'Sqa35-restricted-pw!' };
const OPEN = { username: 'sqa35_open', password: 'Sqa35-open-pw!' };
const NOREAD = { username: 'sqa35_noread', password: 'Sqa35-noread-pw!' };
const basic = (u: { username: string; password: string }) =>
	'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleepMs(intervalMs);
	}
	return predicate();
}

// ------------------------------------------------------------------ payload capture
interface Msg {
	text: string; // decoded payload as JSON text (or utf8 if undecodable)
	raw: string; // latin1 of the raw bytes, for leak scanning independent of decoding
	meta: Record<string, unknown>;
}
interface Sub {
	label: string;
	msgs: Msg[];
	status: () => number;
	closed: () => boolean;
	close: () => void;
}

function decodeBytes(buf: Buffer): { text: string; enc: string } {
	const s = buf.toString('utf8');
	try {
		JSON.parse(s);
		return { text: s, enc: 'json' };
	} catch {
		/* not json */
	}
	try {
		return { text: JSON.stringify(decodeCbor(buf)), enc: 'cbor' };
	} catch {
		return { text: s, enc: 'undecodable' };
	}
}

function leaked(m: Msg): boolean {
	return /secret/i.test(m.raw) || /secret/i.test(m.text);
}
const dump = (msgs: Msg[]) => msgs.map((m) => `${JSON.stringify(m.meta)} ${m.text}`).join('\n  ');
const obs = (arm: string, who: string, msgs: Msg[]) =>
	console.log(`OBS [${arm}] ${who} (${msgs.length} msgs)\n  ${dump(msgs)}`);

function openSse(restURL: string, path: string, authorization: string, label: string): Sub {
	const url = new URL(restURL);
	const msgs: Msg[] = [];
	let status = 0;
	let closed = false;
	let buffer = '';
	const parse = (frame: string) => {
		if (!frame.trim()) return;
		const meta: Record<string, unknown> = {};
		let data: string | undefined;
		for (const line of frame.split('\n')) {
			const idx = line.indexOf(':');
			if (idx < 0) continue;
			const field = line.slice(0, idx);
			const val = line.slice(idx + 1).replace(/^ /, '');
			if (field === 'data') data = (data ? data + '\n' : '') + val;
			else meta[field] = val;
		}
		msgs.push({ text: data ?? '', raw: frame, meta });
	};
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
					parse(buffer.slice(0, sep));
					buffer = buffer.slice(sep + 2);
				}
			});
			res.on('end', () => (closed = true));
			res.on('close', () => (closed = true));
			res.on('error', () => (closed = true));
		}
	);
	req.on('error', () => (closed = true));
	req.end();
	return { label, msgs, status: () => status, closed: () => closed, close: () => req.destroy() };
}

function openWs(wsBase: string, path: string, authorization: string, label: string): Promise<Sub> {
	const msgs: Msg[] = [];
	let status = 0;
	let closed = false;
	const ws = new WebSocket(`${wsBase}${path}`, {
		headers: { Authorization: authorization },
		rejectUnauthorized: false,
	});
	const sub: Sub = {
		label,
		msgs,
		status: () => status,
		closed: () => closed,
		close: () => {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		},
	};
	ws.on('message', (d: Buffer, isBinary: boolean) => {
		const buf = Buffer.isBuffer(d) ? d : Buffer.from(d as any);
		const { text, enc } = decodeBytes(buf);
		msgs.push({ text, raw: buf.toString('latin1'), meta: { enc, isBinary, bytes: buf.length } });
	});
	ws.on('close', () => (closed = true));
	ws.on('error', () => {});
	ws.on('unexpected-response', (_req, res) => {
		status = res.statusCode ?? 0;
		closed = true;
	});
	return new Promise<Sub>((resolveP) => {
		const timer = setTimeout(() => resolveP(sub), 8000);
		ws.once('open', () => {
			status = 101;
			clearTimeout(timer);
			resolveP(sub);
		});
		ws.once('error', () => {
			clearTimeout(timer);
			resolveP(sub);
		});
		ws.once('unexpected-response', () => {
			clearTimeout(timer);
			resolveP(sub);
		});
	});
}

function mqttConnect(url: string, user: { username: string; password: string }, clientId: string): Promise<MqttClient> {
	const opts: IClientOptions = {
		protocolVersion: 5,
		reconnectPeriod: 0,
		connectTimeout: 8000,
		clean: true,
		rejectUnauthorized: false,
		...user,
		clientId,
	};
	return new Promise((resolveP, reject) => {
		const c = mqtt.connect(url, opts);
		const onError = (err: Error) => {
			c.removeListener('connect', onConnect);
			c.end(true);
			reject(err);
		};
		const onConnect = () => {
			c.removeListener('error', onError);
			c.on('error', () => {});
			resolveP(c);
		};
		c.once('error', onError);
		c.once('connect', onConnect);
	});
}

/** Subscribe and return the SUBACK reason codes (err.packet.granted on a rejected SUBACK, not the callback arg). */
function mqttSubscribe(c: MqttClient, topic: string, qos: 0 | 1): Promise<{ codes: unknown; err?: string }> {
	return new Promise((res) =>
		c.subscribe(topic, { qos }, (err: any, granted: any) =>
			res(
				err
					? { codes: err.packet?.granted, err: String(err.message ?? err) }
					: { codes: granted?.map((g: any) => g.qos) }
			)
		)
	);
}

function collectMqtt(c: MqttClient): Msg[] {
	const msgs: Msg[] = [];
	c.on('message', (topic, payload, packet) => {
		const { text, enc } = decodeBytes(payload);
		msgs.push({
			text,
			raw: payload.toString('latin1'),
			meta: { topic, enc, retain: packet.retain, qos: packet.qos, props: (packet as any).properties },
		});
	});
	return msgs;
}

suite(
	'SQA-35 attribute-level read restriction vs subscription payloads',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL = '';
		let wsBase = '';
		let mqttURL = '';
		const subs = new Set<Sub>();
		const mqttClients = new Set<MqttClient>();

		const adminReq = () => ({ ...client.headers });
		const put = (id: string, body: object) => request(restURL).put(`/Ticket/${id}`).set(adminReq()).send(body);
		const patch = (id: string, body: object) => request(restURL).patch(`/Ticket/${id}`).set(adminReq()).send(body);
		const del = (id: string) => request(restURL).delete(`/Ticket/${id}`).set(adminReq());

		const perm = (
			read: boolean,
			attrs: Array<{ attribute_name: string; read: boolean; insert: boolean; update: boolean }>
		) => ({
			super_user: false,
			data: { tables: { Ticket: { read, insert: false, update: false, delete: false, attribute_permissions: attrs } } },
		});

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 } },
				// loopback auto-authorization would turn every request into the super user and void the experiment
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			wsBase = restURL.replace(/^http/, 'ws');
			mqttURL = `${wsBase}/mqtt`;

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Ticket/').timeout(3000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}

			const attr = (attribute_name: string) => ({ attribute_name, read: true, insert: false, update: false });
			await client
				.req()
				.send({
					operation: 'add_role',
					role: 'sqa35_restricted',
					permission: perm(true, [attr('title'), attr('owner')]),
				})
				.expect(200);
			await client
				.req()
				.send({ operation: 'add_role', role: 'sqa35_open', permission: perm(true, []) })
				.expect(200);
			await client
				.req()
				.send({ operation: 'add_role', role: 'sqa35_noread', permission: perm(false, []) })
				.expect(200);
			for (const [u, role] of [
				[RESTRICTED, 'sqa35_restricted'],
				[OPEN, 'sqa35_open'],
				[NOREAD, 'sqa35_noread'],
			] as const) {
				await client
					.req()
					.send({ operation: 'add_user', role, username: u.username, password: u.password, active: true })
					.expect(200);
			}

			const records = ['sse', 'ws', 'mqtt', 'sel'].map((s) => ({
				id: `${s}-1`,
				title: 'title-v1',
				owner: 'ownerA',
				secret: `SECRET-${s}-initial`,
			}));
			await client.req().send({ operation: 'insert', schema: 'data', table: 'Ticket', records }).expect(200);
		});

		after(async () => {
			for (const s of subs) s.close();
			for (const c of mqttClients) await new Promise<void>((r) => c.end(true, {}, () => r()));
			await teardownHarper(ctx);
		});

		/** Admin writes: PUT existing, PATCH existing, PUT new, DELETE new. Secrets are unique per surface. */
		async function drive(s: string) {
			await put(`${s}-1`, { id: `${s}-1`, title: 'title-v2', owner: 'ownerA', secret: `SECRET-${s}-put` }).expect(204);
			await sleep(200);
			const p = await patch(`${s}-1`, { title: 'title-v3', secret: `SECRET-${s}-patch` });
			ok(p.status < 300, `PATCH failed ${p.status} ${p.text}`);
			await sleep(200);
			await put(`${s}-2`, { id: `${s}-2`, title: 'title-n1', owner: 'ownerB', secret: `SECRET-${s}-put2` }).expect(204);
			await sleep(200);
			const d = await del(`${s}-2`);
			ok(d.status < 300, `DELETE failed ${d.status} ${d.text}`);
		}

		function assertNoLeak(arm: string, msgs: Msg[]) {
			const bad = msgs.filter(leaked);
			ok(
				bad.length === 0,
				`ATTRIBUTE LEAK on ${arm}: ${bad.length}/${msgs.length} restricted-user payload(s) contain secret:\n  ${dump(bad)}`
			);
		}

		// ---------------------------------------------------------------- controls
		test('NEGATIVE CONTROL: restricted REST GET omits secret and keeps title', async () => {
			const one = await request(restURL).get('/Ticket/sse-1').set('Authorization', basic(RESTRICTED));
			console.log(`OBS [rest] restricted GET /Ticket/sse-1 -> ${one.status} ${one.text}`);
			strictEqual(one.status, 200);
			ok(one.body.title === 'title-v1', `title missing: ${one.text}`);
			ok(!('secret' in one.body) && !/SECRET/.test(one.text), `REST leaked secret: ${one.text}`);

			const col = await request(restURL).get('/Ticket/').set('Authorization', basic(RESTRICTED));
			console.log(`OBS [rest] restricted GET /Ticket/ -> ${col.status} ${col.text.slice(0, 400)}`);
			strictEqual(col.status, 200);
			ok(Array.isArray(col.body) && col.body.length >= 4, `expected >=4 rows: ${col.text}`);
			ok(
				col.body.every((r: any) => r.title === 'title-v1'),
				`title missing on collection: ${col.text}`
			);
			ok(!/secret/i.test(col.text), `REST collection leaked secret: ${col.text}`);
		});

		test('POSITIVE CONTROL (REST): open role sees secret', async () => {
			const one = await request(restURL).get('/Ticket/sse-1').set('Authorization', basic(OPEN));
			console.log(`OBS [rest] open GET /Ticket/sse-1 -> ${one.status} ${one.text}`);
			strictEqual(one.status, 200);
			strictEqual(one.body.secret, 'SECRET-sse-initial');
		});

		test('ADMISSION CONTROL: read:false role refused on SSE (403), WebSocket and MQTT SUBACK >= 0x80', async () => {
			const sse = openSse(restURL, '/Ticket/', basic(NOREAD), 'noread-sse');
			subs.add(sse);
			ok(await waitFor(() => sse.status() !== 0 || sse.closed(), 5000), 'no SSE response at all');
			console.log(`OBS [admission] SSE noread status ${sse.status()}`);
			strictEqual(sse.status(), 403);

			const ws = await openWs(wsBase, '/Ticket/', basic(NOREAD), 'noread-ws');
			subs.add(ws);
			await sleep(500);
			console.log(`OBS [admission] WS noread status ${ws.status()} closed=${ws.closed()} msgs=${ws.msgs.length}`);
			ok(ws.status() !== 101 || ws.closed(), `WS upgrade for read:false role stayed open (status ${ws.status()})`);

			const c = await mqttConnect(mqttURL, NOREAD, 'sqa35-noread');
			mqttClients.add(c);
			const r = await mqttSubscribe(c, 'Ticket/#', 1);
			console.log(`OBS [admission] MQTT noread SUBACK ${JSON.stringify(r)}`);
			ok(
				Array.isArray(r.codes) && (r.codes as number[]).every((x) => x >= 0x80),
				`SUBACK not rejected: ${JSON.stringify(r)}`
			);
		});

		// ---------------------------------------------------------------- SSE
		test('SSE: collection + single-record streams (restricted vs open) honour attribute restriction', async () => {
			const s = 'sse';
			const rc = openSse(restURL, '/Ticket/', basic(RESTRICTED), 'restricted-collection');
			const rs = openSse(restURL, `/Ticket/${s}-1`, basic(RESTRICTED), 'restricted-single');
			const oc = openSse(restURL, '/Ticket/', basic(OPEN), 'open-collection');
			const os = openSse(restURL, `/Ticket/${s}-1`, basic(OPEN), 'open-single');
			for (const x of [rc, rs, oc, os]) subs.add(x);

			// single-record stream delivers current value on open
			ok(
				await waitFor(() => rs.msgs.length >= 1 && os.msgs.length >= 1, 6000),
				`no initial single-record delivery: restricted=${rs.msgs.length} open=${os.msgs.length}`
			);
			await sleep(500);
			await drive(s);
			await waitFor(() => oc.msgs.some((m) => m.text.includes(`SECRET-${s}-put2`)) && oc.msgs.length >= 4, 8000);
			await sleep(1500);

			for (const x of [rc, rs, oc, os]) obs(`sse ${x.label}`, `status=${x.status()}`, x.msgs);
			for (const x of [rc, rs, oc, os]) strictEqual(x.status(), 200, `${x.label} status`);

			// positive control
			ok(
				os.msgs.some((m) => m.text.includes(`SECRET-${s}-initial`)),
				'POSITIVE CONTROL: open single stream initial delivery lacks secret'
			);
			ok(
				os.msgs.some((m) => m.text.includes(`SECRET-${s}-put`)),
				'POSITIVE CONTROL: open single stream put lacks secret'
			);
			ok(
				oc.msgs.some((m) => m.text.includes(`SECRET-${s}-patch`)),
				'POSITIVE CONTROL: open collection stream patch lacks secret'
			);
			// liveness of restricted subscribers (so absence of secret is not vacuous)
			ok(
				rs.msgs.some((m) => m.text.includes('title-v2')),
				'restricted single stream did not deliver the put (inconclusive)'
			);
			ok(
				rc.msgs.some((m) => m.text.includes('title-n1')),
				'restricted collection stream did not deliver the new row (inconclusive)'
			);

			assertNoLeak('SSE restricted single-record stream', rs.msgs);
			assertNoLeak('SSE restricted collection stream', rc.msgs);
		});

		// ---------------------------------------------------------------- WebSocket
		test('WebSocket: collection + single-record (restricted vs open) honour attribute restriction', async () => {
			const s = 'ws';
			const rc = await openWs(wsBase, '/Ticket/', basic(RESTRICTED), 'restricted-collection');
			const rs = await openWs(wsBase, `/Ticket/${s}-1`, basic(RESTRICTED), 'restricted-single');
			const oc = await openWs(wsBase, '/Ticket/', basic(OPEN), 'open-collection');
			const os = await openWs(wsBase, `/Ticket/${s}-1`, basic(OPEN), 'open-single');
			for (const x of [rc, rs, oc, os]) subs.add(x);
			for (const x of [rc, rs, oc, os]) strictEqual(x.status(), 101, `${x.label} upgrade status`);
			await sleep(1000);
			await drive(s);
			await waitFor(() => oc.msgs.some((m) => m.text.includes(`SECRET-${s}-put2`)), 8000);
			await sleep(1500);

			for (const x of [rc, rs, oc, os]) obs(`ws ${x.label}`, `status=${x.status()}`, x.msgs);

			ok(
				os.msgs.some((m) => m.text.includes(`SECRET-${s}-put`)),
				'POSITIVE CONTROL: open single ws lacks secret on put'
			);
			ok(
				oc.msgs.some((m) => m.text.includes(`SECRET-${s}-patch`)),
				'POSITIVE CONTROL: open collection ws lacks secret on patch'
			);
			ok(
				rs.msgs.some((m) => m.text.includes('title-v2')),
				'restricted single ws did not deliver the put (inconclusive)'
			);
			ok(
				rc.msgs.some((m) => m.text.includes('title-n1')),
				'restricted collection ws did not deliver the new row (inconclusive)'
			);

			assertNoLeak('WebSocket restricted single-record', rs.msgs);
			assertNoLeak('WebSocket restricted collection', rc.msgs);
		});

		// ---------------------------------------------------------------- MQTT
		test('MQTT: Ticket/# and Ticket/<id> at QoS 0 and 1 (restricted vs open) honour attribute restriction', async () => {
			const s = 'mqtt';
			const plan: Array<{ label: string; user: typeof RESTRICTED; topic: string; qos: 0 | 1 }> = [];
			for (const [who, user] of [
				['restricted', RESTRICTED],
				['open', OPEN],
			] as const) {
				for (const qos of [0, 1] as const) {
					plan.push({ label: `${who}-q${qos}-wild`, user, topic: 'Ticket/#', qos });
					plan.push({ label: `${who}-q${qos}-single`, user, topic: `Ticket/${s}-1`, qos });
				}
			}
			const got = new Map<string, Msg[]>();
			for (const p of plan) {
				const c = await mqttConnect(mqttURL, p.user, `sqa35-${p.label}`);
				mqttClients.add(c);
				got.set(p.label, collectMqtt(c));
				const r = await mqttSubscribe(c, p.topic, p.qos);
				console.log(`OBS [mqtt] ${p.label} SUBACK ${JSON.stringify(r)}`);
				ok(
					Array.isArray(r.codes) && (r.codes as number[]).every((x) => x < 0x80),
					`${p.label} subscribe rejected: ${JSON.stringify(r)}`
				);
			}
			await sleep(1000);
			await drive(s);
			const openWild = got.get('open-q1-wild')!;
			await waitFor(() => openWild.some((m) => m.text.includes(`SECRET-${s}-put2`)), 8000);
			await sleep(1500);

			for (const [label, msgs] of got) obs(`mqtt ${label}`, 'received', msgs);

			for (const q of [0, 1]) {
				const os = got.get(`open-q${q}-single`)!;
				ok(
					os.some((m) => m.text.includes(`SECRET-${s}-initial`)),
					`POSITIVE CONTROL: open q${q} single retained delivery lacks secret`
				);
				ok(
					os.some((m) => m.text.includes(`SECRET-${s}-put`)),
					`POSITIVE CONTROL: open q${q} single live put lacks secret`
				);
				ok(
					got.get(`open-q${q}-wild`)!.some((m) => m.text.includes(`SECRET-${s}-patch`)),
					`POSITIVE CONTROL: open q${q} wildcard patch lacks secret`
				);
				ok(
					got.get(`restricted-q${q}-single`)!.some((m) => m.text.includes('title-v2')),
					`restricted q${q} single did not deliver the put (inconclusive)`
				);
				ok(
					got.get(`restricted-q${q}-wild`)!.some((m) => m.text.includes('title-n1')),
					`restricted q${q} wildcard did not deliver new row (inconclusive)`
				);
			}
			const leaks: string[] = [];
			for (const [label, msgs] of got) {
				if (!label.startsWith('restricted')) continue;
				const bad = msgs.filter(leaked);
				if (bad.length) leaks.push(`${label}: ${bad.length}/${msgs.length}\n  ${dump(bad)}`);
			}
			ok(leaks.length === 0, `ATTRIBUTE LEAK on MQTT:\n${leaks.join('\n')}`);
		});

		// ---------------------------------------------------------------- caller select
		test('CALLER SELECT: restricted SSE /Ticket/?select(title) and select(title,secret) never widen past the permission select', async () => {
			const s = 'sel';
			const rSel = openSse(restURL, '/Ticket/?select(title)', basic(RESTRICTED), 'restricted-select(title)');
			const oSel = openSse(restURL, '/Ticket/?select(title)', basic(OPEN), 'open-select(title)');
			const rWide = openSse(
				restURL,
				'/Ticket/?select(title,secret)',
				basic(RESTRICTED),
				'restricted-select(title,secret)'
			);
			for (const x of [rSel, oSel, rWide]) subs.add(x);
			await sleep(1000);
			await drive(s);
			await waitFor(() => oSel.msgs.length >= 4, 8000);
			await sleep(1500);
			for (const x of [rSel, oSel, rWide]) obs(`select ${x.label}`, `status=${x.status()}`, x.msgs);
			for (const x of [rSel, oSel, rWide]) strictEqual(x.status(), 200, `${x.label} status`);

			// Observation only: a caller's own select is NOT applied to deliveries for a role without attribute
			// permissions (PR #3307 declares this out of scope: "Honoring caller selects is new API"); the open
			// user may read `secret`, so this is not a leak. The restricted arms below carry the assertions.
			ok(oSel.msgs.length > 0, 'open select stream delivered nothing (inconclusive)');
			console.log(
				`OBS [select] caller select(title) applied for the OPEN role: ${oSel.msgs.filter(leaked).length === 0} (documented non-goal of PR #3307)`
			);
			assertNoLeak('SSE restricted select(title)', rSel.msgs);
			assertNoLeak('SSE restricted select(title,secret)', rWide.msgs);
		});
	}
);
