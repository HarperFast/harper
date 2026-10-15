/**
 * harper#196: the app is installed under a dot-directory, serves a dot-directory of its own, and has
 * files named with a literal `%`. Each used to reset the connection.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-send-names');

suite('static plugin serves names send would mishandle as a URL path', (ctx: ContextWithHarper) => {
	let hiddenParent: string;
	let previousParent: string | undefined;

	before(async () => {
		hiddenParent = await mkdtemp(join(tmpdir(), '.harper-static-names-'));
		previousParent = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR;
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = hiddenParent;
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
		if (previousParent === undefined) delete process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR;
		else process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = previousParent;
		if (hiddenParent) await rm(hiddenParent, { recursive: true, force: true });
	});

	async function get(path: string) {
		const res = await fetch(new URL(path, ctx.harper.httpURL), { signal: AbortSignal.timeout(5000) });
		return { status: res.status, text: (await res.text()).trim() };
	}

	test('serves a file when the application is installed under a dot-directory', async () => {
		const res = await get('/hello.txt');
		strictEqual(res.status, 200);
		strictEqual(res.text, 'hello');
	});

	test('serves a file from a dot-directory the static config selects', async () => {
		const res = await get('/.well-known/security.txt');
		strictEqual(res.status, 200);
		strictEqual(res.text, 'Contact: mailto:security@example.com');
	});

	test('serves a file whose name contains a percent sign', async () => {
		const literal = await get('/discount-50%.txt');
		strictEqual(literal.status, 200);
		strictEqual(literal.text, 'half off');

		// the name on disk is `hello%20world.txt`; send must not decode it to `hello world.txt`
		const escaped = await get('/hello%20world.txt');
		strictEqual(escaped.status, 200);
		strictEqual(escaped.text, 'literal escape');
	});
});
