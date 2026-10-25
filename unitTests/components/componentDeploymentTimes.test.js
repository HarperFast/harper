'use strict';

// harper#564: each get_components entry says when the release it serves was deployed and when this node's workers
// last loaded it.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const operations = require('#js/components/operations');
const { lifecycle, reset, internal } = require('#src/components/status/index');
const { StatusAggregator } = internal;
const { formatDeploymentProvenance, DEPLOYMENT_PROVENANCE_FILE } = require('#src/components/deploymentProvenance');
const { databases } = require('#src/resources/databases');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');

const DEPLOYMENT_TABLE = SYSTEM_TABLE_NAMES.DEPLOYMENT_TABLE_NAME;

function installDeploymentRows(rows) {
	if (!databases.system) databases.system = {};
	const prior = databases.system[DEPLOYMENT_TABLE];
	databases.system[DEPLOYMENT_TABLE] = {
		async get(id) {
			return rows.find((row) => row.deployment_id === id);
		},
		async *search({ conditions, sort }) {
			const ordered = sort ? [...rows].sort((a, b) => b[sort.attribute] - a[sort.attribute]) : rows;
			for (const row of ordered) {
				if (conditions.every(({ attribute, value }) => row[attribute] === value)) yield row;
			}
		},
	};
	return () => {
		databases.system[DEPLOYMENT_TABLE] = prior;
	};
}

describe('component load times (harper#564)', () => {
	afterEach(() => reset());

	it('records when a thread finished loading a component, and keeps it across later reports', async () => {
		const before = Date.now();
		lifecycle.loading('app');
		assert.strictEqual(internal.componentStatusRegistry.getStatus('app').loadedAt, undefined);
		lifecycle.loaded('app');
		const loadedAt = internal.componentStatusRegistry.getStatus('app').loadedAt.getTime();
		assert.ok(loadedAt >= before);

		internal.componentStatusRegistry.reportWarning('app', 'slow upstream');
		assert.strictEqual(internal.componentStatusRegistry.getStatus('app').loadedAt.getTime(), loadedAt);

		lifecycle.failed('broken', new Error('boom'));
		assert.ok(internal.componentStatusRegistry.getStatus('broken').loadedAt.getTime() >= loadedAt);
	});

	it("reports the latest load across threads and an application's sub-components", async () => {
		const aggregated = StatusAggregator.aggregate(
			new Map([
				['app@worker-0', { status: 'healthy', lastChecked: new Date(10), loadedAt: new Date(1000) }],
				['app@worker-1', { status: 'healthy', lastChecked: new Date(10), loadedAt: new Date(3000) }],
				['app.rest@worker-0', { status: 'healthy', lastChecked: new Date(10), loadedAt: new Date(2000) }],
				['other@worker-0', { status: 'healthy', lastChecked: new Date(10) }],
			])
		);
		assert.strictEqual(aggregated.get('app').loadedAt, 3000);
		assert.strictEqual(aggregated.get('other').loadedAt, undefined);
		const status = await internal.componentStatusRegistry.getAggregatedStatusFor('app', aggregated);
		assert.strictEqual(status.loadedAt, 3000);
	});
});

describe('get_components deployment times (harper#564)', () => {
	let root;
	let previousRoot;
	let restoreTable;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-times-'));
		previousRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, root);
	});
	afterEach(async () => {
		restoreTable?.();
		reset();
		if (!root) return;
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, previousRoot);
		await fs.rm(root, { recursive: true, force: true });
	});

	async function component(name, liveDeploymentId) {
		await fs.mkdir(path.join(root, name), { recursive: true });
		await fs.writeFile(path.join(root, name, 'resources.js'), '');
		if (liveDeploymentId) {
			await fs.writeFile(
				path.join(root, name, DEPLOYMENT_PROVENANCE_FILE),
				formatDeploymentProvenance(name, liveDeploymentId)
			);
		}
	}

	it('describes the live release by the record that made it live, and the latest load on this node', async () => {
		await component('web', 'b');
		await component('legacy');
		await component('never-deployed');
		await component('rolling', 'g');
		restoreTable = installDeploymentRows([
			{ deployment_id: 'a', project: 'web', status: 'success', completed_at: 100 },
			{ deployment_id: 'b', project: 'web', status: 'staged', completed_at: 200 },
			{ deployment_id: 'c', project: 'web', status: 'success', activated_from: 'b', completed_at: 300 },
			// newer, but rejected here: this node still serves b
			{ deployment_id: 'd', project: 'web', status: 'partial', completed_at: 400 },
			{ deployment_id: 'g', project: 'rolling', status: 'rolling_out', completed_at: 500 },
			{ deployment_id: 'e', project: 'legacy', status: 'success', completed_at: 50 },
			{ deployment_id: 'f', project: 'legacy', status: 'failed', completed_at: 60 },
		]);
		const before = Date.now();
		lifecycle.loaded('web');

		const { entries } = await operations.getComponents();
		const web = entries.find((entry) => entry.name === 'web');
		assert.strictEqual(web.deployment_id, 'b');
		assert.strictEqual(web.deployed_at, 300);
		assert.ok(web.restarted_at >= before, 'restarted_at is when this node last loaded it');
		assert.strictEqual(web.status.loadedAt, undefined);

		const legacy = entries.find((entry) => entry.name === 'legacy');
		assert.strictEqual(legacy.deployment_id, undefined);
		assert.strictEqual(legacy.deployed_at, 50);
		assert.strictEqual(legacy.restarted_at, undefined);

		const rolling = entries.find((entry) => entry.name === 'rolling');
		assert.strictEqual(rolling.deployed_at, 500, 'a release still rolling out is live where it went live');

		const neverDeployed = entries.find((entry) => entry.name === 'never-deployed');
		assert.strictEqual(neverDeployed.deployed_at, undefined);
	});
});

