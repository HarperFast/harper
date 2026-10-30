/**
 * Promoted from qa-explorer (QA-759 / P-527): what a live MQTT subscriber on a CACHE-SOURCED
 * (`sourcedFrom`) table receives when the cached record's TTL expires and a later read lazily
 * revalidates it against a CHANGED upstream value.
 *
 * Each side of this intersection was covered and the two never crossed: the MQTT suites never touch
 * `sourcedFrom` or `expiration`, and the `resources/sourcedfrom-*` suites never subscribe.
 *
 * MECHANISM. A read of an expired cache entry goes through `getFromSource()` in
 * `resources/Table.ts`, which calls the source resolver and writes the resolved record back through
 * `updateRecord()`. `resources/transactionBroadcast.ts` notifies subscribers by scanning the audit
 * entries those commits produce, so a cache revalidation reaches every `Table.subscribe()` consumer
 * — MQTT included — the same way an ordinary write does. The dispatcher re-reads the CURRENT entry
 * instead of forwarding the event's own payload (`if (entry.version !== auditRecord.version)
 * return`), which is why the delivered payload is the post-revalidation record.
 *
 * WHAT GATES THE PUBLISH, and so what this suite does and does not guard. The write-back is audited
 * only when `getFromSource()`'s `hasChanges` holds, and that is a VERSION test, not a value
 * comparison: `invalidated || (validReportedVersion && reportedVersion > existingVersion) ||
 * !existingRecord`. `reportedVersion` is `sourceContext.lastModified`, which the resolver here raises
 * simply by reading the upstream row — every table read with a context lifts that context's
 * `lastModified` to the row's version, and inside a source resolver the ambient context IS the
 * source context. So Q1 guards the contract for a source that reports a newer version. A source that
 * reports none (a plain `fetch()` resolver, say) takes the other branch: measured on this fixture
 * with the upstream moved out of Harper into a module variable, the revalidating read returned the
 * changed value and NO publish reached the subscriber at all. Whether that silence is correct is the
 * same open question the excluded arm below leaves open, so this file pins neither.
 *
 * ARMS:
 *   Q0 (control): a direct PUT to the cache table publishes to a live subscriber. Without it a
 *      silent Q1 could be a dead subscription rather than a missing publish.
 *   Q1: prime a key through the resolver, let the TTL expire with the row still resident, change the
 *      upstream value, then issue exactly ONE revalidating GET — a publish carrying the FRESH
 *      payload reaches the live subscriber.
 *
 * What keeps Q1 honest is that the resolution reports the branch it took. The fixture resolver
 * records `SourceContext.replacingRecord`, which Harper populates only when the read revalidated a
 * resident entry, so a run that instead refilled an absent row — the eviction scan having removed it,
 * which publishes for a different reason — fails the arm rather than passing it. That evidence comes
 * from inside the resolution the arm triggered, which a residency read taken beforehand cannot do.
 *
 * Q1 matches the publish by PAYLOAD, not by arrival order, because a subscriber on this topic also
 * sees the priming commit's own dispatch: that write commits after the priming GET has already
 * returned, so it races the subscribe and can be delivered — carrying the PRE-revalidation value —
 * immediately before the fresh one. (Only in that order: a priming dispatch still unprocessed when
 * the revalidation commits is dropped instead, since the dispatcher's re-read finds a version that no
 * longer matches its audit entry.) Asserting on the first post-trigger message would therefore fail
 * on ordering that says nothing about the behavior under test.
 *
 * The identical-value revalidation arm (an upstream returning a byte-identical payload) is
 * deliberately out of scope pending resolution of whether it should publish at all.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/qa759-cache-revalidation-publish.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa759-cache-revalidation-publish');

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the sibling MQTT
// suites carry.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const PUBLISH_WAIT_MS = 5000;

interface CollectedMessage {
	topic: string;
	payload: string;
	retain: boolean;
	at: number;
}

function subscribeClient(client: MqttClient, topic: string, qos: 0 | 1 | 2 = 1, timeoutMs = 10_000): Promise<any[]> {
	return new Promise((res, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`SUBACK for ${topic} did not arrive within ${timeoutMs}ms`)),
			timeoutMs
		);
		client.subscribe(topic, { qos }, (err, granted) => {
			clearTimeout(timer);
			if (err) reject(err);
			else res(granted ?? []);
		});
	});
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((res) => {
		if (!client) return res();
		client.end(true, {}, () => res());
	});
}

function collectMessages(client: MqttClient) {
	const msgs: CollectedMessage[] = [];
	const handler = (topic: string, payload: Buffer, packet: any) => {
		msgs.push({ topic, payload: payload.toString(), retain: Boolean(packet?.retain), at: Date.now() });
	};
	client.on('message', handler);
	return { msgs, stop: () => client.removeListener('message', handler) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

function parsePayload(payload: string): { value?: string; nonce?: number } | undefined {
	try {
		return JSON.parse(payload);
	} catch {
		return undefined;
	}
}

suite('QA-759 MQTT publishes on a cache-sourced (sourcedFrom) table', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let apiClient: ReturnType<typeof createApiClient>;
	let restURL: string;
	let headers: Record<string, string>;
	let mqttURL = '';
	let mqttUsable = false;
	let mqttSkipReason = '';

	function baseOpts(overrides: Partial<IClientOptions> = {}): IClientOptions {
		return {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			username: ctx.harper.admin.username,
			password: ctx.harper.admin.password,
			...overrides,
		};
	}

	function connectClient(url: string, opts: IClientOptions): Promise<MqttClient> {
		return new Promise((res, reject) => {
			const client = mqtt.connect(url, opts);
			const onError = (err: Error) => {
				client.removeListener('connect', onConnect);
				client.end(true);
				reject(err);
			};
			const onConnect = () => {
				client.removeListener('error', onError);
				// An unhandled 'error' on an EventEmitter throws, but a late one must not fail the run:
				// end(true) in the finally blocks below races in-flight traffic.
				client.on('error', (err: Error) =>
					console.log(`[QA-759] post-connect mqtt error on ${opts.clientId}: ${err?.message ?? err}`)
				);
				res(client);
			};
			client.once('error', onError);
			client.once('connect', onConnect);
		});
	}

	/** An unreachable broker fails the arm rather than skipping it: an arm that reports green
	 *  without having run its probes proves nothing. */
	function requireMqtt() {
		ok(mqttUsable, `MQTT is unusable, so this arm proved nothing: ${mqttSkipReason}`);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		apiClient = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		headers = { 'Content-Type': 'application/json', 'Authorization': apiClient.headers.Authorization };

		const wsScheme = restURL.startsWith('https') ? 'wss' : 'ws';
		mqttURL = `${restURL.replace(/^https?/, wsScheme)}/mqtt`;

		await waitForRouteReady(apiClient, '/Item/', 120_000);

		try {
			const probe = await connectClient(mqttURL, baseOpts({ clientId: 'qa759-probe' }));
			mqttUsable = probe.connected === true;
			if (!mqttUsable) mqttSkipReason = `MQTT client connected=false on ${mqttURL}`;
			await endQuiet(probe);
		} catch (err) {
			mqttUsable = false;
			mqttSkipReason = `MQTT connect probe failed on ${mqttURL}: ${(err as Error)?.message}`;
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function putJSON(path: string, body: unknown): Promise<{ status: number; text: string }> {
		const res = await fetch(`${restURL}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
		const text = await res.text().catch(() => '');
		return { status: res.status, text };
	}

	async function getJSON(path: string): Promise<{ status: number; body: any }> {
		const res = await fetch(`${restURL}${path}`, { headers });
		const text = await res.text();
		let body: any;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		return { status: res.status, body };
	}

	async function putOK(path: string, body: unknown): Promise<void> {
		const res = await putJSON(path, body);
		ok([200, 201, 204].includes(res.status), `PUT ${path} should succeed, got ${res.status}: ${res.text}`);
	}

	/** The priming write-back commits after the priming GET has already returned, so the moment the
	 *  row becomes resident-and-expired is an observable condition, not an elapsed TTL to sleep off. */
	async function pollExpiredResident(id: string, timeoutMs = 10_000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		let body: any;
		while (Date.now() < deadline) {
			body = (await getJSON(`/ItemRaw/?id=${encodeURIComponent(id)}`)).body;
			if (body?.exists === true && typeof body.expiresAt === 'number' && body.expiresAt < Date.now()) return body;
			await sleep(50);
		}
		return body;
	}

	async function pollCounterAtLeast(id: string, atLeast: number, timeoutMs = 6000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		let last: any;
		while (Date.now() < deadline) {
			const r = await getJSON(`/Counter/${encodeURIComponent(id)}`);
			last = r.status === 200 ? r.body : undefined;
			if (typeof last?.count === 'number' && last.count >= atLeast) return last;
			await sleep(100);
		}
		return last;
	}

	test('Q0 control: a DIRECT write to the table publishes to a live subscriber', { timeout: 30_000 }, async () => {
		requireMqtt();
		const id = 'direct-ctrl';
		const topic = `Item/${id}`;
		const isCtrl = (m: CollectedMessage) => {
			const parsed = parsePayload(m.payload);
			return parsed?.value === 'ctrl-v1' && parsed?.nonce === 1;
		};
		const sub = await connectClient(mqttURL, baseOpts({ clientId: 'qa759-q0-sub' }));
		try {
			const obs = collectMessages(sub);
			await subscribeClient(sub, topic);
			await sleep(200);

			const triggerAt = Date.now();
			await putOK(`/Item/${id}`, { id, value: 'ctrl-v1', nonce: 1 });

			const arrived = await waitFor(
				() => obs.msgs.some((m) => m.at >= triggerAt && m.topic === topic && isCtrl(m)),
				PUBLISH_WAIT_MS
			);
			obs.stop();

			ok(
				arrived,
				`instrumentation not armed: no MQTT publish carrying {value:'ctrl-v1',nonce:1} observed on ${topic} ` +
					`within ${PUBLISH_WAIT_MS}ms of a direct write — the Q1 reading below cannot be trusted. ` +
					`Messages after the trigger: ${JSON.stringify(obs.msgs.filter((m) => m.at >= triggerAt))}`
			);
		} finally {
			await endQuiet(sub);
		}
	});

	test(
		'Q1 changed-value TTL revalidation: the subscriber receives the FRESH payload',
		// The failure path stacks four poll ceilings, which does not fit the sibling suites' 30s.
		{ timeout: 60_000 },
		async () => {
			requireMqtt();
			const id = 'changed-1';
			const topic = `Item/${id}`;
			const isFresh = (m: CollectedMessage) => {
				const parsed = parsePayload(m.payload);
				return parsed?.value === 'B' && parsed?.nonce === 2;
			};

			await putOK(`/Source/${id}`, { id, value: 'A', nonce: 1 });
			const primeRes = await getJSON(`/Item/${id}`);
			strictEqual(primeRes.status, 200, `prime GET /Item/${id} should succeed, got ${primeRes.status}`);
			strictEqual(primeRes.body?.value, 'A', `primed Item/${id} should reflect Source round 1`);
			const counterAfterPrime = await pollCounterAtLeast(id, 1);
			ok(
				counterAfterPrime?.count >= 1,
				`resolver should have run at least once priming ${id}, Counter=${JSON.stringify(counterAfterPrime)}`
			);

			const sub = await connectClient(mqttURL, baseOpts({ clientId: 'qa759-q1-sub' }));
			try {
				const obs = collectMessages(sub);
				await subscribeClient(sub, topic);
				await sleep(200);

				const rawBefore = await pollExpiredResident(id);
				ok(
					rawBefore?.exists === true &&
						rawBefore?.value?.value === 'A' &&
						typeof rawBefore?.expiresAt === 'number' &&
						rawBefore.expiresAt < Date.now(),
					`the primed row should be resident and already expired before the revalidating read, got ` +
						`${JSON.stringify(rawBefore)} at ${Date.now()}`
				);

				await putOK(`/Source/${id}`, { id, value: 'B', nonce: 2 });
				const triggerAt = Date.now();
				const revalRes = await getJSON(`/Item/${id}`);

				// Waits on the fresh payload itself, not the next message to arrive (see the header).
				const freshArrived = await waitFor(
					() => obs.msgs.some((m) => m.at >= triggerAt && m.topic === topic && isFresh(m)),
					PUBLISH_WAIT_MS
				);
				await sleep(300);
				obs.stop();

				const postTrigger = obs.msgs.filter((m) => m.at >= triggerAt && m.topic === topic);

				// Both reads below are deliberately free of source resolution: Counter is a plain table,
				// and /ItemRaw/ reads the stored row without resolving it. A plain GET /Item here would
				// re-enter the resolver once B's own 1.2s TTL lapsed — which a slow publish makes likely —
				// and that run would overwrite the branch evidence this arm is about to assert.
				const counterAfterReval = await pollCounterAtLeast(id, 2);
				const rawAfter = (await getJSON(`/ItemRaw/?id=${encodeURIComponent(id)}`)).body;

				ok(
					freshArrived,
					`expected a publish on ${topic} carrying the FRESH (post-revalidation) payload ` +
						`{value:'B',nonce:2} within ${PUBLISH_WAIT_MS}ms of the revalidating read; ` +
						`${postTrigger.length} post-trigger message(s) arrived: ${JSON.stringify(postTrigger)} ` +
						`(revalidating GET returned ${JSON.stringify(revalRes.body)}, stored row now ${JSON.stringify(rawAfter)})`
				);

				strictEqual(revalRes.status, 200, `revalidating GET /Item/${id} should succeed, got ${revalRes.status}`);
				strictEqual(revalRes.body?.value, 'B', `revalidating read should return the FRESH value from Source`);
				strictEqual(rawAfter?.value?.value, 'B', `the cache row should hold the fresh value after the revalidation`);
				ok(
					counterAfterReval?.count >= 2,
					`resolver should have re-run on revalidation, Counter=${JSON.stringify(counterAfterReval)}`
				);
				strictEqual(
					counterAfterReval?.replacedValue,
					'A',
					`the revalidating read should have replaced the resident record, not refilled an absent one ` +
						`(Counter=${JSON.stringify(counterAfterReval)})`
				);
			} finally {
				await endQuiet(sub);
			}
		}
	);
});
