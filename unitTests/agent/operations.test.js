'use strict';

const assert = require('node:assert');
const { buildOperations } = require('#src/agent/operations');

describe('agent/operations set_agent_config', () => {
	function setAgentConfig() {
		const patches = [];
		const deps = {
			getConfig: () => ({}),
			setConfig: (patch) => {
				patches.push(patch);
				return patch;
			},
			startRun: () => true,
			cancelRun: () => false,
			admitRun: () => 0,
			isRunInFlight: () => false,
		};
		const operation = buildOperations(deps).find((op) => op.name === 'set_agent_config');
		return { execute: operation.execute, patches };
	}

	it('rejects an httpFetch patch, applying nothing from the request', async () => {
		const { execute, patches } = setAgentConfig();
		for (const httpFetch of [true, false, { allow: ['example.com'] }]) {
			await assert.rejects(execute({ operation: 'set_agent_config', httpFetch, maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /fixed at startup/);
				return true;
			});
		}
		assert.deepStrictEqual(patches, []);
	});

	it('rejects a componentsScope or configScope patch, applying nothing from the request', async () => {
		const { execute, patches } = setAgentConfig();
		for (const key of ['componentsScope', 'configScope']) {
			await assert.rejects(execute({ operation: 'set_agent_config', [key]: '.', maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.ok(err.message.startsWith(`agent.${key} is fixed at startup`), err.message);
				return true;
			});
		}
		assert.deepStrictEqual(patches, []);
	});

	it('still applies the runtime-tunable keys', async () => {
		const { execute, patches } = setAgentConfig();
		await execute({ operation: 'set_agent_config', maxTurns: 3, allowDestructive: true, maxTokens: 32000 });
		assert.deepStrictEqual(patches, [{ maxTurns: 3, allowDestructive: true, maxTokens: 32000 }]);
	});

	it('rejects a maxTokens that is not a positive integer, applying nothing from the request', async () => {
		const { execute, patches } = setAgentConfig();
		for (const maxTokens of [0, -1, 1.5, '8192', null, Number.NaN]) {
			await assert.rejects(execute({ operation: 'set_agent_config', maxTokens, maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /maxTokens/);
				return true;
			});
		}
		assert.deepStrictEqual(patches, []);
	});

	it('applies maxToolResultBytes within 1024..1048576 and rejects anything else with a 400', async () => {
		const { execute, patches } = setAgentConfig();
		await execute({ operation: 'set_agent_config', maxToolResultBytes: 1024 });
		await execute({ operation: 'set_agent_config', maxToolResultBytes: 1_048_576 });
		for (const maxToolResultBytes of [0, 1023, 1_048_577, 65536.5, '65536', null]) {
			await assert.rejects(execute({ operation: 'set_agent_config', maxToolResultBytes, maxTurns: 3 }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /maxToolResultBytes must be an integer from 1024 to 1048576/);
				return true;
			});
		}
		assert.deepStrictEqual(patches, [{ maxToolResultBytes: 1024 }, { maxToolResultBytes: 1_048_576 }]);
	});
});

