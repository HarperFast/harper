'use strict';

const assert = require('node:assert');
const path = require('node:path');
// Prime Harper's module graph in the same order the other models unit tests do (see Models.test.js).
require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { startWorker, onMessageByType, getWorkerIndex, setMainIsWorker } = manageThreads;
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { Models, ModelCapabilityError } = require('#src/resources/models/Models');
const { ModelBackendRegistrationError } = require('#src/resources/models/backendRegistry');
const {
	apportionUsage,
	ModelBackendUnavailableError,
	registerProcessBackend,
} = require('#src/resources/models/processBackend');
const { waitFor } = require('../../waitFor');

// Workers are started through manageThreads' startWorker, so they reach each other and the main
// thread (this mocha process, the coordinator) over the same port mesh production workers use.
const FIXTURE = path.join(__dirname, 'fixtures', 'processBackendWorker.cjs');
const WORKER_NAME = 'models-process-backend-test';
const COMMAND_TIMEOUT_MS = 20000;

const events = [];
const replies = new Map();
const readiness = new Map();
let nextCommand = 1;
onMessageByType('process-backend-test-event', (message) => events.push(message));
onMessageByType('process-backend-test-reply', (message) => replies.get(message.rid)?.(message));
onMessageByType('process-backend-test-ready', (message) => readiness.get(message.threadId)?.());

/** The fixture's fingerprint of a text, as a vector's first element carries it. */
function fingerprint(text) {
	let hash = 7;
	for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 16777216;
	return hash;
}

function startFixtureWorker(started) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name: WORKER_NAME,
			workerIndex: started.length,
			autoRestart: false,
			onStarted(worker) {
				started.push(worker);
				readiness.set(worker.threadId, () => resolve(worker));
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`Fixture worker exited before it was ready (code ${code})`)));
			},
		});
	});
}

/** Send a fixture command and resolve with its reply; `rid` identifies an embed to a later abort. */
function command(worker, body) {
	const rid = nextCommand++;
	const reply = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			replies.delete(rid);
			reject(new Error(`No reply to '${body.command}' from thread ${worker.threadId}`));
		}, COMMAND_TIMEOUT_MS);
		replies.set(rid, (message) => {
			clearTimeout(timer);
			replies.delete(rid);
			resolve(message);
		});
	});
	worker.postMessage({ type: 'process-backend-test-command', rid, ...body });
	return Object.assign(reply, { rid });
}

const factoryRuns = (id) => events.filter((event) => event.event === 'factory' && event.id === id);
const backendCalls = (prefix) =>
	events.filter((event) => event.event === 'embed' && event.texts.some((text) => text.startsWith(prefix)));
const statusOf = async (worker, id) => (await command(worker, { command: 'status', id })).status;

/** Wait until `worker` reports `id` in a state matching `predicate`, and return that status. */
function waitForStatus(worker, id, predicate, description) {
	let last;
	return waitFor(
		async () => {
			last = await statusOf(worker, id);
			return predicate(last) && last;
		},
		{ timeout: 10000, message: () => `${description}; last status ${JSON.stringify(last)}` }
	);
}

function assertServedBy(reply, texts, ownerThreadId) {
	assert.ok(reply.ok, `embed failed: ${JSON.stringify(reply.error)}`);
	assert.deepStrictEqual(
		reply.vectors,
		texts.map((text) => [fingerprint(text), ownerThreadId])
	);
}

