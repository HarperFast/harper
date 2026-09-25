// The ops API denies writes to the `system` database (403) and describe_table omits a table's expiration,
// so the suite reaches system.hdb_oidc_token_use in-process. Rows are read from the primary store with
// their expiry metadata, not through a get or search: those hide an expired row, and a get removes it.

const TABLE = 'hdb_oidc_token_use';

function tokenUseTable() {
	return databases.system[TABLE];
}

export class TokenUseTable extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const Table = tokenUseTable();
		if (target?.id) return { id: target.id, visible: Boolean(await Table.get(target.id)) };
		const durable = {};
		let durableExpiration = null;
		for (const { value } of Table.dbisDB.getRange({ start: TABLE + '/', end: TABLE + '0' })) {
			if (!value?.name) continue;
			if (value.isPrimaryKey) durableExpiration = value.expiration ?? null;
			else durable[value.name] = { indexed: Boolean(value.indexed), expiresAt: Boolean(value.expiresAt) };
		}
		const rows = [];
		for (const { key, value, expiresAt } of Table.primaryStore.getRange({ start: false, versions: true })) {
			if (value != null) rows.push({ id: key, expiresAt });
		}
		return {
			audit: Table.audit,
			schemaDefined: Table.schemaDefined,
			expiration: Table.expirationMS ? Table.expirationMS / 1000 : null,
			durableExpiration,
			attributes: Table.attributes.map(({ name, indexed, expiresAt }) => ({
				name,
				indexed: Boolean(indexed),
				expiresAt: Boolean(expiresAt),
			})),
			durable,
			rows,
		};
	}

	// Writes each row as replication applies a peer's: its expiry arrives as the write's metadata.
	async post(query, body) {
		const { rows } = body || query || {};
		for (const { id, expiresAt } of rows)
			await tokenUseTable().put({ id, policy_id: 'deploy', used_at: Date.now() }, { expiresAt });
		return { ok: true, written: rows.length };
	}
}
