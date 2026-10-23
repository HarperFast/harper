'use strict';

const assert = require('node:assert');
const { awaitRollout, summarizeRollout, ROLLOUT_WAIT_PER_NODE_MS } = require('#src/bin/deployRollout');

const ID = '22222222-2222-2222-2222-222222222222';
const fast = { initialIntervalMs: 5, maxIntervalMs: 10 };

function records(...sequence) {
	let read = 0;
	return async () => {
		const next = sequence[Math.min(read++, sequence.length - 1)];
		if (next instanceof Error) throw next;
		return next;
	};
}

describe("following a rolling deploy's record (harper#3058)", () => {
	let lines;
	const report = (line) => lines.push(line);
	beforeEach(() => (lines = []));

	const peer = (node, activation) => ({ node, status: 'success', ...(activation && { activation }) });

	it('reports each node once, as its outcome lands, and ends when the record does', async () => {
		const outcome = await awaitRollout(
			ID,
			records(
				{ status: 'rolling_out', peer_results: [peer('a'), peer('b')] },
				{
					status: 'rolling_out',
					peer_results: [peer('a', { activated: true, certification: 'certified' }), peer('b')],
				},
				{
					deployment_id: ID,
					status: 'success',
					peer_results: [
						peer('a', { activated: true, certification: 'certified' }),
						peer('b', { activated: true, certification: 'certified' }),
					],
				}
			),
			{ ...fast, report }
		);
		assert.strictEqual(outcome.failure, undefined);
		assert.strictEqual(outcome.timedOut, false);
		assert.deepStrictEqual(lines.slice(1), ['  a: took the release (certified)', '  b: took the release (certified)']);
		assert.deepStrictEqual(summarizeRollout(outcome), {
			status: 'success',
			nodes: [
				{ node: 'a', activated: true, certification: 'certified' },
				{ node: 'b', activated: true, certification: 'certified' },
			],
		});
	});

	it('fails naming the node that did not take the release, and why', async () => {
		const outcome = await awaitRollout(
			ID,
			records({
				status: 'partial',
				peer_results: [peer('a', { activated: false, error: 'release failed to load in its canary worker' })],
				error: { message: 'Not activated on 1 of 1 peer node(s): a (release failed to load in its canary worker)' },
			}),
			{ ...fast, report }
		);
		assert.match(outcome.failure, /a \(release failed to load/);
		assert.ok(lines.includes('  a: did not take the release: release failed to load in its canary worker'));
	});

	it('times out naming the nodes still waiting, and keeps retrying a read that fails meanwhile', async () => {
		const outcome = await awaitRollout(
			ID,
			records(
				{ status: 'rolling_out', peer_results: [peer('a', { activated: true }), peer('b')] },
				new Error('socket hang up')
			),
			{ ...fast, report, timeoutMs: 60 }
		);
		assert.strictEqual(outcome.timedOut, true);
		assert.match(outcome.failure, /not yet taken on b \(last read failed: socket hang up\)/);
		assert.strictEqual(summarizeRollout(outcome).status, 'timed_out');
	});

	it("keeps waiting through a lagging node's earlier status, which is no ending", async () => {
		const outcome = await awaitRollout(
			ID,
			records(
				{ status: 'restarting', peer_results: [peer('a')] },
				{ status: 'rolling_out', peer_results: [peer('a')] },
				{ deployment_id: ID, status: 'success', peer_results: [peer('a', { activated: true })] }
			),
			{ ...fast, report }
		);
		assert.strictEqual(outcome.failure, undefined);
		assert.strictEqual(outcome.record.status, 'success');
	});

	it('stops at once on a refusal, which no retry fixes', async () => {
		const refusal = Object.assign(new Error('get_deployment answered 403'), { statusCode: 403 });
		const outcome = await awaitRollout(ID, records(refusal), { ...fast, report, timeoutMs: 60_000 });
		assert.match(outcome.failure, /Grant the role get_deployment, or, if the token expired/);
		assert.match(outcome.failure, /or pass wait=false/);
	});

	it('bounds each read by what is left of the wait', async () => {
		const budgets = [];
		await awaitRollout(
			ID,
			async (_id, remainingMs) => {
				budgets.push(remainingMs);
				return { status: 'rolling_out', peer_results: [] };
			},
			{ ...fast, report, timeoutMs: 80 }
		);
		assert.ok(budgets.length > 1);
		assert.ok(budgets.every((budget) => budget >= 1 && budget <= 80));
		assert.ok(budgets.at(-1) < budgets[0]);
	});

	it('allows each node the per-node bound by default', () => {
		assert.ok(ROLLOUT_WAIT_PER_NODE_MS >= 10 * 60 * 1000);
	});
});
