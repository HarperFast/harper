'use strict';

const assert = require('node:assert/strict');
// Prime module graph in the order other unit tests load it (avoids the ESM/CJS cycle
// when transaction.ts is loaded ESM-first).
require('#src/resources/databases');
const { setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
const { Models } = require('#src/resources/models/Models');
const {
	BudgetExceededError,
	ToolHandlerError,
	_setComputeCallCostUsdForTests,
	_resetComputeCallCostUsdForTests,
} = require('#src/resources/models/agentLoop');
const { logger } = require('#src/utility/logging/logger');

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
		this.streamResponses = [];
		this.calls = [];
		this.streamCalls = [];
	}
	capabilities() {
		return { embed: false, generate: true, stream: true, tools: true, adapters: false };
	}
	queue(...results) {
		for (const r of results) this.responses.push(r);
		return this;
	}
	queueStream(...rounds) {
		// Each `round` is an array of GenerateChunk-like objects to yield in order.
		for (const round of rounds) this.streamResponses.push(round);
		return this;
	}
	async generate(input, opts) {
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
	async *generateStream(input, opts) {
		const snapshot =
			typeof input === 'string' || Array.isArray(input)
				? input
				: { ...input, messages: input.messages.map((m) => ({ ...m })) };
		this.streamCalls.push({ input: snapshot, opts });
		if (this.streamResponses.length === 0) {
			throw new Error('ScriptedBackend stream ran out of rounds');
		}
		const chunks = this.streamResponses.shift();
		for (const c of chunks) yield c;
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
			backend.queue(toolCallRound('plan', [tc('c1', 'lookup', { key: 'k1' })]), final('answer'));
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

		it("toolParallelism: 'serial' runs handlers in order (no concurrent overlap)", async () => {
			// Two tool calls in ONE round.
			backend.queue(toolCallRound('multi', [tc('c1', 'slow', { i: 1 }), tc('c1b', 'slow', { i: 2 })]), final('done'));
			const events = [];
			await models.generate('go', {
				toolMode: 'auto',
				toolParallelism: 'serial',
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
			backend.queue(toolCallRound('p', [tc('c1', 'echo', { text: 'a' })]), final('done'));
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
		it('coerces null/undefined assistant content to empty string (OpenAI-style tool-call rounds)', async () => {
			// OpenAI leaves `content` as null when the model's only output is tool_calls.
			// `Message.content` and `ConversationTurn.content` are typed as required
			// strings — the loop must coerce at the seam, not push null into the
			// running message list (would corrupt downstream rounds + appender).
			backend.queue(
				{ output: { content: null, finishReason: 'tool_calls', toolCalls: [tc('c1', 'echo', { x: 1 })] }, usage: {} },
				final('done')
			);
			const turns = [];
			await models.generate('q', {
				toolMode: 'auto',
				conversation: {
					async append(t) {
						turns.push(t);
					},
				},
				toolHandlers: { echo: (args) => args },
			});
			// Round 2 saw the assistant message with empty-string content (not null).
			const round2 = backend.calls[1].input.messages;
			const assistantMsg = round2.find((m) => m.role === 'assistant');
			assert.strictEqual(assistantMsg.content, '');
			// Conversation appender got empty string too.
			const assistantTurn = turns.find((t) => t.role === 'assistant' && t.toolCalls);
			assert.strictEqual(assistantTurn.content, '');
		});

		it('passes small results through untouched in the trace', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'small', {})]), final('done'));
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
			backend.queue(toolCallRound('p', [tc('c1', 'big', {})]), final('done'));
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
			backend.queue(toolCallRound('p', [tc('c1', 'cjk', {})]), final('done'));
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
			backend.queue(toolCallRound('p', [tc('c1', 'broken', {})]), final('recovered'));
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
			backend.queue(toolCallRound('p', [tc('c1', 'bigint', {})]), final('recovered'));
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
			backend.queue(toolCallRound('p', [tc('c1', 'cyc', {})]), final('recovered'));
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

	describe("parallel dispatch (default, toolParallelism: 'parallel')", () => {
		it('handlers in one round run concurrently — start events interleave', async () => {
			backend.queue(toolCallRound('multi', [tc('c1', 'slow', { i: 1 }), tc('c2', 'slow', { i: 2 })]), final('done'));
			const events = [];
			await models.generate('go', {
				toolMode: 'auto',
				// Default is parallel — assert behavior without explicit opt-in.
				toolHandlers: {
					slow: async (args) => {
						events.push(`start-${args.i}`);
						await new Promise((r) => setImmediate(r));
						events.push(`end-${args.i}`);
						return args.i;
					},
				},
			});
			// Parallel: both starts fire before either end (handlers overlap).
			assert.deepStrictEqual(events, ['start-1', 'start-2', 'end-1', 'end-2']);
		});

		it('trace and tool messages are in CALL order, not completion order', async () => {
			// Handler #1 sleeps longer than #2 — completion order is [#2, #1] but the
			// trace and the tool messages fed back to the model must follow the order the
			// model emitted them in.
			backend.queue(toolCallRound('p', [tc('c1', 'slow', { ms: 10 }), tc('c2', 'fast', { ms: 0 })]), final('done'));
			const result = await models.generate('go', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: {
					slow: async (args) => {
						await new Promise((r) => setTimeout(r, args.ms));
						return { tag: 'slow' };
					},
					fast: async (args) => {
						await new Promise((r) => setTimeout(r, args.ms));
						return { tag: 'fast' };
					},
				},
			});
			assert.deepStrictEqual(
				result.trace.map((e) => e.toolName),
				['slow', 'fast']
			);
			// Tool messages on round 2 appear in call order too.
			const round2 = backend.calls[1].input.messages;
			const toolMsgs = round2.filter((m) => m.role === 'tool');
			assert.deepStrictEqual(
				toolMsgs.map((m) => m.toolCallId),
				['c1', 'c2']
			);
		});

		it('single tool call uses the serial path even under parallel default', async () => {
			// Sanity — one call, default parallel: still runs cleanly via Promise.all bypass.
			backend.queue(toolCallRound('p', [tc('c1', 'echo', { x: 1 })]), final('done'));
			const result = await models.generate('go', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: { echo: (args) => args },
			});
			assert.strictEqual(result.trace.length, 1);
		});
	});

	describe('abort propagation', () => {
		it('caller aborts between rounds → next iteration throws AbortError, partial work analytics recorded', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'echo', { i: 0 })]),
				// Second round won't be reached — caller aborts after round 1's handler runs.
				final('unreachable')
			);
			const ac = new AbortController();
			let abortedDuringHandler = false;
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						signal: ac.signal,
						toolHandlers: {
							echo: async (args, ctx) => {
								// Caller aborts as the handler runs — composed signal reflects it.
								ac.abort();
								abortedDuringHandler = ctx.signal && ctx.signal.aborted;
								return args;
							},
						},
					}),
				(err) => err.name === 'AbortError'
			);
			assert.strictEqual(abortedDuringHandler, true, 'handler ctx.signal must reflect caller abort');
			// One analytics row for round 1 (succeeded); round 2 never started, so no row.
			// (`throwIfAborted` fires before the second `models.generate` is reached.)
			assert.strictEqual(writer.records.length, 1);
			assert.strictEqual(writer.records[0].success, true);
		});

		it('handler ctx.signal aborts when caller aborts during execution', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'slow', {})]), final('done'));
			const ac = new AbortController();
			let handlerSawAbort = false;
			await assert.rejects(
				async () => {
					await models.generate('q', {
						toolMode: 'auto',
						signal: ac.signal,
						toolHandlers: {
							slow: async (_args, ctx) => {
								// Race: abort and listen on ctx.signal simultaneously.
								await new Promise((resolve, reject) => {
									ctx.signal.addEventListener('abort', () => {
										handlerSawAbort = true;
										reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
									});
									setImmediate(() => ac.abort());
								});
							},
						},
					});
				},
				(err) => err.name === 'AbortError'
			);
			assert.strictEqual(handlerSawAbort, true);
		});

		it('composed signal flows to the inner Models.generate as a wrapper (not the caller signal directly)', async () => {
			// Use a custom backend that observes the signal AT call time — the loop's
			// finally aborts the composed signal on exit, so post-loop inspection would
			// always show aborted=true. The point is: backend gets the wrapper, not the
			// raw caller signal, and it's not aborted while the call is in flight.
			let observedSignal;
			let abortedDuringCall;
			setGenerative('default', {
				name: 'observe',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: true, adapters: false }),
				async generate(_input, opts) {
					observedSignal = opts.signal;
					abortedDuringCall = opts.signal?.aborted ?? null;
					return { status: 'completed', output: { content: 'x', finishReason: 'stop' }, usage: {} };
				},
			});
			const ac = new AbortController();
			await models.generate('q', { toolMode: 'auto', signal: ac.signal });
			assert.ok(observedSignal, 'inner backend call must receive a signal');
			assert.notStrictEqual(observedSignal, ac.signal, 'must be a composed wrapper, not the caller signal');
			assert.strictEqual(abortedDuringCall, false, 'signal is not aborted while the call is in flight');
		});

		it('caller-pre-aborted signal: first iteration throws before paying for a backend call', async () => {
			backend.queue(final('unreachable'));
			const ac = new AbortController();
			ac.abort();
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', signal: ac.signal }),
				(err) => err.name === 'AbortError'
			);
			assert.strictEqual(backend.calls.length, 0, 'inner generate must not run when caller pre-aborted');
		});

		it('in-flight handler abort rethrows (does NOT enter recover and append a bogus tool message)', async () => {
			// If recover swallowed AbortError, the loop would push `{error: "aborted"}`
			// into messages and try a SECOND backend round before bailing. Pin the
			// behavior: handler-mid-flight abort → loop throws AbortError after the
			// post-dispatch check; no second backend call; no error envelope in trace.
			backend.queue(toolCallRound('p', [tc('c1', 'slow', {})]), final('unreachable — abort happens during round 1'));
			const ac = new AbortController();
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						includeToolTrace: true,
						signal: ac.signal,
						toolHandlers: {
							slow: async (_args, ctx) => {
								await new Promise((resolve, reject) => {
									ctx.signal.addEventListener('abort', () => {
										const err = new Error('aborted');
										err.name = 'AbortError';
										reject(err);
									});
									setImmediate(() => ac.abort());
								});
							},
						},
					}),
				(err) => err.name === 'AbortError'
			);
			// One backend call only — the second `final(...)` never got reached.
			assert.strictEqual(backend.calls.length, 1, 'no second round after abort');
		});

		it('last-iteration abort → AbortError, NOT BudgetExceededError (misclassification check)', async () => {
			// `maxToolIterations: 1` would otherwise trip BudgetExceededError after one
			// round of tool calls. If we abort mid-handler in that one round, the loop
			// must classify the throw as AbortError (post-dispatch throwIfAborted)
			// rather than treating the loop body as having "exhausted" iterations.
			backend.queue(toolCallRound('p', [tc('c1', 'slow', {})]));
			const ac = new AbortController();
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						maxToolIterations: 1,
						signal: ac.signal,
						toolHandlers: {
							slow: async (_args, ctx) => {
								await new Promise((resolve, reject) => {
									ctx.signal.addEventListener('abort', () => {
										const err = new Error('aborted');
										err.name = 'AbortError';
										reject(err);
									});
									setImmediate(() => ac.abort());
								});
							},
						},
					}),
				(err) => err.name === 'AbortError' && !(err instanceof BudgetExceededError)
			);
		});

		it('loopController.abort fires on exit — sibling handlers still running see the signal', async () => {
			// One round, two parallel tool calls: 'missing' is DECLARED in `tools` but has
			// no handler (a caller config bug → hard ClientError(400) on dispatch), 'slow'
			// is in flight. After the missing-handler throw propagates out, the loop's
			// finally aborts loopController → the slow handler's ctx.signal aborts. (Test by
			// having the slow handler check ctx.signal in a microtask after a small delay; if
			// cleanup didn't fire, the handler would hang.)
			backend.queue(toolCallRound('p', [tc('c1', 'missing', {}), tc('c2', 'slow', {})]));
			let slowSawAbort = false;
			let slowResolver;
			const slowFinished = new Promise((resolve) => {
				slowResolver = resolve;
			});
			await assert.rejects(
				() =>
					models.generate(
						{
							messages: [{ role: 'user', content: 'q' }],
							// Declaring 'missing' makes the absent handler a caller config bug → hard throw.
							tools: [{ name: 'missing', description: '', parameters: {} }],
						},
						{
							toolMode: 'auto',
							toolHandlers: {
								// 'missing' is intentionally absent — declared tool w/o handler throws ClientError(400).
								slow: async (_args, ctx) => {
									await new Promise((resolve) => setImmediate(resolve));
									slowSawAbort = ctx.signal.aborted;
									slowResolver();
									return null;
								},
							},
						}
					),
				(err) => err.statusCode === 400 && /No handler registered for declared tool/.test(err.message)
			);
			// Wait for the slow handler to finish (it has nothing to await on after the abort).
			await slowFinished;
			assert.strictEqual(slowSawAbort, true, 'sibling handler must see signal aborted after loop cleanup');
		});
	});

	describe('trace integrity', () => {
		it("trace's `arguments` is decoupled from in-handler mutation", async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'mutator', { keep: 'as-emitted' })]), final('done'));
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

	describe('missing handler (split policy: declared = config bug, undeclared = hallucination)', () => {
		it('DECLARED tool with no handler throws ClientError(400) — caller config bug', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'configured', {})]));
			await assert.rejects(
				() =>
					models.generate(
						{
							messages: [{ role: 'user', content: 'q' }],
							tools: [{ name: 'configured', description: '', parameters: {} }],
						},
						{ toolMode: 'auto', toolHandlers: {} }
					),
				(err) => err.statusCode === 400 && /No handler registered for declared tool 'configured'/.test(err.message)
			);
		});

		it('UNDECLARED tool name recovers: feeds an "unknown tool" error back and the model continues', async () => {
			// Round 1: model hallucinates a tool that was never declared and has no handler.
			// Round 2: model recovers with a terminal answer. The loop must NOT throw.
			backend.queue(toolCallRound('p', [tc('c1', 'hallucinated', {})]), final('recovered after unknown tool'));
			const result = await models.generate('q', {
				toolMode: 'auto',
				includeToolTrace: true,
				toolHandlers: {},
			});
			assert.strictEqual(result.content, 'recovered after unknown tool');
			assert.strictEqual(result.trace.length, 1);
			assert.match(result.trace[0].error.message, /Unknown tool 'hallucinated'/);
			// The tool message fed back to the model carried the error envelope.
			const toolMsg = backend.calls[1].input.messages.find((m) => m.role === 'tool');
			assert.match(toolMsg.content, /Unknown tool 'hallucinated'/);
		});

		it('UNDECLARED tool under toolErrorMode:"abort" stops the loop with ToolHandlerError', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'hallucinated', {})]));
			await assert.rejects(
				() => models.generate('q', { toolMode: 'auto', toolErrorMode: 'abort', toolHandlers: {} }),
				(err) => err instanceof ToolHandlerError && /Unknown tool 'hallucinated'/.test(err.message)
			);
		});

		it('prototype-member tool name (toString / constructor / __proto__) does NOT dispatch a built-in', async () => {
			// A bare `handlers[name]` lookup would resolve Object.prototype.toString as a
			// "handler" and invoke it. Each must be treated as an undeclared unknown tool.
			for (const evil of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
				clearRegistry();
				backend = new ScriptedBackend();
				setGenerative('default', backend);
				backend.queue(toolCallRound('p', [tc('c1', evil, {})]), final('ok'));
				const result = await models.generate('q', {
					toolMode: 'auto',
					includeToolTrace: true,
					toolHandlers: {},
				});
				assert.strictEqual(result.content, 'ok', `${evil} must not dispatch a built-in`);
				assert.strictEqual(result.trace[0].error.message, `Unknown tool '${evil}': no such tool is available`);
			}
		});

		it('own, NON-callable handler value for a declared tool is treated as missing (hard throw)', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'broken', {})]));
			await assert.rejects(
				() =>
					models.generate(
						{
							messages: [{ role: 'user', content: 'q' }],
							tools: [{ name: 'broken', description: '', parameters: {} }],
						},
						{ toolMode: 'auto', toolHandlers: { broken: 'not a function' } }
					),
				(err) => err.statusCode === 400 && /No handler registered for declared tool 'broken'/.test(err.message)
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

	describe('streaming auto path (generateStream + toolMode: auto)', () => {
		it('terminal first-round stream: yields the inner deltas + final finishReason unchanged', async () => {
			backend.queueStream([{ deltaContent: 'hello ' }, { deltaContent: 'world' }, { finishReason: 'stop' }]);
			const chunks = [];
			for await (const c of models.generateStream('q', { toolMode: 'auto' })) {
				chunks.push(c);
			}
			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0].deltaContent, 'hello ');
			assert.strictEqual(chunks[2].finishReason, 'stop');
		});

		it('multi-round: streams round 1 deltas, suppresses intermediate finishReason=tool_calls, streams round 2 deltas + terminal finishReason', async () => {
			backend.queueStream(
				[
					{ deltaContent: 'thinking' },
					{ deltaToolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }] },
					{ finishReason: 'tool_calls' },
				],
				[{ deltaContent: 'final answer' }, { finishReason: 'stop' }]
			);
			const chunks = [];
			for await (const c of models.generateStream('q', {
				toolMode: 'auto',
				toolHandlers: { echo: (args) => args },
			})) {
				chunks.push(c);
			}
			// No chunk carries 'tool_calls' as a terminal finishReason — only the final 'stop'.
			const finishReasons = chunks.map((c) => c.finishReason).filter(Boolean);
			assert.deepStrictEqual(finishReasons, ['stop']);
			// Deltas from BOTH rounds reached the caller.
			const allContent = chunks.map((c) => c.deltaContent ?? '').join('');
			assert.match(allContent, /thinking/);
			assert.match(allContent, /final answer/);
			// Two inner stream calls — one per iteration.
			assert.strictEqual(backend.streamCalls.length, 2);
		});

		it('assembles deltaToolCalls across multiple chunks (id-keyed, fields merge in arrival order)', async () => {
			backend.queueStream(
				[
					{ deltaToolCalls: [{ id: 'c1', name: 'echo' }] },
					{ deltaToolCalls: [{ id: 'c1', arguments: { partial: 1 } }] },
					{ deltaToolCalls: [{ id: 'c1', arguments: { full: 2 } }] },
					{ finishReason: 'tool_calls' },
				],
				[{ deltaContent: 'done' }, { finishReason: 'stop' }]
			);
			const seenArgs = [];
			for await (const _ of models.generateStream('q', {
				toolMode: 'auto',
				toolHandlers: {
					echo: (args) => {
						seenArgs.push(args);
						return args;
					},
				},
			})) {
				// drain
			}
			assert.strictEqual(seenArgs.length, 1);
			assert.deepStrictEqual(seenArgs[0], { partial: 1, full: 2 });
		});

		it('iteration cap trips on stream too — BudgetExceededError({kind: iterations}) after maxToolIterations rounds', async () => {
			for (let i = 0; i < 4; i++) {
				backend.queueStream([
					{ deltaToolCalls: [{ id: `c${i}`, name: 'echo', arguments: { i } }] },
					{ finishReason: 'tool_calls' },
				]);
			}
			let caught;
			try {
				for await (const _ of models.generateStream('q', {
					toolMode: 'auto',
					maxToolIterations: 3,
					toolHandlers: { echo: (args) => args },
				})) {
					// drain
				}
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.kind, 'iterations');
			assert.strictEqual(caught.partialTrace.length, 3);
		});

		it('caller-pre-aborted signal bails on stream too, before any backend round', async () => {
			backend.queueStream([{ deltaContent: 'unreachable' }, { finishReason: 'stop' }]);
			const ac = new AbortController();
			ac.abort();
			await assert.rejects(
				async () => {
					for await (const _ of models.generateStream('q', {
						toolMode: 'auto',
						signal: ac.signal,
					})) {
						// drain
					}
				},
				(err) => err.name === 'AbortError'
			);
			assert.strictEqual(backend.streamCalls.length, 0);
		});

		it('backend tail-flushes tool calls without finishReason (proxy truncation) → loop dispatches, does NOT drop the calls', async () => {
			// All three in-tree backends (openai, anthropic, bedrock) emit a tail-flush
			// `{deltaToolCalls: ...}` without a `finishReason` when the upstream stream
			// closes mid-message. The loop must treat that as a `tool_calls` round and
			// dispatch — otherwise the backend's careful recovery is undone here.
			backend.queueStream(
				[
					{ deltaContent: 'thinking' },
					// Note: no finishReason chunk at all — backend tail-flushed.
					{ deltaToolCalls: [{ id: 'c1', name: 'recover', arguments: { x: 1 } }] },
				],
				[{ deltaContent: 'recovered' }, { finishReason: 'stop' }]
			);
			const dispatched = [];
			const chunks = [];
			for await (const c of models.generateStream('q', {
				toolMode: 'auto',
				toolHandlers: {
					recover: (args) => {
						dispatched.push(args);
						return { ok: true };
					},
				},
			})) {
				chunks.push(c);
			}
			assert.deepStrictEqual(dispatched, [{ x: 1 }], 'tail-flushed tool call must dispatch');
			// Caller sees deltas from BOTH rounds + a terminal 'stop'.
			const text = chunks.map((c) => c.deltaContent ?? '').join('');
			assert.match(text, /thinking/);
			assert.match(text, /recovered/);
			const finishReasons = chunks.map((c) => c.finishReason).filter(Boolean);
			assert.deepStrictEqual(finishReasons, ['stop']);
		});

		it('backend stream ends with no finishReason AND no tool calls → loop yields synthetic stop', async () => {
			backend.queueStream([{ deltaContent: 'partial' }]);
			const chunks = [];
			for await (const c of models.generateStream('q', { toolMode: 'auto' })) {
				chunks.push(c);
			}
			// Last chunk carries a synthetic terminal `stop` so consumer's for-await sees one.
			const finishReasons = chunks.map((c) => c.finishReason).filter(Boolean);
			assert.deepStrictEqual(finishReasons, ['stop']);
		});

		it('degenerate backend: finishReason=tool_calls with NO assembled calls → loop reclassifies as terminal stop', async () => {
			// Provider misbehavior or upstream truncation can yield "tool_calls" without
			// any tool-call deltas. Without the guard, the loop would suppress the
			// intermediate finishReason chunk AND treat the round as terminal — the
			// consumer's `for-await` would end with zero chunks ever yielded, violating
			// the GenerateChunk contract ("finishReason set on the FINAL chunk").
			backend.queueStream([{ finishReason: 'tool_calls' }]);
			const chunks = [];
			for await (const c of models.generateStream('q', { toolMode: 'auto' })) {
				chunks.push(c);
			}
			assert.strictEqual(chunks.length, 1, 'must yield exactly one terminal chunk');
			assert.strictEqual(chunks[0].finishReason, 'stop');
		});

		it("toolErrorMode: 'abort' on stream surfaces ToolHandlerError with cause + trace", async () => {
			backend.queueStream(
				[{ deltaToolCalls: [{ id: 'c1', name: 'broken', arguments: {} }] }, { finishReason: 'tool_calls' }],
				[{ deltaContent: 'unreachable' }, { finishReason: 'stop' }]
			);
			const handlerErr = new Error('stream boom');
			let caught;
			try {
				for await (const _ of models.generateStream('q', {
					toolMode: 'auto',
					toolErrorMode: 'abort',
					toolHandlers: {
						broken: () => {
							throw handlerErr;
						},
					},
				})) {
					// drain
				}
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof ToolHandlerError);
			assert.strictEqual(caught.cause, handlerErr);
			assert.strictEqual(caught.partialTrace.length, 1);
			assert.strictEqual(caught.partialTrace[0].error.message, 'stream boom');
			// Second round was never consumed.
			assert.strictEqual(backend.streamCalls.length, 1);
		});

		it('streaming recover-mode appends error envelope and continues (default behavior)', async () => {
			backend.queueStream(
				[{ deltaToolCalls: [{ id: 'c1', name: 'broken', arguments: {} }] }, { finishReason: 'tool_calls' }],
				[{ deltaContent: 'recovered' }, { finishReason: 'stop' }]
			);
			const chunks = [];
			for await (const c of models.generateStream('q', {
				toolMode: 'auto',
				toolHandlers: {
					broken: () => {
						throw new Error('boom');
					},
				},
			})) {
				chunks.push(c);
			}
			const text = chunks.map((c) => c.deltaContent ?? '').join('');
			assert.match(text, /recovered/);
			// Second round saw the error envelope as the tool message.
			const round2messages = backend.streamCalls[1].input.messages;
			const toolMsg = round2messages[round2messages.length - 1];
			assert.strictEqual(toolMsg.role, 'tool');
			assert.strictEqual(JSON.parse(toolMsg.content).error, 'boom');
		});

		it('streaming parallel dispatch: multi-id assembly across interleaved deltas', async () => {
			// Realistic OpenAI-style streaming: deltas for two tool calls arrive interleaved,
			// each id built up across multiple chunks. The Map-keyed assembler must reconcile
			// them into two complete calls.
			backend.queueStream(
				[
					{ deltaToolCalls: [{ id: 'c1', name: 'echo' }] },
					{ deltaToolCalls: [{ id: 'c2', name: 'echo' }] },
					{ deltaToolCalls: [{ id: 'c1', arguments: { i: 1 } }] },
					{ deltaToolCalls: [{ id: 'c2', arguments: { i: 2 } }] },
					{ finishReason: 'tool_calls' },
				],
				[{ deltaContent: 'done' }, { finishReason: 'stop' }]
			);
			const dispatched = [];
			for await (const _ of models.generateStream('q', {
				toolMode: 'auto',
				toolHandlers: {
					echo: (args) => {
						dispatched.push(args.i);
						return args;
					},
				},
			})) {
				// drain
			}
			assert.deepStrictEqual(dispatched.sort(), [1, 2]);
		});

		it("maxToolTokens / maxCostUsd throw 501 on stream — usage isn't exposed on GenerateChunk in v1", async () => {
			backend.queueStream([{ finishReason: 'stop' }]);
			await assert.rejects(
				async () => {
					for await (const _ of models.generateStream('q', {
						toolMode: 'auto',
						maxToolTokens: 100,
					})) {
						// drain
					}
				},
				(err) => err.statusCode === 501 && /streamed usage/.test(err.message)
			);
		});
	});

	describe('opts.conversation hook', () => {
		function makeConversationSpy() {
			const turns = [];
			return {
				turns,
				async append(turn) {
					turns.push(turn);
				},
			};
		}

		it('sync path: assistant → tool → assistant turns appended in order (input NOT echoed)', async () => {
			backend.queue(toolCallRound('thinking', [tc('c1', 'echo', { x: 1 })]), final('done'));
			const conversation = makeConversationSpy();
			await models.generate('hello', {
				toolMode: 'auto',
				conversation,
				toolHandlers: { echo: (args) => ({ result: args.x }) },
			});
			// Loop ONLY appends new turns it produced. The caller's `hello` input is
			// theirs to track; re-appending it would corrupt the conversation store.
			assert.deepStrictEqual(
				conversation.turns.map((t) => t.role),
				['assistant', 'tool', 'assistant']
			);
			assert.strictEqual(conversation.turns[0].content, 'thinking');
			assert.ok(conversation.turns[0].toolCalls, 'mid-loop assistant turn carries toolCalls');
			assert.strictEqual(conversation.turns[1].toolCallId, 'c1');
			assert.strictEqual(conversation.turns[2].content, 'done');
			assert.strictEqual(conversation.turns[2].toolCalls, undefined, 'terminal assistant turn omits toolCalls');
		});

		it('streaming path: assistant → tool → assistant turns appended in order (input NOT echoed)', async () => {
			backend.queueStream(
				[
					{ deltaContent: 'thinking' },
					{ deltaToolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }] },
					{ finishReason: 'tool_calls' },
				],
				[{ deltaContent: 'final' }, { finishReason: 'stop' }]
			);
			const conversation = makeConversationSpy();
			for await (const _ of models.generateStream('hello', {
				toolMode: 'auto',
				conversation,
				toolHandlers: { echo: (args) => ({ result: args.x }) },
			})) {
				// drain
			}
			assert.deepStrictEqual(
				conversation.turns.map((t) => t.role),
				['assistant', 'tool', 'assistant']
			);
			assert.strictEqual(conversation.turns[0].content, 'thinking');
			assert.ok(conversation.turns[0].toolCalls);
			assert.strictEqual(conversation.turns[2].content, 'final');
		});

		it('sync path with Message[] input: caller-supplied user turns are NOT echoed to the appender', async () => {
			// Multi-turn history input: caller has already persisted these turns in their
			// store. The loop must not echo them back.
			backend.queue(final('out'));
			const conversation = makeConversationSpy();
			await models.generate(
				[
					{ role: 'system', content: 'sys (ambient — not a turn)' },
					{ role: 'user', content: 'q1' },
					{ role: 'assistant', content: 'a1' },
					{ role: 'user', content: 'q2' },
				],
				{ toolMode: 'auto', conversation }
			);
			// Only the assistant turn produced THIS call lands in the appender.
			assert.deepStrictEqual(
				conversation.turns.map((t) => ({ role: t.role, content: t.content })),
				[{ role: 'assistant', content: 'out' }]
			);
		});

		it('streaming path: empty terminal content does NOT append an empty assistant turn', async () => {
			backend.queueStream([{ finishReason: 'stop' }]);
			const conversation = makeConversationSpy();
			for await (const _ of models.generateStream('hello', {
				toolMode: 'auto',
				conversation,
			})) {
				// drain
			}
			// No assistant turn for the empty terminal; loop never echoes input either.
			assert.deepStrictEqual(conversation.turns, []);
		});

		it('sync path: BudgetExceededError still fires; conversation has NOT had any turn appended pre-trip', async () => {
			backend.queue({
				output: { content: 'over', finishReason: 'stop' },
				usage: { promptTokens: 200, completionTokens: 0 },
			});
			const conversation = makeConversationSpy();
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						maxToolTokens: 100,
						conversation,
					}),
				(err) => err instanceof BudgetExceededError
			);
			// Budget tripped before the terminal assistant append — zero turns total.
			assert.deepStrictEqual(conversation.turns, []);
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
	});

	describe('token + cost budgets', () => {
		afterEach(() => {
			_resetComputeCallCostUsdForTests();
		});

		// The default ScriptedBackend usage helpers set tokens to 1+1 per round; for these
		// tests we override per-call so the budget arithmetic is predictable.
		function tokenRound(content, tokens = { promptTokens: 50, completionTokens: 50 }) {
			return { output: { content, finishReason: 'stop' }, usage: tokens };
		}
		function tokenToolRound(content, toolCalls, tokens = { promptTokens: 50, completionTokens: 50 }) {
			return {
				output: { content, finishReason: 'tool_calls', toolCalls },
				usage: tokens,
			};
		}

		it("maxToolTokens trips BudgetExceededError({kind: 'tokens'}) when cumulative tokens exceed the cap", async () => {
			// Round 1: 60 tokens. Round 2: 60 tokens. Total: 120 > cap of 100.
			backend.queue(
				tokenToolRound('p1', [tc('c1', 'echo', { i: 1 })], { promptTokens: 30, completionTokens: 30 }),
				tokenRound('done', { promptTokens: 30, completionTokens: 30 })
			);
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					maxToolTokens: 100,
					toolHandlers: { echo: (args) => args },
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError, 'expected BudgetExceededError');
			assert.strictEqual(caught.kind, 'tokens');
			assert.strictEqual(caught.statusCode, 429);
			assert.match(caught.message, /maxToolTokens=100/);
			// Trace records round 1's tool call before the budget tripped on round 2's generate.
			assert.strictEqual(caught.partialTrace.length, 1);
			assert.strictEqual(caught.partialTrace[0].iteration, 1);
		});

		it('first-round usage that exceeds the cap still trips — caps the round we PAID for, not the next one', async () => {
			// One round, 150 tokens, cap 100. Trips immediately.
			backend.queue(tokenRound('over', { promptTokens: 75, completionTokens: 75 }));
			let caught;
			try {
				await models.generate('q', { toolMode: 'auto', maxToolTokens: 100 });
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.kind, 'tokens');
		});

		it('maxToolTokens unset → unlimited (no trip even with huge usage)', async () => {
			backend.queue(tokenRound('over', { promptTokens: 1_000_000, completionTokens: 1_000_000 }));
			const result = await models.generate('q', { toolMode: 'auto' });
			assert.strictEqual(result.content, 'over');
		});

		it("maxCostUsd trips BudgetExceededError({kind: 'cost'}) when an injected cost function exceeds the cap", async () => {
			// Inject a $0.01-per-call cost so two rounds = $0.02, capped at $0.015.
			_setComputeCallCostUsdForTests(() => 0.01);
			backend.queue(tokenToolRound('p', [tc('c1', 'echo', { i: 1 })]), tokenRound('done'));
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					maxCostUsd: 0.015,
					toolHandlers: { echo: (args) => args },
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.kind, 'cost');
			assert.match(caught.message, /maxCostUsd=0.015/);
		});

		it('maxCostUsd does NOT trip with the v1 stub (computeCallCostUsd returns 0)', async () => {
			// Default stub: cost = 0 per call, so any cap is unreachable today. Proves
			// the v1 contract: cap is wired but doesn't fire in production until a
			// real rate card lands.
			backend.queue(tokenRound('done'));
			const result = await models.generate('q', { toolMode: 'auto', maxCostUsd: 0.0001 });
			assert.strictEqual(result.content, 'done');
		});

		it('cost function receives the usage object and model name', async () => {
			const observations = [];
			_setComputeCallCostUsdForTests((usage, model) => {
				observations.push({ usage, model });
				return 0;
			});
			backend.queue(tokenRound('done', { promptTokens: 5, completionTokens: 3 }));
			// Use the default-registered backend; the model name passed in opts is what
			// flows to computeCallCostUsd, independent of how the backend resolves.
			await models.generate('q', { toolMode: 'auto' });
			assert.strictEqual(observations.length, 1);
			assert.strictEqual(observations[0].usage.promptTokens, 5);
			assert.strictEqual(observations[0].usage.completionTokens, 3);
			// `opts.model` was undefined here; the cost function sees that.
			assert.strictEqual(observations[0].model, undefined);
		});

		it('caller abort during the in-flight backend round preempts the budget tally', async () => {
			// Round 1's usage would push us over a 100-token cap. But the caller aborts
			// mid-call, so the inner generate rejects with AbortError BEFORE we tally —
			// caller sees AbortError, not BudgetExceededError. Locks the ordering in
			// `runAgentLoop` so commit 5's streaming wiring can't accidentally invert it.
			let ac;
			setGenerative('default', {
				name: 'aborting-backend',
				capabilities: () => ({ embed: false, generate: true, stream: false, tools: true, adapters: false }),
				async generate(_input, opts) {
					// Abort mid-call. opts.signal is the composed loop signal — firing the
					// caller signal propagates to it.
					ac.abort();
					opts.signal.throwIfAborted();
					// Unreachable, but keeps the type tidy.
					return {
						status: 'completed',
						output: { content: 'unreachable', finishReason: 'stop' },
						usage: { promptTokens: 200, completionTokens: 200 },
					};
				},
			});
			ac = new AbortController();
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						maxToolTokens: 100,
						signal: ac.signal,
					}),
				(err) => err.name === 'AbortError' && !(err instanceof BudgetExceededError)
			);
		});

		it('partial trace on token budget trip is independent of includeToolTrace', async () => {
			// includeToolTrace: false (default). On budget trip, partialTrace is still populated.
			backend.queue(
				tokenToolRound('p', [tc('c1', 'echo', { i: 1 })], { promptTokens: 60, completionTokens: 0 }),
				tokenRound('done', { promptTokens: 60, completionTokens: 0 })
			);
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					maxToolTokens: 100,
					toolHandlers: { echo: (args) => args },
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof BudgetExceededError);
			assert.strictEqual(caught.partialTrace.length, 1, 'partial trace populated regardless of includeToolTrace');
		});
	});

	describe("toolErrorMode: 'abort'", () => {
		it('handler throw surfaces as ToolHandlerError carrying the cause + trace (recover NOT applied)', async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'broken', {})]), final('unreachable — abort halts the loop'));
			const handlerErr = new Error('boom');
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					toolErrorMode: 'abort',
					toolHandlers: {
						broken: () => {
							throw handlerErr;
						},
					},
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof ToolHandlerError);
			assert.strictEqual(caught.toolName, 'broken');
			assert.strictEqual(caught.toolCallId, 'c1');
			assert.strictEqual(caught.cause, handlerErr, 'cause is the original throw, not a copy');
			// Trace includes the failing entry so the caller sees the call that triggered abort.
			assert.strictEqual(caught.partialTrace.length, 1);
			assert.strictEqual(caught.partialTrace[0].error.message, 'boom');
			// Loop halted — the second round's `final` was never consumed.
			assert.strictEqual(backend.calls.length, 1);
		});

		it("ToolHandlerError statusCode mirrors a thrown ClientError's status (e.g. 400)", async () => {
			const { ClientError } = require('#src/utility/errors/hdbError');
			backend.queue(toolCallRound('p', [tc('c1', 'forbidden', {})]));
			await assert.rejects(
				() =>
					models.generate('q', {
						toolMode: 'auto',
						toolErrorMode: 'abort',
						toolHandlers: {
							forbidden: () => {
								throw new ClientError('nope', 403);
							},
						},
					}),
				(err) => err instanceof ToolHandlerError && err.statusCode === 403
			);
		});

		it('parallel: successful sibling entries are recorded in trace BEFORE the abort throw', async () => {
			backend.queue(
				toolCallRound('p', [tc('c1', 'ok', { i: 1 }), tc('c2', 'broken', { i: 2 }), tc('c3', 'ok', { i: 3 })])
			);
			let caught;
			try {
				await models.generate('q', {
					toolMode: 'auto',
					toolErrorMode: 'abort',
					toolHandlers: {
						ok: async (args) => ({ value: args.i }),
						broken: () => {
							throw new Error('boom');
						},
					},
				});
			} catch (err) {
				caught = err;
			}
			assert.ok(caught instanceof ToolHandlerError);
			// All three entries land on the trace — the successful ones AND the failed one.
			assert.strictEqual(caught.partialTrace.length, 3);
			assert.strictEqual(caught.partialTrace.find((e) => e.toolCallId === 'c2').error.message, 'boom');
			assert.ok(caught.partialTrace.find((e) => e.toolCallId === 'c1').result);
			assert.ok(caught.partialTrace.find((e) => e.toolCallId === 'c3').result);
		});

		it("default toolErrorMode is 'recover' (unchanged behavior)", async () => {
			backend.queue(toolCallRound('p', [tc('c1', 'broken', {})]), final('recovered'));
			const result = await models.generate('q', {
				toolMode: 'auto',
				toolHandlers: {
					broken: () => {
						throw new Error('boom');
					},
				},
			});
			assert.strictEqual(result.content, 'recovered');
		});
	});

	describe('resilience hardening (no silent failures, consistent side-effects)', () => {
		function makeConversationSpy() {
			const turns = [];
			return {
				turns,
				async append(turn) {
					turns.push(turn);
				},
			};
		}

		// Spy on logger.warn for the warn-once assertions, restoring the original after.
		let warnings;
		let origWarn;
		beforeEach(() => {
			warnings = [];
			origWarn = logger.warn;
			logger.warn = (...args) => warnings.push(args.join(' '));
		});
		afterEach(() => {
			logger.warn = origWarn;
		});

		describe('budget warn-once when backend reports no usage', () => {
			it('maxToolTokens set but no usage → warns once, does NOT trip, loop completes', async () => {
				// Two tool rounds + terminal, all with usage: undefined.
				backend.queue(
					{ output: { content: 'r1', finishReason: 'tool_calls', toolCalls: [tc('c1', 'echo', { i: 1 })] } },
					{ output: { content: 'r2', finishReason: 'tool_calls', toolCalls: [tc('c2', 'echo', { i: 2 })] } },
					{ output: { content: 'final', finishReason: 'stop' } }
				);
				const result = await models.generate('q', {
					toolMode: 'auto',
					maxToolTokens: 1, // would trip instantly IF usage were measurable
					toolHandlers: { echo: (a) => a },
				});
				assert.strictEqual(result.content, 'final', 'unmeasurable budget must not falsely trip');
				const budgetWarns = warnings.filter((w) => /budget is unenforceable/.test(w));
				assert.strictEqual(budgetWarns.length, 1, 'warns exactly once across the run, not per-round');
			});

			it('maxToolTokens still trips normally when the backend DOES report usage', async () => {
				backend.queue(toolCallRound('r1', [tc('c1', 'echo', { i: 1 })]), final('unreached'));
				await assert.rejects(
					() => models.generate('q', { toolMode: 'auto', maxToolTokens: 1, toolHandlers: { echo: (a) => a } }),
					(err) => err instanceof BudgetExceededError && err.kind === 'tokens'
				);
				assert.strictEqual(warnings.filter((w) => /budget is unenforceable/.test(w)).length, 0);
			});
		});

		describe('abort-mode does not persist tool turns the model never consumed', () => {
			it('sync: toolErrorMode:"abort" throws BEFORE the failed tool turn reaches the conversation sink', async () => {
				backend.queue(toolCallRound('thinking', [tc('c1', 'boom', {})]));
				const conversation = makeConversationSpy();
				await assert.rejects(
					() =>
						models.generate('q', {
							toolMode: 'auto',
							toolErrorMode: 'abort',
							conversation,
							toolHandlers: {
								boom: () => {
									throw new Error('handler failed');
								},
							},
						}),
					(err) => err instanceof ToolHandlerError
				);
				// The assistant tool-call turn is legitimately persisted (the model DID emit it),
				// but the recover-style tool-error turn must NOT be — abort returns the error.
				assert.deepStrictEqual(
					conversation.turns.map((t) => t.role),
					['assistant'],
					'no tool-role turn should be appended on the abort path'
				);
			});

			it('recover mode (default) DOES persist the tool-error turn so the model can react', async () => {
				backend.queue(toolCallRound('thinking', [tc('c1', 'boom', {})]), final('handled'));
				const conversation = makeConversationSpy();
				await models.generate('q', {
					toolMode: 'auto',
					conversation,
					toolHandlers: {
						boom: () => {
							throw new Error('handler failed');
						},
					},
				});
				assert.deepStrictEqual(
					conversation.turns.map((t) => t.role),
					['assistant', 'tool', 'assistant']
				);
			});
		});

		describe('streaming: terminal turn persisted before the terminal chunk is delivered', () => {
			it('conversation has the final assistant turn even if the consumer breaks on the finish chunk', async () => {
				backend.queueStream([{ deltaContent: 'the answer' }, { finishReason: 'stop' }]);
				const conversation = makeConversationSpy();
				for await (const chunk of models.generateStream('q', { toolMode: 'auto', conversation })) {
					if (chunk.finishReason) break; // stop the instant the terminal chunk arrives
				}
				assert.deepStrictEqual(
					conversation.turns.map((t) => t.role),
					['assistant'],
					'terminal assistant turn must be persisted before the finish chunk is yielded'
				);
				assert.strictEqual(conversation.turns[0].content, 'the answer');
			});

			it('the terminal finishReason is delivered on its own final chunk (never co-located with content)', async () => {
				backend.queueStream([{ deltaContent: 'hi', finishReason: 'stop' }]);
				const chunks = [];
				for await (const c of models.generateStream('q', { toolMode: 'auto' })) {
					chunks.push(c);
				}
				// Content delta and the terminal finishReason arrive as separate chunks.
				assert.strictEqual(chunks.at(-1).finishReason, 'stop');
				assert.strictEqual(chunks.at(-1).deltaContent, undefined);
				assert.strictEqual(chunks.map((c) => c.deltaContent ?? '').join(''), 'hi');
				assert.strictEqual(chunks.filter((c) => c.finishReason).length, 1, 'exactly one terminal chunk');
			});
		});

		describe('streaming: incomplete assembled tool call is surfaced, not silently dropped', () => {
			it('a tool-call delta that never delivers a name is recorded in the trace as IncompleteToolCall', async () => {
				// id arrives but the name fragment never does (truncated stream); the round
				// has no other content/calls, so the loop terminates — but must surface the drop.
				backend.queueStream([
					{ deltaToolCalls: [{ id: 'c1', arguments: { partial: true } }] },
					{ finishReason: 'stop' },
				]);
				const chunks = [];
				for await (const c of models.generateStream('q', { toolMode: 'auto', includeToolTrace: true })) {
					chunks.push(c);
				}
				assert.strictEqual(warnings.filter((w) => /dropping incomplete streamed tool call/.test(w)).length, 1);
				// generateStream doesn't return a trace object to the caller, but the warn is the
				// observable signal; assert the loop still terminated cleanly with a stop.
				assert.strictEqual(chunks.at(-1).finishReason, 'stop');
			});
		});

		describe('sync: degenerate tool_calls round (no dispatchable calls) is coerced to a terminal stop', () => {
			it('finishReason tool_calls + empty toolCalls returns finishReason stop with coerced content (matches streaming)', async () => {
				// OpenAI can emit finishReason: 'tool_calls' with the calls dropped if their args
				// were malformed (parseToolCalls discards them). The streaming path already folds
				// this to 'stop'; the sync path must too — an auto-mode caller should never see a
				// tool_calls finishReason (calls are resolved internally) pointing at no calls.
				backend.queue({ output: { content: null, finishReason: 'tool_calls', toolCalls: [] }, usage: {} });
				const result = await models.generate('q', { toolMode: 'auto', includeToolTrace: true });
				assert.strictEqual(result.finishReason, 'stop');
				assert.strictEqual(result.content, '', 'null content coerced to empty string');
				assert.deepStrictEqual(result.trace, [], 'no tools ran');
			});
		});
	});
});
