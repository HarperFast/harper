'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { dropPeerResults } = require('#src/components/operations');
const { dropComponentFileValidator } = require('#src/components/operationsValidation');

describe('a replicated drop_component', () => {
	it("reports each peer's outcome in the per-node shape, and keeps what its answer carried", () => {
		const replicated = [
			// what a peer running this drop answers, with the node harper-pro attaches
			{
				message: 'Successfully dropped: preview',
				node: 'peer-a',
				componentRemoved: true,
				workerStopped: true,
				branchesRemoved: false,
			},
			{
				message: 'Successfully dropped: preview, which was not on this node',
				node: 'peer-b',
				componentRemoved: false,
				workerStopped: false,
				branchesRemoved: false,
			},
			// what harper-pro records for a peer the operation did not reach
			{ status: 'failed', reason: 'Error: connection closed', node: 'peer-c' },
			// a peer that predates the per-node result
			{ message: 'Successfully dropped: preview', node: 'peer-d' },
		];
		assert.deepStrictEqual(dropPeerResults(replicated), [
			{ ...replicated[0], error: null },
			{ ...replicated[1], error: null },
			{
				status: 'failed',
				reason: 'Error: connection closed',
				node: 'peer-c',
				componentRemoved: null,
				workerStopped: null,
				branchesRemoved: null,
				error: 'Error: connection closed',
			},
			{
				message: 'Successfully dropped: preview',
				node: 'peer-d',
				componentRemoved: null,
				workerStopped: null,
				branchesRemoved: null,
				error: null,
			},
		]);
	});

	it('accepts keepBranches only as a boolean', () => {
		assert.equal(dropComponentFileValidator({ project: 'preview', keepBranches: true }), undefined);
		assert.equal(dropComponentFileValidator({ project: 'preview' }), undefined);
		assert.match(dropComponentFileValidator({ project: 'preview', keepBranches: 'true' }).message, /keepBranches/);
	});
});
