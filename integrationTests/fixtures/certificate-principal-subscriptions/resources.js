const READERS = new Set(['certsub-device', 'certsub_dropped']);

export class CertSubFeed extends tables.CertSubFeed {
	allowRead(user) {
		return READERS.has(user?.username);
	}
}

// A grant an application keeps in allowRead: a client reads the record named for it until a gate row revokes it.
export class CertSubTopic extends tables.CertSubTopic {
	async allowRead(user, target) {
		if (!user?.username || target?.id !== user.username) return false;
		return (await tables.CertSubGate.get(user.username))?.revoked !== true;
	}
}
