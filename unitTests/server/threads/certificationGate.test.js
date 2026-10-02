'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { waitFor } = require('../../waitFor.js');

// A certifying rollout reloads the root components on main before it replaces anything. This suite is about what it
// does with the workers, so that load and the restart-required bit are stubbed out; a test can hold the load open.
let rootLoad = Promise.resolve();
let releaseRootLoad = () => {};
for (const [specifier, exports] of [
	['#js/server/loadRootComponents', { loadRootComponents: () => rootLoad }],
	['#src/components/requestRestart', { resetRestartNeeded() {}, requestRestart() {}, restartNeeded: () => false }],
]) {
	const resolved = require.resolve(specifier);
	require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const {
	startWorker,
	workers,
	certificationRequest,
	setCertificationHandler,
	setCanaryVerdictTimeout,
} = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'certificationGate-fixture.cjs');
const COMPONENT = 'web';
const DEPLOYMENT = '11111111-1111-1111-1111-111111111111';

describe('the release certification gate', function () {
	this.timeout(60000);
	let planDir;
	let planPath;
	let decisions;
	let completions;
	let pool;
	let committed;
	let started;

	function plan(sequence) {
		writeFileSync(planPath, JSON.stringify({ sequence }));
		rmSync(`${planPath}.starts`, { force: true });
	}

	function startFixture(index) {
		return new Promise((resolve, reject) => {
			startWorker(FIXTURE, {
				name: 'http',
				workerIndex: index,
				threadCount: 3,
				onStarted(worker) {
					started.push(worker);
					worker.certifyRequests = [];
					worker.on('message', (message) => {
						if (message?.type === 'fixture-booted') worker.certifyRequests.push(message.certify);
					});
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

	function httpWorkers() {
		return workers.filter((worker) => worker.name === 'http');
	}

	function arm(overrides = {}) {
		return certificationRequest('arm', {
			component: COMPONENT,
			deploymentId: DEPLOYMENT,
			isolated: false,
			scope: undefined,
			...overrides,
		});
	}

	function commit() {
		committed = true;
		return certificationRequest('commit', { component: COMPONENT, deploymentId: DEPLOYMENT });
	}

	function decisionOf() {
		return certificationRequest('decision', { component: COMPONENT, deploymentId: DEPLOYMENT });
	}

	function rolledOut() {
		return waitFor(() => completions.length > 0, { timeout: 45000, message: 'the certifying rollout never ended' });
	}

	before(() => {
		planDir = mkdtempSync(path.join(os.tmpdir(), 'certification-gate-'));
		planPath = path.join(planDir, 'plan.json');
		process.env.CERTIFICATION_GATE_PLAN = planPath;
		setCanaryVerdictTimeout(1500);
	});

	after(() => {
		setCanaryVerdictTimeout(undefined);
		rmSync(planDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		decisions = [];
		completions = [];
		setCertificationHandler({
			decide: async (certification, decision) => {
				decisions.push({ component: certification.component, ...decision });
				return decision;
			},
			complete: async (certification) => {
				completions.push(certification.component);
			},
			resolveArmed: async () => 'withdrawn',
		});
		plan([{ outcome: 'loaded' }]);
		rootLoad = Promise.resolve();
		committed = false;
		started = [];
		pool = [];
		for (let index = 0; index < 3; index++) pool.push(await startFixture(index));
	});

	afterEach(async () => {
		await certificationRequest('withdraw', { component: COMPONENT, deploymentId: DEPLOYMENT });
		// The next test's restart would queue behind this one's.
		releaseRootLoad();
		if (committed) await rolledOut();
		for (const worker of httpWorkers()) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
		setCertificationHandler(undefined);
	});

	it('arms only while a worker could load the release, and only once per component', async () => {
		for (const worker of httpWorkers()) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
		assert.deepStrictEqual(await arm(), { armed: false, reason: 'unavailable' });

		pool = [await startFixture(0)];
		assert.deepStrictEqual(await arm(), { armed: true });
		assert.deepStrictEqual(await arm(), { armed: false, reason: 'in-flight' });
		assert.deepStrictEqual(await arm({ deploymentId: '22222222-2222-2222-2222-222222222222' }), {
			armed: false,
			reason: 'busy',
		});
	});

	it('certifies on the canary, checks every later replacement, and closes once the rollout ends', async () => {
		await arm();
		assert.equal(await commit(), true);
		const decision = await decisionOf();
		assert.equal(decision.status, 'certified');
		await rolledOut();

		assert.deepStrictEqual(
			decisions.map(({ status }) => status),
			['certified']
		);
		assert.ok(
			pool.every((worker) => worker.wasShutdown),
			'every worker was replaced'
		);
		const replacements = httpWorkers().filter((worker) => !pool.includes(worker));
		assert.equal(replacements.length, 3);
		for (const replacement of replacements) {
			assert.deepStrictEqual(
				replacement.certifyRequests,
				[[{ component: COMPONENT, deploymentId: DEPLOYMENT }]],
				'each replacement was held for the release'
			);
		}
	});

	it('rejects a canary that fails its load, keeps every worker it would have replaced, and stops', async () => {
		plan([{ outcome: 'failed' }]);
		await arm();
		await commit();
		const decision = await decisionOf();
		assert.equal(decision.status, 'rejected');
		assert.match(decision.reason, /threw at load/);
		await rolledOut();

		await waitFor(() => httpWorkers().length === 3, { message: 'the canary was not stopped' });
		assert.deepStrictEqual(
			httpWorkers()
				.map((worker) => worker.threadId)
				.sort(),
			pool.map((worker) => worker.threadId).sort(),
			'the pool is exactly the workers that were serving'
		);
		assert.ok(pool.every((worker) => !worker.wasShutdown));
	});

	for (const [label, step, pattern] of [
		['exits before it reports', { behavior: 'exit' }, /exited before it reported/],
		['never reports', { behavior: 'silent' }, /did not report/],
		[
			'loaded another generation',
			{ outcome: 'loaded', loadedDeploymentId: '33333333-3333-3333-3333-333333333333' },
			/rather than/,
		],
	]) {
		it(`rejects a canary that ${label}`, async () => {
			plan([step]);
			await arm();
			await commit();
			const decision = await decisionOf();
			assert.equal(decision.status, 'rejected');
			assert.match(decision.reason, pattern);
			await rolledOut();
			assert.ok(pool.every((worker) => !worker.wasShutdown));
		});
	}

	it('decides nothing from a skipped load, and certifies nothing', async () => {
		plan([{ outcome: 'skipped' }]);
		await arm();
		await commit();
		const decision = await decisionOf();
		assert.equal(decision.status, 'uncertified');
	});

	it('holds a crash restart back until the canary decides', async () => {
		plan([{ outcome: 'loaded', delayMs: 700 }]);
		await arm();
		await commit();
		await waitFor(() => httpWorkers().length === 4, { message: 'the canary never started' });
		const crashed = pool[2];
		await crashed.terminate();
		await sleep(200);
		assert.equal(httpWorkers().length, 3, 'the crashed worker is not replaced while the canary is undecided');
		const decision = await decisionOf();
		assert.equal(decision.status, 'certified');
		await rolledOut();
		await waitFor(() => httpWorkers().length === 3, { message: 'the deferred restart never ran' });
	});

	it('starts a crash restart the gate stopped again, on the release the rejection left live', async () => {
		plan([{ outcome: 'failed' }]);
		const loading = Promise.withResolvers();
		rootLoad = loading.promise;
		releaseRootLoad = loading.resolve;
		await arm();
		await commit();
		// The rollout is still loading, so this restart is the first start on the committed release: the canary.
		await pool[2].terminate();
		const verdict = await decisionOf();
		assert.equal(verdict.status, 'rejected');
		const restarted = await waitFor(
			() => {
				const later = started.filter((worker) => !pool.includes(worker));
				return later.length === 2 && later[1].certifyRequests.length === 1 && later;
			},
			{ message: 'the stopped canary was not started again' }
		);
		assert.deepStrictEqual(
			restarted.map((worker) => worker.certifyRequests),
			[[[{ component: COMPONENT, deploymentId: DEPLOYMENT }]], [null]],
			'the canary was held, and its copy was not'
		);
		await waitFor(() => httpWorkers().length === 3 && !httpWorkers().includes(restarted[0]), {
			message: 'the rejected canary was not stopped',
		});
		loading.resolve();
		await rolledOut();
		assert.ok(!pool[0].wasShutdown && !pool[1].wasShutdown, 'a rejected rollout replaces nothing further');
	});

	it('refuses to withdraw a release once it is committed', async () => {
		plan([{ outcome: 'loaded', delayMs: 300 }]);
		await arm();
		await commit();
		assert.equal(await certificationRequest('withdraw', { component: COMPONENT, deploymentId: DEPLOYMENT }), false);
		assert.equal((await decisionOf()).status, 'certified');
	});

	it('holds starts back while armed, and lets them go when the registration is withdrawn', async () => {
		await arm();
		const crashed = pool[0];
		await crashed.terminate();
		await sleep(200);
		assert.equal(httpWorkers().length, 2, 'nothing starts while the release may be about to go live');
		await certificationRequest('withdraw', { component: COMPONENT, deploymentId: DEPLOYMENT });
		await waitFor(() => httpWorkers().length === 3, { message: 'the held-back start never ran' });
	});

	it('stops at a later replacement that fails its check, keeping it and every worker after it', async () => {
		plan([{ outcome: 'loaded' }, { outcome: 'failed' }]);
		await arm();
		await commit();
		const decision = await decisionOf();
		assert.equal(decision.status, 'certified');
		await rolledOut();
		const replaced = pool.filter((worker) => worker.wasShutdown);
		assert.equal(replaced.length, 1, 'only the canary replaced a worker');
		await waitFor(() => httpWorkers().length === 3);
	});

	it('starts a slot again when its admitted replacement never comes up', async () => {
		plan([{ outcome: 'loaded', afterAdmission: 'exit' }, { outcome: 'loaded' }]);
		await arm();
		await commit();
		assert.equal((await decisionOf()).status, 'certified');
		await rolledOut();
		await waitFor(() => httpWorkers().length === 3, { message: 'the pool did not get its worker back' });
	});

	it('replaces the requesting worker last, once it has answered', async () => {
		// Read now: a Worker's threadId reads back as -1 once it has exited.
		const requesterThreadId = pool[0].threadId;
		await arm({ requesterThreadId });
		const shutdownOrder = [];
		for (const worker of pool) {
			const threadId = worker.threadId;
			worker.once('shutdown', () => shutdownOrder.push(threadId));
		}
		await commit();
		await decisionOf();
		await certificationRequest('release', { component: COMPONENT, deploymentId: DEPLOYMENT });
		await rolledOut();
		assert.equal(shutdownOrder.length, 3);
		assert.equal(shutdownOrder.at(-1), requesterThreadId);
	});
});
