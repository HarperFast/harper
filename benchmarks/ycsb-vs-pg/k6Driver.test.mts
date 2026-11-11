/**
 * The k6 load generator against a recording HTTP server: every phase's requests, the window it opens and
 * closes, and how it fails. Skipped where k6 is not installed (YCSB_K6 or `k6` on PATH).
 *   node --test benchmarks/ycsb-vs-pg/k6Driver.test.mts
 */
import { test } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DENY_EVERY, formatKey, linkPrefix, ownerOf } from '../ycsb/workload.mts';
import { k6Binary, parseSummary, startDriver, type DriverConfig, type PhaseWindow } from './k6Driver.mts';

const hasK6 = (() => {
	try {
		execFileSync(k6Binary(), ['version'], { stdio: 'ignore', timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
})();
const skip = hasK6 ? false : 'k6 is not installed';

const RECORDS = 300;
const KEY_WIDTH = 6;
const SHAPE = { fieldCount: 10, fieldLength: 100 };

interface Seen {
	method: string;
	path: string;
	headers: IncomingMessage['headers'];
	body: string;
	/** Whether the test's window was open when the request arrived. */
	inWindow: boolean;
}

/** Answers like the benchmark app: records by key (404 when absent), owner-checked inspect, chain. */
async function recordingServer(): Promise<{
	server: Server;
	baseUrl: string;
	seen: Seen[];
	stored: Map<string, string>;
	window: { open: boolean };
}> {
	const seen: Seen[] = [];
	const stored = new Map<string, string>();
	const window = { open: false };
	const server = createServer((request, response) => {
		let body = '';
		request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
		request.on('end', () => {
			const path = request.url!;
			seen.push({ method: request.method!, path, headers: request.headers, body, inWindow: window.open });
			const record = /^\/usertable\/(user\d+)$/.exec(path);
			if (record && request.method === 'PUT') {
				stored.set(record[1], body);
				response.writeHead(204).end();
			} else if (record) {
				response.writeHead(stored.has(record[1]) ? 200 : 404).end(stored.get(record[1]) ?? '');
			} else if (path.startsWith('/inspect/')) {
				const index = Number(path.slice('/inspect/user'.length));
				const caller = request.headers.authorization?.replace('Bearer ', '') ?? request.headers['x-caller'];
				response.writeHead(caller === ownerOf(index) ? 200 : 403).end();
			} else {
				response.writeHead(200).end('[]');
			}
		});
	});
	server.listen(0, '127.0.0.1');
	await new Promise((resolve) => server.once('listening', resolve));
	const { port } = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${port}`, seen, stored, window };
}

const config = (baseUrl: string, extra: Partial<DriverConfig> = {}): DriverConfig => ({
	baseUrl,
	table: 'usertable',
	records: RECORDS,
	opsPerWorkload: 400,
	concurrency: 8,
	shape: SHAPE,
	keyWidth: KEY_WIDTH,
	maxScanLength: 10,
	...extra,
});

const recordingWindow = (state: { open: boolean }) => {
	const calls: string[] = [];
	const window: PhaseWindow = {
		async begin() {
			calls.push('begin');
			state.open = true;
		},
		async end() {
			calls.push('end');
			state.open = false;
		},
	};
	return { window, calls };
};

test('parseSummary takes the last summary line and refuses a short, foreign or non-finite one', () => {
	const line = (summary: object) => `YCSB_K6_SUMMARY ${JSON.stringify(summary)}`;
	const good = { phaseId: 'p1', iterations: 4, ops: 3, errors: 1, latency: { read: { count: 3, p50: 0.2 } } };
	const stdout = ['banner', line({ ...good, ops: 0 }), line(good), ''].join('\n');
	deepStrictEqual(parseSummary(stdout, 'p1', 4), good);
	throws(() => parseSummary('nothing here', 'p1', 4), /no summary/);
	throws(() => parseSummary(line(good), 'p2', 4), /phase p1, not p2/);
	throws(() => parseSummary(line({ ...good, iterations: 3 }), 'p1', 4), /ran 3 of 4 iterations/);
	throws(() => parseSummary(line({ ...good, ops: 2 }), 'p1', 4), /ran 4 of 4 iterations \(2 ops, 1 errors\)/);
	throws(() => parseSummary(line({ ...good, latency: { read: { count: 3, p50: null } } }), 'p1', 4), /not finite/);
});

test('load writes every key once with its link and owner; read-all reads each once', { skip }, async () => {
	const { server, baseUrl, seen, stored } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl, { authorization: 'Bearer loader' }));
		strictEqual(driver.load.ops, RECORDS);
		strictEqual(driver.load.errors, 0);
		ok(driver.load.generatorCpuSeconds >= 0);
		strictEqual(stored.size, RECORDS);
		for (let index = 0; index < RECORDS; index++) {
			const record = JSON.parse(stored.get(formatKey(index, KEY_WIDTH))!);
			ok(record.field0.startsWith(linkPrefix({ index, keyCount: RECORDS, keyWidth: KEY_WIDTH })));
			strictEqual(Object.keys(record).length, SHAPE.fieldCount);
		}
		ok(seen.every((s) => s.headers.authorization === 'Bearer loader'));
		seen.length = 0;
		const all = await driver.readAll();
		strictEqual(all.ops, RECORDS);
		deepStrictEqual(
			seen.map((s) => s.path).sort(),
			Array.from({ length: RECORDS }, (_, i) => `/usertable/${formatKey(i, KEY_WIDTH)}`).sort()
		);
		await driver.close();
	} finally {
		server.close();
	}
});

test('a measured run happens entirely inside its window, which opens and closes once', { skip }, async () => {
	const { server, baseUrl, seen, window: state } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl));
		seen.length = 0;
		const { window, calls } = recordingWindow(state);
		const result = await driver.runWorkload('C', 'zipfian', 500, undefined, window);
		deepStrictEqual(calls, ['begin', 'end']);
		strictEqual(seen.length, 500);
		ok(seen.every((s) => s.inWindow && s.method === 'GET' && /^\/usertable\/user\d{6}$/.test(s.path)));
		strictEqual(result.ops, 500);
		strictEqual(result.errors, 0);
		strictEqual(result.latency.read!.count, 500);
		ok(result.latency.read!.p50 > 0 && result.latency.read!.p99 >= result.latency.read!.p50);
		ok(result.throughput > 0 && result.elapsedMs > 0);
	} finally {
		server.close();
	}
});

test('inspect sends each owner its own credential and expects the denial it causes', { skip }, async () => {
	const { server, baseUrl, seen } = await recordingServer();
	try {
		const callerAuthorizations = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [ownerOf(i), `Bearer ${ownerOf(i)}`])
		);
		const driver = await startDriver(config(baseUrl, { load: false, callerAuthorizations }));
		const result = await driver.runWorkload('inspect', 'zipfian', 400);
		strictEqual(result.errors, 0, 'every allowed inspect answered 200 and every denied one 403');
		strictEqual(result.ops, 400);
		const denied = seen.filter((s) => {
			const index = Number(s.path.slice('/inspect/user'.length));
			return s.headers.authorization !== `Bearer ${ownerOf(index)}`;
		});
		// One in DENY_EVERY per VU, so between 0 and 400 / DENY_EVERY + 8 in all.
		ok(denied.length > 0 && denied.length <= 400 / DENY_EVERY + 8, `${denied.length} denied`);
	} finally {
		server.close();
	}
});

test('inserting workloads give each VU its own keys and read only acknowledged ones', { skip }, async () => {
	const { server, baseUrl, seen, stored } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl));
		seen.length = 0;
		const result = await driver.runWorkload('D', 'latest', 2_000);
		strictEqual(result.errors, 0, 'no read reached a key that was not yet inserted');
		const inserted = seen.filter((s) => s.method === 'PUT').map((s) => Number(s.path.slice('/usertable/user'.length)));
		ok(inserted.length > 0);
		strictEqual(new Set(inserted).size, inserted.length, 'no key inserted twice');
		ok(inserted.every((index) => index >= RECORDS));
		strictEqual(stored.size, RECORDS + inserted.length);
	} finally {
		server.close();
	}
});

test('a window that fails to open fails the phase before any request', { skip }, async () => {
	const { server, baseUrl, seen } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl, { load: false }));
		let ended = 0;
		const window: PhaseWindow = {
			begin: async () => {
				throw new Error('perf would not start');
			},
			end: async () => {
				ended++;
			},
		};
		await rejects(driver.runWorkload('C', 'zipfian', 200, undefined, window), /perf would not start/);
		strictEqual(ended, 0);
		strictEqual(seen.length, 0);
	} finally {
		server.close();
	}
});

test('k6 dying mid-run fails the phase and still closes its window once', { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'k6-driver-test-'));
	const pidFile = join(dir, 'k6.pid');
	const wrapper = join(dir, 'k6');
	writeFileSync(wrapper, `#!/bin/sh\necho $$ > ${pidFile}\nexec ${k6Binary()} "$@"\n`);
	chmodSync(wrapper, 0o755);
	const { server, baseUrl, seen, window: state } = await recordingServer();
	const previous = process.env.YCSB_K6;
	process.env.YCSB_K6 = wrapper;
	try {
		const driver = await startDriver(config(baseUrl, { load: false }));
		const { window, calls } = recordingWindow(state);
		server.on('request', () => {
			if (seen.length === 50 && existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
		});
		await rejects(driver.runWorkload('C', 'zipfian', 1_000_000, undefined, window), /k6 exited/);
		deepStrictEqual(calls, ['begin', 'end']);
	} finally {
		if (previous === undefined) delete process.env.YCSB_K6;
		else process.env.YCSB_K6 = previous;
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a phase with fewer keys or ops than VUs runs every one of them', { skip }, async () => {
	const { server, baseUrl, stored } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl, { records: 3 }));
		strictEqual(driver.load.ops, 3);
		strictEqual(stored.size, 3);
		strictEqual((await driver.runWorkload('C', 'zipfian', 2)).ops, 2);
		strictEqual((await driver.runWorkload('C', 'zipfian', 0)).ops, 0);
	} finally {
		server.close();
	}
});

test('a window still opening when k6 dies is closed once it has opened', { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'k6-driver-test-'));
	const pidFile = join(dir, 'k6.pid');
	const wrapper = join(dir, 'k6');
	writeFileSync(wrapper, `#!/bin/sh\necho $$ > ${pidFile}\nexec ${k6Binary()} "$@"\n`);
	chmodSync(wrapper, 0o755);
	const { server, baseUrl } = await recordingServer();
	const previous = process.env.YCSB_K6;
	process.env.YCSB_K6 = wrapper;
	try {
		const driver = await startDriver(config(baseUrl, { load: false }));
		const calls: string[] = [];
		const window: PhaseWindow = {
			async begin() {
				calls.push('begin');
				process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
				await new Promise((resolve) => setTimeout(resolve, 300));
				calls.push('opened');
			},
			async end() {
				calls.push('end');
			},
		};
		await rejects(driver.runWorkload('C', 'zipfian', 1000, undefined, window), /k6 exited/);
		deepStrictEqual(calls, ['begin', 'opened', 'end']);
	} finally {
		if (previous === undefined) delete process.env.YCSB_K6;
		else process.env.YCSB_K6 = previous;
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('failed requests are counted, not fatal, and only successes are timed', { skip }, async () => {
	const { server, baseUrl } = await recordingServer();
	try {
		const driver = await startDriver(config(baseUrl, { load: false }));
		const result = await driver.runWorkload('C', 'zipfian', 100);
		strictEqual(result.errors, 100);
		strictEqual(result.ops, 0);
		strictEqual(result.latency.read, undefined);
	} finally {
		server.close();
	}
});
