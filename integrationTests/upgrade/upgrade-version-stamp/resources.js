// Fixture for upgrade-version-stamp.test.ts (harper#2158).
//
// The ops API denies writes to the `system` database (403), so the suite cannot stale
// `system.hdb_info` the way it needs to in order to make the next boot look like an in-place
// upgrade. A component resource runs in-process against the table directly, which is the same
// access the upgrade path itself has.
//
//   GET  /VersionStamps/        — every hdb_info row, oldest info_id first.
//   POST /VersionStamps/ {info_id, version}
//                               — write one hdb_info row with a chosen version.

function infoTable() {
	return databases['system']['hdb_info'];
}

export class VersionStamps extends Resource {
	static loadAsInstance = false;

	async get() {
		const records = [];
		for await (const record of infoTable().search({ conditions: [] })) {
			records.push({
				info_id: record.info_id,
				data_version_num: record.data_version_num,
				hdb_version_num: record.hdb_version_num,
			});
		}
		records.sort((a, b) => a.info_id - b.info_id);
		return { records };
	}

	async post(query, body) {
		const b = body || query || {};
		const info_id = Number(b.info_id);
		await infoTable().put({ info_id, data_version_num: b.version, hdb_version_num: b.version });
		return { ok: true, info_id, version: b.version };
	}
}
