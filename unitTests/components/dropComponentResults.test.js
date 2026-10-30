'use strict';

const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { dropPeerResults } = require('#src/components/operations');
const { dropComponentFileValidator } = require('#src/components/operationsValidation');

describe('a replicated drop_component', () => {
	it("reports each peer's outcome in the per-node shape, and keeps what its answer carried", () => {
		const replicated = [
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
			{ status: 'failed', reason: 'Error: connection closed', node: 'peer-c' },
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

	it('reads an outcome a peer wrapped in its answer', () => {
		const outcome = { componentRemoved: true, workerStopped: false, branchesRemoved: false };
		for (const wrapped of [
			{ node: 'peer-a', value: outcome },
			{ node: 'peer-a', body: outcome },
		]) {
			assert.deepStrictEqual(dropPeerResults([wrapped]), [{ ...wrapped, node: 'peer-a', ...outcome, error: null }]);
		}
	});

	it('accepts ifDeploymentId only as a deployment UUID, and only for a whole component', () => {
		const id = '0f5c4a3e-7b1d-4e2a-9c6f-1a2b3c4d5e6f';
		assert.equal(dropComponentFileValidator({ project: 'preview', ifDeploymentId: id }), undefined);
		assert.match(dropComponentFileValidator({ project: 'preview', ifDeploymentId: 'd-1' }).message, /must be a UUID/);
		assert.match(
			dropComponentFileValidator({ project: 'preview', file: 'index.js', ifDeploymentId: id }).message,
			/ifDeploymentId/
		);
	});

	it('accepts keepBranches only as a boolean, and never with restart: true', () => {
		assert.equal(dropComponentFileValidator({ project: 'preview', keepBranches: true }), undefined);
		assert.equal(dropComponentFileValidator({ project: 'preview', keepBranches: false, restart: true }), undefined);
		assert.equal(dropComponentFileValidator({ project: 'preview' }), undefined);
		assert.match(dropComponentFileValidator({ project: 'preview', keepBranches: 'true' }).message, /keepBranches/);
		assert.match(
			dropComponentFileValidator({ project: 'preview', keepBranches: true, restart: true }).message,
			/cannot be combined with 'restart: true'/
		);
	});
});
