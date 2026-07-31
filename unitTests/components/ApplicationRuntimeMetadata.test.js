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

	it('canonicalizes __proto__ as data without mutating the accumulator prototype', async function () {
		await fs.writeFile(
			path.join(this.current, 'package.json'),
			'{"name":"app","__proto__":{"polluted":true},"dependencies":"not-an-object"}\n'
		);

		const metadata = await readInstalledPackageMetadata(this.current);
		const canonicalPackage = JSON.parse(metadata.files.get('package.json').toString());
		assert.equal(Object.hasOwn(canonicalPackage, '__proto__'), true);
		assert.deepEqual(canonicalPackage.__proto__, { polluted: true });
		assert.equal(metadata.hasInstallableDependencies, false);
	});
});
