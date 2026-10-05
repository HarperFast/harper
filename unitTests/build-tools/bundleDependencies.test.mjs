import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundlePlan, checkBundle, prepareBundle } from '../../build-tools/bundleDependencies.ts';

describe('portable production dependency bundle', function () {
	this.timeout(120_000);
	let directory;
	let source;
	let lock;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'harper-bundle-'));
		source = join(directory, 'source');
		mkdirSync(source);
		lock = {
			name: 'harper-bundle-fixture',
			version: '1.0.0',
			lockfileVersion: 3,
			packages: {
				'': { name: 'harper-bundle-fixture', version: '1.0.0', dependencies: { parent: '^1.0.0' } },
				'node_modules/parent': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
				'node_modules/child': { version: '1.0.1' },
			},
		};
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function writeSource() {
		const root = { ...lock.packages[''], files: ['index.js'], devDependencies: { 'dev-only': '^1.0.0' } };
		writeFileSync(join(source, 'package.json'), JSON.stringify(root));
		writeFileSync(join(source, 'package-lock.json'), JSON.stringify(lock));
		writeFileSync(join(source, 'index.js'), "module.exports = require('parent');\n");
		for (const [key, value] of Object.entries(lock.packages)) {
			if (!key) continue;
			const name = key.split('node_modules/').at(-1);
			mkdirSync(join(source, key), { recursive: true });
			writeFileSync(join(source, key, 'package.json'), JSON.stringify({ name, main: 'index.js', ...value }));
			writeFileSync(join(source, key, 'index.js'), `module.exports = ${JSON.stringify(value.version)};\n`);
		}
		writeFileSync(join(source, 'node_modules/parent/index.js'), "module.exports = require('child');\n");
	}
	function prepare() {
		writeSource();
		return prepareBundle(source, join(directory, 'stage'));
	}

	it('preserves locked versions through a real pack, consumer install and offline npm ci', () => {
		const stage = prepare();
		assert.deepStrictEqual(checkBundle(stage, join(source, 'package-lock.json')), { roots: 1, packages: 2 });
		const packed = JSON.parse(
			execFileSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', directory], {
				encoding: 'utf8',
				timeout: 60_000,
			})
		);
		const consumer = join(directory, 'consumer');
		mkdirSync(consumer);
		writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
		const options = { cwd: consumer, encoding: 'utf8', timeout: 60_000 };
		execFileSync(
			'npm',
			['install', join(directory, packed[0].filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
			options
		);
		rmSync(join(consumer, 'node_modules'), { recursive: true });
		execFileSync('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], options);
		const installed = join(consumer, 'node_modules/harper-bundle-fixture');
		checkBundle(installed, join(source, 'package-lock.json'), true);
		assert.strictEqual(
			execFileSync(process.execPath, ['-e', "console.log(require('harper-bundle-fixture'))"], options).trim(),
			'1.0.1'
		);
		const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
		assert.ok(!manifest.devDependencies);
		assert.ok(!readFileSync(join(source, 'package.json'), 'utf8').includes('bundleDependencies'));
	});

	it('preserves nested copies instead of substituting the hoisted dependency', () => {
		lock.packages['node_modules/parent'].dependencies.child = '^2.0.0';
		lock.packages['node_modules/parent/node_modules/child'] = { version: '2.0.0' };
		const stage = prepare();
		assert.strictEqual(checkBundle(stage, join(source, 'package-lock.json')).packages, 2);
		assert.strictEqual(
			JSON.parse(readFileSync(join(stage, 'node_modules/parent/node_modules/child/package.json'))).version,
			'2.0.0'
		);
	});

	it('severs unused optional declarations in copied manifests and preserves the source and shared children', () => {
		lock.packages['node_modules/parent'].optionalDependencies = { 'react-native-fs': '^2.0.0' };
		lock.packages['node_modules/parent'].peerDependencies = { 'utf-8-validate': '*' };
		lock.packages['node_modules/parent'].peerDependenciesMeta = { 'utf-8-validate': { optional: true } };
		lock.packages['node_modules/react-native-fs'] = { version: '2.0.0', dependencies: { child: '^1.0.0' } };
		lock.packages['node_modules/utf-8-validate'] = { version: '6.0.0', hasInstallScript: true };
		const stage = prepare();
		const original = JSON.parse(readFileSync(join(source, 'node_modules/parent/package.json')));
		const copied = JSON.parse(readFileSync(join(stage, 'node_modules/parent/package.json')));
		assert.ok(original.optionalDependencies['react-native-fs']);
		assert.ok(!copied.optionalDependencies['react-native-fs']);
		assert.ok(!copied.peerDependencies['utf-8-validate']);
		assert.strictEqual(checkBundle(stage, join(source, 'package-lock.json')).packages, 2);
	});

	it('preserves explicit producers and fails rather than severing a required native dependency', () => {
		lock.packages['node_modules/parent'].dependencies['utf-8-validate'] = '^6.0.0';
		lock.packages['node_modules/parent'].peerDependencies = { 'utf-8-validate': '*' };
		lock.packages['node_modules/parent'].peerDependenciesMeta = { 'utf-8-validate': { optional: true } };
		lock.packages['node_modules/utf-8-validate'] = { version: '6.0.0', hasInstallScript: true };
		assert.throws(() => bundlePlan(lock), /Cannot bundle native.*utf-8-validate/);
	});

	it('keeps native and shared roots out of the bundle with exact release pins', () => {
		lock.packages[''].dependencies['ordered-binary'] = '^1.6.0';
		lock.packages[''].optionalDependencies = { 'native-fixture': '^1.0.0' };
		lock.packages['node_modules/ordered-binary'] = { version: '1.6.2' };
		lock.packages['node_modules/native-fixture'] = { version: '1.0.0', os: ['linux'] };
		const stage = prepare();
		const manifest = JSON.parse(readFileSync(join(stage, 'package.json')));
		assert.strictEqual(manifest.dependencies['ordered-binary'], '1.6.2');
		assert.strictEqual(manifest.optionalDependencies['native-fixture'], '1.0.0');
		assert.deepStrictEqual(manifest.bundleDependencies, ['parent']);
		assert.strictEqual(checkBundle(stage, join(source, 'package-lock.json')).packages, 2);
	});

	it('preserves a required peer even when the same React Native name is optional elsewhere', () => {
		lock.packages['node_modules/parent'].optionalDependencies = { 'react-native-fs': '^2.0.0' };
		lock.packages['node_modules/parent'].peerDependencies = { 'react-native-fs': '*' };
		lock.packages['node_modules/react-native-fs'] = { version: '2.0.0', hasInstallScript: true };
		assert.throws(() => bundlePlan(lock), /Cannot bundle native.*react-native-fs/);
	});

	it('fails when a bundled root would pull a shared storage module back into the archive', () => {
		lock.packages['node_modules/parent'].dependencies['ordered-binary'] = '^1.6.0';
		lock.packages['node_modules/ordered-binary'] = { version: '1.6.2' };
		assert.throws(() => bundlePlan(lock), /intentionally unbundled dependency.*ordered-binary/);
	});

	for (const field of ['os', 'cpu', 'libc', 'gypfile', 'hasInstallScript']) {
		it(`rejects a foreign-platform optional transitive marked ${field} even when it is not installed`, () => {
			lock.packages['node_modules/parent'].optionalDependencies = { child: '^1.0.0' };
			delete lock.packages['node_modules/parent'].dependencies;
			lock.packages['node_modules/child'][field] =
				field === 'gypfile' || field === 'hasInstallScript' ? true : ['foreign'];
			assert.throws(() => bundlePlan(lock), /Cannot bundle native.*child/);
		});
	}

	for (const hook of ['preinstall', 'install', 'postinstall']) {
		it(`rejects a bundled ${hook} hook even without native metadata in the lock`, () => {
			writeSource();
			const file = join(source, 'node_modules/child/package.json');
			const manifest = JSON.parse(readFileSync(file));
			manifest.scripts = { [hook]: 'node download.js' };
			writeFileSync(file, JSON.stringify(manifest));
			assert.throws(() => prepareBundle(source, join(directory, 'stage')), /Cannot bundle native.*child/);
		});
	}

	for (const [file, contents] of [
		['addon.node', Buffer.from('addon')],
		['addon.bare', Buffer.from('addon')],
		['binding.gyp', Buffer.from('{}')],
		['hermesc', Buffer.from('7f454c46', 'hex')],
		['mach-o', Buffer.from('cffaedfe', 'hex')],
		['mach-o-fat64', Buffer.from('cafebabf', 'hex')],
		['windows', Buffer.from('MZ\0\0')],
	]) {
		it(`rejects native content ${file}`, () => {
			writeSource();
			writeFileSync(join(source, 'node_modules/child', file), contents);
			assert.throws(() => prepareBundle(source, join(directory, 'stage')), /Cannot bundle native/);
		});
	}

	it('rejects an unresolved optional dependency rather than leaving a floating install edge', () => {
		lock.packages['node_modules/parent'].optionalDependencies = { absent: '^1.0.0' };
		assert.throws(() => bundlePlan(lock), /Missing locked dependency.*absent/);
	});

	it('rejects installed version drift before copying dependencies', () => {
		writeSource();
		writeFileSync(join(source, 'node_modules/child/package.json'), JSON.stringify({ name: 'child', version: '1.0.2' }));
		assert.throws(() => prepareBundle(source, join(directory, 'stage')), /Installed.*child differs/);
	});

	it('fails a deliberately corrupted archive instead of comparing installer output with itself', () => {
		const stage = prepare();
		writeFileSync(join(stage, 'node_modules/child/package.json'), JSON.stringify({ name: 'child', version: '1.0.2' }));
		assert.throws(() => checkBundle(stage, join(source, 'package-lock.json')), /Bundled.*child differs/);
	});

	it('rejects unexpected packages in the actual archive', () => {
		const stage = prepare();
		const file = join(stage, 'node_modules/extra/package.json');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ name: 'extra', version: '1.0.0' }));
		assert.throws(() => checkBundle(stage, join(source, 'package-lock.json')), /Unexpected bundled package/);
	});

	it('rejects a source manifest that no longer matches the checked lock', () => {
		const stage = prepare();
		const file = join(stage, 'package.json');
		const manifest = JSON.parse(readFileSync(file));
		manifest.dependencies.parent = '^2.0.0';
		writeFileSync(file, JSON.stringify(manifest));
		assert.throws(() => checkBundle(stage, join(source, 'package-lock.json')), /parent declaration differs/);
	});

	it('clears an earlier stage before rebuilding it', () => {
		const stage = prepare();
		writeFileSync(join(stage, 'stale'), 'stale');
		const fresh = prepareBundle(source, join(directory, 'stage'));
		assert.throws(() => readFileSync(join(fresh, 'stale')), /ENOENT/);
	});

	it('rejects an unsupported lock layout and an unsafe destination', () => {
		writeSource();
		assert.throws(() => prepareBundle(source, source), /destination must not contain/);
		writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 2 }));
		assert.throws(() => prepareBundle(source, join(directory, 'stage')), /Expected lockfileVersion 3/);
	});
});
