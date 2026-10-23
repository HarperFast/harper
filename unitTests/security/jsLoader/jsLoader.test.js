'use strict';

const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { scopedImport } = require('#src/security/jsLoader');
const assert = require('node:assert');
const { expect } = require('chai');

const SYMLINK_FIXTURE = join(__dirname, 'fixtures', 'symlink-test', 'node_modules', 'proxyTransform');
// Minimal scope that routes through the VM loader without requiring a full Harper server context
const vmScope = () => ({ mode: 'vm-current-context' });

describe('scopedImport', () => {
	it('should import a module', async () => {
		const result = await scopedImport(join(__dirname, 'fixtures', 'good.cjs'));
		expect(result.foo).to.equal('bar');
	});

	it('should throw an error importing an invalid CommonJS module', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid1.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( 'is')?/);
			// note: `rewire` (called from `testUtils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/invalid1\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?This is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should throw an error importing a CommonJS module with invalid dependency', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid2.cjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal("SyntaxError: Unexpected token '='");
			// note: `rewire` (called from `testUtils`) is wrapping commonjs modules
			expect(e.stack).to.match(
				/libbad\.cjs:1\n(?:\(function \(exports, require, module, __filename, __dirname\) \{ )?module.exports.baz ====\n +\^\n+SyntaxError: Unexpected token '='/
			);
		}
	});

	it('should throw an error importing an invalid ESM module', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid3.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.match(/SyntaxError: Unexpected identifier( 'is')?/);
			expect(e.stack).to.match(
				/invalid3\.mjs:1\nThis is not a valid module.\n +\^\^\n+SyntaxError: Unexpected identifier(?: 'is')?/
			);
		}
	});

	it('should resolve require("harperdb") to harper exports', async () => {
		const scope = {
			mode: 'vm-current-context',
			allowedPath: '',
			moduleCache: null,
			server: { authenticateUser: null, operation: null },
			logger: {},
			resources: {},
			config: {},
		};
		const result = await scopedImport(join(__dirname, 'fixtures', 'uses-harperdb.cjs'), scope);
		expect(result.Resource).to.be.a('function');
		expect(result.tables).to.exist;
		expect(result.defineTable).to.be.a('function');
		expect(result.defineResource).to.be.a('function');
		expect(result.schemaOf).to.be.a('function');
		expect(result.projectTableFragment).to.be.a('function');
		expect(result.t).to.exist;
		expect(result.types).to.exist;
		// #1325/#1534: the model-backend registration API reaches components through
		// `require('harperdb').models` (getHarperExports) — methods on the models
		// singleton, NOT separate top-level exports (those generic globals were
		// removed in #1534, the same way routing is `models.registerRouter`).
		expect(result.models).to.exist;
		expect(result.models.registerBackend).to.be.a('function');
		expect(result.models.defineBackend).to.be.a('function');
		expect(result.registerBackend).to.equal(undefined);
		expect(result.defineBackend).to.equal(undefined);
	});

	it('should throw an error importing an ESM module with invalid dependency', async () => {
		try {
			await scopedImport(join(__dirname, 'fixtures', 'invalid4.mjs'));
		} catch (e) {
			expect(e).to.be.instanceOf(SyntaxError);
			expect(e.toString()).to.equal('SyntaxError: Missing initializer in const declaration');
			expect(e.stack).to.match(
				/libbad\.mjs:1\nexport const baz ====\n +\^\^\^\n+SyntaxError: Missing initializer in const declaration/
			);
		}
	});

	it('should handle dynamic import() from a CJS module', async () => {
		const result = await scopedImport(join(__dirname, 'fixtures', 'uses-dynamic-import.cjs'), vmScope());
		const lib = await result.load();
		expect(lib.baz).to.equal('pow');
	});

	it('records transitive local modules and their resolution edges', async () => {
		const loadedModules = [];
		const resolutions = [];
		const scope = {
			mode: 'vm-current-context',
			recordLoadedModule: (url) => loadedModules.push(url),
			recordModuleResolution: (specifier, referrer, resolvedUrl) =>
				resolutions.push({ specifier, referrer, resolvedUrl }),
		};

		const result = await scopedImport(join(__dirname, 'fixtures', 'uses-dynamic-import.cjs'), scope);
		await result.load();

		expect(loadedModules.some((url) => url.endsWith('/uses-dynamic-import.cjs'))).to.equal(true);
		expect(loadedModules.some((url) => url.endsWith('/libgood.cjs'))).to.equal(true);
		expect(resolutions.some(({ specifier }) => specifier === './libgood.cjs')).to.equal(true);
	});

	it('keeps app-local package imports observable unless native loading is explicit', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'harper-js-loader-imports-'));
		try {
			writeFileSync(
				join(directory, 'package.json'),
				JSON.stringify({
					name: 'app-local-imports',
					type: 'module',
					imports: { '#helper': './helper.js' },
					exports: { './self': './self.js' },
				})
			);
			writeFileSync(
				join(directory, 'entry.js'),
				"export { value } from '#helper';\nexport { selfValue } from 'app-local-imports/self';\n"
			);
			writeFileSync(join(directory, 'helper.js'), 'export const value = 42;\n');
			writeFileSync(join(directory, 'self.js'), 'export const selfValue = 84;\n');

			const loadedModules = [];
			const resolutions = [];
			let nativeRuntime = false;
			const result = await scopedImport(join(directory, 'entry.js'), {
				mode: 'vm-current-context',
				runtimeRoot: directory,
				recordLoadedModule: (url) => loadedModules.push(url),
				recordModuleResolution: (specifier, referrer, resolvedUrl) =>
					resolutions.push({ specifier, referrer, resolvedUrl }),
				markNativeRuntime: () => (nativeRuntime = true),
			});

			expect(result.value).to.equal(42);
			expect(result.selfValue).to.equal(84);
			expect(loadedModules.some((url) => url.endsWith('/helper.js'))).to.equal(true);
			expect(loadedModules.some((url) => url.endsWith('/self.js'))).to.equal(true);
			expect(resolutions.some(({ specifier }) => specifier === '#helper')).to.equal(true);
			expect(resolutions.some(({ specifier }) => specifier === 'app-local-imports/self')).to.equal(true);
			expect(nativeRuntime).to.equal(false);

			let explicitNativeRuntime = false;
			const nativeResult = await scopedImport(join(directory, 'entry.js'), {
				mode: 'vm-current-context',
				runtimeRoot: directory,
				dependencyLoader: 'native',
				markNativeRuntime: () => (explicitNativeRuntime = true),
			});
			expect(nativeResult.value).to.equal(42);
			expect(nativeResult.selfValue).to.equal(84);
			expect(explicitNativeRuntime).to.equal(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('import.meta compatibility', () => {
	it('should populate import.meta.url, filename, dirname, and resolve for ESM modules', async () => {
		const fixturePath = join(__dirname, 'fixtures', 'import-meta.mjs');
		const result = await scopedImport(fixturePath, vmScope());
		expect(result.metaUrl).to.be.a('string').and.include('import-meta.mjs');
		expect(result.metaFilename).to.equal(fixturePath);
		expect(result.metaDirname).to.equal(join(__dirname, 'fixtures'));
		expect(result.resolvedSelf).to.equal(pathToFileURL(fixturePath).toString());
	});
});

describe('symlinked module resolution', () => {
	it('should resolve relative CJS require through a symlinked module', async () => {
		// proxyTransform is a symlink to ../harper-modules/proxy-transform-module
		// index.cjs does require('../cache.cjs') which must resolve via the real path,
		// not the symlink path (node_modules/proxyTransform/../cache.cjs would not exist)
		const result = await scopedImport(join(SYMLINK_FIXTURE, 'index.cjs'), vmScope());
		expect(result.default.cached).to.equal('hit');
	});

	it('should resolve relative ESM import through a symlinked module', async () => {
		// Same scenario for ESM: import cache from '../cache.mjs' must resolve via realpath
		const result = await scopedImport(join(SYMLINK_FIXTURE, 'index.mjs'), vmScope());
		expect(result.cached).to.equal('hit');
	});

	it('should resolve relative ESM import through a symlinked module in a compartment', async () => {
		// Outside node_modules, so the compartment evaluates the entry itself and resolves '../cache.mjs' via resolveHook
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'harper-js-loader-symlink-'));
		try {
			mkdirSync(join(runtimeRoot, 'real', 'sub'), { recursive: true });
			mkdirSync(join(runtimeRoot, 'app'));
			writeFileSync(join(runtimeRoot, 'real', 'cache.mjs'), "export const cached = 'hit';\n");
			writeFileSync(join(runtimeRoot, 'real', 'sub', 'index.mjs'), "export { cached } from '../cache.mjs';\n");
			symlinkSync(join(runtimeRoot, 'real', 'sub', 'index.mjs'), join(runtimeRoot, 'app', 'link.mjs'));
			const result = await scopedImport(join(runtimeRoot, 'app', 'link.mjs'), {
				mode: 'compartment',
				runtimeRoot,
				resources: {},
			});
			expect(result.cached).to.equal('hit');
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	});
});

describe('SES loading', () => {
	it('requires the same shims, in the same order, as ses/index.js', () => {
		const sesIndex = readFileSync(join(dirname(require.resolve('ses/package.json')), 'index.js'), 'utf8');
		const loaderSource = readFileSync(join(__dirname, '..', '..', '..', 'security', 'jsLoader.ts'), 'utf8');
		const sesShims = [...sesIndex.matchAll(/^import '\.\/src\/([\w-]+-shim\.js)';$/gm)].map((match) => match[1]);
		const loadedShims = [...loaderSource.matchAll(/(?:require|nativeRequire)\('ses\/([\w-]+-shim\.js)'\)/g)].map(
			(match) => match[1]
		);
		expect(sesShims).to.have.length.above(0);
		expect(loadedShims).to.deep.equal(sesShims);
	});
});

const PROBE_PACKAGE_FILES = {
	'a.js': 'a',
	'valid.js': 'valid',
	'index.js': 'index',
	'x.js': 'x',
	'node.js': 'node-branch',
	'generic.js': 'generic-branch',
	'features/alpha.js': 'alpha',
	'features/$&.js': 'dollar',
	'features/private/secret.js': 'secret',
	'node_modules/dep/index.js': 'nested-dep',
};

// Each case reaches the exports fallback: its targets sit behind conditions the CommonJS resolver does not
// match, so createRequire().resolve() rejects it with ERR_PACKAGE_PATH_NOT_EXPORTED first.
const EXPORTS_CONFORMANCE_CASES = [
	{
		title: 'matches conditions in the package key order',
		exports: { '.': { node: { import: './node.js' }, import: './generic.js' } },
		expected: 'node-branch',
	},
	{
		title: 'moves past an unmatched nested condition',
		exports: { '.': { import: { worker: './a.js' }, node: { import: './x.js' } } },
		expected: 'x',
	},
	{
		title: 'stops at a null condition target',
		exports: { '.': { node: null, default: './x.js' } },
		expected: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	},
	{
		title: 'stops at a nested null default',
		exports: { '.': { import: { worker: './a.js', default: null }, node: { import: './x.js' } } },
		expected: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	},
	{
		title: 'expands a * subpath pattern',
		exports: { './features/*': { import: './features/*.js' } },
		subpath: '/features/alpha',
		expected: 'alpha',
	},
	{
		title: 'selects the pattern with the longest prefix',
		exports: { './features/*': { import: './x/*.js' }, './features/private/*': { import: './features/private/*.js' } },
		subpath: '/features/private/secret',
		expected: 'secret',
	},
	{
		title: 'lets a longer null pattern block a shorter one',
		exports: { './features/*': { import: './features/*.js' }, './features/private/*': null },
		subpath: '/features/private/secret',
		expected: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	},
	{
		title: 'breaks an equal-prefix tie on the longer pattern',
		exports: { './f/*': { import: './x/*.js' }, './f/*.js': { import: './features/*.js' } },
		subpath: '/f/alpha.js',
		expected: 'alpha',
	},
	{
		title: 'prefers an exact subpath over a pattern',
		exports: { './features/*': { import: './features/*.js' }, './features/alpha': { import: './a.js' } },
		subpath: '/features/alpha',
		expected: 'a',
	},
	{
		title: 'substitutes the pattern match literally',
		exports: { './f/*': { import: './features/*.js' } },
		subpath: '/f/$&',
		expected: 'dollar',
	},
	{
		title: 'rejects a pattern match that leaves its directory',
		exports: { './features/*': { import: './features/*.js' } },
		subpath: '/features/../index',
		expected: 'ERR_INVALID_MODULE_SPECIFIER',
	},
	{
		title: 'rejects a target outside the package',
		exports: { '.': { import: './../outside.js' } },
		expected: 'ERR_INVALID_PACKAGE_TARGET',
	},
	{
		title: 'rejects a percent-encoded traversal target',
		exports: { '.': { import: './%2e%2e/outside.js' } },
		expected: 'ERR_INVALID_PACKAGE_TARGET',
	},
	{ title: 'rejects a bare target', exports: { '.': { import: 'index.js' } }, expected: 'ERR_INVALID_PACKAGE_TARGET' },
	{
		title: 'rejects a target inside node_modules',
		exports: { '.': { import: './node_modules/dep/index.js' } },
		expected: 'ERR_INVALID_PACKAGE_TARGET',
	},
	{
		title: 'rejects an encoded path separator',
		exports: { '.': { import: './features%2Falpha.js' } },
		expected: 'ERR_INVALID_MODULE_SPECIFIER',
	},
	{
		title: 'rejects a directory target',
		exports: { '.': { import: './features' } },
		expected: 'ERR_UNSUPPORTED_DIR_IMPORT',
	},
	{
		title: 'rejects numeric condition keys',
		exports: { '.': { import: { 0: './a.js' } } },
		expected: 'ERR_INVALID_PACKAGE_CONFIG',
	},
	{
		title: 'rejects a decimal numeric condition key',
		exports: { '.': { import: { 1.5: './a.js', default: './valid.js' } } },
		expected: 'ERR_INVALID_PACKAGE_CONFIG',
	},
	{
		title: 'falls back past an invalid array target',
		exports: { '.': { import: ['index.js', './valid.js'] } },
		expected: 'valid',
	},
	{
		title: 'falls back past a null array target',
		exports: { '.': { import: [null, './valid.js'] } },
		expected: 'valid',
	},
	{
		title: 'ends an array on its last null',
		exports: { '.': { import: ['index.js', null] } },
		expected: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
	},
	{
		title: 'ends an array on its last invalid target',
		exports: { '.': { import: [null, 'index.js'] } },
		expected: 'ERR_INVALID_PACKAGE_TARGET',
	},
	{
		title: 'does not fall back past a target file that is missing',
		exports: { '.': { import: ['./missing.js', './valid.js'] } },
		expected: 'ERR_MODULE_NOT_FOUND',
	},
	{ title: 'resolves a root array', exports: [{ import: './a.js' }], expected: 'a' },
	{ title: 'loads a target with a query string', exports: { '.': { import: './a.js?variant=1' } }, expected: 'a' },
];

function writeProbePackage(exports) {
	const runtimeRoot = mkdtempSync(join(tmpdir(), 'harper-js-loader-exports-'));
	const packageRoot = join(runtimeRoot, 'node_modules', 'exports-probe');
	for (const [file, value] of Object.entries(PROBE_PACKAGE_FILES)) {
		mkdirSync(dirname(join(packageRoot, file)), { recursive: true });
		writeFileSync(join(packageRoot, file), `export const value = '${value}';\n`);
	}
	writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'exports-probe', type: 'module', exports }));
	writeFileSync(join(runtimeRoot, 'outside.js'), "export const value = 'outside';\n");
	return runtimeRoot;
}

