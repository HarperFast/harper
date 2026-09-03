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
		// `workerData: null` is present but falsy: it still replaces the bootstrap object, so a truthiness
		// check would let it through and the thread would come up with no ITC wiring and no error.
		assert.throws(() => startWorker(FIXTURE, { name: WORKER_NAME, workerData: null }), /does not accept 'workerData'/);
		// The other half of the same hazard: a raw transferList is spread last and replaces the merged list,
		// dropping the ports to this thread's peers.
		assert.throws(
			() => startWorker(FIXTURE, { name: WORKER_NAME, transferList: [] }),
			/does not accept 'transferList'/
		);
		// A transferred port is single-use, and the unexpected-exit path re-invokes startWorker with the SAME
		// options — so a restartable worker carrying one throws DataCloneError on its second spawn,
		// synchronously, inside an `exit` listener with nothing to catch it. That is a process-wide crash,
		// not a failed spawn, so the contract is refused up front.
		const { port1, port2 } = new MessageChannel();
		try {
			assert.throws(
				() => startWorker(FIXTURE, { name: WORKER_NAME, extraTransferList: [port2] }),
				/requires 'autoRestart: false'/
			);
		} finally {
			port1.close();
			port2.close();
		}
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

	it('never restarts or copies a one-shot worker, whose transferred ports are spent', async function () {
		// The crash this guards: `restartWorkers` replaces workers through `worker.startCopy()`, which
		// re-spawns from the SAME options object — so a worker carrying transferred ports would hit
		// `DataCloneError` synchronously, inside the restart loop, taking the rest of the restart with it.
		this.timeout(30000);
		const { port1, port2 } = new MessageChannel();
		const worker = startWorker(FIXTURE, {
			autoRestart: false,
			name: WORKER_NAME,
			execArgvOptions: { preloads: false },
			extraWorkerData: { certification: { candidateDirPath: '/tmp/c', nonce: 'n', verdictPort: port2 } },
			extraTransferList: [port2],
		});

		try {
			assert.strictEqual(worker.isOneShot, true, 'a port-carrying spawn is marked one-shot');
			// The backstop for a direct caller: a named refusal rather than a DataCloneError from inside
			// `new Worker`.
			assert.throws(() => worker.startCopy(), /Cannot restart a one-shot/);

			// The restart loop's own filter is NOT driven here. `restartWorkers` runs a real node restart —
			// it reinstalls applications, which shells out to `npm pack` — so calling it from a unit test
			// exercises far more than the one-line `isOneShot` filter and would be slow and fragile for it.
			// What is asserted above is the mechanism that filter depends on: the flag is set, and the copy
			// refuses by name. The filter itself is covered by reading, and the crash it prevents is
			// described in the commit that added it.
		} finally {
			port1.close();
			await worker.terminate().catch(() => {});
		}
	});

	it('leaves noServerStart absent unless asked for', async function () {
		this.timeout(30000);
		const report = await spawnAndReport({});
		assert.strictEqual(report.noServerStart, undefined);
		assert.strictEqual(report.sawPort, false);
		assert.strictEqual(report.hasAddPorts, true);
	});
});
