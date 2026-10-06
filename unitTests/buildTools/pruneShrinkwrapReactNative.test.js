// Covers production shrinkwrap pruning: the unused React Native tree (#1937) and
// optional UTF-8 peers. Shared packages and explicit addon dependencies must survive.
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'build-tools', 'prune-shrinkwrap-react-native.mjs');

// Root depends on alasql and `shared`. alasql optionally depends on react-native-fs,
// which peer-depends on react-native, which pulls `rn-only` and also `shared`.
// Only react-native-fs, react-native and rn-only are exclusive to that subtree.
function fixture() {
	return {
		lockfileVersion: 3,
		packages: {
			'': { dependencies: { alasql: '^4.17.3', shared: '^1.0.0' } },
			'node_modules/alasql': { version: '4.17.3', optionalDependencies: { 'react-native-fs': '^2.20.0' } },
			'node_modules/react-native-fs': { version: '2.20.0', peerDependencies: { 'react-native': '*' } },
			'node_modules/react-native': { version: '0.82.1', dependencies: { 'rn-only': '^1.0.0', 'shared': '^1.0.0' } },
			'node_modules/rn-only': { version: '1.0.0' },
			'node_modules/shared': { version: '1.0.0' },
		},
	};
}

function runPrune(lock) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-rn-'));
	const file = path.join(dir, 'npm-shrinkwrap.json');
	try {
		fs.writeFileSync(file, JSON.stringify(lock));
		// Capture expected-throw errors without printing the child's stack into the test output.
		const stdout = execFileSync(process.execPath, [SCRIPT, file], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 30_000,
		});
		return { stdout, result: JSON.parse(fs.readFileSync(file, 'utf8')) };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function utf8Fixture() {
	return {
		lockfileVersion: 3,
		packages: {
			'': { dependencies: { ws: '^8.0.0' }, optionalDependencies: { bufferutil: '^4.0.0' } },
			'node_modules/ws': {
				version: '8.0.0',
				peerDependencies: { 'utf-8-validate': '>=5.0.2' },
				peerDependenciesMeta: { 'utf-8-validate': { optional: true } },
			},
			'node_modules/utf-8-validate': {
				version: '5.0.10',
				dependencies: { 'node-gyp-build': '^4.0.0', 'addon-only': '^1.0.0' },
			},
			'node_modules/bufferutil': { version: '4.0.0', dependencies: { 'node-gyp-build': '^4.0.0' } },
			'node_modules/node-gyp-build': { version: '4.0.0' },
			'node_modules/addon-only': { version: '1.0.0' },
		},
	};
}

