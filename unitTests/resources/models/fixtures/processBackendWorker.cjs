'use strict';

// Worker for processBackend.test.js, started through manageThreads' startWorker so it joins the same
// port mesh production workers use. It registers an embedding backend (process-wide or per thread)
// and embeds through the models facade on command, reporting every factory run and backend call
// to the test, tagged with the thread it ran on.
const { parentPort, threadId } = require('node:worker_threads');
// Prime Harper's module graph in the order the other models tests do (see Models.test.js).
require('#src/resources/databases');
const { onMessageByType } = require('#js/server/threads/manageThreads');
const { Models } = require('#src/resources/models/Models');
const { ownerLoad } = require('#src/resources/models/processBackend');

// No analytics: the facade writes its call rows to this writer and its metrics nowhere.
const models = new Models({ write: () => 0 }, () => {}, {});
const report = (event) => parentPort.postMessage({ type: 'process-backend-test-event', threadId, ...event });
const reply = (rid, body) => parentPort.postMessage({ type: 'process-backend-test-reply', rid, threadId, ...body });
const gates = new Map();
const controllers = new Map();

/** A float32-exact fingerprint of `text`, so the test can tell which request a vector answers. */
function fingerprint(text) {
	let hash = 7;
	for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 16777216;
	return hash;
}

function testBackend(name) {
	return models.defineBackend({
		name,
		async embed(input, opts) {
			const texts = Array.isArray(input) ? input : [input];
			report({ event: 'embed', texts });
			for (const text of texts) {
				// Held until the test releases it, so later requests queue behind this call.
				if (text.startsWith('gate:')) await new Promise((resolve) => gates.set(text, resolve));
				// Runs until its signal aborts, so the test can see a caller's cancel reach the owner.
				if (text.startsWith('until-aborted:'))
					await new Promise((resolve, reject) => {
						report({ event: 'waiting', text });
						opts.signal.addEventListener(
							'abort',
							() => {
								report({ event: 'aborted', text });
								reject(opts.signal.reason);
							},
							{ once: true }
						);
					});
			}
			return {
				status: 'completed',
				output: texts.map((text) => Float32Array.from([fingerprint(text), threadId])),
				usage: { embeddingTokens: texts.length * 3 },
			};
		},
	});
}

const commands = {
	register({ id, scope, options, failStart }) {
		if (scope === 'thread') {
			report({ event: 'factory', id });
			models.registerBackend('embedding', id, testBackend(`test:${id}`));
			return {};
		}
		models.registerProcessBackend(
			'embedding',
			id,
			async () => {
				report({ event: 'factory', id });
				if (failStart) {
					// Fails when the test releases it, so the test can line up the other claimants first.
					await new Promise((resolve) => gates.set(`start:${id}`, resolve));
					throw new Error('model file is missing');
				}
				return testBackend(`test:${id}`);
			},
			options
		);
		return {};
	},
	async embed({ rid, id, texts }) {
		const controller = new AbortController();
		controllers.set(rid, controller);
		try {
			const vectors = await models.embed(texts, { model: id, signal: controller.signal });
			return { ok: true, vectors: vectors.map((vector) => [...vector]) };
		} catch (error) {
			return { ok: false, error: { name: error?.name, reason: error?.reason, message: error?.message } };
		} finally {
			controllers.delete(rid);
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
	status({ id }) {
		return { status: models.backendStatus('embedding', id) };
	},
	load({ id }) {
		return { load: ownerLoad('embedding', id) };
	},
};

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
