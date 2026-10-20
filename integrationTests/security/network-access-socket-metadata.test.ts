/**
 * set_network_access publishes the operations allowlist as `allowedSources` in the operations API's UDS
 * mirror metadata, live, and removes it when cleared (#3358). A fronting proxy enforces it; Harper only
 * persists and publishes, so this asserts the YAML, not admission.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/network-access-socket-metadata.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual, match } from 'node:assert';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const execFileAsync = promisify(execFile);

// Mirrors are unix domain sockets; Windows has no mirror to publish to.
const skipSuite = process.platform === 'win32';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function freePort(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, host, () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

async function yamlFiles(socketsDir: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const name of await readdir(socketsDir).catch(() => [] as string[])) {
		if (name.endsWith('.yaml')) files.set(name, await readFile(join(socketsDir, name), 'utf8').catch(() => ''));
	}
	return files;
}

async function waitFor<T>(probe: () => Promise<T>, accept: (value: T) => boolean, what: string, ms = 30_000) {
	const deadline = Date.now() + ms;
	let last: T;
	do {
		last = await probe();
		if (accept(last)) return last;
		await sleep(100);
	} while (Date.now() < deadline);
	throw new Error(`${what}: ${JSON.stringify(last instanceof Map ? [...last] : last)}`);
}

suite('Operations allowlist in UDS mirror metadata (#3358)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let socketsDir: string;
	let operationsPort: string;
	const isOperationsMirror = (yaml: string) => yaml.includes(`\nport: ${operationsPort}\n`);
	const operationsMirrors = async () =>
		[...(await yamlFiles(socketsDir)).values()].filter((yaml) => isOperationsMirror(yaml));

	const start = () =>
		startHarper(ctx, {
			config: { tls: { unixDomainSockets: true }, operationsApi: { network: { securePort: operationsPort } } },
		} as any);

	before(async () => {
		operationsPort = `127.0.0.1:${await freePort('127.0.0.1')}`;
		await start();
		socketsDir = join(ctx.harper.dataRootDir, 'sockets');
		const mirrors = await waitFor(operationsMirrors, (list) => list.length > 0, 'no operations API mirror metadata');
		for (const yaml of mirrors) ok(!yaml.includes('allowedSources'), 'unrestricted before any list is set');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('refuses a list that excludes the caller unless forced', async () => {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'set_network_access', scope: 'operations', allow: ['10.0.0.0/8'] }),
		});
		const body = await response.json();
		strictEqual(response.status, 409, JSON.stringify(body));
		match(body.error, /source address 127\.\d+\.\d+\.\d+/);
		deepStrictEqual(
			(await sendOperation(ctx.harper, { operation: 'get_network_access', scope: 'operations' })).allow,
			[]
		);
	});

	test('the local CLI, over the operations domain socket, is the recovery path and skips the check', async () => {
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(env))
			if (key.startsWith('HARPER_CLI_') || key.startsWith('CLI_TARGET_')) delete env[key];
		delete env.NODE_OPTIONS;
		const home = ctx.harper.dataRootDir;
		const { stdout } = await execFileAsync(
			process.execPath,
			[HARPER_BIN, 'set_network_access', 'scope=operations', 'allow=["10.0.0.0/8"]'],
			{ cwd: home, env: { ...env, HOME: home, USERPROFILE: home }, timeout: 30_000 }
		);
		match(stdout, /10\.0\.0\.0\/8/);
		deepStrictEqual((await sendOperation(ctx.harper, { operation: 'get_network_access', scope: 'operations' })).allow, [
			'10.0.0.0/8',
		]);
	});

	test('publishes the list without a restart, and only on operations mirrors', async () => {
		const result = await sendOperation(ctx.harper, {
			operation: 'set_network_access',
			scope: 'operations',
			allow: ['10.0.0.0/8', '2001:DB8::/32', '192.0.2.7'],
			force: true,
		});
		deepStrictEqual(result.allow, ['10.0.0.0/8', '2001:db8::/32', '192.0.2.7/32']);

		const expected = 'allowedSources:\n  - "10.0.0.0/8"\n  - "2001:db8::/32"\n  - "192.0.2.7/32"\n';
		const mirrors = await waitFor(
			operationsMirrors,
			(list) => list.length > 0 && list.every((yaml) => yaml.includes(expected)),
			'operations mirror metadata never published the list'
		);
		ok(mirrors.length > 0);
		for (const [name, yaml] of await yamlFiles(socketsDir)) {
			if (!isOperationsMirror(yaml)) ok(!yaml.includes('allowedSources'), `${name} is not an operations mirror`);
		}

		const stored = await sendOperation(ctx.harper, { operation: 'get_network_access', scope: 'operations' });
		deepStrictEqual(stored.allow, ['10.0.0.0/8', '2001:db8::/32', '192.0.2.7/32']);
		strictEqual(stored.updatedBy, ctx.harper.admin.username);
	});

	test('a restarted node publishes the persisted list in its first metadata write', async () => {
		await killHarper(ctx);
		await start();
		const sawUnrestricted: string[] = [];
		await waitFor(
			async () => {
				const mirrors = await operationsMirrors();
				for (const yaml of mirrors) if (!yaml.includes('allowedSources')) sawUnrestricted.push(yaml);
				return mirrors;
			},
			(list) => list.length > 0 && list.every((yaml) => yaml.includes('  - "10.0.0.0/8"\n')),
			'operations mirror metadata lacks the persisted list after restart'
		);
		deepStrictEqual(sawUnrestricted, [], 'an operations mirror was advertised unrestricted after restart');
	});

	test('clearing the list removes allowedSources without a restart', async () => {
		await sendOperation(ctx.harper, { operation: 'set_network_access', scope: 'operations', allow: [] });
		await waitFor(
			operationsMirrors,
			(list) =>
				list.length > 0 && list.every((yaml) => !yaml.includes('allowedSources') && yaml.includes('certificates:')),
			'operations mirror metadata still carries allowedSources'
		);
		deepStrictEqual(
			(await sendOperation(ctx.harper, { operation: 'get_network_access' })).map((view: any) => view.allow),
			[[]]
		);
	});
});
