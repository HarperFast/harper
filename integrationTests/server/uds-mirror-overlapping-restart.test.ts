/**
 * Overlapping HTTP worker restart keeps every per-worker UDS mirror socket (#2961): the replacement
 * rebinds `<workerIndex>-<port>.sock` before the outgoing worker closes its own server, and libuv
 * unlinks a pipe server's bound path on close whoever owns it by then.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/uds-mirror-overlapping-restart.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { request } from 'node:http';
import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const WORKERS = 4;
// The overlapping (pre-start) restart only exists where SO_REUSEPORT is reliable: not on
// Windows or macOS, and not under Bun (see restartWorkers()'s platformCanPreStartReplacement).
const skipSuite = process.platform !== 'linux' || process.env.HARPER_RUNTIME === 'bun';

const socketsDirMode = async (dir: string) => (await stat(dir)).mode & 0o777;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ThreadInfo = { threadId: number; name: string; application?: string };

async function poolThreadIds(ctx: ContextWithHarper): Promise<number[]> {
	const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
	ok(Array.isArray(info.threads), 'system_information reports threads');
	return (info.threads as ThreadInfo[])
		.filter((thread) => thread.name === 'http' && !thread.application)
		.map((thread) => thread.threadId)
		.sort((a, b) => a - b);
}

async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, what: string, ms = 60_000) {
	const deadline = Date.now() + ms;
	let last: T;
	do {
		last = await probe();
		if (accept(last)) return last;
		await sleep(250);
	} while (Date.now() < deadline);
	throw new Error(`${what}: ${JSON.stringify(last)}`);
}

async function mirrorsByPort(socketsDir: string): Promise<Map<string, string[]>> {
	const byPort = new Map<string, string[]>();
	for (const name of await readdir(socketsDir)) {
		const match = /^(\d+)-(.+)\.sock$/.exec(name);
		if (!match) continue;
		const list = byPort.get(match[2]) ?? [];
		list.push(name);
		byPort.set(match[2], list);
	}
	return byPort;
}

function requestOverMirror(socketPath: string, ctx: ContextWithHarper): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path: '/',
				method: 'GET',
				headers: {
					authorization: `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				},
				timeout: 5000,
			},
			(res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode ?? 0));
			}
		);
		req.on('timeout', () => req.destroy(new Error('no HTTP response over the mirror')));
		req.on('error', reject);
		req.end();
	});
}

suite(
	'Overlapping HTTP worker restart keeps every UDS mirror socket (#2961)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let socketsDir: string;
		let mirrorPort: string;
		const expectedMirrors = () => Array.from({ length: WORKERS }, (_, index) => `${index}-${mirrorPort}.sock`);

		before(async () => {
			await startHarper(ctx, { config: { threads: { count: WORKERS }, tls: { unixDomainSockets: true } } } as any);
			socketsDir = join(ctx.harper.dataRootDir, 'sockets');
			const byPort = await waitFor(
				() => mirrorsByPort(socketsDir),
				(map) => [...map.values()].some((names) => names.length === WORKERS),
				`no port has ${WORKERS} worker mirrors in ${socketsDir}`
			);
			// Several secure ports publish per-worker mirrors (HTTPS, MQTTS); pick the one that speaks HTTP.
			for (const [port, names] of byPort) {
				if (names.length !== WORKERS) continue;
				const answered = await requestOverMirror(join(socketsDir, `0-${port}.sock`), ctx).catch(() => undefined);
				if (answered !== undefined) {
					mirrorPort = port;
					break;
				}
			}
			ok(mirrorPort, `no fully mirrored port answers HTTP: ${JSON.stringify([...byPort])}`);
			strictEqual(await socketsDirMode(socketsDir), 0o700, 'sockets directory is owner-only after startup');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(
			'every replacement worker still serves its mirror once the workers it replaced have exited',
			{ timeout: 180_000 },
			async () => {
				const before = await poolThreadIds(ctx);
				strictEqual(before.length, WORKERS, `expected ${WORKERS} pool workers before the restart`);
				const beforeIdentity = new Map<string, string>();
				for (const name of expectedMirrors()) {
					const info = await stat(join(socketsDir, name), { bigint: true });
					beforeIdentity.set(name, `${info.dev}:${info.ino}`);
					ok(await requestOverMirror(join(socketsDir, name), ctx), `${name} does not answer HTTP before the restart`);
				}

				// Replacement workers must tighten a directory that was widened since startup.
				await chmod(socketsDir, 0o755);
				// The operations request is served by a worker that is itself restarted, so its response is
				// best-effort; the pool's thread ids are the authoritative completion signal.
				sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' }).catch(() => {});

				let stable = 0;
				await waitFor(
					() => poolThreadIds(ctx).catch(() => [] as number[]),
					(ids) => {
						const replaced = ids.length === WORKERS && ids.every((id) => !before.includes(id));
						stable = replaced ? stable + 1 : 0;
						return stable >= 3;
					},
					'the pool never settled on a full set of replacement workers',
					120_000
				);
				// A worker leaves the pool on its 'exit', which follows its closeServers() in the SHUTDOWN
				// chain, so by now every outgoing close (and libuv's unlink) has already run.

				const present = (await mirrorsByPort(socketsDir)).get(mirrorPort) ?? [];
				deepStrictEqual(
					present.sort(),
					expectedMirrors().sort(),
					`mirror sockets missing after the restart: ${present}`
				);
				strictEqual(await socketsDirMode(socketsDir), 0o700, 'replacement workers re-tighten the sockets directory');
				for (const name of expectedMirrors()) {
					const socketPath = join(socketsDir, name);
					const info = await stat(socketPath, { bigint: true });
					ok(
						`${info.dev}:${info.ino}` !== beforeIdentity.get(name),
						`${name} is still the outgoing worker's inode, not the replacement's`
					);
					const status = await requestOverMirror(socketPath, ctx);
					ok(status >= 200 && status < 500, `${name} answered HTTP ${status}`);
				}
			}
		);
	}
);