describe('agent/operations budgets (#3040)', () => {
	const session = require('#src/agent/session');

	function operation(name, deps = {}) {
		const patches = [];
		const all = buildOperations({
			getConfig: () => ({}),
			setConfig: (patch) => {
				patches.push(patch);
				return patch;
			},
			startRun: () => true,
			cancelRun: () => false,
			admitRun: () => 0,
			isRunInFlight: () => false,
			...deps,
		});
		return { execute: all.find((op) => op.name === name).execute, patches };
	}

	it('set_agent_config applies maxSessionTokens and maxCostUsd, and null clears a cap', async () => {
		const { execute, patches } = operation('set_agent_config');
		await execute({ operation: 'set_agent_config', maxSessionTokens: 200000, maxCostUsd: '1.5' });
		await execute({ operation: 'set_agent_config', maxCostUsd: null });
		assert.deepStrictEqual(patches, [{ maxSessionTokens: 200000, maxCostUsd: 1.5 }, { maxCostUsd: undefined }]);
	});

	it('set_agent_config rejects a maxTurns that is not a positive integer, applying nothing', async () => {
		const { execute, patches } = operation('set_agent_config');
		for (const maxTurns of [null, 0, -1, 2.5, 'many', '']) {
			await assert.rejects(execute({ operation: 'set_agent_config', maxTurns, autoApprove: true }), (err) => {
				assert.strictEqual(err.statusCode, 400);
				assert.match(err.message, /agent\.maxTurns must be a positive integer/);
				return true;
			});
		}
		await execute({ operation: 'set_agent_config', maxTurns: '20' });
		assert.deepStrictEqual(patches, [{ maxTurns: 20 }]);
	});

	it('set_agent_config rejects a malformed cap and applies nothing from that request', async () => {
		const { execute, patches } = operation('set_agent_config');
		await assert.rejects(execute({ operation: 'set_agent_config', maxTurns: 3, maxSessionTokens: -5 }), (err) => {
			assert.strictEqual(err.statusCode, 400);
			assert.match(err.message, /agent\.maxSessionTokens must be a positive integer/);
			return true;
		});
		assert.deepStrictEqual(patches, []);
	});

	describe('session reads carry folded usage', () => {
		let store;
		beforeEach(() => {
			store = new Map();
			// Rows expose fields only as accessors, like a stored record, so a spread would copy nothing.
			const asRecord = (row) => {
				const record = {};
				for (const [key, value] of Object.entries(structuredClone(row))) {
					Object.defineProperty(record, key, { get: () => value, enumerable: false });
				}
				return record;
			};
			session._setTableForTests({
				async put(row) {
					store.set(row.session_id, structuredClone(row));
				},
				primaryStore: {
					async get(key) {
						return store.has(key) ? structuredClone(store.get(key)) : undefined;
					},
				},
				async *search() {
					for (const row of store.values()) yield asRecord(row);
				},
			});
		});
		afterEach(() => session._setTableForTests(undefined));

		async function seed() {
			const created = await session.createSession({ user: 'admin' });
			await session.appendMessage(created.session_id, { role: 'user', content: 'hi', createdAt: 1 });
			await session.appendMessage(created.session_id, {
				role: 'assistant',
				content: 'ok',
				createdAt: 2,
				usage: { promptTokens: 7, completionTokens: 3, costUsd: 0.001 },
			});
			return created.session_id;
		}

		it('cancel_agent_run answers and closes every open approval in the write that marks the session aborted', async () => {
			const created = await session.createSession({ user: 'admin' });
			await session.appendMessage(created.session_id, {
				role: 'assistant',
				content: '',
				createdAt: 1,
				toolCalls: [
					{ id: 'c1', name: 'drop', arguments: {} },
					{ id: 'c2', name: 'drop', arguments: {} },
				],
			});
			const first = await session.addPendingApproval(created.session_id, {
				toolName: 'drop',
				arguments: {},
				toolCallId: 'c1',
				reason: 'destructive',
			});
			await session.addPendingApproval(created.session_id, {
				toolName: 'drop',
				arguments: {},
				toolCallId: 'c2',
				reason: 'destructive',
			});
			await session.resolveApproval(created.session_id, first.id, true);
			await session.setStatus(created.session_id, 'awaiting_approval');

			const result = await operation('cancel_agent_run').execute({ session_id: created.session_id });
			assert.deepStrictEqual(result, { cancelled: true, signalledLiveRun: false });
			const cancelled = await session.getSession(created.session_id);
			assert.strictEqual(cancelled.status, 'aborted');
			assert.ok(cancelled.pendingApprovals.every((a) => a.resolved && a.consumed));
			const responses = cancelled.messages.filter((m) => m.role === 'tool');
			assert.deepStrictEqual(responses.map((m) => m.toolCallId).sort(), ['c1', 'c2']);
			assert.ok(responses.every((m) => JSON.parse(m.content).error === 'cancelled_by_operator'));
		});

		it('agent_prompt refuses a session whose cancelled run is still finishing, appending nothing', async () => {
			const created = await session.createSession({ user: 'admin' });
			await session.cancelSession(created.session_id);
			const started = [];
			const { execute } = operation('agent_prompt', {
				getConfig: () => ({ enabled: true }),
				startRun: (id) => started.push(id) > 0,
				isRunInFlight: () => true,
			});
			await assert.rejects(execute({ session_id: created.session_id, message: 'again' }), (err) => {
				assert.strictEqual(err.statusCode, 409);
				assert.match(err.message, /still has a run finishing/);
				assert.strictEqual(err.code, 'AGENT_RUN_FINISHING');
				assert.strictEqual(err.retryable, true);
				return true;
			});
			assert.deepStrictEqual(started, []);
			assert.strictEqual((await session.getSession(created.session_id)).messages.length, 0);
		});

		it('agent_prompt and approve_agent_action start the run with the token taken before their first await', async () => {
			let cancels = 0;
			const starts = [];
			const deps = {
				getConfig: () => ({ enabled: true }),
				startRun: (id, admitted) => starts.push(admitted) > 0,
				admitRun: () => cancels,
				isRunInFlight: () => false,
			};
			const created = await session.createSession({ user: 'admin' });
			const table = session.getAgentSessionTable();
			const put = table.put.bind(table);
			table.put = async (row) => {
				cancels++;
				return put(row);
			};
			await operation('agent_prompt', deps).execute({ session_id: created.session_id, message: 'again' });
			assert.deepStrictEqual(starts, [0], 'a cancel during the append fences out the run');

			const approval = await session.addPendingApproval(created.session_id, {
				toolName: 'drop',
				arguments: {},
				toolCallId: 'c1',
				reason: 'destructive',
			});
			cancels = 0;
			starts.length = 0;
			await operation('approve_agent_action', deps).execute({
				session_id: created.session_id,
				approval_id: approval.id,
			});
			assert.deepStrictEqual(starts, [0], 'a cancel during the resolve fences out the run');
		});

		it('agent_prompt answers 409 when a cancel fenced out the run it would start', async () => {
			const created = await session.createSession({ user: 'admin' });
			const { execute } = operation('agent_prompt', {
				getConfig: () => ({ enabled: true }),
				startRun: () => false,
				admitRun: () => 0,
				isRunInFlight: () => false,
			});
			await assert.rejects(execute({ session_id: created.session_id, message: 'again' }), (err) => {
				assert.strictEqual(err.statusCode, 409);
				assert.match(err.message, /recorded but not run/);
				assert.strictEqual(err.code, 'AGENT_PROMPT_NOT_RUN');
				assert.strictEqual(err.retryable, false, 'the prompt was saved, so sending it again would duplicate it');
				return true;
			});
		});

		it('agent_prompt records nothing when a cancel arrives before the prompt is saved', async () => {
			const created = await session.createSession({ user: 'admin' });
			let reads = 0;
			const started = [];
			const { execute } = operation('agent_prompt', {
				getConfig: () => ({ enabled: true }),
				startRun: (id) => started.push(id) > 0,
				admitRun: () => (reads++ === 0 ? 0 : 1),
				isRunInFlight: () => false,
			});
			await assert.rejects(execute({ session_id: created.session_id, message: 'again' }), (err) => {
				assert.strictEqual(err.statusCode, 409);
				assert.match(err.message, /arrived while this prompt was being accepted$/);
				assert.strictEqual(err.code, 'AGENT_PROMPT_CANCELLED');
				assert.strictEqual(err.retryable, true);
				return true;
			});
			assert.deepStrictEqual(started, []);
			assert.strictEqual((await session.getSession(created.session_id)).messages.length, 0);
		});

		it('get_agent_session returns the row plus its usage', async () => {
			const sessionId = await seed();
			const result = await operation('get_agent_session').execute({ session_id: sessionId });
			assert.strictEqual(result.session_id, sessionId);
			assert.strictEqual(result.messages.length, 2);
			assert.deepStrictEqual(result.usage, { calls: 1, promptTokens: 7, completionTokens: 3, costUsd: 0.001 });
			assert.strictEqual(result.runInFlight, false);
		});

		it('session reads say whether a run, even a cancelled one, is still in flight', async () => {
			const sessionId = await seed();
			await session.cancelSession(sessionId);
			const inFlight = { isRunInFlight: (id) => id === sessionId };
			const read = await operation('get_agent_session', inFlight).execute({ session_id: sessionId });
			assert.strictEqual(read.status, 'aborted');
			assert.strictEqual(read.runInFlight, true);
			const { sessions } = await operation('list_agent_sessions', inFlight).execute({});
			assert.strictEqual(sessions[0].runInFlight, true);
		});

		it('agent_prompt marks a busy session retryable, since nothing was recorded', async () => {
			const sessionId = await seed();
			await session.setStatus(sessionId, 'running');
			const { execute } = operation('agent_prompt', { getConfig: () => ({ enabled: true }) });
			await assert.rejects(execute({ session_id: sessionId, message: 'again' }), (err) => {
				assert.strictEqual(err.statusCode, 409);
				assert.strictEqual(err.code, 'AGENT_SESSION_BUSY');
				assert.strictEqual(err.retryable, true);
				return true;
			});
			assert.strictEqual((await session.getSession(sessionId)).messages.length, 2);
		});

		it('list_agent_sessions returns each row with usage, even when the row exposes fields as accessors', async () => {
			const sessionId = await seed();
			const { sessions } = await operation('list_agent_sessions').execute({});
			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].session_id, sessionId);
			assert.strictEqual(sessions[0].status, 'idle');
			assert.deepStrictEqual(sessions[0].usage, { calls: 1, promptTokens: 7, completionTokens: 3, costUsd: 0.001 });
		});
	});
});
