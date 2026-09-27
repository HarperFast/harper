'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	setGenerative,
	setDecision,
	clearRegistry,
	defineBackend,
	ModelBackendRegistrationError,
} = require('#src/resources/models/backendRegistry');
const { clearRouting, setFallbackGroup } = require('#src/resources/models/routing');
const { Models } = require('#src/resources/models/Models');
const { ChoiceScoringUnsupportedError } = require('#src/resources/models/backendHelpers');
const { createGenerativeDecisionBackend } = require('#src/resources/models/generativeDecision');
const { resetDecisionTables } = require('#src/resources/models/decisionStore');
const { OpenAIBackend } = require('#src/components/openai/index');

const generate = async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } });
const letters = (n) => Array.from({ length: n }, (_, i) => `v${i}`);

function makeMockWriter() {
	const records = [];
	let nextId = 1000;
	return {
		records,
		write(record) {
			records.push(record);
			return nextId++;
		},
	};
}

function limitedScorer(name, maxScoredChoices) {
	const backend = defineBackend({
		name,
		generate,
		structuredOutput: true,
		maxScoredChoices,
		scoreChoices: async (_input, choices) => {
			backend.calls++;
			return { status: 'completed', output: { logLikelihoods: choices.map((_, i) => -i) } };
		},
	});
	backend.calls = 0;
	return backend;
}

function firstValueVotes(schema) {
	const calls = [];
	const answer = schema.properties
		? Object.fromEntries(Object.entries(schema.properties).map(([name, leaf]) => [name, leaf.enum[0]]))
		: { value: schema.enum[0] };
	return {
		calls,
		generate: async (input, opts) => {
			calls.push(opts);
			return { content: JSON.stringify(answer), finishReason: 'stop' };
		},
	};
}

describe('scoring limits (#2849)', () => {
	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	describe('defineBackend', () => {
		it('passes maxScoredChoices through for a scoring backend and omits it otherwise', () => {
			assert.strictEqual(limitedScorer('s', 5).capabilities().maxScoredChoices, 5);
			assert.strictEqual(
				defineBackend({ name: 'plain', generate, maxScoredChoices: 5 }).capabilities().maxScoredChoices,
				undefined
			);
			assert.strictEqual(limitedScorer('u', undefined).capabilities().maxScoredChoices, undefined);
		});

		it('rejects a limit that is not a positive integer', () => {
			for (const bad of [0, -1, 2.5, Number.NaN, Infinity, '20'])
				assert.throws(() => limitedScorer('bad', bad), ModelBackendRegistrationError, String(bad));
		});
	});

	describe('models.scoreChoices', () => {
		let writer;
		let models;
		beforeEach(() => {
			writer = makeMockWriter();
			models = new Models(writer, () => {});
		});

		it('declines a call above the limit without invoking the backend, recording scoring_unsupported', async () => {
			const s = limitedScorer('limited', 2);
			setGenerative('default', s);
			await assert.rejects(models.scoreChoices('q', letters(3)), ChoiceScoringUnsupportedError);
			assert.strictEqual(s.calls, 0);
			assert.deepStrictEqual(
				writer.records.map((r) => [r.backend, r.success, r.error_code, r.prompt_tokens]),
				[['limited', false, 'scoring_unsupported', undefined]]
			);
		});

		it('scores at exactly the limit', async () => {
			const s = limitedScorer('limited', 3);
			setGenerative('default', s);
			const r = await models.scoreChoices('q', letters(3));
			assert.strictEqual(r.logLikelihoods.length, 3);
			assert.strictEqual(s.calls, 1);
		});

		it('falls through a limited primary to an unlimited fallback', async () => {
			const primary = limitedScorer('primary', 2);
			const fallback = limitedScorer('fallback', undefined);
			setGenerative('primary', primary);
			setGenerative('fallback', fallback);
			setFallbackGroup('generative', 'primary', ['fallback']);
			await models.scoreChoices('q', letters(5), { model: 'primary' });
			assert.deepStrictEqual([primary.calls, fallback.calls], [0, 1]);
			assert.deepStrictEqual(
				writer.records.map((r) => [r.backend, r.error_code ?? 'ok']),
				[
					['primary', 'scoring_unsupported'],
					['fallback', 'ok'],
				]
			);
		});

		it('reports a candidate that advertises scoring without implementing it as a failure, not a decline', async () => {
			setGenerative('default', {
				name: 'liar',
				capabilities: () => ({
					embed: false,
					generate: true,
					stream: false,
					tools: false,
					adapters: false,
					scoreChoices: true,
					maxScoredChoices: 2,
				}),
				generate,
			});
			await assert.rejects(
				models.scoreChoices('q', letters(3)),
				(err) => err.name !== 'ChoiceScoringUnsupportedError' && /does not implement/.test(err.message)
			);
		});

		it('ignores a malformed limit from a hand-written backend', async () => {
			const s = limitedScorer('fine', undefined);
			const original = s.capabilities();
			s.capabilities = () => ({ ...original, maxScoredChoices: Number.NaN });
			setGenerative('default', s);
			await models.scoreChoices('q', letters(30));
			assert.strictEqual(s.calls, 1);
		});
	});

	describe('the generative adapter under scoring: auto', () => {
		const leaf = (n) => ({ enum: letters(n) });

		it('votes a schema with a leaf above every candidate limit, with no scoring attempt', async () => {
			const s = limitedScorer('limited', 20);
			setGenerative('default', s);
			const schema = { type: 'object', properties: { small: leaf(4), large: leaf(21) } };
			const votes = firstValueVotes(schema);
			const scoreCalls = [];
			const backend = createGenerativeDecisionBackend(
				{ samples: 2 },
				{ generate: votes.generate, score: async (...args) => scoreCalls.push(args) }
			);
			const result = await backend.decide('x', schema, {});
			assert.strictEqual(scoreCalls.length, 0);
			assert.strictEqual(votes.calls.length, 2);
			assert.match(result.output.signature, /mode=vote/);
		});

		it('scores a schema whose largest leaf is exactly at the limit', async () => {
			const s = limitedScorer('limited', 20);
			setGenerative('default', s);
			const backend = createGenerativeDecisionBackend({ samples: 2 }, { generate: () => assert.fail('voted') });
			const result = await backend.decide('x', { type: 'object', properties: { small: leaf(4), large: leaf(20) } }, {});
			assert.match(result.output.signature, /mode=score/);
			assert.strictEqual(s.calls, 2);
		});

		it('scores when an unlimited candidate in the fallback group can take the largest leaf', async () => {
			setGenerative('primary', limitedScorer('primary', 5));
			setGenerative('fallback', limitedScorer('fallback', undefined));
			setFallbackGroup('generative', 'primary', ['fallback']);
			const backend = createGenerativeDecisionBackend(
				{ generative: 'primary', samples: 1 },
				{ generate: () => assert.fail('voted') }
			);
			const result = await backend.decide('x', leaf(9), {});
			assert.match(result.output.signature, /mode=score/);
		});

		it('scoring: score surfaces the decline without a scoring request', async () => {
			const s = limitedScorer('limited', 3);
			setGenerative('default', s);
			const backend = createGenerativeDecisionBackend({ scoring: 'score' }, { generate: () => assert.fail('voted') });
			await assert.rejects(backend.decide('x', leaf(4), {}), ChoiceScoringUnsupportedError);
			assert.strictEqual(s.calls, 0);
		});
	});

	describe('end to end over the OpenAI backend', () => {
		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			resetDecisionTables();
		});

		it('votes and persists a decision whose largest leaf exceeds 20 without sending a scoring request', async () => {
			const scoring = [];
			const completions = [];
			const fetch = async (url, init) => {
				const body = JSON.parse(init.body);
				if (body.logprobs) {
					scoring.push(body);
					throw new Error('no scoring request is expected');
				}
				completions.push(body);
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: { role: 'assistant', content: JSON.stringify({ small: 'v0', large: 'v0' }) },
								finish_reason: 'stop',
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				);
			};
			setGenerative('default', new OpenAIBackend({ apiKey: 'k', model: 'gpt-4o-mini' }, fetch));
			const schema = { type: 'object', properties: { small: { enum: letters(4) }, large: { enum: letters(25) } } };
			setDecision('default', createGenerativeDecisionBackend({ samples: 2 }));
			const writer = makeMockWriter();
			const models = new Models(writer, () => {});
			const decision = await models.decide('a ticket', schema, { persist: true });
			assert.strictEqual(scoring.length, 0);
			assert.strictEqual(completions.length, 2);
			assert.ok(
				completions.every((c) => c.response_format),
				'votes carry the response schema'
			);
			assert.deepStrictEqual(decision.value, { small: 'v0', large: 'v0' });
			assert.ok(!writer.records.some((r) => r.method === 'scoreChoices'));
			const stored = await models.getDecision(decision.id);
			assert.match(stored.signature, /mode=vote/);
		});
	});
});

