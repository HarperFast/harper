const READERS = new Set(['certsub-device', 'certsub_dropped']);

export class CertSubFeed extends tables.CertSubFeed {
	allowRead(user) {
		return READERS.has(user?.username);
	}
}
