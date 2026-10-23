'use strict';

const assert = require('node:assert');
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
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
		const loadedShims = [...loaderSource.matchAll(/require\('ses\/([\w-]+-shim\.js)'\)/g)].map((match) => match[1]);
		expect(sesShims).to.have.length.above(0);
		expect(loadedShims).to.deep.equal(sesShims);
	});
});

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
				writeFileSync(join(runtimeRoot, 'entry.mjs'), "export { value } from 'bun-esm-only-pkg';\n");
				Object.defineProperty(process.versions, 'bun', { configurable: true, value: 'test' });

				const result = await scopedImport(join(runtimeRoot, 'entry.mjs'), loaderScope(runtimeRoot));
				expect(result.value).to.equal('bun-esm-only');
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
	});
}

describe('compartment importHook', () => {
	const OUTSIDE_ALLOWED_PATH = /Can not load module at .* outside of allowed path/;
	let root;
	let appDir;
	let outsideDir;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'js-loader-compartment-')));
		appDir = join(root, 'app');
		outsideDir = join(root, 'outside');
		mkdirSync(appDir);
		mkdirSync(outsideDir);
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	const compartmentScope = (overrides = {}) => ({
		mode: 'compartment',
		runtimeRoot: appDir,
		allowedPath: appDir,
		resources: {},
		...overrides,
	});
	const writeApp = (name, source) => {
		const file = join(appDir, name);
		writeFileSync(file, source);
		return file;
	};
	const writePackage = (name, files, packageJson = {}) => {
		const packageDir = join(appDir, 'node_modules', name);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...packageJson }));
		for (const [file, source] of Object.entries(files)) writeFileSync(join(packageDir, file), source);
	};

	describe('allowedPath', () => {
		let secretPath;
		beforeEach(() => {
			secretPath = join(outsideDir, 'secret.js');
			writeFileSync(secretPath, "export const secret = 'leaked';\n");
		});

		it('refuses a relative import of a plain file outside allowedPath', async () => {
			const entry = writeApp('entry.js', "export { secret } from '../outside/secret.js';\n");
			await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses an absolute import of a plain file outside allowedPath', async () => {
			const entry = writeApp('entry.js', `export { secret } from ${JSON.stringify(secretPath)};\n`);
			await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses a file: URL import of a plain file outside allowedPath', async () => {
			const entry = writeApp('entry.js', `export { secret } from ${JSON.stringify(pathToFileURL(secretPath).href)};\n`);
			await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses an import through a symlink that points outside allowedPath', async () => {
			symlinkSync(secretPath, join(appDir, 'link.js'));
			const entry = writeApp('entry.js', "export { secret } from './link.js';\n");
			await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses an entry module outside allowedPath', async () => {
			await assert.rejects(scopedImport(secretPath, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses a transitive import from an allowed module', async () => {
			writeApp('hop.js', "export { secret } from '../outside/secret.js';\n");
			const entry = writeApp('entry.js', "export { secret } from './hop.js';\n");
			await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH);
		});

		it('refuses JSON and TypeScript files outside allowedPath', async () => {
			writeFileSync(join(outsideDir, 'data.json'), '{"secret":"leaked"}');
			writeFileSync(join(outsideDir, 'typed.ts'), "export const secret: string = 'leaked';\n");
			for (const target of ['data.json', 'typed.ts']) {
				const entry = writeApp(
					'entry.mjs',
					target.endsWith('.json')
						? `import data from '../outside/${target}' with { type: 'json' };\nexport default data;\n`
						: `export { secret } from '../outside/${target}';\n`
				);
				await assert.rejects(scopedImport(entry, compartmentScope()), OUTSIDE_ALLOWED_PATH, target);
			}
		});

		it('still loads modules inside allowedPath, including JSON and TypeScript', async () => {
			writeApp('dep.js', "export const inside = 'ok';\n");
			writeApp('data.json', '{"value":1}');
			writeApp('typed.ts', "export const typed: string = 'ts';\n");
			const entry = writeApp(
				'entry.mjs',
				"export { inside } from './dep.js';\nexport { typed } from './typed.ts';\n" +
					"import data from './data.json' with { type: 'json' };\nexport { data };\n"
			);
			const result = await scopedImport(entry, compartmentScope());
			assert.strictEqual(result.inside, 'ok');
			assert.strictEqual(result.typed, 'ts');
			assert.strictEqual(result.data.value, 1);
		});

		it('still loads node: built-ins', async () => {
			const entry = writeApp(
				'entry.mjs',
				"import { basename } from 'node:path';\nexport const name = basename('/a/b.js');\n"
			);
			assert.strictEqual((await scopedImport(entry, compartmentScope())).name, 'b.js');
		});

		it('loads a plain file outside the app directory when allowedPath is unrestricted', async () => {
			const entry = writeApp('entry.js', "export { secret } from '../outside/secret.js';\n");
			const result = await scopedImport(entry, compartmentScope({ allowedPath: '' }));
			assert.strictEqual(result.secret, 'leaked');
		});
	});

	describe('CommonJS dependencies imported natively', () => {
		const importKeys = async (specifierSource) => {
			const entry = writeApp('entry.mjs', specifierSource);
			return scopedImport(entry, compartmentScope());
		};

		it('exposes names assigned dynamically to module.exports', async () => {
			writePackage(
				'dynpkg',
				{
					'index.cjs':
						"module.exports = {};\nfor (const name of ['alpha', 'beta']) module.exports[name] = name + '!';\n",
				},
				{ main: 'index.cjs' }
			);
			const result = await importKeys(
				"import dynpkg, { alpha, beta } from 'dynpkg';\nexport { alpha, beta };\nexport const same = typeof dynpkg.alpha;\n"
			);
			assert.strictEqual(result.alpha, 'alpha!');
			assert.strictEqual(result.beta, 'beta!');
			assert.strictEqual(result.same, 'string');
		});

		it('keeps names that native import exposes but module.exports does not enumerate', async () => {
			writePackage(
				'hiddenpkg',
				{ 'index.cjs': "Object.defineProperty(exports, 'alpha', { value: 42 });\n" },
				{ main: 'index.cjs' }
			);
			const result = await importKeys("export { alpha } from 'hiddenpkg';\n");
			assert.strictEqual(result.alpha, 42);
		});

		it('keeps the native default export of a transpiled-ESM module', async () => {
			writePackage(
				'babelpkg',
				{
					'index.cjs':
						"'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nexports.default = 'X';\nexports.named = 'N';\n",
				},
				{ main: 'index.cjs' }
			);
			const result = await importKeys(
				"import babel, { named } from 'babelpkg';\nexport { named };\nexport const wrapped = babel.default;\n"
			);
			assert.strictEqual(result.named, 'N');
			assert.strictEqual(result.wrapped, 'X');
		});

		it('does not fail the import for a getter that throws', async () => {
			writePackage(
				'getterpkg',
				{
					'index.cjs':
						"exports.ok = 1;\nfor (const name of ['bad']) Object.defineProperty(exports, name, { enumerable: true, get() { throw new Error('unused getter'); } });\n",
				},
				{ main: 'index.cjs' }
			);
			const result = await importKeys("export { ok } from 'getterpkg';\n");
			assert.strictEqual(result.ok, 1);
		});

		it('adds no names for an array, string or buffer module.exports', async () => {
			const exportsByPackage = {
				arraypkg: "module.exports = ['a', 'b'];",
				stringpkg: "module.exports = 'text';",
				bufferpkg: "module.exports = Buffer.from('xy');",
			};
			for (const [name, source] of Object.entries(exportsByPackage)) {
				writePackage(name, { 'index.cjs': source }, { main: 'index.cjs' });
				const result = await importKeys(`import * as ns from '${name}';\nexport const keys = Object.keys(ns);\n`);
				assert.ok(!result.keys.includes('0'), `${name} exposed index names: ${result.keys}`);
				assert.ok(result.keys.includes('default'), name);
			}
		});

		it('does not promote the properties of an ES module default export to named exports', async () => {
			writePackage(
				'esmpkg',
				{ 'index.js': 'export default { hidden: 1 };\nexport const shown = 2;\n' },
				{ type: 'module', exports: { '.': { import: './index.js' } } }
			);
			const result = await importKeys("import * as ns from 'esmpkg';\nexport const keys = Object.keys(ns).sort();\n");
			assert.deepStrictEqual(result.keys, ['default', 'shown']);
		});
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