describe('scoring limits: hardening (#2849)', () => {
	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('an OpenAI model that refused logprobs reports no scoring limit', async () => {
		const fetch = async () =>
			new Response(JSON.stringify({ error: { message: 'logprobs is not supported', param: 'logprobs' } }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		const b = new OpenAIBackend({ apiKey: 'k', model: 'o1' }, fetch);
		await assert.rejects(b.scoreChoices('q', ['a', 'b'], { accounting: {} }));
		assert.strictEqual(b.capabilities().scoreChoices, false);
		assert.strictEqual(b.capabilities().maxScoredChoices, undefined);
	});

	it('the auto probe treats a malformed leaf as above every limit rather than throwing', async () => {
		setGenerative('default', limitedScorer('limited', 20));
		const votes = firstValueVotes({ enum: ['a', 'b'] });
		const backend = createGenerativeDecisionBackend({ samples: 1 }, { generate: votes.generate });
		const malformed = { type: 'integer' };
		const err = await backend.decide('x', malformed, {}).then(
			() => undefined,
			(e) => e
		);
		assert.ok(!(err instanceof TypeError), String(err));
	});
});

describe('scoring limits with no-match (#2849 with #2846)', () => {
	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('counts the none choice, so a 20-value no-match leaf votes against a 20-choice limit without a scoring attempt', async () => {
		const s = limitedScorer('limited', 20);
		setGenerative('default', s);
		const samples = [];
		const backend = createGenerativeDecisionBackend(
			{ samples: 2 },
			{
				generate: async (input, opts) => {
					samples.push(opts);
					return { content: JSON.stringify({ value: 'v0', noMatch: false }), finishReason: 'stop' };
				},
			}
		);
		const result = await backend.decide('x', { enum: letters(20), noMatch: true }, {});
		assert.strictEqual(s.calls, 0);
		assert.strictEqual(samples.length, 2);
		assert.match(result.output.signature, /mode=vote/);
	});

	it('still scores a 19-value no-match leaf within the same limit', async () => {
		const s = limitedScorer('limited', 20);
		setGenerative('default', s);
		const backend = createGenerativeDecisionBackend({ samples: 2 }, { generate: () => assert.fail('voted') });
		const result = await backend.decide('x', { enum: letters(19), noMatch: true }, {});
		assert.match(result.output.signature, /mode=score/);
		assert.strictEqual(s.calls, 1);
	});
});
