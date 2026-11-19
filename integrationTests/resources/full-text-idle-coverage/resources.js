export class IdleRunners extends Resource {
	static loadAsInstance = false;
	get() {
		const Table = tables.IdleArticle;
		return Object.fromEntries(
			Table.fullTextIndexes.map(({ name }) => {
				const key = `derived-index:fulltext:${Table.tableName}/${name}:runner`;
				const free = Table.auditStore.tryLock(key);
				if (free) Table.auditStore.unlock(key);
				return [name, free];
			})
		);
	}
}
