'use strict';

// A compile cache is process-wide once enabled, so each case runs in its own process instead of mocha's.
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const nodeModule = require('node:module');
const { join } = require('node:path');
const { cachedDataVersionTag } = require('node:v8');
const { setTimeout: sleep } = require('node:timers/promises');
const { HARPER_CONFIG_FILE } = require('#src/utility/hdbTerms');

const [rootPath, scenario] = process.argv.slice(2);
mkdirSync(join(rootPath, 'database'), { recursive: true });
// A complete config, because loading manageThreads reads it.
const defaultConfig = readFileSync(join(__dirname, '../../../../static/defaultConfig.yaml'), 'utf8');
writeFileSync(
	join(rootPath, HARPER_CONFIG_FILE),
	defaultConfig.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(rootPath)}`)
);
process.env.ROOTPATH = rootPath;
if (scenario === 'unsupported') nodeModule.enableCompileCache = undefined;

// No Node release frees accepted entries yet, so every case but this one opens the gate for the running version.
if (scenario !== 'gate-closed') {
	const { COMPILE_CACHE_FREES_ACCEPTED_ENTRIES } = require('#src/server/threads/compileCacheNodeReleases');
	COMPILE_CACHE_FREES_ACCEPTED_ENTRIES[Number(process.versions.node.split('.')[0])] = process.version;
}
const warnings = [];
const loggerModule = require('#src/utility/logging/harper_logger');
// the built module exports the logger itself; the TypeScript source has it as its default export
const logger = loggerModule.default ?? loggerModule;
const warn = logger.warn;
logger.warn = (...args) => {
	warnings.push(args.join(' '));
	return warn.apply(logger, args);
};
const { enableCompileCache } = require('#src/server/threads/compileCache');
const { startWorker } = require('#src/server/threads/manageThreads');

async function workerReport(options) {
	const worker = startWorker(join(__dirname, 'worker.cjs'), {
		name: 'compile-cache-test',
		autoRestart: false,
		...options,
	});
	const report = await new Promise((resolve, reject) => {
		worker.on('message', (message) => message.type !== 'os-thread-id' && resolve(message));
		worker.once('error', reject);
		worker.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
	});
	worker.wasShutdown = true;
	await worker.terminate();
	return report;
}

async function main() {
	if (scenario === 'file-slot') {
		const tag = cachedDataVersionTag().toString(16).padStart(8, '0');
		const uid = process.getuid ? `-${process.getuid()}` : '';
		const cache = join(rootPath, 'cache', 'compile');
		mkdirSync(cache, { recursive: true });
		writeFileSync(join(cache, `${process.version}-${process.arch}-${tag}${uid}`), 'not a directory');
	}
	if (scenario !== 'import-only') enableCompileCache(rootPath);
	if (scenario === 'repeat') enableCompileCache(rootPath);
	if (scenario === 'moved-root') enableCompileCache(join(rootPath, 'moved'));
	const staleCache = process.env.COMPILE_CACHE_TEST_STALE;
	if (staleCache) {
		for (let waited = 0; existsSync(staleCache) && waited < 10000; waited += 50) await sleep(50);
	}
	const report = {
		mainDirectory: nodeModule.getCompileCacheDir?.(),
		mainEnvDirectory: process.env.NODE_COMPILE_CACHE,
		staleCacheRemains: staleCache ? existsSync(staleCache) : undefined,
		warnings,
		worker: await workerReport({}),
		job: await workerReport({ env: { ...process.env, COMPILE_CACHE_TEST_JOB: 'job-1' } }),
	};
	const callerDirectory = process.env.COMPILE_CACHE_TEST_CALLER_DIRECTORY;
	if (callerDirectory)
		report.callerJob = await workerReport({ env: { ...process.env, NODE_COMPILE_CACHE: callerDirectory } });
	process.stdout.write(JSON.stringify(report) + '\n');
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
