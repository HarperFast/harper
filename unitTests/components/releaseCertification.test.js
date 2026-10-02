'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const {
	CERTIFICATION_RECORD_FILE,
	certificationPinsOf,
	certificationRecordPath,
	failClosedReleases,
	liveCertification,
	liveDeploymentId,
	readCertificationRecord,
	rejectionReason,
	removeCertificationRecord,
	writeCertificationRecord,
} = require('#src/components/releaseCertification');
const { DEPLOYMENT_PROVENANCE_FILE, formatDeploymentProvenance } = require('#src/components/deploymentProvenance');

const LIVE = '11111111-1111-1111-1111-111111111111';
const PREVIOUS = '22222222-2222-2222-2222-222222222222';

async function newRoot() {
	return fs.mkdtemp(path.join(os.tmpdir(), 'release-certification-'));
}

/** A live tree carrying `deploymentId`'s marker, and that deployment's directory with its owner sidecar. */
async function deployed(root, component, deploymentId) {
	await fs.mkdir(path.join(root, component), { recursive: true });
	await fs.writeFile(
		path.join(root, component, DEPLOYMENT_PROVENANCE_FILE),
		formatDeploymentProvenance(component, deploymentId)
	);
	await fs.mkdir(path.join(root, '.deploy-staging', deploymentId), { recursive: true });
	await fs.writeFile(path.join(root, '.deploy-staging', deploymentId, '.component'), component);
}

function pending(component, deploymentId, overrides = {}) {
	return {
		component,
		deploymentId,
		previous: PREVIOUS,
		wasAbsent: false,
		state: 'pending',
		incarnation: 'this-process',
		...overrides,
	};
}

