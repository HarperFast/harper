'use strict';

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { scopedImport } = require('#src/security/jsLoader');
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
});

describe('pure-ESM package resolution', () => {
	// Regression test for https://github.com/HarperFast/harper/issues/826
	// Pure-ESM packages have an exports map with only "import" conditions and no "require".
	// createRequire().resolve() (CJS resolver) throws ERR_PACKAGE_PATH_NOT_EXPORTED for these;
	// the fix returns the raw specifier so createModule() falls through to dynamic import().
	it('should import a pure-ESM package (exports map with only "import" conditions, no "require")', async () => {
		const runtimeRoot = join(__dirname, 'fixtures', 'esm-only-test');
		const resolutions = [];
		const loadedModules = [];
		const result = await scopedImport(join(runtimeRoot, 'uses-pure-esm-pkg.mjs'), {
			...vmScope(),
			runtimeRoot,
			recordModuleResolution: (specifier) => resolutions.push(specifier),
			recordLoadedModule: (url) => loadedModules.push(url),
		});
		expect(result.value).to.equal('esm-only');
		expect(resolutions).not.to.include('pure-esm-pkg');
		expect(loadedModules.some((url) => url.endsWith('/pure-esm-pkg/package.json'))).to.equal(true);
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
			writeFileSync(join(runtimeRoot, 'entry.mjs'), "export { value } from 'bun-esm-only-pkg';\n");
			Object.defineProperty(process.versions, 'bun', { configurable: true, value: 'test' });

			const result = await scopedImport(join(runtimeRoot, 'entry.mjs'), { ...vmScope(), runtimeRoot });
			expect(result.value).to.equal('bun-esm-only');
		} finally {
			if (originalBun) Object.defineProperty(process.versions, 'bun', originalBun);
			else delete process.versions.bun;
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
