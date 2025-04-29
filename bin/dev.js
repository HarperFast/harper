// once we have typestrip working, we can auto disable compilation with process.versions.node < '23'
if (__filename.endsWith('dev.js') && !process.env.HARPER_SKIP_COMPILE) {
	const fg = require('fast-glob');
	const { tmpdir } = require('node:os');
	const { relative, join } = require('node:path');
	const { existsSync, statSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs');
	const { isMainThread } = require('node:worker_threads');
	const { spawnSync, spawn } = require('node:child_process');

	// Enable source maps for TypeScript debugging.
	// These methods are specifically marked as "experimental", and we should
	// replace them with `module.getSourceMapsSupport()` and
	// `module.setSourceMapsSupport()` when our minimum Node version is 22.
	process.setSourceMapsEnabled(true);

	const { PACKAGE_ROOT } = require('../utility/packageUtils.js');

	const SRC_DIRECTORIES = [
		'bin',
		'components',
		'dataLayer',
		'resources',
		'server',
		'sqlTranslator',
		'upgrade',
		'utility',
		'validation',
	];
	const TS_DIRECTORY = 'ts-build';

	if (isMainThread) {
		let needsCompile = false;
		let buildDirectoryExists = false;
		if ((buildDirectoryExists = existsSync(join(PACKAGE_ROOT, TS_DIRECTORY)))) {
			let existingTSFiles = new Set();
			fg.sync(
				SRC_DIRECTORIES.map((dir) => `${dir}/**/*.ts`),
				{ cwd: PACKAGE_ROOT }
			).forEach((file) => {
				let sourceTime = 0;
				let compiledTime = 0;

				try {
					existingTSFiles.add(file);
					sourceTime = statSync(join(PACKAGE_ROOT, file)).mtimeMs - 5000;
					compiledTime = statSync(join(PACKAGE_ROOT, TS_DIRECTORY, file.replace(/.ts$/, '.js'))).mtimeMs;
				} catch (_) {}

				if (sourceTime > compiledTime) needsCompile = true;
			});
			fg.sync(
				SRC_DIRECTORIES.map((dir) => `${dir}/**/*.js`),
				{ cwd: join(PACKAGE_ROOT, TS_DIRECTORY) }
			).forEach((file) => {
				if (!existingTSFiles.has(file.replace(/.js$/, '.ts'))) {
					try {
						unlinkSync(join(PACKAGE_ROOT, TS_DIRECTORY, file));
					} catch (_) {}
				}
			});
		} else {
			needsCompile = true;
		}

		if (needsCompile) {
			console.log('Compiling TypeScript...');

			const result = spawnSync('npx', ['tsc'], { cwd: PACKAGE_ROOT });
			if (result.stdout?.length) console.log(result.stdout.toString());
			if (result.stderr?.length) console.log(result.stderr.toString());

			if (buildDirectoryExists) {
				const pidPath = join(tmpdir(), 'harperdb-tsc.pid');
				let isRunning = false;
				if (existsSync(pidPath)) {
					try {
						process.kill(+readFileSync(pidPath, 'utf8'), 0);
						isRunning = true;
					} catch {}
				}

				if (!isRunning) {
					console.log('Starting background TypeScript compilation...');
					const tscProcess = spawn('npx', ['tsc', '--watch'], { detached: true, cwd: PACKAGE_ROOT, stdio: 'ignore' });
					tscProcess.on('error', (error) => {
						console.error('Error trying to compile TypeScript', error);
					});
					if (tscProcess.pid) writeFileSync(pidPath, String(tscProcess.pid), 'utf-8');
					tscProcess.unref();
				}
			}
		}
	}

	let Module = module.constructor;
	let findPath = Module._findPath;
	/**
	 * Hack the node module system to make it so we can load the TypeScript compiled modules from a separate directory
	 * *and* load JavaScript files from their existing source directory. This is just intended for source/dev use, and
	 * should be skipped in our built version. But this allows us to keep TypeScript alongside JavaScript while having
	 * the built output in separate directory so we can easily gitignore all the built modules.
	 */
	Module._findPath = function (request, paths, isMain) {
		if (
			request.startsWith('.') &&
			!isMain &&
			paths.length === 1 &&
			paths[0].startsWith(PACKAGE_ROOT) &&
			!paths[0].includes('node_modules')
		) {
			// relative reference in our code base
			let path = relative(PACKAGE_ROOT, paths[0]);
			let alternate;
			if (path.startsWith(TS_DIRECTORY)) {
				alternate = join(PACKAGE_ROOT, relative(TS_DIRECTORY, path));
			} else {
				alternate = join(PACKAGE_ROOT, TS_DIRECTORY, path);
			}
			if (request.endsWith('.js') || request.endsWith('.ts')) {
				request = request.slice(0, -3);
			}
			let baseFilename = join(alternate, request);
			let filename = baseFilename + '.js';
			if (existsSync(filename)) return filename;
			if (baseFilename.includes('.') && existsSync(baseFilename)) return baseFilename;
		}
		return findPath(request, paths, isMain);
	};
}
