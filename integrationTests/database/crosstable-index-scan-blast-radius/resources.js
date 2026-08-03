// QA-631 — F-158 (GH #1881) blast-radius characterization: cross-table secondary-index scan
// miss within a single request, RocksDB-only (confirmed by qa629-crosstable-index-miss).
// Precondition (sharper than the issue's "write in waves" framing): the queried table's rows
// for the slot span MORE THAN ONE flushed on-disk sorted run.
//
// QA-774: converted from the storage.rocks.writeBufferManagerSize: 8MB cap technique to
// QA-772's flush-forcing technique (that WBM cap now HANGS this fixture's seed on this
// machine). Seeding is waved as before; each wave is followed by an explicit `/Flush/` call
// instead of relying on WBM backpressure. RocksDB's atomic_flush=true means one flush() call
// seals that wave's memtable into its own SST for the primary AND every index CF, across all
// four tables (they share the "qa631-blast" schema directory).
//
// Endpoints:
//   POST /SeedWave/ { table, wave, keys, perKeyPerWave, bodyKb } — ONE transaction, writes
//     `keys` x `perKeyPerWave` rows for a SINGLE wave (every key touched every wave). Call once
//     per wave to scatter each key's index entries across many sorted runs once flushed.
//   POST /Flush/ — force every RocksDB column family sharing this schema's directory to flush
//     its memtable to a new SST file, atomically. Call once between seeding waves.
//   GET  /IndexStats/?table=X&attribute=repositoryId — RocksDB level-0 file count (parsed from
//     `rocksdb.levelstats`) for both the primary store and the named index CF. Used to arm the
//     oracle precondition.
//   GET  /Drain/?steps=A:full,B:index,C:index&key=repo-N — for EACH step IN ORDER, WITHIN THIS
//     ONE REQUEST, counts rows with repositoryId===key via an indexed AND-equals search
//     (scan=index) or an unconditioned full scan filtered in JS (scan=full, the
//     index-independent oracle). A table may appear more than once (used for the "does a
//     full-scan touch heal a later index read of the same table" question). Returns
//     { steps: [{table, scan, count}], key }.
function getTable(tableName) {
	return databases['qa631-blast'][tableName];
}

function bodyOf(kb) {
	return 'x'.repeat(1024).repeat(kb);
}

// GET /Probe/ -> readiness poll target (component pre-installed; no restart needed).
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

export class SeedWave extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table;
		const wave = Number(b.wave);
		const keys = Number(b.keys) || 50;
		const perKeyPerWave = Number(b.perKeyPerWave) || 5;
		const bodyKb = Number(b.bodyKb) || 4;
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);
		const payload = bodyOf(bodyKb);
		let count = 0;
		for (let r = 0; r < keys; r++) {
			for (let i = 0; i < perKeyPerWave; i++) {
				const n = wave * perKeyPerWave + i;
				await table.put({ id: `${tableName}-r${r}-n${n}`, repositoryId: `repo-${r}`, n, body: payload });
				count++;
			}
		}
		return { ok: true, table: tableName, wave, count };
	}
}

// POST /Flush/ -> force every RocksDB column family sharing this schema's directory to flush
// its memtable to a new SST file, atomically (see header). Call once between seeding waves.
//
// RocksDB level-0 file count proxy for "how many un-merged sorted runs", carried over from
// qa772-flush-forcing (getDBIntProperty('rocksdb.num-files-at-level0') reliably returns
// undefined on this @harperfast/rocksdb-js build; getDBProperty('rocksdb.levelstats') is a
// string property that DOES work, so parse the "Level 0" row's file count out of it instead).
function statsOf(store) {
	if (!store || typeof store.getDBIntProperty !== 'function') return { unavailable: true };
	let levelStats;
	try {
		levelStats = store.getDBProperty && store.getDBProperty('rocksdb.levelstats');
	} catch (e) {
		levelStats = `error: ${e.message}`;
	}
	let l0Files = null;
	if (typeof levelStats === 'string') {
		const m = levelStats.match(/^\s*0\s+(\d+)/m);
		if (m) l0Files = Number(m[1]);
	}
	let numEntries;
	try {
		numEntries = store.getDBIntProperty('rocksdb.estimate-num-keys');
	} catch {
		/* not fatal */
	}
	return { l0Files, numEntries, levelStats };
}

function statsForTable(tableName, attribute) {
	const table = getTable(tableName);
	if (!table) throw new Error(`unknown table ${tableName}`);
	return { primary: statsOf(table.primaryStore), index: statsOf(table.indices && table.indices[attribute]) };
}

// POST /Flush/ { statsFor?: [{table, attribute}] } — flush, then OPTIONALLY compute levelstats
// for the given table/attribute pairs in the SAME server-side call, immediately after the
// flush() await resolves. This closes the race window against RocksDB's background compaction
// thread: a separate /IndexStats/ GET after this call incurs an extra HTTP round-trip, which
// was empirically enough time for compaction to already merge L0 away (observed: with 20 waves
// and the default level0_file_num_compaction_trigger=4, L0 lands on a 20 % 4 === 0 boundary
// right when the last wave's flush completes, so ANY added delay before reading levelstats
// risks catching post-compaction state instead of the pre-compaction sorted-run count this
// fixture needs to arm the oracle).
export class Flush extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable('TableA');
		if (typeof t.primaryStore.flush !== 'function')
			throw new Error('QA-631 Flush control invalid: primaryStore.flush() not available (not RocksDB?)');
		await t.primaryStore.flush();
		const stats = {};
		if (Array.isArray(b.statsFor)) {
			for (const { table: tableName, attribute } of b.statsFor) {
				stats[tableName] = statsForTable(tableName, attribute);
			}
		}
		return { ok: true, stats };
	}
}

// GET /IndexStats/?table=X&attribute=repositoryId — same stats, standalone (used outside the
// tight post-flush window, e.g. for informational post-hoc inspection).
export class IndexStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = (query && (query.get ? query.get('table') : query.table)) || 'TableA';
		const attribute = (query && (query.get ? query.get('attribute') : query.attribute)) || 'repositoryId';
		const { primary, index } = statsForTable(tableName, attribute);
		return { table: tableName, attribute, primary, index };
	}
}

export class Drain extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const q = (name, def) => {
			const v = query && (query.get ? query.get(name) : query[name]);
			return v == null ? def : v;
		};
		const stepsRaw = String(q('steps', 'A:index'));
		const key = q('key', 'repo-7');
		const steps = stepsRaw
			.split(',')
			.map((s) => {
				const [table, scan] = s.trim().split(':');
				return { table, scan: scan || 'index' };
			})
			.filter((s) => s.table);

		const results = [];
		for (const { table: tableName, scan } of steps) {
			const table = getTable(tableName);
			if (!table) throw new Error(`unknown table ${tableName}`);
			let count = 0;
			// Track which table each returned row actually came from (by its id prefix). #1881's
			// worse outcome is a read resolved against a foreign column family returning a SIBLING
			// TABLE's row at the expected cardinality — invisible to a count, visible here.
			const seen = new Set();
			if (scan === 'full') {
				for await (const r of table.search({ conditions: [] })) {
					if (r.repositoryId === key) {
						count++;
						seen.add(String(r.id).split('-')[0]);
					}
				}
			} else {
				for await (const r of table.search({
					operator: 'and',
					conditions: [{ attribute: 'repositoryId', comparator: 'equals', value: key }],
				})) {
					count++;
					seen.add(String(r.id).split('-')[0]);
				}
			}
			results.push({ table: tableName, scan, count, owners: [...seen].sort() });
		}
		return { steps: results, key };
	}
}
