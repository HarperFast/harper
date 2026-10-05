'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { waitFor } = require('../../waitFor.js');

// A certifying rollout reloads the root components on main before it replaces anything. This suite is about what it
// does with the workers, so that reload does nothing, and a test can hold it open.
let rootLoad = Promise.resolve();
let releaseRootLoad = () => {};

const {
	startWorker,
	workers,
	certificationRequest,
	certificationRollout,
	setCertificationHandler,
	setCanaryVerdictTimeout,
	setRootComponentsReload,
} = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'certificationGate-fixture.cjs');
const COMPONENT = 'web';
const DEPLOYMENT = '11111111-1111-1111-1111-111111111111';
const OTHER = { component: 'api', deploymentId: '22222222-2222-2222-2222-222222222222' };

describe('the release certification gate', function () {
	this.timeout(60000);
	let planDir;
	let planPath;
	let decisions;
	let completions;
	let pool;
	let committed;
	let started;

	function plan(sequence, { concurrentStarts, unheldLoadMs, unheldShutdownDelayMs } = {}) {
		writeFileSync(planPath, JSON.stringify({ sequence, concurrentStarts, unheldLoadMs, unheldShutdownDelayMs }));
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
					worker.lifecycle = [];
					worker.on('message', (message) => {
						if (message?.type === 'fixture-lifecycle') worker.lifecycle.push(message);
						if (message?.type === 'fixture-admitted') worker.admitted = true;
						if (message?.type !== 'fixture-booted') return;
						worker.certifyRequests.push(message.certify);
						worker.failClosed = message.failClosed;
					});
					worker.once('exit', () => (worker.exitedAt = Date.now()));
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

	let safeMode;

	before(() => {
		// startWorker resolves the configured preload modules once per process, outside safe mode only; a later suite
		// configures them, so these starts must not be the ones that resolve them.
		safeMode = process.env.HARPER_SAFE_MODE;
		process.env.HARPER_SAFE_MODE = '1';
		setRootComponentsReload(() => rootLoad);
		planDir = mkdtempSync(path.join(os.tmpdir(), 'certification-gate-'));
		planPath = path.join(planDir, 'plan.json');
		process.env.CERTIFICATION_GATE_PLAN = planPath;
		setCanaryVerdictTimeout(1500);
	});

	after(() => {
		if (safeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = safeMode;
		setRootComponentsReload(undefined);
		setCanaryVerdictTimeout(undefined);
		rmSync(planDir, { recursive: true, force: true });
	});

	function handler(overrides = {}) {
		return {
			decide: async (certification, decision) => {
				decisions.push({ component: certification.component, at: Date.now(), ...decision });
				return decision;
			},
			complete: async (certification) => {
				completions.push({ component: certification.component, at: Date.now() });
			},
			resolveArmed: async () => 'withdrawn',
			...overrides,
		};
	}

	async function stopOthers(keep) {
		for (const worker of pool.filter((candidate) => candidate !== keep)) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
		pool = [keep];
	}

	/** Two workers die while a release is armed, so both restarts are held back; the requester's death commits. */
	async function holdBackTwoStarts() {
		const [requester, other, spare] = pool;
		spare.wasShutdown = true;
		await spare.terminate();
		pool = [requester, other];
		await arm({ requesterThreadId: requester.threadId });
		await other.terminate();
		await requester.terminate();
	}

	beforeEach(async () => {
		decisions = [];
		completions = [];
		setCertificationHandler(handler());
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

	it('keeps a refused decision and its rollout for the requester that reads them after the rollout ended', async () => {
		plan([{ outcome: 'failed' }, { outcome: 'loaded' }]);
		await arm();
		await commit();
		await rolledOut();
		// A later release of the component completes before this requester reads its own decision.
		const later = { component: COMPONENT, deploymentId: '33333333-3333-3333-3333-333333333333' };
		assert.deepStrictEqual(await certificationRequest('arm', { ...later, isolated: false, scope: undefined }), {
			armed: true,
		});
		assert.equal(await certificationRequest('commit', later), true);
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'the later rollout never ended' });
		assert.equal((await certificationRequest('decision', later))?.status, 'certified');

		const decision = await decisionOf();
		assert.equal(decision?.status, 'rejected', 'the requester still reads the refusal');
		const outcome = await certificationRollout(COMPONENT, DEPLOYMENT);
		assert.equal(outcome?.certification?.status, 'rejected', 'and the rollout that followed it');

		await certificationRequest('release', { component: COMPONENT, deploymentId: DEPLOYMENT });
		assert.equal(await decisionOf(), undefined, 'released, it is gone');
	});

	it('forgets a decision once the worker that requested it has exited without reading it', async () => {
		plan([{ outcome: 'failed' }]);
		const requester = pool[1];
		await arm({ requesterThreadId: requester.threadId });
		await commit();
		await rolledOut();
		assert.equal((await decisionOf())?.status, 'rejected');
		requester.wasShutdown = true;
		await requester.terminate();
		await waitFor(async () => (await decisionOf()) === undefined, { message: 'the decision outlived its requester' });
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

	for (const [label, resolveArmed] of [
		['commits', async () => 'committed'],
		['cannot be resolved', async () => Promise.reject(new Error('could not read the component'))],
	]) {
		it(`certifies through a held-back start when the requester's registration ${label} and nothing is left to replace`, async () => {
			setCertificationHandler(handler({ resolveArmed }));
			const original = [...pool];
			await stopOthers(pool[0]);
			plan([{ outcome: 'failed' }]);
			await arm({ requesterThreadId: pool[0].threadId });
			// The only worker dies between the swap and its commit: its crash restart is the only start left.
			await pool[0].terminate();
			await rolledOut();
			assert.deepStrictEqual(
				decisions.map(({ status }) => status),
				['rejected']
			);
			const later = started.filter((worker) => !original.includes(worker));
			assert.deepStrictEqual(later[0].certifyRequests, [[{ component: COMPONENT, deploymentId: DEPLOYMENT }]]);
			await waitFor(() => later.length === 2 && later[1].certifyRequests.length === 1, {
				message: 'the rejected canary was not started again',
			});
			assert.deepStrictEqual(later[1].certifyRequests, [null]);
		});
	}

	it('admits a held start only on its own load, even once the canary certified the release', async () => {
		setCertificationHandler(handler({ resolveArmed: async () => 'committed' }));
		plan([{ outcome: 'loaded' }, { outcome: 'failed' }], { concurrentStarts: 2 });
		await holdBackTwoStarts();
		await rolledOut();
		assert.deepStrictEqual(
			decisions.map(({ status }) => status),
			['certified']
		);
		const held = started.filter((worker) => worker.certifyRequests[0]);
		await waitFor(() => held.length === 2 && held.every((worker) => worker.exitedAt || worker.admitted), {
			message: 'the held starts never settled',
		});
		assert.equal(held[0].admitted, true, 'the canary is admitted');
		assert.equal(held[1].admitted, undefined, 'a start whose own load failed is not');
	});

	it('stops a held start that never reports, whichever decision it was waiting on', async () => {
		setCertificationHandler(handler({ resolveArmed: async () => 'committed' }));
		plan([{ outcome: 'loaded' }, { behavior: 'silent' }], { concurrentStarts: 2 });
		await holdBackTwoStarts();
		await rolledOut();
		assert.deepStrictEqual(
			decisions.map(({ status }) => status),
			['certified']
		);
		const held = started.filter((worker) => worker.certifyRequests[0]);
		await waitFor(() => held[1]?.exitedAt, { timeout: 10000, message: 'the silent held start was never stopped' });
		assert.equal(held[0].admitted, true);
		await waitFor(() => started.some((worker) => worker.certifyRequests[0] === null && !pool.includes(worker)), {
			message: 'its slot was not started again',
		});
	});

	it('stops every held start before it restores for a certification it cannot record', async () => {
		setCertificationHandler(
			handler({
				resolveArmed: async () => 'committed',
				decide: async (certification, decision) => {
					decisions.push({ component: certification.component, at: Date.now(), ...decision });
					if (decision.status === 'certified') throw new Error('ENOSPC: no space left on device');
					return decision;
				},
			})
		);
		plan([{ outcome: 'loaded' }, { behavior: 'silent', shutdownDelayMs: 300 }], { concurrentStarts: 2 });
		await holdBackTwoStarts();
		await rolledOut();
		assert.deepStrictEqual(
			decisions.map(({ status }) => status),
			['certified', 'interrupted']
		);
		const held = started.filter((worker) => worker.certifyRequests[0]);
		assert.equal(held.length, 2);
		for (const worker of held) {
			assert.ok(worker.exitedAt && worker.exitedAt <= decisions[1].at, 'it exited before the restore was decided');
			assert.equal(worker.admitted, undefined);
		}
	});

	it('interrupts a certification it cannot record, and restores instead of rolling out', async () => {
		setCertificationHandler(
			handler({
				decide: async (certification, decision) => {
					decisions.push({ component: certification.component, at: Date.now(), ...decision });
					if (decision.status === 'certified') throw new Error('ENOSPC: no space left on device');
					return decision;
				},
			})
		);
		await arm();
		await commit();
		const verdict = await decisionOf();
		assert.equal(verdict.status, 'interrupted');
		assert.match(verdict.reason, /could not be recorded: ENOSPC/);
		assert.deepStrictEqual(
			decisions.map(({ status }) => status),
			['certified', 'interrupted']
		);
		await rolledOut();
		const canary = started.find((worker) => worker.certifyRequests[0]);
		assert.equal(canary.admitted, undefined, 'the canary of an unrecorded certification is not admitted');
		assert.ok(
			pool.every((worker) => !worker.wasShutdown),
			'and nothing it would have replaced was'
		);
	});

	it('decides a timed-out canary only once it has exited', async () => {
		plan([{ behavior: 'silent', shutdownDelayMs: 800 }]);
		await arm();
		await commit();
		const verdict = await decisionOf();
		assert.match(verdict.reason, /did not report/);
		const canary = started.find((worker) => worker.certifyRequests[0]);
		assert.ok(canary.exitedAt, 'the canary has exited');
		assert.ok(decisions[0].at >= canary.exitedAt, 'the decision, and with it the restore, came after the exit');
	});

	it('refuses, in memory, only the release whose rejection it could not record', async () => {
		let recordFails = true;
		setCertificationHandler(
			handler({
				decide: async (certification, decision) => {
					decisions.push({ component: certification.component, at: Date.now(), ...decision });
					if (decision.status === 'rejected' && recordFails) throw new Error('ENOSPC: no space left on device');
					return decision;
				},
			})
		);
		plan([{ outcome: 'failed' }]);
		await arm();
		await commit();
		assert.equal((await decisionOf()).recordError, 'ENOSPC: no space left on device');
		await rolledOut();
		const afterRefusal = await startFixture(3);
		assert.deepStrictEqual(afterRefusal.failClosed?.[COMPONENT]?.deploymentId, DEPLOYMENT);
		pool.push(afterRefusal);

		recordFails = false;
		completions = [];
		plan([{ outcome: 'loaded' }]);
		const next = '44444444-4444-4444-4444-444444444444';
		await arm({ deploymentId: next });
		await certificationRequest('commit', { component: COMPONENT, deploymentId: next });
		committed = true;
		assert.equal(
			(await certificationRequest('decision', { component: COMPONENT, deploymentId: next })).status,
			'certified'
		);
		const canary = started.find((worker) => worker.certifyRequests[0]?.[0]?.deploymentId === next);
		assert.equal(canary.failClosed, null, 'the next release is not refused for the last one');
	});

	it("pauses the running workers' watchers from the commit until a certified rollout ends", async () => {
		plan([{ outcome: 'loaded', delayMs: 300 }]);
		await arm();
		await commit();
		for (const worker of pool) {
			assert.deepStrictEqual(
				worker.lifecycle.map(({ phase, watchersOnly }) => [phase, watchersOnly]),
				[['start', true]],
				'every running worker paused, holding no load, before the commit answered'
			);
		}
		await rolledOut();
		const replacements = started.filter((worker) => !pool.includes(worker));
		await waitFor(() => replacements.some((worker) => worker.lifecycle.length > 0), {
			message: 'the pause was never lifted',
		});
		for (const worker of replacements) {
			assert.ok(
				worker.lifecycle.every(({ phase, at }) => phase === 'end' && at >= completions[0].at),
				'a worker started on the release is never paused, and hears the pause lifted only once the rollout ended'
			);
		}
	});

	it('resumes the watchers of the workers a refusal kept serving only after the predecessor is back', async () => {
		plan([{ outcome: 'failed' }]);
		await arm();
		await commit();
		assert.equal((await decisionOf()).status, 'rejected');
		await rolledOut();
		await waitFor(() => pool.every((worker) => worker.lifecycle.length === 2), {
			message: 'the kept workers were not resumed',
		});
		for (const worker of pool) {
			assert.deepStrictEqual(
				worker.lifecycle.map(({ phase }) => phase),
				['start', 'end']
			);
			assert.ok(worker.lifecycle[1].at >= completions[0].at, 'resumed once the refusal was decided and closed');
		}
	});

	/**
	 * The other release arms once this rollout's canary is booting, and stays armed past the moment this rollout reaches
	 * its next worker: a replacement started then could not decide it, and its own rollout queues behind this one.
	 */
	async function overlappingRollouts(other) {
		await arm();
		await commit();
		await waitFor(() => started.some((worker) => !pool.includes(worker)), { message: 'no canary started' });
		assert.deepStrictEqual(await certificationRequest('arm', { ...other, isolated: false, scope: undefined }), {
			armed: true,
		});
		await waitFor(() => decisions.some(({ component }) => component === COMPONENT), { message: 'no decision' });
		await sleep(500);
		assert.equal(await certificationRequest('commit', other), true);
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'an overlapping rollout never ended' });
		return decisions.map(({ component, status }) => `${component}:${status}`).sort();
	}

	it('starts no later replacement while another release is armed, so overlapping rollouts both end', async () => {
		plan([{ outcome: 'loaded', delayMs: 300 }]);
		assert.deepStrictEqual(await overlappingRollouts(OTHER), ['api:certified', `${COMPONENT}:certified`]);
	});

	it('replaces a worker again when its replacement was stopped for another release, not for its own', async () => {
		// This rollout's second replacement is the other release's canary, and fails only that one.
		plan([
			{ outcome: 'loaded', delayMs: 300 },
			{ outcome: 'loaded', outcomes: { api: 'failed' } },
		]);
		assert.deepStrictEqual(await overlappingRollouts(OTHER), ['api:rejected', `${COMPONENT}:certified`]);
		assert.deepStrictEqual(
			pool.filter((worker) => httpWorkers().includes(worker)),
			[],
			'every worker was replaced on the certified release'
		);
	});

	it('interrupts the release a stopped held start was the canary of, when another release it loaded is refused', async () => {
		const other = { component: 'api', deploymentId: '22222222-2222-2222-2222-222222222222' };
		// The crash restart refuses this release only once the rollout's first replacement, the other release's canary,
		// has started too, and long before that replacement reports.
		plan([{ outcome: 'failed' }, { outcome: 'loaded', delayMs: 5000 }], { concurrentStarts: 2 });
		const loading = Promise.withResolvers();
		rootLoad = loading.promise;
		releaseRootLoad = loading.resolve;
		await arm();
		await commit();
		// The rollout is still loading, so this crash restart is the canary of the committed release.
		await pool[2].terminate();
		await waitFor(() => started.length > 3, { message: 'the crash restart never started' });
		assert.deepStrictEqual(await certificationRequest('arm', { ...other, isolated: false, scope: undefined }), {
			armed: true,
		});
		loading.resolve();
		assert.equal(await certificationRequest('commit', other), true);
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'a rollout never ended' });
		assert.ok(
			started.some((worker) => worker.certifyRequests[0]?.length === 2),
			'a held start loaded both releases'
		);
		const byComponent = Object.fromEntries(decisions.map((decision) => [decision.component, decision]));
		assert.equal(byComponent[COMPONENT].status, 'rejected');
		assert.equal(byComponent.api.status, 'interrupted');
		assert.match(byComponent.api.reason, new RegExp(`release ${DEPLOYMENT} of ${COMPONENT}, which it also loaded`));
	});

	/** The rollout's first replacement waits out the other release's arming, so it starts as the canary of both. */
	async function sharedCanary(other) {
		const loading = Promise.withResolvers();
		rootLoad = loading.promise;
		releaseRootLoad = loading.resolve;
		await arm();
		await commit();
		assert.deepStrictEqual(await certificationRequest('arm', { ...other, isolated: false, scope: undefined }), {
			armed: true,
		});
		loading.resolve();
		assert.equal(await certificationRequest('commit', other), true);
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'a rollout never ended' });
		assert.ok(
			started.some((worker) => worker.certifyRequests[0]?.length === 2),
			'one held start loaded both releases'
		);
		return Object.fromEntries(decisions.map((decision) => [decision.component, decision]));
	}

	it('decides each release a shared canary reported on by its own report, even once the other is refused', async () => {
		const other = { component: 'api', deploymentId: '22222222-2222-2222-2222-222222222222' };
		plan([{ outcomes: { [COMPONENT]: 'failed', api: 'loaded' } }]);
		const byComponent = await sharedCanary(other);
		assert.equal(byComponent[COMPONENT].status, 'rejected');
		assert.equal(byComponent.api.status, 'certified', 'the canary loaded it');
	});

	it('rejects every release a shared canary went silent on for its silence, not for each other', async () => {
		const other = { component: 'api', deploymentId: '22222222-2222-2222-2222-222222222222' };
		plan([{ behavior: 'silent' }]);
		const byComponent = await sharedCanary(other);
		for (const decision of Object.values(byComponent)) {
			assert.equal(decision.status, 'rejected');
			assert.match(decision.reason, /did not report within/);
		}
	});

	it('makes no start booted while a release was armed its canary, even once that start goes silent', async () => {
		// The start made while the release is armed goes silent; its copy, made once the release is live, loads it.
		plan([{ behavior: 'silent' }, { outcome: 'loaded' }]);
		const loading = Promise.withResolvers();
		rootLoad = loading.promise;
		releaseRootLoad = loading.resolve;
		await arm();
		const before = started.length;
		void startFixture(3).catch(() => {});
		await waitFor(() => started.length > before, { message: 'the start never began' });
		await commit();
		assert.equal((await decisionOf()).status, 'certified', 'the start that said nothing about it did not reject it');
		loading.resolve();
		await rolledOut();
	});

	it('stops a silent start whose only release is already being decided, rather than leave it held', async () => {
		plan([{ behavior: 'silent' }]);
		const recording = Promise.withResolvers();
		setCertificationHandler(
			handler({
				decide: async (certification, decision) => {
					decisions.push({ component: certification.component, at: Date.now(), ...decision });
					await recording.promise;
					return decision;
				},
			})
		);
		const failing = Promise.reject(new Error('the reload failed'));
		failing.catch(() => {});
		rootLoad = failing;
		await arm();
		await commit();
		// The rollout fails before any start is the release's canary, so it decides `interrupted`, whose record waits.
		await waitFor(() => decisions.length === 1, { message: 'the rollout never decided' });
		await pool[2].terminate();
		const silent = await waitFor(() => started.find((worker) => !pool.includes(worker)), {
			message: 'the crash restart never started',
		});
		await waitFor(() => silent.exitedAt, { timeout: 5000, message: 'the silent start was left held' });
		recording.resolve();
		await rolledOut();
	});

	it('refuses a start already loading when a release went live, and starts it again held for that release', async () => {
		plan([{ outcome: 'loaded' }], { unheldLoadMs: 600 });
		const loading = Promise.withResolvers();
		rootLoad = loading.promise;
		releaseRootLoad = loading.resolve;
		await pool[1].terminate();
		await waitFor(() => started.length === 4, { message: 'the crash restart never started' });
		const crossed = started.at(-1);
		await arm();
		await commit();
		await waitFor(() => crossed.exitedAt, { message: 'the start whose load crossed the commit was admitted' });
		assert.ok(!crossed.admitted, 'it never bound');
		const held = await waitFor(() => started.find((worker) => worker !== crossed && !pool.includes(worker)), {
			message: 'it was not started again',
		});
		await waitFor(() => held.certifyRequests.length > 0);
		assert.deepStrictEqual(held.certifyRequests, [[{ component: COMPONENT, deploymentId: DEPLOYMENT }]]);
		assert.equal((await decisionOf()).status, 'certified');
		releaseRootLoad();
		await rolledOut();
	});

	it("replaces a rollout's replacement again when another release went live while it was loading", async () => {
		plan([{ outcome: 'loaded', delayMs: 800 }, { outcome: 'loaded' }]);
		await arm();
		await commit();
		const canary = await waitFor(() => started.find((worker) => !pool.includes(worker)), {
			message: 'no canary started',
		});
		assert.deepStrictEqual(await certificationRequest('arm', { ...OTHER, isolated: false, scope: undefined }), {
			armed: true,
		});
		assert.equal(await certificationRequest('commit', OTHER), true);
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'an overlapping rollout never ended' });
		assert.deepStrictEqual(decisions.map(({ component, status }) => `${component}:${status}`).sort(), [
			'api:certified',
			`${COMPONENT}:certified`,
		]);
		assert.ok(canary.exitedAt && !canary.admitted, 'the replacement whose load crossed the commit never bound');
		assert.deepStrictEqual(
			pool.filter((worker) => httpWorkers().includes(worker)),
			[],
			'every worker was replaced, the one whose replacement was refused included'
		);
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

	it("makes worker 0's replacement the canary, wherever worker 0 is in the pool", async () => {
		await pool[0].terminate();
		const restarted = await waitFor(() => started.length === 4 && started.at(-1), {
			message: 'worker 0 was not restarted',
		});
		await waitFor(() => restarted.admitted, { message: 'the restarted worker 0 never bound' });
		pool = [pool[1], pool[2], restarted];
		const before = started.length;
		await arm();
		await commit();
		assert.equal((await decisionOf()).status, 'certified');
		assert.equal(started[before].workerIndex, 0, 'the first replacement, the canary, replaces worker 0');
		await rolledOut();
	});

	it('replaces a requesting worker 0 first, so its replacement is still the canary', async () => {
		const requesterThreadId = pool[0].threadId;
		await arm({ requesterThreadId });
		const shutdownOrder = [];
		for (const worker of pool) {
			const threadId = worker.threadId;
			worker.once('shutdown', () => shutdownOrder.push(threadId));
		}
		const before = started.length;
		await commit();
		await decisionOf();
		assert.equal(started[before].workerIndex, 0);
		await certificationRequest('release', { component: COMPONENT, deploymentId: DEPLOYMENT });
		await rolledOut();
		assert.equal(shutdownOrder[0], requesterThreadId);
	});

	it('does not hold the rest of the rollout behind a requesting worker 0 that has not answered', async () => {
		// Each serving worker takes a while to exit once asked, as a requester its drain holds would.
		plan([{ outcome: 'loaded' }], { unheldShutdownDelayMs: 3000 });
		const [requester, next] = pool;
		await arm({ requesterThreadId: requester.threadId });
		let nextAskedAt;
		next.once('shutdown', () => (nextAskedAt = Date.now()));
		const committedAt = Date.now();
		await commit();
		await waitFor(() => nextAskedAt, { timeout: 30000, message: 'the next worker was never replaced' });
		assert.ok(nextAskedAt - committedAt < 8000, 'the rollout went on without the requester answering');
		if (process.platform === 'linux') {
			assert.ok(
				!requester.exitedAt || nextAskedAt < requester.exitedAt,
				"and without waiting for the requester's exit"
			);
		}
		await rolledOut();
	});

	it("starts a slot again when the gate stops the copy that replaced it after its predecessor's exit", async () => {
		// An uncertified rollout replaces the requester unheld; another release commits while it waits on the requester.
		plan([{ outcome: 'skipped' }, { outcome: 'loaded', outcomes: { api: 'failed' } }]);
		// The other release's refusal stays in its recording, where its predecessor would be restored, until released.
		const recording = Promise.withResolvers();
		setCertificationHandler(
			handler({
				decide: async (certification, decision) => {
					decisions.push({ component: certification.component, at: Date.now(), ...decision });
					if (certification.component === 'api') await recording.promise;
					return decision;
				},
			})
		);
		const requester = pool[1];
		await arm({ requesterThreadId: requester.threadId });
		await commit();
		assert.equal((await decisionOf()).status, 'uncertified');
		await waitFor(() => pool[2].exitedAt, { timeout: 30000, message: 'the rollout never reached the requester' });
		assert.deepStrictEqual(await certificationRequest('arm', { ...OTHER, isolated: false, scope: undefined }), {
			armed: true,
		});
		assert.equal(await certificationRequest('commit', OTHER), true);
		const startedBefore = started.length;
		await certificationRequest('release', { component: COMPONENT, deploymentId: DEPLOYMENT });
		await waitFor(() => decisions.some(({ component }) => component === 'api'), {
			timeout: 30000,
			message: 'the other release was never decided',
		});
		await sleep(1000);
		assert.equal(
			started.length - startedBefore,
			1,
			'only its canary started: nothing else loads while the refusal restores its predecessor'
		);
		recording.resolve();
		await waitFor(() => completions.length === 2, { timeout: 45000, message: 'a rollout never ended' });
		assert.equal(decisions.find(({ component }) => component === 'api')?.status, 'rejected');
		await waitFor(() => httpWorkers().length === 3, { timeout: 10000, message: 'the slot was left empty' });
	});

	it('replaces the requesting worker last, once it has answered', async () => {
		// Read now: a Worker's threadId reads back as -1 once it has exited.
		const requesterThreadId = pool[1].threadId;
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
