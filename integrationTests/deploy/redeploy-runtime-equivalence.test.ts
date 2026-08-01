import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader, getRestartRequired, operation } from './redeploy-restart-flag-helpers.ts';

const RELATIVE_PROJECT = 'redeploy-relative-runtime-app';
const PACKAGE_IMPORT_PROJECT = 'redeploy-package-import-runtime-app';
const PACKAGE_METADATA_PROJECT = 'redeploy-package-metadata-app';
const RESOLUTION_PROJECT = 'redeploy-resolution-runtime-app';
const PURE_ESM_PROJECT = 'redeploy-pure-esm-runtime-app';

async function buildRuntimePayload(className: string, version: number, packageImport: boolean): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'redeploy-runtime-equivalence-'));
	try {
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		if (packageImport) {
			await writeFile(
				join(directory, 'package.json'),
				JSON.stringify({
					name: PACKAGE_IMPORT_PROJECT,
					version: '1.0.0',
					type: 'module',
					imports: { '#helper': './helper.js' },
				}) + '\n'
			);
			await writeFile(
				join(directory, 'package-lock.json'),
				JSON.stringify({
					name: PACKAGE_IMPORT_PROJECT,
					version: '1.0.0',
					lockfileVersion: 3,
					requires: true,
					packages: { '': { name: PACKAGE_IMPORT_PROJECT, version: '1.0.0' } },
				}) + '\n'
			);
		}
		await writeFile(
			join(directory, 'resources.js'),
			`import { VERSION } from '${packageImport ? '#helper' : './helper.js'}';\n` +
				`export class ${className} extends Resource {\n` +
				'\tstatic loadAsInstance = false;\n' +
				'\tget() { return { version: VERSION }; }\n' +
				'}\n'
		);
		await writeFile(join(directory, 'helper.js'), `export const VERSION = ${version};\n`);
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function buildResolutionPayload(addJavaScriptCandidate: boolean): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'redeploy-runtime-resolution-'));
	try {
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(join(directory, 'package.json'), '{"name":"redeploy-resolution-runtime-app","type":"module"}\n');
		await writeFile(
			join(directory, 'resources.js'),
			"import helper from './helper';\n" +
				'export class ResolutionVersion extends Resource {\n' +
				'\tstatic loadAsInstance = false;\n' +
				'\tget() { return { version: helper.VERSION }; }\n' +
				'}\n'
		);
		await writeFile(join(directory, 'helper.json'), '{"VERSION":1}\n');
		if (addJavaScriptCandidate) await writeFile(join(directory, 'helper.js'), 'export default { VERSION: 2 };\n');
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function buildPureESMPayload(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'redeploy-pure-esm-'));
	try {
		const dependencyDirectory = join(directory, 'vendor', 'pure-esm-probe');
		const rootPackage = {
			name: PURE_ESM_PROJECT,
			version: '1.0.0',
			type: 'module',
			dependencies: { 'pure-esm-probe': 'file:vendor/pure-esm-probe' },
		};
		const dependencyPackage = {
			name: 'pure-esm-probe',
			version: '1.0.0',
			type: 'module',
			exports: { '.': { import: './index.js' } },
		};
		await mkdir(dependencyDirectory, { recursive: true });
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(
			join(directory, 'resources.js'),
			"import { VERSION } from 'pure-esm-probe';\n" +
				'export class PureESMVersion extends Resource {\n' +
				'\tstatic loadAsInstance = false;\n' +
				'\tget() { return { version: VERSION }; }\n' +
				'}\n'
		);
		await writeFile(join(directory, 'package.json'), JSON.stringify(rootPackage) + '\n');
		await writeFile(join(dependencyDirectory, 'package.json'), JSON.stringify(dependencyPackage) + '\n');
		await writeFile(join(dependencyDirectory, 'index.js'), 'export const VERSION = 1;\n');
		await writeFile(
			join(directory, 'package-lock.json'),
			JSON.stringify({
				name: PURE_ESM_PROJECT,
				version: '1.0.0',
				lockfileVersion: 3,
				requires: true,
				packages: {
					'': rootPackage,
					'node_modules/pure-esm-probe': { resolved: 'vendor/pure-esm-probe', link: true },
					'vendor/pure-esm-probe': dependencyPackage,
				},
			}) + '\n'
		);
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function buildPackageMetadataPayload(dependencyVersion: number, prettyPackageJSON: boolean): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'redeploy-package-metadata-'));
	try {
		const dependencyDirectory = `probe-dependency-v${dependencyVersion}`;
		const dependencySpecifier = `file:vendor/${dependencyDirectory}`;
		const rootPackage = prettyPackageJSON
			? {
					dependencies: { 'probe-dependency': dependencySpecifier },
					type: 'module',
					version: '1.0.0',
					name: PACKAGE_METADATA_PROJECT,
				}
			: {
					name: PACKAGE_METADATA_PROJECT,
					version: '1.0.0',
					type: 'module',
					dependencies: { 'probe-dependency': dependencySpecifier },
				};
		const dependencyPackage = { name: 'probe-dependency', version: `${dependencyVersion}.0.0` };

		await mkdir(join(directory, 'vendor', dependencyDirectory), { recursive: true });
		await writeFile(join(directory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
		await writeFile(
			join(directory, 'resources.js'),
			'export class MetadataVersion extends Resource {\n' +
				'\tstatic loadAsInstance = false;\n' +
				'\tget() { return { version: 1 }; }\n' +
				'}\n'
		);
		await writeFile(
			join(directory, 'package.json'),
			JSON.stringify(rootPackage, null, prettyPackageJSON ? 2 : undefined) + '\n'
		);
		await writeFile(
			join(directory, 'vendor', dependencyDirectory, 'package.json'),
			JSON.stringify(dependencyPackage) + '\n'
		);
		await writeFile(
			join(directory, 'package-lock.json'),
			JSON.stringify({
				name: PACKAGE_METADATA_PROJECT,
				version: '1.0.0',
				lockfileVersion: 3,
				requires: true,
				packages: {
					'': rootPackage,
					'node_modules/probe-dependency': { resolved: `vendor/${dependencyDirectory}`, link: true },
					[`vendor/${dependencyDirectory}`]: dependencyPackage,
				},
			}) + '\n'
		);
		return await targz(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function readResourceVersion(ctx: ContextWithHarper, resourceName: string): Promise<number | undefined> {
	try {
		const response = await fetch(`${ctx.harper.httpURL}/${resourceName}`, {
			headers: { Authorization: authHeader(ctx) },
		});
		if (response.status !== 200) {
			await response.body?.cancel();
			return;
		}
		return ((await response.json()) as { version?: number } | null)?.version;
	} catch {
		return;
	}
}

async function waitForVersion(ctx: ContextWithHarper, resourceName: string, version: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if ((await readResourceVersion(ctx, resourceName)) === version) return;
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${resourceName} version ${version}`);
}

async function waitForRestartRequired(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await getRestartRequired(ctx)) return;
		await sleep(250);
	}
	throw new Error('Timed out waiting for restartRequired');
}

suite('Redeploy runtime-equivalence proof', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('loads a resource with an unwatched relative helper', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: RELATIVE_PROJECT,
			payload: await buildRuntimePayload('RelativeVersion', 1, false),
			restart: true,
		});
		await waitForVersion(ctx, 'RelativeVersion', 1);
	});

	test('an identical redeploy remains restart-free', async () => {
		strictEqual(await getRestartRequired(ctx), false);
		await operation(ctx, {
			operation: 'deploy_component',
			project: RELATIVE_PROJECT,
			payload: await buildRuntimePayload('RelativeVersion', 1, false),
			restart: false,
		});
		await sleep(2_000);
		strictEqual(await getRestartRequired(ctx), false);
		strictEqual(await readResourceVersion(ctx, 'RelativeVersion'), 1);
	});

	test('changing only an unwatched relative helper requests restart', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: RELATIVE_PROJECT,
			payload: await buildRuntimePayload('RelativeVersion', 2, false),
			restart: false,
		});
		await waitForRestartRequired(ctx);
		strictEqual(await readResourceVersion(ctx, 'RelativeVersion'), 1);
	});

	test('loads an app-local package import', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: PACKAGE_IMPORT_PROJECT,
			payload: await buildRuntimePayload('PackageImportVersion', 1, true),
			restart: true,
		});
		await waitForVersion(ctx, 'PackageImportVersion', 1);
	});

	test('changing only an app-local package-import helper requests restart', async () => {
		strictEqual(await getRestartRequired(ctx), false);
		await operation(ctx, {
			operation: 'deploy_component',
			project: PACKAGE_IMPORT_PROJECT,
			payload: await buildRuntimePayload('PackageImportVersion', 2, true),
			restart: false,
		});
		await waitForRestartRequired(ctx);
		strictEqual(await readResourceVersion(ctx, 'PackageImportVersion'), 1);
	});

	test('loads an extensionless import through its initial JSON candidate', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: RESOLUTION_PROJECT,
			payload: await buildResolutionPayload(false),
			restart: true,
		});
		await waitForVersion(ctx, 'ResolutionVersion', 1);
	});

	test('adding a higher-priority resolution candidate requests restart', async () => {
		strictEqual(await getRestartRequired(ctx), false);
		await operation(ctx, {
			operation: 'deploy_component',
			project: RESOLUTION_PROJECT,
			payload: await buildResolutionPayload(true),
			restart: false,
		});
		await waitForRestartRequired(ctx);
		strictEqual(await readResourceVersion(ctx, 'ResolutionVersion'), 1);
	});

	test('loads a dependency with import-only package exports', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: PURE_ESM_PROJECT,
			payload: await buildPureESMPayload(),
			restart: true,
		});
		await waitForVersion(ctx, 'PureESMVersion', 1);
	});

	test('an identical import-only dependency redeploy remains restart-free', async () => {
		strictEqual(await getRestartRequired(ctx), false);
		await operation(ctx, {
			operation: 'deploy_component',
			project: PURE_ESM_PROJECT,
			payload: await buildPureESMPayload(),
			restart: false,
		});
		await sleep(2_000);
		strictEqual(await getRestartRequired(ctx), false);
		strictEqual(await readResourceVersion(ctx, 'PureESMVersion'), 1);
	});

	test('loads a component with deterministic dependency metadata', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: PACKAGE_METADATA_PROJECT,
			payload: await buildPackageMetadataPayload(1, false),
			restart: true,
		});
		await waitForVersion(ctx, 'MetadataVersion', 1);
	});

	test('package.json formatting and key order remain restart-free', async () => {
		strictEqual(await getRestartRequired(ctx), false);
		await operation(ctx, {
			operation: 'deploy_component',
			project: PACKAGE_METADATA_PROJECT,
			payload: await buildPackageMetadataPayload(1, true),
			restart: false,
		});
		await sleep(2_000);
		strictEqual(await getRestartRequired(ctx), false);
	});

	test('a changed installed dependency requests restart', async () => {
		await operation(ctx, {
			operation: 'deploy_component',
			project: PACKAGE_METADATA_PROJECT,
			payload: await buildPackageMetadataPayload(2, true),
			restart: false,
		});
		await waitForRestartRequired(ctx);
		ok(await getRestartRequired(ctx));
	});
});
