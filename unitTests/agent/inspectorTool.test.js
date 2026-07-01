'use strict';

/**
 * Unit tests for the agent's V8 inspector (CDP) tools (#626).
 *
 * Two layers:
 *   1. The safety envelope (`resolvePort`, exercised through the tool handlers) —
 *      pure, no network. This is the security-relevant part: debug must be
 *      enabled, a starting port configured, and workerIndex in range and NOT the
 *      main thread (< 0, which would deadlock the agent's own thread).
 *   2. A live CDP round-trip: open a real inspector on an ephemeral port and drive
 *      inspector_evaluate + inspector_profile_cpu against it. This process stands
 *      in for a worker (same protocol); we never breakpoint it (that would pause
 *      the test — exactly the reason main-thread attach is banned).
 */

const assert = require('node:assert/strict');
const inspector = require('node:inspector');
const { buildInspectorTools, summarizeProfile, _closeInspectorSessions } = require('#src/agent/tools/inspectorTool');

function toolMap(deps) {
	return new Map(buildInspectorTools(deps).map((t) => [t.def.name, t]));
}

const ctx = { sessionId: 's1' };

describe('agent/inspectorTool — safety envelope', () => {
	afterEach(() => _closeInspectorSessions());

	const baseDeps = { debugEnabled: true, startingPort: 9230, host: '127.0.0.1', getWorkerCount: () => 4 };

	it('rejects attach when threads_debug is disabled', async () => {
		const tools = toolMap({ ...baseDeps, debugEnabled: false });
		await assert.rejects(
			() => tools.get('inspector_attach').handler({ workerIndex: 0 }, ctx),
			/threads_debug is not enabled/
		);
	});

	it('rejects attach when no starting port is configured', async () => {
		const tools = toolMap({ ...baseDeps, startingPort: undefined });
		await assert.rejects(
			() => tools.get('inspector_attach').handler({ workerIndex: 0 }, ctx),
			/threads_debug_startingPort is not configured/
		);
	});

	it('refuses the main thread (workerIndex < 0) — never self-attach', async () => {
		const tools = toolMap(baseDeps);
		await assert.rejects(
			() => tools.get('inspector_attach').handler({ workerIndex: -1 }, ctx),
			/cannot attach to the main thread/
		);
	});

	it('rejects a workerIndex past the live worker count', async () => {
		const tools = toolMap({ ...baseDeps, getWorkerCount: () => 2 });
		await assert.rejects(
			() => tools.get('inspector_evaluate').handler({ workerIndex: 5, expression: '1' }, ctx),
			/no worker at index 5/
		);
	});

	it('marks evaluate and set_breakpoint destructive, others not', () => {
		const tools = toolMap(baseDeps);
		assert.equal(tools.get('inspector_evaluate').destructive, true);
		assert.equal(tools.get('inspector_set_breakpoint').destructive, true);
		assert.ok(!tools.get('inspector_attach').destructive);
		assert.ok(!tools.get('inspector_set_logpoint').destructive);
		assert.ok(!tools.get('inspector_profile_cpu').destructive);
	});
});

describe('agent/inspectorTool — summarizeProfile', () => {
	it('ranks functions by self time and caps to topN', () => {
		const profile = {
			nodes: [
				{ id: 1, callFrame: { functionName: 'hot', url: 'file:///a.js', lineNumber: 10 } },
				{ id: 2, callFrame: { functionName: 'cool', url: 'file:///b.js', lineNumber: 20 } },
			],
			samples: [1, 1, 2, 1],
			timeDeltas: [1000, 1000, 1000, 1000], // microseconds
		};
		const out = summarizeProfile(profile, 1);
		assert.equal(out.sampleCount, 4);
		assert.equal(out.totalMs, 4);
		assert.equal(out.topFunctions.length, 1);
		assert.equal(out.topFunctions[0].function, 'hot'); // 3 samples * 1ms = 3ms self, beats cool's 1ms
		assert.equal(out.topFunctions[0].selfMs, 3);
	});
});

describe('agent/inspectorTool — live CDP round-trip', () => {
	let port;
	before(() => {
		// Open a real inspector on an ephemeral port; parse the port back from the ws URL.
		inspector.open(0, '127.0.0.1', false);
		port = Number(new URL(inspector.url()).port);
	});
	after(() => {
		_closeInspectorSessions();
		try {
			inspector.close();
		} catch {
			/* already closed */
		}
	});

	// startingPort + workerIndex(0) === this process's inspector port; getWorkerCount 1 keeps it in range.
	const deps = () => ({ debugEnabled: true, startingPort: port, host: '127.0.0.1', getWorkerCount: () => 1 });

	it('attaches and evaluates an expression in the target', async () => {
		const tools = toolMap(deps());
		const attached = await tools.get('inspector_attach').handler({ workerIndex: 0 }, ctx);
		assert.equal(attached.attached, true);
		assert.equal(attached.port, port);

		const res = await tools.get('inspector_evaluate').handler({ workerIndex: 0, expression: '40 + 2' }, ctx);
		assert.equal(res.value, 42);
	});

	it('surfaces an evaluation exception as a thrown error', async () => {
		const tools = toolMap(deps());
		await assert.rejects(
			() => tools.get('inspector_evaluate').handler({ workerIndex: 0, expression: 'throw new Error("boom")' }, ctx),
			/boom/
		);
	});

	it('records a CPU profile and returns hot functions', async () => {
		const tools = toolMap(deps());
		const out = await tools.get('inspector_profile_cpu').handler({ workerIndex: 0, durationMs: 150 }, ctx);
		assert.ok(Array.isArray(out.topFunctions));
		assert.equal(typeof out.totalMs, 'number');
	});
});