describe('prune-shrinkwrap optional utf-8-validate peers', () => {
	it('removes the addon and exclusive children even without a react-native tree', () => {
		const { stdout, result } = runPrune(utf8Fixture());
		assert.ok(!result.packages['node_modules/utf-8-validate'], 'optional peer must not ship the unused addon');
		assert.ok(!result.packages['node_modules/addon-only'], 'exclusive children must be pruned');
		assert.ok(result.packages['node_modules/node-gyp-build'], 'bufferutil still requires the shared native loader');
		assert.ok(result.packages['node_modules/bufferutil'], 'other optional native packages must survive');
		assert.ok(result.packages['node_modules/ws'], 'ws itself must survive');
		assert.match(stdout, /No unused react-native-fs tree.*nothing to prune/);
		assert.match(stdout, /Pruned 2 entries reachable only through optional utf-8-validate peers/);
	});

	it('preserves other optional peers even when no explicit dependency produces them', () => {
		const lock = utf8Fixture();
		delete lock.packages[''].optionalDependencies;
		lock.packages['node_modules/ws'].peerDependencies.bufferutil = '^4.0.0';
		lock.packages['node_modules/ws'].peerDependenciesMeta.bufferutil = { optional: true };
		const { result } = runPrune(lock);
		assert.ok(!result.packages['node_modules/utf-8-validate'], 'UTF-8 peer should be pruned');
		assert.ok(result.packages['node_modules/bufferutil'], 'rule must not extend to other optional peers');
		assert.ok(result.packages['node_modules/node-gyp-build'], 'their dependencies must survive');
	});

	it('refuses to write if an unreachable entry still requires the addon', () => {
		const lock = utf8Fixture();
		lock.packages['node_modules/dev-only-tool'] = { version: '1.0.0', dependencies: { 'utf-8-validate': '^5.0.0' } };
		assert.throws(
			() => runPrune(lock),
			/pruning .*utf-8-validate.*required dependenc.*unresolved[\s\S]*dev-only-tool -> utf-8-validate/
		);
	});

	it('omits the addon from the real production lock without dropping native dependencies', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-utf8-lock-'));
		const file = path.join(dir, 'npm-shrinkwrap.json');
		try {
			fs.copyFileSync(path.join(__dirname, '..', '..', 'package-lock.json'), file);
			for (const script of ['prune-shrinkwrap-dev.mjs', 'prune-shrinkwrap-react-native.mjs']) {
				execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'build-tools', script), file], {
					timeout: 30_000,
				});
			}
			const { packages } = JSON.parse(fs.readFileSync(file, 'utf8'));
			assert.ok(
				!Object.keys(packages).some(
					(key) => key.endsWith('/node_modules/utf-8-validate') || key === 'node_modules/utf-8-validate'
				)
			);
			for (const name of [
				'ws',
				'bufferutil',
				'node-gyp-build',
				'@harperfast/rocksdb-js',
				'@harperfast/rocksdb-js-linux-x64-glibc',
			]) {
				assert.ok(packages[`node_modules/${name}`], `${name} must remain in the production lock`);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
		it(`keeps the addon when another package declares it in ${field}`, () => {
			const lock = utf8Fixture();
			lock.packages[''].dependencies.consumer = '^1.0.0';
			lock.packages['node_modules/consumer'] = { version: '1.0.0', [field]: { 'utf-8-validate': '^5.0.0' } };
			const { result } = runPrune(lock);
			assert.ok(result.packages['node_modules/utf-8-validate'], 'explicit dependency must survive');
			assert.ok(result.packages['node_modules/addon-only'], 'its dependencies must survive too');
		});
	}

	for (const field of ['dependencies', 'optionalDependencies']) {
		it(`keeps an optional peer that the same package also declares in ${field}`, () => {
			const lock = utf8Fixture();
			lock.packages['node_modules/ws'][field] = { 'utf-8-validate': '^5.0.0' };
			const { result } = runPrune(lock);
			assert.ok(result.packages['node_modules/utf-8-validate'], 'peer metadata cannot override an explicit dependency');
		});
	}

	it('keeps a peer unless its metadata explicitly marks it optional', () => {
		const lock = utf8Fixture();
		lock.packages['node_modules/ws'].peerDependenciesMeta['utf-8-validate'].optional = false;
		const { result } = runPrune(lock);
		assert.ok(result.packages['node_modules/utf-8-validate'], 'required peer must survive');
	});

	it('prunes a nested optional-peer copy while keeping a directly required hoisted copy', () => {
		const lock = utf8Fixture();
		lock.packages[''].dependencies['utf-8-validate'] = '^5.0.0';
		lock.packages['node_modules/ws/node_modules/utf-8-validate'] = { version: '6.0.6' };
		const { result } = runPrune(lock);
		assert.ok(!result.packages['node_modules/ws/node_modules/utf-8-validate'], 'nested optional peer must be pruned');
		assert.strictEqual(
			result.packages['node_modules/utf-8-validate'].version,
			'5.0.10',
			'explicit hoisted copy survives'
		);
	});

	it('is idempotent after removing optional peers', () => {
		const { result: once } = runPrune(utf8Fixture());
		const { result: twice } = runPrune(once);
		assert.deepStrictEqual(twice, once);
	});
});

