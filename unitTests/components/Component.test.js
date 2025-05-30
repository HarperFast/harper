/* eslint-disable @typescript-eslint/no-require-imports, sonarjs/void-use, sonarjs/assertions-in-tests, sonarjs/no-nested-functions */
// Not sure why sonar cannot pick up the assertions within the tests. I think its because they are `async`.

const { tmpdir } = require('node:os');
const {
	processResourceExtensionComponent,
	Component,
	InvalidFilesOptionError,
	InvalidGlobPattern,
	InvalidFilesSourceOptionError,
	InvalidFilesOnlyOptionError,
	InvalidFileIgnoreOptionError,
	InvalidRootOptionError,
	InvalidPathOptionError,
	InvalidURLPathOptionError,
} = require('../../components/Component');
const { Resources } = require('../../resources/Resources');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { fake, restore, replace } = require('sinon');
const fg = require('fast-glob');

const TEMP_DIR_PATH = join(tmpdir(), 'harper.unit-test.component-');

function createFixture(dirPath, fixture) {
	mkdirSync(dirPath, { recursive: true });
	for (const entry of fixture) {
		if (typeof entry === 'string') {
			writeFileSync(join(dirPath, entry), entry);
		} else {
			createFixture(join(dirPath, entry[0]), entry[1]);
		}
	}
}

function createTempFixture(fixture) {
	const root = mkdtempSync(TEMP_DIR_PATH);

	createFixture(root, fixture);

	return root;
}

