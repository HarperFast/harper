'use strict';

// A compile cache is process-wide once enabled, so each case runs in its own process instead of mocha's.
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const nodeModule = require('node:module');
const { join } = require('node:path');
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
	if (scenario !== 'import-only') enableCompileCache(rootPath);
	if (scenario === 'repeat') enableCompileCache(rootPath);
	const staleCache = process.env.COMPILE_CACHE_TEST_STALE;
	if (staleCache) {
		// pruning runs in the background; give it a bounded window
		for (let waited = 0; existsSync(staleCache) && waited < 10000; waited += 50) await sleep(50);
	}
	const report = {
		mainDirectory: nodeModule.getCompileCacheDir?.(),
		mainEnvDirectory: process.env.NODE_COMPILE_CACHE,
		staleCacheRemains: staleCache ? existsSync(staleCache) : undefined,
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
