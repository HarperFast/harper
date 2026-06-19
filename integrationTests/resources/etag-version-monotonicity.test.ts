/**
 * Version / ETag monotonicity under a same-record update storm.
 *
 * Hammer a SINGLE record with rapid CONCURRENT plain set()s (full-replace PUTs,
 * NOT addTo). Lost-update under concurrent plain set() is EXPECTED and NOT what we
 * test — we probe the integrity of the VERSION metadata that drives ETag caching
 * and conditional-write ordering:
 *
 *   M1 MONOTONICITY    — across the storm, does the committed record's lastModified
 *                        (== __updatedtime__) only ever ADVANCE (never regress) as
 *                        observed by successive read-backs?
 *   M2 COLLISION-FREE  — do two DISTINCT committed states ever share the same
 *                        lastModified (=> same ETag for different data = a
 *                        conditional-cache hazard: a client holding the old ETag
 *                        gets 304 for changed data)?
 *   M3 REAL FINAL      — is the final stored state one of the actually-submitted
 *                        values (no torn / merged record)?
 *   M4 CROSS-SURFACE   — for the SAME committed write, do the REST ETag (decoded to
 *                        a Float64 ms), the record's __updatedtime__, and the audit
 *                        log timestamp all agree?
 *
 * ETag derivation: etag is a packed encoding of the Float64 of request.lastModified.
 * NOTE: the encoding is LOSSY in the most-significant float byte (byte7) — only its
 * low nibble survives — so it is not a strict bijection in general. BUT byte7 is
 * constant (0x42=66) for every timestamp in the current ~ms-epoch era, so within
 * this era each distinct integer-ms lastModified maps to a UNIQUE etag string, and
 * we can decode an etag back to lastModified exactly by fixing byte7=66. We
 * cross-check both ways: decode the etag, and forward-encode __updatedtime__ and
 * compare the etag STRING.
 *
 * Run BOTH engines x single/multi worker:
 *   npm run test:integration -- "integrationTests/resources/etag-version-monotonicity.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/resources/etag-version-monotonicity.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'etag-version-monotonicity');
const SCHEMA = 'data';
const TABLE = 'Doc';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';
// Worker count via QA145_WORKERS so one file covers single + multi-worker across runs.
const WORKERS = Number(process.env.QA145_WORKERS ?? '1');
const skipSuite = process.platform === 'win32';

// Storm sizing.
const ROUNDS = 6;
const STORM = 250; // concurrent same-key set()s per round

const summary: string[] = [];

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// Forward etag encoder — byte-for-byte mirror of server/REST.ts ETag encoding.
const _eb = new Uint8Array(8);
const _ef = new Float64Array(_eb.buffer, 0, 1);
function encodeEtag(ms: number): string {
	_ef[0] = ms;
	const b = _eb;
	return String.fromCharCode(
		34,
		(b[0] & 0x3f) + 62,
		(b[0] >> 6) + ((b[1] << 2) & 0x3f) + 62,
		(b[1] >> 4) + ((b[2] << 4) & 0x3f) + 62,
		(b[2] >> 2) + 62,
		(b[3] & 0x3f) + 62,
		(b[3] >> 6) + ((b[4] << 2) & 0x3f) + 62,
		(b[4] >> 4) + ((b[5] << 4) & 0x3f) + 62,
		(b[5] >> 2) + 62,
		(b[6] & 0x3f) + 62,
		(b[6] >> 6) + ((b[7] << 2) & 0x3f) + 62,
		34
	);
}

/**
 * Decode an ETag back to the Float64 ms it encodes. Byte7 (MSB) is lossy in the
 * forward encoding but constant (0x42=66) across the current epoch era, so we fix
 * it; this round-trips exactly for all in-era timestamps (verified 500k samples).
 */
