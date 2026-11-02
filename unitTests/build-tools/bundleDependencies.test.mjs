import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

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

	for (const flags of [[], ['--preserve-symlinks-main']]) {
		it(`checks a corrupt archive through a linked CLI path ${flags.join(' ')}`, () => {
			const stage = prepare();
			const linked = join(directory, 'linked-tools');
			symlinkSync(fileURLToPath(new URL('../../build-tools/', import.meta.url)), linked, 'junction');
			const file = join(stage, 'node_modules/parent/package.json');
			const manifest = JSON.parse(readFileSync(file));
			manifest.version = '9.9.9';
			writeFileSync(file, JSON.stringify(manifest));
			assert.throws(
				() =>
					execFileSync(
						process.execPath,
						[...flags, join(linked, 'bundleDependencies.ts'), 'check', stage, join(source, 'package-lock.json')],
						{ encoding: 'utf8', stdio: 'pipe' }
					),
				(error) =>
					error.status !== 0 && error.stderr.includes('Bundled node_modules/parent differs from package-lock.json')
			);
		});
	}
	it('can be imported by a Node program reading stdin', () => {
		const helper = new URL('../../build-tools/bundleDependencies.ts', import.meta.url);
		const output = execFileSync(process.execPath, ['--input-type=module', '-'], {
			input: `import { bundlePlan } from ${JSON.stringify(helper.href)}; console.log(typeof bundlePlan);`,
			encoding: 'utf8',
			stdio: 'pipe',
		});
		assert.strictEqual(output.trim(), 'function');
	});

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
			[
				'install',
				join(directory, (Array.isArray(packed) ? packed[0] : packed[lock.packages[''].name]).filename),
				'--ignore-scripts',
				'--offline',
				'--no-audit',
				'--no-fund',
			],
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

	it('leaves optional-only peers externally supplied even when the development lock contains them', () => {
		lock.packages['node_modules/parent'].peerDependencies = { 'native-peer': '^1.0.0' };
		lock.packages['node_modules/parent'].peerDependenciesMeta = { 'native-peer': { optional: true } };
		lock.packages['node_modules/native-peer'] = { version: '1.0.0', os: ['foreign'] };
		const stage = prepare();
		assert.strictEqual(checkBundle(stage, join(source, 'package-lock.json')).packages, 2);
		assert.ok(!bundlePlan(lock).packages.has('node_modules/native-peer'));
	});

	for (const name of ['re2', '@datadog/pprof']) {
		it(`keeps harper-pro native root ${name} outside the archive with an exact pin`, () => {
			lock.packages[''].dependencies[name] = '^1.0.0';
			const nativeRoot = `node_modules/${name}`;
			lock.packages[nativeRoot] = { version: '1.0.1', hasInstallScript: true };
			writeSource();
			writeFileSync(join(source, nativeRoot, 'binding.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
			const stage = prepareBundle(source, join(directory, 'stage'));
			const manifest = JSON.parse(readFileSync(join(stage, 'package.json')));
			assert.strictEqual(manifest.dependencies[name], '1.0.1');
			assert.deepStrictEqual(checkBundle(stage, join(source, 'package-lock.json')), { roots: 1, packages: 2 });
			moduleFixture(join(stage, nativeRoot), name);
			checkBundle(stage, join(source, 'package-lock.json'), true);
		});
	}

	for (const spec of ['npm:another-package@1.6.2', 'https://example.test/ordered-binary.tgz', './local.tgz']) {
		it(`rejects rewriting non-registry source ${spec} to a same-named registry package`, () => {
			lock.packages[''].dependencies['ordered-binary'] = spec;
			lock.packages['node_modules/ordered-binary'] = { version: '1.6.2' };
			assert.throws(() => bundlePlan(lock), /Cannot replace non-registry dependency ordered-binary/);
		});
	}

	it('prunes the real production graph while retaining native roots and required type packages', () => {
		const realLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url)));
		const plan = bundlePlan(realLock);
		for (const name of ['@harperfast/rocksdb-js', 'lmdb', 'argon2']) {
			assert.ok(!plan.packages.has(`node_modules/${name}`));
			assert.strictEqual(plan.external[name], realLock.packages[`node_modules/${name}`].version);
		}
		for (const key of plan.packages) {
			assert.ok(!/node_modules\/(react-native-fs|react-native|utf-8-validate)(?:$|\/)/.test(key));
		}
		assert.ok(plan.packages.has('node_modules/@types/node'));
		const optionalOnly = structuredClone(realLock);
		delete optionalOnly.packages['node_modules/@types/readable-stream'].dependencies['@types/node'];
		assert.ok(!bundlePlan(optionalOnly).packages.has('node_modules/@types/node'));
	});

	it('keeps uWebSockets.js as a dev dependency and optional peer in the real manifest', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
		assert.ok(manifest.devDependencies['uWebSockets.js']);
		assert.ok(manifest.peerDependencies['uWebSockets.js']);
		assert.strictEqual(manifest.peerDependenciesMeta['uWebSockets.js'].optional, true);
		assert.ok(!manifest.dependencies['uWebSockets.js'] && !manifest.optionalDependencies['uWebSockets.js']);
	});

	function installedEngineFixture(engine, names) {
		Object.assign(lock.packages[''].dependencies, {
			[engine]: '2.0.0',
			'@harperfast/extended-iterable': '1.0.0',
			'ordered-binary': '1.6.2',
			'msgpackr': '2.0.0',
		});
		for (const [name, version] of Object.entries(lock.packages[''].dependencies)) {
			lock.packages[`node_modules/${name}`] ??= { version };
		}
		lock.packages[`node_modules/${engine}`].dependencies = Object.fromEntries(
			names.map((name) => [name, lock.packages[''].dependencies[name]])
		);
		const stage = prepare();
		for (const name of Object.keys(bundlePlan(lock).external)) {
			moduleFixture(join(stage, 'node_modules', name), name);
		}
		return stage;
	}
	function moduleFixture(path, name) {
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(path, 'package.json'),
			JSON.stringify({ name, version: lock.packages[`node_modules/${name}`].version, main: 'index.js' })
		);
		writeFileSync(join(path, 'index.js'), 'module.exports = {};');
	}
	for (const [engine, names] of [
		['@harperfast/rocksdb-js', ['@harperfast/extended-iterable', 'ordered-binary', 'msgpackr']],
		['lmdb', ['@harperfast/extended-iterable', 'ordered-binary']],
	]) {
		for (const name of names) {
			it(`rejects the archive when ${engine} no longer declares ${name}`, () => {
				installedEngineFixture(engine, names);
				delete lock.packages[`node_modules/${engine}`].dependencies[name];
				assert.throws(
					() => prepare(),
					(error) => error.message.includes(`${engine} no longer declares ${name}`)
				);
			});
			for (const layout of ['nested', 'linked']) {
				it(`rejects a ${layout} private ${name} instance in ${engine}`, () => {
					const stage = installedEngineFixture(engine, names);
					const nested = join(stage, 'node_modules', engine, 'node_modules', name);
					if (layout === 'linked') {
						const target = join(directory, 'private-encoder');
						moduleFixture(target, name);
						mkdirSync(dirname(nested), { recursive: true });
						symlinkSync(target, nested, 'junction');
					} else moduleFixture(nested, name);
					assert.throws(
						() => checkBundle(stage, join(source, 'package-lock.json'), true),
						(error) => error.message.includes(`separate ${name} instances`)
					);
				});
			}
		}
		it(`checks module resolution from the real path of a linked ${engine}`, () => {
			const stage = installedEngineFixture(engine, names);
			const linked = join(directory, 'linked', 'engine');
			moduleFixture(linked, engine);
			for (const name of names) moduleFixture(join(directory, 'linked', 'node_modules', name), name);
			const installed = join(stage, 'node_modules', engine);
			rmSync(installed, { recursive: true });
			symlinkSync(linked, installed, 'junction');
			assert.throws(
				() => checkBundle(stage, join(source, 'package-lock.json'), true),
				/separate @harperfast\/extended-iterable instances/
			);
		});
	}

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

	const peBinary = Buffer.alloc(132);
	peBinary.write('MZ');
	peBinary.writeUInt32LE(128, 60);
	peBinary.write('PE\0\0', 128);
	for (const [file, contents] of [
		['addon.node', Buffer.from('addon')],
		['addon.bare', Buffer.from('addon')],
		['binding.gyp', Buffer.from('{}')],
		['hermesc', Buffer.from('7f454c46', 'hex')],
		['mach-o', Buffer.from('cffaedfe', 'hex')],
		['mach-o-fat64', Buffer.from('cafebabf', 'hex')],
		['windows', peBinary],
	]) {
		it(`rejects native content ${file}`, () => {
			writeSource();
			writeFileSync(join(source, 'node_modules/child', file), contents);
			assert.throws(() => prepareBundle(source, join(directory, 'stage')), /Cannot bundle native/);
		});
	}

	it('allows ordinary text beginning with MZ', () => {
		writeSource();
		writeFileSync(join(source, 'node_modules/child/README.md'), 'MZ_MODE describes a text-only option.\n'.repeat(5));
		assert.ok(prepareBundle(source, join(directory, 'stage')));
	});

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

	it('rejects an added dependency declaration in a copied manifest', () => {
		const stage = prepare();
		const file = join(stage, 'node_modules/parent/package.json');
		const manifest = JSON.parse(readFileSync(file));
		manifest.dependencies.absent = '^1.0.0';
		writeFileSync(file, JSON.stringify(manifest));
		assert.throws(() => checkBundle(stage, join(source, 'package-lock.json')), /declaration for absent differs/);
	});

	it('rejects an optional peer changed into a required consumer install edge', () => {
		lock.packages['node_modules/parent'].peerDependencies = { absent: '^1.0.0' };
		lock.packages['node_modules/parent'].peerDependenciesMeta = { absent: { optional: true } };
		const stage = prepare();
		const file = join(stage, 'node_modules/parent/package.json');
		const manifest = JSON.parse(readFileSync(file));
		delete manifest.peerDependenciesMeta;
		writeFileSync(file, JSON.stringify(manifest));
		assert.throws(() => checkBundle(stage, join(source, 'package-lock.json')), /peer optionality.*absent differs/);
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

	it('refuses to clear an unrelated existing directory', () => {
		writeSource();
		const destination = join(directory, 'unrelated');
		mkdirSync(destination);
		writeFileSync(join(destination, 'keep'), 'keep');
		assert.throws(() => prepareBundle(source, destination), /not an owned bundle stage/);
		assert.strictEqual(readFileSync(join(destination, 'keep'), 'utf8'), 'keep');
	});
});
