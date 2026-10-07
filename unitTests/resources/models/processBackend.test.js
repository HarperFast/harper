'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
// Prime Harper's module graph in the same order the other models unit tests do (see Models.test.js).
require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { startWorker, onMessageByType, getWorkerIndex, setMainIsWorker } = manageThreads;
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { Models, ModelCapabilityError } = require('#src/resources/models/Models');
const { getBackend, ModelBackendRegistrationError } = require('#src/resources/models/backendRegistry');
const {
	apportionUsage,
	backendStatus,
	callerLoad,
	ModelBackendBusyError,
	ModelBackendUnavailableError,
	ownerLoad: localOwnerLoad,
	registerProcessBackend,
	sameValue,
	takePartialUsage,
} = require('#src/resources/models/processBackend');
const { waitFor } = require('../../waitFor');

// Workers are started through manageThreads' startWorker, so they reach each other and the main
// thread (this mocha process, the coordinator) over the same port mesh production workers use.
const FIXTURE = path.join(__dirname, 'fixtures', 'processBackendWorker.cjs');
const WORKER_NAME = 'models-process-backend-test';
const COMMAND_TIMEOUT_MS = 20000;
// The protocol's message types, for the hand-built messages a misbehaving thread could send.
const CLAIM = 'models-process-backend-claim';
const STATE = 'models-process-backend-state';
const REQUEST = 'models-process-backend-request';
const RESPONSE = 'models-process-backend-response';
const keyOf = (id, domain = '') => JSON.stringify([domain, 'embedding', id]);

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

function startFixtureWorker(started, options = {}) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name: WORKER_NAME,
			workerIndex: started.length,
			autoRestart: false,
			...options,
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
const waitingOn = (text) => waitFor(() => events.some((event) => event.event === 'waiting' && event.text === text));
const statusOf = async (worker, id, kind) => (await command(worker, { command: 'status', id, kind })).status;
const ownerLoad = async (worker, id) => (await command(worker, { command: 'load', id })).load;
const rawResponse = (request) =>
	waitFor(() => events.find((event) => event.event === 'raw-response' && event.message.request === request), 10000);

