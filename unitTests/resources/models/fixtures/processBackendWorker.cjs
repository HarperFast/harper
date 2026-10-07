'use strict';

// Worker for processBackend.test.js, started through manageThreads' startWorker so it joins the same
// port mesh production workers use. It registers backends (process-wide or per thread) and calls them
// through the models facade on command, reporting every factory run, backend call, disposal, analytics
// row, metric and refusal to the test, tagged with the thread it ran on. Its backends can hold or reject
// their dispose(), fail on a chosen input, and keep their factory's signal. On SHUTDOWN it runs Harper's
// shutdown drains the way threadServer does, so the test sees what a real worker would wait for before
// exiting.
const { parentPort, threadId } = require('node:worker_threads');
const { getEventListeners } = require('node:events');
// Prime Harper's module graph in the order the other models tests do (see Models.test.js).
require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { onMessageByType } = manageThreads;
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { runShutdownDrains, shutdownDrainsHaveWork } = require('#src/components/shutdownDrain');
const { contextStorage } = require('#src/resources/transaction');
const { setFallbackGroup } = require('#src/resources/models/routing');
const { allowedValues } = require('#src/resources/models/decision');
const { Models } = require('#src/resources/models/Models');
const processBackend = require('#src/resources/models/processBackend');

const report = (event) => parentPort.postMessage({ type: 'process-backend-test-event', threadId, ...event });
const reply = (rid, body) => parentPort.postMessage({ type: 'process-backend-test-reply', rid, threadId, ...body });
// The facade writes its call rows and metrics here, so the test can total what callers billed.
const models = new Models(
	{
		write(record) {
			report({ event: 'row', record });
			return 0;
		},
	},
	(value, metric, path) => report({ event: 'metric', value, metric, path }),
	{}
);
const gates = new Map();
const controllers = new Map();

/** A float32-exact fingerprint of `text`, so the test can tell which request a vector answers. */
function fingerprint(text) {
	let hash = 7;
	for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 16777216;
	return hash;
}

/**
 * Held until the test releases `text`, or until the call's signal aborts. A backend that keeps its
 * factory's signal (`factorySignal`) stops the call when that signal aborts, too.
 */
function hold(text, signal, factorySignal) {
	return new Promise((resolve, reject) => {
		report({ event: 'waiting', text });
		gates.set(text, resolve);
		signal?.addEventListener(
			'abort',
			() => {
				gates.delete(text);
				report({ event: 'aborted', text });
				reject(signal.reason);
			},
			{ once: true }
		);
		factorySignal?.addEventListener(
			'abort',
			() => {
				gates.delete(text);
				report({ event: 'factory-signal-aborted', text });
				reject(factorySignal.reason);
			},
			{ once: true }
		);
	});
}

function embeddingBackend(id, spec = {}) {
	let disposals = 0;
	return {
		name: `test:${id}`,
		capabilities() {
			if (spec.capabilities === 'throw') throw new Error('capabilities are not readable yet');
			const capabilities = { embed: true, generate: false, stream: false, tools: false, adapters: false };
			if (spec.capabilities === 'uncloneable') capabilities.describe = () => 'a function cannot cross threads';
			return capabilities;
		},
		async embed(input, opts) {
			const texts = Array.isArray(input) ? input : [input];
			const { signal, accounting, ...rest } = opts;
			report({ event: 'embed', id, texts, opts: rest, accounting });
			for (const text of texts) {
				// Held texts keep this call running, so later requests queue behind it.
				if (text.startsWith('gate:') || text.startsWith('until-aborted:')) await hold(text, signal, spec.factorySignal);
				// An error carrying the name and reason the handover protocol uses, thrown after the call ran.
				if (text.startsWith('moved-shaped:'))
					throw Object.assign(new Error(`backend ran, then threw ${text}`), {
						name: 'ModelBackendUnavailableError',
						reason: 'moved',
						statusCode: 503,
					});
				if (text === spec.failOn)
					throw Object.assign(new Error(`provider refused ${text}`), { name: 'ProviderError', statusCode: 503 });
				if (text.startsWith('error:')) {
					const [, status, code] = text.split(':');
					throw Object.assign(new Error(`provider refused ${text}`), {
						name: 'ProviderError',
						statusCode: Number(status),
						code,
					});
				}
			}
			return {
				status: 'completed',
				output: texts.map((text) => Float32Array.from([fingerprint(text), threadId])),
				usage: spec.usage ?? { embeddingTokens: texts.length * 3 },
			};
		},
		// 'hold' waits until the test releases `dispose:<id>`; 'reject' rejects every time, 'reject-once' the first time.
		async dispose() {
			disposals++;
			report({ event: 'dispose', id });
			if (spec.dispose === 'hold') await new Promise((resolve) => gates.set(`dispose:${id}`, resolve));
			if (spec.dispose === 'reject' || (spec.dispose === 'reject-once' && disposals === 1))
				throw new Error(`could not free the model of ${id}`);
		},
	};
}

