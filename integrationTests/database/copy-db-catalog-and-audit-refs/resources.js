const HAS_ADDITIONAL_AUDIT_REFS = 0x80;
const RESIDENCY_ID = 70000;
const OWNERS = ['node-a', 'node-b'];
const NEXT_TABLE_ID = 50;

export class SeedCatalog extends Resource {
	static loadAsInstance = false;
	post() {
		const dbisDb = tables.Counter.dbisDB;
		dbisDb.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], OWNERS);
		dbisDb.putSync([Symbol.for('residency_by_set'), OWNERS.join(',')], RESIDENCY_ID);
		dbisDb.putSync(Symbol.for('next-table-id'), NEXT_TABLE_ID);
		return { seeded: true };
	}
}

export class Verify extends Resource {
	static loadAsInstance = false;
	async get() {
		const Counter = tables.Counter;
		const records = {};
		const undecodable = [];
		let auditRefFlagged = 0;
		for (const { key } of Counter.primaryStore.getRange({ start: null })) {
			if (typeof key === 'symbol') continue;
			try {
				const entry = Counter.primaryStore.getEntry(key);
				if (entry?.metadataFlags & HAS_ADDITIONAL_AUDIT_REFS) auditRefFlagged++;
				const record = await Counter.get(key);
				if (record == null) undecodable.push(key);
				else records[key] = { n: record.n, label: record.label, group: record.group };
			} catch {
				undecodable.push(key);
			}
		}
		let indexHits = 0;
		for await (const record of Counter.search({ conditions: [{ attribute: 'group', value: 'g' }] })) {
			if (record?.group === 'g') indexHits++;
		}
		return {
			engine: Counter.primaryStore.rootStore?.constructor?.name,
			records,
			undecodable,
			auditRefFlagged,
			indexHits,
			residency: Counter.getResidencyRecord(RESIDENCY_ID) ?? null,
			residencyBySet: Counter.dbisDB.getSync([Symbol.for('residency_by_set'), OWNERS.join(',')]) ?? null,
			nextTableId: Counter.dbisDB.getSync(Symbol.for('next-table-id')) ?? null,
		};
	}
}
