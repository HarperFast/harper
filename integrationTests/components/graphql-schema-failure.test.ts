/**
 * A component whose `schema.graphql` fails to parse must not gate the rest of the instance, and its
 * parse error must be diagnosable (#1917).
 *
 * On the unfixed loader the graphql plugin returned a success-only `once(entryHandler,
 * 'initialLoadComplete')`, so a rejected schema load never settled it. The component only failed at
 * the loader's watchdog, and it spent that whole watchdog holding the load lock keyed by the plugin
 * TYPE name — one lock for every application using `graphqlSchema` — so each broken application
 * delayed every other one, valid ones included. The operator saw only "handleApplication timed out",
 * never the schema, its file or its line.
 *
 * The broken fixtures shorten the plugin timeout to 5s so a baseline run against the unfixed loader
 * costs seconds rather than the measured 63.7s. Every assertion below is on observable content
 * except the per-component gap, which is what proves the loads no longer serialize behind the
 * watchdog: each broken component logs its diagnostic when it acquires the load lock, so on the
 * unfixed loader the two diagnostics are a whole watchdog apart.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/graphql-schema-failure.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitForLogMatches } from './waitForLog.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/graphql-schema-failure');
const BROKEN_APPS = ['broken-one', 'broken-two'];
// Must match the `graphqlSchema.timeout` in the broken fixtures' config.yaml.
const BROKEN_PLUGIN_TIMEOUT_MS = 5_000;

function loadAttemptTimestamp(log: string, appName: string): number {
	// Logged by Scope when the entry handler rejects — present both before and after the fix, so it
	// is a fair clock for comparing the two. The component holds the plugin load lock at this point.
	const pattern = new RegExp(`\\[${appName}\\]: Error in async entry handler`);
	const line = log.split('\n').find((entry) => pattern.test(entry));
	ok(line, `expected '${appName}' to report a failed schema load in the instance log`);
	const stamp = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
	ok(stamp, `expected an ISO timestamp on '${appName}' schema load failure: ${line}`);
	return Date.parse(stamp);
}

suite('a broken graphqlSchema does not gate the whole instance', (ctx: ContextWithHarper) => {
	let instanceLog: string;

	before(async () => {
		// All three apps must land directly under components/, so stage the data root rather than
		// using setupHarperWithFixture (which copies a single fixture dir as one component).
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		for (const app of [...BROKEN_APPS, 'control']) {
			await cp(join(FIXTURE_PATH, app), join(dataRootDir, 'components', app), { recursive: true, dereference: true });
		}
		ctx.harper = { dataRootDir };
		// One worker: the load lock is cross-thread, so extra workers only repeat the same queue.
		await startHarper(ctx, { config: { threads: { count: 1 } } });

		const logDirectory = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		instanceLog = await waitForLogMatches(
			join(logDirectory, 'hdb.log'),
			BROKEN_APPS.map((app) => new RegExp(`\\[${app}\\]: Error in async entry handler`))
		);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the valid application serves its routes', async () => {
		const res = await fetch(new URL('/ControlThing', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /ControlThing to serve: ${res.status} ${text}`);
	});

	test('a broken component reports the real reason, not a watchdog timeout', async () => {
		// The loader publishes a failed component as an ErrorResource that rethrows on every request,
		// so its error message is what a client sees as the RFC 9457 problem title.
		const res = await fetch(new URL('/', ctx.harper.httpURL), { headers: { accept: 'application/json' } });
		const title = ((await res.json()) as { title?: string }).title ?? '';
		ok(
			/Could not load component 'graphqlSchema' for application 'broken-(one|two)'/.test(title),
			`expected a broken component's load failure to be reported: ${title}`
		);
		ok(/Invalid GraphQL schema/.test(title), `expected the real reason in the reported failure: ${title}`);
		ok(!/timed out/.test(title), `a diagnosed schema failure must not be reported as a watchdog timeout: ${title}`);
	});

	test('the client-facing failure carries no schema source and no host path', async () => {
		const res = await fetch(new URL('/', ctx.harper.httpURL), { headers: { accept: 'application/json' } });
		const body = await res.text();
		ok(!body.includes('@primaryKey'), `a problem response must not echo the schema source: ${body}`);
		ok(!body.includes(ctx.harper.dataRootDir), `a problem response must not echo the host path: ${body}`);
		ok(!body.includes('Syntax Error'), `the parser detail belongs in the log, not the response: ${body}`);
	});

	test('the instance log names the schema file, line, column and offending token', () => {
		for (const app of BROKEN_APPS) {
			const diagnostic = instanceLog
				.split('\n')
				.find((line) => line.includes('Invalid GraphQL schema in') && line.includes(`${app}/schema.graphql`));
			ok(diagnostic, `expected a schema diagnostic naming ${app}/schema.graphql in the instance log`);
		}
		ok(/Syntax Error/.test(instanceLog), 'the diagnostic must carry the parser message');
		ok(/schema\.graphql:\d+:\d+/.test(instanceLog), 'the diagnostic must carry the file, line and column');
		ok(/^\s*\|\s*\^/m.test(instanceLog), 'the diagnostic must carry the caret pointing at the offending token');
	});

	test('the broken components do not serialize behind each other', () => {
		const gap = Math.abs(
			loadAttemptTimestamp(instanceLog, 'broken-two') - loadAttemptTimestamp(instanceLog, 'broken-one')
		);
		ok(
			gap < BROKEN_PLUGIN_TIMEOUT_MS - 1_000,
			`the two broken components loaded ${gap}ms apart; with the plugin timeout at ` +
				`${BROKEN_PLUGIN_TIMEOUT_MS}ms that means the second waited out the first's watchdog`
		);
	});
});