describe('models.registerProcessBackend: one backend per process, served to every worker thread', function () {
	let workers = [];

	afterEach(async function () {
		for (const worker of workers.reverse()) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
		workers = [];
	});

	async function startWorkers(count) {
		for (let i = 0; i < count; i++) await startFixtureWorker(workers);
		return workers;
	}

	/** Register `id` on each worker in turn, waiting until each one sees the owner main elected. */
	async function registerInOrder(list, id, options) {
		for (const worker of list) {
			await command(worker, { command: 'register', id, options });
			await waitForStatus(
				worker,
				id,
				(status) => status?.owner !== undefined,
				`${id}: no owner reached ${worker.threadId}`
			);
		}
	}

	it('serves two workers from one owner whose factory and model load run exactly once', async function () {
		const [first, second] = await startWorkers(2);
		await registerInOrder([first, second], 'one-owner');
		const fromFirst = await command(first, { command: 'embed', id: 'one-owner', texts: ['one-owner:a'] });
		const fromSecond = await command(second, {
			command: 'embed',
			id: 'one-owner',
			texts: ['one-owner:b', 'one-owner:c'],
		});

		assertServedBy(fromFirst, ['one-owner:a'], first.threadId);
		assertServedBy(fromSecond, ['one-owner:b', 'one-owner:c'], first.threadId);
		assert.deepStrictEqual(
			factoryRuns('one-owner').map((event) => event.threadId),
			[first.threadId],
			'the factory ran once, on the owner'
		);
		assert.ok(backendCalls('one-owner:').every((event) => event.threadId === first.threadId));
		// Readiness is pushed by main once the owner reports, so it can trail the first answered call.
		const ready = await waitForStatus(
			second,
			'one-owner',
			(status) => status?.state === 'ready',
			'one-owner: not ready'
		);
		assert.deepStrictEqual(ready, {
			scope: 'process',
			state: 'ready',
			owner: first.threadId,
			restarts: 0,
			maxRestarts: 1,
			generation: ready.generation,
		});
		assert.deepStrictEqual(await statusOf(first, 'one-owner'), ready, 'every worker reports the same state');
	});

	it("aborts the owner's backend call when the calling worker aborts", async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'cancel');
		const call = command(caller, { command: 'embed', id: 'cancel', texts: ['until-aborted:cancel'] });
		await waitFor(() => events.some((event) => event.event === 'waiting' && event.text === 'until-aborted:cancel'));
		await command(caller, { command: 'abort', target: call.rid });

		const reply = await call;
		assert.strictEqual(reply.ok, false);
		assert.strictEqual(reply.error.name, 'AbortError');
		const aborted = await waitFor(() =>
			events.find((event) => event.event === 'aborted' && event.text === 'until-aborted:cancel')
		);
		assert.strictEqual(aborted.threadId, owner.threadId, "the abort reached the owner's backend call");
	});

	it('answers concurrent requests from several workers, each with its own result', async function () {
		const list = await startWorkers(3);
		await registerInOrder(list, 'concurrent');
		const sent = [];
		for (const worker of list)
			for (let i = 0; i < 15; i++) {
				const texts =
					i % 3 === 0
						? [`concurrent:${worker.threadId}:${i}:x`, `concurrent:${worker.threadId}:${i}:y`]
						: [`concurrent:${worker.threadId}:${i}`];
				sent.push({ texts, reply: command(worker, { command: 'embed', id: 'concurrent', texts }) });
			}
		for (const { texts, reply } of sent) assertServedBy(await reply, texts, list[0].threadId);
		assert.strictEqual(factoryRuns('concurrent').length, 1);
	});

	it('merges queued embed requests into one backend call when maxBatchInputs allows', async function () {
		const [owner, ...callers] = await startWorkers(3);
		await registerInOrder([owner, ...callers], 'batched', { maxBatchInputs: 8 });
		const gate = command(owner, { command: 'embed', id: 'batched', texts: ['gate:batched'] });
		await waitFor(() => backendCalls('gate:batched').length === 1);
		const sent = [];
		for (const worker of callers)
			for (let i = 0; i < 6; i++) {
				const texts = [`batched:${worker.threadId}:${i}`];
				sent.push({ texts, reply: command(worker, { command: 'embed', id: 'batched', texts }) });
			}
		// Every request is queued behind the held call before it is let go.
		await waitFor(async () => (await command(owner, { command: 'load', id: 'batched' })).load?.queued === 12, 10000);
		await command(owner, { command: 'release', text: 'gate:batched' });

		assertServedBy(await gate, ['gate:batched'], owner.threadId);
		for (const { texts, reply } of sent) assertServedBy(await reply, texts, owner.threadId);
		const merged = backendCalls('batched:');
		assert.deepStrictEqual(
			merged.map((event) => event.texts.length),
			[8, 4],
			'twelve queued requests ran as two calls of at most eight inputs'
		);
	});

	it('refuses a request past maxPending with ModelBackendBusyError instead of queueing it', async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'busy', { maxPending: 1 });
		const held = command(owner, { command: 'embed', id: 'busy', texts: ['gate:busy'] });
		await waitFor(() => backendCalls('gate:busy').length === 1);
		const queued = command(caller, { command: 'embed', id: 'busy', texts: ['busy:queued'] });
		await waitFor(async () => (await command(owner, { command: 'load', id: 'busy' })).load?.queued === 1);

		const refused = await command(caller, { command: 'embed', id: 'busy', texts: ['busy:refused'] });
		assert.strictEqual(refused.ok, false);
		assert.strictEqual(refused.error.name, 'ModelBackendBusyError');
		await command(owner, { command: 'release', text: 'gate:busy' });
		assertServedBy(await held, ['gate:busy'], owner.threadId);
		assertServedBy(await queued, ['busy:queued'], owner.threadId);
	});

	it('fails in-flight calls with a named error when the owner dies, restarts once, then stops', async function () {
		const [owner, second, third] = await startWorkers(3);
		// A Worker's threadId reads -1 once it has exited.
		const [ownerId, secondId] = [owner.threadId, second.threadId];
		await registerInOrder([owner, second, third], 'restart');
		const inFlight = command(second, { command: 'embed', id: 'restart', texts: ['until-aborted:restart'] });
		await waitFor(() => events.some((event) => event.event === 'waiting' && event.text === 'until-aborted:restart'));
		owner.wasShutdown = true;
		await owner.terminate();

		const lost = await inFlight;
		assert.strictEqual(lost.ok, false);
		assert.strictEqual(lost.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(lost.error.reason, 'owner-exited');

		// One restart: the earliest surviving claimant becomes the owner and runs its factory.
		const restarted = await waitForStatus(
			third,
			'restart',
			(status) => status?.state === 'ready' && status.owner !== ownerId,
			'restart: no new owner became ready'
		);
		assert.strictEqual(restarted.owner, secondId);
		assert.strictEqual(restarted.restarts, 1);
		assertServedBy(
			await command(third, { command: 'embed', id: 'restart', texts: ['restart:after'] }),
			['restart:after'],
			secondId
		);
		assert.deepStrictEqual(
			factoryRuns('restart').map((event) => event.threadId),
			[ownerId, secondId]
		);

		// The budget is spent: losing the second owner fails the backend instead of loading it again.
		second.wasShutdown = true;
		await second.terminate();
		const failed = await waitForStatus(
			third,
			'restart',
			(status) => status?.state === 'failed',
			'restart: never failed'
		);
		assert.strictEqual(failed.reason, 'owner-exited');
		assert.strictEqual(failed.owner, undefined);
		const refused = await command(third, { command: 'embed', id: 'restart', texts: ['restart:refused'] });
		assert.strictEqual(refused.ok, false);
		assert.strictEqual(refused.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(refused.error.reason, 'failed');
		assert.strictEqual(factoryRuns('restart').length, 2, 'no thread fell back to loading its own copy');
	});

	it('hands ownership over without spending the restart budget when the owner is told to shut down', async function () {
		const [owner, successor] = await startWorkers(2);
		const ownerId = owner.threadId;
		await registerInOrder([owner, successor], 'handover');
		await waitForStatus(successor, 'handover', (status) => status?.state === 'ready', 'handover: not ready');
		// What a rolling restart sends a worker before it stops it.
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });

		const handedOver = await waitForStatus(
			successor,
			'handover',
			(status) => status?.state === 'ready' && status.owner === successor.threadId,
			'handover: the successor never became the ready owner'
		);
		assert.strictEqual(handedOver.restarts, 0, 'a planned exit is not a failure');
		owner.wasShutdown = true;
		await owner.terminate();
		assertServedBy(
			await command(successor, { command: 'embed', id: 'handover', texts: ['handover:after'] }),
			['handover:after'],
			successor.threadId
		);
		assert.deepStrictEqual(
			factoryRuns('handover').map((event) => event.threadId),
			[ownerId, successor.threadId]
		);
		assert.strictEqual((await statusOf(successor, 'handover')).restarts, 0);
	});

	it('restarts a failed start on another worker and fails the requests that waited on it', async function () {
		const [failing, healthy] = await startWorkers(2);
		await command(failing, { command: 'register', id: 'start-failure', failStart: true });
		await waitFor(() => factoryRuns('start-failure').length === 1);
		await command(healthy, { command: 'register', id: 'start-failure' });
		await waitForStatus(
			healthy,
			'start-failure',
			(status) => status?.owner === failing.threadId,
			'start-failure: owner not seen'
		);
		const waiting = command(healthy, { command: 'embed', id: 'start-failure', texts: ['start-failure:early'] });
		await waitFor(async () => (await command(failing, { command: 'load', id: 'start-failure' })).load?.queued === 1);
		await command(failing, { command: 'release', text: 'start:start-failure' });

		const early = await waiting;
		assert.strictEqual(early.ok, false);
		assert.strictEqual(early.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(early.error.reason, 'start-failed');
		const status = await waitForStatus(
			failing,
			'start-failure',
			(candidate) => candidate?.state === 'ready',
			'start-failure: restart never became ready'
		);
		assert.strictEqual(status.owner, healthy.threadId);
		assert.strictEqual(status.restarts, 1);
		assertServedBy(
			await command(failing, { command: 'embed', id: 'start-failure', texts: ['start-failure:later'] }),
			['start-failure:later'],
			healthy.threadId
		);
	});

	it('leaves registerBackend per thread: each worker builds and serves its own backend', async function () {
		const [first, second] = await startWorkers(2);
		await command(first, { command: 'register', id: 'per-thread', scope: 'thread' });
		await command(second, { command: 'register', id: 'per-thread', scope: 'thread' });

		assertServedBy(
			await command(first, { command: 'embed', id: 'per-thread', texts: ['per-thread:a'] }),
			['per-thread:a'],
			first.threadId
		);
		assertServedBy(
			await command(second, { command: 'embed', id: 'per-thread', texts: ['per-thread:b'] }),
			['per-thread:b'],
			second.threadId
		);
		assert.deepStrictEqual(
			factoryRuns('per-thread').map((event) => event.threadId),
			[first.threadId, second.threadId]
		);
		assert.deepStrictEqual(await statusOf(second, 'per-thread'), { scope: 'thread', state: 'ready' });
	});
});