describe('release certification records', () => {
	let root;
	beforeEach(async () => {
		root = await newRoot();
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('round-trips a record and replaces it whole', async () => {
		await deployed(root, 'web', LIVE);
		await writeCertificationRecord(root, pending('web', LIVE));
		const written = await readCertificationRecord(root, LIVE);
		assert.equal(written.state, 'pending');
		assert.equal(written.previous, PREVIOUS);
		assert.equal(typeof written.at, 'number');

		await writeCertificationRecord(root, pending('web', LIVE, { state: 'rejected', reason: 'boom' }));
		const replaced = await readCertificationRecord(root, LIVE);
		assert.equal(replaced.state, 'rejected');
		assert.equal(replaced.reason, 'boom');
		const leftovers = (await fs.readdir(path.join(root, '.deploy-staging', LIVE))).filter((name) =>
			name.includes('.partial-')
		);
		assert.deepEqual(leftovers, [], 'no temp file is left beside the record');
	});

	it('reads absent as undefined and refuses a record it cannot trust', async () => {
		await deployed(root, 'web', LIVE);
		assert.equal(await readCertificationRecord(root, LIVE), undefined);

		await fs.writeFile(certificationRecordPath(root, LIVE), '{not json');
		await assert.rejects(readCertificationRecord(root, LIVE), /could not be parsed/);

		await fs.writeFile(
			certificationRecordPath(root, LIVE),
			JSON.stringify({ ...pending('web', PREVIOUS), v: 1, at: Date.now() })
		);
		await assert.rejects(readCertificationRecord(root, LIVE), /not a certification record/);

		await fs.writeFile(
			certificationRecordPath(root, LIVE),
			JSON.stringify({ ...pending('web', LIVE), state: 'maybe', v: 1, at: Date.now() })
		);
		await assert.rejects(readCertificationRecord(root, LIVE), /not a certification record/);
	});

	it('refuses a deployment id that is not a single path segment', () => {
		assert.throws(() => certificationRecordPath(root, '../escape'), /Invalid deployment id/);
		assert.throws(() => certificationRecordPath(root, '.claiming-x'), /Invalid deployment id/);
	});

	it('removes a record, and removing an absent one is not an error', async () => {
		await deployed(root, 'web', LIVE);
		await writeCertificationRecord(root, pending('web', LIVE));
		await removeCertificationRecord(root, LIVE);
		await removeCertificationRecord(root, LIVE);
		assert.equal(await readCertificationRecord(root, LIVE), undefined);
	});

	it('names the live release only from a marked directory', async () => {
		assert.equal(await liveDeploymentId(root, 'web'), undefined);
		await deployed(root, 'web', LIVE);
		assert.equal(await liveDeploymentId(root, 'web'), LIVE);
		await fs.writeFile(path.join(root, 'web', DEPLOYMENT_PROVENANCE_FILE), formatDeploymentProvenance('other', LIVE));
		assert.equal(await liveDeploymentId(root, 'web'), undefined, "another component's marker names nothing");
	});

	it('reports the live release record, or that it cannot be read', async () => {
		await deployed(root, 'web', LIVE);
		assert.equal(await liveCertification(root, 'web'), undefined);

		await writeCertificationRecord(root, pending('web', LIVE));
		const live = await liveCertification(root, 'web');
		assert.equal(live.deploymentId, LIVE);
		assert.equal(live.record.state, 'pending');
		assert.equal(rejectionReason(live), undefined, 'a pending release is not refused');

		await fs.writeFile(certificationRecordPath(root, LIVE), 'garbage');
		const unreadable = await liveCertification(root, 'web');
		assert.ok(unreadable.unreadable instanceof Error);
		assert.match(rejectionReason(unreadable), /cannot be read/, 'an unreadable decision is never permission');
	});

	it('fails closed exactly the components whose LIVE release was rejected or is unreadable', async () => {
		await deployed(root, 'rejected', LIVE);
		await writeCertificationRecord(root, pending('rejected', LIVE, { state: 'rejected', reason: 'threw at load' }));

		const pendingId = '33333333-3333-3333-3333-333333333333';
		await deployed(root, 'pending', pendingId);
		await writeCertificationRecord(root, pending('pending', pendingId));

		const unreadableId = '44444444-4444-4444-4444-444444444444';
		await deployed(root, 'unreadable', unreadableId);
		await fs.writeFile(certificationRecordPath(root, unreadableId), 'garbage');

		// A rejected release that is no longer live is history, not a reason to refuse what is live now.
		const displacedId = '55555555-5555-5555-5555-555555555555';
		await deployed(root, 'restored', PREVIOUS);
		await fs.mkdir(path.join(root, '.deploy-staging', displacedId), { recursive: true });
		await fs.writeFile(path.join(root, '.deploy-staging', displacedId, '.component'), 'restored');
		await writeCertificationRecord(root, pending('restored', displacedId, { state: 'rejected' }));

		const failClosed = await failClosedReleases(root);
		assert.deepEqual([...failClosed.keys()].sort(), ['rejected', 'unreadable']);
		assert.match(failClosed.get('rejected').message, /threw at load/);
		assert.match(failClosed.get('unreadable').message, /cannot be read/);
	});

	it('answers an empty set when there is no staging root at all', async () => {
		assert.equal((await failClosedReleases(root)).size, 0);
	});

	it('pins the predecessors a component records, and nothing when one record cannot be read', async () => {
		await deployed(root, 'web', LIVE);
		await writeCertificationRecord(root, pending('web', LIVE));
		await deployed(root, 'other', '66666666-6666-6666-6666-666666666666');
		await writeCertificationRecord(
			root,
			pending('other', '66666666-6666-6666-6666-666666666666', { previous: '77777777-7777-7777-7777-777777777777' })
		);
		assert.deepEqual(await certificationPinsOf(root, 'web'), [PREVIOUS]);

		await fs.writeFile(certificationRecordPath(root, LIVE), 'garbage');
		assert.equal(await certificationPinsOf(root, 'web'), undefined);
		assert.deepEqual(await certificationPinsOf(root, 'other'), ['77777777-7777-7777-7777-777777777777']);
	});

	it('keeps the record beside its deployment', () => {
		assert.equal(
			certificationRecordPath(root, LIVE),
			path.join(root, '.deploy-staging', LIVE, CERTIFICATION_RECORD_FILE)
		);
	});
});
