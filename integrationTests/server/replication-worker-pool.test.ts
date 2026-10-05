import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	HarperStartupError,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const RECORDER = resolve(import.meta.dirname, 'fixtures/load-recorder');
const HTTP_THREADS = 2;
const REPLICATION_THREADS = 2;

type ThreadInfo = { threadId: number; name: string; application?: string };

async function threads(ctx: ContextWithHarper): Promise<ThreadInfo[]> {
	const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
	ok(Array.isArray(info.threads), 'system_information reports threads');
	return info.threads as ThreadInfo[];
}
const ofType = (list: ThreadInfo[], name: string) =>
	list
		.filter((thread) => thread.name === name)
		.map((thread) => thread.threadId)
		.sort();

async function newDataRoot(ctx: ContextWithHarper) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	ctx.harper = { dataRootDir } as any;
	return dataRootDir;
}

// The Bun listener path is not exercised here, as in isolated-application.test.ts.
const UNSUPPORTED_HERE = process.env.HARPER_RUNTIME === 'bun';

suite('a replication worker pool (replication.threads)', { skip: UNSUPPORTED_HERE }, (ctx: ContextWithHarper) => {
	let loadsLog: string;
	before(async () => {
		const dataRootDir = await newDataRoot(ctx);
		const componentDir = join(dataRootDir, 'components', basename(RECORDER));
		await cp(RECORDER, componentDir, { recursive: true, dereference: true });
		loadsLog = join(componentDir, 'loads.log');
		await startHarper(ctx, {
			config: {
				threads: { count: HTTP_THREADS },
				// nothing in core claims this port; the pool needs one of its own to start at all
				replication: { threads: REPLICATION_THREADS, securePort: 19933 },
			},
		});
	});
	after(async () => {
		await killHarper(ctx);
		await teardownHarper(ctx);
	});

	test('starts the configured number of replication workers beside the HTTP pool', async () => {
		const list = await threads(ctx);
		strictEqual(ofType(list, 'replication').length, REPLICATION_THREADS, JSON.stringify(list));
		strictEqual(ofType(list, 'http').length, HTTP_THREADS, JSON.stringify(list));
	});

	test('loads no application code on a replication worker', async () => {
		const response = await fetch(new URL('/LoadRecorder/probe', ctx.harper.httpURL));
		strictEqual(response.status, 200, 'the HTTP workers serve the application');
		const loaders = (await readFile(loadsLog, 'utf8')).trim().split('\n');
		ok(
			loaders.some((line) => line.startsWith('http ')),
			loaders.join(', ')
		);
		ok(!loaders.some((line) => line.startsWith('replication ')), loaders.join(', '));
	});

	test('an application change restarts the HTTP workers but not the pool', async () => {
		const before = await threads(ctx);
		await sendOperation(ctx.harper, { operation: 'drop_component', project: basename(RECORDER), restart: true });
		const after = await threads(ctx);
		const httpBefore = ofType(before, 'http');
		for (const id of ofType(after, 'http')) ok(!httpBefore.includes(id), `HTTP worker ${id} was replaced`);
		strictEqual(
			JSON.stringify(ofType(after, 'replication')),
			JSON.stringify(ofType(before, 'replication')),
			'the replication workers survived the application restart'
		);
	});

	test('an operator restart_service restarts the pool too', async () => {
		const before = ofType(await threads(ctx), 'replication');
		await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' });
		const deadline = Date.now() + 60_000;
		let after: number[];
		do {
			after = ofType(await threads(ctx), 'replication');
			if (after.length === REPLICATION_THREADS && after.every((id) => !before.includes(id))) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		} while (Date.now() < deadline);
		strictEqual(after.length, REPLICATION_THREADS);
		for (const id of after) ok(!before.includes(id), `replication worker ${id} was replaced`);
	});
});

suite(
	'a replication pool without a replication port of its own',
	{ skip: UNSUPPORTED_HERE },
	(ctx: ContextWithHarper) => {
		after(async () => {
			await killHarper(ctx).catch(() => undefined);
			await teardownHarper(ctx);
		});

		test('refuses to start', async () => {
			await newDataRoot(ctx);
			await rejects(
				startHarper(ctx, { config: { replication: { threads: 1, port: null, securePort: null } } }),
				(error: Error) =>
					error instanceof HarperStartupError &&
					error.message.includes('replication.threads requires replication.port or replication.securePort')
			);
		});
	}
);
