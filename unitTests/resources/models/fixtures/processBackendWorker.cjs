'use strict';

// Worker for processBackend.test.js, started through manageThreads' startWorker so it joins the same
// port mesh production workers use. It registers backends (process-wide or per thread) and calls them
// through the models facade on command, reporting every factory run, backend call, disposal, analytics
// row, metric and refusal to the test, tagged with the thread it ran on. Its backends can hold or reject
// their dispose(), fail on a chosen input, keep their factory's signal and throw from a property getter;
// a factory can also register its backend and return a different engine object, as a module factory
// may, whose own dispose() the test can hold or reject; register a second backend under its key, or an
// invalid one after a valid one; register a backend and then throw; or register a backend under another
// key beside the one it returns, or leave async work running that registers under its key once the test
// releases it, either another backend, whose dispose() the test can hold or reject, or the very one it
// returned. A thread can also register a backend under a key directly, as code outside any factory
// would. Its calls can carry options that cannot cross threads, that two calls
// share by reference, or that are class instances. On
// SHUTDOWN it runs Harper's shutdown drains the way threadServer does, so the test sees what a real
// worker would wait for before exiting.
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
/** One Date every call made with `shareDate` holds by reference, as two calls sharing an options object would. */
const SHARED_DATE = new Date(0);
/** An option built from a class: its own field crosses threads, its prototype (and the getter on it) does not. */
class Tier {
	constructor(name) {
		this.name = name;
	}
	get label() {
		return this.name.toUpperCase();
	}
}

/** `value` as it can be reported to the test: a value that cannot cross threads is described, not sent. */
function reportable(value) {
	try {
		return structuredClone(value);
	} catch {
		return { uncloneable: Object.keys(value) };
	}
}

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
	const backend = {
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
			// What a class-instance option looks like once it reaches the backend.
			const tier = rest.tier && {
				plain: Object.getPrototypeOf(rest.tier) === Object.prototype,
				name: rest.tier.name,
				label: rest.tier.label,
			};
			report({ event: 'embed', id, what: spec.what ?? 'backend', texts, opts: reportable(rest), accounting, tier });
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
		// 'hold' waits until the test releases `dispose:<id>` (`dispose:<id>:<what>` for a backend a factory
		// registers beside others); 'reject' rejects every time, 'reject-once' the first time; 'getter-throws'
		// replaces this method with a property that throws when read (below).
		async dispose() {
			disposals++;
			report({ event: 'dispose', id, what: spec.what ?? 'backend' });
			const gate = spec.what === undefined ? `dispose:${id}` : `dispose:${id}:${spec.what}`;
			if (spec.dispose === 'hold') await new Promise((resolve) => gates.set(gate, resolve));
			if (spec.dispose === 'reject' || (spec.dispose === 'reject-once' && disposals === 1))
				throw new Error(`could not free the model of ${id}`);
		},
	};
	// A backend whose `capabilities` cannot even be read: the getter throws before any method is reached.
	if (spec.capabilities === 'getter-throws')
		Object.defineProperty(backend, 'capabilities', {
			get() {
				throw new Error('the capabilities property is not readable yet');
			},
		});
	// A backend whose `dispose` cannot be read, so no try to dispose it can succeed.
	if (spec.dispose === 'getter-throws')
		Object.defineProperty(backend, 'dispose', {
			get() {
				report({ event: 'dispose-read', id });
				throw new Error(`the dispose property of ${id} is not readable`);
			},
		});
	return backend;
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

/**
 * An engine a factory returns beside the backend it registers, as a module factory may return the
 * handle its backend wraps. 'hold' waits until the test releases `dispose-engine:<id>`; 'reject' rejects
 * every time.
 */
