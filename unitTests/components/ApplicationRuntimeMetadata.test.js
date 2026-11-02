'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	installedPackageMetadataEqual,
	installedRuntimeChanged,
	readInstalledPackageMetadata,
} = require('#src/components/Application');

describe('installed application runtime metadata', () => {
	beforeEach(async function () {
		this.previous = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-metadata-previous-'));
		this.current = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-metadata-current-'));
	});

	afterEach(async function () {
		await Promise.all([
			fs.rm(this.previous, { recursive: true, force: true }),
			fs.rm(this.current, { recursive: true, force: true }),
		]);
	});

	it('normalizes package.json formatting and key order', async function () {
		await fs.writeFile(
			path.join(this.previous, 'package.json'),
			'{"version":"1.0.0","dependencies":{"second":"2","first":"1"},"name":"app"}\n'
		);
		await fs.writeFile(
			path.join(this.current, 'package.json'),
			JSON.stringify(
				{
					name: 'app',
					dependencies: { first: '1', second: '2' },
					version: '1.0.0',
				},
				null,
				2
			)
		);
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package-lock.json'), '{"lockfileVersion":3}\n'),
			fs.writeFile(path.join(this.current, 'package-lock.json'), '{"lockfileVersion":3}\n'),
		]);

		const previous = await readInstalledPackageMetadata(this.previous);
		const current = await readInstalledPackageMetadata(this.current);
		assert.equal(installedPackageMetadataEqual(previous, current), true);
		assert.equal(installedRuntimeChanged(previous, current, false), false);
	});

	it('treats reordered exports/imports conditions as a runtime change, but not whitespace alone', async function () {
		const manifest = {
			name: 'app',
			version: '1.0.0',
			exports: {
				'.': { node: './node.js', default: './default.js' },
				'./sub': { import: { types: './sub.d.ts', default: './sub.js' }, require: './sub.cjs' },
			},
			imports: { '#dep': { node: './dep-node.js', default: './dep-default.js' } },
		};
		await fs.writeFile(path.join(this.previous, 'package.json'), JSON.stringify(manifest));

		await fs.writeFile(path.join(this.current, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			false,
			'whitespace-only reformatting must not report a runtime change'
		);

		const reorderedExports = structuredClone(manifest);
		reorderedExports.exports['.'] = { default: './default.js', node: './node.js' };
		await fs.writeFile(path.join(this.current, 'package.json'), JSON.stringify(reorderedExports));
		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			true,
			'reordering a top-level exports condition changes first-match resolution'
		);

		const reorderedNestedExports = structuredClone(manifest);
		reorderedNestedExports.exports['./sub'].import = { default: './sub.js', types: './sub.d.ts' };
		await fs.writeFile(path.join(this.current, 'package.json'), JSON.stringify(reorderedNestedExports));
		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			true,
			'reordering a nested condition map changes first-match resolution'
		);

		const reorderedImports = structuredClone(manifest);
		reorderedImports.imports['#dep'] = { default: './dep-default.js', node: './dep-node.js' };
		await fs.writeFile(path.join(this.current, 'package.json'), JSON.stringify(reorderedImports));
		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			true,
			'reordering an imports condition changes first-match resolution'
		);
	});

	it('detects reordering of a condition map inside a root exports array fallback', async function () {
		const manifest = {
			name: 'app',
			exports: [{ node: './node.js', default: './default.js' }, './legacy.js'],
		};
		await fs.writeFile(path.join(this.previous, 'package.json'), JSON.stringify(manifest));

		const reordered = structuredClone(manifest);
		reordered.exports[0] = { default: './default.js', node: './node.js' };
		await fs.writeFile(path.join(this.current, 'package.json'), JSON.stringify(reordered));

		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			true
		);
	});

	it('compares generated lock evidence after installation', async function () {
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package.json'), '{"name":"app"}\n'),
			fs.writeFile(path.join(this.current, 'package.json'), '{"name":"app"}\n'),
			fs.writeFile(path.join(this.previous, 'package-lock.json'), '{"packages":{"node_modules/x":{"version":"1"}}}\n'),
			fs.writeFile(path.join(this.current, 'package-lock.json'), '{"packages":{"node_modules/x":{"version":"2"}}}\n'),
		]);

		assert.equal(
			installedRuntimeChanged(
				await readInstalledPackageMetadata(this.previous),
				await readInstalledPackageMetadata(this.current),
				false
			),
			true
		);
	});

	it('fails closed for dependency installs without lock evidence or with opaque scripts', async function () {
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package.json'), '{"name":"app","dependencies":{"x":"1"}}\n'),
			fs.writeFile(path.join(this.current, 'package.json'), '{"name":"app","dependencies":{"x":"1"}}\n'),
		]);
		const previous = await readInstalledPackageMetadata(this.previous);
		const current = await readInstalledPackageMetadata(this.current);

		assert.equal(installedPackageMetadataEqual(previous, current), true);
		assert.equal(
			installedRuntimeChanged(previous, current, false),
			true,
			'an unlocked install is not reproducible evidence'
		);
		assert.equal(installedRuntimeChanged(previous, current, true), true, 'custom scripts make the install opaque');
	});

	it('does not require lock evidence for development-only dependencies omitted from production installs', async function () {
		const manifest = '{"name":"app","devDependencies":{"build-tool":"1"}}\n';
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package.json'), manifest),
			fs.writeFile(path.join(this.current, 'package.json'), manifest),
		]);
		const previous = await readInstalledPackageMetadata(this.previous);
		const current = await readInstalledPackageMetadata(this.current);

		assert.equal(previous.hasInstallableDependencies, false);
		assert.equal(installedRuntimeChanged(previous, current, false), false);
	});

	it('requires lock evidence for workspace production installs', async function () {
		const manifest = '{"name":"app","workspaces":{"packages":["packages/*"]}}\n';
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package.json'), manifest),
			fs.writeFile(path.join(this.current, 'package.json'), manifest),
		]);
		const previous = await readInstalledPackageMetadata(this.previous);
		const current = await readInstalledPackageMetadata(this.current);

		assert.equal(previous.hasInstallableDependencies, true);
		assert.equal(installedRuntimeChanged(previous, current, false), true);
	});

	it('requires lock evidence when an explicit non-npm manager may discover external workspace work', async function () {
		const manifest = '{"name":"app","devEngines":{"packageManager":{"name":"pnpm"}}}\n';
		await Promise.all([
			fs.writeFile(path.join(this.previous, 'package.json'), manifest),
			fs.writeFile(path.join(this.current, 'package.json'), manifest),
		]);
		const previous = await readInstalledPackageMetadata(this.previous);
		const current = await readInstalledPackageMetadata(this.current);

		assert.equal(previous.hasInstallableDependencies, true);
		assert.equal(installedRuntimeChanged(previous, current, false), true);
	});

	it('canonicalizes __proto__ as data without mutating the accumulator prototype', async function () {
		await fs.writeFile(
			path.join(this.current, 'package.json'),
			'{"name":"app","__proto__":{"polluted":true},"dependencies":"not-an-object"}\n'
		);

		const metadata = await readInstalledPackageMetadata(this.current);
		const canonicalPackage = JSON.parse(metadata.files.get('package.json').toString());
		assert.equal(Object.hasOwn(canonicalPackage, '__proto__'), true);
		assert.deepEqual(canonicalPackage.__proto__, { polluted: true });
		assert.equal(metadata.hasInstallableDependencies, true);
	});
});
