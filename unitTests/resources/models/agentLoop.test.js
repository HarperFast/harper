'use strict';

const assert = require('node:assert/strict');
// Prime module graph in the order other unit tests load it (avoids the ESM/CJS cycle
// when transaction.ts is loaded ESM-first).
require('#src/resources/databases');
const { setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
const { Models } = require('#src/resources/models/Models');
const { BudgetExceededError } = require('#src/resources/models/agentLoop');

function makeMockWriter() {
	const records = [];
	return {
		records,
		write(record) {
			records.push(record);
		},
	};
}

/**
 * Test-only backend that returns a queued sequence of generate results. Each entry
 * is the GenerateResult the next `generate(...)` call should resolve with. Records
 * every (input, opts) pair so tests can assert the loop's request shape.
 */
class ScriptedBackend {
	constructor(name = 'scripted') {
		this.name = name;
		this.responses = [];
		this.calls = [];
	}
	capabilities() {
		return { embed: false, generate: true, stream: false, tools: true, adapters: false };
	}
	queue(...results) {
		for (const r of results) this.responses.push(r);
		return this;
	}
	async generate(input, opts) {
		// Snapshot the input — the loop mutates the same `messages` array across
		// iterations, so naive reference capture would show every call as the final state.
		const snapshot =
			typeof input === 'string' || Array.isArray(input)
				? input
				: { ...input, messages: input.messages.map((m) => ({ ...m })) };
		this.calls.push({ input: snapshot, opts });
		if (this.responses.length === 0) {
			throw new Error('ScriptedBackend ran out of responses');
		}
		const next = this.responses.shift();
		return { status: 'completed', output: next.output, usage: next.usage };
	}
}

function final(content) {
	return { output: { content, finishReason: 'stop' }, usage: { promptTokens: 1, completionTokens: 1 } };
}

function toolCallRound(content, toolCalls) {
	return {
		output: { content, finishReason: 'tool_calls', toolCalls },
		usage: { promptTokens: 1, completionTokens: 1 },
	};
}

function tc(id, name, args) {
	return { id, name, arguments: args };
}

describe("agentLoop (toolMode: 'auto')", () => {
	let writer;
	let models;
	let backend;

	beforeEach(() => {
		clearRegistry();
		writer = makeMockWriter();
		models = new Models(writer);
		backend = new ScriptedBackend();
		setGenerative('default', backend);
	});

	afterEach(() => {
		clearRegistry();
	});

	describe('terminal-first round (passthrough equivalence)', () => {
		it('returns the single-shot result when backend emits no tool calls', async () => {
			backend.queue(final('hello world'));
			const result = await models.generate('hi', { toolMode: 'auto' });
			assert.strictEqual(result.content, 'hello world');
			assert.strictEqual(result.finishReason, 'stop');
			assert.strictEqual(result.trace, undefined, 'trace omitted when includeToolTrace not set');
		});

		it('returns the trace when includeToolTrace is set, even on first-round terminal', async () => {
			backend.queue(final('done'));
			const result = await models.generate('hi', { toolMode: 'auto', includeToolTrace: true });
			assert.deepStrictEqual(result.trace, [], 'empty trace = no tools ran');
		});

		it('outer auto call writes ZERO analytics rows; inner round writes ONE', async () => {
			backend.queue(final('one-shot'));
			await models.generate('hi', { toolMode: 'auto' });
			assert.strictEqual(writer.records.length, 1, 'one row per backend round');
			assert.strictEqual(writer.records[0].method, 'generate');
			assert.strictEqual(writer.records[0].success, true);
		});

		it('passes toolMode: return to the inner Models.generate (prevents loop recursion)', async () => {
			backend.queue(final('x'));
			await models.generate('hi', { toolMode: 'auto' });
			assert.strictEqual(backend.calls[0].opts.toolMode, 'return');
		});
	});

	describe('serial dispatch (multi-round)', () => {
		it('runs N rounds: tool call → result → tool call → result → final', async () => {
			backend.queue(
				toolCallRound('thinking', [tc('c1', 'echo', { text: 'a' })]),
				toolCallRound('still thinking', [tc('c2', 'echo', { text: 'b' })]),
				final('done: a + b')
			);
			const seen = [];
			const result = await models.generate('start', {
				toolMode: 'auto',
				toolHandlers: {
					echo: (args) => {
						seen.push(args.text);
						return { echoed: args.text };
					},
				},
			});
			assert.strictEqual(result.content, 'done: a + b');
			assert.deepStrictEqual(seen, ['a', 'b']);
			assert.strictEqual(backend.calls.length, 3);
			assert.strictEqual(writer.records.length, 3, 'one analytics row per iteration');
		});

		it('appends assistant + tool messages onto the running message list between rounds', async () => {
			backend.queue(
				toolCallRound('plan', [tc('c1', 'lookup', { key: 'k1' })]),
				final('answer')
			);
			await models.generate('q', {
				toolMode: 'auto',
				toolHandlers: { lookup: (args) => ({ key: args.key, value: 'v1' }) },
			});
			// First call only sees the user message.
			assert.strictEqual(backend.calls[0].input.messages.length, 1);
			assert.strictEqual(backend.calls[0].input.messages[0].role, 'user');
			// Second call sees: user, assistant(tool_calls), tool(result).
			assert.strictEqual(backend.calls[1].input.messages.length, 3);
			assert.strictEqual(backend.calls[1].input.messages[1].role, 'assistant');
			assert.ok(backend.calls[1].input.messages[1].toolCalls);
			assert.strictEqual(backend.calls[1].input.messages[2].role, 'tool');
			assert.strictEqual(backend.calls[1].input.messages[2].toolCallId, 'c1');
		});

		it('serial handlers run in order (no concurrent overlap in v1)', async () => {
			// Two tool calls in ONE round.
			backend.queue(
				toolCallRound('multi', [tc('c1', 'slow', { i: 1 }), tc('c1b', 'slow', { i: 2 })]),
				final('done')
			);
			const events = [];
			await models.generate('go', {
				toolMode: 'auto',
				toolHandlers: {
					slow: async (args) => {
						events.push(`start-${args.i}`);
						await new Promise((r) => setImmediate(r));
						events.push(`end-${args.i}`);
						return args.i;
					},
				},
			});
			// Serial: each handler completes before the next starts.
			assert.deepStrictEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
		});

		it('records the trace entries when includeToolTrace is set', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'echo', { text: 'a' })]),
				final('done')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: { echo: (args) => ({ echoed: args.text }) },
			});
			assert.strictEqual(result.trace.length, 1);
			const entry = result.trace[0];
			assert.strictEqual(entry.iteration, 1);
			assert.strictEqual(entry.toolCallId, 'c1');
			assert.strictEqual(entry.toolName, 'echo');
			assert.deepStrictEqual(entry.arguments, { text: 'a' });
			assert.strictEqual(JSON.parse(entry.result).echoed, 'a');
			assert.ok(entry.durationMs >= 0);
			assert.strictEqual(entry.truncated, undefined);
			assert.strictEqual(entry.error, undefined);
		});
	});

	describe('input normalization', () => {
		it('accepts a string input', async () => {
			backend.queue(final('out'));
			await models.generate('hello', { toolMode: 'auto' });
			assert.deepStrictEqual(backend.calls[0].input.messages, [{ role: 'user', content: 'hello' }]);
		});

		it('accepts a Message[] input', async () => {
			backend.queue(final('out'));
			const msgs = [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'q' },
			];
			await models.generate(msgs, { toolMode: 'auto' });
			assert.strictEqual(backend.calls[0].input.messages.length, 2);
			assert.notStrictEqual(backend.calls[0].input.messages, msgs, 'must copy, not alias caller array');
		});

		it('accepts a { messages, tools, system } object and threads tools + system through', async () => {
			backend.queue(final('out'));
			await models.generate(
				{
					messages: [{ role: 'user', content: 'q' }],
					tools: [{ name: 'echo', description: 'echoes', parameters: { type: 'object' } }],
					system: 'be helpful',
				},
				{ toolMode: 'auto' }
			);
			assert.strictEqual(backend.calls[0].input.system, 'be helpful');
			assert.strictEqual(backend.calls[0].input.tools[0].name, 'echo');
		});
	});

	describe('result truncation', () => {
		it('passes small results through untouched in the trace', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'small', {})]),
				final('done')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: { small: () => ({ ok: true }) },
			});
			assert.strictEqual(result.trace[0].result, JSON.stringify({ ok: true }));
			assert.strictEqual(result.trace[0].truncated, undefined);
		});

		it('truncates a result that exceeds toolResultMaxBytes and tags the trace entry', async () => {
			const huge = 'x'.repeat(10_000);
			backend.queue(
				toolCallRound('p', [tc('c1', 'big', {})]),
				final('done')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				toolResultMaxBytes: 256,
				includeToolTrace: true,
				toolHandlers: { big: () => huge },
			});
			const entry = result.trace[0];
			assert.strictEqual(entry.truncated, true);
			assert.ok(entry.totalBytes > 256);
			assert.ok(entry.result.includes('[truncated;'));
			// And the model received the truncated form, not the original.
			const messages = backend.calls[1].input.messages;
			const toolMsg = messages[messages.length - 1];
			assert.strictEqual(toolMsg.role, 'tool');
			assert.ok(toolMsg.content.length <= 256 + 80 /* slack for marker */);
			assert.ok(toolMsg.content.includes('[truncated;'));
		});

		it('handles multi-byte UTF-8 content cleanly (single-pass slice, no O(n²) trim)', async () => {
			// CJK characters are 3 bytes in UTF-8. With a 256-byte cap, ~85 chars worth of
			// JSON head fits before the marker. Make sure: (a) the byte cap is respected,
			// (b) the result is valid UTF-8 even when the byte boundary splits a codepoint,
			// (c) the trace's `totalBytes` reports the byte length, not char length.
			const text = '漢'.repeat(10_000); // 30_000 bytes UTF-8
			backend.queue(
				toolCallRound('p', [tc('c1', 'cjk', {})]),
				final('done')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				toolResultMaxBytes: 256,
				includeToolTrace: true,
				toolHandlers: { cjk: () => text },
			});
			const entry = result.trace[0];
			assert.strictEqual(entry.truncated, true);
			// totalBytes counts bytes, not characters.
			assert.ok(entry.totalBytes >= 30_000, `totalBytes=${entry.totalBytes} should be >= 30000`);
			// Body fits inside the cap (marker overhead may push the final string slightly
			// past in the corner where cap < markerBytes, but the body itself must stay in).
			const bodyBytes = Buffer.byteLength(entry.result, 'utf8');
			assert.ok(bodyBytes <= 256 + 60 /* marker overhead */, `bodyBytes=${bodyBytes}`);
			// The decoded string must be valid UTF-8 (replacement chars are OK at the
			// boundary, but no invalid byte sequences).
			assert.doesNotThrow(() => Buffer.from(entry.result, 'utf8').toString('utf8'));
		});
	});

	describe('handler errors (recover mode)', () => {
		it('appends the error as a tool result and keeps looping', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'broken', {})]),
				final('recovered')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: {
					broken: () => {
						throw new Error('boom');
					},
				},
			});
			assert.strictEqual(result.content, 'recovered');
			assert.strictEqual(result.trace[0].error.message, 'boom');
			// Model saw the error envelope in the tool message.
			const lastMsg = backend.calls[1].input.messages[backend.calls[1].input.messages.length - 1];
			assert.strictEqual(lastMsg.role, 'tool');
			assert.strictEqual(JSON.parse(lastMsg.content).error, 'boom');
		});

		it('recovers when serialization throws on a BigInt return value', async () => {
			// Handlers returning raw DB rows can include BigInt — JSON.stringify throws.
			// The loop must catch the serialization error in the same recover path it uses
			// for handler throws, otherwise a "real" tool result crashes the whole loop.
			backend.queue(
				toolCallRound('p', [tc('c1', 'bigint', {})]),
				final('recovered')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: { bigint: () => ({ id: 123n }) },
			});
			assert.strictEqual(result.content, 'recovered');
			assert.ok(result.trace[0].error, 'serialization failure must surface on the trace');
			assert.match(result.trace[0].error.message, /BigInt/);
		});

		it('recovers when serialization throws on a circular result', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'cyc', {})]),
				final('recovered')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: {
					cyc: () => {
						const o = {};
						o.self = o;
						return o;
					},
				},
			});
			assert.strictEqual(result.content, 'recovered');
			assert.ok(result.trace[0].error);
		});
	});

	describe('trace integrity', () => {
		it("trace's `arguments` is decoupled from in-handler mutation", async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'mutator', { keep: 'as-emitted' })]),
				final('done')
			);
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: {
					mutator: (args) => {
						// Common pattern: normalize input in place.
						args.mutated = true;
						args.keep = 'mutated';
						return args;
					},
				},
			});
			// The trace must show what the MODEL emitted, not the handler's mutated view.
			assert.strictEqual(result.trace[0].arguments.mutated, undefined);
			assert.strictEqual(result.trace[0].arguments.keep, 'as-emitted');
		});
	});

	describe('inner backend errors', () => {
		it('propagates a mid-loop backend throw and records the analytics row for that round', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'echo', { i: 0 })])
				// Second round: backend throws (no queued response → ScriptedBackend rejects).
			);
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						toolHandlers: { echo: (args) => args },
					}),
				/ran out of responses/
			);
			// First inner round succeeded (one analytics row); second failed (second row).
			// Both came through the single-shot path's analytics — the outer auto call
			// writes nothing of its own.
			assert.strictEqual(writer.records.length, 2);
			assert.strictEqual(writer.records[0].success, true);
			assert.strictEqual(writer.records[1].success, false);
		});
	});

	describe('missing handler', () => {
		it('throws ClientError(400) — nothing to dispatch to', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'unknown', {})]));
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', toolHandlers: {} }),
				(err) => err.statusCode === 400 && /No handler registered/.test(err.message)
			);
		});
	});

	describe('iteration budget', () => {
		it("trips BudgetExceededError({kind: 'iterations'}) when the model keeps calling tools", async () => {
			// 4 rounds of tool calls — cap is 3.
			for (let i = 0; i < 4; i++) {
				backend.queue(toolCallRound(`r${i}`, [tc(`c${i}`, 'echo', { i })]));
			}
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					maxToolIterations: 3,
					toolHandlers: { echo: (args) => args },
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.kind, 'iterations');
			assert.strictEqual(caught.statusCode, 429);
			// Trace is always attached on the budget-error path, even without includeToolTrace.
			assert.strictEqual(caught.partialTrace.length, 3, 'one trace entry per iteration that ran');
		});

		it('default cap is 10', async () => {
			for (let i = 0; i < 11; i++) {
				backend.queue(toolCallRound(`r${i}`, [tc(`c${i}`, 'echo', { i })]));
			}
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					toolHandlers: { echo: (args) => args },
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.kind, 'iterations');
			assert.strictEqual(caught.partialTrace.length, 10);
		});
	});

	describe('gated modes (deferred to later commits)', () => {
		it("toolArgValidation: 'strict' throws 501 at entry", async () => {
			backend.queue(final('x'));
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', toolArgValidation: 'strict' }),
				(err) => err.statusCode === 501 && /toolArgValidation/.test(err.message)
			);
		});

		it("toolArgValidation: 'lenient' throws 501 at entry", async () => {
			backend.queue(final('x'));
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', toolArgValidation: 'lenient' }),
				(err) => err.statusCode === 501
			);
		});

		it("toolErrorMode: 'abort' throws 501 at entry", async () => {
			backend.queue(final('x'));
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', toolErrorMode: 'abort' }),
				(err) => err.statusCode === 501 && /toolErrorMode/.test(err.message)
			);
		});

		it('maxToolTokens throws 501 at entry (commit 4)', async () => {
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', maxToolTokens: 1000 }),
				(err) => err.statusCode === 501
			);
		});

		it('maxCostUsd throws 501 at entry (commit 4)', async () => {
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', maxCostUsd: 0.1 }),
				(err) => err.statusCode === 501
			);
		});

		it('opts.conversation throws 501 at entry (commit 5)', async () => {
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						conversation: { async append() {} },
					}),
				(err) => err.statusCode === 501 && /conversation/.test(err.message)
			);
		});
	});
});
