'use strict';

/**
 * Minimal test backend for the /v1/* gateway integration test (#631).
 *
 * Implements a simple echo backend inline — no imports from the Harper dist
 * directory. Loaded by `bootstrapModels()` via a `backend: <absolute-path>`
 * entry in the test config. Uses `global.models.registerBackend()` (which is
 * already populated when this register function is invoked).
 */

function textFromInput(input) {
	if (typeof input === 'string') return input;
	const messages = Array.isArray(input) ? input : input.messages;
	return messages.map((m) => m.content || '').join(' ');
}

const echoGenerative = {
	name: 'integration-test-echo',
	capabilities: () => ({ embed: false, generate: true, stream: true, tools: false, adapters: false }),
	async generate(input) {
		const text = textFromInput(input);
		const content = `[echo]: ${text}`;
		return {
			status: 'completed',
			output: { content, finishReason: 'stop' },
			usage: { promptTokens: text.length, completionTokens: content.length },
		};
	},
	async *generateStream(input) {
		const text = textFromInput(input);
		const words = `[echo stream]: ${text}`.split(' ');
		for (const word of words) {
			yield { deltaContent: word + ' ' };
		}
		yield { finishReason: 'stop' };
	},
};

const echoEmbedding = {
	name: 'integration-test-echo-embed',
	capabilities: () => ({ embed: true, generate: false, stream: false, tools: false, adapters: false }),
	async embed(input) {
		const inputs = Array.isArray(input) ? input : [input];
		return {
			status: 'completed',
			output: inputs.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
			usage: { embeddingTokens: inputs.length },
		};
	},
};

/**
 * Called by `registerFromModule` in bootstrap.ts. `global.models` is
 * available at call time (Models singleton is set before bootstrapModels runs).
 * @param {{ logicalName: string, kind: 'embedding' | 'generative' }} args
 */
exports.register = function ({ logicalName, kind }) {
	const models = global.models;
	if (!models) throw new Error('global.models is not set — bootstrap order violation');
	if (kind === 'generative') {
		models.registerBackend('generative', logicalName, echoGenerative);
	} else if (kind === 'embedding') {
		models.registerBackend('embedding', logicalName, echoEmbedding);
	}
};
