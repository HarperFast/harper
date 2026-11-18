const { setNextEncoding, HAS_REPLICA_DEADLINE } = require('#src/resources/RecordEncoder');

// Fixture rows have no audit refs. Keep their identity, expiry and residency when aging them.
function setReplicaDeadline(Table, key, deadline) {
	const store = Table.primaryStore;
	const entry = store.getEntry(key, { uncachedRead: true });
	const flags = (entry.metadataFlags & ~HAS_REPLICA_DEADLINE) | (deadline === undefined ? 0 : HAS_REPLICA_DEADLINE);
	setNextEncoding(
		entry.version,
		flags,
		entry.expiresAt,
		entry.nodeId,
		entry.residencyId,
		entry.residencySlot,
		deadline
	);
	store.putSync(key, entry.value, { version: entry.version });
}

module.exports = { setReplicaDeadline };
