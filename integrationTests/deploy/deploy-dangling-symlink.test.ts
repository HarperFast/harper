/**
 * package_component / deploy_component past a dangling symlink — harper#1718.
 *
 * Pins: a source project with a dangling symlink positioned early in directory order
 * (before real files like schema.graphql, resources.js, and static web assets) is
 * packaged and deployed without truncating entries that follow the broken link in walk
 * order. Both the packaged tar.gz contents and the deployed component's on-disk state
 * are verified, plus a REST endpoint that only exists if resources.js survived packaging.
 *
 * Run: npm run test:integration -- "integrationTests/deploy/deploy-dangling-symlink.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, mkdirSync, symlinkSync, cpSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_DIR = join(import.meta.dirname, 'deploy-dangling-symlink', 'fixture');
const SRC_PROJECT = 'qa518-dangling-src';
const DEPLOYED_PROJECT = 'qa518-dangling-deployed';

async function callOperation(
	ctx: ContextWithHarper,
	op: Record<string, unknown>
): Promise<{ status: number; body: any }> {
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth },
		body: JSON.stringify(op),
	});
	const text = await res.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// leave as text
	}
	return { status: res.status, body: parsed };
}

suite('package_component/deploy_component past a dangling symlink (#1718)', (ctx: ContextWithHarper) => {
	let componentsRoot: string;
	let srcDir: string;
	let packagePayload: string;

	before(async () => {
		await startHarper(ctx, { config: { logging: { root: 'log', level: 'debug' } } });

		// Source project lives under node_modules (not componentsRoot) to avoid being
		// auto-loaded as a root application on worker restart during the deploy test.
		componentsRoot = join(ctx.harper.dataRootDir, 'components');
		srcDir = join(ctx.harper.dataRootDir, 'node_modules', SRC_PROJECT);
		mkdirSync(srcDir, { recursive: true });

		cpSync(join(FIXTURE_DIR, 'config.yaml'), join(srcDir, 'config.yaml'));

		// Dangling symlink created early — every file below it in insertion order must
		// survive packaging despite the pre-scan finding this broken link.
		symlinkSync(join(srcDir, 'does-not-exist-target'), join(srcDir, 'aaa-broken-link'));

		cpSync(join(FIXTURE_DIR, 'schema.graphql'), join(srcDir, 'schema.graphql'));
		cpSync(join(FIXTURE_DIR, 'resources.js'), join(srcDir, 'resources.js'));
		cpSync(join(FIXTURE_DIR, 'web'), join(srcDir, 'web'), { recursive: true });

		// Nested dangling symlink inside a real subdirectory, sibling file created after it.
		const subDir = join(srcDir, 'sub');
		mkdirSync(subDir, { recursive: true });
		symlinkSync(join(subDir, 'also-does-not-exist'), join(subDir, 'broken-nested-link'));
		writeFileSync(join(subDir, 'after-nested.txt'), 'after-nested-content\n');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('verify Harper', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
	});

	test('package_component packages past the dangling symlink without truncating', async () => {
		const pkg = await callOperation(ctx, {
			operation: 'package_component',
			project: SRC_PROJECT,
			skip_node_modules: true,
		});
		strictEqual(pkg.status, 200, `expected 200, got ${pkg.status}: ${JSON.stringify(pkg.body)}`);
		strictEqual(pkg.body.project, SRC_PROJECT);
		ok(
			typeof pkg.body.payload === 'string' && pkg.body.payload.length > 0,
			'package_component should return a non-empty base64 payload'
		);
		packagePayload = pkg.body.payload;

		const { gunzipSync } = await import('node:zlib');
		const tarBuf = gunzipSync(Buffer.from(packagePayload, 'base64'));
		const tarText = tarBuf.toString('latin1');
		for (const expected of [
			'config.yaml',
			'schema.graphql',
			'resources.js',
			'web/index.html',
			'web/about.html',
			'sub/after-nested.txt',
		]) {
			ok(tarText.includes(expected), `packaged tar is missing entry created after the dangling symlink: ${expected}`);
		}
		ok(!tarText.includes('aaa-broken-link'), 'the dangling symlink itself should not be packed as an entry');
	});

	test('deploy_component from that payload deploys the FULL component — fix holds end-to-end', async () => {
		const res = await callOperation(ctx, {
			operation: 'deploy_component',
			project: DEPLOYED_PROJECT,
			payload: packagePayload,
			restart: true,
		});
		strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
		ok(
			typeof res.body.deployment_id === 'string' && /^[0-9a-f-]{36}$/i.test(res.body.deployment_id),
			`expected a UUID deployment_id, got ${JSON.stringify(res.body.deployment_id)}`
		);

		// 45s (vs. the 30s used by the sibling deploy-from-source/deploy-from-github tests): this
		// deploy repackages and restarts a component with more files (including the post-symlink
		// entries), and CI's Windows runners observed this miss a 30s deadline by ~100ms — a slower
		// full restart, not a hang.
		const deadline = Date.now() + 45_000;
		while (true) {
			try {
				const check = await fetch(ctx.harper.httpURL);
				const body = await check.text();
				if (check.status === 200 && body.includes('QA-518 index')) break;
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for application to be ready after restart');
			await sleep(250);
		}

		const deployedDir = join(componentsRoot, DEPLOYED_PROJECT);
		for (const rel of [
			'config.yaml',
			'schema.graphql',
			'resources.js',
			join('web', 'index.html'),
			join('web', 'about.html'),
			join('sub', 'after-nested.txt'),
		]) {
			ok(existsSync(join(deployedDir, rel)), `deployed component is missing ${rel}`);
		}
		ok(!existsSync(join(deployedDir, 'aaa-broken-link')), 'the dangling symlink should not have been deployed');
		ok(
			!existsSync(join(deployedDir, 'sub', 'broken-nested-link')),
			'the nested dangling symlink should not have been deployed'
		);

		const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		const pingRes = await fetch(`${ctx.harper.httpURL}/QA518Ping`, { headers: { Authorization: auth } });
		strictEqual(pingRes.status, 200, `expected QA518Ping to be live, got ${pingRes.status}`);
		const pingBody = await pingRes.json();
		strictEqual(pingBody.marker, 'qa518-dangling-symlink-fix');

		const aboutOnDisk = await readFile(join(deployedDir, 'web', 'about.html'), 'utf8');
		ok(aboutOnDisk.includes('QA-518 about'), 'deployed web/about.html content does not match source');
	});

	test('server-initiated path emits no operator-visible warning about the skipped link (residual gap, tracked as #1719)', async () => {
		const pkg = await callOperation(ctx, {
			operation: 'package_component',
			project: SRC_PROJECT,
			skip_node_modules: true,
		});
		const { project: _echo, ...pkgRest } = pkg.body ?? {};
		const pkgText = JSON.stringify(pkgRest).toLowerCase();
		const mentionsSkip = /dangling|broken.?link|symlink/.test(pkgText);

		let logHasWarning = false;
		const logCandidates = [
			...((ctx.harper as any).logDir ? [join((ctx.harper as any).logDir, 'hdb.log')] : []),
			join(ctx.harper.dataRootDir, 'log', 'hdb.log'),
		];
		let log = '';
		let readAny = false;
		for (const candidate of logCandidates) {
			try {
				log += (await readFile(candidate, 'utf8')) + '\n';
				readAny = true;
			} catch {
				// try next candidate
			}
		}
		if (readAny) {
			const re =
				/(dangling|broken.?link).*symlink|symlink.*(dangling|broken.?link)|aaa-broken-link|broken-nested-link/i;
			logHasWarning = log.split('\n').some((line) => re.test(line));
		}

		ok(readAny, `could not read hdb.log — "no warning found" would be vacuous: ${logCandidates.join(', ')}`);
		// Assert expected state explicitly: if #1719 is fixed, this test will fail and needs updating.
		strictEqual(
			mentionsSkip,
			false,
			'package_component response unexpectedly surfaced a skipped-symlink warning — #1719 may be fixed, update this test'
		);
		strictEqual(
			logHasWarning,
			false,
			'hdb.log unexpectedly contains a skipped-symlink warning — #1719 may be fixed, update this test'
		);
	});
});