/** Wait until `worker` reports `id` in a state matching `predicate`, and return that status. */
function waitForStatus(worker, id, predicate, description, kind) {
	let last;
	return waitFor(
		async () => {
			last = await statusOf(worker, id, kind);
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

/** A hand-built request, as a thread holding the `threads` global could send one. */
function rawRequest(id, origin, request, overrides = {}) {
	return {
		type: REQUEST,
		key: keyOf(id),
		kind: 'embedding',
		logicalName: id,
		request,
		origin,
		version: 0,
		epoch: 1,
		method: 'embed',
		args: [[`${id}:raw`]],
		opts: {},
		accounting: {},
		...overrides,
	};
}

describe('models.registerProcessBackend: one live backend instance per key, served to every worker thread', function () {
	let workers = [];

	afterEach(async function () {
		for (const worker of workers.reverse()) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
		workers = [];
	});

	async function startWorkers(count) {
		const started = [];
		for (let i = 0; i < count; i++) started.push(await startFixtureWorker(workers));
		return started;
	}

	/** Start a worker in worker generation `generation`, as `restartWorkers` would after a deploy. */
	async function startWorkerInGeneration(generation) {
		const saved = manageThreads.restartNumber;
		manageThreads.restartNumber = generation;
		try {
			return await startFixtureWorker(workers);
		} finally {
			manageThreads.restartNumber = saved;
		}
	}

	/** Register `id` on each worker in turn, waiting until each one sees the owner main elected. */
	async function registerInOrder(list, id, options, extra = {}) {
		for (const worker of list) {
			await command(worker, { command: 'register', id, options, ...extra });
			await waitForStatus(
				worker,
				id,
				(status) => status?.owner !== undefined,
				`${id}: no owner reached ${worker.threadId}`,
				extra.kind
			);
		}
	}

	/** Hold the owner's execution slot with a call gated on `gate:<tag>`, so later requests queue behind it. */
	function occupy(owner, id, tag = id) {
		return command(owner, { command: 'embed', id, texts: [`gate:${tag}`] });
	}

	it('serves two workers from one owner whose factory runs exactly once', async function () {
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
		assert.deepStrictEqual(await statusOf(first, 'one-owner'), ready, 'the views converge on the state main holds');
	});

	it("aborts the owner's backend call when the calling worker aborts", async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'cancel');
		const call = command(caller, { command: 'embed', id: 'cancel', texts: ['until-aborted:cancel'] });
		await waitingOn('until-aborted:cancel');
		await command(caller, { command: 'abort', target: call.rid });

		const reply = await call;
		assert.strictEqual(reply.ok, false);
		assert.strictEqual(reply.error.name, 'AbortError');
		assert.strictEqual(reply.listeners, 0, "the proxy removed its listener from the caller's signal");
		const aborted = await waitFor(() =>
			events.find((event) => event.event === 'aborted' && event.text === 'until-aborted:cancel')
		);
		assert.strictEqual(aborted.threadId, owner.threadId, "the abort reached the owner's backend call");
	});

	it('answers concurrent requests from several workers, each with its own result, and leaves nothing behind', async function () {
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
		for (const { texts, reply } of sent) {
			const answered = await reply;
			assertServedBy(answered, texts, list[0].threadId);
			assert.strictEqual(answered.listeners, 0, "no listener is left on the caller's signal");
		}
		assert.strictEqual(factoryRuns('concurrent').length, 1);
		const load = await ownerLoad(list[0], 'concurrent');
		assert.deepStrictEqual(
			{ queued: load.queued, active: load.active, parked: load.parked, phase: load.phase },
			{ queued: 0, active: 0, parked: 0, phase: 'ready' }
		);
		for (const worker of list)
			assert.deepStrictEqual((await command(worker, { command: 'callers', id: 'concurrent' })).load, {
				waiting: 0,
				inFlight: 0,
			});
	});

	it('merges queued embed requests into one backend call when maxBatchInputs allows', async function () {
		const [owner, ...callers] = await startWorkers(3);
		await registerInOrder([owner, ...callers], 'batched', { maxBatchInputs: 8 });
		const gate = occupy(owner, 'batched');
		await waitingOn('gate:batched');
		const sent = [];
		for (const worker of callers)
			for (let i = 0; i < 6; i++) {
				const texts = [`batched:${worker.threadId}:${i}`];
				sent.push({ texts, reply: command(worker, { command: 'embed', id: 'batched', texts }) });
			}
		// Every request is queued behind the held call before it is let go.
		await waitFor(async () => (await ownerLoad(owner, 'batched'))?.queued === 12, 10000);
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

	it('merges only requests whose options and accounting are the same, value for value', async function () {
		const [owner, ...callers] = await startWorkers(4);
		await registerInOrder([owner, ...callers], 'exact', { maxBatchInputs: 8 });
		const gate = occupy(owner, 'exact');
		await waitingOn('gate:exact');
		// JSON writes NaN as null, so a JSON key would have merged the first two.
		const nan = command(callers[0], { command: 'embed', id: 'exact', texts: ['exact:nan'], opts: { variant: NaN } });
		const nil = command(callers[1], { command: 'embed', id: 'exact', texts: ['exact:null'], opts: { variant: null } });
		const tenant = command(callers[2], {
			command: 'embed',
			id: 'exact',
			texts: ['exact:tenant'],
			opts: { variant: null },
			tenant: 'other-tenant',
		});
		await waitFor(async () => (await ownerLoad(owner, 'exact'))?.queued === 3, 10000);
		await command(owner, { command: 'release', text: 'gate:exact' });

		await gate;
		assertServedBy(await nan, ['exact:nan'], owner.threadId);
		assertServedBy(await nil, ['exact:null'], owner.threadId);
		assertServedBy(await tenant, ['exact:tenant'], owner.threadId);
		const calls = backendCalls('exact:');
		assert.deepStrictEqual(
			calls.map((event) => event.texts).sort(),
			[['exact:nan'], ['exact:null'], ['exact:tenant']],
			'no two of the three requests share their options and accounting, so none was merged'
		);
		const callFor = (text) => calls.find((event) => event.texts.includes(text));
		assert.ok(Number.isNaN(callFor('exact:nan').opts.variant), 'each call ran with its own options');
		assert.strictEqual(callFor('exact:null').opts.variant, null);
		assert.strictEqual(callFor('exact:null').accounting.tenantId, undefined);
		assert.strictEqual(callFor('exact:tenant').accounting.tenantId, 'other-tenant');
	});

	it('splits a request larger than maxBatchInputs into backend calls of at most that many inputs', async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'split', { maxBatchInputs: 4 });
		const texts = Array.from({ length: 10 }, (_, index) => `split:${index}`);
		assertServedBy(await command(caller, { command: 'embed', id: 'split', texts }), texts, owner.threadId);

		assert.deepStrictEqual(
			backendCalls('split:').map((event) => event.texts.length),
			[4, 4, 2]
		);
		const row = events.find(
			(event) => event.event === 'row' && event.threadId === caller.threadId && event.record.backend === 'test:split'
		);
		assert.strictEqual(row.record.embedding_tokens, 30, "the caller's row sums the usage of every part");
	});

	it('cancels a merged call only when every request in it is cancelled, and drops a cancelled queued request', async function () {
		const [owner, a, b, c] = await startWorkers(4);
		await registerInOrder([owner, a, b, c], 'merged-cancel', { maxBatchInputs: 8 });

		// One member cancels: the merged call keeps running for the others.
		let gate = occupy(owner, 'merged-cancel');
		await waitingOn('gate:merged-cancel');
		const holder = command(a, { command: 'embed', id: 'merged-cancel', texts: ['gate:merged-cancel:one'] });
		const quitter = command(b, { command: 'embed', id: 'merged-cancel', texts: ['merged-cancel:quitter'] });
		const stayer = command(c, { command: 'embed', id: 'merged-cancel', texts: ['merged-cancel:stayer'] });
		const dropped = command(b, { command: 'embed', id: 'merged-cancel', texts: ['merged-cancel:dropped'] });
		await waitFor(async () => (await ownerLoad(owner, 'merged-cancel'))?.queued === 4, 10000);
		// A request cancelled while it is queued leaves the queue and never reaches the backend.
		await command(b, { command: 'abort', target: dropped.rid });
		assert.strictEqual((await dropped).error.name, 'AbortError');
		await waitFor(async () => (await ownerLoad(owner, 'merged-cancel'))?.queued === 3, 10000);
		await command(owner, { command: 'release', text: 'gate:merged-cancel' });
		await gate;
		await waitingOn('gate:merged-cancel:one');
		await command(b, { command: 'abort', target: quitter.rid });
		assert.strictEqual((await quitter).error.name, 'AbortError');
		await command(owner, { command: 'release', text: 'gate:merged-cancel:one' });
		assertServedBy(await holder, ['gate:merged-cancel:one'], owner.threadId);
		assertServedBy(await stayer, ['merged-cancel:stayer'], owner.threadId);
		assert.deepStrictEqual(
			backendCalls('gate:merged-cancel:one').map((event) => [...event.texts].sort()),
			[['gate:merged-cancel:one', 'merged-cancel:quitter', 'merged-cancel:stayer']],
			'the three queued requests ran as one call'
		);
		assert.ok(!events.some((event) => event.event === 'aborted' && event.text === 'gate:merged-cancel:one'));
		assert.strictEqual(backendCalls('merged-cancel:dropped').length, 0);

		// Every member cancels: the merged call is aborted.
		gate = occupy(owner, 'merged-cancel', 'merged-cancel-2');
		await waitingOn('gate:merged-cancel-2');
		const first = command(a, { command: 'embed', id: 'merged-cancel', texts: ['gate:merged-cancel:all'] });
		const second = command(c, { command: 'embed', id: 'merged-cancel', texts: ['merged-cancel:all'] });
		await waitFor(async () => (await ownerLoad(owner, 'merged-cancel'))?.queued === 2, 10000);
		await command(owner, { command: 'release', text: 'gate:merged-cancel-2' });
		await gate;
		await waitingOn('gate:merged-cancel:all');
		await command(a, { command: 'abort', target: first.rid });
		await command(c, { command: 'abort', target: second.rid });
		assert.strictEqual((await first).error.name, 'AbortError');
		assert.strictEqual((await second).error.name, 'AbortError');
		const aborted = await waitFor(() =>
			events.find((event) => event.event === 'aborted' && event.text === 'gate:merged-cancel:all')
		);
		assert.strictEqual(aborted.threadId, owner.threadId);
	});

	it("bills a merged call once: the callers' rows sum exactly to the usage the backend reported", async function () {
		const [owner, ...callers] = await startWorkers(4);
		const usage = { embeddingTokens: 10.5, gpuMs: 7.3, latencyMs: 40 };
		await registerInOrder([owner, ...callers], 'usage', { maxBatchInputs: 8 }, { usage });
		const gate = occupy(owner, 'usage');
		await waitingOn('gate:usage');
		const sent = callers.map((worker) => {
			const texts = [`usage:${worker.threadId}`];
			return { texts, reply: command(worker, { command: 'embed', id: 'usage', texts }) };
		});
		await waitFor(async () => (await ownerLoad(owner, 'usage'))?.queued === 3, 10000);
		await command(owner, { command: 'release', text: 'gate:usage' });
		await gate;
		for (const { texts, reply } of sent) assertServedBy(await reply, texts, owner.threadId);

		assert.deepStrictEqual(
			backendCalls('usage:').map((event) => event.texts.length),
			[3],
			'the three requests ran as one call'
		);
		const callerIds = callers.map((worker) => worker.threadId);
		const rows = events.filter(
			(event) => event.event === 'row' && callerIds.includes(event.threadId) && event.record.backend === 'test:usage'
		);
		assert.strictEqual(rows.length, 3);
		const total = (field) => rows.reduce((sum, event) => sum + event.record[field], 0);
		assert.strictEqual(total('embedding_tokens'), usage.embeddingTokens);
		assert.strictEqual(total('gpu_ms'), usage.gpuMs);
		const tokens = events.filter(
			(event) => event.event === 'metric' && callerIds.includes(event.threadId) && event.metric === 'model-embed-tokens'
		);
		assert.strictEqual(
			tokens.reduce((sum, event) => sum + event.value, 0),
			usage.embeddingTokens
		);
	});

	it('refuses a request past maxPending with ModelBackendBusyError instead of queueing it', async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'busy', { maxPending: 1 });
		const held = occupy(owner, 'busy');
		await waitingOn('gate:busy');
		const queued = command(caller, { command: 'embed', id: 'busy', texts: ['busy:queued'] });
		await waitFor(async () => (await ownerLoad(owner, 'busy'))?.queued === 1);

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
		await waitingOn('until-aborted:restart');
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
		assert.strictEqual(refused.error.cause, undefined, "the loss's error stays in backendStatus");
		assert.strictEqual(factoryRuns('restart').length, 2, 'no thread fell back to loading its own copy');
	});

	it('hands over one live instance at a time: the released owner finishes its running call, re-routes the rest and disposes before the successor starts', async function () {
		const [owner, successor] = await startWorkers(2);
		const [ownerId, successorId] = [owner.threadId, successor.threadId];
		await registerInOrder([owner, successor], 'handover', undefined, { dispose: 'hold' });
		await waitForStatus(successor, 'handover', (status) => status?.state === 'ready', 'handover: not ready');
		// One call running at the owner and one queued behind it.
		const running = command(successor, { command: 'embed', id: 'handover', texts: ['gate:handover'] });
		await waitingOn('gate:handover');
		const queued = command(successor, { command: 'embed', id: 'handover', texts: ['handover:queued'] });
		await waitFor(async () => (await ownerLoad(owner, 'handover'))?.queued === 1);
		// What a rolling restart sends a worker before it stops it.
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });

		// While the released owner still runs a call, no successor is elected or starts a second instance.
		const handingOver = await waitForStatus(
			successor,
			'handover',
			(status) => status?.draining === ownerId,
			'handover: the released owner was never reported draining'
		);
		assert.strictEqual(handingOver.owner, undefined);
		// A request routed with an older view reaches the released owner and is refused as moved, not run.
		await command(successor, {
			command: 'send',
			target: ownerId,
			message: rawRequest('handover', successorId, 1e6 + 1, { args: [['handover:stale']] }),
		});
		const stale = await rawResponse(1e6 + 1);
		assert.strictEqual(stale.from, ownerId);
		assert.strictEqual(stale.message.ok, false);
		assert.strictEqual(stale.message.refused, 'moved');
		assert.deepStrictEqual(
			factoryRuns('handover').map((event) => event.threadId),
			[ownerId]
		);

		await command(owner, { command: 'release', text: 'gate:handover' });
		assertServedBy(await running, ['gate:handover'], ownerId);
		// The running call is done, so the owner disposes; until its dispose() settles nothing is elected.
		await waitFor(() => events.some((event) => event.event === 'dispose' && event.id === 'handover'));
		assert.strictEqual((await statusOf(successor, 'handover')).draining, ownerId);
		assert.deepStrictEqual(
			factoryRuns('handover').map((event) => event.threadId),
			[ownerId],
			'no successor starts while the released instance is still being disposed'
		);
		await command(owner, { command: 'release', text: 'dispose:handover' });
		assertServedBy(await queued, ['handover:queued'], successorId);
		const drained = await waitFor(() =>
			events.find((event) => event.event === 'drained' && event.threadId === ownerId)
		);
		assert.strictEqual(drained.hadWork, true, "the owner's instance held Harper's shutdown drain open");
		const handedOver = await waitForStatus(
			successor,
			'handover',
			(status) => status?.state === 'ready' && status.owner === successorId,
			'handover: the successor never became the ready owner'
		);
		assert.strictEqual(handedOver.restarts, 0, 'a planned exit is not a failure');
		assert.deepStrictEqual(
			events
				.filter((event) => (event.event === 'factory' || event.event === 'dispose') && event.id === 'handover')
				.map((event) => `${event.event}@${event.threadId}`),
			[`factory@${ownerId}`, `dispose@${ownerId}`, `factory@${successorId}`],
			'the old instance was disposed before the successor ran its factory'
		);
		assert.strictEqual(backendCalls('handover:stale').length, 0);
		owner.wasShutdown = true;
		await owner.terminate();
		assertServedBy(
			await command(successor, { command: 'embed', id: 'handover', texts: ['handover:after'] }),
			['handover:after'],
			successorId
		);
	});

	it('elects the newest generation present when the released instance is gone, and never preempts the owner it elected', async function () {
		const generation = manageThreads.restartNumber;
		const [owner, sameGeneration] = await startWorkers(2);
		const ownerId = owner.threadId;
		await registerInOrder([owner, sameGeneration], 'generation');
		const held = occupy(owner, 'generation');
		await waitingOn('gate:generation');
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: generation });
		await waitForStatus(
			sameGeneration,
			'generation',
			(status) => status?.draining === ownerId,
			'generation: the owner never started draining'
		);
		// A deploy's replacement claims while the old owner is still finishing its call.
		const newer = await startWorkerInGeneration(generation + 1);
		await command(newer, { command: 'register', id: 'generation' });
		await waitForStatus(
			newer,
			'generation',
			(status) => status?.draining === ownerId && status.generation === generation + 1,
			'generation: the newer claim never reached main'
		);
		await command(owner, { command: 'release', text: 'gate:generation' });
		await held;

		const elected = await waitForStatus(
			sameGeneration,
			'generation',
			(status) => status?.state === 'ready',
			'generation: no successor became ready'
		);
		assert.strictEqual(elected.owner, newer.threadId, 'the newer generation won over the older claimant');
		// A claim of a still newer generation, after the election, does not move a healthy owner.
		const newest = await startWorkerInGeneration(generation + 2);
		await registerInOrder([newest], 'generation');
		const kept = await statusOf(newest, 'generation');
		assert.strictEqual(kept.owner, newer.threadId);
		assert.strictEqual(kept.generation, generation + 2);
		assert.deepStrictEqual(
			factoryRuns('generation').map((event) => event.threadId),
			[ownerId, newer.threadId]
		);
	});

	it('bounds the calls that wait for an owner, in number and in time, fails them by name, and serves once a claimant arrives', async function () {
		const mainModels = new Models({ write: () => 0 }, () => {}, {});
		const wasWorker = getWorkerIndex() === 0;
		// While it has workers the main thread loads no application code: it can call, never own.
		setMainIsWorker(false);
		try {
			const [owner] = await startWorkers(1);
			const options = { ownerWaitMs: 300, maxPending: 2 };
			await registerInOrder([owner], 'unowned', options);
			registerProcessBackend(
				'embedding',
				'unowned',
				() => assert.fail('the main thread never runs the factory'),
				options
			);
			await waitFor(() => backendStatus('embedding', 'unowned')?.state === 'ready', 10000);
			owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });
			await waitFor(
				() => events.some((event) => event.event === 'drained' && event.threadId === owner.threadId),
				10000
			);
			const unowned = await waitFor(() => {
				const status = backendStatus('embedding', 'unowned');
				return status?.reason === 'no-owner' && status.draining === undefined && status;
			}, 10000);
			assert.strictEqual(unowned.owner, undefined);

			const waiting = ['unowned:1', 'unowned:2'].map((text) =>
				mainModels.embed(text, { model: 'unowned' }).then(
					() => assert.fail('no owner, so no answer'),
					(error) => error
				)
			);
			await waitFor(() => callerLoad('embedding', 'unowned').waiting === 2);
			await assert.rejects(mainModels.embed('unowned:3', { model: 'unowned' }), ModelBackendBusyError);
			for (const error of await Promise.all(waiting)) {
				assert.ok(error instanceof ModelBackendUnavailableError, String(error));
				assert.strictEqual(error.reason, 'no-owner');
			}
			assert.deepStrictEqual(callerLoad('embedding', 'unowned'), { waiting: 0, inFlight: 0 });

			const [replacement] = await startWorkers(1);
			await registerInOrder([replacement], 'unowned', options);
			const [vector] = await mainModels.embed('unowned:after', { model: 'unowned' });
			assert.deepStrictEqual([...vector], [fingerprint('unowned:after'), replacement.threadId]);
		} finally {
			setMainIsWorker(wasWorker);
		}
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
		await waitFor(async () => (await ownerLoad(failing, 'start-failure'))?.queued === 1);
		await command(failing, { command: 'release', text: 'start:start-failure' });

		const early = await waiting;
		assert.strictEqual(early.ok, false);
		assert.strictEqual(early.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(early.error.reason, 'start-failed');
		assert.ok(!early.error.message.includes('model file is missing'), "the factory's error is not the caller's");
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

	for (const [mode, description, pattern] of [
		['throw', 'throws', /capabilities are not readable yet/],
		['uncloneable', 'returns a value that cannot cross threads', /could not be cloned|clone/i],
	])
		it(`fails the start, and the calls that waited on it, when the backend's capabilities() ${description}`, async function () {
			const id = `capabilities-${mode}`;
			const [failing, caller] = await startWorkers(2);
			const options = { maxRestarts: 0 };
			await command(failing, { command: 'register', id, holdStart: true, capabilities: mode, options });
			await waitFor(() => factoryRuns(id).length === 1);
			await command(caller, { command: 'register', id, capabilities: mode, options });
			await waitForStatus(caller, id, (status) => status?.owner === failing.threadId, `${id}: owner not seen`);
			const waiting = command(caller, { command: 'embed', id, texts: [`${id}:early`] });
			await waitFor(async () => (await ownerLoad(failing, id))?.queued === 1);
			await command(failing, { command: 'release', text: `start:${id}` });

			const early = await waiting;
			assert.strictEqual(early.ok, false);
			assert.strictEqual(early.error.name, 'ModelBackendUnavailableError');
			assert.strictEqual(early.error.reason, 'start-failed');
			const failed = await waitForStatus(caller, id, (status) => status?.state === 'failed', `${id}: never failed`);
			assert.strictEqual(failed.reason, 'start-failed');
			assert.match(failed.error.message, pattern);
			assert.ok(
				events.some((event) => event.event === 'dispose' && event.id === id && event.threadId === failing.threadId),
				'the instance the factory built was disposed'
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

	it('identifies every sender by the port its message came over: a forged state push or response is ignored', async function () {
		const [owner, caller, forger] = await startWorkers(3);
		await registerInOrder([owner, caller, forger], 'forged');
		await waitForStatus(caller, 'forged', (status) => status?.state === 'ready', 'forged: not ready');
		const pending = command(caller, { command: 'embed', id: 'forged', texts: ['gate:forged'] });
		await waitingOn('gate:forged');

		// A state push naming the forger as owner, claiming to come from main.
		await command(forger, {
			command: 'send',
			target: caller.threadId,
			message: {
				type: STATE,
				key: keyOf('forged'),
				version: 1e9,
				epoch: 1e9,
				state: 'ready',
				owner: forger.threadId,
				restarts: 0,
				maxRestarts: 1,
				generation: 1,
				origin: 0,
			},
		});
		// A response claiming to come from the owner, for every request id the caller could be waiting on.
		for (let request = 1; request <= 64; request++)
			await command(forger, {
				command: 'send',
				target: caller.threadId,
				message: {
					type: RESPONSE,
					request,
					origin: owner.threadId,
					ok: true,
					result: { status: 'completed', output: [Float32Array.of(-1, -1)] },
				},
			});
		// Asserting a non-event: give the forged messages time to be (not) acted on.
		await delay(200);
		assert.strictEqual((await statusOf(caller, 'forged')).owner, owner.threadId);
		await command(owner, { command: 'release', text: 'gate:forged' });
		assertServedBy(await pending, ['gate:forged'], owner.threadId);
	});

	it("keeps an isolated application's backends apart from the shared pool's, whatever its messages claim", async function () {
		const [shared] = await startWorkers(1);
		const isolated = await startFixtureWorker(workers, { application: 'isolated-app' });
		await registerInOrder([shared], 'domain');
		await registerInOrder([isolated], 'domain');
		assertServedBy(
			await command(shared, { command: 'embed', id: 'domain', texts: ['domain:shared'] }),
			['domain:shared'],
			shared.threadId
		);
		assertServedBy(
			await command(isolated, { command: 'embed', id: 'domain', texts: ['domain:isolated'] }),
			['domain:isolated'],
			isolated.threadId
		);
		assert.deepStrictEqual(
			factoryRuns('domain')
				.map((event) => event.threadId)
				.sort(),
			[shared.threadId, isolated.threadId].sort(),
			'each domain elected its own owner'
		);

		// The isolated worker claims the shared pool's key outright, then asks the shared owner to serve it.
		await command(isolated, {
			command: 'send',
			target: 0,
			message: {
				type: CLAIM,
				key: keyOf('domain'),
				origin: isolated.threadId,
				generation: 1,
				eligible: true,
				options: { concurrency: 1, maxPending: 256, maxRestarts: 1, ownerWaitMs: 30000 },
			},
		});
		await delay(100);
		await command(isolated, {
			command: 'send',
			target: shared.threadId,
			message: rawRequest('domain', isolated.threadId, 1e6 + 2, { args: [['domain:intruder']] }),
		});
		const answer = await rawResponse(1e6 + 2);
		assert.strictEqual(answer.message.ok, false);
		assert.strictEqual(answer.message.refused, 'not-owner');
		assert.strictEqual(backendCalls('domain:intruder').length, 0);
	});

	it('starts a factory only on an election from main, never on a request that names one', async function () {
		const [owner, bystander, caller] = await startWorkers(3);
		await registerInOrder([owner, bystander, caller], 'elected');
		await command(caller, {
			command: 'send',
			target: bystander.threadId,
			message: rawRequest('elected', caller.threadId, 1e6 + 3, { epoch: 1e6 }),
		});
		const answer = await rawResponse(1e6 + 3);
		assert.strictEqual(answer.from, bystander.threadId);
		assert.strictEqual(answer.message.ok, false);
		assert.strictEqual(answer.message.refused, 'moved');
		assert.deepStrictEqual(
			factoryRuns('elected').map((event) => event.threadId),
			[owner.threadId]
		);
	});

	it("holds a request that names a state the owner has not seen yet until main's push arrives", async function () {
		const [owner, caller, latecomer] = await startWorkers(3);
		await registerInOrder([owner, caller], 'early-request');
		const seen = await ownerLoad(owner, 'early-request');
		// The request the caller would send had it already seen main's next push.
		await command(caller, {
			command: 'send',
			target: owner.threadId,
			message: rawRequest('early-request', caller.threadId, 1e6 + 4, {
				version: seen.version + 1,
				epoch: seen.epoch,
				args: [['early-request:raced']],
			}),
		});
		await waitFor(async () => (await ownerLoad(owner, 'early-request'))?.parked === 1);
		assert.strictEqual(backendCalls('early-request:raced').length, 0);
		// The next claim makes main push its next state to the owner, which then serves the request.
		await registerInOrder([latecomer], 'early-request');
		const answer = await rawResponse(1e6 + 4);
		assert.strictEqual(answer.message.ok, true);
		assert.deepStrictEqual([...answer.message.result.output[0]], [fingerprint('early-request:raced'), owner.threadId]);
	});

	it('forwards generate, scoreChoices and decide from worker to worker', async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'remote-generative', undefined, { kind: 'generative' });
		await registerInOrder([owner, caller], 'remote-decision', undefined, { kind: 'decision' });
		// scoreChoices is advertised once the owner reports its capabilities.
		await waitForStatus(
			caller,
			'remote-generative',
			(status) => status?.state === 'ready',
			'remote-generative: not ready',
			'generative'
		);

		const generated = await command(caller, { command: 'generate', id: 'remote-generative', input: 'hello' });
		assert.ok(generated.ok, JSON.stringify(generated.error));
		assert.strictEqual(generated.result.content, `${owner.threadId}:hello`);
		const scored = await command(caller, {
			command: 'scoreChoices',
			id: 'remote-generative',
			input: 'pick',
			choices: ['a', 'b'],
		});
		assert.ok(scored.ok, JSON.stringify(scored.error));
		assert.deepStrictEqual(scored.result.logLikelihoods, [-owner.threadId / 1000, -1 - owner.threadId / 1000]);
		const decided = await command(caller, {
			command: 'decide',
			id: 'remote-decision',
			state: 'state',
			schema: { enum: ['first', 'second'] },
		});
		assert.ok(decided.ok, JSON.stringify(decided.error));
		assert.strictEqual(decided.value, 'first');
	});

	it("rebuilds a backend's error on the caller with its name, status code and code", async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'errors');
		const reply = await command(caller, { command: 'embed', id: 'errors', texts: ['error:429:rate_limited'] });
		assert.strictEqual(reply.ok, false);
		assert.deepStrictEqual(
			{
				name: reply.error.name,
				message: reply.error.message,
				statusCode: reply.error.statusCode,
				code: reply.error.code,
			},
			{
				name: 'ProviderError',
				message: 'provider refused error:429:rate_limited',
				statusCode: 429,
				code: 'rate_limited',
			}
		);
	});

	it('falls back to a configured fallback group member when the process-wide backend has failed', async function () {
		const [owner, caller] = await startWorkers(2);
		const options = { maxRestarts: 0 };
		await command(owner, { command: 'register', id: 'with-fallback', failStart: true, options });
		await waitFor(() => factoryRuns('with-fallback').length === 1);
		await command(caller, { command: 'register', id: 'with-fallback', options });
		await command(caller, { command: 'fallback', id: 'with-fallback', fallbackId: 'fallback-member' });
		await command(owner, { command: 'release', text: 'start:with-fallback' });
		await waitForStatus(caller, 'with-fallback', (status) => status?.state === 'failed', 'with-fallback: not failed');

		assertServedBy(
			await command(caller, { command: 'embed', id: 'with-fallback', texts: ['with-fallback:a'] }),
			['with-fallback:a'],
			caller.threadId
		);
		const rows = events
			.filter(
				(event) => event.event === 'row' && event.threadId === caller.threadId && event.record.model === 'with-fallback'
			)
			.map((event) => [event.record.backend, event.record.success, event.record.error_code]);
		assert.deepStrictEqual(rows, [
			['process:with-fallback', false, 'backend_unavailable'],
			['test:fallback-member', true, undefined],
		]);
	});

	it("keeps the first claim's restart budget when claims of one generation disagree", async function () {
		const [first, second] = await startWorkers(2);
		await registerInOrder([first], 'divergent', { maxRestarts: 1 });
		await registerInOrder([second], 'divergent', { maxRestarts: 3 });
		assert.strictEqual((await statusOf(second, 'divergent')).maxRestarts, 1);
		assert.strictEqual((await statusOf(first, 'divergent')).maxRestarts, 1);
	});

	it('never sends a call again once its backend has run, even if the backend throws an error shaped like a move', async function () {
		const [owner, other] = await startWorkers(2);
		const options = { ownerWaitMs: 1000 };
		await registerInOrder([owner], 'moved-shaped', options);
		// The owner calls its own backend, so it receives main's next push while the call settles.
		const call = command(owner, { command: 'embed', id: 'moved-shaped', texts: ['moved-shaped:a'] });
		await waitFor(() => backendCalls('moved-shaped:').length === 1);
		// A newer state: a proxy that took the backend's error for the protocol's move would send the call again.
		await registerInOrder([other], 'moved-shaped', options);

		const reply = await call;
		assert.strictEqual(backendCalls('moved-shaped:').length, 1, 'the backend ran the call once');
		assert.strictEqual(reply.ok, false);
		assert.strictEqual(reply.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(
			reply.error.message,
			'backend ran, then threw moved-shaped:a',
			"the caller gets the backend's error"
		);
	});

	it("follows a move the owner's admission path sends at most four times, then fails the call by name", async function () {
		const [owner, bystander, caller] = await startWorkers(3);
		await registerInOrder([owner, bystander, caller], 'bounded-moves');
		// A worker shutting down stays a caller and owns nothing: it refuses every request as moved.
		bystander.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });
		await waitFor(() => events.some((event) => event.event === 'drained' && event.threadId === bystander.threadId));
		// This thread is main, so its pushes are main's: each names the bystander as owner, each newer than the last.
		const push = (version) =>
			manageThreads.sendToThread(caller.threadId, {
				type: STATE,
				key: keyOf('bounded-moves'),
				version,
				epoch: version,
				state: 'ready',
				owner: bystander.threadId,
				restarts: 0,
				maxRestarts: 1,
				generation: 1,
			});
		push(1e6);
		await waitForStatus(caller, 'bounded-moves', (status) => status?.owner === bystander.threadId, 'push not seen');
		const call = command(caller, { command: 'embed', id: 'bounded-moves', texts: ['bounded-moves:a'] });
		for (let move = 1; move <= 4; move++) {
			// Each move leaves the call waiting for a state newer than the one it was routed with.
			await waitFor(
				async () => (await command(caller, { command: 'callers', id: 'bounded-moves' })).load.waiting === 1
			);
			push(1e6 + move);
		}

		const reply = await call;
		assert.strictEqual(reply.ok, false);
		assert.strictEqual(reply.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(reply.error.reason, 'moved');
		assert.strictEqual(
			events.filter((event) => event.event === 'refused' && event.threadId === caller.threadId).length,
			5,
			'one send and four re-sends, each refused unstarted'
		);
		assert.strictEqual(backendCalls('bounded-moves:').length, 0);
	});

	it("holds the election while a released instance's dispose() keeps failing, and fails the key until the next generation", async function () {
		const generation = manageThreads.restartNumber;
		const [owner, successor] = await startWorkers(2);
		const ownerId = owner.threadId;
		await registerInOrder([owner, successor], 'dispose-fails', undefined, { dispose: 'reject' });
		await waitForStatus(successor, 'dispose-fails', (status) => status?.state === 'ready', 'dispose-fails: not ready');
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: generation });

		const failed = await waitForStatus(
			successor,
			'dispose-fails',
			(status) => status?.state === 'failed',
			'dispose-fails: a failed disposal never failed the key'
		);
		assert.strictEqual(failed.reason, 'dispose-failed');
		assert.strictEqual(failed.draining, ownerId, 'the thread that may still hold the instance is named');
		assert.strictEqual(failed.owner, undefined);
		assert.match(failed.error.message, /could not free the model of dispose-fails/);
		assert.strictEqual(
			events.filter((event) => event.event === 'dispose' && event.id === 'dispose-fails').length,
			3,
			'dispose() was tried three times'
		);
		const refused = await command(successor, { command: 'embed', id: 'dispose-fails', texts: ['dispose-fails:a'] });
		assert.strictEqual(refused.error.reason, 'failed');

		// A new generation clears the failure, but nothing is elected while the old instance's thread lives.
		const newer = await startWorkerInGeneration(generation + 1);
		await command(newer, { command: 'register', id: 'dispose-fails' });
		await waitForStatus(
			newer,
			'dispose-fails',
			(status) => status?.generation === generation + 1 && status.draining === ownerId,
			'dispose-fails: the newer claim never reached main'
		);
		// Asserting a non-event: give an election time to (not) happen.
		await delay(200);
		assert.deepStrictEqual(
			factoryRuns('dispose-fails').map((event) => event.threadId),
			[ownerId]
		);
		// The thread's exit is what proves the instance gone.
		owner.wasShutdown = true;
		await owner.terminate();
		const elected = await waitForStatus(
			newer,
			'dispose-fails',
			(status) => status?.state === 'ready',
			'dispose-fails: no owner after the thread exited'
		);
		assert.strictEqual(elected.owner, newer.threadId);
		assert.deepStrictEqual(
			factoryRuns('dispose-fails').map((event) => event.threadId),
			[ownerId, newer.threadId]
		);
	});

	it('tries a rejecting dispose() again and hands over once it succeeds', async function () {
		const [owner, successor] = await startWorkers(2);
		const [ownerId, successorId] = [owner.threadId, successor.threadId];
		await registerInOrder([owner, successor], 'dispose-retry', undefined, { dispose: 'reject-once' });
		await waitForStatus(successor, 'dispose-retry', (status) => status?.state === 'ready', 'dispose-retry: not ready');
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });

		const handedOver = await waitForStatus(
			successor,
			'dispose-retry',
			(status) => status?.state === 'ready' && status.owner === successorId,
			'dispose-retry: the successor never became the ready owner'
		);
		assert.strictEqual(handedOver.restarts, 0);
		assert.deepStrictEqual(
			events
				.filter((event) => (event.event === 'factory' || event.event === 'dispose') && event.id === 'dispose-retry')
				.map((event) => `${event.event}@${event.threadId}`),
			[`factory@${ownerId}`, `dispose@${ownerId}`, `dispose@${ownerId}`, `factory@${successorId}`]
		);
	});

	it("never aborts the factory's signal once its backend is ready, so a handover lets a running call finish", async function () {
		const [owner, successor] = await startWorkers(2);
		const ownerId = owner.threadId;
		await registerInOrder([owner, successor], 'factory-signal', undefined, { watchFactorySignal: true });
		await waitForStatus(
			successor,
			'factory-signal',
			(status) => status?.state === 'ready',
			'factory-signal: not ready'
		);
		// The backend keeps the factory's signal and stops a call when it aborts.
		const running = command(successor, { command: 'embed', id: 'factory-signal', texts: ['gate:factory-signal'] });
		await waitingOn('gate:factory-signal');
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });
		// The owner has released the backend once its run drains (or, had the signal aborted, the call has stopped).
		await waitFor(
			async () =>
				events.some((event) => event.event === 'factory-signal-aborted') ||
				(await ownerLoad(owner, 'factory-signal'))?.phase === 'draining'
		);
		assert.ok(
			!events.some((event) => event.event === 'factory-signal-aborted'),
			"the handover aborted the factory's signal, which stopped the running call"
		);

		await command(owner, { command: 'release', text: 'gate:factory-signal' });
		assertServedBy(await running, ['gate:factory-signal'], ownerId);
		assert.ok(!events.some((event) => event.event === 'factory-signal-aborted'));
		await waitForStatus(
			successor,
			'factory-signal',
			(status) => status?.state === 'ready' && status.owner === successor.threadId,
			'factory-signal: no successor'
		);
	});

	it('refuses at once, and never holds, a request that names a newer state from a thread main never admitted', async function () {
		const [owner, caller] = await startWorkers(2);
		const isolated = await startFixtureWorker(workers, { application: 'isolated-app' });
		await registerInOrder([owner, caller], 'admission');
		const seen = await ownerLoad(owner, 'admission');
		await command(isolated, {
			command: 'send',
			target: owner.threadId,
			message: rawRequest('admission', isolated.threadId, 1e6 + 5, {
				version: seen.version + 1,
				epoch: seen.epoch,
				args: [['admission:intruder']],
			}),
		});

		const answer = await rawResponse(1e6 + 5);
		assert.strictEqual(answer.from, owner.threadId);
		assert.strictEqual(answer.message.ok, false);
		assert.strictEqual(answer.message.refused, 'unconfirmed');
		assert.strictEqual((await ownerLoad(owner, 'admission')).parked, 0, 'the request was never held');
		assert.strictEqual(backendCalls('admission:intruder').length, 0);
	});

	it('sends a call again shortly when the owner it reached has not yet seen the state that admitted its caller', async function () {
		const [owner, bystander, caller] = await startWorkers(3);
		await registerInOrder([owner, bystander, caller], 'unconfirmed');
		// This thread is main: a push naming the bystander as owner reaches the caller before the bystander.
		const push = (target, extra) =>
			manageThreads.sendToThread(target.threadId, {
				type: STATE,
				key: keyOf('unconfirmed'),
				version: 1e6,
				epoch: 1e6,
				state: 'ready',
				owner: bystander.threadId,
				restarts: 0,
				maxRestarts: 1,
				generation: 1,
				...extra,
			});
		push(caller);
		await waitForStatus(caller, 'unconfirmed', (status) => status?.owner === bystander.threadId, 'push not seen');
		const call = command(caller, { command: 'embed', id: 'unconfirmed', texts: ['unconfirmed:a'] });
		const refusal = await waitFor(
			() =>
				events.find(
					(event) => event.event === 'refused' && event.threadId === caller.threadId && event.refused === 'unconfirmed'
				),
			10000
		);
		assert.strictEqual(refusal.from, bystander.threadId);
		// The same push reaches the bystander, with the callers main admitted: the caller's next try is served.
		push(bystander, { callers: [owner.threadId, bystander.threadId, caller.threadId] });
		assertServedBy(await call, ['unconfirmed:a'], bystander.threadId);
	});

	it("bills a split embed's completed parts on its failed attempt's row only, when a later part fails and a fallback serves", async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'partial', { maxBatchInputs: 2 }, { failOn: 'partial:3' });
		await command(caller, { command: 'fallback', id: 'partial', fallbackId: 'partial-fallback' });
		const texts = ['partial:0', 'partial:1', 'partial:2', 'partial:3'];
		assertServedBy(await command(caller, { command: 'embed', id: 'partial', texts }), texts, caller.threadId);

		assert.deepStrictEqual(
			backendCalls('partial:')
				.filter((event) => event.id === 'partial')
				.map((event) => event.texts.length),
			[2, 2],
			'the second part failed after the first completed'
		);
		const rows = events
			.filter(
				(event) => event.event === 'row' && event.threadId === caller.threadId && event.record.model === 'partial'
			)
			.map((event) => [event.record.backend, event.record.success, event.record.embedding_tokens]);
		assert.deepStrictEqual(rows, [
			['test:partial', false, 6],
			['test:partial-fallback', true, 12],
		]);
		const tokens = events
			.filter(
				(event) =>
					event.event === 'metric' && event.threadId === caller.threadId && event.metric === 'model-embed-tokens'
			)
			.map((event) => [event.path, event.value]);
		assert.deepStrictEqual(tokens, [
			['test:partial', 6],
			['test:partial-fallback', 12],
		]);
	});

	it("takes a claimant's generation from the worker main started, never from its claim", async function () {
		const [owner, claimant] = await startWorkers(2);
		const options = { maxRestarts: 0 };
		await command(owner, { command: 'register', id: 'claimed-generation', failStart: true, options });
		await waitFor(() => factoryRuns('claimed-generation').length === 1);
		await command(claimant, { command: 'register', id: 'claimed-generation', options });
		await command(owner, { command: 'release', text: 'start:claimed-generation' });
		const failed = await waitForStatus(
			claimant,
			'claimed-generation',
			(status) => status?.state === 'failed',
			'claimed-generation: never failed'
		);

		// A claim naming a later generation than its worker was started in, as a deploy's replacement would.
		await command(claimant, {
			command: 'send',
			target: 0,
			message: {
				type: CLAIM,
				key: keyOf('claimed-generation'),
				origin: claimant.threadId,
				generation: failed.generation + 1,
				eligible: true,
				options: { concurrency: 1, maxPending: 256, maxRestarts: 1, ownerWaitMs: 30000 },
			},
		});
		// Asserting a non-event: give main time to (not) clear the failure and elect.
		await delay(200);
		const kept = await statusOf(claimant, 'claimed-generation');
		assert.strictEqual(kept.state, 'failed');
		assert.strictEqual(kept.generation, failed.generation);
		assert.strictEqual(factoryRuns('claimed-generation').length, 1);
	});

	it('refuses as moved, and never holds, a request routed with an older election, whatever state version it names', async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'old-epoch');
		// A call the owner serves shows that its last state admits the caller.
		assertServedBy(
			await command(caller, { command: 'embed', id: 'old-epoch', texts: ['old-epoch:admitted'] }),
			['old-epoch:admitted'],
			owner.threadId
		);
		const seen = await ownerLoad(owner, 'old-epoch');
		assert.ok(seen.epoch >= 1, `an election precedes the owner's view (epoch ${seen.epoch})`);
		await command(caller, {
			command: 'send',
			target: owner.threadId,
			message: rawRequest('old-epoch', caller.threadId, 1e6 + 6, {
				version: seen.version + 1,
				epoch: seen.epoch - 1,
				args: [['old-epoch:stale']],
			}),
		});

		// Either the owner answers, or (the defect) it holds the request for a state that cannot serve it.
		const outcome = await waitFor(
			async () =>
				events.find((event) => event.event === 'raw-response' && event.message.request === 1e6 + 6) ??
				((await ownerLoad(owner, 'old-epoch'))?.parked > 0 && 'held'),
			10000
		);
		assert.notStrictEqual(outcome, 'held', 'a request from an older election was held');
		assert.strictEqual(outcome.from, owner.threadId);
		assert.strictEqual(outcome.message.ok, false);
		assert.strictEqual(outcome.message.refused, 'moved');
		assert.strictEqual((await ownerLoad(owner, 'old-epoch')).parked, 0, 'the hold is empty');
		assert.strictEqual(backendCalls('old-epoch:stale').length, 0);
	});

	it("applies the same clone and batching rules to the owner's own calls as to another worker's", async function () {
		const [owner, caller] = await startWorkers(2);
		await registerInOrder([owner, caller], 'same-rules', { maxBatchInputs: 8 });
		const gate = occupy(owner, 'same-rules');
		await waitingOn('gate:same-rules');
		// Two calls from each thread, all four holding one Date by reference in their options.
		const sent = [];
		for (const [worker, tag] of [
			[owner, 'own'],
			[caller, 'other'],
		])
			for (const index of [1, 2]) {
				const texts = [`same-rules:${tag}:${index}`];
				sent.push({ texts, reply: command(worker, { command: 'embed', id: 'same-rules', texts, shareDate: true }) });
			}
		await waitFor(async () => (await ownerLoad(owner, 'same-rules'))?.queued === 4, 10000);
		await command(owner, { command: 'release', text: 'gate:same-rules' });
		await gate;
		for (const { texts, reply } of sent) assertServedBy(await reply, texts, owner.threadId);
		assert.deepStrictEqual(
			backendCalls('same-rules:').map((event) => event.texts.length),
			[1, 1, 1, 1],
			'a Date never matches, so no two of the calls were merged, whichever thread made them'
		);

		// An option holding a function cannot cross threads: the owner's own call fails as another worker's does.
		const [own, other] = await Promise.all(
			[
				[owner, 'same-rules:nested-own'],
				[caller, 'same-rules:nested-other'],
			].map(([worker, text]) =>
				command(worker, { command: 'embed', id: 'same-rules', texts: [text], nestedFunction: true })
			)
		);
		for (const reply of [own, other]) {
			assert.strictEqual(reply.ok, false, 'the call was refused');
			assert.match(reply.error.message, /option 'hooks' cannot cross threads/);
		}
		assert.deepStrictEqual(
			{ name: own.error.name, message: own.error.message },
			{ name: other.error.name, message: other.error.message }
		);
		assert.strictEqual(backendCalls('same-rules:nested').length, 0, 'neither call reached the backend');
	});

	it('disposes what a factory returned before reading any of its properties, so a getter that throws frees it before a successor starts', async function () {
		const id = 'getter-throws';
		const [failing, successor] = await startWorkers(2);
		await command(failing, {
			command: 'register',
			id,
			holdStart: true,
			capabilities: 'getter-throws',
			dispose: 'hold',
		});
		await waitFor(() => factoryRuns(id).length === 1);
		await command(successor, { command: 'register', id });
		await waitForStatus(successor, id, (status) => status?.owner === failing.threadId, `${id}: owner not seen`);
		await command(failing, { command: 'release', text: `start:${id}` });

		// Either the returned object is disposed, or (the defect) a successor runs its factory while it may be live.
		await waitFor(() =>
			events.some(
				(event) =>
					event.id === id &&
					(event.event === 'dispose' || (event.event === 'factory' && event.threadId === successor.threadId))
			)
		);
		assert.ok(
			events.some((event) => event.event === 'dispose' && event.id === id && event.threadId === failing.threadId),
			'the object the factory returned was disposed'
		);
		// Asserting a non-event: give an election time to (not) happen while dispose() is held.
		await delay(200);
		assert.deepStrictEqual(
			factoryRuns(id).map((event) => event.threadId),
			[failing.threadId],
			'no successor runs its factory while the failed start is still disposing'
		);
		await command(failing, { command: 'release', text: `dispose:${id}` });

		const restarted = await waitForStatus(
			successor,
			id,
			(status) => status?.state === 'ready' && status.owner === successor.threadId,
			`${id}: no successor became ready`
		);
		assert.strictEqual(restarted.restarts, 1, 'the failed start used the restart budget');
		assert.deepStrictEqual(
			events
				.filter((event) => (event.event === 'factory' || event.event === 'dispose') && event.id === id)
				.map((event) => `${event.event}@${event.threadId}`),
			[`factory@${failing.threadId}`, `dispose@${failing.threadId}`, `factory@${successor.threadId}`]
		);
	});

	it('counts a dispose property that throws when read as a rejected dispose(): tried three times, then the key fails and nothing is elected while its thread lives', async function () {
		const id = 'dispose-getter';
		const [owner, successor] = await startWorkers(2);
		await registerInOrder([owner, successor], id, undefined, { dispose: 'getter-throws' });
		await waitForStatus(successor, id, (status) => status?.state === 'ready', `${id}: not ready`);
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });

		const failed = await waitForStatus(
			successor,
			id,
			(status) => status?.state === 'failed',
			`${id}: an unreadable dispose never failed the key`
		);
		assert.strictEqual(failed.reason, 'dispose-failed');
		assert.strictEqual(failed.draining, owner.threadId, 'the thread that may still hold the instance is named');
		assert.match(failed.error.message, /the dispose property of dispose-getter is not readable/);
		assert.strictEqual(
			events.filter((event) => event.event === 'dispose-read' && event.id === id).length,
			3,
			'dispose was read on each of three tries'
		);
		assert.deepStrictEqual(
			factoryRuns(id).map((event) => event.threadId),
			[owner.threadId]
		);
	});

	it("aborts a factory's signal when its owner is released while it still runs, and disposes what it returns before a successor starts", async function () {
		const id = 'pending-factory';
		const [owner, successor] = await startWorkers(2);
		await command(owner, { command: 'register', id, holdStart: true });
		await waitFor(() => factoryRuns(id).length === 1);
		await command(successor, { command: 'register', id });
		await waitForStatus(successor, id, (status) => status?.owner === owner.threadId, `${id}: owner not seen`);
		owner.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: manageThreads.restartNumber });

		const aborted = await waitFor(() => events.find((event) => event.event === 'factory-aborted' && event.id === id));
		assert.strictEqual(aborted.threadId, owner.threadId);
		assert.deepStrictEqual([aborted.name, aborted.reason], ['ModelBackendUnavailableError', 'moved']);
		const draining = await waitForStatus(
			successor,
			id,
			(status) => status?.draining === owner.threadId,
			`${id}: the released owner was never reported draining`
		);
		assert.strictEqual(draining.owner, undefined);
		// The factory runs on after its signal aborts; what it returns is disposed before anything is elected.
		await command(owner, { command: 'release', text: `start:${id}` });
		const handedOver = await waitForStatus(
			successor,
			id,
			(status) => status?.state === 'ready' && status.owner === successor.threadId,
			`${id}: the successor never became the ready owner`
		);
		assert.strictEqual(handedOver.restarts, 0, 'a planned exit is not a failure');
		assert.deepStrictEqual(
			events
				.filter((event) => (event.event === 'factory' || event.event === 'dispose') && event.id === id)
				.map((event) => `${event.event}@${event.threadId}`),
			[`factory@${owner.threadId}`, `dispose@${owner.threadId}`, `factory@${successor.threadId}`]
		);
	});

	it('fails a call by name once its wait for an owner to confirm its caller runs out', async function () {
		const [owner, bystander, caller] = await startWorkers(3);
		await registerInOrder([owner, bystander, caller], 'never-confirmed', { ownerWaitMs: 300 });
		// This thread is main: a push naming the bystander as owner reaches the caller, and never the bystander.
		manageThreads.sendToThread(caller.threadId, {
			type: STATE,
			key: keyOf('never-confirmed'),
			version: 1e6,
			epoch: 1e6,
			state: 'ready',
			owner: bystander.threadId,
			restarts: 0,
			maxRestarts: 1,
			generation: 1,
		});
		await waitForStatus(caller, 'never-confirmed', (status) => status?.owner === bystander.threadId, 'push not seen');
		const started = Date.now();
		const reply = await command(caller, { command: 'embed', id: 'never-confirmed', texts: ['never-confirmed:a'] });

		assert.strictEqual(reply.ok, false);
		assert.strictEqual(reply.error.name, 'ModelBackendUnavailableError');
		assert.strictEqual(reply.error.reason, 'not-owner');
		assert.ok(Date.now() - started >= 300, 'the call waited out ownerWaitMs');
		const refusals = events.filter(
			(event) =>
				event.event === 'refused' &&
				event.threadId === caller.threadId &&
				event.from === bystander.threadId &&
				event.refused === 'unconfirmed'
		);
		assert.ok(refusals.length >= 2, `the call was sent again before it failed (${refusals.length} refusals)`);
		assert.strictEqual(backendCalls('never-confirmed:').length, 0);
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
			assert.strictEqual(error.cause, undefined);
			return true;
		});
		const status = await waitFor(() => {
			const current = models.backendStatus('embedding', 'main-empty');
			return current.state === 'failed' && current;
		});
		assert.strictEqual(status.reason, 'start-failed');
		assert.strictEqual(status.error.name, 'ModelBackendRegistrationError');
	});

	it('refuses an option that is a function instead of dropping it, since it cannot reach the owner', async function () {
		setMainIsWorker(true);
		let calls = 0;
		registerProcessBackend('embedding', 'main-options', () =>
			models.defineBackend({
				name: 'test:options',
				embed: async (input) => {
					calls++;
					return { status: 'completed', output: [].concat(input).map(() => Float32Array.of(1)) };
				},
			})
		);
		await assert.rejects(models.embed('a', { model: 'main-options', onProgress: () => {} }), (error) => {
			assert.match(error.message, /option 'onProgress' is a function/);
			return true;
		});
		assert.strictEqual(calls, 0);
		assert.strictEqual((await models.embed('a', { model: 'main-options' })).length, 1);
	});

	it('refuses an option holding a function at any depth, or any other value structured clone refuses, as a call from another thread would be', async function () {
		setMainIsWorker(true);
		let calls = 0;
		registerProcessBackend('embedding', 'main-nested', () =>
			models.defineBackend({
				name: 'test:nested',
				embed: async (input) => {
					calls++;
					return { status: 'completed', output: [].concat(input).map(() => Float32Array.of(1)) };
				},
			})
		);
		for (const [field, value] of [
			['hooks', { onProgress: () => {} }],
			['steps', [{ run() {} }]],
			['handle', { cache: new WeakMap() }],
			['tag', Symbol('tag')],
		])
			await assert.rejects(models.embed('a', { model: 'main-nested', [field]: value }), (error) => {
				assert.match(error.message, new RegExp(`option '${field}' cannot cross threads`));
				return true;
			});
		assert.strictEqual(calls, 0, 'no refused call reached the backend');
		assert.strictEqual((await models.embed('a', { model: 'main-nested', plain: { nested: [1, 'two'] } })).length, 1);
		assert.strictEqual(calls, 1);
	});

	it('merges queued calls by value only: a Date two calls share by reference never matches, as across threads', async function () {
		setMainIsWorker(true);
		const ran = [];
		let releaseGate;
		const gate = new Promise((resolve) => (releaseGate = resolve));
		registerProcessBackend(
			'embedding',
			'main-batched',
			() =>
				models.defineBackend({
					name: 'test:batched',
					embed: async (input) => {
						const texts = [].concat(input);
						ran.push(texts);
						if (texts.includes('gate')) await gate;
						return { status: 'completed', output: texts.map(() => Float32Array.of(1)) };
					},
				}),
			{ maxBatchInputs: 8 }
		);
		const held = models.embed('gate', { model: 'main-batched' });
		await waitFor(() => ran.length === 1);
		const when = new Date(0);
		const tier = { name: 'shared' };
		const queued = [
			models.embed('date-1', { model: 'main-batched', when }),
			models.embed('date-2', { model: 'main-batched', when }),
			models.embed('plain-1', { model: 'main-batched', tier }),
			models.embed('plain-2', { model: 'main-batched', tier }),
		];
		await waitFor(() => localOwnerLoad('embedding', 'main-batched')?.queued === 4);
		releaseGate();
		await held;
		for (const vectors of await Promise.all(queued)) assert.strictEqual(vectors.length, 1);

		assert.deepStrictEqual(
			ran,
			[['gate'], ['date-1'], ['date-2'], ['plain-1', 'plain-2']],
			'the calls sharing a Date ran apart; the calls sharing an equal plain object were merged'
		);
	});

	it('answers a call this thread makes to itself with a copy, as across threads, so a backend that reuses its output buffer cannot change a vector it returned', async function () {
		setMainIsWorker(true);
		const buffer = Float32Array.of(1, 2);
		registerProcessBackend('embedding', 'main-copy', () =>
			models.defineBackend({
				name: 'test:copy',
				embed: async (input) => ({ status: 'completed', output: [].concat(input).map(() => buffer) }),
			})
		);
		const [vector] = await models.embed('a', { model: 'main-copy' });
		assert.deepStrictEqual([...vector], [1, 2]);
		// The backend overwrites its buffer for its next call, as a native embedder reusing an output buffer does.
		buffer.fill(0);
		assert.deepStrictEqual([...vector], [1, 2], "the caller holds a copy, never the backend's buffer");
	});

	it("returns a split embed's partial usage once per error, to the facade's row for that attempt", async function () {
		setMainIsWorker(true);
		registerProcessBackend(
			'embedding',
			'main-partial',
			() =>
				models.defineBackend({
					name: 'test:partial',
					embed: async (input) => {
						const texts = [].concat(input);
						if (texts.includes('fail')) throw Object.assign(new Error('provider refused'), { name: 'ProviderError' });
						return {
							status: 'completed',
							output: texts.map(() => Float32Array.of(1)),
							usage: { embeddingTokens: texts.length * 3 },
						};
					},
				}),
			{ maxBatchInputs: 2 }
		);
		const proxy = getBackend('embedding', 'main-partial');
		const failure = await proxy.embed(['a', 'b', 'fail'], {}).then(
			() => assert.fail('the last part fails'),
			(error) => error
		);
		assert.strictEqual(failure.name, 'ProviderError');
		assert.deepStrictEqual(takePartialUsage(failure), { embeddingTokens: 6 }, 'the first part completed');
		assert.strictEqual(takePartialUsage(failure), undefined, 'a second read bills nothing');
		assert.deepStrictEqual(failure.usage, { embeddingTokens: 6 }, 'the error still reports its usage');
		// A call that failed whole, and any other value, has no partial usage to take.
		const whole = await proxy.embed(['fail'], {}).then(
			() => assert.fail('the only part fails'),
			(error) => error
		);
		assert.strictEqual(takePartialUsage(whole), undefined);
		assert.strictEqual(takePartialUsage(new Error('unrelated')), undefined);
		assert.strictEqual(takePartialUsage(undefined), undefined);
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
		assert.throws(
			() => registerProcessBackend('embedding', 'bad', () => undefined, { ownerWaitMs: 0 }),
			ModelBackendRegistrationError
		);
		assert.strictEqual(models.backendStatus('embedding', 'bad'), undefined, 'a refused registration installs nothing');
	});
});

