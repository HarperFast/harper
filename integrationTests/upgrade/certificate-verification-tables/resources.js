// The ops API denies writes to the `system` database and describe_table omits a table's expiration, so the
// suite reads the certificate verification tables in-process. Rows are read from the primary store with their
// expiry metadata, not through a get or search: those hide an expired row, and a get removes it.

const TABLES = ['hdb_certificate_cache', 'hdb_crl_cache', 'hdb_revoked_certificates'];

export class CertificateVerificationTables extends Resource {
	static loadAsInstance = false;

	get() {
		const state = {};
		for (const name of TABLES) {
			const Table = databases.system[name];
			if (!Table) {
				state[name] = null;
				continue;
			}
			const durable = {};
			let durableExpiration = null;
			for (const { value } of Table.dbisDB.getRange({ start: name + '/', end: name + '0' })) {
				if (!value?.name || value.dropping) continue;
				if (value.isPrimaryKey) durableExpiration = value.expiration ?? null;
				else durable[value.name] = { indexed: Boolean(value.indexed), expiresAt: Boolean(value.expiresAt) };
			}
			const rows = [];
			for (const { key, value, expiresAt } of Table.primaryStore.getRange({ start: false, versions: true })) {
				if (value != null) rows.push({ id: key, expiresAt: expiresAt ?? null, fields: Object.keys(value) });
			}
			state[name] = {
				expiration: Table.expirationMS ? Table.expirationMS / 1000 : null,
				durableExpiration,
				durable,
				rows,
			};
		}
		return state;
	}
}
