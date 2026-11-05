'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('configuration agreement between main and worker', function () {
	for (const envVar of ['HARPER_CONFIG', 'HARPER_SET_CONFIG']) {
		it(`keeps the main thread and a fresh worker in agreement with ${envVar}`, function () {
			const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-config-overlap-'));
			try {
				for (const dir of ['database', 'log', 'backup']) fs.mkdirSync(path.join(rootPath, dir));
				const output = execFileSync(
					process.execPath,
					[
						...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
						'-e',
						`
					const assert = require('node:assert');
					const { Worker } = require('node:worker_threads');
					const config = require('#src/config/configUtils');
					const { filterArgsAgainstRuntimeConfig } = require('#src/config/harperConfigEnvVars');
					config.createConfigFile({ ROOTPATH: process.env.ROOTPATH }, true);
					process.env[process.argv[1]] = JSON.stringify({ http: { mtls: false }, threads: { debug: true } });
					config.initConfig(true);
					const args = filterArgsAgainstRuntimeConfig({ HTTP_MTLS_REQUIRED: 'true', HTTP_THREADS: '8' });
					config.updateConfigValue(undefined, undefined, args, true, true);
					const main = { mtls: config.getConfigObj().http.mtls, count: config.getConfigObj().threads.count };
					assert.deepStrictEqual(main, { mtls: false, count: 8 });
					function readWorkerConfig() {
						const { parentPort } = require('node:worker_threads');
						const config = require('#src/config/configUtils');
						config.initConfig(true);
						parentPort.postMessage({ mtls: config.getConfigObj().http.mtls, count: config.getConfigObj().threads.count });
					}
					const worker = new Worker('(' + readWorkerConfig.toString() + ')()', { eval: true, workerData: { noServerStart: true } });
					worker.once('error', (error) => { throw error; });
					worker.once('message', async (value) => {
						assert.deepStrictEqual(value, main);
						await worker.terminate();
						console.log('config-agreement-ok');
					});
					`,
						envVar,
					],
					{
						cwd: path.resolve(__dirname, '../..'),
						env: {
							...process.env,
							ROOTPATH: rootPath,
							HARPER_DEFAULT_CONFIG: '',
							HARPER_CONFIG: '',
							HARPER_SET_CONFIG: '',
						},
						encoding: 'utf8',
						timeout: 30000,
					}
				);
				assert.match(output, /config-agreement-ok/);
			} finally {
				fs.rmSync(rootPath, { recursive: true, force: true });
			}
		});
	}
});