describe('Component', () => {
	const componentName = 'test-component';

	const harperLogger = require('../../utility/logging/harper_logger');

	beforeEach(() => {
		replace(harperLogger, 'warn', fake());
	});

	afterEach(() => {
		restore();
	});

	after(() => {
		// Cleanup temp directories. Comment this line to debug.
		for (const dir of fg.sync(`${TEMP_DIR_PATH}*`, { onlyDirectories: true })) {
			rmSync(dir, { recursive: true });
		}
	});

	describe('with a valid directory structure', () => {
		// Many assertions depend on the exact structure of this variable. Modify with caution.
		const fixture = ['a', 'b', 'c', ['web', ['d', 'e', ['static', ['f', 'g']]]]];

		const componentDirPath = createTempFixture(fixture);

		describe("with pattern '*'", () => {
			const source = '*';

			async function init(config) {
				const handleDirectoryFake = fake(),
					handleFileFake = fake();

				const resources = new Resources();

				const component = new Component({
					config,
					name: componentName,
					directory: componentDirPath,
					module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
					resources,
				});

				const hasFunctionality = await processResourceExtensionComponent(component);

				return { handleDirectoryFake, handleFileFake, hasFunctionality, resources };
			}

			function assertFiles(fileFake, resources) {
				assert.equal(fileFake.callCount, 3);
				assert.deepEqual(fileFake.getCall(0).args, [Buffer.from('a'), `/a`, join(componentDirPath, 'a'), resources]);
				assert.deepEqual(fileFake.getCall(1).args, [Buffer.from('b'), `/b`, join(componentDirPath, 'b'), resources]);
				assert.deepEqual(fileFake.getCall(2).args, [Buffer.from('c'), `/c`, join(componentDirPath, 'c'), resources]);
			}

			function assertDirectories(directoryFake, resources) {
				assert.equal(directoryFake.callCount, 2);
				assert.deepEqual(directoryFake.getCall(0).args, ['/', componentDirPath, resources]);
				assert.deepEqual(directoryFake.getCall(1).args, ['/web', join(componentDirPath, 'web'), resources]);
			}

			it('should resolve correctly with configuration defaults', async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({ files: source });

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assertDirectories(handleDirectoryFake, resources);
			});

			it("should resolve correctly with configuration `only: 'all'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'all' },
				});

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assertDirectories(handleDirectoryFake, resources);
			});

			it("should resolve correctly with configuration `only: 'files'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'files' },
				});

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assert.equal(handleDirectoryFake.callCount, 0);
			});

			it("should resolve correctly with configuration `only: 'directories'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'directories' },
				});

				assert.ok(hasFunctionality);

				assert.equal(handleFileFake.callCount, 0);

				assertDirectories(handleDirectoryFake, resources);
			});

			it('should call setup methods instead of handle when in main thread', async () => {
				const setupDirectoryFake = fake(),
					handleDirectoryFake = fake(),
					setupFileFake = fake(),
					handleFileFake = fake();

				const resources = new Resources();
				resources.isWorker = false;

				const component = new Component({
					config: { files: source },
					name: componentName,
					directory: componentDirPath,
					module: {
						setupDirectory: setupDirectoryFake,
						handleDirectory: handleDirectoryFake,
						setupFile: setupFileFake,
						handleFile: handleFileFake,
					},
					resources,
				});

				const hasFunctionality = await processResourceExtensionComponent(component);

				assert.ok(hasFunctionality);

				assert.equal(handleFileFake.callCount, 0);
				assertFiles(setupFileFake, resources);

				assert.equal(handleDirectoryFake.callCount, 0);
				assertDirectories(setupDirectoryFake, resources);
			});

			it('should warn about deprecated `root` option and handle it appropriately', async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: '*',
					root: 'web',
				});

				assert.ok(hasFunctionality);

				assert.deepEqual(harperLogger.warn.getCall(0).args, [
					`Resource extension 'root' option is deprecated. Due to backwards compatibility reasons it does not act as assumed. The glob pattern will always be evaluated from the component directory root. The option is only used for the initial root directory handling. Please remove and modify the 'files' glob pattern instead.`,
				]);

				assertFiles(handleFileFake, resources);

				assert.equal(handleDirectoryFake.callCount, 2);
				assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web', '/'), resources]);
				assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/web', join(componentDirPath, 'web'), resources]);
			});
		});

		describe("with pattern '**/*'", () => {
			const source = '**/*';

			async function init(config) {
				const handleDirectoryFake = fake(),
					handleFileFake = fake();

				const resources = new Resources();

				const component = new Component({
					config,
					name: componentName,
					directory: componentDirPath,
					module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
					resources,
				});

				const hasFunctionality = await processResourceExtensionComponent(component);

				return { handleDirectoryFake, handleFileFake, hasFunctionality, resources };
			}

			function assertFiles(fileFake, resources) {
				assert.equal(fileFake.callCount, 7);
				assert.deepEqual(fileFake.getCall(0).args, [Buffer.from('a'), `/a`, join(componentDirPath, 'a'), resources]);
				assert.deepEqual(fileFake.getCall(1).args, [Buffer.from('b'), `/b`, join(componentDirPath, 'b'), resources]);
				assert.deepEqual(fileFake.getCall(2).args, [Buffer.from('c'), `/c`, join(componentDirPath, 'c'), resources]);
				assert.deepEqual(fileFake.getCall(3).args, [
					Buffer.from('d'),
					`/web/d`,
					join(componentDirPath, 'web', 'd'),
					resources,
				]);
				assert.deepEqual(fileFake.getCall(4).args, [
					Buffer.from('e'),
					`/web/e`,
					join(componentDirPath, 'web', 'e'),
					resources,
				]);
				assert.deepEqual(fileFake.getCall(5).args, [
					Buffer.from('f'),
					`/web/static/f`,
					join(componentDirPath, 'web', 'static', 'f'),
					resources,
				]);
				assert.deepEqual(fileFake.getCall(6).args, [
					Buffer.from('g'),
					`/web/static/g`,
					join(componentDirPath, 'web', 'static', 'g'),
					resources,
				]);
			}

			function assertDirectories(directoryFake, resources) {
				assert.equal(directoryFake.callCount, 3);
				assert.deepEqual(directoryFake.getCall(0).args, ['/', componentDirPath, resources]);
				assert.deepEqual(directoryFake.getCall(1).args, ['/web', join(componentDirPath, 'web'), resources]);
				assert.deepEqual(directoryFake.getCall(2).args, [
					'/web/static',
					join(componentDirPath, 'web', 'static'),
					resources,
				]);
			}

			it('should resolve correctly with configuration defaults', async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({ files: source });

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assertDirectories(handleDirectoryFake, resources);
			});

			it("should resolve correctly with configuration `only: 'all'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'all' },
				});

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assertDirectories(handleDirectoryFake, resources);
			});

			it("should resolve correctly with configuration `only: 'files'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'files' },
				});

				assert.ok(hasFunctionality);

				assertFiles(handleFileFake, resources);

				assert.equal(handleDirectoryFake.callCount, 0);
			});

			it("should resolve correctly with configuration `only: 'directories'`", async () => {
				const { handleDirectoryFake, handleFileFake, hasFunctionality, resources } = await init({
					files: { source, only: 'directories' },
				});

				assert.ok(hasFunctionality);

				assert.equal(handleFileFake.callCount, 0);

				assertDirectories(handleDirectoryFake, resources);
			});
		});

		it("should warn about leading '/' and resolve it relative to root", async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: '/' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.deepEqual(harperLogger.warn.getCall(0).args, [
				`Leading '/' in 'files' glob pattern is deprecated. For backwards compatibility purposes, it is currently transformed to the relative path of the component, but in the future will result in an error. Paths are automatically derived from the root of the component directory. Please remove (e.g. '/web/*' -> 'web/*').`,
			]);

			assert.equal(handleFileFake.callCount, 0);

			// The double call matches the behavior of the original implementation.
			// Essentially the first call happens from the root path handling, and the second from the actual match operation
			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/', componentDirPath, resources]);
		});

		it("should warn about leading '/' and resolve it relative to root with glob star", async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: '/*' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.deepEqual(harperLogger.warn.getCall(0).args, [
				`Leading '/' in 'files' glob pattern is deprecated. For backwards compatibility purposes, it is currently transformed to the relative path of the component, but in the future will result in an error. Paths are automatically derived from the root of the component directory. Please remove (e.g. '/web/*' -> 'web/*').`,
			]);

			assert.equal(handleFileFake.callCount, 3);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('a'),
				`/a`,
				join(componentDirPath, 'a'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('b'),
				`/b`,
				join(componentDirPath, 'b'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('c'),
				`/c`,
				join(componentDirPath, 'c'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/web', join(componentDirPath, 'web'), resources]);
		});

		it('should prepend urlPath', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: './*', urlPath: 'foo' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 3);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('a'),
				`/foo/a`,
				join(componentDirPath, 'a'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('b'),
				`/foo/b`,
				join(componentDirPath, 'b'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('c'),
				`/foo/c`,
				join(componentDirPath, 'c'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/foo/', join(componentDirPath, '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/foo/web', join(componentDirPath, 'web'), resources]);
		});

		it("should warn about deprecated 'path' option, and handle it as 'urlPath'", async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: './*', path: 'foo' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.deepEqual(harperLogger.warn.getCall(0).args, [
				`Resource extension 'path' option is deprecated. Please replace with 'urlPath'.`,
			]);

			assert.equal(handleFileFake.callCount, 3);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('a'),
				`/foo/a`,
				join(componentDirPath, 'a'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('b'),
				`/foo/b`,
				join(componentDirPath, 'b'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('c'),
				`/foo/c`,
				join(componentDirPath, 'c'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/foo/', join(componentDirPath, '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/foo/web', join(componentDirPath, 'web'), resources]);
		});

		it('should resolve glob pattern `<dir>/*` correctly', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/*' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 2);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('d'),
				`/d`,
				join(componentDirPath, 'web', 'd'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web', '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, [
				'/static',
				join(componentDirPath, 'web', 'static'),
				resources,
			]);
		});

		it('should resolve glob pattern `<dir>/**/*` correctly', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/**/*' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 4);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('d'),
				`/d`,
				join(componentDirPath, 'web', 'd'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('f'),
				`/static/f`,
				join(componentDirPath, 'web', 'static', 'f'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(3).args, [
				Buffer.from('g'),
				`/static/g`,
				join(componentDirPath, 'web', 'static', 'g'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, [
				'/static',
				join(componentDirPath, 'web', 'static'),
				resources,
			]);
		});

		it('should handle `root` option when it matches the file pattern', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/**', root: 'web' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.deepEqual(harperLogger.warn.getCall(0).args, [
				`Resource extension 'root' option is deprecated. Due to backwards compatibility reasons it does not act as assumed. The glob pattern will always be evaluated from the component directory root. The option is only used for the initial root directory handling. Please remove and modify the 'files' glob pattern instead.`,
			]);

			assert.equal(handleFileFake.callCount, 4);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('d'),
				`/d`,
				join(componentDirPath, 'web', 'd'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('f'),
				`/static/f`,
				join(componentDirPath, 'web', 'static', 'f'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(3).args, [
				Buffer.from('g'),
				`/static/g`,
				join(componentDirPath, 'web', 'static', 'g'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web', '/'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, [
				'/static',
				join(componentDirPath, 'web', 'static'),
				resources,
			]);
		});

		it('should resolve all files and directories within the specified directory glob', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/**/*' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 4);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('d'),
				`/d`,
				join(componentDirPath, 'web', 'd'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(2).args, [
				Buffer.from('f'),
				`/static/f`,
				join(componentDirPath, 'web', 'static', 'f'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(3).args, [
				Buffer.from('g'),
				`/static/g`,
				join(componentDirPath, 'web', 'static', 'g'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, [
				'/static',
				join(componentDirPath, 'web', 'static'),
				resources,
			]);
		});

		it('should resolve a specific file', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/e' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 1);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 1);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, [
				'/',
				// The trailing slash is a backwards compat thing related to the `rootPath` handling
				join(componentDirPath, 'web') + '/',
				resources,
			]);
		});

		it('should resolve a specific directory', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();
			const component = new Component({
				config: { files: 'web' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});
			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 0);

			assert.equal(handleDirectoryFake.callCount, 2);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web'), resources]);
			assert.deepEqual(handleDirectoryFake.getCall(1).args, ['/', join(componentDirPath, 'web'), resources]);
		});

		it('should ignore specified files', async () => {
			const handleDirectoryFake = fake(),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: { source: 'web/**/*', ignore: ['**/static/**'] } },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 2);
			assert.deepEqual(handleFileFake.getCall(0).args, [
				Buffer.from('d'),
				`/d`,
				join(componentDirPath, 'web', 'd'),
				resources,
			]);
			assert.deepEqual(handleFileFake.getCall(1).args, [
				Buffer.from('e'),
				`/e`,
				join(componentDirPath, 'web', 'e'),
				resources,
			]);

			assert.equal(handleDirectoryFake.callCount, 1);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web'), resources]);
		});

		it('should return early if root handleDirectory returns true', async () => {
			const handleDirectoryFake = fake.returns(true),
				handleFileFake = fake();

			const resources = new Resources();

			const component = new Component({
				config: { files: 'web/*' },
				name: componentName,
				directory: componentDirPath,
				module: { handleDirectory: handleDirectoryFake, handleFile: handleFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(handleFileFake.callCount, 0);

			assert.equal(handleDirectoryFake.callCount, 1);
			assert.deepEqual(handleDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web', '/'), resources]);
		});

		it('should return early if root setupDirectory returns true', async () => {
			const setupDirectoryFake = fake.returns(true),
				setupFileFake = fake();

			const resources = new Resources();
			resources.isWorker = false;

			const component = new Component({
				config: { files: 'web/*' },
				name: componentName,
				directory: componentDirPath,
				module: { setupDirectory: setupDirectoryFake, setupFile: setupFileFake },
				resources,
			});

			const hasFunctionality = await processResourceExtensionComponent(component);

			assert.ok(hasFunctionality);

			assert.equal(setupFileFake.callCount, 0);

			assert.equal(setupDirectoryFake.callCount, 1);
			assert.deepEqual(setupDirectoryFake.getCall(0).args, ['/', join(componentDirPath, 'web', '/'), resources]);
		});
	});

	describe('options validation', () => {
		it('should throw an error if files is not a non-empty string, array of non-empty strings, or an object', () => {
			for (const invalid of [null, undefined, 1, true, Symbol('foo'), '', '\n', '\t', '\r\n', '   ', ['']]) {
				const componentDetails = {
					config: { files: invalid },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidFilesOptionError(componentDetails));
			}
		});

		it('should throw an error if files.source is invalid', () => {
			for (const invalid of [null, undefined, 1, true, Symbol('foo'), '', [], ['']]) {
				const componentDetails = {
					config: { files: { source: invalid } },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidFilesSourceOptionError(componentDetails));
			}
		});

		it('should throw an error if files.only is invalid', () => {
			for (const invalid of [null, 1, true, {}, [], Symbol('foo'), 'bar']) {
				const componentDetails = {
					config: { files: { source: '*', only: invalid } },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidFilesOnlyOptionError(componentDetails));
			}
		});

		it('should throw an error if files.ignore is invalid', () => {
			for (const invalid of [null, 1, true, {}, Symbol('foo'), '', [], ['']]) {
				const componentDetails = {
					config: { files: { source: '*', ignore: invalid } },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidFileIgnoreOptionError(componentDetails));
			}
		});

		it('should throw an error if root is invalid', () => {
			for (const invalid of [null, 1, true, {}, [], Symbol('foo'), '']) {
				const componentDetails = {
					config: { files: '*', root: invalid },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidRootOptionError(componentDetails));
			}
		});

		it('should throw an error if path is invalid', () => {
			for (const invalid of [null, 1, true, {}, [], Symbol('foo'), '']) {
				const componentDetails = {
					config: { files: '*', path: invalid },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidPathOptionError(componentDetails));
			}
		});

		it(`should throw an error if urlPath is invalid`, () => {
			for (const invalid of [null, 1, true, {}, [], '', '..']) {
				const componentDetails = {
					config: { files: '*', urlPath: invalid },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(() => new Component(componentDetails), new InvalidURLPathOptionError(componentDetails));
			}
		});

		it('should throw an error if the files option contains `..` as a string', async () => {
			for (const files of ['..', './..', 'static/../..']) {
				const componentDetails = {
					config: { files },
					name: componentName,
					directory: 'fake-directory',
					module: {},
					resources: new Resources(),
				};
				assert.throws(
					() => {
						const component = new Component(componentDetails);
						void component.globOptions;
					},
					new InvalidGlobPattern(componentDetails, files)
				);
			}
		});

		it('should throw an error if the files option contains `..` as an array', async () => {
			const componentDetails = {
				config: { files: ['static', '..'] },
				name: componentName,
				directory: 'fake-directory',
				module: {},
				resources: new Resources(),
			};
			assert.throws(
				() => {
					const component = new Component(componentDetails);
					void component.globOptions;
				},
				new InvalidGlobPattern(componentDetails, '..')
			);
		});

		it('should throw an error if the files.source option contains `..` as a string', async () => {
			const componentDetails = {
				config: { files: { source: 'static/../..' } },
				name: componentName,
				directory: 'fake-directory',
				module: {},
				resources: new Resources(),
			};
			assert.throws(
				() => {
					const component = new Component(componentDetails);
					void component.globOptions;
				},
				new InvalidGlobPattern(componentDetails, 'static/../..')
			);
		});

		it('should throw an error if the files.source option contains `..` as an array', async () => {
			const componentDetails = {
				config: { files: { source: ['static', '..'] } },
				name: componentName,
				directory: 'fake-directory',
				module: {},
				resources: new Resources(),
			};
			assert.throws(
				() => {
					const component = new Component(componentDetails);
					void component.globOptions;
				},
				new InvalidGlobPattern(componentDetails, '..')
			);
		});
	});
});
