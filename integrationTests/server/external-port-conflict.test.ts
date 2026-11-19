/**
 * Regression test for external MQTT port-conflict detection.
 *
 * With reusePort (Linux), sibling workers share a port and never raise EADDRINUSE; without it
 * (macOS/Windows), the main thread binds every port before any worker starts and never
 * restarts. Either way an EADDRINUSE on the reusePort path or the main thread is never a
 * benign in-process collision — it means an unrelated process already holds the port and will
 * silently receive this listener's traffic. Harper used to swallow that EADDRINUSE
 * unconditionally, so a squatter on the MQTT port went completely unreported (the original
 * symptom: a developer's second Harper instance holding 8883, MQTT connections silently
 * routed to it).
 *
 * This test pre-occupies the MQTT secure port with an unrelated plain socket server, boots
 * Harper on the same address, and asserts (a) Harper logs the external conflict and (b) Harper
 * still starts (the conflict is surfaced, not fatal).
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	startHarper,
	teardownHarper,
	getNextAvailableLoopbackAddress,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

// Mirrors @harperfast/integration-testing's fixed MQTT secure port.
const MQTTS_PORT = 8883;
const CONFLICT_LOG = /address already in use by another process/;

/** Bind a plain (non-reusePort) TCP server to simulate an unrelated process squatting the port. */
function occupyPort(host: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen({ host, port, reusePort: false }, () => {
			server.removeListener('error', reject);
			resolve(server);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Poll the instance's hdb.log until it contains `pattern` or the deadline passes. */
async function waitForLogMatch(logDir: string, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
	const logFile = join(logDir, 'hdb.log');
	const deadline = Date.now() + timeoutMs;
	let contents = '';
	while (Date.now() < deadline) {
		try {
			contents = await readFile(logFile, 'utf8');
			if (pattern.test(contents)) return contents;
		} catch {
			// log file may not exist yet
		}
		await sleep(200);
	}
	return contents;
}

suite('external MQTT port conflict is surfaced, not swallowed', (ctx: ContextWithHarper) => {
	let squatter: Server;
	let hostname: string;

	before(async () => {
		hostname = await getNextAvailableLoopbackAddress();
		// Grab the MQTT secure port before Harper boots, as an unrelated process would.
		squatter = await occupyPort(hostname, MQTTS_PORT);

		const dataRootDir = await mkdtemp(join(tmpdir(), 'harper-external-port-conflict-'));
		// Pre-seed hostname so startHarper binds MQTT on the exact address we squatted.
		ctx.harper = { dataRootDir, hostname } as ContextWithHarper['harper'];
		// Must resolve despite the squatter — the conflict is surfaced, not fatal.
		await startHarper(ctx);
	});

	after(async () => {
		// Release the port before teardown so its port-free wait doesn't block on our squatter.
		// teardownHarper() releases the loopback address (only once it has confirmed the ports are
		// free), so don't release it again here — a second unconditional release could return a
		// still-parked address to the shared pool.
		if (squatter) await closeServer(squatter);
		await teardownHarper(ctx);
	});

	// Detection is universal: with reusePort (Linux) siblings share the port so any EADDRINUSE is
	// external; without it (macOS/Windows/Bun raw sockets) the main thread binds first and never
	// restarts, so its EADDRINUSE is equally unambiguous.
	test('Harper logs the external bind conflict for the MQTT port', async () => {
		const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		const contents = await waitForLogMatch(logDir, CONFLICT_LOG);
		ok(
			CONFLICT_LOG.test(contents),
			`expected an external-conflict log for the MQTT port; got:\n${contents.slice(-2000)}`
		);
	});

	test('Harper still started despite the conflict', () => {
		// startHarper() resolved in before() (it throws HarperStartupError otherwise), so a live
		// process handle is the proof the squatted port did not abort boot.
		ok(ctx.harper.process && ctx.harper.process.exitCode === null, 'Harper process should be running');
	});
});
