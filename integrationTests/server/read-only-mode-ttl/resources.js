// The oracle for read-only-mode-ttl.test.ts: what the primary store holds, read without the table's
// read path, which would hide (or evict) an expired record.
export class RawEntry extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const table = query?.get ? query.get('table') : query?.table;
		const id = query?.get ? query.get('id') : query?.id;
		const entry = databases.readonlyttl[table].primaryStore.getEntry(id);
		return { present: !!entry, hasValue: entry?.value != null, expiresAt: entry?.expiresAt ?? null };
	}
}
