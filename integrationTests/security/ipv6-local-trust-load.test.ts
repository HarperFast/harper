/**
 * Under concurrent, multi-thread, mixed-peer load every response reports its OWN peer address and gets local
 * trust exactly for `::1` and `127.0.0.x` (`isLocalPeerAddress`; `security/DESIGN.md`, "A request trusted by its
 * transport"), on Node's HTTP server and on uWS (CI runs this file both ways).
 *
 * uWS reads the peer address through a per-thread cache (`server/serverHelpers/uwsServer.ts` `readPeerAddress`:
 * the formatted text is reused while consecutive requests on a thread come from the same peer), and #3855 made
 * that text Node-shaped (`::1`, `::ffff:127.0.0.1`) so `isLocalPeerAddress` trusts IPv6 loopback and
 * IPv4-mapped loopback alike. `ipv6-local-trust.test.ts` alternates three peers on one thread, which catches a
 * cache that never refreshes. This file interleaves seven peers on four threads, several differing only in
 * their low bytes (`127.0.0.1`, `127.0.0.2`, `127.0.1.1`, `127.0.2.2`), under keep-alive, `Connection: close`
 * and WebSocket volume, so a cache compare that ignores part of the address hands one peer's address and trust
 * to another. The Node arm cannot see the cache (Node's `remoteAddress` is per socket); it pins the trust rule
 * itself.
 *
 * Sources: `::1`, `127.0.0.1`, `127.0.0.2` (trusted); `127.0.1.1`, `127.0.2.2` (127/8 outside `127.0.0.x`,
 * untrusted) and this host's first bindable non-link-local and link-local IPv6 addresses (untrusted; a
 * link-local zone is stripped before the comparison, so the zone itself is not pinned). Each source runs eight
 * concurrent loops for PEER_ADDRESS_LOAD_SECONDS (default 4), then until every kind has reached its floor,
 * under a hard deadline.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/ipv6-local-trust-load.test.ts"
 *   HARPER_UWS_HTTP=1 npm run test:integration -- "integrationTests/security/ipv6-local-trust-load.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { Agent, request } from 'node:http';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ipv6-local-trust');
const THREADS = 4;
const SECONDS = (() => {
	const raw = process.env.PEER_ADDRESS_LOAD_SECONDS;
	if (raw === undefined) return 4;
	if (!/^\d+$/.test(raw) || +raw <= 0)
		throw new Error(`PEER_ADDRESS_LOAD_SECONDS must be a positive integer, got ${raw}`);
	return +raw;
})();
const ARM = process.env.HARPER_UWS_HTTP ? 'uws' : 'node';
const LOOPS_PER_SOURCE = 8;
const KEEPALIVE_BURST = 5;
// every source must get at least this many responses of every kind, or the run did not exercise it concurrently
const FLOOR_PER_SOURCE_KIND = 100;
const FLOOR_GRACE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

type Kind = 'keepalive' | 'close' | 'ws';
const KINDS: Kind[] = ['keepalive', 'close', 'ws'];

interface Source {
	name: string;
	bind: string; // the client's local address (with zone for link-local)
	host: string; // the address to connect to (with zone for link-local)
	expectedIp: string; // the `ip` Harper must report: Node's remoteAddress form, zone stripped
	trusted: boolean;
	linkLocal?: boolean;
	/** must be able to bind on this platform, so a source silently not running cannot pass the suite */
	required: boolean;
}

const isLinux = process.platform === 'linux';
const loopback = (name: string, expectedIp: string, trusted: boolean, required: boolean): Source => ({
	name,
	bind: name,
	host: name.includes(':') ? name : '127.0.0.1',
	expectedIp,
	trusted,
	required,
});