describe('apportionUsage', function () {
	/** Every order the shares could be added in, for a few shares. */
	function permutations(list) {
		if (list.length <= 1) return [list];
		return list.flatMap((item, index) =>
			permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])
		);
	}

	it('splits whole token counts by largest remainder', function () {
		const shares = apportionUsage({ embeddingTokens: 10, latencyMs: 40 }, [1, 1, 1]);
		assert.deepStrictEqual(
			shares.map((share) => share.embeddingTokens),
			[4, 3, 3]
		);
		assert.ok(
			shares.every((share) => share.latencyMs === 40),
			'latency is the merged call’s for every member'
		);
		assert.deepStrictEqual(apportionUsage(undefined, [2, 1]), [undefined, undefined]);
	});

	it('makes the shares sum exactly to the reported value, in any order, when the value is fractional', function () {
		for (const [value, counts] of [
			[10.5, [1, 1, 1]],
			[7.3, [3, 1, 2]],
			[0.1, [1, 1]],
			[1234567.890123, [5, 7, 11, 13]],
		]) {
			const shares = apportionUsage({ promptTokens: value, gpuMs: value }, counts);
			for (const field of ['promptTokens', 'gpuMs'])
				for (const order of permutations(shares.map((share) => share[field])))
					assert.strictEqual(
						order.reduce((sum, part) => sum + part, 0),
						value,
						`${field} ${value} over ${counts}`
					);
		}
	});

	it('attributes a negative count whole to the first member rather than splitting it', function () {
		assert.deepStrictEqual(
			apportionUsage({ completionTokens: -2 }, [1, 1]).map((share) => share.completionTokens),
			[-2, 0]
		);
	});
});

