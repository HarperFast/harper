// QA-518 — end-to-end proof-of-life for a component packaged/deployed past a dangling
// symlink. If the packaging bug (silent truncation after a broken symlink) were still
// present, this file — created after the dangling symlink in directory walk order —
// would never have made it into the tarball, and this endpoint would 404.
export class QA518Ping extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true, marker: 'qa518-dangling-symlink-fix' };
	}
}
