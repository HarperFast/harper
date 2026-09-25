'use strict';

// The origin of a replicated deploy_component waits for each peer's answer. That wait is bounded so a peer
// that never answers cannot hold the origin's operation, deployment row and restart forever, but it must
// never be shorter than what a healthy peer is allowed for the same request, or a slow success is reported
// as a failure.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
const { deployComponent, peerDeployAnswerTimeoutMs } = require('#src/components/operations');
const { packageDirectory } = require('#src/components/packageComponent');
const { resetRestartNeeded } = require('#src/components/requestRestart');
const { componentPreparationBudgetMs } = require('#src/components/Application');
const { DEFAULT_AWAIT_ROW_TIMEOUT_MS } = require('#src/components/deploymentRecorder');
const { RESTART_WAIT_CEILING_MS } = require('#src/components/awaitRestart');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('peerDeployAnswerTimeoutMs', function () {
	it("covers the peer's payload wait and every extraction and install command at its default allowance", function () {
		const timeoutMs = peerDeployAnswerTimeoutMs({ operation: 'deploy_component', project: 'app' });
		assert.ok(
			timeoutMs >= DEFAULT_AWAIT_ROW_TIMEOUT_MS + 4 * HOUR + 2 * HOUR,
			`${timeoutMs}ms does not cover four extraction commands and two install commands`
		);
		assert.ok(timeoutMs >= DEFAULT_AWAIT_ROW_TIMEOUT_MS + componentPreparationBudgetMs());
	});

	it('scales with install_timeout for both install commands', function () {
		const shorter = peerDeployAnswerTimeoutMs({ install_timeout: 10 * MINUTE });
		const longer = peerDeployAnswerTimeoutMs({ install_timeout: 30 * MINUTE });
		assert.strictEqual(longer - shorter, 2 * 20 * MINUTE);
	});

	it('adds the deployment_timeout payload wait, twice when the peer must also wait for credential references', function () {
		const base = peerDeployAnswerTimeoutMs({ deployment_timeout: 0 });
		assert.strictEqual(peerDeployAnswerTimeoutMs({ deployment_timeout: 5 * MINUTE }) - base, 5 * MINUTE);
		assert.strictEqual(
			peerDeployAnswerTimeoutMs({
				deployment_timeout: 5 * MINUTE,
				credentials: [{ registry: 'https://npm.pkg.github.com', secret: 'deploy.app.npm' }],
			}) - base,
			10 * MINUTE
		);
	});

	it('adds the restart ceiling only when the peer restarts before answering', function () {
		const withoutRestart = peerDeployAnswerTimeoutMs({ restart: false });
		assert.strictEqual(peerDeployAnswerTimeoutMs({ restart: true }) - withoutRestart, RESTART_WAIT_CEILING_MS);
		// A rolling restart is cleared on the replicated request, so peers answer before any restart.
		assert.strictEqual(peerDeployAnswerTimeoutMs({ restart: 'rolling' }), withoutRestart);
	});

	it('reads the numeric strings a JSON or multipart client sends', function () {
		assert.strictEqual(
			peerDeployAnswerTimeoutMs({ deployment_timeout: '300000', install_timeout: '600000' }),
			peerDeployAnswerTimeoutMs({ deployment_timeout: 300000, install_timeout: 600000 })
		);
	});

	it('never exceeds the longest delay a timer can hold', function () {
		assert.strictEqual(peerDeployAnswerTimeoutMs({ install_timeout: 2 ** 40 }), 2 ** 31 - 1);
	});
});

// The budget is only a bound if the deploy hands it to the replicator: a replicator given no deadline waits
// for as long as a peer that accepted the operation takes to answer, which may be never.
describe('deploy_component gives replicateOperation a peer deadline', function () {
	this.timeout(20_000);
	const PROJECT = 'peer-deadline-app';
	let componentsRoot;
	let priorComponentsRoot;
	let sourceDir;
	let originalReplicateOperation;
	let replications;

	before(async function () {
		priorComponentsRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		componentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-deadline-root-'));
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, componentsRoot);
		sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-deadline-src-'));
		await fs.writeFile(path.join(sourceDir, 'resources.js'), 'export {};\n');
	});

	after(async function () {
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, priorComponentsRoot);
		// A first deploy of a component asks for a restart, which this process never performs.
		resetRestartNeeded();
		await fs.rm(componentsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await fs.rm(sourceDir, { recursive: true, force: true });
	});

	beforeEach(function () {
		replications = [];
		originalReplicateOperation = server.replication.replicateOperation;
		server.replication.replicateOperation = async (operation, options) => {
			replications.push({ operation: { ...operation }, options });
			return { message: '', replicated: [] };
		};
	});

	afterEach(function () {
		server.replication.replicateOperation = originalReplicateOperation;
	});

	it('passes a finite deadline sized from the request it replicates', async function () {
		const archive = await packageDirectory(sourceDir, { skip_node_modules: true });
		const response = await deployComponent({
			operation: 'deploy_component',
			project: PROJECT,
			payload: archive.toString('base64'),
			restart: false,
			replicated: true,
			deployment_timeout: 5 * MINUTE,
			install_timeout: 10 * MINUTE,
		});
		assert.strictEqual(response.message, `Successfully deployed: ${PROJECT}`);

		assert.strictEqual(replications.length, 1);
		const [{ operation, options }] = replications;
		assert.ok(
			Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0,
			`the peer deadline was ${options?.timeoutMs}`
		);
		assert.strictEqual(options.timeoutMs, peerDeployAnswerTimeoutMs(operation));
		assert.strictEqual(typeof options.onPeerResult, 'function');
	});
});
