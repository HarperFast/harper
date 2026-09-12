/**
 * `deploy_component` never publishes a candidate that fails to load — through the real operations API,
 * which deploys on the MAIN thread (#2315 step 2).
 *
 * The regression this guards: the load check used to be gated on `!isMainThread`, and the operations API
 * deploys on main, so for an operator deploy it ran nothing at all. Step 1 put the check between build and
 * swap, but on this path there was no check to order — a candidate that installed cleanly and threw at
 * load was published anyway, while the operation reported an error.
 *
 * Deliberately end to end rather than a unit test of the certification helper: what was broken was the
 * WIRING on this thread, and a helper test cannot see that. So this drives the API, then asserts the
 * previous release still ANSWERS REQUESTS — which step 1's availability test explicitly did not cover,
 * since it sampled the component directory on disk and exercised no route.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
import { operation, readVersion } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'certified-deploy';

/** A component exposing its version over REST. `throwsAtLoad` makes its resource module throw on import. */
async function buildPayload(version: number, { throwsAtLoad = false } = {}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'certified-deploy-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: `${version}.0.0` }));
		await writeFile(join(dir, 'version.txt'), String(version));
		await writeFile(join(dir, 'config.yaml'), 'rest: true\njsResource:\n  files: resource.js\n');
		await writeFile(
			join(dir, 'resource.js'),
			throwsAtLoad
				? `throw new Error('v${version} cannot load');\n`
				: `export class Version extends Resource {\n\tget() {\n\t\treturn { version: ${version} };\n\t}\n}\n`
		);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

suite('deploy_component certifies a candidate before publishing it', (ctx: ContextWithHarper) => {
	before(async () => {
		// Certification is off by default — see `certificationEnabled` in `components/Application.ts` — so this
		// suite asks for it. Without the switch the deploys below all succeed and prove nothing.
		await startHarper(ctx, { env: { HARPER_CERTIFY_DEPLOYS: 'true' } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a candidate that throws at load is rejected, and the previous release keeps answering', async () => {
		const componentsRoot = join(ctx.harper.dataRootDir, 'components');
		const livePath = join(componentsRoot, PROJECT);

		// v1: a component that loads and serves.
		await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(1),
			restart: true,
		});
		strictEqual(await readFile(join(livePath, 'version.txt'), 'utf8'), '1', 'v1 is live');

		// v2: installs cleanly, throws the moment it is loaded.
		let rejection: string | undefined;
		try {
			await operation(ctx, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(2, { throwsAtLoad: true }),
				restart: true,
			});
		} catch (error) {
			rejection = error instanceof Error ? error.message : String(error);
		}

		// Non-2xx. The helper does not surface the response body, so the candidate's own message is asserted
		// in the unit test instead; what matters here is that the operation failed rather than reporting
		// success over a component that cannot load.
		ok(rejection, 'the deploy is reported as failed');

		// The point, and what step 1's availability test explicitly could not show: v1 still ANSWERS, not
		// merely still exists on disk.
		strictEqual(await readVersion(ctx), 1, 'v1 still answers requests');
		strictEqual(await readFile(join(livePath, 'version.txt'), 'utf8'), '1', 'and is still the live tree');
		ok(!existsSync(join(componentsRoot, '.deploy-staging')), 'and the rejected candidate was swept');
	});

	test('a candidate that loads cleanly is still published', async () => {
		// The gate has to accept as well as refuse, or the previous assertion proves only that deploys break.
		const livePath = join(ctx.harper.dataRootDir, 'components', PROJECT);
		await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(3),
			restart: true,
		});
		strictEqual(await readFile(join(livePath, 'version.txt'), 'utf8'), '3', 'v3 is published');
		strictEqual(await readVersion(ctx), 3, 'and answers requests');
	});

	test('the published tree does not carry the module link the certification load created', async () => {
		// Certifying LOADS the candidate, and every non-root load links the running install into the
		// component's `node_modules/harper` so `import 'harper'` resolves to the live instance. That link is
		// not part of what the deploy staged, and the candidate tree is renamed into the live path — so
		// without cleanup every walk of the component follows it into the whole Harper install.
		// `package_component` did exactly that and packaged the install: 46s of tarring and then
		// "Maximum response size reached".
		//
		// Deployed WITHOUT a restart deliberately: a serving worker legitimately recreates the link the next
		// time it loads the component, so the invariant is about what the DEPLOY leaves behind.
		const livePath = join(ctx.harper.dataRootDir, 'components', PROJECT);
		await operation(ctx, { operation: 'deploy_component', project: PROJECT, payload: await buildPayload(4) });
		strictEqual(await readFile(join(livePath, 'version.txt'), 'utf8'), '4', 'v4 is published');
		ok(!existsSync(join(livePath, 'node_modules', 'harper')), 'no link to the Harper install was left behind');

		// And the user-visible consequence: packaging sees the component, not the install behind the link.
		const estimate = await operation(ctx, { operation: 'package_component', project: PROJECT, estimate: true });
		ok(
			estimate.total_size < 1_000_000,
			`packaging walks only the component (got ${estimate.total_size} bytes; the install is orders of magnitude larger)`
		);
	});
});
