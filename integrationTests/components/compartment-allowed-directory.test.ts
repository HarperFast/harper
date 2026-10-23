/**
 * Under `applications.moduleLoader: compartment` with the default `allowedDirectory: app`, a component
 * cannot import a plain file outside its own directory, by relative path, absolute path or symlink, and a
 * refused component does not take the instance or its sibling components down. A CommonJS dependency
 * whose `module.exports` names are assigned dynamically supports named imports.
 *
 * On the unfixed loader the compartment `importHook` read plain files without the allowed-path check, so
 * the three escaping components loaded and served the outside file's contents, and the named import from
 * the CommonJS dependency failed with "does not provide an export named".
 *
 * Run: npm run test:integration -- "integrationTests/components/compartment-allowed-directory.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const SECRET = 'leaked-from-outside-the-component';
const ESCAPING_APPS = ['escape-relative', 'escape-absolute', 'escape-symlink'];
const ALL_APPS = [...ESCAPING_APPS, 'control', 'cjs-dependency'];

async function writeApp(componentsDir: string, name: string, files: Record<string, string>): Promise<string> {
	const appDir = join(componentsDir, name);
	await mkdir(appDir, { recursive: true });
	await writeFile(join(appDir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
	await writeFile(join(appDir, 'package.json'), JSON.stringify({ name, type: 'module' }));
	for (const [file, source] of Object.entries(files)) await writeFile(join(appDir, file), source);
	return appDir;
}

function resourceSource(className: string, imports: string, value: string): string {
	return (
		"import { Resource } from 'harper';\n" +
		imports +
		`export class ${className} extends Resource {\n` +
		'\tstatic loadAsInstance = false;\n' +
		`\tget() { return ${value}; }\n` +
		'}\n'
	);
}

async function componentStatuses(ctx: ContextWithHarper): Promise<Map<string, string>> {
	const status = await sendOperation(ctx.harper, { operation: 'get_status' });
	return new Map<string, string>(
		(status.componentStatus ?? []).map((entry: { name: string; status?: string }) => [entry.name, entry.status ?? ''])
	);
}

suite('compartment loader applies allowedDirectory to plain file imports', (ctx: ContextWithHarper) => {
	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		const componentsDir = join(dataRootDir, 'components');
		const outsideDir = join(dataRootDir, 'outside');
		const secretPath = join(outsideDir, 'secret.js');
		await mkdir(outsideDir, { recursive: true });
		await writeFile(secretPath, `export const secret = '${SECRET}';\n`);

		await writeApp(componentsDir, 'escape-relative', {
			'resources.js': resourceSource(
				'EscapeRelative',
				"import { secret } from '../../outside/secret.js';\n",
				'{ secret }'
			),
		});
		await writeApp(componentsDir, 'escape-absolute', {
			'resources.js': resourceSource(
				'EscapeAbsolute',
				`import { secret } from ${JSON.stringify(secretPath)};\n`,
				'{ secret }'
			),
		});
		const symlinkApp = await writeApp(componentsDir, 'escape-symlink', {
			'resources.js': resourceSource('EscapeSymlink', "import { secret } from './linked.js';\n", '{ secret }'),
		});
		await symlink(secretPath, join(symlinkApp, 'linked.js'));
		await writeApp(componentsDir, 'control', {
			'resources.js': resourceSource('Control', "import { inside } from './dep.js';\n", '{ inside }'),
			'dep.js': "export const inside = 'loaded-in-tree';\n",
		});

		const cjsApp = await writeApp(componentsDir, 'cjs-dependency', {
			'resources.js': resourceSource(
				'CjsDependency',
				"import dynamic, { alpha, beta } from 'dynamic-cjs';\n",
				'{ alpha, beta, viaDefault: dynamic.alpha }'
			),
		});
		const dependencyDir = join(cjsApp, 'node_modules', 'dynamic-cjs');
		await mkdir(dependencyDir, { recursive: true });
		await writeFile(
			join(dependencyDir, 'package.json'),
			JSON.stringify({ name: 'dynamic-cjs', version: '1.0.0', main: 'index.cjs' })
		);
		await writeFile(
			join(dependencyDir, 'index.cjs'),
			"module.exports = {};\nfor (const name of ['alpha', 'beta']) module.exports[name] = `${name}!`;\n"
		);

		ctx.harper = { dataRootDir };
		await startHarper(ctx, { config: { applications: { moduleLoader: 'compartment' }, threads: { count: 1 } } });

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const statuses = await componentStatuses(ctx);
			if (ALL_APPS.every((app) => ['error', 'healthy'].includes(statuses.get(`${app}.jsResource`) ?? ''))) break;
			await delay(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a component importing inside its own directory loads and serves', async () => {
		const response = await fetch(new URL('/Control', ctx.harper.httpURL));
		const body = await response.text();
		strictEqual(response.status, 200, body);
		strictEqual(JSON.parse(body).inside, 'loaded-in-tree');
	});

	test('a CommonJS dependency with dynamically assigned exports supports named imports', async () => {
		const response = await fetch(new URL('/CjsDependency', ctx.harper.httpURL));
		const body = await response.text();
		strictEqual(response.status, 200, body);
		deepStrictEqual(JSON.parse(body), { alpha: 'alpha!', beta: 'beta!', viaDefault: 'alpha!' });
	});

	for (const app of ESCAPING_APPS) {
		test(`${app} is refused and never serves the outside file`, async () => {
			const statuses = await componentStatuses(ctx);
			strictEqual(statuses.get(`${app}.jsResource`), 'error');
			const path = `/${app
				.split('-')
				.map((word) => word[0].toUpperCase() + word.slice(1))
				.join('')}`;
			const response = await fetch(new URL(path, ctx.harper.httpURL));
			const body = await response.text();
			ok(response.status !== 200, `${path} served: ${body}`);
			ok(!body.includes(SECRET), `${path} leaked the outside file: ${body}`);
		});
	}

	test('the instance log names the allowed-path refusal for each escape', async () => {
		const logDirectory = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		const instanceLog = await readFile(join(logDirectory, 'hdb.log'), 'utf8');
		const refusals = instanceLog
			.split('\n')
			.filter((line) => /Can not load module at .*secret\.js outside of allowed path/.test(line));
		ok(refusals.length >= ESCAPING_APPS.length, `expected a refusal per escaping component, got ${refusals.length}`);
	});
});
