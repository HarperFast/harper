// Lists the stored rows of a certificate-verification system table with each row's expiry metadata, read
// from the primary store in-process: these tables are sourced from the verifier, so a `get` on a row past
// its expiry re-routes to the source instead of showing the stored row, and the operations API shows no
// expiry. Binary fields are reduced to their length.
const TABLES = ['hdb_certificate_cache', 'hdb_crl_cache', 'hdb_revoked_certificates'];

export class SystemTableProbe extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const name = target.get('table');
		if (!TABLES.includes(name))
			throw new Error(`SystemTableProbe: 'table' must be one of ${TABLES.join(', ')}, got '${name}'`);
		const Table = databases.system?.[name];
		if (!Table) throw new Error(`SystemTableProbe: databases.system.${name} is not declared`);
		const rows = [];
		for (const { key, value, expiresAt } of Table.primaryStore.getRange({ start: false, versions: true })) {
			if (value == null) continue;
			rows.push({
				id: key,
				expiresAt,
				record: Object.fromEntries(
					Object.entries(value).map(([k, v]) => [k, v instanceof Uint8Array ? `<${v.length} bytes>` : v])
				),
			});
		}
		return rows;
	}
}
