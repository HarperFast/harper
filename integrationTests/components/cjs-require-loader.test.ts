/**
 * CommonJS require() in a component loaded by the VM module loaders follows the same rules as import:
 * dependencyLoader routing, TypeScript stripping, a filesystem __filename, allowedDirectory,
 * allowedBuiltInModules and the constrained child_process.
 *
 * Run: npm run test:integration -- "integrationTests/components/cjs-require-loader.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader } from '../deploy/redeploy-restart-flag-helpers.ts';

type ProbeResult = {
	vmLoaded: boolean;
	sameInstanceAsImport: boolean;
	markerFromAppRealm: boolean;
	typed: string;
	filename: string;
	dirname: string;
	siblingFilename: string;
	filenameReadable: boolean | string;
	outside: string;
	disallowedBuiltin: string;
	execSync: string;
};

async function writeFixture(parentDirectory: string): Promise<string> {
	const appDirectory = join(parentDirectory, 'cjs-require-loader-app');
	const dependencyDirectory = join(appDirectory, 'node_modules', 'loader-probe');
	const outsidePath = join(parentDirectory, 'outside.cjs');
	await mkdir(dependencyDirectory, { recursive: true });
	await writeFile(outsidePath, 'module.exports = { loaded: true };\n');
	await writeFile(join(appDirectory, 'config.yaml'), 'jsResource:\n  files: resources.cjs\nrest: true\n');
	await writeFile(
		join(appDirectory, 'package.json'),
		JSON.stringify({ name: 'cjs-require-loader-app', dependencies: { 'loader-probe': '1.0.0' } })
	);
	await writeFile(
		join(dependencyDirectory, 'package.json'),
		JSON.stringify({ name: 'loader-probe', version: '1.0.0', main: 'index.js' })
	);
	await writeFile(join(dependencyDirectory, 'index.js'), 'module.exports = { marker: {} };\n');
	await writeFile(
		join(appDirectory, 'typed.ts'),
		"interface Shape { value: string }\nconst shape: Shape = { value: 'stripped' };\nmodule.exports = shape;\n"
	);
	await writeFile(
		join(appDirectory, 'sibling.mjs'),
		"import { fileURLToPath } from 'node:url';\nexport const filename = fileURLToPath(import.meta.url);\n"
	);
	await writeFile(
		join(appDirectory, 'resources.cjs'),
		`const { Resource } = require('harper');
const { readFileSync } = require('node:fs');
const probe = require('loader-probe');
const outcome = (load) => {
	try {
		return load();
	} catch (error) {
		return error.message;
	}
};
class CjsRequireProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		const imported = await import('loader-probe');
		const sibling = await import('./sibling.mjs');
		return {
			vmLoaded: require.cache === undefined,
			sameInstanceAsImport: imported.default === probe,
			markerFromAppRealm: probe.marker instanceof Object,
			typed: outcome(() => require('./typed.ts').value),
			filename: __filename,
			dirname: __dirname,
			siblingFilename: sibling.filename,
			filenameReadable: outcome(() => readFileSync(__filename, 'utf8').includes('CjsRequireProbe')),
			outside: outcome(() => require(${JSON.stringify(outsidePath)}) && 'loaded'),
			disallowedBuiltin: outcome(() => require('node:os') && 'loaded'),
			execSync: outcome(() => require('child_process').execSync('exit 0') && 'ran'),
		};
	}
}
module.exports = { CjsRequireProbe };
`
	);
	return appDirectory;
}

async function getProbe(ctx: ContextWithHarper): Promise<ProbeResult> {
	const deadline = Date.now() + 30_000;
	let status = 0;
	let body = '';
	while (Date.now() < deadline) {
		let response: Response;
		try {
			response = await fetch(`${ctx.harper.httpURL}/CjsRequireProbe`, {
				headers: { Authorization: authHeader(ctx) },
				signal: AbortSignal.timeout(5_000),
			});
		} catch {
			await sleep(250);
			continue;
		}
		status = response.status;
		if (status === 200) return (await response.json()) as ProbeResult;
		body = await response.text();
		await sleep(250);
	}
	strictEqual(status, 200, `CjsRequireProbe never became reachable: ${body}`);
	throw new Error('unreachable');
}

for (const [moduleLoader, dependencyLoader] of [
	['vm', 'native'],
	['vm-current-context', 'native'],
	['vm-current-context', 'auto'],
] as const) {
	suite(
		`CommonJS require (moduleLoader: ${moduleLoader}, dependencyLoader: ${dependencyLoader})`,
		(ctx: ContextWithHarper) => {
			let fixtureParent: string;
			let probe: ProbeResult;

			before(async () => {
				fixtureParent = await realpath(await mkdtemp(join(tmpdir(), 'cjs-require-loader-')));
				await setupHarperWithFixture(ctx, await writeFixture(fixtureParent), {
					config: {
						applications: {
							moduleLoader,
							dependencyLoader,
							allowedDirectory: 'app',
							allowedBuiltInModules: ['fs', 'url', 'child_process'],
						},
					},
				});
				probe = await getProbe(ctx);
			});

			after(async () => {
				try {
					await teardownHarper(ctx);
				} finally {
					if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
				}
			});

			test('loads the component through the VM loader', () => {
				strictEqual(probe.vmLoaded, true);
			});

			test('requires a dependency natively, sharing the instance import() returns', () => {
				strictEqual(probe.sameInstanceAsImport, true);
			});

			test('a natively required dependency builds its objects in the main realm', () => {
				strictEqual(probe.markerFromAppRealm, moduleLoader === 'vm-current-context');
			});

			test('strips TypeScript types from a required .ts file', () => {
				strictEqual(probe.typed, 'stripped');
			});

			test('passes filesystem paths as __filename and __dirname', () => {
				strictEqual(probe.dirname, join(probe.siblingFilename, '..'));
				strictEqual(probe.filename, join(probe.dirname, 'resources.cjs'));
				strictEqual(probe.filenameReadable, true);
			});

			test('applies allowedDirectory, allowedBuiltInModules and the child_process substitute', () => {
				ok(probe.outside.includes('outside of allowed path'), probe.outside);
				strictEqual(probe.disallowedBuiltin, 'Module node:os is not allowed to be imported');
				strictEqual(probe.execSync, 'execSync is not allowed');
			});

			test('keeps serving after the rejected requires', async () => {
				deepStrictEqual(await getProbe(ctx), probe);
			});
		}
	);
}
