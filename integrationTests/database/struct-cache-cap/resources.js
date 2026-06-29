// QA-175 — direct typedStructs introspection resource.
//
// The structon/msgpackr encoder keeps an append-only `typedStructs` array per
// encoder instance, pinned on the long-lived primary store. RecordEncoder caps it
// at maxOwnStructures=256. We can't read that array from the test process (Harper
// runs in a child worker), so we expose it over HTTP from INSIDE a worker.
//
// A table's primary store is reachable as `tables.<Name>.primaryStore`; the encoder
// is `primaryStore.encoder` (a RecordEncoder extending StructonEncoder), and its
// live structure dictionary is `encoder.typedStructs`. We report `.length` plus the
// configured cap (`maxOwnStructures`) for both tables.
//
// NOTE: each Harper http worker is a separate process with its OWN encoder instance,
// so the count we read is for whichever worker served this request. To make the
// reading deterministic the test restarts to a single http worker before measuring.

function readStructStats(name) {
	const table = tables[name];
	const store = table && table.primaryStore;
	const enc = store && store.encoder;
	const ts = enc && enc.typedStructs;
	// classic msgpackr shared structures (the non-typed path) — reported for contrast.
	const classic = enc && enc.structures;
	return {
		table: name,
		hasStore: !!store,
		hasEncoder: !!enc,
		// typedStructs.length — the live per-encoder TYPED structure-dictionary size
		// (the array that grew to ~15,700 and OOM'd in the field incident).
		typedStructs: Array.isArray(ts) ? ts.length : ts ? Number(ts.length) || 0 : null,
		// classic shared structures.length — keys on the field-NAME set; should stay ~1.
		classicStructures: Array.isArray(classic) ? classic.length : null,
		// transitions are tracked as a property on the typedStructs array (structon).
		hasTransitions: !!(ts && ts.transitions),
		// is the typed/random-access path actually engaged on this store?
		randomAccessStructure: store ? (store.randomAccessStructure ?? null) : null,
		// the configured cap (RecordEncoder pins 256). Confirms the fix is wired.
		maxOwnStructures: enc ? (enc.maxOwnStructures ?? null) : null,
		pid: process.pid,
	};
}

export class StructStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const which = (query.get && query.get('table')) || null;
		if (which) return readStructStats(which);
		// default: report both tables under test
		return {
			WidthHom: readStructStats('WidthHom'),
			WidthHet: readStructStats('WidthHet'),
		};
	}
}

// Diagnostic: encode N width-varied records THROUGH the readable worker's encoder
// (the inner randomAccess store's encoder) to confirm typedStructs grows in-worker.
// GET /EncodeProbe/?table=WidthHet&count=2000
export class EncodeProbe extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = (query.get && query.get('table')) || 'WidthHet';
		const count = Number((query.get && query.get('count')) || 2000);
		const table = tables[name];
		let store = table && table.primaryStore;
		// walk to the store whose encoder is on the randomAccess path
		let enc = store && store.encoder;
		let s = store;
		for (let i = 0; i < 4 && s; i++) {
			if (s.randomAccessStructure && s.encoder) {
				enc = s.encoder;
				store = s;
				break;
			}
			s = s.store || s.db || s._store || null;
		}
		if (!enc || typeof enc.encode !== 'function') return { error: 'no encoder', name };
		// mode=width (default): same field NAMES, value WIDTH varies (the QA-175 premise)
		// mode=keys: field NAME set varies per record (the contrast — key-set heterogeneity)
		const mode = (query.get && query.get('mode')) || 'width';
		const before = Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null;
		const palettesInt = [5, 200, 30000, 2_000_000_000, 9_000_000_000_000, Number.MAX_SAFE_INTEGER];
		const palettesStrLen = [2, 8, 32, 128, 512, 2048, 6000];
		const KEY_POOL = Array.from({ length: 60 }, (_, i) => 'k' + i);
		let a = 0x9e3779b9 ^ count;
		const rng = () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		// sample the typedStructs growth curve so we can see plateau-vs-climb
		const trace = [];
		for (let i = 0; i < count; i++) {
			let rec;
			if (mode === 'keys') {
				// random subset of field NAMES — this is what actually mints distinct structs
				rec = { id: String(i) };
				const kc = 2 + Math.floor(rng() * 10);
				for (let j = 0; j < kc; j++) rec[KEY_POOL[Math.floor(rng() * KEY_POOL.length)]] = i % 5;
			} else {
				// same field names {id,n,f,s}; only VALUE WIDTH varies
				rec = {
					id: String(i),
					n: palettesInt[i % palettesInt.length] + (i % 7),
					f: 1.23456789012345 + (i % 11) / 1e6,
					s: String.fromCharCode(97 + (i % 26)).repeat(palettesStrLen[i % palettesStrLen.length]),
				};
			}
			try {
				enc.encode(rec);
			} catch {
				/* ignore */
			}
			if (i % Math.max(1, Math.floor(count / 10)) === 0)
				trace.push(Array.isArray(enc.typedStructs) ? enc.typedStructs.length : -1);
		}
		const after = Array.isArray(enc.typedStructs) ? enc.typedStructs.length : null;
		trace.push(after);
		return {
			name,
			mode,
			storeCtor: store && store.constructor && store.constructor.name,
			randomAccessStructure: store ? (store.randomAccessStructure ?? null) : null,
			maxOwnStructures: enc.maxOwnStructures ?? null,
			typedStructsBefore: before,
			typedStructsAfter: after,
			growthTrace: trace,
			encoded: count,
			pid: process.pid,
		};
	}
}

// Diagnostic: dump the shape of tables.<name>.primaryStore + its encoder so we can
// locate where typedStructs actually lives. GET /StructProbe/?table=WidthHet
export class StructProbe extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = (query.get && query.get('table')) || 'WidthHet';
		const table = tables[name];
		const store = table && table.primaryStore;
		const enc = store && store.encoder;
		function keysOf(o) {
			if (!o) return null;
			const own = Object.getOwnPropertyNames(o);
			const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {});
			return { own: own.slice(0, 60), proto: proto.slice(0, 60) };
		}
		// also try walking the store chain (handleLocalTimeForGets may wrap the real store)
		const storeChain = [];
		let s = store;
		for (let i = 0; i < 4 && s; i++) {
			storeChain.push({
				ctor: s.constructor && s.constructor.name,
				hasEncoder: !!s.encoder,
				encTypedStructs: s.encoder && Array.isArray(s.encoder.typedStructs) ? s.encoder.typedStructs.length : null,
				encStructures: s.encoder && Array.isArray(s.encoder.structures) ? s.encoder.structures.length : null,
				randomAccessStructure: s.randomAccessStructure ?? null,
			});
			s = s.store || s.db || s._store || null;
		}
		return {
			table: name,
			tableKeys: keysOf(table),
			storeCtor: store && store.constructor && store.constructor.name,
			storeKeys: keysOf(store),
			encoderCtor: enc && enc.constructor && enc.constructor.name,
			encoderKeys: keysOf(enc),
			storeChain,
			pid: process.pid,
		};
	}
}