// SES flattens a compartment's load failure into a TypeError that keeps only the underlying message
const CODE_BY_MESSAGE = [
	[/No "exports" main defined|is not defined by "exports"/, 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
	[/Invalid "exports" target/, 'ERR_INVALID_PACKAGE_TARGET'],
	[/Invalid module "/, 'ERR_INVALID_MODULE_SPECIFIER'],
	[/Directory import/, 'ERR_UNSUPPORTED_DIR_IMPORT'],
	[/Invalid package config/, 'ERR_INVALID_PACKAGE_CONFIG'],
	[/Cannot find module/, 'ERR_MODULE_NOT_FOUND'],
];

function errorCode(error) {
	if (error?.code) return error.code;
	return CODE_BY_MESSAGE.find(([pattern]) => pattern.test(error?.message))?.[1] ?? error?.name;
}

async function loadOutcome(load) {
	try {
		return (await load()).value;
	} catch (error) {
		return errorCode(error);
	}
}

for (const mode of ['vm-current-context', 'compartment']) {
	describe(`pure-ESM package resolution (${mode})`, () => {
		// Regression test for https://github.com/HarperFast/harper/issues/826
		// Pure-ESM packages have an exports map with only "import" conditions and no "require".
		// createRequire().resolve() (CJS resolver) throws ERR_PACKAGE_PATH_NOT_EXPORTED for these on Node and
		// MODULE_NOT_FOUND on Bun; both loaders then resolve the entry from the package's exports map.
		const loaderScope = (runtimeRoot) => ({ mode, runtimeRoot, resources: {} });

		it('should import a pure-ESM package (exports map with only "import" conditions, no "require")', async () => {
			const runtimeRoot = join(__dirname, 'fixtures', 'esm-only-test');
			const resolutions = [];
			const loadedModules = [];
			const result = await scopedImport(join(runtimeRoot, 'uses-pure-esm-pkg.mjs'), {
				...loaderScope(runtimeRoot),
				recordModuleResolution: (specifier) => resolutions.push(specifier),
				recordLoadedModule: (url) => loadedModules.push(url),
			});
			expect(result.value).to.equal('esm-only');
			expect(resolutions).not.to.include('pure-esm-pkg');
			expect(loadedModules.some((url) => url.endsWith('/pure-esm-pkg/package.json'))).to.equal(true);
			expect(loadedModules.some((url) => url.endsWith('/pure-esm-pkg/index.js'))).to.equal(true);
		});

		it('uses the ESM fallback for Bun MODULE_NOT_FOUND errors from bare packages', async () => {
			const runtimeRoot = mkdtempSync(join(tmpdir(), 'harper-js-loader-bun-esm-'));
			const packageRoot = join(runtimeRoot, 'node_modules', 'bun-esm-only-pkg');
			const originalBun = Object.getOwnPropertyDescriptor(process.versions, 'bun');
			try {
				mkdirSync(packageRoot, { recursive: true });
				writeFileSync(
					join(packageRoot, 'package.json'),
					JSON.stringify({
						name: 'bun-esm-only-pkg',
						type: 'module',
						exports: { '.': { import: './index.mjs', require: './missing.cjs' } },
					})
				);
				writeFileSync(join(packageRoot, 'index.mjs'), "export const value = 'bun-esm-only';\n");
				const bunConditionRoot = join(runtimeRoot, 'node_modules', 'bun-condition-pkg');
				mkdirSync(bunConditionRoot);
				writeFileSync(
					join(bunConditionRoot, 'package.json'),
					JSON.stringify({
						name: 'bun-condition-pkg',
						type: 'module',
						exports: { bun: './bun.mjs', import: './index.mjs' },
					})
				);
				writeFileSync(join(bunConditionRoot, 'bun.mjs'), "export const value = 'bun';\n");
				writeFileSync(join(bunConditionRoot, 'index.mjs'), "export const value = 'import';\n");
				writeFileSync(
					join(runtimeRoot, 'entry.mjs'),
					"export { value } from 'bun-esm-only-pkg';\nexport { value as bunValue } from 'bun-condition-pkg';\n"
				);
				Object.defineProperty(process.versions, 'bun', { configurable: true, value: 'test' });

				const result = await scopedImport(join(runtimeRoot, 'entry.mjs'), loaderScope(runtimeRoot));
				expect(result.value).to.equal('bun-esm-only');
				assert.strictEqual(result.bunValue, 'bun');
			} finally {
				if (originalBun) Object.defineProperty(process.versions, 'bun', originalBun);
				else delete process.versions.bun;
				rmSync(runtimeRoot, { recursive: true, force: true });
			}
		});

		it('keeps the require target of a dual package and surfaces resolution errors', async () => {
			const runtimeRoot = mkdtempSync(join(tmpdir(), 'harper-js-loader-dual-'));
			const packageRoot = join(runtimeRoot, 'node_modules', 'dual-pkg');
			try {
				mkdirSync(packageRoot, { recursive: true });
				writeFileSync(
					join(packageRoot, 'package.json'),
					JSON.stringify({
						name: 'dual-pkg',
						exports: { '.': { import: './index.mjs', require: './index.cjs' } },
					})
				);
				writeFileSync(join(packageRoot, 'index.mjs'), "export const target = 'import';\n");
				writeFileSync(join(packageRoot, 'index.cjs'), "exports.target = 'require';\n");
				writeFileSync(join(runtimeRoot, 'dual.mjs'), "export { target } from 'dual-pkg';\n");
				writeFileSync(join(runtimeRoot, 'missing.mjs'), "export * from 'no-such-pkg';\n");
				writeFileSync(join(runtimeRoot, 'unexported.mjs'), "export * from 'dual-pkg/private';\n");

				const result = await scopedImport(join(runtimeRoot, 'dual.mjs'), loaderScope(runtimeRoot));
				expect(result.target).to.equal('require');
				const failure = (file) =>
					scopedImport(join(runtimeRoot, file), loaderScope(runtimeRoot)).then(
						() => expect.fail(`${file} should not load`),
						(error) => error.message
					);
				expect(await failure('missing.mjs')).to.include("Cannot find module 'no-such-pkg'");
				expect(await failure('unexported.mjs')).to.match(/\.\/private|dual-pkg\/private/);
			} finally {
				rmSync(runtimeRoot, { recursive: true, force: true });
			}
		});

		describe('resolves package exports as native Node import does', () => {
			for (const { title, exports, subpath = '', expected } of EXPORTS_CONFORMANCE_CASES) {
				it(title, async () => {
					const runtimeRoot = writeProbePackage(exports);
					try {
						const entry = join(runtimeRoot, 'entry.mjs');
						writeFileSync(entry, `export * from 'exports-probe${subpath}';\n`);
						const native = await loadOutcome(() => import(pathToFileURL(entry).href));
						const loaded = await loadOutcome(() => scopedImport(entry, loaderScope(runtimeRoot)));
						assert.strictEqual(native, expected, 'native Node import');
						assert.strictEqual(loaded, expected);
					} finally {
						rmSync(runtimeRoot, { recursive: true, force: true });
					}
				});
			}
		});
	});
}

describe('application require() of package exports (vm-current-context)', () => {
	const writeDualPackage = (runtimeRoot) => {
		const packageRoot = join(runtimeRoot, 'node_modules', 'dual-probe');
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, 'package.json'),
			JSON.stringify({ name: 'dual-probe', type: 'module', exports: { '.': { import: './a.js', require: './b.cjs' } } })
		);
		writeFileSync(join(packageRoot, 'a.js'), "export const value = 'import';\n");
		writeFileSync(join(packageRoot, 'b.cjs'), "exports.value = 'require';\n");
	};

	it('keeps the CommonJS verdict for an import-only package, as native require does', async () => {
		const runtimeRoot = writeProbePackage({ '.': { import: './index.js' } });
		try {
			writeDualPackage(runtimeRoot);
			const entry = join(runtimeRoot, 'app.cjs');
			writeFileSync(
				entry,
				[
					"const attempt = (load) => { try { load(); return 'loaded'; } catch (error) { return error.code; } };",
					"exports.requireOutcome = attempt(() => require('exports-probe'));",
					"exports.resolveOutcome = attempt(() => require.resolve('exports-probe'));",
					"exports.dualValue = require('dual-probe').value;",
				].join('\n')
			);
			const native = require(entry);
			const loaded = await scopedImport(entry, { ...vmScope(), runtimeRoot });
			assert.strictEqual(native.requireOutcome, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
			assert.strictEqual(native.resolveOutcome, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
			assert.strictEqual(native.dualValue, 'require');
			assert.strictEqual(loaded.requireOutcome, native.requireOutcome);
			assert.strictEqual(loaded.resolveOutcome, native.resolveOutcome);
			assert.strictEqual(loaded.dualValue, native.dualValue);
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	});

	it('surfaces an uncaught require() rejection without re-running the module as ESM', async () => {
		const runtimeRoot = writeProbePackage({ '.': { import: './index.js' } });
		const counter = Symbol.for('harper.jsLoader.test.requireRejection');
		try {
			const entry = join(runtimeRoot, 'app.cjs');
			writeFileSync(
				entry,
				`globalThis[Symbol.for('harper.jsLoader.test.requireRejection')] = (globalThis[Symbol.for('harper.jsLoader.test.requireRejection')] ?? 0) + 1;\nmodule.exports = require('exports-probe');\n`
			);
			const scope = { ...vmScope(), runtimeRoot };
			assert.strictEqual(await loadOutcome(() => scopedImport(entry, scope)), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
			assert.strictEqual(globalThis[counter], 1);
			assert.strictEqual(await loadOutcome(() => scopedImport(entry, scope)), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
			assert.strictEqual(globalThis[counter], 2);
		} finally {
			delete globalThis[counter];
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	});

	it('resolves package exports for import.meta.resolve and a dynamic import() from CommonJS', async () => {
		const runtimeRoot = writeProbePackage({ './features/*': { node: { import: './features/*.js' } } });
		try {
			const esmEntry = join(runtimeRoot, 'meta.mjs');
			writeFileSync(esmEntry, "export const resolved = import.meta.resolve('exports-probe/features/alpha');\n");
			const cjsEntry = join(runtimeRoot, 'dynamic.cjs');
			writeFileSync(cjsEntry, "exports.load = () => import('exports-probe/features/alpha');\n");
			const nativeResolved = (await import(pathToFileURL(esmEntry).href)).resolved;
			assert.match(nativeResolved, /\/features\/alpha\.js$/);
			assert.strictEqual((await scopedImport(esmEntry, { ...vmScope(), runtimeRoot })).resolved, nativeResolved);
			const dynamic = await scopedImport(cjsEntry, { ...vmScope(), runtimeRoot });
			assert.strictEqual((await dynamic.load()).value, 'alpha');
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	});
});

describe('native addon delegation', () => {
	let runtimeRoot;
	let addonPath;
	let originalLoader;

	beforeEach(() => {
		runtimeRoot = mkdtempSync(join(tmpdir(), 'js-loader-native-addon-'));
		addonPath = join(runtimeRoot, 'addon.node');
		writeFileSync(addonPath, Buffer.from([0xff, 0x00, 0xfe]));
		originalLoader = require.extensions['.node'];
	});

	afterEach(() => {
		require.extensions['.node'] = originalLoader;
		rmSync(runtimeRoot, { recursive: true, force: true });
	});

	it('delegates transitive CJS .node requires and marks the runtime opaque', async () => {
		const wrapperPath = join(runtimeRoot, 'wrapper.cjs');
		writeFileSync(wrapperPath, "module.exports = require('./addon.node');\n");
		let nativeRuntimeMarked = false;
		require.extensions['.node'] = (module) => {
			module.exports = { delegated: true };
		};
		const result = await scopedImport(wrapperPath, {
			...vmScope(),
			runtimeRoot,
			markNativeRuntime: () => {
				nativeRuntimeMarked = true;
			},
		});
		expect(result.default.delegated).to.equal(true);
		expect(nativeRuntimeMarked).to.equal(true);
	});

	it('delegates compartment .node imports and marks the runtime opaque', async () => {
		const entryPath = join(runtimeRoot, 'entry.mjs');
		writeFileSync(entryPath, "import addon from './addon.node'; export default addon;\n");
		let nativeRuntimeMarked = false;
		require.extensions['.node'] = (module) => {
			module.exports = { delegated: true };
		};
		const result = await scopedImport(entryPath, {
			mode: 'compartment',
			runtimeRoot,
			allowedPath: runtimeRoot,
			resources: {},
			markNativeRuntime: () => {
				nativeRuntimeMarked = true;
			},
		});
		expect(result.default.delegated).to.equal(true);
		expect(nativeRuntimeMarked).to.equal(true);
	});

	it('delegates ESM .node imports and marks the runtime opaque', async () => {
		const entryPath = join(runtimeRoot, 'entry.mjs');
		writeFileSync(entryPath, "import addon from './addon.node'; export default addon;\n");
		let nativeRuntimeMarked = false;
		require.extensions['.node'] = (module) => {
			module.exports = { delegated: true };
		};
		const result = await scopedImport(entryPath, {
			...vmScope(),
			runtimeRoot,
			markNativeRuntime: () => {
				nativeRuntimeMarked = true;
			},
		});
		expect(result.default.delegated).to.equal(true);
		expect(nativeRuntimeMarked).to.equal(true);
	});

	it('does not mark a failed optional native load as opaque', async () => {
		const wrapperPath = join(runtimeRoot, 'wrapper.cjs');
		writeFileSync(
			wrapperPath,
			"try { module.exports = require('./addon.node'); } catch { module.exports = { fallback: true }; }\n"
		);
		let nativeRuntimeMarked = false;
		require.extensions['.node'] = () => {
			throw new Error('ABI mismatch');
		};
		const result = await scopedImport(wrapperPath, {
			...vmScope(),
			runtimeRoot,
			markNativeRuntime: () => {
				nativeRuntimeMarked = true;
			},
		});
		expect(result.default.fallback).to.equal(true);
		expect(nativeRuntimeMarked).to.equal(false);
	});

	it('rejects a CJS native addon outside allowedPath', async () => {
		const allowedPath = join(runtimeRoot, 'allowed');
		const wrapperPath = join(allowedPath, 'wrapper.cjs');
		mkdirSync(allowedPath);
		writeFileSync(wrapperPath, "module.exports = require('../addon.node');\n");
		require.extensions['.node'] = (module) => {
			module.exports = { delegated: true };
		};
		let error;
		try {
			await scopedImport(wrapperPath, { ...vmScope(), runtimeRoot, allowedPath });
		} catch (caught) {
			error = caught;
		}
		expect(error?.message).to.include('outside of allowed path');
	});
});

for (const mode of ['vm-current-context', 'vm']) {
	describe(`CommonJS require (${mode})`, () => {
		let runtimeRoot;
		let loadedModules;
		let nativeRuntimeMarked;
		const loaderScope = (options = {}) => ({
			mode,
			runtimeRoot,
			allowedPath: runtimeRoot,
			resources: {},
			recordLoadedModule: (url, source) => loadedModules.set(url, source.toString()),
			markNativeRuntime: () => (nativeRuntimeMarked = true),
			...options,
		});
		const writePackage = (name, packageJson = {}) => {
			const packageRoot = join(runtimeRoot, 'node_modules', name);
			mkdirSync(packageRoot, { recursive: true });
			writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, main: 'index.js', ...packageJson }));
			writeFileSync(join(packageRoot, 'index.js'), 'module.exports = { marker: {} };\n');
			return join(packageRoot, 'index.js');
		};
		const loadedUrl = (path) => pathToFileURL(path).toString();

		beforeEach(() => {
			runtimeRoot = mkdtempSync(join(realpathSync(tmpdir()), 'harper-js-loader-cjs-'));
			loadedModules = new Map();
			nativeRuntimeMarked = false;
		});
		afterEach(() => rmSync(runtimeRoot, { recursive: true, force: true }));

		it('passes filesystem paths as __filename and __dirname', async () => {
			writeFileSync(join(runtimeRoot, 'paths.cjs'), 'module.exports = { filename: __filename, dirname: __dirname };\n');
			writeFileSync(join(runtimeRoot, 'entry.cjs'), "module.exports = require('./paths.cjs');\n");
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope());
			expect(result.filename).to.equal(join(runtimeRoot, 'paths.cjs'));
			expect(result.dirname).to.equal(runtimeRoot);
		});

		it('strips TypeScript types from a required .ts file and records its source as read', async () => {
			const typedSource = "interface Shape { value: string }\nconst shape: Shape = { value: 'stripped' };\nmodule.exports = shape;\n";
			writeFileSync(join(runtimeRoot, 'typed.ts'), typedSource);
			writeFileSync(join(runtimeRoot, 'entry.cjs'), "module.exports = require('./typed.ts');\n");
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope());
			expect(result.value).to.equal('stripped');
			expect(loadedModules.get(loadedUrl(join(runtimeRoot, 'typed.ts')))).to.equal(typedSource);
		});

		it('still strips TypeScript types from an imported ESM .ts file', async () => {
			writeFileSync(join(runtimeRoot, 'typed.ts'), "export const value: string = 'stripped';\n");
			writeFileSync(join(runtimeRoot, 'entry.mjs'), "export { value } from './typed.ts';\n");
			const result = await scopedImport(join(runtimeRoot, 'entry.mjs'), loaderScope());
			expect(result.value).to.equal('stripped');
		});

		it('requires a dependency natively under dependencyLoader: native, as import() does', async () => {
			const probePath = writePackage('native-probe');
			writeFileSync(join(runtimeRoot, 'local.cjs'), 'module.exports = {};\n');
			writeFileSync(
				join(runtimeRoot, 'entry.cjs'),
				"exports.viaRequire = require('native-probe');\n" +
					"exports.viaImport = () => import('native-probe');\n" +
					"exports.local = require('./local.cjs');\n"
			);
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope({ dependencyLoader: 'native' }));
			expect(result.viaRequire).to.equal(require(probePath));
			expect((await result.viaImport()).default).to.equal(result.viaRequire);
			expect(loadedModules.has(loadedUrl(join(runtimeRoot, 'local.cjs')))).to.equal(true);
			expect(nativeRuntimeMarked).to.equal(false);
		});

		it('routes required dependencies by whether they depend on harper under dependencyLoader: auto', async () => {
			const plainPath = writePackage('plain-probe');
			const harperDependentPath = writePackage('@scoped/harper-probe', { dependencies: { harper: '*' } });
			writeFileSync(
				join(runtimeRoot, 'entry.cjs'),
				"exports.plain = require('plain-probe');\nexports.harperDependent = require('@scoped/harper-probe');\n"
			);
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope());
			expect(result.plain).to.equal(require(plainPath));
			expect(loadedModules.has(loadedUrl(plainPath))).to.equal(false);
			expect(loadedModules.has(loadedUrl(harperDependentPath))).to.equal(true);
		});

		it('keeps required dependencies in the application loader under dependencyLoader: app', async () => {
			const probePath = writePackage('app-probe');
			writeFileSync(join(runtimeRoot, 'entry.cjs'), "module.exports = require('app-probe');\n");
			await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope({ dependencyLoader: 'app' }));
			expect(loadedModules.has(loadedUrl(probePath))).to.equal(true);
		});

		it('marks the runtime opaque before natively evaluating an application-local module', async () => {
			writeFileSync(
				join(runtimeRoot, 'package.json'),
				JSON.stringify({ name: 'native-local', imports: { '#helper': './helper.cjs' } })
			);
			writeFileSync(join(runtimeRoot, 'helper.cjs'), "throw new Error('helper failed');\n");
			writeFileSync(
				join(runtimeRoot, 'entry.cjs'),
				"try { require('#helper'); } catch (error) { exports.failure = error.message; }\n"
			);
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope({ dependencyLoader: 'native' }));
			expect(result.failure).to.equal('helper failed');
			expect(nativeRuntimeMarked).to.equal(true);
			expect(loadedModules.has(loadedUrl(join(runtimeRoot, 'helper.cjs')))).to.equal(false);
		});

		it('propagates an evaluation error instead of retrying the module as ESM', async () => {
			writeFileSync(join(runtimeRoot, 'bad.cjs'), 'module.exports.value ====\n');
			writeFileSync(join(runtimeRoot, 'requires-bad.cjs'), "module.exports = require('./bad.cjs');\n");
			writeFileSync(join(runtimeRoot, 'throws.cjs'), "module.exports = {};\nthrow new Error('failed to import settings');\n");
			const failure = (file) =>
				scopedImport(join(runtimeRoot, file), loaderScope()).then(
					() => expect.fail(`${file} should not load`),
					(error) => error
				);
			expect((await failure('throws.cjs')).message).to.equal('failed to import settings');
			const syntaxError = await failure('requires-bad.cjs');
			expect(syntaxError.name).to.equal('SyntaxError');
			expect(syntaxError.stack).to.include('bad.cjs');
		});

		it('evaluates a module again after its evaluation threw, as Node does', async () => {
			writeFileSync(join(runtimeRoot, 'failing.cjs'), "throw new Error('evaluation failed');\n");
			writeFileSync(
				join(runtimeRoot, 'entry.cjs'),
				"const attempt = () => { try { require('./failing.cjs'); return 'loaded'; } catch (error) { return error.message; } };\n" +
					'exports.first = attempt();\nexports.second = attempt();\n'
			);
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope());
			expect(result.first).to.equal('evaluation failed');
			expect(result.second).to.equal('evaluation failed');
		});

		it('hands a circular require the incomplete module and repeats return one instance', async () => {
			writeFileSync(join(runtimeRoot, 'a.cjs'), "exports.name = 'a';\nexports.fromB = require('./b.cjs').fromA;\n");
			writeFileSync(join(runtimeRoot, 'b.cjs'), "exports.fromA = require('./a.cjs').name;\n");
			writeFileSync(
				join(runtimeRoot, 'entry.cjs'),
				"exports.fromB = require('./a.cjs').fromB;\nexports.same = require('./b.cjs') === require('./b.cjs');\n"
			);
			const result = await scopedImport(join(runtimeRoot, 'entry.cjs'), loaderScope());
			expect(result.fromB).to.equal('a');
			expect(result.same).to.equal(true);
		});
	});
}