describe("finding the live release's record when the catalog or history is awkward (harper#564)", () => {
	const { deploymentOfLiveRelease } = require('#src/components/deploymentOperations');
	let restoreTable;
	afterEach(() => restoreTable?.());

	it('keeps the record found by key when the activated_from search cannot run', async () => {
		restoreTable = installDeploymentRows([
			{ deployment_id: 'b', project: 'web', status: 'success', completed_at: 200 },
		]);
		databases.system[DEPLOYMENT_TABLE].search = () => {
			// An upgraded catalog that lacks the attribute
			throw new Error('activated_from is not an attribute of hdb_deployment');
		};
		assert.deepStrictEqual(await deploymentOfLiveRelease('web', 'b'), { deployment_id: 'b', completed_at: 200 });
	});

	it('finds a markerless release behind any number of newer unreleased deploys', async () => {
		const rows = [{ deployment_id: 'released', project: 'old', status: 'success', completed_at: 1 }];
		for (let i = 0; i < 150; i++) {
			rows.push({
				deployment_id: `failed-${i}`,
				project: 'old',
				status: i % 2 ? 'failed' : 'staged',
				completed_at: 10 + i,
			});
		}
		restoreTable = installDeploymentRows(rows);
		assert.deepStrictEqual(await deploymentOfLiveRelease('old', undefined), {
			deployment_id: 'released',
			completed_at: 1,
		});
	});
});

describe("finding the live release's record in the deployment table (harper#564)", () => {
	const { deploymentOfLiveRelease } = require('#src/components/deploymentOperations');
	const rows = [
		{ deployment_id: 'times-1', project: 'times-p', status: 'success', completed_at: 100 },
		{ deployment_id: 'times-2', project: 'times-p', status: 'success', completed_at: 300 },
		{ deployment_id: 'times-3', project: 'times-p', status: 'failed', completed_at: 400 },
		{ deployment_id: 'times-4', project: 'times-q', status: 'success', completed_at: 500 },
		{ deployment_id: 'times-5', project: 'times-p', status: 'success', completed_at: 200, activated_from: 'times-x' },
		// swapped here, then failed on a peer
		{ deployment_id: 'times-6', project: 'times-p', status: 'failed', completed_at: 600 },
	];
	before(async () => {
		await testUtils.ensureSystemTables();
		for (const row of rows) await databases.system[DEPLOYMENT_TABLE].put(row);
	});
	after(async () => {
		const table = databases.system?.[DEPLOYMENT_TABLE];
		if (table) for (const row of rows) await table.delete(row.deployment_id);
	});

	it('finds it by key and by activated_from, and for a tree without a marker, the newest released row', async () => {
		assert.deepStrictEqual(await deploymentOfLiveRelease('times-p', undefined), {
			deployment_id: 'times-2',
			completed_at: 300,
		});
		assert.deepStrictEqual(await deploymentOfLiveRelease('times-p', 'times-x'), {
			deployment_id: 'times-5',
			completed_at: 200,
		});
		assert.deepStrictEqual(await deploymentOfLiveRelease('times-p', 'times-1'), {
			deployment_id: 'times-1',
			completed_at: 100,
		});
		assert.strictEqual(await deploymentOfLiveRelease('times-none', undefined), undefined);
		assert.deepStrictEqual(await deploymentOfLiveRelease('times-p', 'times-6'), {
			deployment_id: 'times-6',
			completed_at: 600,
		});
	});
});
