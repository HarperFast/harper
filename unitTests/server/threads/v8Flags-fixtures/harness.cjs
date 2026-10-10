'use strict';

// V8 flags are process-global, so each case runs in its own process instead of mocha's.
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HARPER_CONFIG_FILE, CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const rootPath = mkdtempSync(join(tmpdir(), 'harper-v8flags-'));
mkdirSync(join(rootPath, 'database'));
// A complete config, because loading socketRouter validates it.
const defaultConfig = readFileSync(join(__dirname, '../../../../static/defaultConfig.yaml'), 'utf8');
writeFileSync(
	join(rootPath, HARPER_CONFIG_FILE),
	defaultConfig.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(rootPath)}`)
);
process.env.ROOTPATH = rootPath;
process.on('exit', () => {
	try {
		rmSync(rootPath, { force: true, recursive: true });
	} catch {}
});

const envMgr = require('#src/utility/environment/environmentManager');
// Loaded before the setting is assigned, as bin/run.ts loads it before install and env-var config are written.
const { startWorker, workers } = require('#js/server/threads/manageThreads');
const { startHTTPThreads } = require('#src/server/threads/socketRouter');

async function main() {
	const results = [];
	for (const v8Flags of JSON.parse(process.argv[2])) {
		envMgr.setProperty(CONFIG_PARAMS.THREADS_V8FLAGS, v8Flags);
		if (process.argv[3] === 'startHTTPThreads') {
			await startHTTPThreads(0).then(
				() => results.push({ started: true }),
				(error) => results.push({ error: error.message })
			);
			continue;
		}
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
	process.stdout.write(JSON.stringify({ defaultStackTraceLimit: Error.stackTraceLimit, results }) + '\n');
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