describe('prune-shrinkwrap-react-native', () => {
	it('removes packages reachable only through react-native-fs', () => {
		const { result } = runPrune(fixture());
		const keys = Object.keys(result.packages);
		assert.ok(!keys.includes('node_modules/react-native-fs'), 'react-native-fs should be pruned');
		assert.ok(!keys.includes('node_modules/react-native'), 'react-native should be pruned');
		assert.ok(!keys.includes('node_modules/rn-only'), 'rn-only should be pruned');
	});

	it('keeps packages that remain reachable by another path', () => {
		const { result } = runPrune(fixture());
		// `shared` is pulled in by react-native but is also a direct root dependency.
		assert.ok(result.packages['node_modules/shared'], 'shared must survive — root still depends on it');
		assert.ok(result.packages['node_modules/alasql'], 'alasql itself must survive');
		assert.ok(result.packages[''], 'root manifest must survive');
	});

	it('reports the number of pruned entries', () => {
		const { stdout } = runPrune(fixture());
		assert.match(stdout, /Pruned 3 entries reachable only through react-native-fs/);
	});

	it('is a no-op when there is no react-native-fs tree', () => {
		const lock = fixture();
		delete lock.packages['node_modules/react-native-fs'];
		delete lock.packages['node_modules/react-native'];
		delete lock.packages['node_modules/rn-only'];
		delete lock.packages['node_modules/alasql'].optionalDependencies;
		const { stdout, result } = runPrune(lock);
		assert.match(stdout, /No unused react-native-fs tree.*nothing to prune/);
		assert.doesNotMatch(stdout, /^Pruned /m);
		assert.deepStrictEqual(Object.keys(result.packages).sort(), ['', 'node_modules/alasql', 'node_modules/shared']);
	});

	it('is idempotent', () => {
		const { result: once } = runPrune(fixture());
		const { result: twice } = runPrune(once);
		assert.deepStrictEqual(Object.keys(twice.packages).sort(), Object.keys(once.packages).sort());
	});

	// Regression: severing every edge named react-native-fs, rather than only the ones the
	// dependent declared optional, deleted a package that another dependent still required
	// and left that requirement dangling in the published shrinkwrap.
	it('keeps react-native-fs when another package hard-depends on it', () => {
		const lock = fixture();
		lock.packages[''].dependencies['other-pkg'] = '^1.0.0';
		lock.packages['node_modules/other-pkg'] = { version: '1.0.0', dependencies: { 'react-native-fs': '^2.20.0' } };
		const { stdout, result } = runPrune(lock);
		assert.ok(result.packages['node_modules/react-native-fs'], 'react-native-fs is still required by other-pkg');
		assert.ok(result.packages['node_modules/react-native'], 'its peer tree stays reachable through it');
		assert.match(stdout, /No unused react-native-fs tree.*nothing to prune/);
		assert.doesNotMatch(stdout, /^Pruned /m);
	});

	it('still prunes when the only other reference is another optional declaration', () => {
		const lock = fixture();
		lock.packages[''].dependencies['other-pkg'] = '^1.0.0';
		lock.packages['node_modules/other-pkg'] = {
			version: '1.0.0',
			optionalDependencies: { 'react-native-fs': '^2.20.0' },
		};
		const { result } = runPrune(lock);
		assert.ok(!result.packages['node_modules/react-native-fs'], 'both declarations are optional, so it goes');
		assert.ok(result.packages['node_modules/other-pkg'], 'the optional dependent itself survives');
	});

	// The script fails the build if it *introduces* an unresolved required edge. It must not
	// fail on one the input already had — published shrinkwraps legitimately carry some.
	it('tolerates a required edge that was already unresolved before pruning', () => {
		const lock = fixture();
		lock.packages['node_modules/shared'].dependencies = { 'never-installed': '^1.0.0' };
		const { stdout, result } = runPrune(lock);
		assert.match(stdout, /Pruned 3 entries/);
		assert.ok(result.packages['node_modules/shared'], 'the pre-existing gap is not ours to act on');
	});

	// The backstop's own trigger. Reachable via an entry the production walk never visits —
	// in practice a dev entry, which is why build.sh prunes dev first.
	it('refuses to write when the prune newly breaks a required edge', () => {
		const lock = fixture();
		lock.packages['node_modules/dev-only-tool'] = { version: '1.0.0', dependencies: { 'rn-only': '^1.0.0' } };
		assert.throws(() => runPrune(lock), /required dependenc.* unresolved[\s\S]*node_modules\/dev-only-tool -> rn-only/);
	});

	it('points at the dev prune when it refuses', () => {
		const lock = fixture();
		lock.packages['node_modules/dev-only-tool'] = { version: '1.0.0', dependencies: { 'rn-only': '^1.0.0' } };
		assert.throws(() => runPrune(lock), /run prune-shrinkwrap-dev\.mjs first/);
	});

	// resolve() must prefer a nested copy over the hoisted one, and handle scoped names —
	// both appear in the real tree (`@react-native/*`) but not in the flat fixtures above.
	it('resolves nested and scoped entries the way npm does', () => {
		const lock = fixture();
		lock.packages['node_modules/react-native'].dependencies['@scope/rn-helper'] = '^1.0.0';
		lock.packages['node_modules/@scope/rn-helper'] = { version: '1.0.0' };
		// A nested copy of `shared` under react-native: reachable only through the subtree,
		// so it goes, while the hoisted `shared` the root depends on stays.
		lock.packages['node_modules/react-native/node_modules/shared'] = { version: '2.0.0' };
		const { result } = runPrune(lock);
		assert.ok(!result.packages['node_modules/@scope/rn-helper'], 'scoped rn-only package pruned');
		assert.ok(!result.packages['node_modules/react-native/node_modules/shared'], 'nested copy pruned');
		assert.strictEqual(result.packages['node_modules/shared'].version, '1.0.0', 'hoisted copy untouched');
	});

	// The ancestor walk itself: a react-native-fs that only exists nested under its dependent,
	// plus a dependency of it that only exists at the root. Getting either lookup wrong leaves
	// the package unreachable, so it is never pruned and these assertions fail.
	it('resolves a nested react-native-fs and walks up through ancestors to the root', () => {
		const lock = fixture();
		lock.packages[''].dependencies['other-pkg'] = '^1.0.0';
		lock.packages['node_modules/other-pkg'] = {
			version: '1.0.0',
			optionalDependencies: { 'react-native-fs': '^2.19.0' },
		};
		// other-pkg's only resolution path is its own nested copy — resolving to the hoisted
		// one instead would leave this entry marked reachable and unpruned.
		lock.packages['node_modules/other-pkg/node_modules/react-native-fs'] = {
			version: '2.19.0',
			dependencies: { 'nested-rn-dep': '^1.0.0' },
		};
		// Two segments below where it lives, so resolve() must miss twice before hitting root.
		lock.packages['node_modules/nested-rn-dep'] = { version: '1.0.0' };

		const { result } = runPrune(lock);
		assert.ok(
			!result.packages['node_modules/other-pkg/node_modules/react-native-fs'],
			'nested copy must resolve nested-first, and be pruned'
		);
		assert.ok(
			!result.packages['node_modules/nested-rn-dep'],
			'root-level dep reachable only through the nested copy — requires the ancestor walk'
		);
		assert.ok(result.packages['node_modules/other-pkg'], 'the dependent itself survives');
	});

	it('rejects an unsupported lockfileVersion', () => {
		const lock = fixture();
		lock.lockfileVersion = 2;
		assert.throws(() => runPrune(lock), /unsupported lockfileVersion 2/);
	});
});