describe('sameValue, which decides whether queued embed requests may merge', function () {
	it('compares primitives, arrays and plain objects by value', function () {
		assert.ok(sameValue(NaN, NaN));
		assert.ok(!sameValue(0, -0), 'Object.is tells -0 from 0');
		assert.ok(!sameValue(null, undefined));
		assert.ok(sameValue({ a: [1, { b: 'c' }] }, { a: [1, { b: 'c' }] }));
		assert.ok(!sameValue({ a: 1 }, { a: 1, b: undefined }));
		assert.ok(!sameValue([1, 2], { 0: 1, 1: 2, length: 2 }));
		const shared = { tier: ['x'] };
		assert.ok(sameValue({ shared }, { shared }), 'a plain object shared by reference is equal by value');
	});

	it('never matches any other object, even the same one, as two structured clones of it never would', function () {
		for (const exotic of [new Date(0), new Map(), Float32Array.of(1), new (class Options {})(), () => {}]) {
			assert.ok(!sameValue(exotic, exotic), `${Object.prototype.toString.call(exotic)} matched itself`);
			assert.ok(!sameValue({ value: exotic }, { value: exotic }), `${Object.prototype.toString.call(exotic)} nested`);
		}
		const cyclic = {};
		cyclic.self = cyclic;
		assert.ok(!sameValue(cyclic, cyclic), 'a cycle is never followed to a match');
	});
});
