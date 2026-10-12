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
			startRun: () => {},
			cancelRun: () => false,
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
		await execute({ operation: 'set_agent_config', maxTurns: 3, allowDestructive: true });
		assert.deepStrictEqual(patches, [{ maxTurns: 3, allowDestructive: true }]);
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
			startRun: () => {},
			cancelRun: () => false,
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

		it('get_agent_session returns the row plus its usage', async () => {
			const sessionId = await seed();
			const result = await operation('get_agent_session').execute({ session_id: sessionId });
			assert.strictEqual(result.session_id, sessionId);
			assert.strictEqual(result.messages.length, 2);
			assert.deepStrictEqual(result.usage, { calls: 1, promptTokens: 7, completionTokens: 3, costUsd: 0.001 });
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
