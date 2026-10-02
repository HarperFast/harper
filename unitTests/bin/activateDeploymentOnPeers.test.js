'use strict';

const assert = require('node:assert');
const { activateDeploymentOnPeers } = require('#src/bin/restart');
const { getThisNodeName } = require('#src/server/nodeName');

const DEPLOYMENT = '11111111-1111-1111-1111-111111111111';
const ROW = '22222222-2222-2222-2222-222222222222';

describe('activating a staged release on each peer in turn', () => {
	let previousServer;
	let sent;
	let answers;

	beforeEach(() => {
		previousServer = global.server;
		sent = [];
		answers = {};
		global.server = {
			nodes: [{ name: getThisNodeName() }, { name: 'peer-a' }, { name: 'peer-b' }, { name: 'peer-c' }],
			replication: {
				monitorNodeCAs() {},
				async sendOperationToNode(node, operation, options) {
					sent.push({ node: node.name, operation, options });
					const answer = answers[node.name] ?? { message: `Successfully deployed: web`, certification: 'certified' };
					if (answer instanceof Error) throw answer;
					return answer;
				},
			},
		};
	});
	afterEach(() => {
		global.server = previousServer;
	});

	const activation = (overrides = {}) => ({
		project: 'web',
		deployment_id: DEPLOYMENT,
		deployment_row: ROW,
		...overrides,
	});

	it('refuses an activation it cannot read', async () => {
		for (const bad of [
			undefined,
			activation({ project: 42 }),
			activation({ deployment_id: '../etc' }),
			activation({ deployment_row: undefined }),
			activation({ nodes: 'peer-a' }),
			activation({ nodes: [1] }),
		]) {
			await assert.rejects(activateDeploymentOnPeers(bad), { statusCode: 400 }, JSON.stringify(bad));
		}
		assert.deepStrictEqual(sent, []);
	});

	it('activates every other node, one at a time, and reports what each certified', async () => {
		let inFlight = 0;
		const send = global.server.replication.sendOperationToNode;
		global.server.replication.sendOperationToNode = async (...args) => {
			assert.equal(++inFlight, 1, 'one peer at a time');
			await new Promise((resolve) => setTimeout(resolve, 10));
			try {
				return await send(...args);
			} finally {
				inFlight--;
			}
		};
		const { activated } = await activateDeploymentOnPeers(activation());
		assert.deepStrictEqual(
			sent.map(({ node }) => node),
			['peer-a', 'peer-b', 'peer-c']
		);
		assert.deepStrictEqual(sent[0].operation, {
			operation: 'deploy_component',
			project: 'web',
			deployment_id: DEPLOYMENT,
			_deploymentId: ROW,
			restart: true,
			replicated: false,
		});
		assert.ok(sent[0].options.timeoutMs > 0);
		assert.deepStrictEqual(
			activated.map(({ node, certification }) => ({ node, certification })),
			['peer-a', 'peer-b', 'peer-c'].map((node) => ({ node, certification: 'certified' }))
		);
	});

	it('has nothing to do on a node without peers, which has no replication to ask', async () => {
		global.server = {
			replication: {
				monitorNodeCAs() {
					throw new Error('Replication not implemented.');
				},
			},
		};
		assert.deepStrictEqual(await activateDeploymentOnPeers(activation()), { activated: [] });
	});

	it('activates only the nodes it was given', async () => {
		await activateDeploymentOnPeers(activation({ nodes: ['peer-b'] }));
		assert.deepStrictEqual(
			sent.map(({ node }) => node),
			['peer-b']
		);
	});

	it('visits every peer when one refuses, and fails naming each that did not take it', async () => {
		answers['peer-a'] = new Error('web was not deployed on this node: release failed to load in its canary worker');
		answers['peer-b'] = { value: { message: 'Successfully deployed: web', certification: 'certified' } };
		await assert.rejects(activateDeploymentOnPeers(activation()), (error) => {
			assert.match(error.message, /was not activated on 1 of 3 peer node\(s\): peer-a \(web was not deployed/);
			assert.deepStrictEqual(
				error.replicated.map(({ node, certification, error: failure }) => ({ node, certification, failed: !!failure })),
				[
					{ node: 'peer-a', certification: undefined, failed: true },
					{ node: 'peer-b', certification: 'certified', failed: false },
					{ node: 'peer-c', certification: 'certified', failed: false },
				]
			);
			return true;
		});
		assert.equal(sent.length, 3, 'a refusal on one peer does not stop the others');
	});
});
