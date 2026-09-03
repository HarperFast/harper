'use strict';

const assert = require('assert');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const { startWorker } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'workerDataExtra-fixture.js');
const WORKER_NAME = 'workerData-extra-test';

/** Spawn the fixture and resolve its report. */
function spawnAndReport(options) {
	return new Promise((resolve, reject) => {
		// `preloads: false` is not incidental: `getImportModules()` memoizes, so a spawn from a test that
		// resolves the configured preload list freezes it for the whole process and breaks
		// preloadSafeMode.test.js when they share one mocha run. This is the same hazard the deploy
		// validator avoids, which is why the option is threaded through startWorker at all.
		const worker = startWorker(FIXTURE, {
			autoRestart: false,
			name: WORKER_NAME,
			execArgvOptions: { preloads: false },
			...options,
		});
		const timer = setTimeout(() => reject(new Error('fixture never reported')), 20000);
		worker.on('message', (message) => {
			if (message?.type !== 'extra-report') return;
			clearTimeout(timer);
			resolve(message);
			worker.terminate().catch(() => {});
		});
		worker.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describe('startWorker per-call workerData', () => {
	it('refuses input that would silently cost the thread its ITC bootstrap', () => {
		// `...options` is spread into the constructor last, so this would REPLACE the bootstrap object
		// wholesale — the worker would come up with no addPorts and no way to reach its peers.
		assert.throws(
			() => startWorker(FIXTURE, { name: WORKER_NAME, workerData: { mine: 1 } }),
			/does not accept 'workerData'/
		);
		for (const key of ['addPorts', 'ticketKeys', 'workerCount', 'noServerStart', '__proto__']) {
			assert.throws(
				() => startWorker(FIXTURE, { name: WORKER_NAME, extraWorkerData: { [key]: 'x' } }),
				/is owned by the thread bootstrap/,
				`${key} must be refused`
			);
		}
	});

	it('merges extraWorkerData and a transferred port alongside the bootstrap, not instead of it', async function () {
		this.timeout(30000);
		const { port1, port2 } = new MessageChannel();
		const throughPort = new Promise((resolve) => port1.once('message', resolve));
		const report = await spawnAndReport({
			noServerStart: true,
			extraWorkerData: { certification: { candidateDirPath: '/tmp/candidate', nonce: 'n-1', verdictPort: port2 } },
			extraTransferList: [port2],
		});

		assert.strictEqual(report.candidateDirPath, '/tmp/candidate');
		assert.strictEqual(report.nonce, 'n-1');
		assert.strictEqual(report.sawPort, true, 'the MessagePort survived the transfer');
		// `noServerStart` is a reserved key precisely so a provider cannot forge it; the bootstrap
		// supplies it on request instead.
		assert.strictEqual(report.noServerStart, true);
		// The point of the merge: the thread still got everything it normally gets.
		assert.strictEqual(report.hasAddPorts, true, 'addPorts survived');
		assert.strictEqual(report.hasTicketKeys, true, 'ticketKeys survived');
		assert.strictEqual(report.name, WORKER_NAME);

		assert.deepStrictEqual(await throughPort, { type: 'through-transferred-port', nonce: 'n-1' });
		port1.close();
	});

	it('leaves noServerStart absent unless asked for', async function () {
		this.timeout(30000);
		const report = await spawnAndReport({});
		assert.strictEqual(report.noServerStart, undefined);
		assert.strictEqual(report.sawPort, false);
		assert.strictEqual(report.hasAddPorts, true);
	});
});
