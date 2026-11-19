const READERS = new Set(['certsub-device', 'certsub_dropped']);

export class CertSubFeed extends tables.CertSubFeed {
	allowRead(user) {
		return READERS.has(user?.username);
	}
}

export class CertSubTopic extends tables.CertSubTopic {
	async allowRead(user, target) {
		if (!user?.username || target?.id !== user.username) return false;
		return (await tables.CertSubGate.get(user.username))?.revoked !== true;
	}
}