function hostIPv6Candidates(): { global: Source[]; linkLocal: Source[] } {
	const candidates = { global: [] as Source[], linkLocal: [] as Source[] };
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const entry of addresses ?? []) {
			if (entry.family !== 'IPv6' || entry.internal) continue;
			if (entry.address.startsWith('fe80:')) {
				// Windows takes a numeric zone; elsewhere it is the interface name
				const zoned = `${entry.address}%${process.platform === 'win32' ? entry.scopeid : name}`;
				candidates.linkLocal.push({
					name: zoned,
					bind: zoned,
					host: zoned,
					expectedIp: entry.address,
					trusted: false,
					linkLocal: true,
					required: false,
				});
			} else {
				const address = entry.address;
				candidates.global.push({
					name: address,
					bind: address,
					host: address,
					expectedIp: address,
					trusted: false,
					required: false,
				});
			}
		}
	}
	return candidates;
}

async function bindablePort(host: string): Promise<number | undefined> {
	const server = createServer();
	try {
		return await new Promise<number>((resolvePort, reject) => {
			server.once('error', reject);
			server.listen(0, host, () => resolvePort((server.address() as { port: number }).port));
		});
	} catch (error: any) {
		if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' || error.code === 'EINVAL') return undefined;
		throw error;
	} finally {
		server.close();
	}
}

const HAS_IPV6 = (await bindablePort('::')) !== undefined;
const HAS_IPV6_LOOPBACK = (await bindablePort('::1')) !== undefined;
const firstBindable = async (list: Source[]) => {
	for (const s of list) if ((await bindablePort(s.bind)) !== undefined) return s;
};
const hostIPv6 = hostIPv6Candidates();
const HOST_IPV6 = [await firstBindable(hostIPv6.global), await firstBindable(hostIPv6.linkLocal)].filter(
	(s): s is Source => s !== undefined
);
const SOURCES: Source[] = [
	loopback('::1', '::1', true, HAS_IPV6_LOOPBACK),
	loopback('127.0.0.1', '::ffff:127.0.0.1', true, true),
	loopback('127.0.0.2', '::ffff:127.0.0.2', true, true),
	// 127/8 outside 127.0.0.x: loopback to the OS (every Linux host binds it; other platforms alias only what they were
	// told to) and untrusted to Harper
	loopback('127.0.1.1', '::ffff:127.0.1.1', false, isLinux),
	loopback('127.0.2.2', '::ffff:127.0.2.2', false, isLinux),
	...HOST_IPV6,
];
const bindable = new Set<string>();
for (const s of SOURCES) if ((await bindablePort(s.bind)) !== undefined) bindable.add(s.name);
const ACTIVE = SOURCES.filter((s) => bindable.has(s.name));
const suiteSkip =
	process.env.HARPER_RUNTIME === 'bun'
		? 'Bun reports peer addresses itself'
		: !HAS_IPV6
			? 'a bare http.port binds ::, which this host cannot'
			: !ACTIVE.some((s) => !s.trusted) && 'no untrusted source address can bind on this host';

const stripZone = (ip: string | null) => (ip === null ? null : ip.split('%')[0]);

interface Peer {
	username: string | null;
	localMarker: boolean;
	ip: string | null;
}
interface Reply extends Peer {
	headers?: Record<string, string | string[] | undefined>;
}
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

function httpWhoAmI(port: number, s: Source, agent: Agent | false): Promise<Reply> {
	return new Promise((resolveReply, reject) => {
		const req = request(
			{
				host: s.host,
				port,
				localAddress: s.bind,
				path: '/WhoAmI/',
				headers: agent === false ? { Accept: 'application/json', Connection: 'close' } : { Accept: 'application/json' },
				agent,
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('error', reject);
				res.on('end', () => {
					if (res.statusCode !== 200) return reject(coded(`status ${res.statusCode}`, `HTTP_${res.statusCode}`));
					try {
						resolveReply({ ...JSON.parse(text), headers: res.headers });
					} catch {
						reject(coded(`bad body ${text.slice(0, 80)}`, 'BAD_BODY'));
					}
				});
			}
		);
		req.on('error', reject);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(coded('timeout', 'TIMEOUT')));
		req.end();
	});
}