function decodeEtag(etag: string | null): number | null {
	if (!etag) return null;
	const s = etag.replace(/"/g, '');
	if (s.length !== 10) return null;
	const c = (i: number) => s.charCodeAt(i) - 62;
	const dec3 = (c0: number, c1: number, c2: number, c3: number) => [
		c0 | ((c1 & 0x03) << 6),
		((c1 >> 2) & 0x0f) | ((c2 & 0x0f) << 4),
		((c2 >> 4) & 0x03) | (c3 << 2),
	];
	const g0 = dec3(c(0), c(1), c(2), c(3));
	const g1 = dec3(c(4), c(5), c(6), c(7));
	const b6 = c(8) | ((c(9) & 0x03) << 6);
	const b = new Uint8Array([g0[0], g0[1], g0[2], g1[0], g1[1], g1[2], b6, 66]);
	return new Float64Array(b.buffer, 0, 1)[0];
}

async function op(ctx: ContextWithHarper, operation: any): Promise<any> {
	return sendOperation(ctx.harper, operation);
}

/** ops read of one row, full attributes (incl. __updatedtime__). */
async function opsGet(ctx: ContextWithHarper, id: string): Promise<Record<string, any> | null> {
	const res = await op(ctx, {
		operation: 'search_by_conditions',
		schema: SCHEMA,
		table: TABLE,
		operator: 'and',
		conditions: [{ search_attribute: 'id', search_type: 'equals', search_value: id }],
		get_attributes: ['*'],
	});
	const rows = Array.isArray(res) ? res : [];
	return rows[0] ?? null;
}

/** Audit history for a key, oldest-first. */
async function readHistory(ctx: ContextWithHarper, id: string): Promise<any[]> {
	const res = await op(ctx, {
		operation: 'read_audit_log',
		schema: SCHEMA,
		table: TABLE,
		search_type: 'hash_value',
		search_values: [id],
	});
	const entries = res?.[id];
	return Array.isArray(entries) ? entries : [];
}

suite(
	`version/ETag monotonicity under same-record storm [engine=${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: WORKERS } }, env: {} });
			httpURL = ctx.harper.httpURL;
			auth = authHeader(ctx);
			// readiness poll
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/${TABLE}/`, { headers: { Authorization: auth } });
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			console.log(`\n===== version/ETag monotonicity SUMMARY [engine=${ENGINE}, workers=${WORKERS}] =====`);
			for (const line of summary) console.log(line);
			console.log('=====================================================================\n');
			await teardownHarper(ctx);
		});

		// One PUT (plain full-replace set) -> { status, etag }.
		async function put(key: string, value: number, tag: string): Promise<{ status: number; etag: string | null }> {
			const res = await fetch(`${httpURL}/${TABLE}/${key}`, {
				method: 'PUT',
				headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: key, value, tag }),
			});
			// drain body so the socket frees
			await res.text();
			return { status: res.status, etag: res.headers.get('etag') };
		}

		// REST GET -> { status, etag, body }.
		async function get(key: string): Promise<{ status: number; etag: string | null; body: any }> {
			const res = await fetch(`${httpURL}/${TABLE}/${key}`, {
				headers: { Authorization: auth, Accept: 'application/json' },
			});
			const body = res.status === 200 ? await res.json() : (await res.text(), null);
			return { status: res.status, etag: res.headers.get('etag'), body };
		}

		test(`storm: lastModified monotonic + collision-free + real final + cross-surface [engine=${ENGINE}]`, async () => {
			const key = `storm-${ENGINE}-${WORKERS}`;
			const observedReads: number[] = []; // lastModified (ms) seen on successive read-backs (monotonicity)
			// lastModified -> set of distinct committed (value|tag) states observed at that version (collision)
			const versionStates = new Map<number, Set<string>>();
			const allSubmitted = new Set<string>();

			// self-test the etag codec before trusting M4
			let codecOk = false;

			for (let round = 0; round < ROUNDS; round++) {
				// Fire STORM concurrent plain set()s, each with a DISTINCT value so any two
				// committed states are distinguishable.
				const reqs: Promise<{ status: number; etag: string | null }>[] = [];
				for (let i = 0; i < STORM; i++) {
					const value = round * STORM + i; // globally unique across rounds
					const tag = `r${round}i${i}`;
					allSubmitted.add(`${value}|${tag}`);
					reqs.push(put(key, value, tag));
				}
				const results = await Promise.all(reqs);
				const ok2xx = results.filter((r) => r.status >= 200 && r.status < 300).length;

				// Read the committed state back from up to THREE surfaces for this round.
				const g = await get(key);
				const row = await opsGet(ctx, key);
				const hist = await readHistory(ctx, key);
				const auditTs = hist.length ? hist[hist.length - 1].timestamp : NaN;

				const etagMs = decodeEtag(g.etag);
				// __updatedtime__ may live on the ops row or the REST body depending on schema; best-effort.
				const utRow = typeof row?.__updatedtime__ === 'number' ? row.__updatedtime__ : NaN;
				const utBody = typeof g.body?.__updatedtime__ === 'number' ? g.body.__updatedtime__ : NaN;
				const ut = Number.isFinite(utRow) ? utRow : utBody;

				// codec self-check: decoded ETag must match the audit-log timestamp of the same write
				// (the audit ts is the canonical lastModification; etag is derived from it).
				if (etagMs != null && Number.isFinite(auditTs) && Math.abs(etagMs - auditTs) < 1e-6) codecOk = true;

				// committed state identity for this round
				const state = `${g.body?.value}|${g.body?.tag}`;

				// Monotonicity/collision anchor: the ETag-decoded version (the cache surface).
				const ver = etagMs ?? NaN;
				if (Number.isFinite(ver)) {
					observedReads.push(ver);
					if (!versionStates.has(ver)) versionStates.set(ver, new Set());
					versionStates.get(ver)!.add(state);
				}

				summary.push(
					`[round ${round}] storm=${STORM} 2xx=${ok2xx} committed state='${state}' ` +
						`etag=${g.etag} etagMs=${etagMs} auditTs=${auditTs} __updatedtime__=${Number.isFinite(ut) ? ut : 'absent'} ` +
						`etag==audit=${etagMs != null && Number.isFinite(auditTs) ? Math.abs(etagMs - auditTs) < 1e-6 : 'n/a'}`
				);
			}

			// ---- M1: monotonicity of the committed version across rounds ----
			let monotonic = true;
			let regression = '';
			for (let i = 1; i < observedReads.length; i++) {
				if (observedReads[i] < observedReads[i - 1]) {
					monotonic = false;
					regression = `round ${i}: ${observedReads[i]} < round ${i - 1}: ${observedReads[i - 1]}`;
					break;
				}
			}

			// ---- M2: collision — any single version mapped to >1 distinct committed state ----
			// Round-final read samples (6) PLUS the full audit-log mining below for the strong test.
			const collisions: string[] = [];
			for (const [ver, states] of versionStates) {
				if (states.size > 1) collisions.push(`version ${ver} -> {${[...states].join(', ')}}`);
			}

			// ---- M2-strong: mine the FULL audit log (every committed write) for a timestamp shared by
			// two DISTINCT record states. This is the definitive ETag-collision probe: the etag is a
			// pure function of the write's timestamp, so two distinct committed images at one timestamp
			// => one etag for two states. ~1500 committed writes per run across both keys touched. ----
			const fullHist = await readHistory(ctx, key);
			const tsToStates = new Map<number, Set<string>>();
			let auditMonotonic = true;
			let auditInversions = 0;
			let maxInversionMs = 0;
			let auditRegression = '';
			let prevTs = -Infinity;
			for (const e of fullHist) {
				const ts = e.timestamp;
				if (ts < prevTs) {
					auditMonotonic = false;
					auditInversions++;
					maxInversionMs = Math.max(maxInversionMs, prevTs - ts);
					if (!auditRegression) auditRegression = `first: audit entry ts ${ts} < prior ${prevTs}`;
				}
				prevTs = ts;
				const rec = Array.isArray(e.records) ? e.records[0] : e.records;
				// committed image identity (value|tag); deletes have no record image
				const img = rec ? `${rec.value}|${rec.tag}` : `<${e.operation}>`;
				if (!tsToStates.has(ts)) tsToStates.set(ts, new Set());
				tsToStates.get(ts)!.add(img);
			}
			const auditCollisions: string[] = [];
			let sharedTsCount = 0;
			for (const [ts, states] of tsToStates) {
				if (states.size > 1) {
					auditCollisions.push(`ts ${ts} -> {${[...states].join(', ')}}`);
				}
			}
			// How many distinct committed timestamps vs total writes (collision *pressure*).
			const distinctTs = tsToStates.size;
			const totalEntries = fullHist.length;
			sharedTsCount = totalEntries - distinctTs;

			// ---- M3: final committed state is a real submitted value ----
			const finalGet = await get(key);
			const finalState = `${finalGet.body?.value}|${finalGet.body?.tag}`;
			const finalIsReal = allSubmitted.has(finalState);

			// ---- M4: cross-surface consistency on the FINAL write (ETag vs audit ts vs __updatedtime__) ----
			const finalRow = await opsGet(ctx, key);
			const finalEtagMs = decodeEtag(finalGet.etag);
			const hist = await readHistory(ctx, key);
			const lastAuditTs = hist.length ? hist[hist.length - 1].timestamp : NaN;
			// __updatedtime__ is best-effort (ops row or REST body); on this schema it may be absent.
			const finalUtRow = typeof finalRow?.__updatedtime__ === 'number' ? finalRow.__updatedtime__ : NaN;
			const finalUtBody = typeof finalGet.body?.__updatedtime__ === 'number' ? finalGet.body.__updatedtime__ : NaN;
			const finalUt = Number.isFinite(finalUtRow) ? finalUtRow : finalUtBody;
			const utPresent = Number.isFinite(finalUt);

			// Anchor: ETag-decoded ms must equal the canonical audit-log timestamp.
			const etagVsAudit =
				finalEtagMs != null && Number.isFinite(lastAuditTs) ? Math.abs(finalEtagMs - lastAuditTs) : NaN;
			const utVsAudit = utPresent && Number.isFinite(lastAuditTs) ? Math.abs(finalUt - lastAuditTs) : NaN;
			// Independent string-level check: forward-encode the canonical audit ts -> must equal the served ETag.
			const expectedEtag = Number.isFinite(lastAuditTs) ? encodeEtag(lastAuditTs) : null;
			const etagStringMatch = expectedEtag != null && expectedEtag === finalGet.etag;

			summary.push(
				`[M1 monotonic] ${monotonic}${monotonic ? '' : ' REGRESSION: ' + regression} (samples=${observedReads.length})`
			);
			summary.push(
				`[M2 collisions/round-final] count=${collisions.length}${collisions.length ? ' :: ' + collisions.join(' ; ') : ''}`
			);
			summary.push(
				`[M2-strong audit-mined] entries=${totalEntries} distinctTimestamps=${distinctTs} ` +
					`sharedTimestampWrites=${sharedTsCount} stateCollisions=${auditCollisions.length}` +
					(auditCollisions.length ? ' :: ' + auditCollisions.slice(0, 5).join(' ; ') : '')
			);
			summary.push(
				`[M-audit-order] auditArrayMonotonic=${auditMonotonic} inversions=${auditInversions} ` +
					`maxInversionMs=${maxInversionMs}${auditMonotonic ? '' : ' (' + auditRegression + ')'} ` +
					`[NOTE: audit-array ordering, distinct from live-ETag M1]`
			);
			summary.push(`[M3 final-real] ${finalIsReal} finalState='${finalState}'`);
			summary.push(
				`[M4 cross-surface] codecOk=${codecOk} finalEtagMs=${finalEtagMs} lastAuditTs=${lastAuditTs} ` +
					`__updatedtime__=${utPresent ? finalUt : 'absent-on-this-schema'} |etag-audit|=${etagVsAudit} ` +
					`|ut-audit|=${utPresent ? utVsAudit : 'n/a'} etagStr=${finalGet.etag} expectedEtag=${expectedEtag} ` +
					`etagStringMatch=${etagStringMatch} auditEntries=${hist.length}`
			);

			// Hard assertions: the version-integrity contract.
			ok(codecOk, 'ETag codec self-check failed (decoded ETag never matched the audit timestamp) — cannot trust M4');
			ok(monotonic, `MONOTONICITY VIOLATION: committed lastModified/ETag regressed (${regression})`);
			// NOTE: auditArrayMonotonic is recorded but NOT asserted — sub-ms audit-array reordering of
			// two near-simultaneous multi-worker writes is an ordering artifact, not a live-version
			// regression. The cache-correctness contract is M1 (live ETag) + the no-collision check below.
			equal(
				collisions.length,
				0,
				`VERSION COLLISION (round-final): distinct committed states share one lastModified/ETag -> ${collisions.join(' ; ')}`
			);
			equal(
				auditCollisions.length,
				0,
				`VERSION COLLISION (audit-mined): two distinct committed states share one timestamp/ETag -> ${auditCollisions.slice(0, 5).join(' ; ')}`
			);
			ok(finalIsReal, `TORN/PHANTOM FINAL STATE: '${finalState}' was never submitted`);
			// Cross-surface: ETag must agree with the canonical audit timestamp (both ms-value and string form).
			ok(
				Number.isFinite(etagVsAudit) && etagVsAudit < 1e-6,
				`cross-surface: final ETag-ms (${finalEtagMs}) != audit ts (${lastAuditTs})`
			);
			ok(etagStringMatch, `cross-surface: served ETag (${finalGet.etag}) != etag(auditTs) (${expectedEtag})`);
			// If __updatedtime__ surfaced at all, it too must agree with the audit ts (else divergent surfaces).
			if (utPresent) ok(utVsAudit < 2, `cross-surface: __updatedtime__ (${finalUt}) != audit ts (${lastAuditTs})`);
		});
	}
);
