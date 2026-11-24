const { parentPort, workerData } = require('node:worker_threads');

// A thread that never loads the schema: everything it knows comes from the catalog. Absent when mocha loads this
// file itself.
if (workerData?.database) run();

function run() {
	const { setupTestDBPath } = require('../testUtils');
	const { resetDatabases } = require('#src/resources/databases');
	const { setMainIsWorker } = require('#src/server/threads/manageThreads');
	setupTestDBPath();
	setMainIsWorker(true);

	async function report() {
		const { PeerStamped, RelOrg, RelMember } = resetDatabases()[workerData.database];
		const attribute = (Table, name) => Table?.attributes.find((attribute) => attribute.name === name);
		const member = RelOrg && (await RelMember.get({ id: 'm1', select: ['id', 'org'] }));
		const org = RelOrg && (await RelOrg.get({ id: 'o1', select: ['id', 'members'] }));
		return {
			primaryKeyNullable: attribute(PeerStamped, 'id')?.nullable,
			primaryKeyType: attribute(PeerStamped, 'id')?.type,
			createdTime: attribute(PeerStamped, 'createdAt')?.assignCreatedTime,
			updatedTime: attribute(PeerStamped, 'updatedAt')?.assignUpdatedTime,
			orgIndexRegistered: Boolean(RelMember?.indices.org),
			memberOrg: member?.org?.id ?? null,
			orgMembers: org?.members?.map((related) => related.id) ?? null,
		};
	}

	parentPort.on('message', () => {
		report().then(
			(result) => parentPort.postMessage({ result }),
			(error) => parentPort.postMessage({ error: error.stack })
		);
	});
}
