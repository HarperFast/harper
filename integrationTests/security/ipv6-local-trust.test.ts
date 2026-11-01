/**
 * `request.ip` and local trust are the same on Node's HTTP server and on uWS (CI also runs this file with
 * HARPER_UWS_HTTP=1) for a bare `http.port`, which both bind dual-stack.
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ipv6-local-trust');

interface Peer {
	username: string | null;
	localMarker: boolean;
	ip: string | null;
}

async function bindablePort(host: string): Promise<number | undefined> {
	const server = createServer();
	try {
		return await new Promise<number>((resolvePort, reject) => {
			server.once('error', reject);
			server.listen(0, host, () => resolvePort((server.address() as { port: number }).port));
		});
	} catch (error: any) {
		if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') return undefined;
		throw error;
	} finally {
		server.close();
	}
}

function nonLoopbackIPv6(): { address: string; linkLocal: boolean } | undefined {
	let linkLocal: string | undefined;
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const entry of addresses ?? []) {
			if (entry.family !== 'IPv6' || entry.internal) continue;
			if (!entry.address.startsWith('fe80:')) return { address: entry.address, linkLocal: false };
			linkLocal ??= `${entry.address}%${name}`;
		}
	}
	return linkLocal ? { address: linkLocal, linkLocal: true } : undefined;
}

const HAS_IPV6 = (await bindablePort('::')) !== undefined;
const HAS_IPV6_LOOPBACK = (await bindablePort('::1')) !== undefined;
const REMOTE_IPV6 = nonLoopbackIPv6();
const suiteSkip =
	process.env.HARPER_RUNTIME === 'bun'
		? 'Bun reports peer addresses itself'
		: !HAS_IPV6 && 'a bare http.port binds ::, which this host cannot';

function whoAmI(port: number, host: string, localAddress: string): Promise<Peer> {
	return new Promise((resolvePeer, reject) => {
		const req = request(
			{
				host,
				port,
				localAddress,
				path: '/WhoAmI/',
				headers: { Accept: 'application/json', Connection: 'close' },
				agent: false,
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('error', reject);
				res.on('end', () => {
					if (res.statusCode !== 200)
						return reject(new Error(`GET /WhoAmI/ from ${localAddress}: ${res.statusCode} ${text}`));
					resolvePeer(JSON.parse(text));
				});
			}
		);
		req.on('error', reject);
		req.setTimeout(15_000, () => req.destroy(new Error(`no response from ${host}`)));
		req.end();
	});
}

function whoAmIOverWebSocket(port: number, host: string, localAddress: string): Promise<Peer> {
	return new Promise((resolvePeer, reject) => {
		// connected here rather than from the URL, which cannot carry a link-local zone
		const socket = new WebSocket(`ws://localhost:${port}/WhoAmI/`, {
			headers: { Accept: 'application/json' },
			createConnection: () => connect({ host, port, localAddress }),
		});
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`no WebSocket message from ${host}`));
		}, 15_000);
		socket.once('message', (data) => {
			clearTimeout(timer);
			socket.terminate();
			resolvePeer(JSON.parse(data.toString()));
		});
		socket.once('close', (code, reason) => {
			clearTimeout(timer);
			reject(new Error(`WebSocket closed before a message: ${code} ${reason}`));
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			socket.terminate();
			reject(error);
		});
	});
}

const LOCAL = { username: 'local', localMarker: true };
const ANONYMOUS = { username: null, localMarker: false };

suite('local trust and request.ip for IPv6 and dual-stack peers', { skip: suiteSkip }, (ctx: ContextWithHarper) => {
	let port: number;

	before(async () => {
		port = (await bindablePort('::'))!;
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { authentication: { authorizeLocal: true }, http: { port } },
		});
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				await whoAmI(port, ctx.harper.hostname, ctx.harper.hostname);
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

	test('an IPv4 client is the local principal at its IPv4-mapped address', async () => {
		const host = ctx.harper.hostname;
		const expected = { ...LOCAL, ip: `::ffff:${host}` };
		deepStrictEqual(await whoAmI(port, host, host), expected);
		deepStrictEqual(await whoAmIOverWebSocket(port, host, host), expected);
	});

	test('a ::1 client is the local principal at ::1', { skip: !HAS_IPV6_LOOPBACK && 'no IPv6 loopback' }, async () => {
		const expected = { ...LOCAL, ip: '::1' };
		deepStrictEqual(await whoAmI(port, '::1', '::1'), expected);
		deepStrictEqual(await whoAmIOverWebSocket(port, '::1', '::1'), expected);
	});

	test(
		'a non-loopback IPv6 client is not trusted',
		{ skip: !REMOTE_IPV6 && 'this host has no non-loopback IPv6 address' },
		async () => {
			const { address, linkLocal } = REMOTE_IPV6!;
			for (const peer of [await whoAmI(port, address, address), await whoAmIOverWebSocket(port, address, address)]) {
				// Node appends a link-local address's zone; uWS has only the address bytes
				const { ip, ...principal } = peer;
				deepStrictEqual(principal, ANONYMOUS);
				if (linkLocal) ok(ip && address.startsWith(ip.split('%')[0]), `${ip} is not ${address}`);
				else deepStrictEqual(ip, address);
			}
		}
	);
});