function wsWhoAmI(port: number, s: Source): Promise<Reply> {
	return new Promise((resolveReply, reject) => {
		// a link-local zone cannot ride in a URL, so that source connects explicitly (as ipv6-local-trust.test.ts does)
		const url = s.linkLocal
			? `ws://localhost:${port}/WhoAmI/`
			: `ws://${s.host.includes(':') ? `[${s.host}]` : s.host}:${port}/WhoAmI/`;
		const options: WebSocket.ClientOptions = { headers: { Accept: 'application/json' } };
		if (s.linkLocal) options.createConnection = () => connect({ host: s.host, port, localAddress: s.bind });
		else options.localAddress = s.bind;
		const socket = new WebSocket(url, options);
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.terminate();
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(coded('ws timeout', 'TIMEOUT'))), REQUEST_TIMEOUT_MS);
		socket.once('message', (data) => {
			let parsed: Peer;
			try {
				parsed = JSON.parse(data.toString());
			} catch {
				return finish(() => reject(coded('bad ws body', 'BAD_BODY')));
			}
			finish(() => resolveReply(parsed));
		});
		socket.once('close', (code) => finish(() => reject(coded(`ws closed ${code}`, `WS_CLOSE_${code}`))));
		socket.once('error', (error) => finish(() => reject(error)));
	});
}

