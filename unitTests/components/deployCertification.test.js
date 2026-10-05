'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const zlib = require('node:zlib');
const tar = require('tar-fs');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	prepareApplication,
	assertNotCertifying,
	keepsInstalledTree,
	DEPLOY_STAGING_DIR,
	Application,
} = require('#src/components/Application');
const {
	readCertificationRecord,
	writeCertificationRecord,
	certificationRecordPath,
} = require('#src/components/releaseCertification');
const { processIncarnation } = require('#js/server/threads/manageThreads');
const {
	recordCertificationDecision,
	closeCertification,
	resolveArmedCertification,
	resolveInterruptedCertifications,
	deployCertification,
} = require('#src/components/canaryRollout');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { preserveRootConfig } = require('../rootConfigFixture.js');

const PAYLOAD_DECLARATION = { rootConfig: null, isolated: false };

async function makeTarball(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-certification-src-'));
	for (const [rel, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
		await fs.writeFile(path.join(dir, rel), content);
	}
	const chunks = [];
	await new Promise((resolve, reject) => {
		const gzip = zlib.createGzip();
		gzip.on('data', (chunk) => chunks.push(chunk));
		gzip.on('end', resolve);
		gzip.on('error', reject);
		tar.pack(dir).pipe(gzip);
	});
	await fs.rm(dir, { recursive: true, force: true });
	return Buffer.concat(chunks);
}

function applicationAt(root, payload) {
	const app = new Application({ name: 'web', payload });
	app.dirPath = path.join(root, 'web');
	return app;
}

async function deploy(root, id, marker, options = {}) {
	const app = applicationAt(
		root,
		await makeTarball({ 'package.json': '{"name":"web","version":"1.0.0"}\n', 'index.js': marker })
	);
	await prepareApplication(app, { artifactId: id, describeArtifact: () => PAYLOAD_DECLARATION, ...options });
	return app;
}

async function readLive(root) {
	return fs.readFile(path.join(root, 'web', 'index.js'), 'utf8');
}

function recordingCertification(root, { armed = true } = {}) {
	const calls = [];
	return {
		calls,
		async arm(previous, wasAbsent) {
			calls.push({
				call: 'arm',
				previous,
				wasAbsent,
				liveAtArm: existsSync(path.join(root, 'web')) ? await readLive(root) : undefined,
			});
			return armed;
		},
		async commit() {
			calls.push({ call: 'commit', liveAtCommit: await readLive(root) });
		},
		async withdraw() {
			calls.push({ call: 'withdraw' });
		},
	};
}

describe('activating a release for certification', () => {
	preserveRootConfig();
	let root;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-certification-'));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('arms the gate and writes the pending record before the swap, and commits after it', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		const certification = recordingCertification(root);

		const app = await deploy(root, 'd2', 'V2\n', { certification });

		assert.deepStrictEqual(
			certification.calls.map(({ call }) => call),
			['arm', 'commit']
		);
		const [arm, commit] = certification.calls;
		assert.equal(arm.liveAtArm, 'V1\n', 'the previous release is still live when the gate is armed');
		assert.equal(arm.previous, 'd1', 'the release it will displace is named as the one to restore');
		assert.equal(arm.wasAbsent, false);
		assert.equal(commit.liveAtCommit, 'V2\n', 'main learns of the release only once it is live');
		assert.equal(app.certificationArmed, true);
		const record = await readCertificationRecord(root, 'd2');
		assert.equal(record.state, 'pending');
		assert.equal(record.previous, 'd1');
		assert.equal(record.incarnation, processIncarnation);
	});

	it('records a first deploy as having nothing to restore', async function () {
		this.timeout(30000);
		const certification = recordingCertification(root);
		await deploy(root, 'd1', 'V1\n', { certification });
		const [arm] = certification.calls;
		assert.equal(arm.previous, null);
		assert.equal(arm.wasAbsent, true);
		assert.equal((await readCertificationRecord(root, 'd1')).wasAbsent, true);
	});

	it('records nothing when no worker can certify it', async function () {
		this.timeout(30000);
		const certification = recordingCertification(root, { armed: false });
		const app = await deploy(root, 'd1', 'V1\n', { certification });
		assert.deepStrictEqual(
			certification.calls.map(({ call }) => call),
			['arm']
		);
		assert.equal(app.certificationArmed, false);
		assert.equal(await readCertificationRecord(root, 'd1'), undefined);
		assert.equal(await readLive(root), 'V1\n');
	});

	it('withdraws, and removes the record, when the activation fails before it commits', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		const certification = recordingCertification(root);
		await assert.rejects(
			deploy(root, 'd2', 'V2\n', {
				certification,
				// An entry `assertApplicationConfig` refuses: the activation fails before its journal is written.
				describeArtifact: () => ({ rootConfig: { package: 42 }, isolated: false }),
			})
		);
		assert.deepStrictEqual(
			certification.calls.map(({ call }) => call),
			['arm', 'withdraw']
		);
		assert.equal(await readLive(root), 'V1\n');
		assert.equal(existsSync(certificationRecordPath(root, 'd2')), false);
	});

	it('reports the activation failure, not a withdrawal that failed after it', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		const certification = recordingCertification(root);
		certification.withdraw = async () => {
			throw new Error('could not reach main');
		};
		await assert.rejects(
			deploy(root, 'd2', 'V2\n', {
				certification,
				describeArtifact: () => ({ rootConfig: { package: 42 }, isolated: false }),
			}),
			(error) => !/could not reach main/.test(error.message)
		);
		assert.equal(await readLive(root), 'V1\n');
	});

	it('refuses every other preparation of the component while its release is pending in this process', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n', { certification: recordingCertification(root) });

		await assert.rejects(deploy(root, 'd2', 'V2\n'), (error) => {
			assert.equal(error.statusCode, 409);
			assert.match(error.message, /being certified/);
			return true;
		});
		await assert.rejects(assertNotCertifying(path.join(root, 'web'), 'web'), { statusCode: 409 });
		assert.equal(await readLive(root), 'V1\n');

		// An activation of the release being certified joins its decision instead.
		const join = recordingCertification(root);
		const joined = applicationAt(root);
		await prepareApplication(joined, { mode: 'activate', artifactId: 'd1', certification: join });
		assert.equal(joined.alreadyActive, true);
		assert.equal(joined.certificationArmed, true);
		assert.deepStrictEqual(join.calls, [], 'nothing is armed twice');
	});

	it('does not fence a release another process left pending, or one already rejected', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		await writeCertificationRecord(root, {
			component: 'web',
			deploymentId: 'd1',
			previous: null,
			wasAbsent: true,
			state: 'pending',
			incarnation: 'a-previous-process',
		});
		await assertNotCertifying(path.join(root, 'web'), 'web');
		await writeCertificationRecord(root, {
			component: 'web',
			deploymentId: 'd1',
			previous: null,
			wasAbsent: true,
			state: 'rejected',
			incarnation: processIncarnation,
		});
		await assertNotCertifying(path.join(root, 'web'), 'web');
		await deploy(root, 'd2', 'V2\n');
		assert.equal(await readLive(root), 'V2\n', 'a deploy is how a rejected release is replaced');
	});

	it('does not fence a release whose record cannot be read when nothing here holds it open', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		await fs.writeFile(certificationRecordPath(root, 'd1'), 'not a record');
		await assertNotCertifying(path.join(root, 'web'), 'web');
		await deploy(root, 'd2', 'V2\n');
		assert.equal(await readLive(root), 'V2\n', 'a deploy is how a release with an unreadable record is replaced');
	});

	it('certifies a rejected live release again when its id is activated', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		await writeCertificationRecord(root, {
			component: 'web',
			deploymentId: 'd1',
			previous: null,
			wasAbsent: true,
			state: 'rejected',
			incarnation: 'a-previous-process',
			reason: 'threw at load',
		});
		const certification = recordingCertification(root);
		const app = applicationAt(root);

		await prepareApplication(app, { mode: 'activate', artifactId: 'd1', certification });

		assert.equal(app.alreadyActive, true);
		assert.deepStrictEqual(
			certification.calls.map(({ call }) => call),
			['arm', 'commit']
		);
		assert.equal(certification.calls[0].wasAbsent, true, 'the record keeps saying what it would restore');
		assert.equal((await readCertificationRecord(root, 'd1')).state, 'pending');
	});

	it('refuses to certify a live release again while its record cannot be read, and leaves the record alone', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		await fs.writeFile(certificationRecordPath(root, 'd1'), 'not a record');
		const certification = recordingCertification(root);

		await assert.rejects(
			prepareApplication(applicationAt(root), { mode: 'activate', artifactId: 'd1', certification }),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.match(error.message, /certification record cannot be read/);
				return true;
			}
		);
		assert.deepStrictEqual(certification.calls, [], 'nothing is armed');
		assert.equal(await fs.readFile(certificationRecordPath(root, 'd1'), 'utf8'), 'not a record');
	});

	it('restores only while the release it replaces is the one live', async function () {
		this.timeout(30000);
		await deploy(root, 'd1', 'V1\n');
		await deploy(root, 'd2', 'V2\n');

		await assert.rejects(
			prepareApplication(applicationAt(root), { mode: 'activate', artifactId: 'd1', onlyIfLive: 'd9' }),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.match(error.message, /no longer d9/);
				return true;
			}
		);
		assert.equal(await readLive(root), 'V2\n');

		await prepareApplication(applicationAt(root), { mode: 'activate', artifactId: 'd1', onlyIfLive: 'd2' });
		assert.equal(await readLive(root), 'V1\n');
	});

	it('keeps the predecessor a pending record names through retention', async function () {
		this.timeout(60000);
		env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, 1);
		try {
			await deploy(root, 'd1', 'V1\n');
			await deploy(root, 'd2', 'V2\n', { certification: recordingCertification(root) });
			await writeCertificationRecord(root, {
				...(await readCertificationRecord(root, 'd2')),
				incarnation: 'a-previous-process',
			});
			// Two more releases each displace one; at maxCount 1 the oldest kept release would go.
			await deploy(root, 'd3', 'V3\n');
			await deploy(root, 'd4', 'V4\n');
			assert.ok(
				existsSync(path.join(root, DEPLOY_STAGING_DIR, 'd1', 'web')),
				'the release d2 would be restored to is still kept'
			);
		} finally {
			env.setProperty(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT, undefined);
		}
	});
});