function engine(id, disposal) {
	return {
		engine: id,
		async dispose() {
			report({ event: 'dispose', id, what: 'engine' });
			if (disposal === 'hold') await new Promise((resolve) => gates.set(`dispose-engine:${id}`, resolve));
			if (disposal === 'reject') throw new Error(`could not close the engine of ${id}`);
		},
	};
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
		registersAndReturns,
		registersTwice,
		registersInvalid,
		registersThenThrows,
		registersExtra,
		registersLate,
		lateDispose,
		engineDispose,
	}) {
		const build = (factorySignal, what, disposal = dispose) =>
			kind === 'generative'
				? generativeBackend(id)
				: kind === 'decision'
					? decisionBackend(id)
					: embeddingBackend(id, {
							capabilities,
							usage,
							failOn,
							dispose: disposal,
							factorySignal: watchFactorySignal ? factorySignal : undefined,
							what,
						});
		/** An embedding backend without embed(), which registerBackend refuses, that can still be disposed. */
		const invalid = () => {
			const backend = embeddingBackend(id, { dispose, what: 'invalid' });
			delete backend.embed;
			return backend;
		};
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
				signal?.addEventListener(
					'abort',
					() => report({ event: 'factory-aborted', id, name: signal.reason?.name, reason: signal.reason?.reason }),
					{ once: true }
				);
				// Held until the test releases it, so the test can line up claimants and calls first.
				if (failStart || holdStart) await new Promise((resolve) => gates.set(`start:${id}`, resolve));
				report({ event: 'factory-settled', id, aborted: signal?.aborted === true });
				if (failStart) throw new Error('model file is missing');
				if (registersTwice) {
					// Registers a backend, then a second one under the same key. 'propagate' rethrows the refusal;
					// 'catch' swallows it and returns an engine beside the first, as if nothing had happened.
					models.registerBackend(kind, id, build(signal, 'first'));
					try {
						models.registerBackend(kind, id, build(signal, 'second'));
					} catch (error) {
						report({ event: 'registration-refused', id, name: error?.name, message: error?.message });
						if (registersTwice === 'propagate') throw error;
					}
					return engine(id, engineDispose);
				}
				if (registersInvalid) {
					// Registers a valid backend, then one registerBackend refuses as invalid, and rethrows that refusal.
					models.registerBackend(kind, id, build(signal, 'first'));
					try {
						models.registerBackend(kind, id, invalid());
					} catch (error) {
						report({ event: 'registration-refused', id, name: error?.name, message: error?.message });
						throw error;
					}
				}
				if (registersThenThrows) {
					models.registerBackend(kind, id, build(signal, 'registered'));
					throw new Error('the model file is corrupt');
				}
				if (registersLate) {
					// Leaves async work running that, once the test releases `late:<id>`, registers under the key
					// after the start it belonged to has ended: another backend, whose dispose() follows
					// `lateDispose`, or with 'returned' the backend the factory returned.
					const returned = build(signal, undefined, null);
					void new Promise((resolve) => gates.set(`late:${id}`, resolve)).then(() => {
						let threw;
						try {
							models.registerBackend(
								kind,
								id,
								registersLate === 'returned' ? returned : build(signal, 'late', lateDispose ?? null)
							);
						} catch (error) {
							threw = { name: error?.name, message: error?.message };
						}
						report({ event: 'late-registered', id, threw });
					});
					return returned;
				}
				if (registersExtra) {
					// A backend under another key, whose dispose() follows `dispose`, beside the one the factory
					// returns, whose dispose() resolves at once.
					models.registerBackend(kind, `${id}-extra`, build(signal, 'extra'));
					return build(signal, undefined, null);
				}
				if (!registersAndReturns) return build(signal);
				// A module-shaped factory: it registers the backend and returns a different object.
				models.registerBackend(kind, id, build(signal));
				return engine(id, engineDispose);
			},
			options
		);
		return {};
	},
	/** Register a backend under `id` from no factory, as other code on the thread would. */
	registerDirect({ id, what }) {
		try {
			models.registerBackend('embedding', id, embeddingBackend(id, { what }));
			return {};
		} catch (error) {
			return { threw: { name: error?.name, message: error?.message } };
		}
	},
	fallback({ id, fallbackId }) {
		models.registerBackend('embedding', fallbackId, embeddingBackend(fallbackId));
		setFallbackGroup('embedding', id, [fallbackId]);
		return {};
	},
	async embed({ rid, id, texts, opts, tenant, shareDate, nestedFunction, tier }) {
		const controller = new AbortController();
		controllers.set(rid, controller);
		const callOpts = { ...opts, model: id, signal: controller.signal };
		if (shareDate) callOpts.when = SHARED_DATE;
		if (nestedFunction) callOpts.hooks = { onProgress() {} };
		if (tier !== undefined) callOpts.tier = new Tier(tier);
		const call = () => models.embed(texts, callOpts);
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
