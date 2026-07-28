// Covers build-tools/prune-shrinkwrap-react-native.mjs, which strips the react-native
// tree from the published shrinkwrap (#1937). The risk worth testing is over-reach: the
// script must remove only what is reachable *solely* through alasql's optional
// react-native-fs edge, and never a package something else still depends on.
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
	fs.writeFileSync(file, JSON.stringify(lock));
	// stderr is captured rather than inherited so the expected-throw case does not print
	// the child's stack trace into the test output.
	const stdout = execFileSync(process.execPath, [SCRIPT, file], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return { stdout, result: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

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
		assert.match(stdout, /nothing to prune/);
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
		assert.match(stdout, /nothing to prune/);
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

	it('rejects an unsupported lockfileVersion', () => {
		const lock = fixture();
		lock.lockfileVersion = 2;
		assert.throws(() => runPrune(lock), /unsupported lockfileVersion 2/);
	});
});