describe('deciding a release', () => {
	preserveRootConfig();
	const WEB = { component: 'web', deploymentId: 'd2' };
	let root;
	let previousRoot;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'canary-rollout-'));
		previousRoot = env.get(CONFIG_PARAMS.COMPONENTSROOT);
		// The restore activates through the configured components root, as it does in a running Harper.
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, root);
	});
	afterEach(async () => {
		env.setProperty(CONFIG_PARAMS.COMPONENTSROOT, previousRoot);
		await fs.rm(root, { recursive: true, force: true });
	});

	/** d1 live and kept, then d2 activated for certification over it. */
	async function certifying() {
		await deploy(root, 'd1', 'V1\n');
		await deploy(root, 'd2', 'V2\n', { certification: recordingCertification(root) });
	}

	async function recordOf(id, incarnation) {
		await writeCertificationRecord(root, { ...(await readCertificationRecord(root, id)), incarnation });
	}

	it('makes a certified release durable, and forgets it once the rollout ends', async function () {
		this.timeout(30000);
		await certifying();
		assert.deepStrictEqual(await recordCertificationDecision(WEB, { status: 'certified' }), { status: 'certified' });
		assert.equal((await readCertificationRecord(root, 'd2')).state, 'certified');
		await closeCertification(WEB);
		assert.equal(await readCertificationRecord(root, 'd2'), undefined);
		assert.equal(await readLive(root), 'V2\n');
	});

	it('forgets a release nothing could certify, and leaves it live', async function () {
		this.timeout(30000);
		await certifying();
		await recordCertificationDecision(WEB, { status: 'uncertified', reason: 'its load was skipped' });
		assert.equal(await readCertificationRecord(root, 'd2'), undefined);
		assert.equal(await readLive(root), 'V2\n');
	});

	it('restores the predecessor of a rejected release, and forgets the rejection once it is restored', async function () {
		this.timeout(30000);
		await certifying();
		const decision = await recordCertificationDecision(WEB, { status: 'rejected', reason: 'threw at load' });
		assert.equal(decision.status, 'rejected');
		assert.equal(decision.restored, 'd1');
		assert.equal(decision.failedClosed, false);
		assert.equal(await readLive(root), 'V1\n');
		assert.equal(await readCertificationRecord(root, 'd2'), undefined);
	});

	it('restores the predecessor when the certification was interrupted, rather than leave it undecided', async function () {
		this.timeout(30000);
		await certifying();
		const decision = await recordCertificationDecision(WEB, {
			status: 'interrupted',
			reason: 'the process is shutting down',
		});
		assert.equal(decision.status, 'interrupted');
		assert.equal(decision.restored, 'd1');
		assert.equal(await readLive(root), 'V1\n');
		assert.equal(await readCertificationRecord(root, 'd2'), undefined);
	});

	it('records a refusal that came without a reason under one its status gives', async function () {
		this.timeout(30000);
		await deploy(root, 'd2', 'V2\n', { certification: recordingCertification(root) });
		await recordCertificationDecision(WEB, { status: 'interrupted' });
		assert.equal((await readCertificationRecord(root, 'd2')).reason, 'it was interrupted before its canary decided');
	});

	it('keeps a rejected first deploy live and refused, through the end of its rollout', async function () {
		this.timeout(30000);
		await deploy(root, 'd2', 'V2\n', { certification: recordingCertification(root) });
		const decision = await recordCertificationDecision(WEB, { status: 'rejected', reason: 'threw at load' });
		assert.equal(decision.restored, null);
		assert.equal(decision.failedClosed, true);
		await closeCertification(WEB);
		const record = await readCertificationRecord(root, 'd2');
		assert.equal(record.state, 'rejected');
		assert.equal(record.reason, 'threw at load');
	});

	it('keeps the rejection when the predecessor cannot be put back', async function () {
		this.timeout(30000);
		await certifying();
		await fs.rm(path.join(root, DEPLOY_STAGING_DIR, 'd1'), { recursive: true, force: true });
		const decision = await recordCertificationDecision(WEB, { status: 'rejected', reason: 'threw at load' });
		assert.equal(decision.restored, null);
		assert.equal(decision.failedClosed, true);
		assert.equal(await readLive(root), 'V2\n');
		assert.equal((await readCertificationRecord(root, 'd2')).state, 'rejected');
	});

	it('keeps the record of a refused release whose rejection could not be written, for the next boot to settle', async function () {
		this.timeout(30000);
		await certifying();
		await closeCertification({
			...WEB,
			decision: { status: 'rejected', reason: 'threw at load', recordError: 'ENOSPC' },
		});
		assert.equal((await readCertificationRecord(root, 'd2')).state, 'pending');
		await closeCertification({ ...WEB, decision: { status: 'interrupted', reason: 'the process is shutting down' } });
		assert.equal((await readCertificationRecord(root, 'd2')).state, 'pending');

		await recordOf('d2', 'a-previous-process');
		await resolveInterruptedCertifications(root);
		assert.equal(await readLive(root), 'V1\n', 'the release nobody could refuse durably is put back at boot');
	});

	it('passes a decision through when there is no record to make it durable in', async function () {
		this.timeout(30000);
		await deploy(root, 'd2', 'V2\n');
		const decision = { status: 'rejected', reason: 'threw at load' };
		assert.deepStrictEqual(await recordCertificationDecision(WEB, decision), decision);
		assert.equal(await readLive(root), 'V2\n');
	});

	it('resolves a registration whose requester died from which release is live', async function () {
		this.timeout(30000);
		await certifying();
		assert.equal(await resolveArmedCertification(WEB), 'committed');
		assert.equal((await readCertificationRecord(root, 'd2')).state, 'pending');

		await writeCertificationRecord(root, {
			component: 'web',
			deploymentId: 'd1',
			previous: null,
			wasAbsent: true,
			state: 'pending',
			incarnation: processIncarnation,
		});
		assert.equal(await resolveArmedCertification({ component: 'web', deploymentId: 'd1' }), 'withdrawn');
		assert.equal(await readCertificationRecord(root, 'd1'), undefined);
	});

	describe('at boot', () => {
		it('rejects a release a previous process left pending, and restores its predecessor', async function () {
			this.timeout(30000);
			await certifying();
			await recordOf('d2', 'a-previous-process');
			await resolveInterruptedCertifications(root);
			assert.equal(await readLive(root), 'V1\n');
			assert.equal(await readCertificationRecord(root, 'd2'), undefined);
		});

		it('restores again where a previous process rejected a release but did not finish restoring', async function () {
			this.timeout(30000);
			await certifying();
			await writeCertificationRecord(root, {
				...(await readCertificationRecord(root, 'd2')),
				state: 'rejected',
				reason: 'threw at load',
				incarnation: 'a-previous-process',
			});
			await resolveInterruptedCertifications(root);
			assert.equal(await readLive(root), 'V1\n');
			assert.equal(await readCertificationRecord(root, 'd2'), undefined);
		});

		it('keeps a rejected release with nothing to restore, which then fails closed', async function () {
			this.timeout(30000);
			await deploy(root, 'd2', 'V2\n', { certification: recordingCertification(root) });
			await recordCertificationDecision(WEB, { status: 'rejected', reason: 'threw at load' });
			await recordOf('d2', 'a-previous-process');
			await resolveInterruptedCertifications(root);
			assert.equal((await readCertificationRecord(root, 'd2')).state, 'rejected');
			assert.equal(await readLive(root), 'V2\n');
		});

		it('forgets a certified release, and a record whose release is no longer live', async function () {
			this.timeout(30000);
			await certifying();
			await writeCertificationRecord(root, {
				...(await readCertificationRecord(root, 'd2')),
				state: 'certified',
				incarnation: 'a-previous-process',
			});
			await writeCertificationRecord(root, {
				component: 'web',
				deploymentId: 'd1',
				previous: null,
				wasAbsent: true,
				state: 'pending',
				incarnation: 'a-previous-process',
			});
			await resolveInterruptedCertifications(root);
			assert.equal(await readCertificationRecord(root, 'd2'), undefined);
			assert.equal(await readCertificationRecord(root, 'd1'), undefined);
			assert.equal(await readLive(root), 'V2\n');
		});

		it("leaves this process's records, and records it cannot read, alone", async function () {
			this.timeout(30000);
			await certifying();
			await fs.writeFile(certificationRecordPath(root, 'd1'), 'garbage');
			await resolveInterruptedCertifications(root);
			assert.equal((await readCertificationRecord(root, 'd2')).state, 'pending');
			assert.equal(await fs.readFile(certificationRecordPath(root, 'd1'), 'utf8'), 'garbage');
			assert.equal(await readLive(root), 'V2\n');
		});

		it('does nothing without a staging root', async () => {
			await resolveInterruptedCertifications(root);
		});
	});

	describe('a deploy asking to be certified', () => {
		const spec = (overrides = {}) => ({
			component: 'web',
			deploymentId: 'd2',
			eligible: () => true,
			isolated: () => false,
			scope: () => undefined,
			...overrides,
		});

		it('is not armed when its isolation changed', async () => {
			const certification = deployCertification(spec({ eligible: () => false }));
			assert.equal(await certification.arm(), false);
			assert.equal(certification.armed, false);
			assert.equal(certification.unavailableReason, 'ineligible');
		});

		it('is not armed when no worker places the release', async () => {
			const certification = deployCertification(spec());
			assert.equal(await certification.arm(), false);
			assert.equal(certification.unavailableReason, 'unavailable');
			assert.equal(await certification.decision(), undefined);
		});
	});
});

