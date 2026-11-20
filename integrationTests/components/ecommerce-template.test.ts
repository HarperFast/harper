/**
 * ecommerce-template component integration test.
 *
 * Automates the manual plan in harper-qe-logbook releases/v5/harper-ecommerce-template.mdx. The
 * template ships `prebuilt: true` without a committed `.next`, so the test builds it inside the
 * running instance instead (the HARPER_READONLY build path, Harper v5.1+).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const execFileAsync = promisify(execFile);

// Bump deliberately: the assertions below track this commit's routes, seed data and config.
const TEMPLATE_SHA = '86e57a26a49c3ba1ef71521ae44d69760e2e8a41';
const TEMPLATE_TARBALL_URL = `https://codeload.github.com/HarperFast/harper-ecommerce-template/tar.gz/${TEMPLATE_SHA}`;
const PROJECT = 'harper-ecommerce-template';
// npm install of Next.js plus an in-process `next build` pinned to one worker (next.config.js `cpus: 1`).
const READY_TIMEOUT_MS = 300_000;

async function prepareTemplateArchive(workDir: string): Promise<string> {
	const response = await fetch(TEMPLATE_TARBALL_URL, { signal: AbortSignal.timeout(60_000) });
	strictEqual(response.status, 200, `downloading ${TEMPLATE_TARBALL_URL}`);
	const sourceArchive = join(workDir, 'source.tgz');
	await writeFile(sourceArchive, Buffer.from(await response.arrayBuffer()));
	await execFileAsync('tar', ['-xzf', sourceArchive, '-C', workDir]);

	// codeload names the top-level directory <repo>-<sha>; Harper strips a single top-level directory.
	const templateDir = join(workDir, `${PROJECT}-${TEMPLATE_SHA}`);
	const configPath = join(templateDir, 'config.yaml');
	const config = await readFile(configPath, 'utf8');
	ok(/^\s+prebuilt: true$/m.test(config), 'expected the pinned template to ship prebuilt: true');
	// The build runs inside handleApplication, which Harper cuts off after 30s by default; CI runners need longer.
	await writeFile(
		configPath,
		config.replace(/^(\s+)prebuilt: true$/m, `$1prebuilt: false\n$1timeout: ${READY_TIMEOUT_MS}`)
	);

	const archive = join(workDir, `${PROJECT}.tgz`);
	// COPYFILE_DISABLE stops macOS tar adding ._* entries, which would defeat the top-level directory strip.
	await execFileAsync('tar', ['-czf', archive, '-C', workDir, `${PROJECT}-${TEMPLATE_SHA}`], {
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	});
	return archive;
}

// Under HARPER_UWS_HTTP the plugin's guard sees a response but `request._nodeRequest` is null, so every
// Next.js page 500s ("Cannot read properties of null (reading 'url')") while REST still serves. The Bun
// adapter has the same null `_nodeRequest`. https://github.com/HarperFast/nextjs/issues/86
// Opt-in: the suite depends on GitHub, npm and upstream Next.js releases, so it runs only from the advisory
// job in .github/workflows/integration-tests-nextjs.yml, never in the blocking integration shards.
const skipSuite =
	!process.env.HARPER_ECOMMERCE_TEMPLATE_TEST ||
	process.platform === 'win32' ||
	process.env.HARPER_RUNTIME === 'bun' ||
	!!process.env.HARPER_UWS_HTTP;

suite('Component: ecommerce-template', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let workDir: string;

	before(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'ecommerce-template-'));
		const archive = await prepareTemplateArchive(workDir);

		await startHarper(ctx);

		const body = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT,
			package: archive,
			restart: true,
			// The default install omits devDependencies, but `next build` needs them (tailwind postcss, typescript
			// for the tsconfig `@/` path aliases). Not `npm ci`: the pinned lockfile is out of sync with package.json.
			install_command: 'npm install --include=dev',
		});
		strictEqual(body.message, `Successfully deployed: ${PROJECT}, restarting Harper`);
		ok(typeof body.deployment_id === 'string', `expected deployment_id in deploy response, got ${body.deployment_id}`);

		// REST comes up as soon as the schema loads; the homepage only once `next build` finishes and
		// the plugin starts serving, so poll the page rather than a table.
		const deadline = Date.now() + READY_TIMEOUT_MS;
		let lastOutcome = 'no response';
		while (true) {
			try {
				const check = await fetch(ctx.harper.httpURL, { signal: AbortSignal.timeout(10_000) });
				if (check.status === 200) break;
				lastOutcome = `HTTP ${check.status}: ${(await check.text()).slice(0, 200)}`;
			} catch (error) {
				lastOutcome = String(error);
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${PROJECT} to serve its homepage after deploy (last: ${lastOutcome})`);
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			if (workDir) await rm(workDir, { recursive: true, force: true });
		}
	});

	test('homepage returns 200', async () => {
		const res = await fetch(ctx.harper.httpURL);
		strictEqual(res.status, 200);
		ok(res.headers.get('content-type')?.includes('text/html'), 'expected an HTML page');
	});

	test('/products page returns 200', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products`);
		strictEqual(res.status, 200);
	});

	test('/products/[id] page renders the seeded product', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/11`);
		strictEqual(res.status, 200);
		ok((await res.text()).includes('Portable Laptop Stand'), 'expected the product name in the page');
	});

	test('GET /Product/ returns the seeded products', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body), 'expected array');
		ok(body.length >= 15, `expected at least 15 seeded products, got ${body.length}`);
	});

	test('GET /Product/:id returns the complete product record', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/11`);
		strictEqual(res.status, 200);
		const body = await res.json();
		strictEqual(body.id, '11');
		strictEqual(body.name, 'Portable Laptop Stand');
		strictEqual(body.category, 'Accessories');
		ok(typeof body.price === 'number', 'expected a numeric price');
	});

	test('GET /Traits/:id returns the seeded user traits', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Traits/1`);
		strictEqual(res.status, 200);
		const body = await res.json();
		ok(Array.isArray(body.traits), 'expected traits array');
		ok(body.traits.includes('sporty'), 'expected the seeded "sporty" trait');
	});

	test('POST /Product/ creates a new product', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: '99',
				name: 'Test Product',
				category: 'Testing',
				price: 9.99,
				image: 'https://example.com/test.png',
				description: 'CI test product',
				features: ['test feature'],
				specs: { Material: 'Plastic' },
			}),
		});
		ok(res.status < 300, `expected 2xx, got ${res.status}`);

		const getRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		strictEqual(getRes.status, 200);
		const body = await getRes.json();
		strictEqual(body.name, 'Test Product');
		strictEqual(body.category, 'Testing');
		strictEqual(body.price, 9.99);
	});

	test('PUT /Product/:id replaces the record', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/99`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updated Product', price: 19.99 }),
		});
		ok(res.status < 300, `expected 2xx, got ${res.status}`);

		const getRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		strictEqual(getRes.status, 200);
		const body = await getRes.json();
		strictEqual(body.name, 'Updated Product');
		strictEqual(body.price, 19.99);
		strictEqual(body.category, undefined, 'expected PUT to replace, not merge');
	});

	test('DELETE /Product/:id removes the record', async () => {
		const deleteRes = await fetch(`${ctx.harper.httpURL}/Product/99`, { method: 'DELETE' });
		strictEqual(deleteRes.status, 200);
		strictEqual(await deleteRes.json(), true);

		const goneRes = await fetch(`${ctx.harper.httpURL}/Product/99`);
		strictEqual(goneRes.status, 404);
	});

	test('invalid product ID returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/999`);
		strictEqual(res.status, 404);
	});

	test('invalid route returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/nonexistent`);
		strictEqual(res.status, 404);
	});

	test('string product ID returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/products/abc`);
		strictEqual(res.status, 404);
	});

	test('REST API nonexistent product returns 404', async () => {
		const res = await fetch(`${ctx.harper.httpURL}/Product/999`);
		strictEqual(res.status, 404);
	});
});
