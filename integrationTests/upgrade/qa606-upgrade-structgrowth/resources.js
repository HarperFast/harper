// QA-606 — legacy-v4-origin (upgraded) dataset vs fresh-install control: does the encoder's
// typedStructs count PLATEAU under a width-heterogeneous NEW-write workload once
// randomAccessFields is enabled, the way a fresh-install table does (QA-598), or does a
// legacy-origin dict grow UNBOUNDED (the #1453-class escape QA-478 never exercised because it
// only measured decode, never drove new writes with randomAccessFields:true active)?
//
// This component is dropped into the dataRootDir's components/ folder AFTER the legacy
// (v4.7.34) instance is stopped and BEFORE current-main is first started on the same
// dataRootDir — mirrors QA-478's qa478-probe component. It never runs under the legacy binary.
//
// GET /StructReport606/?table=WidthDrift|FreshControl — per-table randomAccess-mode +
//   typed/classic structure counts (QA-478/QA-231 StructReport pattern), used as the
//   precondition check that randomAccessFields actually took effect on the migrated table.
//
// GET /ScanVerify606/?table=... — full scan; count + nullValues (undecodable rows).
//
// GET /StatsProbe606/ — forces a full-table DECODE scan (getRange walk — QA-598 found writes
//   alone don't mint typedStructs, only decode does) of BOTH WidthDrift and FreshControl, then
//   reports each table's real randomAccess encoder typedStructs.length + a transitions trie
//   node count (retention proxy) + heapUsed/rss/pid. This is the growth-curve probe.

function findEncoder(table) {
	const store = table && table.primaryStore;
	let s = store;
	for (let i = 0; i < 6 && s; i++) {
		if (s.randomAccessStructure && s.encoder) return { store: s, enc: s.encoder };
		s = s.store || s.db || s._store || null;
	}
	// fallback: whatever we have, even if not (yet) random-access
	return { store, enc: store && store.encoder };
}

function resolveTable(name) {
	return tables[name] || (databases.data && databases.data[name]);
}

function countTransitionNodes(node, seen, budget) {
	if (!node || typeof node !== 'object' || budget.n <= 0) return 0;
	if (seen.has(node)) return 0;
	seen.add(node);
	let count = 1;
	budget.n--;
	for (const key of Object.keys(node)) {
		if (budget.n <= 0) break;
		count += countTransitionNodes(node[key], seen, budget);
	}
	return count;
}

/** Full-table getRange walk — forces decode of every stored record (the mint-triggering path;
 *  QA-598 found bulk `insert` writes alone leave typedStructs at 0). */
function scanTable(table) {
	let records = 0;
	if (table && table.primaryStore) {
		for (const entry of table.primaryStore.getRange({})) {
			if (entry && entry.value !== undefined) records++;
		}
	}
	return records;
}

function tableStats(name) {
	const table = resolveTable(name);
	const scanned = scanTable(table);
	const { store, enc } = findEncoder(table);
	const typedStructsLen = enc && Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null;
	let transitionNodes = null;
	if (enc && enc.typedStructs && enc.typedStructs.transitions) {
		transitionNodes = countTransitionNodes(enc.typedStructs.transitions, new Set(), { n: 200_000 });
	}
	return {
		randomAccessStructure: store ? (store.randomAccessStructure ?? null) : null,
		classicStructures: enc && Array.isArray(enc.structures) ? enc.structures.length : null,
		maxOwnStructures: enc ? (enc.maxOwnStructures ?? null) : null,
		typedStructsLen,
		transitionNodes,
		scannedRecords: scanned,
	};
}

export class StructReport606 extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = (query?.get && query.get('table')) || 'WidthDrift';
		const table = resolveTable(name);
		if (!table) return { error: 'table not found', table: name, have: Object.keys(tables || {}) };
		const { store, enc } = findEncoder(table);
		return {
			pid: process.pid,
			heapUsedMB: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
			table: name,
			randomAccessStructure: store ? (store.randomAccessStructure ?? null) : null,
			typedStructs: enc && Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null,
			classicStructures: enc && Array.isArray(enc.structures) ? enc.structures.length : null,
			maxOwnStructures: enc ? (enc.maxOwnStructures ?? null) : null,
			storeCtor: store?.constructor?.name,
		};
	}
}

export class ScanVerify606 extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = (query?.get && query.get('table')) || 'WidthDrift';
		const table = resolveTable(name);
		if (!table) return { error: 'table not found', table: name };
		let count = 0;
		let nullValues = 0;
		for await (const rec of table.search({})) {
			count++;
			if (rec == null || rec.id == null) nullValues++;
		}
		return { count, nullValues };
	}
}

export class StatsProbe606 extends Resource {
	static loadAsInstance = false;
	async get() {
		try {
			if (typeof global.gc === 'function') {
				global.gc();
				global.gc();
			}
		} catch {
			/* no-op if not exposed */
		}
		const WidthDrift = tableStats('WidthDrift');
		const FreshControl = tableStats('FreshControl');
		const mem = process.memoryUsage();
		return {
			pid: process.pid,
			heapUsed: mem.heapUsed,
			rss: mem.rss,
			WidthDrift,
			FreshControl,
		};
	}
}
