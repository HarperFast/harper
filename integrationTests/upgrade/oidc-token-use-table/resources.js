// The ops API denies writes to the `system` database (403) and describe_table omits an attribute's expiresAt
// flag, so the suite reaches system.hdb_oidc_token_use in-process. Rows are read from the primary store, not
// through a get or search, because those hide an expired row that the sweep has not physically removed yet.

const TABLE = 'hdb_oidc_token_use';

function tokenUseTable() {
	return databases.system[TABLE];
}

export class TokenUseTable extends Resource {
	static loadAsInstance = false;

	async get() {
		const Table = tokenUseTable();
		const durable = {};
		for (const { value } of Table.dbisDB.getRange({ start: TABLE + '/', end: TABLE + '0' })) {
			if (value?.name) durable[value.name] = { indexed: Boolean(value.indexed), expiresAt: Boolean(value.expiresAt) };
		}
		const rows = [];
		for (const { key, value } of Table.primaryStore.getRange({ start: true })) {
			if (value != null) rows.push({ id: key, expiresAt: value.expiresAt });
		}
		return {
			audit: Table.audit,
			schemaDefined: Table.schemaDefined,
			attributes: Table.attributes.map(({ name, indexed, expiresAt }) => ({
				name,
				indexed: Boolean(indexed),
				expiresAt: Boolean(expiresAt),
			})),
			durable,
			rows,
		};
	}

	async post(query, body) {
		const { rows } = body || query || {};
		for (const row of rows) await tokenUseTable().put({ policy_id: 'deploy', used_at: Date.now(), ...row });
		return { ok: true, written: rows.length };
	}
}