function generativeBackend(id) {
	return models.defineBackend({
		name: `test:${id}`,
		generate: async (input) => ({
			status: 'completed',
			output: { content: `${threadId}:${input}`, finishReason: 'stop' },
			usage: { promptTokens: 2, completionTokens: 1 },
		}),
		scoreChoices: async (_input, choices) => ({
			status: 'completed',
			output: { logLikelihoods: choices.map((_choice, index) => -index - threadId / 1000) },
		}),
	});
}

function decisionBackend(id) {
	return models.defineBackend({
		name: `test:${id}`,
		decide: async (_state, schema) => ({
			status: 'completed',
			output: {
				distribution: allowedValues(schema).map((value, index) => ({ value, probability: index === 0 ? 1 : 0 })),
			},
		}),
	});
}

const errorReply = (error) => ({
	ok: false,
	error: {
		name: error?.name,
		reason: error?.reason,
		message: error?.message,
		statusCode: error?.statusCode,
		code: error?.code,
		cause: error?.cause && { name: error.cause.name, message: error.cause.message },
	},
});

const commands = {
	register({
		id,
		kind = 'embedding',
		scope,
		options,
		failStart,
		holdStart,
		capabilities,
		usage,
		failOn,
		dispose,
		watchFactorySignal,
	}) {
		const build = (factorySignal) =>
			kind === 'generative'
				? generativeBackend(id)
				: kind === 'decision'
					? decisionBackend(id)
					: embeddingBackend(id, {
							capabilities,
							usage,
							failOn,
							dispose,
							factorySignal: watchFactorySignal ? factorySignal : undefined,
						});
		if (scope === 'thread') {
			report({ event: 'factory', id });
			models.registerBackend(kind, id, build());
			return {};
		}
		models.registerProcessBackend(
			kind,
			id,
			async ({ signal } = {}) => {
				report({ event: 'factory', id });
				// Held until the test releases it, so the test can line up claimants and calls first.
				if (failStart || holdStart) await new Promise((resolve) => gates.set(`start:${id}`, resolve));
				report({ event: 'factory-settled', id, aborted: signal?.aborted === true });
				if (failStart) throw new Error('model file is missing');
				return build(signal);
			},
			options
		);
		return {};
	},
	fallback({ id, fallbackId }) {
		models.registerBackend('embedding', fallbackId, embeddingBackend(fallbackId));
		setFallbackGroup('embedding', id, [fallbackId]);
		return {};
	},
	async embed({ rid, id, texts, opts, tenant }) {
		const controller = new AbortController();
		controllers.set(rid, controller);
		const call = () => models.embed(texts, { ...opts, model: id, signal: controller.signal });
		try {
			const vectors = await (tenant === undefined ? call() : contextStorage.run({ user: { tenant } }, call));
			return {
				ok: true,
				vectors: vectors.map((vector) => [...vector]),
				listeners: getEventListeners(controller.signal, 'abort').length,
			};
		} catch (error) {
			return { ...errorReply(error), listeners: getEventListeners(controller.signal, 'abort').length };
		} finally {
			controllers.delete(rid);
		}
	},
	async generate({ id, input }) {
		try {
			return { ok: true, result: await models.generate(input, { model: id }) };
		} catch (error) {
			return errorReply(error);
		}
	},
	async scoreChoices({ id, input, choices }) {
		try {
			return { ok: true, result: await models.scoreChoices(input, choices, { model: id }) };
		} catch (error) {
			return errorReply(error);
		}
	},
	async decide({ id, state, schema }) {
		try {
			const decision = await models.decide(state, schema, { model: id });
			return { ok: true, value: decision.value };
		} catch (error) {
			return errorReply(error);
		}
	},
	abort({ target }) {
		controllers.get(target)?.abort();
		return {};
	},
	release({ text }) {
		gates.get(text)?.();
		return { released: gates.delete(text) };
	},
	status({ id, kind = 'embedding' }) {
		return { status: models.backendStatus(kind, id) };
	},
	load({ id }) {
		return { load: processBackend.ownerLoad('embedding', id) };
	},
	callers({ id }) {
		return { load: processBackend.callerLoad('embedding', id) };
	},
	// Hand-built protocol messages, as any code holding the `threads` global could send them.
	send({ target, message }) {
		return { sent: manageThreads.sendToThread(target, message) };
	},
};

// Responses to hand-built requests (their ids start at 1e6), reported with the port they came over, and
// every refusal an owner sends this thread's proxy.
onMessageByType('models-process-backend-response', (message, port) => {
	if (message.request >= 1e6) report({ event: 'raw-response', from: port?.threadId, message });
	else if (message.refused !== undefined) report({ event: 'refused', from: port?.threadId, refused: message.refused });
});

// What threadServer does on SHUTDOWN before it closes servers and exits.
onMessageByType(ITC_EVENT_TYPES.SHUTDOWN, () => {
	const hadWork = shutdownDrainsHaveWork();
	runShutdownDrains(Date.now() + 15000).then(() => report({ event: 'drained', hadWork }));
});

onMessageByType('process-backend-test-command', async (message) => {
	try {
		reply(message.rid, await commands[message.command](message));
	} catch (error) {
		reply(message.rid, { thrown: { name: error?.name, message: error?.message } });
	}
});

// manageThreads unrefs the parent port; keep this worker alive until the test terminates it.
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'process-backend-test-ready', threadId });