suite(
	`peer address and local trust under concurrent mixed-peer load [${ARM}]`,
	{ skip: suiteSkip },
	(ctx: ContextWithHarper) => {
		let port: number;

		before(async () => {
			port = (await bindablePort('::'))!;
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: THREADS }, authentication: { authorizeLocal: true }, http: { port } },
			});
			const deadline = Date.now() + 90_000;
			for (;;) {
				try {
					await httpWhoAmI(port, SOURCES[1], false);
					return;
				} catch (error) {
					ok(Date.now() < deadline, `the HTTP listener never answered on port ${port}: ${error}`);
					await sleep(250);
				}
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('every response carries its own peer address and trust', async () => {
			const notRun = SOURCES.filter((s) => !bindable.has(s.name)).map((s) => s.name);
			for (const s of SOURCES)
				if (s.required) ok(bindable.has(s.name), `${s.name} could not bind, so the run would not exercise it`);
			ok(
				ACTIVE.some((s) => s.trusted) && ACTIVE.some((s) => !s.trusted),
				`need a trusted and an untrusted source; not run: ${notRun}`
			);
			strictEqual(
				(
					await (
						await fetch(`${ctx.harper.operationsAPIURL}`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
							},
							body: JSON.stringify({ operation: 'get_configuration' }),
						})
					).json()
				).threads.count,
				THREADS
			);

			// uWebSockets.js stamps its own `uWebSockets` response header; Node's http server never does
			const probe = await httpWhoAmI(port, SOURCES[1], false);
			const uwsHeader = probe.headers?.['uwebsockets'];
			if (ARM === 'uws')
				ok(
					uwsHeader !== undefined,
					'HARPER_UWS_HTTP=1 but the response has no uWebSockets header: the arm ran on Node'
				);
			else strictEqual(uwsHeader, undefined, 'the Node arm answered with a uWebSockets header');

			// keys: tally `source|kind|ip|localMarker|username`, live `source|kind`, errors source -> `kind:code`
			const tally = new Map<string, number>();
			const errors = new Map<string, Map<string, number>>();
			const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
			const live = new Map<string, number>();
			const record = (s: Source, kind: Kind, r: Peer) => {
				bump(tally, `${s.name}|${kind}|${r.ip}|${r.localMarker}|${r.username}`);
				bump(live, `${s.name}|${kind}`);
			};
			const belowFloor = (s: Source) =>
				KINDS.filter((kind) => (live.get(`${s.name}|${kind}`) ?? 0) < FLOOR_PER_SOURCE_KIND);
			const recordError = (s: Source, kind: Kind, e: any) => {
				if (!errors.has(s.name)) errors.set(s.name, new Map());
				bump(errors.get(s.name)!, `${kind}:${e?.code ?? e?.message}`);
			};

			const started = Date.now();
			const end = started + SECONDS * 1000;
			const hardEnd = end + FLOOR_GRACE_MS;
			const loop = async (s: Source) => {
				const agent = new Agent({ keepAlive: true, localAddress: s.bind, maxSockets: 1 });
				try {
					for (;;) {
						const now = Date.now();
						let kind: Kind;
						if (now < end) kind = KINDS[Math.floor(Math.random() * KINDS.length)];
						else {
							const missing = belowFloor(s);
							if (missing.length === 0 || now >= hardEnd) break;
							kind = missing[Math.floor(Math.random() * missing.length)];
						}
						try {
							if (kind === 'keepalive') {
								for (let i = 0; i < KEEPALIVE_BURST; i++) record(s, kind, await httpWhoAmI(port, s, agent));
							} else if (kind === 'close') record(s, kind, await httpWhoAmI(port, s, false));
							else record(s, kind, await wsWhoAmI(port, s));
						} catch (e) {
							recordError(s, kind, e);
						}
					}
				} finally {
					agent.destroy();
				}
			};
			await Promise.all(ACTIVE.flatMap((s) => Array.from({ length: LOOPS_PER_SOURCE }, () => loop(s))));
			const elapsedMs = Date.now() - started;

			const counts: Record<string, Record<string, number>> = {};
			const observed: Record<string, Record<string, number>> = {};
			const mismatches: Record<string, number> = {};
			for (const [key, n] of tally) {
				const [name, kind, ip, marker, username] = key.split('|'); // an ip may contain ':' but never '|'
				const s = ACTIVE.find((x) => x.name === name)!;
				counts[name] ??= {};
				counts[name][kind] = (counts[name][kind] ?? 0) + n;
				observed[name] ??= {};
				observed[name][`${ip}|${marker}|${username}`] = (observed[name][`${ip}|${marker}|${username}`] ?? 0) + n;
				const ipOk = stripZone(ip === 'null' ? null : ip) === s.expectedIp;
				const trustOk = marker === String(s.trusted) && username === (s.trusted ? 'local' : 'null');
				if (!ipOk || !trustOk)
					mismatches[`${name} -> ip=${ip} localMarker=${marker} username=${username} [${kind}]`] = n;
			}
			const total = [...tally.values()].reduce((a, b) => a + b, 0);
			const transportErrors = Object.fromEntries([...errors].map(([name, m]) => [name, Object.fromEntries(m)]));
			console.log(
				`PEER_ADDRESS_LOAD ${JSON.stringify({ arm: ARM, seconds: SECONDS, elapsedMs, total, uwebsocketsHeader: uwsHeader ?? null, notRun, counts, observed, mismatches, transportErrors })}`
			);

			strictEqual(
				Object.keys(mismatches).length,
				0,
				`responses carrying another peer's address or trust: ${JSON.stringify(mismatches)}`
			);
			const errorCount = [...errors.values()].reduce((n, m) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
			ok(
				errorCount <= total / 100,
				`${errorCount} transport errors against ${total} responses: ${JSON.stringify(transportErrors)}`
			);
			for (const s of ACTIVE)
				for (const kind of KINDS)
					ok(
						(counts[s.name]?.[kind] ?? 0) >= FLOOR_PER_SOURCE_KIND,
						`${s.name} ${kind}: only ${counts[s.name]?.[kind] ?? 0} responses (< ${FLOOR_PER_SOURCE_KIND}) within ${SECONDS} s + ${FLOOR_GRACE_MS} ms; errors ${JSON.stringify(transportErrors[s.name])}`
					);
		});
	}
);