describe('models.registerProcessBackend on the main thread', function () {
	const writer = {
		records: [],
		write(record) {
			this.records.push(record);
			return this.records.length;
		},
	};
	const models = new Models(writer, () => {}, {});
	let wasWorker;

	before(() => {
		wasWorker = getWorkerIndex() === 0;
	});
	after(() => setMainIsWorker(wasWorker));

	it('owns and serves itself when the main thread is the only worker (threads.count 0)', async function () {
		setMainIsWorker(true);
		let factoryRuns = 0;
		models.registerProcessBackend('generative', 'main-owner', async ({ kind, logicalName }) => {
			factoryRuns++;
			assert.deepStrictEqual({ kind, logicalName }, { kind: 'generative', logicalName: 'main-owner' });
			return models.defineBackend({
				name: 'test:main-owner',
				generate: async (input) => ({
					status: 'completed',
					output: { content: `echo ${input}`, finishReason: 'stop' },
				}),
				generateStream: async function* () {
					yield { deltaContent: 'unreachable' };
				},
			});
		});

		const result = await models.generate('hi', { model: 'main-owner' });
		assert.strictEqual(result.content, 'echo hi');
		assert.strictEqual(factoryRuns, 1);
		await waitFor(() => models.backendStatus('generative', 'main-owner').state === 'ready');
		assert.deepStrictEqual(models.backendStatus('generative', 'main-owner'), {
			scope: 'process',
			state: 'ready',
			owner: 0,
			restarts: 0,
			maxRestarts: 1,
			generation: models.backendStatus('generative', 'main-owner').generation,
		});
		// Streams are not forwarded: the proxy says so instead of half-working.
		assert.throws(() => models.generateStream('hi', { model: 'main-owner' }), ModelCapabilityError);
		const row = writer.records.find((record) => record.method === 'generate');
		assert.strictEqual(row.backend, 'test:main-owner', "the caller's call row names the owner's backend");
		assert.strictEqual(row.success, true);
	});

	it('captures a backend the factory registers itself, as module factories do', async function () {
		setMainIsWorker(true);
		registerProcessBackend('embedding', 'main-module', ({ kind, logicalName }) => {
			models.registerBackend(
				kind,
				logicalName,
				models.defineBackend({
					name: 'test:module',
					embed: async (input) => ({ status: 'completed', output: [].concat(input).map(() => Float32Array.of(1)) }),
				})
			);
			return { engine: 'not a backend' };
		});
		const vectors = await models.embed(['a', 'b'], { model: 'main-module' });
		assert.deepStrictEqual(
			vectors.map((vector) => [...vector]),
			[[1], [1]]
		);
		await waitFor(() => models.backendStatus('embedding', 'main-module').state === 'ready');
	});

	it('bounds a call with timeoutMs and cancels it at the owner', async function () {
		setMainIsWorker(true);
		let ownerSignal;
		registerProcessBackend(
			'embedding',
			'main-timeout',
			() =>
				models.defineBackend({
					name: 'test:hang',
					embed: (input, opts) =>
						new Promise((resolve, reject) => {
							ownerSignal = opts.signal;
							opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
						}),
				}),
			{ timeoutMs: 100 }
		);
		await assert.rejects(models.embed('a', { model: 'main-timeout' }), (error) => {
			assert.ok(error instanceof ModelBackendUnavailableError);
			assert.strictEqual(error.reason, 'timeout');
			return true;
		});
		await waitFor(() => ownerSignal?.aborted);
	});

	it('names a factory that produces no backend as a failed start', async function () {
		setMainIsWorker(true);
		registerProcessBackend('embedding', 'main-empty', () => undefined, { maxRestarts: 0 });
		await assert.rejects(models.embed('a', { model: 'main-empty' }), (error) => {
			assert.ok(error instanceof ModelBackendUnavailableError);
			assert.ok(['start-failed', 'failed'].includes(error.reason), error.reason);
			return true;
		});
		const status = await waitFor(() => {
			const current = models.backendStatus('embedding', 'main-empty');
			return current.state === 'failed' && current;
		});
		assert.strictEqual(status.reason, 'start-failed');
		assert.strictEqual(status.error.name, 'ModelBackendRegistrationError');
	});

	it('rejects invalid registrations up front', function () {
		assert.throws(() => registerProcessBackend('embedding', 'bad', 'not a function'), ModelBackendRegistrationError);
		assert.throws(() => registerProcessBackend('embedding', '', () => undefined), ModelBackendRegistrationError);
		assert.throws(
			() => registerProcessBackend('embedding', 'bad', () => undefined, { concurrency: 0 }),
			ModelBackendRegistrationError
		);
		assert.throws(
			() => registerProcessBackend('generative', 'bad', () => undefined, { maxBatchInputs: 4 }),
			/embedding backends only/
		);
		assert.strictEqual(models.backendStatus('embedding', 'bad'), undefined, 'a refused registration installs nothing');
	});
});

describe('apportionUsage', function () {
	it('splits a merged call into whole token counts that sum to the reported total', function () {
		const shares = apportionUsage({ embeddingTokens: 10, latencyMs: 40, gpuMs: 6 }, [1, 1, 1]);
		assert.deepStrictEqual(
			shares.map((share) => share.embeddingTokens),
			[4, 3, 3]
		);
		assert.ok(shares.every((share) => share.latencyMs === 40));
		assert.strictEqual(
			shares.reduce((sum, share) => sum + share.gpuMs, 0),
			6
		);
		assert.deepStrictEqual(apportionUsage(undefined, [2, 1]), [undefined, undefined]);
	});
});