describe('whether startup keeps the installed tree', () => {
	preserveRootConfig();
	let root, dirPath, lockPath;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-certification-install-'));
		dirPath = path.join(root, 'web');
		lockPath = path.join(root, 'harper-application-lock.json');
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const ENTRY = { package: 'npm:web@1.0.0', urlPath: '/web' };
	const REPLACED = { package: 'npm:web@0.9.0', urlPath: '/web' };
	const lockNaming = (entry) => fs.writeFile(lockPath, JSON.stringify({ applications: { web: entry } }));

	it('keeps a deployed tree only for the entry its deployment declared, whatever the lock names', async function () {
		this.timeout(30000);
		await lockNaming(REPLACED);
		await deploy(root, 'd1', 'V1\n', { describeArtifact: () => ({ rootConfig: ENTRY, isolated: false }) });
		assert.equal(
			await keepsInstalledTree('web', { urlPath: '/web', package: 'npm:web@1.0.0' }, dirPath, lockPath),
			true
		);
		assert.equal(await keepsInstalledTree('web', { ...ENTRY, isolated: true }, dirPath, lockPath), false);
		assert.equal(
			await keepsInstalledTree('web', { package: 'npm:web@1.0.1', urlPath: '/web' }, dirPath, lockPath),
			false
		);
		assert.equal(
			await keepsInstalledTree('web', REPLACED, dirPath, lockPath),
			false,
			'a root config set back to the entry the deploy replaced installs that entry'
		);
	});

	it('installs over a payload build whatever the lock names', async function () {
		this.timeout(30000);
		await lockNaming(ENTRY);
		await deploy(root, 'd1', 'V1\n');
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), false);
	});

	it('installs over a deployed tree whose record cannot be read, whatever the lock names', async function () {
		this.timeout(30000);
		await lockNaming(ENTRY);
		await deploy(root, 'd1', 'V1\n', { describeArtifact: () => ({ rootConfig: REPLACED, isolated: false }) });
		const descriptorPath = path.join(root, DEPLOY_STAGING_DIR, 'd1', '.artifact.json');
		const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
		await fs.writeFile(descriptorPath, 'garbage');
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), false, 'an unreadable record');
		await fs.writeFile(descriptorPath, JSON.stringify({ ...descriptor, v: descriptor.v + 1 }));
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), false, 'a record of another version');
	});

	it('lets the lock decide for a tree no deployment record describes: installed at startup, or its record gone', async function () {
		this.timeout(30000);
		await lockNaming(ENTRY);
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), false, 'nothing is installed');
		await deploy(root, 'boot', 'V1\n', { describeArtifact: undefined });
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), true);
		assert.equal(await keepsInstalledTree('web', REPLACED, dirPath, lockPath), false);
		await deploy(root, 'd1', 'V1\n', { describeArtifact: () => ({ rootConfig: REPLACED, isolated: false }) });
		await fs.rm(path.join(root, DEPLOY_STAGING_DIR, 'd1'), { recursive: true, force: true });
		assert.equal(await keepsInstalledTree('web', ENTRY, dirPath, lockPath), true, 'a record that is gone');
		assert.equal(await keepsInstalledTree('web', REPLACED, dirPath, lockPath), false);
	});
});
