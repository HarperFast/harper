const assert = require('node:assert');
const { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

exports.probeEmbeddedRuntime = async (sourceRoot) => {
	const product = join(process.env.ROOTPATH, '.embedded-product');
	const runtime = join(product, 'dist/core');
	const metadata = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
	metadata.name = 'embedded-layout-fixture';
	mkdirSync(product, { recursive: true });
	writeFileSync(join(product, 'package.json'), JSON.stringify(metadata));
	cpSync(join(sourceRoot, 'dist'), runtime, { recursive: true });
	const outerCli = join(product, 'dist/bin/harper.js');
	mkdirSync(join(product, 'dist/bin'), { recursive: true });
	writeFileSync(
		outerCli,
		"console.log('outer-cli'); const { harper } = require('../core/bin/harper.js'); harper().then(result => { if (result) console.log(result); }).catch(error => { console.error(error); process.exitCode = 1; });"
	);
	const externalWorker = join(product, 'dist/external-worker.js');
	writeFileSync(externalWorker, "require('node:worker_threads').parentPort.postMessage('outside core');");
	const cli = (entry) =>
		execFileSync(process.execPath, [entry, 'version'], { encoding: 'utf8', timeout: 30000 }).trim().split(/\r?\n/);
	let worker, external, databases;
	try {
		assert.deepStrictEqual(cli(join(runtime, 'bin/harper.js')), [metadata.version]);
		assert.deepStrictEqual(cli(outerCli), ['outer-cli', metadata.version]);
		const { PACKAGE_ROOT, RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT, packageJson } = require(
			join(runtime, 'utility/packageUtils.js')
		);
		assert.strictEqual(PACKAGE_ROOT, product);
		assert.strictEqual(RUNTIME_SRC_ROOT, runtime);
		assert.strictEqual(packageJson.name, metadata.name);
		const { systemSchema } = require(join(runtime, 'utility/systemSchema.js'));
		assert.deepStrictEqual(systemSchema, JSON.parse(readFileSync(join(sourceRoot, 'json/systemSchema.json'), 'utf8')));
		assert.strictEqual(require(join(runtime, 'utility/globalSchema.js')).getSystemSchema(), systemSchema);
		const config = require(join(runtime, 'utility/processManagement/servicesConfig.js'));
		assert.strictEqual(config.generateMainServerConfig().script, outerCli);
		assert.strictEqual(config.generateMainServerConfig().cwd, product);
		assert.strictEqual(config.generateRestart().script, join(runtime, 'utility/scripts/restartHdb.js'));
		assert.ok(existsSync(config.generateRestart().script));
		const { GIT_CREDENTIAL_HELPER_PATH } = require(join(runtime, 'components/Application.js'));
		assert.strictEqual(GIT_CREDENTIAL_HELPER_PATH, join(runtime, 'components/gitCredentialHelper.js'));
		assert.ok(existsSync(GIT_CREDENTIAL_HELPER_PATH));
		require(join(runtime, 'dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbSearch.js'));
		require(join(runtime, 'dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropAttribute.js'));
		databases = require(join(runtime, 'resources/databases.js'));
		const manager = require(join(runtime, 'server/threads/manageThreads.js'));
		external = manager.startWorker('dist/external-worker', { name: 'embedded-relative-probe', autoRestart: false });
		const [externalMessage] = await once(external, 'message', { signal: AbortSignal.timeout(10000) });
		assert.strictEqual(externalMessage, 'outside core');
		worker = new Worker(join(RUNTIME_SRC_ROOT, `server/threads/threadServer${RUNTIME_FILE_EXT}`), {
			workerData: { addPorts: [], addThreadIds: [], reportsLoad: true },
		});
		const messages = [];
		worker.on('message', (message) => {
			messages.push(message.type);
			if (message.type === 'child_component_verdict') worker.postMessage({ type: 'child_admitted' });
			if (message.type === 'child_started') worker.postMessage({ type: 'shutdown', restartNumber: 2 });
		});
		const [code] = await once(worker, 'exit', { signal: AbortSignal.timeout(15000) });
		assert.strictEqual(code, 0);
		assert.ok(messages.includes('child_started'));
	} finally {
		if (worker && worker.threadId !== -1) await worker.terminate();
		if (external && external.threadId !== -1) await external.terminate();
		await databases?.closeLoadedDatabases();
		rmSync(product, { recursive: true, force: true });
	}
};
