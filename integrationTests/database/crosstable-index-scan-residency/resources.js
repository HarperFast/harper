// QA-656c — minimal ARM1 (warm/cold) hypothesis test, follow-up to QA-653/QA-656/QA-656b
// (GH#1881, source:gh:1881). Same SeedWave/Drain/IndexStats endpoint shapes as QA-656b, kept
// as-is since they are cheap and let scan=full / scan=rawindex distinguish an index shortfall
// from a genuine missing row.
//
//   POST /SeedWave/ { table, wave, keys, perKeyPerWave, bodyKb } — ONE transaction, writes
//     `keys` x `perKeyPerWave` rows for a SINGLE wave. Calling once per wave scatters each
//     key's index entries across many on-disk sorted runs once the WriteBufferManager is
//     capped (forces memtable flushes).
//   GET  /IndexStats/?table=X&attribute=repositoryId — RocksDB L0-file-count proxy for "how
//     many un-merged sorted runs" (from QA-638), proving (not assuming) the precondition.
//   GET  /Drain/?tables=A,B&scan=index|full|rawindex&key=repo-N — for EACH table in `tables`
//     order, WITHIN THIS ONE REQUEST, counts rows matching repositoryId===key:
//       scan=index    — Resource-level indexed AND-equals search (the exact QA-653/#1881
//                        read path; joins through the primary record).
//       scan=full     — unconditioned scan filtered in JS (index-independent oracle; proves
//                        base rows are intact regardless of what the index scan reports).
//       scan=rawindex — reads table.indices.<attribute> DIRECTLY via getRange(), no primary
//                        join at all; can reveal a dangling/short index entry set directly.
//     A single-table call to /Drain/ IS the "solo warm read" used to warm a table before it
//     ever appears in a combo — no separate warm endpoint is needed.

function getTable(tableName) {
	return databases['qa656c'][tableName];
}

function bodyOf(kb) {
	return 'x'.repeat(1024).repeat(kb);
}

function qp(query, name, def) {
	const v = query && (query.get ? query.get(name) : query[name]);
	return v == null ? def : v;
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

// POST /Flush/ { table? } — force every RocksDB column family sharing this schema's directory
// to flush its memtable to a new SST file, atomically (QA-772 technique: replaces the
// pathological writeBufferManagerSize cap, which hangs this fixture's seed on this machine).
export class Flush extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const table = getTable(b.table || 'WarmA');
		if (typeof table.primaryStore.flush !== 'function')
			throw new Error('Flush control invalid: primaryStore.flush() not available (not RocksDB?)');
		await table.primaryStore.flush();
		return { ok: true };
	}
}

export class IndexStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableName = qp(query, 'table', 'WarmA');
		const attribute = qp(query, 'attribute', 'repositoryId');
		const table = getTable(tableName);
		if (!table) throw new Error(`unknown table ${tableName}`);
		const indexStore = table.indices && table.indices[attribute];
		function statsOf(store) {
			if (!store || typeof store.getDBIntProperty !== 'function') return { unavailable: true };
			// getDBIntProperty('rocksdb.num-files-at-level0') is unreliable on this build (QA-638);
			// parse the "Level 0" row's file count out of the STRING property 'rocksdb.levelstats'
			// instead, which is confirmed to work.
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
		return { table: tableName, attribute, index: statsOf(indexStore) };
	}
}

export class Drain extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const tableNames = String(qp(query, 'tables', 'WarmA,ColdB'))
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const key = qp(query, 'key', 'repo-7');
		const scan = qp(query, 'scan', 'index');
		const attribute = qp(query, 'attribute', 'repositoryId');

		const counts = {};
		for (const tableName of tableNames) {
			const table = getTable(tableName);
			if (!table) throw new Error(`unknown table ${tableName}`);
			let count = 0;
			if (scan === 'full') {
				for await (const r of table.search({ conditions: [] })) {
					if (r.repositoryId === key) count++;
				}
			} else if (scan === 'rawindex') {
				const index = table.indices[attribute];
				const entries = [
					...index.getRange({ start: key, end: key, inclusiveEnd: true, values: true, snapshot: false }),
				].filter((entry) => entry.key === key);
				count = entries.length;
			} else {
				for await (const _r of table.search({
					operator: 'and',
					conditions: [{ attribute, comparator: 'equals', value: key }],
				})) {
					count++;
				}
			}
			counts[tableName] = count;
		}
		return { order: tableNames, key, scan, counts };
	}
}
