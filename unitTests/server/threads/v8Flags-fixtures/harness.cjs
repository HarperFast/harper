'use strict';

// V8 flags are process-global, so each case runs in its own process instead of mocha's.
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HARPER_CONFIG_FILE, CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const rootPath = mkdtempSync(join(tmpdir(), 'harper-v8flags-'));
writeFileSync(join(rootPath, HARPER_CONFIG_FILE), `rootPath: ${JSON.stringify(rootPath)}\n`);
process.env.ROOTPATH = rootPath;
process.on('exit', () => {
	try {
		rmSync(rootPath, { force: true, recursive: true });
	} catch {}
});

const envMgr = require('#src/utility/environment/environmentManager');
envMgr.initTestEnvironment();
// Loaded before the setting is assigned, as bin/run.ts loads it before install and env-var config are written.
const { startWorker, workers } = require('#js/server/threads/manageThreads');

// argv[2]: JSON list of `threads.v8Flags` values; each is assigned, then one worker is started.
async function main() {
	const results = [];
	for (const v8Flags of JSON.parse(process.argv[2])) {
		envMgr.setProperty(CONFIG_PARAMS.THREADS_V8FLAGS, v8Flags);
		let worker;
		try {
			worker = startWorker(join(__dirname, 'worker.cjs'), { name: 'v8-flags-test', autoRestart: false });
		} catch (error) {
			results.push({ error: error.message, workerCount: workers.length });
			continue;
		}
		const stackTraceLimit = await new Promise((resolve, reject) => {
			worker.on('message', (message) => message.type !== 'os-thread-id' && resolve(message.stackTraceLimit));
			worker.once('error', reject);
			worker.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
		});
		results.push({ stackTraceLimit });
		worker.wasShutdown = true;
		await worker.terminate();
	}
	process.stdout.write(JSON.stringify(results) + '\n');
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
