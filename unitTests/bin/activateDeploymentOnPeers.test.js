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

	it('fails naming a peer that staged the release but left the cluster before its turn', async () => {
		await assert.rejects(activateDeploymentOnPeers(activation({ nodes: ['peer-b', 'peer-gone'] })), (error) => {
			assert.match(error.message, /was not activated on 1 of 2 peer node\(s\): peer-gone \(it is no longer one/);
			assert.deepStrictEqual(
				error.http_resp_msg.activated.map(({ node, error: failure }) => ({ node, failed: !!failure })),
				[
					{ node: 'peer-b', failed: false },
					{ node: 'peer-gone', failed: true },
				]
			);
			return true;
		});
		assert.deepStrictEqual(
			sent.map(({ node }) => node),
			['peer-b']
		);
	});

	it('fails, rather than succeed with nothing, when none of the peers it was given remain', async () => {
		await assert.rejects(activateDeploymentOnPeers(activation({ nodes: ['peer-gone'] })), /peer-gone/);
		assert.deepStrictEqual(sent, []);
	});

	it('visits every peer when one refuses, and fails naming each that did not take it', async () => {
		answers['peer-a'] = new Error('web was not deployed on this node: release failed to load in its canary worker');
		answers['peer-b'] = { value: { message: 'Successfully deployed: web', certification: 'certified' } };
		await assert.rejects(activateDeploymentOnPeers(activation()), (error) => {
			assert.match(error.message, /was not activated on 1 of 3 peer node\(s\): peer-a \(web was not deployed/);
			assert.equal(error.http_resp_msg.error, error.message);
			assert.deepStrictEqual(
				error.http_resp_msg.activated.map(({ node, certification, error: failure }) => ({
					node,
					certification,
					failed: !!failure,
				})),
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

describe("recording each peer's activation on the deployment's row (harper#3060)", () => {
	const { databases } = require('#src/resources/databases');
	const { SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
	const DEPLOYMENT_TABLE = SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;
	let previousServer;
	let previousTable;
	let rows;
	let puts;
	let answers;

	beforeEach(() => {
		previousServer = global.server;
		answers = {};
		global.server = {
			nodes: [{ name: getThisNodeName() }, { name: 'peer-a' }, { name: 'peer-b' }, { name: 'peer-c' }],
			replication: {
				monitorNodeCAs() {},
				async sendOperationToNode(node) {
					const answer = answers[node.name] ?? { message: 'Successfully deployed: web', certification: 'certified' };
					if (answer instanceof Error) throw answer;
					return answer;
				},
			},
		};
		rows = new Map();
		puts = [];
		if (!databases.system) databases.system = {};
		previousTable = databases.system[DEPLOYMENT_TABLE];
		databases.system[DEPLOYMENT_TABLE] = {
			async get(id) {
				return rows.get(id);
			},
			async put(row) {
				puts.push(structuredClone(row));
				rows.set(row.deployment_id, row);
			},
		};
	});
	afterEach(() => {
		global.server = previousServer;
		if (databases.system) databases.system[DEPLOYMENT_TABLE] = previousTable;
	});

	const stagedRow = (status = 'rolling_out') => ({
		deployment_id: ROW,
		project: 'web',
		status,
		event_log: [],
		peer_results: ['peer-a', 'peer-b', 'peer-c'].map((node) => ({ node, status: 'success', error: null })),
	});
	const activation = { project: 'web', deployment_id: DEPLOYMENT, deployment_row: ROW };

	it('ends the record partial, naming the node whose canary rejected the release, and keeps each staging outcome', async () => {
		rows.set(ROW, stagedRow());
		answers['peer-b'] = new Error('web was not deployed on this node: release failed to load in its canary worker');
		await assert.rejects(activateDeploymentOnPeers(activation), /peer-b/);

		const row = rows.get(ROW);
		assert.strictEqual(row.status, 'partial');
		assert.deepStrictEqual(row.error.nodes, ['peer-b']);
		assert.match(row.error.message, /peer-b \(web was not deployed on this node/);
		assert.deepStrictEqual(
			row.peer_results.map(({ node, status, activation }) => ({
				node,
				status,
				activated: activation.activated,
				certification: activation.certification,
			})),
			[
				{ node: 'peer-a', status: 'success', activated: true, certification: 'certified' },
				{ node: 'peer-b', status: 'success', activated: false, certification: null },
				{ node: 'peer-c', status: 'success', activated: true, certification: 'certified' },
			]
		);
		assert.match(row.peer_results[1].activation.error, /canary worker/);
		assert.deepStrictEqual(
			row.event_log.map(({ event, data }) => `${event}:${data.node}`),
			['peer_activation:peer-a', 'peer_activation:peer-b', 'peer_activation:peer-c']
		);
		assert.deepStrictEqual(
			puts.map(({ status }) => status),
			['rolling_out', 'rolling_out', 'partial'],
			"the last peer's outcome rides the final write rather than landing just before it"
		);
	});

	it('ends the record success once every node took the release', async () => {
		rows.set(ROW, stagedRow());
		await activateDeploymentOnPeers(activation);
		const row = rows.get(ROW);
		assert.strictEqual(row.status, 'success');
		assert.strictEqual(row.error, undefined);
		assert.ok(row.peer_results.every(({ activation }) => activation.activated));
		assert.ok(typeof row.completed_at === 'number');
	});

	it("waits for the origin's own write of rolling_out before writing over the row", async () => {
		rows.set(ROW, stagedRow('restarting'));
		setTimeout(() => rows.set(ROW, stagedRow()), 300);
		await activateDeploymentOnPeers(activation);
		assert.strictEqual(rows.get(ROW).status, 'success');
		assert.ok(puts.every((put) => put.status !== 'restarting'));
	});

	it('records outcomes on a row the origin ended some other way, and leaves its status', async () => {
		rows.set(ROW, stagedRow('failed'));
		await activateDeploymentOnPeers(activation);
		const row = rows.get(ROW);
		assert.strictEqual(row.status, 'failed');
		assert.strictEqual(row.peer_results.filter(({ activation }) => activation?.activated).length, 3);
	});

	it('names a node that left the cluster before its turn on the record too', async () => {
		rows.set(ROW, stagedRow());
		await assert.rejects(activateDeploymentOnPeers({ ...activation, nodes: ['peer-a', 'peer-gone'] }));
		const row = rows.get(ROW);
		assert.strictEqual(row.status, 'partial');
		assert.deepStrictEqual(row.error.nodes, ['peer-gone']);
		assert.strictEqual(row.peer_results.find(({ node }) => node === 'peer-gone').activation.activated, false);
	});
});
