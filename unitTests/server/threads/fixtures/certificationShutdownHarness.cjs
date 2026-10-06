'use strict';

// A certifying rollout declined at process shutdown while its release's rejection is still being recorded. Run in a
// process of its own, since nothing undoes beginProcessShutdown() in the process that calls it.

const { mkdtempSync, rmSync, writeFileSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { waitFor } = require('../../../waitFor.js');
const { HARPER_CONFIG_FILE } = require('#src/utility/hdbTerms');
process.env.HARPER_SAFE_MODE = 'true';

const rootPath = mkdtempSync(join(tmpdir(), 'harper-certification-shutdown-'));
writeFileSync(join(rootPath, HARPER_CONFIG_FILE), `rootPath: ${JSON.stringify(rootPath)}\n`);
process.env.ROOTPATH = rootPath;
const planPath = join(rootPath, 'plan.json');
writeFileSync(planPath, JSON.stringify({ sequence: [{ outcome: 'failed' }] }));
process.env.CERTIFICATION_GATE_PLAN = planPath;
process.on('exit', () => {
	try {
		rmSync(rootPath, { force: true, recursive: true });
	} catch {}
});

require('#src/utility/environment/environmentManager').initTestEnvironment();
const {
	beginProcessShutdown,
	certificationRequest,
	restartWorkers,
	setCertificationHandler,
	setRootComponentsReload,
	startWorker,
	workers,
} = require('#js/server/threads/manageThreads');

const FIXTURE = join(__dirname, '..', 'certificationGate-fixture.cjs');
const RELEASE = { component: 'web', deploymentId: '11111111-1111-1111-1111-111111111111' };
const WAIT = { timeout: 20000 };

const order = [];
const recording = Promise.withResolvers();
setCertificationHandler({
	decide: async (certification, decision) => {
		order.push(`decide:${decision.status}`);
		await recording.promise;
		order.push('decided');
		return decision;
	},
	complete: async () => {
		order.push('complete');
	},
	resolveArmed: async () => 'withdrawn',
});
const reloading = Promise.withResolvers();
let reloadStarted = false;
setRootComponentsReload(() => {
	reloadStarted = true;
	return reloading.promise;
});

function startPoolWorker(index) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name: 'http',
			workerIndex: index,
			threadCount: 2,
			onStarted(worker) {
				const onReady = (message) => {
					if (message?.type !== 'child_started') return;
					worker.off('message', onReady);
					resolve(worker);
				};
				worker.on('message', onReady);
				worker.once('error', reject);
			},
		});
	});
}

(async () => {
	const pool = [await startPoolWorker(0), await startPoolWorker(1)];
	// Another restart holds in its root reload, so the release's rollout queues behind it and gives it no canary.
	const ahead = restartWorkers('http', undefined, true, null, undefined);
	await waitFor(() => reloadStarted, WAIT);
	await certificationRequest('arm', { ...RELEASE, isolated: false, scope: undefined });
	await certificationRequest('commit', RELEASE);
	// So this crash restart is the release's canary; it reports the release failed, and the rejection waits on decide.
	await pool[1].terminate();
	await waitFor(() => order.includes('decide:rejected'), WAIT);
	beginProcessShutdown();
	reloading.resolve();
	await ahead;
	// The release's rollout, declined now, has every chance to close ahead of the rejection it would cut short.
	await sleep(300);
	recording.resolve();
	await waitFor(() => order.includes('complete'), WAIT);
	writeSync(1, `${JSON.stringify({ order })}\n`);
	for (const worker of [...workers]) {
		worker.wasShutdown = true;
		await worker.terminate();
	}
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
