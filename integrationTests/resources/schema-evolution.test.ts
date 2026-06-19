/**
 * Schema evolution of @indexed / @relationship on a POPULATED table.
 *
 * Seed Author (parent) + Book (child) with data FIRST, then evolve the schema in
 * place via set_component_file (rewrite schema.graphql) + restart_service
 * http_workers, and verify the PRE-EXISTING rows behave correctly after each step.
 *
 * Model: Author 1──* Book (Book.authorId). Deterministic seed so every expected
 * id-set is computable in-test.
 *
 * Evolution steps (each: edit schema -> restart -> verify over old+new rows):
 *   S1 ADD @indexed on Book.genre (was declared-but-unindexed) -> does search_by_value
 *      on the new index BACKFILL every pre-existing matching row? (index == in-test
 *      expected == full-scan via search_by_conditions).
 *   S2 ADD @relationship Author.books (to: authorId) + Book.author (from: authorId)
 *      referencing PRE-EXISTING rows -> do parent->child and child->parent edges
 *      RESOLVE over rows written before the relationship existed?
 *   S3 REMOVE @indexed (Book.tag) AND REMOVE @relationship (Author.tagBooks) ->
 *      are stale index entries / dangling edge resolutions cleaned up, or do they
 *      linger (ghost index hits via search_by_value on the now-unindexed attr;
 *      phantom edge in REST/GraphQL selecting the removed relationship)?
 *   S4 RETYPE Book.year String->Int over coercible ("2001") and non-coercible
 *      ("MMXXIV") existing values -> crash, silent data loss, or clean read?
 *
 * Mechanism: set_component_file (schema.graphql) + restart_service http_workers
 * (re-poll readiness). sendOperation/.expect(200) throws on
 * non-200 — for expected-error paths we use raw fetch / no .expect.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'schema-evolution');
const PROJECT = 'schema-evolution';
const SCHEMA = 'data';

const skipSuite = process.platform === 'win32';

// --- deterministic seed ----------------------------------------------------------------
const AUTHORS = 20;
const BOOKS_PER_AUTHOR = 25; // 500 books total
const GENRES = ['scifi', 'fantasy', 'mystery', 'romance', 'history']; // 5 buckets
const REGIONS = ['na', 'eu', 'apac'];

const authorId = (a: number) => `au-${a}`;
const bookId = (a: number, b: number) => `bk-${a}-${b}`;
const genreFor = (a: number, b: number) => GENRES[(a * 7 + b) % GENRES.length];
// tag holds an AUTHOR id so Author.tagBooks = @relationship(to: tag) actually resolves
// to a non-empty edge set BEFORE removal (gives the S3 phantom-edge probe real teeth).
// Books of author a are tagged with author ((a+1)%AUTHORS)'s id -> a clean cross-link.
const tagFor = (a: number, _b: number) => authorId((a + 1) % AUTHORS);
const yearStrFor = (a: number, b: number) => {
	// Most years are coercible numeric strings; a deterministic minority are NOT.
	if ((a * 3 + b) % 11 === 0) return 'MMXXIV'; // non-coercible roman-ish
	return String(1990 + ((a * 5 + b) % 35)); // "1990".."2024"
};

// --- schema builder: toggle features on/off so each step is a controlled edit ----------
interface SchemaOpts {
	genreIndexed: boolean; // S1
	authorBooksRel: boolean; // S2 (Author.books to:authorId + Book.author from:authorId)
	tagIndexed: boolean; // S3 removes
	tagBooksRel: boolean; // S3 removes (Author.tagBooks to:tag)
	yearInt: boolean; // S4 retype
}
function genSchema(o: SchemaOpts): string {
	const authorRel = o.authorBooksRel ? '\n\tbooks: [Book] @relationship(to: authorId)' : '';
	const tagRel = o.tagBooksRel ? '\n\ttagBooks: [Book] @relationship(to: tag)' : '';
	const genreLine = `genre: String${o.genreIndexed ? ' @indexed' : ''}`;
	const tagLine = `tag: ID${o.tagIndexed ? ' @indexed' : ''}`;
	const yearLine = `year: ${o.yearInt ? 'Int' : 'String'}`;
	const bookAuthorRel = o.authorBooksRel ? '\n\tauthor: Author @relationship(from: authorId)' : '';
	return [
		`type Author @table @export {`,
		`\tid: ID @primaryKey`,
		`\tname: String`,
		`\tregion: String @indexed${authorRel}${tagRel}`,
		`}`,
		``,
		`type Book @table @export {`,
		`\tid: ID @primaryKey`,
		`\tauthorId: ID @indexed`,
		`\t${genreLine}`,
		`\t${tagLine}`,
		`\t${yearLine}`,
		`\ttitle: String${bookAuthorRel}`,
		`}`,
		``,
	].join('\n');
}

// v0 == the on-disk fixture: genre NOT indexed, no author/book rel, tag indexed,
// tagBooks rel present, year is String.
const V0: SchemaOpts = {
	genreIndexed: false,
	authorBooksRel: false,
	tagIndexed: true,
	tagBooksRel: true,
	yearInt: false,
};

suite('schema evolution (@indexed/@relationship) on populated table', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let auth: string;
	let state: SchemaOpts = { ...V0 };

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 1 } }, env: {} });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;

		// readiness poll
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Book/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		// ---- seed POPULATED tables under v0 schema (BEFORE any evolution) ----
		const authors: any[] = [];
		for (let a = 0; a < AUTHORS; a++) {
			authors.push({ id: authorId(a), name: `author-${a}`, region: REGIONS[a % REGIONS.length] });
		}
		await client
			.req()
			.send({ operation: 'insert', schema: SCHEMA, table: 'Author', records: authors })
			.timeout(60_000)
			.expect(200);

		const books: any[] = [];
		for (let a = 0; a < AUTHORS; a++) {
			for (let b = 0; b < BOOKS_PER_AUTHOR; b++) {
				books.push({
					id: bookId(a, b),
					authorId: authorId(a),
					genre: genreFor(a, b),
					tag: tagFor(a, b),
					year: yearStrFor(a, b),
					title: `book ${b} by ${authorId(a)}`,
				});
			}
		}
		for (let i = 0; i < books.length; i += 200) {
			await client
				.req()
				.send({ operation: 'insert', schema: SCHEMA, table: 'Book', records: books.slice(i, i + 200) })
				.timeout(60_000)
				.expect(200);
		}
		await sleep(800); // settle
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ---- helpers --------------------------------------------------------------------------
	async function evolve(next: SchemaOpts, probePath = '/Book/'): Promise<void> {
		state = next;
		await client
			.req()
			.send({ operation: 'set_component_file', project: PROJECT, file: 'schema.graphql', payload: genSchema(next) })
			.timeout(30_000)
			.expect(200);
		await restartHttpWorkers(client, probePath, 120_000);
		await sleep(1_500); // allow index build/backfill to settle
	}

	/** search_by_value -> set of ids. Returns {ids,status} (does not assert 200). */
	async function searchByValue(
		table: string,
		attribute: string,
		value: unknown
	): Promise<{ ids: Set<string>; status: number }> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: SCHEMA,
				table,
				search_attribute: attribute,
				search_value: value,
				get_attributes: ['id'],
			})
			.timeout(60_000);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return { ids: new Set(rows.map((row) => String(row.id))), status: r.status };
	}

	/** full-scan equals via search_by_conditions -> {ids,status}. Independent of secondary index. */
	async function scanEquals(
		table: string,
		attribute: string,
		value: unknown
	): Promise<{ ids: Set<string>; status: number }> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_conditions',
				schema: SCHEMA,
				table,
				operator: 'and',
				conditions: [{ search_attribute: attribute, search_type: 'equals', search_value: value }],
				get_attributes: ['id'],
			})
			.timeout(60_000);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return { ids: new Set(rows.map((row) => String(row.id))), status: r.status };
	}

	async function getById(table: string, id: string): Promise<any> {
		const r = await client
			.req()
			.send({ operation: 'search_by_hash', schema: SCHEMA, table, hash_values: [id], get_attributes: ['*'] })
			.timeout(15_000);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return rows[0];
	}

	/** raw REST GET (no throw-on-non-200). */
	async function restGet(path: string): Promise<{ status: number; body: any; raw: string }> {
		const r = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
		const raw = await r.text();
		let body: any = null;
		try {
			body = JSON.parse(raw);
		} catch {
			/* leave null */
		}
		return { status: r.status, body, raw };
	}

	const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

	// ========================================================================================
	// S1 — ADD @indexed on Book.genre (declared-but-unindexed) over POPULATED rows.
	// ========================================================================================
	test('S1: ADD @indexed on Book.genre backfills every pre-existing matching row', async () => {
		await evolve({ ...state, genreIndexed: true });

		const dt = await client.req().send({ operation: 'describe_table', schema: SCHEMA, table: 'Book' }).expect(200);
		const ga = (dt.body?.attributes ?? []).find((x: any) => (x.attribute ?? x.name) === 'genre');
		console.log(`[schema-evolution S1] post-ALTER genre attr=${JSON.stringify(ga)}`);

		let failures = 0;
		const fails: string[] = [];
		for (const g of GENRES) {
			const expected = new Set<string>();
			for (let a = 0; a < AUTHORS; a++)
				for (let b = 0; b < BOOKS_PER_AUTHOR; b++) if (genreFor(a, b) === g) expected.add(bookId(a, b));

			const idx = await searchByValue('Book', 'genre', g);
			const scan = await scanEquals('Book', 'genre', g);
			const miss = idx.status === 200 ? diff(expected, idx.ids) : [-1 as any];
			const extra = idx.status === 200 ? diff(idx.ids, expected) : [-1 as any];
			const idxVsScan =
				idx.status === 200 && scan.status === 200
					? [...diff(idx.ids, scan.ids), ...diff(scan.ids, idx.ids)]
					: [-1 as any];
			console.log(
				`[schema-evolution S1] genre=${g}: expected=${expected.size} index=${idx.ids.size}(st=${idx.status}) scan=${scan.ids.size}(st=${scan.status}) ` +
					`missing=${miss.length} extra=${extra.length} idx!=scan=${idxVsScan.length}`
			);
			if (idx.status !== 200 || miss.length || extra.length || idxVsScan.length) {
				failures++;
				fails.push(
					`genre=${g}: st=${idx.status} missing=${miss.length} extra=${extra.length} idxVsScan=${idxVsScan.length}`
				);
			}
		}
		strictEqual(failures, 0, `S1 BACKFILL DEFECT (genre index): ${fails.join(' | ')}`);
	});

	// ========================================================================================
	// S2 — ADD @relationship referencing PRE-EXISTING rows; edges must resolve both ways.
	// ========================================================================================
	test('S2: ADD @relationship Author.books / Book.author resolves over pre-existing rows', async () => {
		await evolve({ ...state, authorBooksRel: true });

		let failures = 0;
		const fails: string[] = [];

		// parent -> child: Author.books must contain exactly the pre-existing books for each author.
		for (let a = 0; a < AUTHORS; a++) {
			const expected = new Set<string>();
			for (let b = 0; b < BOOKS_PER_AUTHOR; b++) expected.add(bookId(a, b));
			const r = await restGet(`/Author/${authorId(a)}?select(id,books{id})`);
			const obj = Array.isArray(r.body) ? r.body[0] : r.body;
			const got = new Set<string>((obj?.books ?? []).map((x: any) => String(x.id)));
			const miss = diff(expected, got);
			const extra = diff(got, expected);
			if (r.status !== 200 || miss.length || extra.length) {
				failures++;
				fails.push(
					`Author.books ${authorId(a)}: st=${r.status} got=${got.size}/${expected.size} miss=${miss.length} extra=${extra.length}`
				);
				if (a < 2) console.log(`[schema-evolution S2] sample Author ${authorId(a)} raw=${r.raw.slice(0, 200)}`);
			}
		}

		// child -> parent: Book.author must resolve to the correct pre-existing author.
		for (let a = 0; a < AUTHORS; a++) {
			const probe = bookId(a, a % BOOKS_PER_AUTHOR);
			const r = await restGet(`/Book/${probe}?select(id,authorId,author{id,name})`);
			const obj = Array.isArray(r.body) ? r.body[0] : r.body;
			const resolvedAuthor = obj?.author?.id;
			if (r.status !== 200 || resolvedAuthor !== authorId(a)) {
				failures++;
				fails.push(
					`Book.author ${probe}: st=${r.status} resolved=${JSON.stringify(resolvedAuthor)} expected=${authorId(a)}`
				);
			}
		}

		console.log(
			`[schema-evolution S2] relationship-over-old-rows failures=${failures}` +
				(fails.length ? `\n  ${fails.slice(0, 8).join('\n  ')}` : ' — all resolved')
		);
		strictEqual(failures, 0, `S2 RELATIONSHIP-OVER-EXISTING DEFECT: ${fails.slice(0, 8).join(' | ')}`);
	});

	// ========================================================================================
	// S3 — REMOVE @indexed (Book.tag) AND @relationship (Author.tagBooks); no ghosts/phantoms.
	// ========================================================================================
	test('S3: REMOVE @indexed + @relationship leaves no ghost index hits / phantom edges', async () => {
		// tag == author-id cross-link: books tagged with au-T are exactly author ((T-1+N)%N)'s books.
		const probeTag = authorId(1); // tag value to probe in the index (books of author 0 carry tag au-1)
		const expectedForProbeTag = new Set<string>();
		for (let a = 0; a < AUTHORS; a++)
			for (let b = 0; b < BOOKS_PER_AUTHOR; b++) if (tagFor(a, b) === probeTag) expectedForProbeTag.add(bookId(a, b));
		// tagBooks of author au-T (join Book.tag == au-T) -> books of author ((T-1+N)%N).
		const relAuthor = authorId(1); // -> its tagBooks are author 0's books
		const expectedTagBooks = new Set<string>();
		for (let b = 0; b < BOOKS_PER_AUTHOR; b++) expectedTagBooks.add(bookId(0, b));

		// Sanity BEFORE removal: tag index works and tagBooks relationship resolves (non-empty!).
		const beforeIdx = await searchByValue('Book', 'tag', probeTag);
		const beforeRel = await restGet(`/Author/${relAuthor}?select(id,tagBooks{id})`);
		const beforeRelObj = Array.isArray(beforeRel.body) ? beforeRel.body[0] : beforeRel.body;
		const beforeEdges = new Set<string>((beforeRelObj?.tagBooks ?? []).map((x: any) => String(x.id)));
		console.log(
			`[schema-evolution S3] BEFORE remove: tag-index st=${beforeIdx.status} hits=${beforeIdx.ids.size}/${expectedForProbeTag.size} ; ` +
				`tagBooks rel st=${beforeRel.status} edges=${beforeEdges.size}/${expectedTagBooks.size}`
		);
		ok(
			beforeIdx.ids.size === expectedForProbeTag.size,
			`S3 precondition: tag index must resolve before removal (${beforeIdx.ids.size} vs ${expectedForProbeTag.size})`
		);
		ok(
			beforeEdges.size === expectedTagBooks.size,
			`S3 precondition: tagBooks relationship must resolve non-empty before removal (${beforeEdges.size} vs ${expectedTagBooks.size})`
		);

		await evolve({ ...state, tagIndexed: false, tagBooksRel: false });

		// describe_table: is tag still reported as indexed?
		const dt = await client.req().send({ operation: 'describe_table', schema: SCHEMA, table: 'Book' }).expect(200);
		const tagAttr = (dt.body?.attributes ?? []).find((x: any) => (x.attribute ?? x.name) === 'tag');
		console.log(`[schema-evolution S3] AFTER remove: describe_table tag attr=${JSON.stringify(tagAttr)}`);

		// GHOST INDEX: search_by_value on the now-unindexed tag. Two defensible outcomes:
		//   (a) the index is dropped -> search_by_value errors (no such index) OR
		//   (b) it falls back to a scan and returns the CORRECT current set.
		// A DEFECT is: returns STALE/partial results that disagree with a full scan
		// (search_by_conditions, which does not use the secondary index).
		const ghost = await searchByValue('Book', 'tag', probeTag);
		const scan = await scanEquals('Book', 'tag', probeTag);
		console.log(
			`[schema-evolution S3] ghost-probe search_by_value(tag=${probeTag}) st=${ghost.status} hits=${ghost.ids.size} | ` +
				`scan st=${scan.status} hits=${scan.ids.size} | expected=${expectedForProbeTag.size}`
		);
		// scan must remain authoritative & complete regardless.
		ok(scan.status === 200, `S3: full scan over tag must still work, got st=${scan.status}`);
		strictEqual(
			scan.ids.size,
			expectedForProbeTag.size,
			`S3: full scan over tag changed after index removal (data loss?): ${scan.ids.size} vs ${expectedForProbeTag.size}`
		);
		if (ghost.status === 200) {
			const ghostMiss = diff(expectedForProbeTag, ghost.ids);
			const ghostExtra = diff(ghost.ids, expectedForProbeTag);
			ok(
				ghostMiss.length === 0 && ghostExtra.length === 0,
				`S3 GHOST-INDEX DEFECT: search_by_value(tag) after index removal returned stale set (miss=${ghostMiss.length} extra=${ghostExtra.length})`
			);
		} else {
			console.log(
				`[schema-evolution S3] search_by_value on removed index returned st=${ghost.status} (index dropped — acceptable)`
			);
		}

		// PHANTOM EDGE: selecting the removed tagBooks relationship (which DID resolve before removal).
		const phantom = await restGet(`/Author/${relAuthor}?select(id,tagBooks{id})`);
		const phantomObj = Array.isArray(phantom.body) ? phantom.body[0] : phantom.body;
		const phantomEdges = phantomObj?.tagBooks;
		console.log(
			`[schema-evolution S3] phantom-edge select(tagBooks) st=${phantom.status} value=${JSON.stringify(phantomEdges)?.slice(0, 120)} ` +
				`raw=${phantom.raw.slice(0, 160)}`
		);
		// Acceptable: 200 with tagBooks absent/undefined (relationship gone), or a 4xx for unknown field.
		// DEFECT: 200 that still materializes the removed edges as a populated array.
		const stillPopulated = Array.isArray(phantomEdges) && phantomEdges.length > 0;
		ok(
			!stillPopulated,
			`S3 PHANTOM-EDGE DEFECT: removed relationship tagBooks still resolved ${phantomEdges?.length} edges`
		);

		// The author row itself + plain attrs must remain readable & intact.
		const authorRow = await getById('Author', relAuthor);
		ok(
			authorRow && authorRow.region === REGIONS[1 % REGIONS.length],
			`S3: author row corrupted after relationship removal: ${JSON.stringify(authorRow)}`
		);
	});

	// ========================================================================================
	// S4 — RETYPE Book.year String->Int over coercible + non-coercible existing values.
	// ========================================================================================
	test('S4: RETYPE Book.year String->Int — no crash, no silent loss on existing rows', async () => {
		// Capture a coercible and a non-coercible pre-existing row id.
		let coercibleId = '';
		let coercibleStr = '';
		let nonCoercibleId = '';
		outer: for (let a = 0; a < AUTHORS; a++) {
			for (let b = 0; b < BOOKS_PER_AUTHOR; b++) {
				const y = yearStrFor(a, b);
				if (y === 'MMXXIV' && !nonCoercibleId) nonCoercibleId = bookId(a, b);
				else if (y !== 'MMXXIV' && !coercibleId) {
					coercibleId = bookId(a, b);
					coercibleStr = y;
				}
				if (coercibleId && nonCoercibleId) break outer;
			}
		}
		console.log(
			`[schema-evolution S4] probes: coercible=${coercibleId}("${coercibleStr}") nonCoercible=${nonCoercibleId}("MMXXIV")`
		);

		// Read BEFORE retype.
		const beforeC = await getById('Book', coercibleId);
		const beforeN = await getById('Book', nonCoercibleId);
		console.log(
			`[schema-evolution S4] BEFORE: coercible.year=${JSON.stringify(beforeC?.year)} nonCoercible.year=${JSON.stringify(beforeN?.year)}`
		);

		// RETYPE may legitimately FAIL the restart (validation rejects non-coercible existing
		// data) OR succeed. set_component_file uses .expect(200); restart via restartHttpWorkers
		// may throw if readiness never returns — capture both.
		let retypeError: string | undefined;
		try {
			await evolve({ ...state, yearInt: true });
		} catch (err: any) {
			retypeError = err?.message ?? String(err);
		}
		console.log(`[schema-evolution S4] retype restart error=${JSON.stringify(retypeError ?? null)}`);

		// Whatever the migration outcome, the instance must still answer (no brick/crash-loop).
		const ops = await client.req().send({ operation: 'describe_table', schema: SCHEMA, table: 'Book' }).timeout(15_000);
		ok(ops.status === 200, `S4 BRICK: ops API unresponsive after retype, st=${ops.status}`);

		// Pre-existing rows must remain READABLE (no silent loss / unreadable row).
		const afterC = await getById('Book', coercibleId);
		const afterN = await getById('Book', nonCoercibleId);
		console.log(
			`[schema-evolution S4] AFTER: coercible.year=${JSON.stringify(afterC?.year)} (typeof ${typeof afterC?.year}) ` +
				`nonCoercible.year=${JSON.stringify(afterN?.year)} (typeof ${typeof afterN?.year})`
		);
		ok(afterC, `S4 DATA-LOSS: coercible row ${coercibleId} unreadable after retype`);
		ok(afterN, `S4 DATA-LOSS: non-coercible row ${nonCoercibleId} unreadable after retype`);
		// values must not have silently vanished (year still present in some form).
		ok(
			afterC.year !== undefined && afterC.year !== null,
			`S4 DATA-LOSS: coercible year vanished: ${JSON.stringify(afterC)}`
		);
		ok(
			afterN.year !== undefined && afterN.year !== null,
			`S4 DATA-LOSS: non-coercible year vanished: ${JSON.stringify(afterN)}`
		);

		// Total book count must be unchanged (no rows dropped by the retype).
		const all = await scanEquals('Book', 'authorId', authorId(0)); // one author's books as a cheap liveness probe
		console.log(`[schema-evolution S4] author0 book count after retype=${all.ids.size} (expected ${BOOKS_PER_AUTHOR})`);
		strictEqual(
			all.ids.size,
			BOOKS_PER_AUTHOR,
			`S4 DATA-LOSS: author0 lost books after retype: ${all.ids.size} vs ${BOOKS_PER_AUTHOR}`
		);

		// NEW writes under the Int type: coercible-number ok; what about a string into Int?
		const goodWrite = await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: 'Book',
				records: [
					{ id: 'bk-new-int', authorId: authorId(0), year: 2030, genre: 'scifi', tag: 'tag-0', title: 'new int year' },
				],
			})
			.timeout(15_000);
		const goodRow = await getById('Book', 'bk-new-int');
		// raw fetch for the string-into-Int write (may be rejected -> non-200).
		const badResp = await fetch(`${httpURL}/Book/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({
				id: 'bk-new-str',
				authorId: authorId(0),
				year: 'not-a-year',
				genre: 'scifi',
				tag: 'tag-0',
				title: 'bad str year',
			}),
		});
		const badRaw = (await badResp.text()).slice(0, 200);
		const badRow = await getById('Book', 'bk-new-str');
		console.log(
			`[schema-evolution S4] new-write year=2030 -> op-st=${goodWrite.status} readback=${JSON.stringify(goodRow?.year)} (typeof ${typeof goodRow?.year}) ; ` +
				`new-write year="not-a-year" -> rest-st=${badResp.status} readback=${JSON.stringify(badRow?.year)} raw=${badRaw}`
		);
		ok(
			goodWrite.status === 200,
			`S4: a clean Int write should succeed after retype, got ${goodWrite.status} ${JSON.stringify(goodWrite.body)}`
		);

		console.log(
			`[schema-evolution S4] VERDICT retype-restart-failed=${!!retypeError} ` +
				`existing-coercible-typeof=${typeof afterC?.year} existing-noncoercible-typeof=${typeof afterN?.year} ` +
				`(Harper stores values as-encoded; declared type is a validation/index hint, not a stored cast)`
		);
	});
});
