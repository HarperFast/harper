# Native full-text search

> Storage architecture superseded September 14, 2026. The current design is
> [Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).
> The wrapper and Harper now use native Tantivy files only, with local replay/rebuild on each node.
> RocksDB Directory, host transport, and dual-backend release requirements below are historical,
> not implementation requirements. Existing storage-independent schema, analysis, query, API safety,
> and packaging decisions remain requirements unless explicitly superseded by the current design.


- **Status:** design proposal
- **Primary target:** RocksDB-backed Harper deployments with product catalogs up to hundreds of
  millions of records
- **Initial language:** English
- **Initial query surfaces:** `Table.search()` and exported-table REST APIs
- **Ranking:** weighted BM25
- **Initial matching scope:** term-any, term-all, phrase, bounded prefix/autocomplete, and bounded
  fuzzy
- **Latency objective:** end-to-end search p99 below 50 ms on an agreed reference workload

## Summary

Harper provides a first-class, schema-declared full-text field derived from one or more record
attributes, much as `@embed` derives a vector field from record data. Tantivy implements the
`FULLTEXT` index through an in-process Rust Node-API module. Harper remains the source of truth.
Tantivy index objects are node-local, rebuildable derived state with bounded eventual visibility.
Harper stores those objects only through the RocksDB-backed `RocksDbDirectory` defined in this
document. The wrapper also ships Tantivy's native filesystem directory for standalone use and
paired reference benchmarks, but Harper imports and releases only the Rocks integration. Native
storage is not a Harper schema/configuration option or fallback. If the RocksDB directory cannot
satisfy the correctness and performance gates, Harper does not release native full-text search.

This design does not introduce a second search endpoint or expose Tantivy's query language.
Full-text predicates participate in Harper's existing condition tree, bounded same-index Boolean
groups, AND planning with supported structured conditions, selection, relevance sorting, pagination,
authorization, and REST FIQL translation. The new public
concepts are:

- the `@fullText` schema directive, which declares source fields and analysis options;
- a family of `FULLTEXT` comparators: `matches`, `matches_all`, `matches_phrase`,
  `matches_prefix`, `matches_fuzzy`, and preview `matches_fuzzy_prefix`;
- a `$score` pseudo-attribute, analogous to `$distance` for HNSW;
- index status, lag, and rebuild observability for an eventually consistent derived index.

Full text implements Harper's shared `DerivedIndexBackend` contract. Every write-capable worker
delivers committed source mutations after commit; the existing RocksDB transaction log is the
durable recovery queue, and each generation publishes an opaque contiguous log watermark with its
Tantivy commit. The same runtime can later move HNSW's phase-1 pre-commit mirror onto post-commit
delivery and replay without requiring the two engines to share a physical format or search model.

### Verified baseline and proposed work

This accuracy pass used Harper `9f469c079a` (5.2.5), rocksdb-js `7ab102ca3e` (package 2.8.0, RocksDB
11.8.1), and Tantivy tag `0.26.1` (`d8f4c0b703`). Tantivy main was also checked at `b5d8deb80c`
(0.27.0) for upstream drift, but the pinned 0.26.1 source and behavior remain normative for
implementation.

| Area    | Verified in the reviewed baseline                                                                                            | New work in this design                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harper  | Custom-index maintenance/search are synchronous; replication applies index work locally; backfill uses `indexingPID`.        | A shared post-commit derived-index runtime, opaque log watermark/replay, generation lifecycle hooks, and bounded filtered candidate acquisition. |
| HNSW    | Draft PR #2430 proposes per-worker native wrappers and synchronous shared-mmap dual writes; committed replay is later work.  | It may later adopt the derived protocol, but full text does not claim that mechanism already exists.                                             |
| Tantivy | 0.26.1 has one exclusive `IndexWriter` per directory, internal indexing/merge threads, both directory locks, and WORM files. | Native Node-API adapter, bounded actor/pools, health detection, and Harper generation/checkpoint integration.                                    |

“Verified” describes current code or pinned upstream behavior. Everything in the right column is a
proposal and must pass the implementation and release gates below.

## Motivation

Today an application can approximate full-text indexing with a bespoke `@computed` field and a
normal index. That places tokenization, normalization, storage shape, query behavior, and lifecycle
on application authors. It also cannot provide an efficient inverted index or BM25 ranking at
catalog scale.

The native implementation moves this responsibility into Harper:

- customers identify the record fields that make up a searchable document;
- Harper derives and maintains the search projection;
- a purpose-built full-text engine performs token lookup and ranking;
- the feature composes with existing Harper queries rather than creating a parallel API;
- the derived index can lag committed records by a bounded and observable amount;
- a damaged, missing, or incompatible index can be rebuilt from Harper records.

At hundreds of millions of products, the implementation must use compressed postings, immutable
segments, efficient term dictionaries, top-k pruning, background merging, and native execution.
Implementing those systems inside Harper or modeling individual terms and postings as Harper keys
would reinvent a search engine. Tantivy already supplies them. A RocksDB-backed Tantivy directory
preserves Tantivy's segment format and query engine; it stores opaque segment objects rather than
translating the inverted index into a Harper-owned posting format.

## Scope

### Included

- Schema-native declaration, validation, introspection, and OpenAPI/resource metadata.
- Multiple weighted source fields, such as title, brand, description, and keywords.
- English analysis with a versioned, deterministic contract.
- Weighted BM25 ranking in the first release.
- Full-text predicates in `Table.search()` and existing REST collection queries.
- Initial support for term-any, term-all, exact phrase, bounded prefix/autocomplete, and bounded fuzzy
  matching.
- Composition with normal Harper AND conditions and bounded same-index full-text Boolean subtrees,
  authorization filters, `select`, relevance sorting, and `limit`.
- Native/off-event-loop indexing and search with one Node-API crossing per mutation batch or bounded
  candidate window/cursor pull.
- RocksDB-only production storage through `RocksDbDirectory`; fail early and clearly for LMDB.
- A separately qualified standalone `MmapDirectory` wrapper mode used outside Harper and as the
  paired reference for measuring RocksDB adapter cost; Harper never selects it.
- Node-local derived indexes with opaque log watermarks, replay, shadow rebuilds, and atomic
  generation swaps.
- A coordination mechanism that can later replace HNSW's bespoke phase-1 backfill/flush lifecycle.
- Default-enabled token positions and surface terms, avoiding a catalog-scale rebuild for customers
  using phrase, autocomplete, or fuzzy behavior while allowing storage-conscious deployments to
  disable those capabilities explicitly.
- Product autocomplete and a normal Harper-table pattern for customer-managed curated suggestion
  records. Automatic query/click collection and behavioral score composition are deferred.
- Optional index-time synonym expansion and bounded top-k highlighting, both disabled unless the
  customer explicitly requests them.

### Success measures

- An application declares and maintains a multi-field full-text index without computed-field code
  or a separate search resource.
- Programmatic and REST queries use the same Harper condition tree and return equivalent authorized
  records, ordering, and `$score` metadata.
- Every committed mutation that changes full-text sources or local searchability is either
  represented by a published index watermark or remains recoverable from retained transaction logs.
- A missing, corrupt, or incompatible index can be rebuilt while a compatible generation continues
  serving.
- Each accepted query class meets its own latency and work-budget gate on the reference workload;
  broad fuzzy or prefix queries cannot hide behind a faster aggregate percentile.
- Under the qualified steady-state workload, successful source-changing commits become visible to
  full-text search within one second at p99. Rebuild, recovery, and storage-pressure states expose
  separate lag.
- Operators can determine index readiness, lag, generation, RocksDB directory format, rebuild progress,
  and failure cause without inspecting Tantivy storage.

### Not included in the first release

- Exposing Tantivy's `QueryParser`, query-string syntax, or implementation-specific query objects.
- Strict transaction-level visibility between a record commit and the full-text index.
- Cross-node distributed BM25 normalization or a new federated search protocol.
- Arbitrary language analyzers, customer-supplied tokenizer code, or per-document analyzers.
- Unrestricted wildcard, regex, arbitrary edit-distance, or unbounded term-expansion queries.
- Automatically learning popular queries, conversions, or personalized suggestions without a
  customer-provided event/aggregate dataset.
- Native “did you mean?” correction text or strict BM25F in the first GA release.
- PDF, DOCX, HTML, archive, image, or other binary document extraction.
- LMDB support.
- Replacing Harper records with Tantivy's stored documents.
- A Harper-owned term dictionary, posting-list format, BM25 implementation, or segment merger.
- Mixed text/structured Boolean branches, cross-index Boolean trees, pure-negative full-text
  searches, relationship-path, and branched-table full-text conditions.
- Arbitrary primary sorting of the complete full-text match set or exact full-text hit counts.

## Schema contract

### Declaration

Harper's platform schema gains these definitions:

```graphql
input FullTextSource {
	name: String!
	weight: Float = 1.0
	highlight: Boolean
}

scalar FullText

directive @fullText(
	fields: [FullTextSource!]!
	analyzer: String = "english@1"
	stopWords: Boolean = true
	positions: Boolean = true
	surfaceTerms: Boolean = true
	synonyms: [FullTextSynonymRule!] = []
	highlighting: FullTextHighlighting = { maxFragments: 3, fragmentLength: 160 }
) on FIELD_DEFINITION

input FullTextSynonymRule {
	source: String!
	replacements: [String!]!
}

input FullTextHighlighting {
	maxFragments: Int = 3
	fragmentLength: Int = 160
}
```

Applications consume those definitions in their normal table schema:

```graphql
type Product @table @export {
	id: ID @primaryKey
	title: String
	brand: String
	description: String
	keywords: [String]
	manual: Blob
	category: String @indexed
	status: String @indexed

	search: FullText
		@fullText(
			fields: [
				{ name: "title", weight: 3.0 }
				{ name: "brand", weight: 2.0 }
				{ name: "description", weight: 1.0 }
				{ name: "keywords", weight: 1.5 }
				{ name: "manual", weight: 0.5, highlight: true }
			]
			analyzer: "english@1"
			stopWords: true
			positions: true
			surfaceTerms: true
			synonyms: [{ source: "sneaker", replacements: ["shoe"] }, { source: "shoe", replacements: ["sneaker"] }]
			highlighting: { maxFragments: 2, fragmentLength: 180 }
		)
}
```

`@fullText` is the sole customer-facing declaration for this derived index. It follows `@embed`'s
schema-driven lifecycle model, but it compiles to a canonical `FULLTEXT` derived-index descriptor
stored separately from ordinary `@indexed` descriptors. It does not add an entry to `Table.indices`
or call `openIndex()`.

`@fullText` is independent of `@indexed`; Harper has no existing full-text `@indexed` type to
migrate or preserve. Ordinary `@indexed` validation remains outside this feature.

The structured `FullTextSource` input avoids encoding weights in strings such as `"title^3"`,
which would create a second language inside the schema. These declaration weights are the only
source-field boosts in the first release. `Table.search()` and REST cannot override them or select a
ranking profile. Changing only a weight creates a new ranking fingerprint and atomically replaces
the active ranking configuration; it does not change postings or create a new index generation.

`highlight` is intentionally nullable. When omitted, Harper resolves it to `true` for `String` and
`[String]` sources and `false` for `Blob` sources. Explicit `true` opts a UTF-8 `text/plain` Blob into
highlight retrieval; explicit `false` excludes any source. This policy affects only `$highlights` and
does not change whether the source is indexed or searchable.

### Schema validation

Schema loading rejects:

- a `@fullText` target whose type is not the accepted full-text type;
- an empty `fields` list;
- unknown source fields;
- unsupported source types in the initial release;
- duplicate source fields;
- non-finite, zero, or negative weights;
- an unknown or unversioned analyzer;
- malformed, duplicate, self-replacing, or over-limit synonym rules;
- a synonym source or replacement that does not produce exactly one `english@1` token;
- non-integer, non-positive, or over-limit highlighting settings;
- combining `@fullText` with `@indexed` on the derived target;
- structural settings unsupported by an existing on-disk generation;
- any `@fullText` declaration when the selected storage engine is LMDB;
- a missing platform-specific native binary when `@fullText` is declared.

Initial source types are `String`, `[String]`, and `Blob`. A Blob source is an explicit opt-in by
including that schema field in `@fullText`; each value must declare `text/plain` with no charset or
with `charset=utf-8`. Harper validates the Blob's existing media-type metadata and decodes it as
UTF-8 in the bounded background extraction lane. Missing, unsupported, or corrupt media metadata
follows the observable extraction-failure policy rather than being guessed or coerced. Numbers,
nested objects, relationships, and `Any` are rejected rather than coerced with `String(value)`.

Harper applies fixed server-owned per-source byte, emitted-token, and maximum-token-length limits;
`@fullText` and search requests cannot raise or lower them. A source that deterministically exceeds
one of these limits is quarantined immediately for that record version and is never prefix-truncated.
The index document is rebuilt from the record's remaining valid sources, preventing terms from the
previous value from surviving. If valid sources still emit terms, the record remains searchable from
them; if none do, the mutation follows the termless delete-only rule. The watermark advances and the
generation reports degraded/quarantined source and record counts. A later source version is evaluated
normally and clears that source's quarantine when it succeeds. Harper record acceptance is unchanged.
Quarantine detail is operator-only index health: ordinary results do not gain a per-record
`$searchComplete` flag and healthy-source matches continue to return normally. A quarantine elsewhere
in the index never fails an otherwise valid query.

Malformed Unicode in a `String` or `[String]` source is record-level quarantine, not the per-source
limit policy above. Harper validates UTF-16 before UTF-8 encoding; an unpaired surrogate causes the
mutation to delete the record's prior full-text document, publish no terms from any source for that
record version, advance the watermark, and report the degraded record through operator health. It
does not substitute `U+FFFD`, preserve the old document, reject the authoritative Harper write, or
index the record's remaining fields. A later well-formed version is analyzed normally and clears the
quarantine. Invalid bytes in an opted-in UTF-8 Blob continue through the existing bounded extraction-
failure policy because the Blob is already a byte source, not a JavaScript string.

Retryable Blob unavailability preserves the preceding published document and may hold that record
version's watermark position only inside a release-qualified blocking-gap budget. That budget is a
Harper system policy, not part of `@fullText`, and is bounded by the mutation-to-searchable freshness
envelope and native staging capacity. Age is measured from the durable transaction-log entry timestamp
so restart cannot renew it. Bounded background retries may reacquire the content lease or use Harper's
existing origin-refetch path. Before the gap can exhaust staging or make the index exceed its allowed
staleness, Harper submits a record-level quarantine: the writer
deletes the prior full-text document, indexes none of that version's sibling sources, advances the
position, and exposes the degraded condition to operators until a newer valid version or delete
clears it. Deterministically unsupported media, invalid UTF-8, or corrupt content takes the same
terminal path immediately instead of consuming the retry window. A 24-hour blocking retry is not
supported without a durable out-of-order ledger because one missing Blob would stop publication for
the complete index.

### Derived-field semantics

The field follows the schema and rebuild lifecycle established by `@embed`, while its write
projection is full-text-specific:

- Harper produces the index projection from the declared source attributes;
- changing a source causes the derived index entry to be replaced;
- changing an unrelated field preserves the existing projection;
- clearing every source removes the document from the full-text index;
- replication and audit replay do not invoke customer code or produce different analysis;
- changing structural schema or analyzer versions schedules a rebuild;
- the generated field cannot accidentally be indexed as a normal B-tree value.

Full-text projection uses the complete conflict-resolved record because it has multiple sources. It
compares the old and new declared source values and emits no mutation when they are unchanged. This
does not change `@embed`: its single-source hook continues to run only when its source is present,
avoiding an external model call for unrelated PATCHes.

The generated `FullText` field is a schema-level query handle, not a stored copy of the source
text. It is non-enumerable, rejects direct writes, and is not selectable as record data. Customers
select the source fields or `$score`.

Full-text declarations do not add their source attributes to Harper's retained partial-record
fields. An invalidated record may keep its already-built Tantivy document so indexed lookup can
rehydrate the record through the table's existing source, but Harper does not retain a description,
Blob, or other full-text source solely to make a future rebuild possible. An actual cache eviction
removes both the local record and its full-text document, matching `updateIndices(id, record, null)`
for ordinary secondary indexes.

Adding, removing, renaming, or changing the type of a source creates a new structural fingerprint
and shadow generation. Reordering the same source declarations does not. If a required rebuild
encounters an invalidated partial without the declared full-text sources, the shared derived-index runtime refetches
the complete record through Harper's existing authoritative source-load path under a separate
bounded backfill budget. It does not introduce a field- or Blob-specific fetch path. The generation
remains `BUILDING` until the source-fill commit is covered by its watermark or the record reaches the
explicit quarantine policy. The old compatible generation may continue serving during that
process.

Resource metadata and OpenAPI describe `FullText` as query-only rather than as a writable or
response property.

`FullText` remains a persisted schema attribute descriptor so schema diffing, `describe_all`, and
index lifecycle use Harper's normal metadata path. On an `@sealed` table it is an allowed
schema-level query attribute, but client writes to it are rejected and it is never serialized as
record data.

### Customer-exposed configuration

Only durable declaration-level search behavior or settings that change indexed meaning belong in the
schema.

| Setting                       | Initial behavior | Why expose it                                                                                                 |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `fields[].name`               | Required         | Defines the document projection.                                                                              |
| `fields[].weight`             | `1.0`            | Defines the source's fixed relevance boost; changing only it does not rebuild.                                |
| `fields[].highlight`          | Type-dependent   | Includes a source in opt-in `$highlights`; Blob sources require explicit `true`.                              |
| `analyzer`                    | `english@1`      | Makes text analysis deterministic and rebuildable.                                                            |
| `stopWords`                   | `true`           | Applies the fixed `english@1` stop-word list; changing it requires rebuild.                                   |
| `positions`                   | `true`           | Stores positions for phrase queries; changing it requires rebuild.                                            |
| `surfaceTerms`                | `true`           | Stores normalized, unstemmed terms for prefix, fuzzy, and fuzzy-prefix queries; changing it requires rebuild. |
| `synonyms`                    | `[]`             | Enables bounded index-time expansion; changing any rule requires rebuild.                                     |
| `highlighting.maxFragments`   | `3`              | Maximum fragments returned per record when `$highlights` is selected.                                         |
| `highlighting.fragmentLength` | `160`            | Target maximum UTF-16 code units in each returned fragment.                                                   |

Omitting `highlighting` resolves to three fragments per record with a target maximum of 160 UTF-16
code units each. The setting configures presentation only; it does not enable highlighting on every
query. Callers still select `$highlights`. Harper clamps neither field silently: schema activation
rejects values above server-owned hard caps. `fragmentLength` is adjusted inward when needed to
preserve valid Unicode and token boundaries. Changing either highlighting value updates the
descriptor's search-only options without rebuilding the index.

`fragmentLength` is a context target rather than permission to cut a match. A fragment may expand
beyond it to contain the complete matched token or phrase, but never beyond the fixed server hard
cap. If the match span itself exceeds that hard cap, native tracing omits that fragment, preserves
the otherwise valid hit and any other fragments, and Harper returns `complete: false`. It never
returns a partial token/phrase span or silently truncates configured presentation values.

The first release accepts exactly `english@1`. Omitting `analyzer` resolves to that identifier;
aliases, unversioned names, and analyzer component knobs are rejected. The option remains visible so
future languages or behavior revisions can be added without changing the declaration shape. Changing
the analyzer identifier creates a new index generation.

`stopWords: true` applies the exact versioned `english@1` list. `false` preserves every otherwise
valid token, including short brand names such as `On`. Customers cannot add, remove, or upload
individual stop words in the first release. The setting affects both document and query analysis,
participates in the native schema fingerprint, and creates a new generation when changed.

The enabled list is a local frozen copy of Apache Lucene `EnglishAnalyzer.ENGLISH_STOP_WORDS_SET`,
not a runtime Lucene dependency or a pointer to whatever a future Lucene release contains:

```text
a an and are as at be but by for if in into is it no not of on or such that the their then there
these they this to was will with
```

The 33 newline-delimited terms in that order have SHA-256
`2f66c0e3dde5d31c7e919e2ed4d9d91390696480be361bfa143ca9ae0cb7ca13`. The implementation records
the [upstream provenance](https://github.com/apache/lucene/blob/main/lucene/analysis/common/src/java/org/apache/lucene/analysis/en/EnglishAnalyzer.java)
and satisfies Apache-2.0 attribution requirements. Tests assert the literal set and hash. An upstream
change has no effect on `english@1`; adopting one requires a new analyzer version and generation.

Stop-word removal preserves position increments rather than closing gaps. Document text
`state of the art` therefore indexes `state` and `art` at their original analyzed positions. A phrase
query for the full text undergoes identical analysis and still matches, while `state art` does not
falsely become adjacent. Position-gap behavior is part of `english@1` and applies only when positions
are enabled; disabling positions continues to make phrase comparators unavailable.

With `positions: false`, phrase comparators return a capability error. With `surfaceTerms: false`,
prefix/autocomplete and fuzzy comparators do the same. Harper never
substitutes a scan. Changing either option creates a new index generation. The default configuration
and every `positions`, `surfaceTerms`, and `stopWords` mode are covered by format, capability,
relevance, storage, and write-amplification tests.

Operational tuning stays out of table schemas. Maximum Boolean-tree depth, total Boolean clauses,
and prefix/fuzzy/fuzzy-prefix term and automaton expansion are fixed Harper release limits. They are selected with adversarial
benchmarks, published as product limits, and have no schema-, query-, or customer-configuration
override in the first release. Commit cadence, memory budgets, merge and search concurrency, and
rebuild throttles use safe Harper defaults and system configuration. They become customer options
only when workload evidence calls for control.

Harper computes one trusted full-text resource budget from process-level system configuration during
startup and passes it once to the wrapper before any index is opened. The wrapper validates and
freezes that budget, then allocates indexing workers, merger threads, writer arenas, resident
writers/readers, shadow generations, admission/replay memory, searches, commits, and any Rocks
object-page cache from the same process-wide envelope. A repeated identical initialization is
harmless; a conflicting initialization or an index open before initialization fails explicitly.
The wrapper does not infer additional capacity from machine or cgroup limits, and neither
`@fullText` nor an individual index-open call exposes resource overrides.

The same one-time initialization requires a finite `maxStaleSearcherAgeMs` availability policy.
Harper supplies it from trusted process-level system configuration, and the wrapper enforces it for
every generation; there is no package default, per-index override, or schema field. The interval is
measured from the oldest persisted blocking fact: a durable publication timestamp for reload failure
or the durable source-log entry timestamp for a delivery gap. It is never measured from process
startup or the latest retry. Zero disables serving a prior snapshot while progress is blocked.

Harper's per-table declaration/fan-out cap and the wrapper's process-wide registered-index cap are
distinct from the smaller resident-writer budget. Schemas within the declaration caps may register
more indexes than can write simultaneously. The wrapper then fairly parks and reactivates writers,
with an active shadow generation consuming its own resident permit, while the last validated reader
may remain searchable within the process-level `maxStaleSearcherAgeMs` bound. A parked index catches
up from retained logs without retaining new record content in memory; if it cannot publish before
the bound, Harper marks it stale and then unavailable instead of serving silently old results. There
is no unlimited registration mode and no per-index resource setting. Qualification, rather than an
unmeasured design constant, freezes the shipped caps, residency quantum, shard-credit floor, and
supported thread/memory envelope.

BM25 `k1` and `b` are fixed to Tantivy 0.26.1's effective values, `1.2` and `0.75`, respectively.
They are documented implementation constants, not schema or query options. Tantivy 0.26.1 exposes
them as implementation constants rather than query configuration. A future parameter change therefore
requires native Tantivy support or an upstream-oriented dependency change plus relevance and pruning-
correctness qualification. Tantivy's postings retain the term-frequency and field-norm inputs used to
derive block maxima at query time, so a parameter-only change does not by itself require rebuilding a
generation; the pinned Tantivy revision must confirm format compatibility before such an upgrade.
Harper does not implement a parallel BM25 scorer.

## English analysis contract

`english@1` defines a stable pipeline rather than inheriting a dependency's current defaults:

1. strict validation that JavaScript text contains no unpaired UTF-16 surrogate;
2. Unicode NFKC compatibility normalization;
3. locale-independent full Unicode default case folding;
4. Latin accent and diacritic folding;
5. versioned product-identifier recognition and whole-plus-component tokenization;
6. Unicode-aware prose word segmentation;
7. optional English stop-word filtering, enabled by default;
8. Tantivy `Stemmer::new(Language::English)` for English prose tokens;
9. bounded whole-token, component, and emitted-term lengths;
10. deterministic handling of arrays and empty/null values.

The exact normalization tables, stop-word list, tokenizer behavior for punctuation/SKUs, and maximum
term length must be frozen in tests. Analyzer changes use a new identifier such as `english@2` and
require a new index generation. Product identifiers such as `AB-123`, apostrophes, hyphens, units,
and model numbers need specific corpus tests; generic prose fixtures are insufficient.

NFKC is applied identically at index and query time before case and diacritic folding. Compatibility
forms therefore share searchable terms: full-width `ＡＢＣ` follows `ABC`, the `ﬁ` ligature follows
`fi`, and circled `①` follows `1`. Harper never rewrites the stored record. Analyzer output carries a
mapping back to the original source offsets even when normalization expands or contracts text, so
highlights return the original characters with valid UTF-16 spans. The implementation pins the
Unicode data version in the analyzer fingerprint and golden fixtures; a table change requires a new
analyzer version and generation.

Case-insensitive matching uses locale-independent full Unicode default case folding rather than
ASCII-only or locale-sensitive lowercasing. Multi-character and script-specific folds therefore use
one stable path—for example, German `ß` follows `ss`, and Greek final and ordinary sigma normalize
consistently. Index and query analysis use the identical table. The table version is part of the
analyzer fingerprint, and the original-offset mapping covers case-fold expansions so response text
and highlights retain the source spelling.

An identifier-like lexical unit produces a normalized unstemmed whole token and normalized
unstemmed components split at its recognized internal separators. For example, `AB-123/XL` produces
the whole `ab-123/xl` plus `ab`, `123`, and `xl`. The whole and components bypass English stop-word
removal and stemming; identifier components such as `ON` must not disappear as prose stop words.
Both are stored through Tantivy's ordinary term/position machinery and remain subject to fixed
emitted-token and clause limits. The versioned classifier and separator grammar are frozen in
`english@1` golden fixtures rather than inferred from future tokenizer dependency behavior.

`english@1` recognizes only hyphen (`-`), underscore (`_`), and slash (`/`) as internal product-
identifier separators, and only when they separate non-empty identifier components. Except for the
numeric-decimal and compact symbolic-identifier rules below, period, colon, plus, hash, ampersand,
and all other punctuation delimit tokens rather than joining an identifier. The ordinary separator
set is fixed—not schema configurable—and changing or broadening it requires a new analyzer version
and index generation.

The classifier is deterministic and identical at index and query time. A joined lexical unit is an
identifier when it contains at least one decimal digit, underscore, or slash. A hyphen alone is
insufficient: alphabetic `state-of-the-art` and `ABC-XL` follow ordinary prose analysis, while
`AB-123`, `ABC_XXL`, and `ABC/XL` produce whole-plus-component identifier terms. This conservative
rule is fixed in `english@1`; the first release has no per-source identifier mode.

A contiguous token containing both letters and decimal digits is also an identifier even without a
separator. It emits its normalized unstemmed whole plus components at every letter-to-digit or
digit-to-letter transition: `RTX4090` emits `rtx4090`, `rtx`, and `4090`; `128GB` emits `128gb`, `128`,
and `gb`; and `iPhone15` emits `iphone15`, `iphone`, and `15`. Whole and component alternatives use
the same zero-tie disjunction-max treatment as punctuated identifiers, with the whole form receiving
the strongest boost. Components allow a separated query such as `RTX 4090` to discover `RTX4090`.
These terms bypass stop-word removal and stemming, are not fuzzy-expanded, and remain subject to the
same fixed emitted-term and clause limits.

Across punctuated, mixed letter/digit, and symbolic identifiers, a component is emitted only when its
normalized surface form contains at least two Unicode scalar values. The whole identifier is retained even
when every component is discarded: `X-1`, `5G`, and `A/B` remain exact whole terms but do not emit
`x`, `1`, `5`, `g`, `a`, or `b`. Index and query analysis apply the same rule before term/clause
accounting. The minimum is fixed in `english@1`, not schema configurable.

A narrow symbolic classifier preserves compact alphanumeric names containing an attached plus (`+`),
hash (`#`), or ampersand (`&`) even though those characters are not general separators. It emits the
normalized whole plus only alphanumeric components of at least two characters at the same lexical
position: `C++` emits only `c++`, `C#` only `c#`, `AT&T` emits `at&t` and `at`, and `R&D` only `r&d`.
One-character components are discarded before indexing and clause accounting so they cannot create
large, weak posting lists. Whitespace breaks the compact unit, symbol-only runs emit nothing, and
period and colon remain boundaries. Symbolic whole forms and retained components bypass stop words
and stemming, never enter fuzzy or fuzzy-prefix automata, and remain eligible for exact and bounded
prefix matching. The classifier is symmetric at index and query time, fixed in `english@1`, and not
source configurable.

An identifier is one lexical position. Its whole and every component occupy that same position, and
the next source token advances once. For `AB-123/XL case`, `ab-123/xl`, `ab`, `123`, and `xl` share
one position and `case` occupies the next. A phrase query containing the joined identifier uses the
whole term for that phrase slot, so `"AB-123/XL case"` follows source adjacency. Separately typed
`"AB 123 XL"` has three positions and does not claim that the source contained that phrase; callers
use `matches_all` when they want component conjunction. This keeps Tantivy's ordinary positions and
avoids a wrapper-owned token graph.

An ASCII period directly between decimal digits remains inside the numeric term instead of becoming
a boundary. Thus `12.5` is one term, and mixed `12.5mm` uses the identifier path to emit `12.5mm`,
`12.5`, and `mm`. The analyzer does not also emit `12` and `5`; doing so would create broad, weak
matches. A period in any other context remains a boundary. Numeric-decimal recognition is symmetric
at index and query time and is part of the `english@1` golden contract.

Full-text analysis assigns no measurement semantics. It neither converts values nor silently treats
unit spellings as equivalent: `12in`, `12 inch`, and `30.48cm` are only related by the ordinary terms
they actually emit. A schema author can connect lexical aliases such as `in`, `inch`, and `inches`
through the existing explicit synonym declaration and its directional-rule contract. Quantitative
comparison, normalization, and conversion belong in structured record attributes composed through
Harper's existing filters. The wrapper contains no unit table, conversion engine, or unit-specific
scoring path.

English apostrophe handling is likewise fixed. Straight and Unicode curly apostrophes normalize to
the same lexical form. Internal contraction apostrophes remain part of the token, so `can't` does not
become `can` plus `t` or collide with `cant`. A trailing English possessive `'s` is removed before
stemming, so `women's` follows the same searchable term path as `women`. The analyzer retains source
offset provenance across normalization and possessive removal so highlighting returns the original
spelling and spans the complete visible source token.

For a punctuated identifier query, the query builder makes the exact whole identifier the strongest
native boosted alternative and retains the component path for discovery, using zero-tie
disjunction-max so one logical identifier cannot double count. Separately typed components such as
`AB 123` use the normal term-any or term-all semantics. Identifier whole tokens and components are
never fuzzy-expanded, but remain eligible for exact and bounded prefix matching. This adds tokens,
not a Harper posting list or custom scoring engine.

Broad Latin-to-ASCII folding is mandatory in `english@1`, not another schema switch. Both indexed
and query analysis normalize combining accents and common special Latin letters, including
`café → cafe`, `Møller → moller`, `Łódź → lodz`, `œuvre → oeuvre`, and `Æther → aether`. It emits only
the folded searchable term rather than duplicating original and folded postings, and it does not
transliterate non-Latin scripts. The bounded mapping table and its version participate in the
analyzer fingerprint. Stored Harper source text is never rewritten. Highlight reanalysis carries
offsets from normalized tokens back to the original fragment, so clients receive the original
spelling and valid UTF-16 spans.

Non-Latin text remains searchable but does not pass through English stemming. It receives the same
NFKC, Unicode case-folding, and Unicode word-segmentation stages, then retains its normalized terms
without transliteration. `english@1` makes no claim of language-specific morphology or dictionary
segmentation; in particular, recall for Chinese and Japanese text without explicit word boundaries
is limited. Additional language behavior is introduced only through explicit versioned analyzers
such as a future `cjk@1`, never automatic per-record or per-token language detection within
`english@1`.

English prose stemming composes Tantivy's native `Stemmer::new(Language::English)` filter into
Harper's explicit analyzer chain. Harper does not use Tantivy's whole `en_stem` default tokenizer and
does not call the underlying Rust stemming crate directly. The exact Tantivy and transitive stemmer
versions join the analyzer fingerprint, and golden fixtures pin input-to-stem output. A dependency
upgrade that changes any fixture requires `english@2` and a new generation rather than silently
changing existing terms.

`english@1` cannot be an alias for “whatever Tantivy currently calls English.” Harper constructs
the tokenizer/filter chain explicitly and fingerprints every dependency and data table capable of
changing emitted tokens, including the Tantivy crate version while any built-in component remains
in the chain. Golden fixtures assert the exact token, position, and surface-term stream. A dependency
upgrade that changes a fixture either retains the old implementation or introduces `english@2` and
forces a generation rebuild; mixed analysis within one generation is never accepted.

### Index-time synonym contract

Synonyms are disabled when the declaration has no rules. When configured, Harper canonicalizes and
validates the rules at schema activation, includes their content hash in the schema fingerprint, and
passes the canonical rules to the native analyzer. The document analyzer emits bounded replacement
tokens at the source token's position; the query analyzer remains `english@1` without synonym
expansion. This gives predictable query cost while allowing an indexed source term to match its
configured replacements. Rules are directional: `source: "laptop", replacements: ["computer"]`
allows a query for “computer” to find a document containing “laptop,” but does not make every
computer match a query for “laptop.” Bidirectional equivalence requires explicit reciprocal rules.
Reciprocal rules are valid and canonicalized without recursively expanding one rule through another.

The first release accepts only single-token rules. Each `source` and replacement is canonicalized
through the complete base `english@1` pipeline—with synonym expansion disabled—including stop-word
handling and stemming, and must emit exactly one final token. Zero-token and multi-token values fail
schema activation. The index-time filter matches rules after stemming and emits already canonical
replacement terms, so a rule declared as `laptop → computer` also applies when document text
`laptops` reaches the same `laptop` stem. Emitted replacements do not re-enter the rule matcher, so
reciprocal or chained declarations cannot recurse. This deliberately excludes phrase mappings such
as `"running shoes" → "sneakers"` and `"tv" → "television set"`. Phrase synonyms require explicit
token-graph and position semantics, a versioned rule format, dedicated phrase/highlight tests, and a
generation rebuild when introduced.

A synonym-derived term is an ordinary term at its originating position and receives the same BM25
treatment as a literal occurrence in that weighted source. The first release has no hidden synonym
penalty or synonym-boost option. Tantivy postings do not carry a per-token scoring boost; lowering
derived matches would require duplicate companion streams or a custom scorer, neither justified for
the catalog-scale initial design. Canonical no-op replacements and duplicate replacements for the
same source position are collapsed so a rule declaration cannot manufacture term frequency. Real
occurrences at distinct source positions continue to contribute ordinary term frequency.

The same positioned replacement participates in phrase queries. With `laptop → computer`, source
text `laptop bag` satisfies a phrase query for `computer bag` through Tantivy's ordinary adjacency;
no phrase-specific synonym rewrite or token graph is added. Native highlight tracing follows the
replacement back to its originating position and marks the original visible token `laptop`, while a
multi-token phrase span continues through the last matched source token.

This is a wrapper-owned Tantivy token filter using Tantivy's supported tokenizer/filter API, not a
Harper posting-list implementation. Tantivy continues to own indexing, positions, BM25 statistics,
segments, and merges. Rule count, canonical byte size, replacements per source, and emitted tokens
per input token are hard-bounded. Changing any rule builds and atomically publishes a shadow
generation; live generations never mix synonym revisions. Rules are declared inline in `@fullText`.
The first release does not add a named-set registry, external synonym-file loader, or synonym-table
dependency. This keeps the configuration inside Harper's existing schema lifecycle and prevents a
second configuration watcher from changing indexed meaning outside schema activation.

When `surfaceTerms` is enabled, Tantivy also indexes normalized but unstemmed terms in an internal
field. BM25 continues to use the analyzed/stemmed field. Prefix and fuzzy queries can then expand
against terms customers recognize without changing exact-term ranking.

Configured synonym replacements also enter that bounded surface-term stream. Rule canonicalization
retains both the replacement's final analyzed term and its normalized pre-stem surface term; a
document-side `laptop → computer` emission can therefore be found by prefix `compu`, fuzzy
`computor`, product autocomplete, and a suggestion record using the same index. The surface entry
keeps the originating source-token position, field, and highlight provenance—Tantivy does not store
invented replacement text as record source. It is absent when `surfaceTerms: false`. Synonym rule,
replacement, emitted-term, and query-expansion limits apply before execution, and alternatives for
one logical query term retain the existing zero-tie disjunction-max scoring behavior.

Each `[String]` element is indexed as a repeated value of the same weighted Tantivy field. Positions
reset between elements, so a phrase cannot cross an array boundary. BM25 field length is the sum of
the analyzed terms across non-null elements, and term frequency aggregates normally across those
elements. Null and empty elements contribute no terms. Harper does not add best-element scoring or
create one hidden Tantivy document per array element.

If the complete declared projection produces zero searchable terms after analysis—including an
all-null, all-empty, or stop-word-only record—the mutation deletes any prior document and does not
add a key/version-only replacement. The mutation still completes normally and advances the derived
watermark. A later searchable version is added through the ordinary upsert path. Consequently,
native/index status document counts mean searchable documents, not total Harper records; table totals
remain owned by Harper.

## Query design

### Programmatic `Table.search()`

```js
for await (const product of tables.Product.search({
	conditions: [
		{
			attribute: 'search',
			comparator: 'matches',
			value: 'waterproof trail running shoes',
		},
		{ attribute: 'search', comparator: 'matches', value: 'used', negated: true },
		{ attribute: 'status', comparator: 'equals', value: 'active' },
	],
	sort: { attribute: 'search', descending: true },
	select: ['id', 'title', 'brand', '$score'],
	limit: 20,
})) {
	// existing async search iteration
}
```

Highlighting is off unless `$highlights` is selected:

```js
tables.Product.search({
	conditions: [{ attribute: 'search', comparator: 'matches', value: 'waterproof boots' }],
	select: ['id', 'title', '$score', '$highlights'],
	limit: 20,
});
```

Each returned record may then contain:

```json
{
	"$highlights": {
		"complete": true,
		"fragments": [
			{
				"attribute": "description",
				"sourceStart": 0,
				"text": "Lightweight waterproof boots for winter trails.",
				"matches": [{ "start": 12, "end": 22 }]
			}
		]
	}
}
```

`$highlights` is query metadata, like `$score`, rather than stored record data. Harper sends only the
current source values for returned top-k records to the wrapper's bounded `traceMatches` operation.
Search returns an opaque, versioned match plan when `$highlights` is requested; the trace operation
uses that plan and the published generation's exact analyzer and synonym rules. Harper does not
recreate tokenization, stemming, prefix, fuzzy, fuzzy-prefix, phrase, or synonym matching in JavaScript. Every
entry names its source attribute, contains one bounded plain-text fragment, and identifies matching
half-open `[start, end)` UTF-16 code-unit spans within that fragment. This matches JavaScript and
browser `text.slice(start, end)` semantics. Native tracing maps every released comparator back to the
original source bytes, converts only bounded returned matches to UTF-16 offsets, and validates
boundaries so no span splits a Unicode scalar value or surrogate pair. Harper never injects HTML or
other presentation markup. Public match entries remain exactly `{ start, end }`: exact, stemmed,
folded, prefix, fuzzy, fuzzy-prefix, and synonym match kinds are internal inputs to fragment quality and operator
diagnostics, not durable response semantics. Hard limits cover records, source bytes, fragments,
match spans, and response bytes;
only readable, highlight-eligible full-text source attributes may contribute text. Harper considers
all eligible sources in the declared index and returns a bounded set of the strongest fragments,
labeled by attribute. String and string-array sources are eligible by default. Blob sources
participate only when their `FullTextSource` has `highlight: true`; their content retrieval, UTF-8
decoding, bytes, and concurrency are charged to the highlight budget. Match quality and field weight
determine fragment order, with schema source order as the deterministic tie-breaker. It does not add
a query-time highlight-field selector; callers request the capability solely by selecting
`$highlights`. Highlighted string-only and Blob-enabled queries are separate benchmark classes.

Every fragment includes zero-based `sourceStart`, the UTF-16 code-unit offset where its `text` begins
in the scalar or selected array/Blob source value. Fragment `text` is an exact source substring with
no inserted ellipsis, and match offsets remain relative to that string. A client maps a match back to
the source as `sourceStart + match.start` and `sourceStart + match.end`; `text.length` identifies the
fragment's source end. Native tracing and the Harper façade validate every source and fragment
boundary before returning it.

A fragment from a `[String]` source also includes zero-based `valueIndex`, identifying the array
element supplied to native tracing. Scalar `String` and `Blob` fragments omit the property. Harper
checks the value against the exact materialized source array before serialization; it is not a
persisted Tantivy ordinal. This lets clients distinguish repeated or similar array values without
introducing a generic source-path syntax.

Native tracing creates bounded context windows, then merges windows that overlap or touch only when
they belong to the same source attribute and scalar/Blob value or array `valueIndex` and their union
fits the server hard cap. The merged fragment remains one exact source substring; overlapping match
spans are coalesced. A union that would exceed the cap remains as separately rankable bounded
candidates rather than producing an oversized fragment. Fragment ranking and `maxFragments` apply
after this merge, preventing duplicate snippets from consuming the result budget.

When merged candidates exceed `maxFragments`, Harper orders them by descending distinct positive
query-clause coverage, then descending internal match quality combined with the declaration's source
weight, then descending match density. Match quality uses the validated native query plan's fixed
semantics—such as the lower fuzzy boost—while synonym-derived and literal terms remain equal as
specified above. Remaining ties resolve by schema source order, ascending `valueIndex` where present,
and ascending `sourceStart`. This ranking selects explanatory metadata only; it cannot change a
document's BM25 score or position in the search results.

Selection is one global pool across every eligible source and array value in the hit. Harper does
not reserve a slot per attribute, prefer source diversity, or impose a per-value quota before taking
the strongest `maxFragments` candidates. Multiple fragments from one source/value are valid when
they cover distinct nonoverlapping regions that survive merging and outrank alternatives. Stable
ties still use source order, `valueIndex`, and `sourceStart` as defined above.

A non-phrase trace spans the complete original lexical source token. This includes stemmed,
diacritic-folded, prefix, fuzzy, fuzzy-prefix, and synonym-derived matches: `trai` highlights `trail`, a query typo
such as `waterprof` highlights the source token `waterproof`, and a `shoe` synonym match may highlight
the original source token `sneaker`. It does not return edit-aligned or query-length substrings. A
phrase produces one continuous span from the first matched source token through the last, including
the original separators between them. Phrase spans never cross a field or array-element boundary.

Highlighting is best-effort metadata and cannot invalidate otherwise valid hits or scores. A record
whose eligible sources were fully examined returns `complete: true`, including when `fragments` is
empty. If an opted-in Blob is unavailable, has changed underneath its record version, cannot be
decoded as declared UTF-8 text, or the bounded highlight work/response budget is exhausted, Harper
returns the available fragments with `complete: false`. It does not silently claim a complete empty
result or fail the full search. Customer output does not reveal the failed source or internal cause;
operator metrics and logs classify retrieval, media-type, decode, version, and budget failures
without recording query text or Blob content.

`matches` is a new comparator valid only for `FULLTEXT` fields. Existing `contains` remains literal
substring behavior and must not change meaning.

The initial comparator family remains within the existing Harper condition shape:

```js
// Require every analyzed term.
{ attribute: 'search', comparator: 'matches_all', value: 'waterproof trail shoes' }

// Require an exact phrase; phrase slop is not exposed initially.
{ attribute: 'search', comparator: 'matches_phrase', value: 'trail running shoes' }

// Complete only the final token: "waterproof trai" → "waterproof trail ...".
{ attribute: 'search', comparator: 'matches_prefix', value: 'waterproof trai' }

// Explicit typo-tolerant search with conservative Harper-owned bounds.
{ attribute: 'search', comparator: 'matches_fuzzy', value: 'waterprof trail shoes' }

// Typo-tolerant autocomplete: completed terms exact, final term fuzzy-prefix.
{ attribute: 'search', comparator: 'matches_fuzzy_prefix', value: 'waterproof trsil' }
```

The existing Harper condition tree also supports a bounded full-text Boolean subtree on one index:

```js
tables.Product.search({
	conditions: [
		{
			operator: 'or',
			conditions: [
				{ attribute: 'search', comparator: 'matches_phrase', value: 'hiking boots' },
				{ attribute: 'search', comparator: 'matches', value: 'trail shoes' },
			],
		},
		{ attribute: 'status', comparator: 'equals', value: 'active' },
	],
	limit: 20,
});
```

`matches` never applies prefix or fuzzy behavior. Those semantics are available only through their
named comparators. This keeps normal full-text latency and result sets predictable.

`$score` is select-only query metadata analogous to HNSW's `$distance`; it is not a schema sort
attribute and is not persisted. Larger scores are better. Scores are meaningful within one query
and index generation; score magnitudes are not stable across schema, analyzer, corpus, or engine
upgrades. The first release therefore has no schema or query `minScore` threshold. `Table.search()`
and REST reject rather than silently accept such an option.

The full-text field itself is the sort attribute, following HNSW's use of the derived attribute as the
sort target but not its polarity: lower HNSW distance sorts ascending, while higher full-text score
sorts descending. When no sort is supplied, results default to descending relevance. An explicit relevance
sort is `sort: { attribute: 'search', descending: true }`; ascending relevance is rejected. In the
initial release, a full-text condition cannot use a different primary sort because producing a
complete match set for post-ordering would defeat Tantivy top-k execution. Deterministic secondary
ordering is limited to ties inside the returned relevance window. Equal scores are ordered by the
canonical encoded Harper primary key in ascending byte order. This implicit tie-breaker is always
present, is not a customer sort option, and keeps repeated queries deterministic across workers,
replicas at the same published state, restarts, and storage implementations.

Full-text search keeps Harper's existing `limit` and `offset` controls. Ranked searches enforce a
benchmark-defined maximum offset to protect tail latency. The maximum is release-owned, documented,
and identical through `Table.search()` and REST; it is not a schema or request option. A larger
offset fails with `FULLTEXT_QUERY_LIMIT` before native execution. The internal candidate cursor, if
required by qualification, cannot bypass this limit and is never returned to the caller. Harper's
result-window limit must be equal to or lower than the wrapper's fixed release ceiling. The wrapper
also enforces that non-bypassable ceiling for standalone callers and identically in native and Rocks
storage modes.
Harper generalizes the existing custom-index count guard to a storage-neutral
`touchesDerivedIndex()` capability. `Prefer: count=exact` then reports the total as unavailable rather
than draining a bounded full-text iterator or returning a new error. Estimated counts are returned only when
cached index statistics can produce a safe estimate. Autocomplete requires offset zero and never
computes a total. This feature does not add a pagination or count protocol.

### REST

The application enables Harper's existing schema and REST plugins:

```yaml
graphqlSchema:
  files: schema.graphql
rest: true
```

Because `Product` is marked `@export`, Harper generates these routes through that REST API.

The same condition is expressed through the existing exported-table collection API and FIQL-style
named comparator:

```http
GET /Product/?search=matches=waterproof%20trail%20running%20shoes&status=active&sort(-search)&select(id,title,brand,$score)&limit(20)
```

The other matching modes use the same REST shape:

```http
GET /Product/?search=matches_all=waterproof%20trail%20shoes&limit(20)
GET /Product/?search=matches_phrase=trail%20running%20shoes&limit(20)
GET /Product/?search=matches_prefix=waterproof%20trai&limit(10)
GET /Product/?search=matches_fuzzy=waterprof%20trail%20shoes&limit(20)
GET /Product/?search=matches_fuzzy_prefix=waterproof%20trsil&limit(10)
```

Existing REST grouping and `|` syntax expresses the same supported OR shape:

```http
GET /Product/?(search=matches_phrase=hiking%20boots|search=matches=trail%20shoes)&search=not_matches=used&status=active&limit(20)
```

Programmatic queries use Harper's existing `negated: true` property. REST uses the corresponding
`not_matches*` comparator spelling resolved by the existing negatable-comparator mechanism.

The REST parser translates each named comparator into the same condition object used by
`Table.search()`. OpenAPI and resource metadata list these comparators only for full-text fields and
document `$score` and `$highlights` as conditional response metadata. REST opts in through the same
projection mechanism:

```http
GET /Product/?search=matches=waterproof%20boots&select(id,title,$score,$highlights)&limit(20)
```

Full-text comparator values use a string-only decoder after URI decoding, not Harper's named-FIQL
typed decoder. Text such as `color: red`, `null`, or `date:2024` remains literal query text. Numeric,
Boolean, date, list, and wildcard coercion does not run for the `matches*` family.

### Query planner and filtering

Full-text matching composes with Harper's existing AND condition trees. At catalog scale,
post-filtering a small Tantivy top-k can underfill results, while materializing every text match in
JavaScript can destroy latency. The planner needs two bounded strategies:

```text
Selective structured condition                 Text-first condition
           │                                           │
           ▼                                           ▼
Harper index produces candidate keys         Tantivy produces ranked candidates
           │                                           │
           ▼                                           ▼
packed key set passed to native search        Harper validates record + predicates
           │                                           │
           ▼                                           ▼
Tantivy ranks only eligible documents         validate one bounded window; cursor if gated
```

- **Structured-first:** When a structured index estimate is below both the configured ID-count and
  byte limits, Harper enumerates its canonical encoded primary keys and passes one packed key set to
  Rust. Tantivy applies an exact `TermSetQuery` over an untokenized internal primary-key field inside
  a `BoostQuery` with boost `0.0`. Tantivy 0.26.1's bare `TermSetQuery` reports a constant score, so
  the explicit zero boost is required to keep eligibility from changing `$score` while scoring only
  eligible documents.
  Construction has its own time, count, and byte budget; broad predicates never take this path.
- **Text-first:** Tantivy returns an oversampled ranked candidate window. Harper loads current
  records, rejects missing/deleted/unauthorized/version-mismatched candidates, applies the remaining
  structured predicates, and either fills the requested window, proves native exhaustion, or returns
  a typed budget error. The initial path makes one bounded native candidate-production pass. If that
  path cannot meet the supported filtered-query correctness and p99 gates, an opaque cursor pinned to
  the same native searcher is required before release; Harper does not restart top-k with a larger
  limit.

The one-pass candidate count is
`min(maxCandidateWindow, max(offset + limit, ceil((offset + limit) * candidateOverfetchFactor)))`.
Both values are process-owned immutable hard limits reported by wrapper capabilities;
`maxCandidateWindow` must be at least `maxResultWindow`. Phase 0 freezes their shipped numeric values
from the declared filter-selectivity workload before implementation promotion. No implementation may
choose its own unreported factor or grow the window adaptively inside one request. If the frozen
single pass cannot satisfy the result-completeness and latency gates, the pinned-searcher cursor is a
release requirement rather than a larger hidden window.

The encoded Harper primary key is the stable document identity and equal-score ordering key. Updates
and deletes use delete-by-term on that field before adding the current version, and result rows
return the same key bytes. This avoids a second durable numeric-ID space, allocator, high watermark,
reverse mapping, and reuse/recovery protocol. The scoring/filtering path has no per-document Rust-to-JavaScript callback
per term, posting, document, or candidate. Phase 0 compares bounded key-term filtering with a numeric
bitmap; if the encoded-key path cannot meet the agreed filter workload, the design must be reviewed
before introducing a durable ID mapping rather than adding one implicitly.

The planner promotes the positive full-text subtree to the lead position regardless of its
cardinality estimate. It does not pass Harper's current per-record `filteredSearch` callback into
Rust. Synchronous `estimateCount` uses cached generation statistics and a conservative heuristic; it
never crosses Node-API and it does not control whether FULLTEXT leads.

The planner extracts one full-text Boolean subtree as the lead condition. Every leaf must target the
same `FullText` attribute, but the subtree may use Harper's existing bounded AND, OR, and negation
structure to combine any supported `matches*` comparators. Harper canonicalizes duplicate leaves
without changing group polarity, enforces depth and total-clause budgets, and recursively builds
Tantivy `BooleanQuery` nodes. AND children become `Must`, OR children become `Should` with at least one
required match, and valid exclusions become `MustNot`. A document's relevance is the sum of the
boosted positive clauses it matches; exclusions contribute no score. Repeating a canonical clause
cannot inflate rank.

Every disjunctive branch must contain a positive scoring anchor. Negation may narrow an AND branch
that is already constrained by a positive full-text clause, but it cannot form its own complement-
of-index branch. Thus `(boots OR shoes) AND NOT used` is valid, while `boots OR NOT used` is rejected
before native execution. Validation proves this property recursively after normalization rather than
checking only for one positive leaf somewhere in the tree.

Ordinary structured predicates may be AND siblings outside the extracted subtree and use the same
structured-first or text-first strategies. The first release rejects a structured condition nested
inside a full-text OR branch, leaves targeting different `FullText` attributes, a tree with no
positive full-text clause, an OR branch without its own positive anchor, relationship-path full-text
attributes, and `enforceExecutionOrder` on a full-text query. Those shapes cannot fall through to
`filterByType` or a primary-store scan. They return a typed 400 response before planning. Queries
against the target table directly remain supported; mixed-union, cross-relationship, and cross-index
score composition are deferred.

### Query safety and bounds

Harper builds structured Tantivy query objects from parsed Harper conditions. Raw user text
must never be passed to Tantivy's `QueryParser`; otherwise Tantivy syntax, field access, and parser
behavior become an unintended public API.

Query values are validated as well-formed UTF-16 before normalization or native encoding. An
unpaired surrogate returns `FULLTEXT_INVALID_REQUEST` as a 400 response without echoing the query
text or entering native execution. Harper never relies on a JavaScript, Node-API, or UTF-8 encoder's
lossy replacement behavior.

After applying the selected analyzer, a full-text leaf that contains zero searchable terms compiles
to match-none. This includes an empty value and a value composed entirely of enabled `english@1`
stop words. A standalone match-none query returns an ordinary empty result without entering the
native search pool. Within a supported full-text Boolean subtree it retains normal Boolean meaning:
it makes a required conjunction unsatisfiable and contributes nothing to a disjunction. It never
becomes an unfiltered scan, changes analyzer behavior, or retries with stop-word removal disabled.

The query layer needs bounded values for:

- input bytes and analyzed terms;
- Boolean clause count;
- prefix/fuzzy/fuzzy-prefix expansion and automaton work;
- candidate over-fetch or cursor-production work;
- eligible-key count, bytes, term-set construction time, and fallback count;
- timeout/cancellation;
- deep offset pagination;
- count-preference handling without an unbounded exact-count scan.

These limits protect p99 latency and fair capacity sharing. Boolean depth, total-clause, and term-
expansion ceilings are release-owned constants rather than workload inputs. Harper validates them
before crossing Node-API, and the native package enforces the same ceilings defensively. A release
may change them only with benchmark evidence and corresponding documentation and compatibility-test
updates.

Every documented minimum “character” length—identifier component two, exact-prefix three, and fuzzy
or fuzzy-prefix four—is counted as Unicode scalar values in the applicable normalized surface term
after NFKC, full case folding, and Latin folding and before stemming. UTF-8 byte length and UTF-16
response offsets do not determine query admission. Independent maximum byte/term/source limits still
bound storage and allocation. Golden fixtures cover normalization expansions and non-ASCII terms so
the JavaScript and Rust preflight checks cannot disagree.

Fuzzy edit distance uses Tantivy's native Unicode-character semantics over that normalized surface
term. Tantivy constructs the Levenshtein DFA from Rust `char` values and compiles it into an
equivalent UTF-8 byte-consuming automaton for term-dictionary traversal; a multibyte Unicode scalar
therefore does not consume multiple edits merely because of its encoding. Harper does not implement
a second byte-, UTF-16-, or grapheme-cluster distance. Golden fixtures include non-ASCII
substitutions, insertions, deletions, and adjacent transpositions and are part of the Tantivy-upgrade
compatibility gate.

Full text adds no customer timeout field to `@fullText`, `Table.search()`, or REST. At planning,
Harper computes one absolute native deadline from the remaining existing request deadline and the
hard server safety ceiling, whichever is earlier. Queueing, analysis, candidate production,
materialization, and optional highlight tracing all consume that same end-to-end budget; no stage
or cursor pull resets it. Existing request cancellation and client disconnects propagate to the
same cooperative native cancellation token.

Admission control applies before a request enters the Rust search pool. It budgets queue depth,
queued work, and concurrent expansion separately for ordinary term/phrase searches and the more
expensive prefix/fuzzy/fuzzy-prefix/autocomplete classes. One client cannot occupy every search slot with
maximum-expansion requests; excess work receives a retryable 503 before analysis or term expansion.
Cancellation removes queued work promptly, and per-class capacity always reserves progress for
ordinary bounded searches.

The first release adds no wrapper-owned result or compiled-query-plan cache. Every request analyzes
and executes against one pinned published Tantivy searcher and ranking revision, relying on
Tantivy's reader structures and Harper's existing shared RocksDB block cache for warm-path reuse.
Qualification measures warm and cold p99 without repeated identical-query hits. This prevents stale
generation results, authorization/filter cache-key explosion, and native memory competition with
authoritative records. Applications remain free to cache complete authorized responses above
`Table.search()` under their own freshness contract.

### Public errors and degraded behavior

Programmatic and REST queries share the same typed Harper errors. REST uses the existing Resource
error serialization; full-text search does not add an error envelope or endpoint.

`FULLTEXT_QUERY_LIMIT` uses the existing error `detail` path. It identifies the violated constraint,
the reason (`required`, `nonFinite`, or `maximum`), and the effective numeric maximum when applicable.
It never includes the supplied value, query text, analyzed terms, or record data. Programmatic
callers receive the same detail that Harper's existing RFC 9457 REST serialization emits.

| Condition                                                                                                                                                                                                              | Harper error code                |                  HTTP status | Behavior                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index is building or has no published generation                                                                                                                                                                       | Existing `INDEX_REBUILDING`      |                          503 | Reuse `IndexRebuildingError`, include index identity/state, and never scan.                                                                       |
| Active generation failed or cannot open                                                                                                                                                                                | `FULLTEXT_INDEX_FAILED`          |                          503 | Fail closed and expose the operator-visible failure ID.                                                                                           |
| Comparator requires disabled positions or surface terms                                                                                                                                                                | `FULLTEXT_CAPABILITY_DISABLED`   |                          400 | Identify the comparator and schema option required; changing it triggers a rebuild.                                                               |
| Query text contains an unpaired UTF-16 surrogate                                                                                                                                                                       | `FULLTEXT_INVALID_REQUEST`       |                          400 | Reject before normalization/native encoding and never replace malformed input lossily.                                                            |
| Query has a missing, infinite, or oversized `limit`, exceeds the maximum `offset`, or exceeds input, clause, expansion, or work limits                                                                                 | `FULLTEXT_QUERY_LIMIT`           |                          400 | Reject before or during bounded expansion; invalid result-window values fail before native execution, and no limit can be bypassed with a cursor. |
| Candidate production or validation exhausts its execution budget before `limit` or Tantivy exhaustion                                                                                                                  | `FULLTEXT_QUERY_BUDGET_EXCEEDED` |                          503 | Return no partial page; the caller may narrow filters, lower `limit`, or retry.                                                                   |
| Query exceeds its execution deadline                                                                                                                                                                                   | `FULLTEXT_QUERY_TIMEOUT`         |                          504 | Cancel native work and return no partial response.                                                                                                |
| Native search queue or query-class admission budget is full                                                                                                                                                            | `FULLTEXT_QUERY_BUSY`            |                          503 | Reject before native execution, include retry guidance, and do not expose another request's activity.                                             |
| Operator-only checkpoint wait is not reached before its deadline                                                                                                                                                       | `FULLTEXT_CHECKPOINT_TIMEOUT`    |                          504 | Report opaque checkpoint detail only to an authorized operator; customer query errors expose readiness and a coarse lag category.                 |
| Mixed text/structured or cross-index Boolean tree, pure-negative or unanchored-negative-OR tree, relationship path, branched target, record-level `allowRead`/row filter, `enforceExecutionOrder`, or unsupported sort | `FULLTEXT_QUERY_UNSUPPORTED`     |                          400 | Identify the unsupported query/security shape before execution.                                                                                   |
| LMDB schema declaration                                                                                                                                                                                                | `FULLTEXT_STORAGE_UNSUPPORTED`   | 400 during schema activation | Reject before the application accepts writes.                                                                                                     |
| Unsupported platform or absent optional native package                                                                                                                                                                 | `FULLTEXT_NATIVE_UNAVAILABLE`    |       Schema/startup failure | Name the required platform package and detected platform; never scan.                                                                             |

Normal eventual lag does not produce an error. Queries use the last published generation and expose
lag through status and metrics. Returning fewer than `limit` is complete only when Tantivy has
exhausted the match set. If candidate production or validation reaches its work/deadline budget first, Harper
returns `FULLTEXT_QUERY_BUDGET_EXCEEDED` with no partial response. It never reports how many
candidates authorization, structured predicates, stale versions, or missing records rejected;
those reasons remain operator-only aggregate metrics so the response does not expose unauthorized
candidate cardinality. Autocomplete uses the same bounded contract and should cancel superseded
requests rather than accepting ambiguous partial completion.

Deadline expiration, request cancellation, or any query-work/resource-budget failure discards every
candidate and returns no hit page. A successful response either fills the requested window or proves
that the captured published searcher is exhausted. This rule applies equally to autocomplete. It
does not change the separate best-effort highlighting contract: valid hits may still carry
`$highlights.complete: false` when optional post-search fragment work is incomplete.

Each candidate includes the score, canonical encoded primary key, and indexed Harper record version.
Harper compares that version with the current record before returning it. A version mismatch is
rejected and may trigger another search round, preventing old text from matching a newly updated
record while the index lags.

### Ranking

The initial ranking is weighted BM25 across the declared source fields. The score is a boosted sum:

```text
score(document, query) =
    3.0 × BM25(title, query)
  + 2.0 × BM25(brand, query)
  + 1.0 × BM25(description, query)
  + 1.5 × BM25(keywords, query)
```

For a normal query term, matching more than one declared source adds every field's weighted BM25
contribution. A title occurrence and a description occurrence therefore reinforce one another rather
than collapsing to the strongest field. This cross-field summation is distinct from alternatives
generated for one prefix or fuzzy term, which use the zero-tie disjunction-max rules above to avoid
expansion-driven score inflation.

This uses Tantivy's native BM25 scoring and field boosts. It is not necessarily strict BM25F,
which has a different cross-field normalization model. The public ranking contract is **weighted
BM25**, not BM25F. Harper adds a custom Tantivy `Query`/`Weight`/`Scorer` only if relevance tests
establish a need for BM25F. Field boosts come exclusively from the active `@fullText` declaration;
query callers cannot replace or augment them.

The effective BM25 constants are `k1 = 1.2` and `b = 0.75`. They cannot be overridden in
`@fullText`, `Table.search()`, or REST. Golden relevance fixtures and benchmark manifests record
these values so a dependency change cannot silently alter scoring or pruning behavior.

BM25 magnitude is not a durable filtering contract. Customers use bounded top-k retrieval and
structured predicates, not a score threshold. A threshold can be reconsidered only with an explicit
normalization and compatibility contract; exposing Tantivy's current raw magnitude would make
ordinary corpus growth a query-semantics change.

Product relevance can also depend on availability, popularity, margin, freshness, geography, and
personalization. The initial release supports structured filtering and deterministic tie-breaking
inside the relevance window, but it does not add a ranking-expression language. Numeric business
signals can be combined with `$score` later if relevance tests justify a stable public contract.

### Matching modes

All initial matching modes remain in the Harper comparator family:

| ---------------------- | ---------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `matches` | Weighted BM25 term-any matching | boosted term/Boolean queries | Initial GA. |
| `matches_all` | Require every term somewhere in the record | Boolean `Must` term-across-field groups | Initial GA. |
| `matches_phrase` | Ordered adjacent terms | `PhraseQuery` over stored positions | Initial GA. |
| `matches_prefix` | Require completed terms plus a final prefix | Boolean term groups + surface dictionary | Initial preview; GA after testing. |
| `matches_fuzzy` | Explicit typo-tolerant term matching | Levenshtein/FST automaton | Initial preview; GA after testing. |
| `matches_fuzzy_prefix` | Exact completed terms plus typo-tolerant final | `FuzzyTermQuery::new_prefix` + Boolean groups | Initial preview; benchmark-gated. |

The initial index stores frequencies, norms, positions, and normalized surface terms. This
increases index size and write cost, but avoids rebuilding a 100-million-record catalog to enable
phrase, prefix, autocomplete, or fuzzy behavior. The cost remains a release benchmark gate, not a
reason to omit the data by default.

For `matches_all`, Harper creates one required group per analyzed query term. Each group is a boosted
OR across the declared source fields, and all term groups are required. A title match for one term
and a description match for another therefore satisfies the query, with each field's schema weight
still contributing to score. This is record-level term conjunction, not a same-field constraint.

After analysis, `matches`, `matches_all`, and `matches_fuzzy` deduplicate identical query terms before
building clauses or fuzzy expansions. `matches_prefix` and `matches_fuzzy_prefix` likewise
deduplicate completed exact terms while retaining the final prefix as their distinct required
clause. Repetition cannot manufacture score or consume the clause budget twice. Phrase queries
preserve every analyzed token, including duplicates, because order and repetition are part of their
meaning. A future explicit phrase-prefix comparator would preserve them for the same reason.

Phrase behavior is exact ordered adjacency (`slop = 0`) in the first release. Harper analyzes the
input, constructs a Tantivy phrase query independently for each weighted source field, applies the
field boost, and combines the fields. A phrase never crosses a source-field or string-array-element
boundary. Custom slop can be added later without changing the index format because positions are
already present when phrase search is enabled, but it requires a separately reviewed query shape and
work limits that behave consistently in `Table.search()` and REST.

Prefix behavior creates one required record-level group for every completed analyzed term and one
required expansion group for the final token. Each group searches across all declared weighted
fields, so `waterproof trai` may match `waterproof` in the description and `trail` in the title; it
does not require adjacency or order. Completed terms remain exact, and only the final token expands,
preventing an unrestricted wildcard search. The final analyzed token must contain at least three
characters; shorter prefixes return `FULLTEXT_QUERY_LIMIT` before native execution. This minimum is
fixed in the first release. Harper also enforces maximum term expansions, maximum input terms, a
small result limit, and cancellation. Harper builds each expanded completion with the ordinary
schema field boosts, then wraps those alternative completions in Tantivy's native
`DisjunctionMaxQuery` with a zero tie-breaker. Only the strongest completion contributes to a
document's score; containing several terms with the same prefix cannot multiply the contribution of
one logical query token. An exact ordered `matches_phrase_prefix` comparator is deferred rather than
being hidden inside `matches_prefix`.

The final completion token is structurally required even when analysis removes it. If it is an
enabled stop word—as in `waterproof the`—the complete prefix leaf becomes match-none. Harper does not
drop the final group and broaden the request to the completed terms, and it does not bypass the
configured stop-word behavior for prefix modes. The same rule applies to `matches_fuzzy_prefix`.

An analyzer-recognized trailing token boundary has different intent from a removed final token. For
input such as `waterproof `, every surviving analyzed term is complete and required exactly; there
is no prefix group and no expansion. Harper preserves the trailing-boundary fact during request
analysis rather than trimming the value and treating the last term as incomplete. If no searchable
completed term survives, the leaf is match-none under the preceding rule. Exact- and fuzzy-prefix
modes use the same behavior, and neither may issue an empty-prefix term-dictionary walk.

Fuzzy behavior is bounded:

- multi-term input uses term-any semantics, matching `matches`, while documents matching more
  distinct terms naturally accumulate more score;
- a fixed maximum edit distance of 1, with adjacent transposition costing one edit;
- edits are counted with Tantivy's native Unicode-character semantics over the normalized surface
  term, not over UTF-8 bytes or UTF-16 code units;
- a minimum term length of four characters; shorter terms remain exact;
- no fuzzing of stop words, numeric identifiers, tokens mixing letters and digits, or tokens with
  identifier punctuation such as hyphens, underscores, or slashes;
- a maximum number of fuzzy terms per query;
- a bounded expansion/work budget;
- one zero-tie disjunction-max group per eligible term, containing exact BM25 plus a fixed exact-match
  preference bonus and a lower constant-score fuzzy fallback, so the alternatives never double count;
- no promise that Tantivy's raw fuzzy score is the public Harper score.

The first release has no schema or per-query edit-distance control. Requests cannot raise the
distance above one; the exact-match bonus is greater than the fuzzy branch's fixed score, so an exact
spelling wins its logical-token group while retaining its BM25 contribution. A mixed query remains
valid: in `tv stand`, `tv` is an exact clause while `stand` is eligible for fuzzy fallback.
`matches_fuzzy` does not require every analyzed term. Callers can AND separate single-term fuzzy
conditions when that strict shape is needed; a dedicated `matches_all_fuzzy` comparator is deferred
until workload evidence justifies expanding the public comparator family.
Identifier classification is deterministic and versioned with the query contract. Values such as
`AB-123`, `RTX4090`, `WH1000XM5`, and `12345` remain exact under `matches_fuzzy`; they remain eligible
for ordinary exact and bounded prefix matching. Punctuated identifiers also retain their unstemmed
components for partial discovery, with an exact whole-identifier match receiving the strongest
boost. Golden query fixtures freeze this classification so dependency upgrades cannot silently
change product identity behavior.

Tantivy's native fuzzy term query uses a Levenshtein automaton with constant-score behavior. For each
eligible analyzed term, the exact branch is a Boolean sum of the BM25 `TermQuery` and a
`ConstScoreQuery` over that same term—both clauses are `Must`, so they match the same documents and
their scores add. Harper places that exact branch and the lower-scored native
fuzzy branch inside `DisjunctionMaxQuery` with a zero tie-breaker. This tree is intentional: making
the exact term and its bonus separate outer disjuncts would select rather than add the bonus. The
exact bonus is strictly greater than the fuzzy branch's constant score, so an exact spelling wins the
group even when its BM25 value is low; matching both alternatives does not stack across branches.
The two constants are benchmark-qualified release values, not schema or query options. No expanded-
variant BM25 layer or Tantivy query syntax becomes part of the initial contract.

`matches_fuzzy_prefix` is the explicit preview API for typo-tolerant product autocomplete. Every
completed analyzed term is an exact required record-level group, matching across the declared
weighted sources like `matches_prefix`; only the final normalized surface token may use Tantivy's
native `FuzzyTermQuery::new_prefix` with edit distance one and adjacent transposition costing one
edit. The final token must contain at least four characters. Numeric and product-identifier tokens
use the ordinary exact-prefix branch and never enter the fuzzy automaton. Harper combines the normal
exact-prefix group and a lower-scored fuzzy-prefix fallback with zero-tie disjunction-max. The exact
prefix branch's constant score is strictly higher, so an exact completion wins without stacking. The comparator has fixed term, automaton, result, time,
cancellation, and cumulative work budgets and uses the expensive-query admission class; it accepts
no wildcard syntax or edit-distance option. It remains preview until catalog-scale adversarial
benchmarks meet the latency and saturation gates. This is a structured wrapper call around native
Tantivy query primitives, not a query-parser string or a second autocomplete index.

Initial highlighting reanalyzes only returned Harper records in the native wrapper and does not store
source text or token offsets in Tantivy. It supports term-any, term-all, phrase, prefix, fuzzy,
fuzzy-prefix, stemming, and index-time synonym-derived matches by retaining original-token provenance
during the bounded trace. Only positive scoring clauses produce spans; exclusions never do. This
keeps the feature default-off without making offsets a structural schema capability. Per-source
`highlight` eligibility is a search-only schema policy and does not require a rebuild.

### Autocomplete and suggestions

“Autocomplete” and “suggestions” describe different result types and must not be conflated:

| Capability                         | Result type             | Source                                            | Initial treatment                      |
| ---------------------------------- | ----------------------- | ------------------------------------------------- | -------------------------------------- |
| Product autocomplete               | Current product records | Existing product full-text index                  | Supported by `matches_prefix`.         |
| Typo-tolerant product autocomplete | Current product records | `matches_fuzzy_prefix` over product surface terms | Preview and benchmark-gated.           |
| Brand/category/title suggestions   | Suggestion records      | Customer-managed curated suggestion table         | Supported in the initial scope.        |
| Popularity metadata                | Suggestion records      | Customer-supplied ordinary fields                 | Return/filter only; not a rank signal. |
| “Did you mean?” correction text    | Terms/corrected query   | Term dictionary + correction/ranking logic        | Later native capability.               |
| Personalized suggestions           | Suggestion records      | User/session behavior                             | Outside initial full-text scope.       |

#### Product autocomplete

Product autocomplete is a normal table search and returns authorized, current Harper records:

```js
tables.Product.search({
	conditions: [
		{
			attribute: 'search',
			comparator: 'matches_prefix',
			value: 'waterproof trai',
		},
		{ attribute: 'status', comparator: 'equals', value: 'active' },
	],
	sort: { attribute: 'search', descending: true },
	select: ['id', 'title', 'brand', '$score'],
	limit: 10,
});
```

```http
GET /Product/?search=matches_prefix=waterproof%20trai&status=active&sort(-search)&select(id,title,brand,$score)&limit(10)
```

The preview typo-tolerant form changes only the explicit comparator:

```js
tables.Product.search({
	conditions: [
		{ attribute: 'search', comparator: 'matches_fuzzy_prefix', value: 'waterproof trsil' },
		{ attribute: 'status', comparator: 'equals', value: 'active' },
	],
	sort: { attribute: 'search', descending: true },
	select: ['id', 'title', 'brand', '$score'],
	limit: 10,
});
```

```http
GET /Product/?search=matches_fuzzy_prefix=waterproof%20trsil&status=active&sort(-search)&select(id,title,brand,$score)&limit(10)
```

```text
keystrokes
   │  debounce + cancel superseded request
   ▼
Table.search / REST `matches_prefix` or preview `matches_fuzzy_prefix`
   │
   ▼
Tantivy required exact-term groups + final exact-prefix/fuzzy-prefix group
   │  bounded expansions + top-k
   ▼
current Harper record/version/authorization validation
   │
   ▼
top 5–10 product records
```

Autocomplete produces several rapidly superseded requests per user session. Exact prefix requires a
minimum of three final-token characters; fuzzy prefix requires four. Both omit exact counts and
offsets, cap results, propagate cooperative cancellation to Harper-owned checkpoints, and expose
separate latency, cancellation, expansion, and cache metrics. Fuzzy-prefix load is reported and
admitted separately because native automaton traversal can be substantially more expensive.

Pure BM25 may not be sufficient for product autocomplete. Exact title prefix, availability, and
popularity can matter more than description term frequency. Initial behavior uses weighted BM25
with title boosts. Combining `$score` with business signals requires a separate, stable ranking
contract.

#### Suggestion records

Tantivy cannot infer popularity, conversions, curation, or user intent from product text alone.
Phrase suggestions such as `trail running shoes for women` are customer-managed Harper records:

```graphql
type SearchSuggestion @table @export {
	id: ID @primaryKey
	text: String
	kind: String @indexed
	popularity: Long @indexed
	conversionRate: Float

	search: FullText
		@fullText(fields: [{ name: "text", weight: 1.0 }], analyzer: "english@1", positions: true, surfaceTerms: true)
}
```

The table uses the same full-text index and existing query mechanisms:

```js
tables.SearchSuggestion.search({
	conditions: [{ attribute: 'search', comparator: 'matches_prefix', value: 'trail run' }],
	sort: { attribute: 'search', descending: true },
	select: ['text', 'kind', 'popularity'],
	limit: 8,
});
```

Customers write curated suggestions and may supply popularity or other ordinary ranking fields.
In the initial release those fields are returned metadata and may participate in supported bounded
structured AND filters, but they do not alter full-text ordering. Suggestion results remain ordered
by `$score`; arbitrary sorting of the complete text match set is rejected, and the example's
`popularity` selection does not rank by popularity. Harper does not automatically collect query,
click, or conversion events. A later component may aggregate explicitly permitted events into the
same table without changing the full-text index contract, but blending a business signal with BM25
requires a separately reviewed normalization, update, and ranking contract. This preserves the
normal table, replication, REST, authorization, and lifecycle model without implying an unbounded
post-sort.

#### “Did you mean?”

Fuzzy document retrieval can return useful products for a misspelled query without displaying a
correction. Producing correction text is a different contract: Harper must generate nearby surface
terms, rank them by edit distance and corpus frequency, preserve brands/SKUs, decide whether the
original results are already satisfactory, and assemble a corrected multi-term query. Because that
returns terms rather than records, it may eventually require a small suggestion-specific result
shape. It is not required for the initial full-text release.

## Architecture

### Read path

```text
Table.search / exported REST collection
                 │
                 ▼
Harper condition parser, planner, and authorization
                 │ structured full-text query + optional eligible-key term set
                 ▼
FullTextIndex adapter ── bounded Node-API call ───► Rust / Tantivy
                 ▲                                │
                 │ IDs + scores + record versions │
                 └────────────────────────────────┘
                 │
                 ▼
current RocksDB record/version/authorization validation
                 │
                 ▼
normal Harper projection and response
```

Tantivy returns candidate IDs, scores, primary keys, and indexed record versions, not
customer-facing documents. Harper remains responsible for current-record lookup, version and row
authorization checks, remaining predicates, projection, and serialization. This keeps full-text
search inside the Resource and `Table.search()` execution path.

### Write path

```text
Table.put / post / patch / delete
                 │
                 ▼
Resource transactional wrapper + Table._writeUpdate / _writeDelete
                 │
                 ▼
resolve conflicts, merge PATCHes, and determine final residency
                 │
                 ▼
commit authoritative record + existing transaction-log entry
                 │
                 ▼
same-thread `aftercommit` joins committed log position with final record
                 │
                 ├── unchanged sources/invalidation ──► position-only no-op
                 ├── locally searchable final record ─► project declared sources
                 └── delete/derived-only eviction fact ► delete by encoded primary key
                 │
                 ▼
nonblocking native `deliver()` from the originating worker
                 │
                 ▼
one process-global Tantivy writer per index generation
                 │
                 ▼
bounded hybrid commit scheduler
                 │
                 ▼
Tantivy commit + contiguous aggregate log watermark
                 │
                 ▼
publish RocksDB-backed directory head; reload shared searcher
```

The final record object and effective change mask are captured in transaction-local post-commit
context only after version precedence, PATCH merging, skip decisions, and residency handling are
complete. `RocksTransactionLogStore.aftercommit` supplies the committed opaque position; the
dispatcher joins it to that exact final object without decoding the audit payload again. Projection
selects only declared full-text sources on the originating worker. It performs no tokenization,
Tantivy work, Directory I/O, customer code, or cross-worker JavaScript call.

Table construction hoists a derived-interest bit and compact source-dependency masks. A table with
no derived index pays one predictable false branch and performs no target registry lookup or
projection. For a derived table, a source-unchanged PATCH delivers a position-only no-op so the
generation's contiguous watermark can advance without copying record content. Invalidation that
preserves whole-record indexed discoverability is also a no-op; actual deletion, cache eviction, or
loss of searchable residency emits a delete. This follows Harper's whole-record cache lifecycle
rather than inventing attribute-level eviction behavior.

Current Harper cache eviction and TTL expiration bypass the transaction log. For a RocksDB table with
derived-index interest, Harper adds a local-only `EVICT` control entry using the existing log format's
next reserved action code (`9`) and commits it in the same raw transaction as the version-guarded record
removal. The entry is excluded from replication and customer audit/subscription output but remains a
normal derived-consumer retention fact. This is required because a post-commit notification without a
durable log position could be lost on deferral or crash and leave a permanent ghost document. The
existing worker-0 expiration sweep remains the producer of scheduled expirations; ordinary writes
still deliver from their originating worker.

`deliver()` enqueues and returns. A full or unavailable native lane returns `deferred`; it cannot
delay or reject the record commit. Harper then catches up from the durable transaction log under the
same bounded runtime. Every write-capable worker delivers its own local and replicated commits, so
no worker waits for worker 0 to read or decode another worker's record. The wrapper applies accepted
mutations through one process-global writer per index generation and serializes only commit,
rollback, and publication for that index.

Failure behavior follows the durability boundaries:

- before the RocksDB commit, neither the record nor its log entry is committed;
- after record/log commit but before derived publication, the retained log remains the recovery
  fact;
- a Tantivy commit contains the checkpoint payload, so reopening can identify a durable commit even
  if the process exits before reader reload or in-memory publication;
- publication never advances beyond the checkpoint reported by the reopened adapter;
- deterministic content failures publish explicit quarantine/no-document outcomes and advance only
  when that exact outcome is represented; structural failures stop the generation without advancing
  past the failed position.

Harper table and secondary-index column families run without RocksDB's native WAL, while the root
log store uses WAL. “Commit” here means accepted and visible under Harper's transaction guarantees,
not that every table memtable independently survived power loss. After an unclean restart, replay
resumes exclusively after the published opaque watermark and applies entries through the same
normalizer and backend contract. The root log can therefore survive a table memtable write without
making derived state authoritative. Full text never binds a second transaction log or assigns a
second commit callback.

### Shared derived-index control plane

```text
                     committed Harper record transaction
                                      │
                                      ▼
                    transaction log + opaque position
                                      │
                                      ▼
                           DerivedIndexRuntime
                     ┌────────────────┴────────────────┐
                     │                                 │
                     ▼                                 ▼
                HNSW adapter                    Full-text adapter
              native graph plane        Tantivy directory/storage adapter
                     └──────► published watermark ◄───┘
                                      │
                                      ▼
                    readiness, lag, catch-up, rebuild,
                        generation swap, metrics, close
```

Harper's shared runtime owns behavior common to every non-transactional derived index:

- post-commit mutation delivery;
- durable-log replay and retention reservations;
- source dependency detection and bounded originating-worker projection;
- source/schema/analyzer fingerprints;
- bounded queues and backpressure;
- initial builds and shadow rebuilds;
- atomic generation publication;
- readiness and failure states;
- invalidation and format compatibility;
- graceful close and crash recovery;
- backup/restore policy;
- common metrics and operator errors.

The adapter owns only engine-specific behavior:

- physical storage format;
- schema/open validation;
- application of upsert/delete batches;
- the durability barrier and embedded checkpoint;
- search execution;
- engine-specific corruption checks and statistics.

**Every accepted source mutation is represented either by the selected published generation or by
a transaction-log position retained after that generation's contiguous watermark.** HNSW and
Tantivy do not need identical accuracy, writer topology, or storage mechanics to share that
contract.

### State ownership and identity

| State                                       | Owner                                      | Persistence and scope                                                                                                                   |
| ------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Source records and versions                 | Harper table/primary store                 | Authoritative RocksDB state; replicated normally.                                                                                       |
| Durable delivery queue                      | Harper transaction logs through rocksdb-js | Existing committed entries; retained node-locally while a derived consumer watermark requires them.                                     |
| Committed positions and aggregate watermark | Harper shared derived runtime              | Opaque, versioned, exact-exclusive-resume tokens; Harper and the wrapper never parse their layout.                                      |
| Stable document identity                    | Harper canonical encoded primary key       | Untokenized Tantivy term and packed result key; no second durable ID allocator or mapping.                                              |
| Desired schema and build lifecycle          | Existing persisted attribute descriptor    | Authoritative `indexingPID`, restart, progress, failure, format, and structural-option state.                                           |
| Published derived progress                  | Tantivy commit payload                     | Highest contiguous aggregate log watermark represented by the searchable commit.                                                        |
| Index manifest                              | Derived-index generation storage           | Engine, schema, analyzer, binding/directory format, watermark, and active-generation identity; subordinate to the attribute descriptor. |
| Tantivy objects and segments                | Full-text adapter in the index CF          | Node-local, rebuildable derived state; never authoritative record storage.                                                              |
| Writer and commit actor                     | Process-global native registry             | One `IndexWriter` per canonical storage identity, logical index, and generation; commit/rollback/publication serialized per index.      |
| Reader and searcher                         | Process-global native runtime              | One reader per generation and atomically replaceable `Searcher` snapshots shared through environment-local handles.                     |

Harper's canonical encoded primary key is indexed in a dedicated untokenized bytes field and stored
with each Tantivy document. A mutation deletes by that term and conditionally adds the complete
current projection only when analysis emits at least one searchable term. A termless projection is a
delete-only mutation. Tantivy's segment-local document addresses are never persisted or exposed.

Structured-first filtering passes bounded encoded keys as one packed buffer and constructs a
`TermSetQuery`. Text-first results return the same bytes for current-record lookup. The key codec
version is part of the generation fingerprint, and every decoded result must round-trip through
Harper's primary-key codec before record access.

### Log-backed delivery, watermark, and replay

The transaction log is the only durable mutation queue. Declaring any derived index ensures the
table's internal transaction log remains enabled even when customer-facing audit output is disabled.
Harper does not add a dirty-marker column family, maintenance-target record, per-record
`GetForUpdate` fence, epoch rotation, or marker reclamation path.

The shared contract is conceptually:

```ts
type LogPosition = Uint8Array;
type LogWatermark = Uint8Array;

interface CommittedRecordEntry {
	tableId: number;
	recordId: Id;
	version: number;
	previousVersion?: number;
	nodeId: number;
	txnTime: number;
	logPosition: LogPosition;
	type: 'upsert' | 'delete' | 'invalidated' | 'evicted';
	record?: unknown;
}

interface CommittedBaseCopyControlEntry {
	tableId: number;
	txnTime: number;
	logPosition: LogPosition;
	type: 'base-copy-start' | 'reload';
	copyId: Uint8Array;
	copyCursor: Uint8Array;
}

type CommittedEntry = CommittedRecordEntry | CommittedBaseCopyControlEntry;

type DeliveryOutcome =
	| { status: 'accepted' }
	| { status: 'deferred'; reason: 'busy' | 'source-required' | 'closed' | 'failed' };

interface DerivedIndexBackend {
	readonly needsPreviousValue: boolean;
	deliver(entries: CommittedEntry[]): DeliveryOutcome;
	getWatermark(): LogWatermark | undefined;
	status(): DerivedIndexStatus;
	close(options: DerivedCloseOptions): Promise<void>;
	beginRebuild(context: RebuildContext): RebuildHandle;
}
```

[`hnsw-fulltext-coordination.md`](hnsw-fulltext-coordination.md) is normative for this shared
interface; the copy here is included to keep the complete design readable. These types belong to
Harper core, not the wrapper's public exports. `RebuildContext` contains the opaque boundary plus any
base-copy identity/cursor. The full-text backend sets
`needsPreviousValue = false` because it replaces a document by primary-key term. Harper's shared
protocol owns exact source positions, multi-log coverage, resume and retention-gap detection. Those
semantics must be proven against the supported stack; fulltext treats progress context as opaque
and does not require a new native rocksdb-js cursor API.

`RocksTransactionLogStore.aftercommit` runs after the record and log append commit. The write path
places the final conflict-resolved, post-PATCH, query-visible record object and effective change mask
in transaction-local context. The dispatcher joins that object to the committed position and
projects declared sources on the originating worker. A pre-encoded or bodyless hot entry without a
proven full record returns `source-required` and is recovered by the bounded source-resolution lane;
a PATCH delta is never indexed as a complete document. Retained-log replay always resolves the record
identity against the current authoritative table before projection. It never trusts the log body as
final state because a RocksDB transaction retry can leave the losing attempt's body in the durable log
while the winning attempt stores different content. The replayed position completes only after
applying, deleting, or version-suppressing the resolved authoritative state.

Every write-capable worker delivers its own local and replicated commits. `deliver()` performs
bounded native admission and returns immediately. A saturated or unavailable lane returns
`deferred`; the record commit remains successful, Harper latches catch-up, and replay resumes from
the durable log. This avoids making one JavaScript worker read, decode, or project all other workers'
writes.

The normalizer maps every committed operation exhaustively:

- a final local record whose indexed sources changed becomes a complete upsert;
- a source-unchanged write or invalidation that preserves whole-record searchable residency becomes a
  position-only no-op;
- delete, cache eviction, source-confirmed absence, or loss of searchable residency becomes a term
  delete;
- base-copy start and completion are explicit control facts; copy rows enter a private building
  generation through the rebuild channel rather than fabricated log positions;
- unknown or corrupt operation types fail the affected generation closed rather than advancing its
  watermark.

Accepted mutations are ordered and idempotent by canonical record identity and version. Older
versions are suppressed. Equal version bits with identical canonical operation and projection are
duplicates; different content or operation is `FULLTEXT_VERSION_CONFLICT`. Derived mode holds that
position, serves only the previous validated searcher within `maxStaleSearcherAgeMs`, and asks Harper
to reread the authoritative record. Only an exact-bound repair or a newer authoritative version may
resolve the gap. Standalone `apply()` rejects the conflicting batch before changing it.

A derived commit may publish only the highest aggregate watermark for which every earlier required
position is represented by an upsert, delete, deterministic no-op/quarantine outcome, or exact
repair. That watermark is written through Tantivy's existing commit payload and becomes searchable
with `meta.json`. In-memory admission receipts, wrapper-local sequences, and later positions cannot
skip a hole. Merge-only commits preserve the current watermark.

At startup or after deferral, Harper resumes exclusively after the published watermark. A replay
overlap is harmless; a cursor from a recreated log cannot silently address the new incarnation. The
consumer's durable retention reservation is established before purge policy runs. If exact replay is
no longer possible, the generation becomes `NEEDS_REBUILD` rather than guessing from timestamps or
performing a silent skip.

Blob content remains under Harper's blob owner. Local committed content is projected only through
the existing blob codec and a renewable, expiry-observable derived-consumer content lease.
Replication may commit a record while a referenced blob is still pending; that entry returns
`deferred/source-required`, holds the watermark only inside the frozen blocking-gap budget, and
retries after content arrives. Expiry publishes record quarantine before staging or freshness limits
are crossed. The wrapper never treats
raw file bytes as text, controls blob reclamation, or invents a second blob store. Rebuild of a
caching table rehydrates the whole record through Harper's existing source path when local content is
not resident.

#### Rebuild ownership

The native wrapper never enumerates source records or orchestrates a rebuild. It creates and
validates a generation, accepts bounded complete mutation batches, commits/checkpoints them, reports
terminal `rebuildRequired` state, and closes the generation. Its API exposes no Harper table, source
iterator, URL, credential, or callback registration.

Harper durably captures an opaque log boundary, creates a private `BUILDING` generation through its
existing attribute lifecycle, and scans authoritative records while live delivery continues.
Replication base copy uses its existing copy identity and resume cursor; each committed full-record
batch is projected directly into the private generation. Harper then replays the retained log after
the captured boundary, proves contiguous cursor coverage through copy completion and ordinary
catch-up, validates the searcher, and uses the catalog transaction to swap generations. If the gap
cannot be replayed, the build remains unavailable and restarts from authoritative records.

A standalone caller owns the equivalent source enumeration and active-reference swap. rocksdb-js
supplies storage, opaque cursor, retention, flush, and lifecycle primitives only. This keeps rebuild
policy in the host and the same wrapper engine path in native and Rocks storage.

### Commit and visibility

```text
record + log commit ──► post-commit delivery/replay ──► Tantivy writer
                                                        │
                                                        ▼
                                               prepare commit +
                                          aggregate log watermark
                                                        │
                                                        ▼
                                      durable objects + atomic meta/head
                                                        │
                                                        ▼
                                            background reader reload
                                                        │
                                                        ▼
                                      atomically replace shared Searcher
```

For derived mode, Tantivy's commit payload contains a tagged, versioned encoding of the opaque
aggregate log watermark because `IndexMeta.payload` is `Option<String>`. The Directory publishes a
durable head from the `meta.json` replacement only after its objects pass the required durability
barrier. Bootstrap initializes the watermark, a source commit may advance it only across a
contiguous covered prefix, and a merge-only commit preserves it. Reader reload is coalesced in the
background; queries pin the current validated `Searcher` and never wait for publication I/O.

One logical Harper query initially uses one Node-API search call against one pinned `Searcher`. That
call returns one bounded oversampled candidate window, and Harper validates each candidate at most
once. The supported filtered-query workload must satisfy page correctness and p99 with this path. If
it does not, the release adds an opaque request-scoped native cursor over that same `Searcher`, with
one total order, cumulative work accounting, and the original deadline and cancellation token. It
does not issue progressively larger top-k calls from rank one or ship an underfilled success path.
Harper owns and closes that cursor within the active query. It is never serialized, cannot outlive or
resume across requests or processes, and is not exposed through `Table.search()` or REST as a
continuation token.

The [native HNSW traversal-plane proposal](https://github.com/HarperFast/harper/pull/2430)
currently dual-writes from each worker at index-store mutation sites, uses shared mmap slot
synchronization, and leaves committed watermark/replay for a later phase. Moving HNSW to the shared
post-commit log-backed protocol in issue #2489 would remove rollback phantoms and lost mirror writes,
but full text does not claim that future HNSW behavior as an existing foundation.

### Consistency contract

The default query contract is eventual:

- a newly committed record may be absent until the next published Tantivy commit;
- an updated or deleted record may remain as a candidate until that commit;
- every returned candidate is loaded from Harper under current authorization and version rules;
- a missing, deleted, stale-version, or unauthorized candidate is rejected;
- filtering returns the requested page, exhausts the Tantivy match set, or fails with the typed
  query-budget error; budget exhaustion is never presented as a complete underfilled page;
- lag is bounded by policy and exposed as metrics/status, not hidden.

Publication checkpoints are operator-visible state, not a customer query token. `Table.search()` and
REST neither accept a write receipt nor wait for a requested index position; they immediately use the
latest published generation. Unknown consistency/watermark options fail normal request validation
rather than being silently ignored. Internal lifecycle, backup, qualification tests, and authorized
operator diagnostics may await a checkpoint under a separate bounded timeout. Customer errors
expose readiness and a coarse lag category without returning requested or visible checkpoint values,
which would reveal write-rate information. Adding customer read-your-write behavior would require a
separate public consistency design and is not an implied follow-on capability.

### Lifecycle and shadow rebuilds

```text
ABSENT ──► BUILDING ──► CATCHING_UP ──► READY
              │              │             │
              └──────────────┴─────────────┼──► FAILED
                                           ├──► DEGRADED
                                           └──► REBUILDING ──► READY
```

Indexed-schema, analyzer, or format changes create a new generation:

```text
durably mark shadow generation BUILDING
                 │
                 ▼
open bounded primary-key scan while every
concurrent mutation remains in the retained log
                 │
                 ▼
replay after captured boundary, prove contiguous
watermark coverage, validate generation B
                 │
                 ▼
durability barrier + publication checkpoint
                 │
                 ▼
atomically publish B; retire generation A
```

An initial build may return a clear `503 index not ready` for queries requiring it. During a
compatible rebuild, the old READY generation continues serving until the new generation is caught
up and atomically swapped. The attribute descriptor therefore distinguishes `activeGeneration`
from `buildingGeneration`; `isIndexing` is generation-scoped and the search path rejects only when
there is no serviceable active generation. The derived-index runtime does not call the existing
`runIndexing` clear path for a rebuild. The persistent manifest contains the storage/table
incarnation, index identity, schema fingerprint, format version, generation, and opaque log
watermark. A deletable `.stale` marker is not lifecycle authority.

The current schema backfill loop may run on whichever worker holds `indexingPID` and calls
`customIndex.index()` synchronously. A full-text derived descriptor never enters that path; the
schema lifecycle hands its generation-scoped build to the derived-index runtime instead. Its
`BUILDING`, progress, and failure state still map onto existing `isIndexing`/`indexingFailed`
behavior so queries return `INDEX_REBUILDING` rather than a partial generation.

The persisted Harper attribute descriptor remains authoritative for desired schema and build
ownership. Existing `indexingPID`, restart generation, `lastIndexedKey`, `indexingFailed`,
`indexFormat`, `canonicalIndexKey`, and `searchOnlyOptions` machinery drives and resumes the scan.
The generation manifest records engine-local compatibility, checkpoint, and publication state; it
cannot independently start a competing build. `positions`, `surfaceTerms`, the canonical order-
independent set of source field identities/types, synonym rules, stop-word behavior, and analyzer
version are structural options and are never listed as search-only. Source weights are separately
fingerprinted ranking options. Schema activation
atomically replaces one immutable ranking configuration after confirming that its field identities
match the active generation. Each query captures the configuration once with its `Searcher`, so a
request cannot mix old and new weights. The native Directory and postings are untouched.

Resolved per-source highlight eligibility, declaration order, and the `highlighting` fragment
settings are descriptor `searchOnlyOptions` values. Declaration order is used only as the final
highlight-fragment tie-breaker. Changing any of these values updates query behavior without
rebuilding or changing the native generation fingerprint.

The bulk build does not hold a 100-million-record RocksDB snapshot. It uses bounded Harper backfill
chunks, records `lastIndexedKey`, and captures an opaque log boundary before scanning. Concurrent
mutations continue through the active generation and remain replayable from that boundary. Final
catch-up resumes exclusively through the retained-log cursor and publication waits for contiguous
coverage. Duplicate scan/replay application is harmless because updates delete by primary-key term
and add only the winning version.

Lifecycle teardown is explicit:

- `clear` starts a new table/index incarnation, closes the active generation, and rebuilds from the now-empty
  table before serving;
- dropping `@fullText` unregisters its consumer, closes readers/writers, advances retention past that
  consumer, and removes generation storage after all native handles release it;
- dropping a table or database performs the same cleanup for every derived index below it;
- a crash during teardown is resumed from the attribute descriptor and manifest, making directory
  removal idempotent.

Transaction-log retention, exact replay and rebuild decisions belong to Harper's shared protocol. Detect gaps before trusting a stored watermark, including during boot and restore. The fulltext design does not require a new rocksdb-js cursor/retention ABI; the supported implementation must be proven before activation.

### Upgrade, rollback, and format compatibility

The generation manifest records four independent compatibility values: Harper derived-index
protocol version, analyzer identifier, native binding format version, and Tantivy index format
identity. The adapter reports the versions it can read and write before Harper opens a generation.
Harper never assumes that a Node-API ABI match means the on-disk index is compatible.

`@harperfast/fulltext` begins on a `0.x` release line. Before `1.0`, a minor may make a declared
public-API or persisted-format break; a patch may not silently do so. Lowering an advertised package
hard limit is a public-API break and therefore requires a declared `0.x` minor. Raising one is
non-breaking but requires native and Rocks benchmark evidence against the applicable resource,
correctness, and latency gates. Every package release declares its API revision, complete hard-limit
table and digest, readable and writable storage-format identifiers, supported Harper storage integration tuple,
qualified storage-stack fingerprints, and whether an upgrade opens in place, rebuilds, or migrates.
`CHANGELOG.md` is the authoritative human-readable record and generated GitHub release notes mirror
it. The latest `0.x` minor is the initial supported feature line, with any additional security-
maintenance window stated explicitly in `SECURITY.md`.

Harper exact-pins the manifest-qualified fulltext and rocksdb-js pair used by a release. An
undeclared or incompatible format fails closed; Harper does not guess compatibility or fall back to
Tantivy native storage. It builds a compatible shadow generation from authoritative Harper records,
catches it up, and publishes it through the ordinary generation protocol.

Native mode is independently usable. The planned Harper entry point uses Harper-owned storage and derived-delivery integration. There is no supported standalone rocksdb-js mode or optional peer; compatibility qualification covers the actual Harper/fulltext/storage stack.

Deployment follows a binary-first sequence:

1. deploy a Harper/native binding version that can read the current generation and understands the
   proposed schema/analyzer version;
2. verify capability on every serving node;
3. activate the schema change;
4. build and catch up a shadow generation on each node;
5. publish the new generation only after validation and the durability barrier;
6. retain the previous compatible generation through the configured rollback window.

A code upgrade that can read the current format opens it in place. A change to indexed meaning,
analyzer behavior, derived-index protocol, or writable Tantivy format builds a new generation.
Changing only source weights atomically replaces the schema-owned ranking configuration without a
generation build; every in-flight query remains pinned to the configuration revision it captured.
Nodes that do not understand the required capability reject schema activation rather than serving
different analysis. Each node can rebuild independently because Harper records and retained
transaction logs are authoritative; Tantivy generations are not replicated between nodes.

Rollback reactivates the retained generation only when its schema fingerprint still matches the
rolled-back application schema and its checkpoint can catch up from retained transaction logs.
Otherwise the older binary rebuilds a compatible generation from Harper records. A downgrade that
cannot read the active manifest fails closed and reports the required version. Generation retirement
waits for the rollback window, log-retention safety, and confirmation that no process holds an
active reader.

## Tantivy integration

### Node-API adapter

Tantivy is Rust, so Harper needs a native adapter. The adapter uses `napi-rs` and executes
in-process, matching the native HNSW plane. A sidecar cannot borrow Harper's in-process RocksDB
handles, while proxying every directory read back to Harper would put IPC inside the search loop.
The in-process path is therefore part of the release architecture, with strict panic containment
and fault tests. If native crash telemetry shows process isolation is necessary, the design must be
revisited; Harper does not switch to a filesystem-backed Tantivy release as a fallback.

The public package/module is `@harperfast/fulltext` from the independent `HarperFast/fulltext`
repository. It is named for the Harper capability rather than exposing Tantivy in the API name. The
Harper integration layout mirrors the native HNSW work:

```text
HarperFast/fulltext                       Rust crate, napi-rs binding, and TypeScript façade
resources/indexes/FullTextIndex.ts        Harper query and derived-backend adapter
resources/derivedIndexes/                 shared post-commit delivery/replay/lifecycle
Harper storage integration                supported store APIs and bounded transport
```

The complete public wrapper surface is specified in
[`tantivy-node-wrapper-plan.md`](tantivy-node-wrapper-plan.md). The Harper-owned derived path uses
the separately named Rocks factory and does not expose native storage:

```ts
interface DerivedRocksFullTextIndex {
	deliver(batch: Uint8Array): DeliveryReceipt;
	commit(options?: { signal?: AbortSignal }): Promise<CommitReceipt>;
	updateRanking(config: FullTextRankingConfig): void;
	search(request: SearchRequest, options?: { signal?: AbortSignal }): Promise<SearchResult>;
	traceMatches(plan: Uint8Array, sources: Uint8Array, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
	reload(): Promise<void>;
	status(): FullTextStatus;
	close(options?: { mode?: 'drain' | 'rollback'; timeoutMs?: number }): Promise<void>;
}
```

Standalone native callers use awaited apply and explicit commit. Harper imports the planned @harperfast/fulltext/harper entry point only after qualification and uses nonblocking derived delivery. Both paths share engine, query, codec and lifecycle implementations; the integration context shape is frozen after the storage proof.

The packed mutation boundary validates a complete batch before it can enter the writer queue. A bad
protocol version, schema/generation fingerprint, field identity, count, offset, length, UTF-8
sequence, trailing byte, or hard-limit violation rejects the whole batch; no valid prefix is
applied and no malformed record is silently skipped. Explicit keyed quarantine markers are valid
mutations and follow the content policy above. This validation atomicity does not turn `apply()`
into a durability receipt: publication still requires `commit()`.

Standalone `commit()` resolves at durable Directory publication and schedules the shared background
reader reload; it does not wait for the new searcher or its bounded structural warm-up. A caller that
needs a visibility barrier invokes `reload()` after commit. That call snapshots the publication
current when it begins and waits until the process-global searcher covers at least that revision,
without duplicating work when a background reload already covers it. Search without the barrier may
briefly use the preceding immutable snapshot. Harper request admission never inserts this wait; it
uses the latest already published searcher under the derived freshness contract.

Standalone native wrapper users publish only by calling `commit()` explicitly. The
wrapper creates no standalone timer, mutation/byte threshold, idle flush, checkpoint, or automatic
commit policy. Harper's separately named derived integration owns the bounded hybrid scheduler and
derives its watermark from the shared cursor protocol; it still uses the same native commit actor.

Standalone `close()` requires a clean writer by default. If queued, applying, or applied-
uncommitted work exists, it returns `FULLTEXT_UNCOMMITTED_WORK` and leaves the handle open so the
caller can commit and try again. `close({ mode: 'rollback' })` is the explicit destructive choice:
it cancels work that has not begun, lets an active bounded batch finish, discards all writer state
after the last commit, and closes. It never publishes that work. Harper's derived lifecycle retains
its separate runtime-owned drain/rollback behavior.

Graceful Harper shutdown stops new derived delivery, immediately flushes each Harper-owned
coalescer, and asks every backend to drain, commit, and durably publish within the time remaining on
Harper's existing shutdown deadline. It does not wait for optional reader warming or merge
optimization. At the deadline, publication stops, not-yet-started work is cancelled, and
uncommitted writer state rolls back through the safe native close path. Harper retains no content
buffer; restart resumes exactly after the last durable published watermark from its transaction log.
An active atomic RocksDB operation still reaches a safe boundary and remains protected by the
existing operation guard—timeout is not permission to force-free native state. Crash or forced
termination skips the optimization and uses the same replay path.

Drain scheduling reuses the normal global and per-database commit permits. Different databases may
progress concurrently within the global limit; initially, indexes sharing a database serialize their
commit/durability barriers. Active serving generations precede shadow rebuilds, then ordering uses
oldest pending log position, publication lag, and accumulated bytes with fair progress among peers.
Shutdown adds no independent thread pool or flush mechanism, never bypasses storage-pressure guards,
and closes a database only after its backends have published or safely rolled back within the shared
deadline.

Current HNSW has no equivalent accepted coalescing queue: its Rocks graph writes are synchronous,
and PR #2430's phase-1 mmap mirror treats an unflushed tail as disposable derived state. If HNSW
later adopts the shared derived protocol, it uses this bounded Harper drain/replay lifecycle rather
than making the phase-1 flush behavior a cross-engine shutdown contract.

Standalone cancellation can remove that complete validated batch while it is queued, producing no
writer mutation. Once writer application starts, the bounded batch finishes and `apply()` resolves
its authoritative receipt even if the signal is then aborted. It never rejects as cancelled after
changing writer state or leaves an unreported suffix. Harper's nonblocking derived delivery instead
uses its accepted/deferred result and durable replay contract.

The boundary must be coarse:

- one crossing per mutation batch, not per record or token;
- one crossing for the initial bounded candidate window, or one per bounded cursor pull if the
  release gate requires the cursor, never per posting or candidate;
- compact buffers for canonical primary-key sets and results;
- cooperative cancellation at Harper-owned queue, complete-batch, collector, and pre-storage
  boundaries;
- no per-document JavaScript scoring/filter callbacks; bounded storage transport may service reads through JavaScript.

Tantivy stores the Harper-encoded primary key and record version as internal indexed/stored fields.
It does not store the customer document. The adapter validates the primary-key codec version when
opening and rebuilding a generation. Results use one packed buffer for the candidate window or each
cursor pull and decode keys lazily, avoiding a `Uint8Array` and object allocation for every
candidate.

The packed result format is versioned. Its header carries format version and hit count; each
fixed-width row carries a versioned eight-byte encoding of Harper's numeric record version as its
raw IEEE-754 bits, `score:f32`, primary-key offset, and primary-key length, followed by one
contiguous primary-key byte region. The decoder rejects non-finite values but preserves
fractional versions exactly and compares their bits with the current entry. JavaScript materializes
a key only when the current-record validation path reaches that hit. Format mismatch fails the
native capability preflight rather than guessing the layout.

### Async integration with `Table.search()`

The native call is asynchronous. Harper's existing custom-index seam is synchronous:
`resources/search.ts` calls `customIndex.search(...).map(...)`, and `filteredSearch` may call a
synchronous JavaScript record predicate during HNSW traversal. Full text must not force Tantivy
through either contract or make a blocking Node-API estimate call.

`FullTextIndex` implements the asynchronous derived-index query contract. `resources/search.ts`
dispatches a derived condition before the current custom-index expression and returns an
async-capable iterable that awaits one bounded native candidate operation before loading primary records. This
changes more than one call site: `Table.search()`, REST collection reads, `explain`, subscription
initial loads, and any SQL path that can reach condition acquisition must each be traced. The
initial public scope is `Table.search()` and REST. Every other consumer rejects
`FULLTEXT_QUERY_UNSUPPORTED` before acquisition instead of coercing a Promise or silently scanning.

Record-level authorization `rowFilter` rejects full-text before native acquisition because a filter
cannot isolate Tantivy's global BM25 statistics. Non-authorization caller and structured predicates
that cannot run in Tantivy are applied during text-first candidate validation. A structured-first key-term
filter is used only when every applicable structured predicate can be represented by an exact
bounded key set. Harper does not return
a silently underfilled page when the candidate budget expires before Tantivy is exhausted: it
returns `FULLTEXT_QUERY_BUDGET_EXCEEDED`. Phase 4 must prove exact result counts for table/field-level
authorization and selective companion filters; if common filters cannot meet the latency target, the identity/filter design
returns for review before GA rather than silently adding a numeric mapping.

Cancellation is attached before each native operation is submitted. The adapter catches every
rejection and translates timeout, admission, closed-generation, and panic failures into the typed
Harper errors in this design before the async iterable observes them. Each acquisition site awaits or
deliberately rejects the capability; no native promise is allowed to escape into an unobserved
`setImmediate` or subscription callback.

Planning remains synchronous. The existing custom-index `estimateCount(condition.value)` contract
is unchanged. The derived-index planner capability uses generation statistics cached in JavaScript
when the reader publishes and returns a conservative number without Node-API. Full text is promoted
to the lead condition independently of that estimate. If later planning needs the complete
condition, it will use a new versioned derived capability rather than changing the HNSW-visible
method signature. HNSW's synchronous `search`, `rescoreResults`, `exactDistance`, and property
resolver remain unchanged.

`FullTextIndex` is not visible to Harper's synchronous custom-index machinery. `openIndex()`,
`updateIndices`, and `runIndexing` never receive the descriptor. `openDerivedIndexStore()` creates
engine-owned storage, post-commit delivery owns incremental maintenance, and Harper's
shadow-generation workflow owns backfill. The derived adapter exposes no synchronous `index()` method,
so a later `$score` resolver or lifecycle refactor cannot accidentally introduce an in-transaction
native call.

Any coalescing before Harper calls the derived adapter remains Harper runtime policy. Harper owns
the per-target byte/entry thresholds, next-turn scheduling, retained-content accounting, overflow
replay latch, and shutdown behavior. The wrapper receives only a bounded encoded batch and enforces
its independent decode/admission ceilings; it neither controls Harper's event loop nor exposes
coalescing options. These values are system configuration, not `@fullText` fields.

### Native ownership and threading

Rust owns the Tantivy `Index`, one `IndexWriter` and one `IndexReader` per resident generation, the
analyzer, publication payload, and bounded execution resources. Environment-local JavaScript handles
refer to that process-global runtime; they do not create their own writer, reader, cache, or thread
pool. Search executes concurrently against the last published searcher.

Tantivy permits one `IndexWriter` for a directory because that object owns the ordered operation
stamps, pending add/delete set, commit/rollback boundary, segment publication, merge replacement,
and garbage-collection view. Two writers starting from the same head could each publish a valid
successor whose `meta.json` omits the other's segments; a stale-head check cannot merge those two
commit graphs. The wrapper therefore fences exactly one writer per canonical
`(storage incarnation, full-text index, generation)`. This is not one writer for a Harper process,
node, or cluster. Separate indexes, shadow generations, databases, and replica nodes have independent
writers and may progress concurrently.

One writer is not one ingestion thread. In Tantivy 0.26.1, document addition, term deletion, and
`run` use shared writer access, while prepare/commit require exclusive mutable access. Every
write-capable Harper worker therefore sends a bounded batch directly to its own native admission
shard. Package-owned ingestion lanes share the single writer and Tantivy's indexing workers build
segments in parallel. Only the commit barrier closes entry to that writer long enough to drain a
captured boundary, prepare the commit, run the Directory durability barrier, and atomically publish
`meta.json` with the matching watermark. Admission after the captured boundary may remain queued for
the next commit. No Harper worker—especially worker 0—relays or re-decodes another worker's writes.

The per-environment admission shards and their aggregate byte/cardinality budget keep `deliver()`
nonblocking on the post-commit path. A full shard returns `deferred`; Harper retains no projected
content and later replays the transaction-log entry using a reserved recovery budget. Large native
work does not run on Node's default libuv pool. Process/database governors bound resident writers,
Tantivy indexing and merge workers, search workers, shadow-build work, queued bytes, and concurrent
RocksDB publication barriers. Multiple full-text indexes can ingest in parallel, but indexes sharing
one RocksDB database initially serialize their targeted flush/publication barrier to protect primary
traffic.

Each resident generation has a monotonic health epoch covering wrapper ingestion lanes, Tantivy
indexing workers, the segment updater, and merge supervision. Admission and commit capture it. A
detected critical-task failure advances the health epoch, poisons the generation, rejects pending
work with `FULLTEXT_WRITER_FAILED`, and prevents watermark publication for work accepted under the
older health epoch. If partial application cannot be proved, the same writer is never allowed to
retry and continue. Reopen starts from the last durable commit; standalone mode resumes from the
caller's checkpoint, while Harper replays from the retained transaction-log watermark or rebuilds
when that position is no longer retained.

Shutdown and environment teardown release local handles but do not invent controller elections or
persistent owner rows. One process-global close operation drains or rolls back the generation and
keeps the Harper storage integration alive until active native operations reach a safe boundary. A deadline is
not permission to force-free storage. If a native operation cannot reach that boundary, the runtime
stays fail-closed and requires process restart rather than opening a second writer.

Branch databases do not participate initially: branch full-text schema mutation and queries fail
explicitly and cannot claim the base generation's lock. Any later read-only branch support must key
ownership by physical storage incarnation and open a frozen published head without a writer.

The Rust crate uses unwinding, not `panic = "abort"`. CI inspects the resolved Cargo profiles and
rejects any released native artifact built with `panic = "abort"`. Harper-owned writer/search tasks and Node-API
entry points contain `catch_unwind` boundaries, but that alone does not catch a panic on Tantivy's
internally spawned segment-updater or merge threads. Every custom `Directory` method must return a
typed I/O error and contain no `unwrap`, `expect`, or unchecked range arithmetic on storage-derived
bytes. The adapter also needs an observable writer-health probe for updater/merge failure and must
transition the generation to `FULLTEXT_INDEX_FAILED` when progress is no longer possible. The
native spike must prove those failures are observable; otherwise the in-process adapter is not
eligible for GA and process isolation must be reconsidered. The health probe is a monotonic opstamp
and publication-progress watchdog with a bounded deadline; injected updater and merge-task panics
must move `READY` to `FULLTEXT_INDEX_FAILED` rather than leave a permanently stalled writer.
Memory-unsafe faults cannot be caught,
so the Harper storage integration exposes no raw RocksDB pointer, native code is fuzzed and sanitizer-tested, and
staged rollout monitors process crashes separately from ordinary index failures.

### Physical storage architecture

Tantivy accesses index state through its `Directory` trait. The wrapper implements a private
`RocksDbDirectory` that stores Tantivy's logical files as immutable, chunked objects in a caller-
owned rocksdb-js column family. In Harper, that column family lives in Harper's already-open RocksDB
database. Tantivy creates no separate filesystem index tree. RocksDB still owns its normal WAL,
MANIFEST, SST, and current-profile blob files; those are storage-engine files rather than a second
Tantivy datastore.

The public wrapper also supports standalone native storage by delegating directly to Tantivy's
`MmapDirectory`. That mode ships for non-Harper applications and provides the paired performance
reference. Harper itself imports only the Rocks subpath: native storage cannot be selected through
schema or configuration and is never an error fallback. A failing RocksDB gate blocks the Harper
full-text release without blocking the wrapper's independently qualified native mode.

Harper records remain authoritative. Tantivy stores only the internal values needed for search.
Updates become delete-by-primary-key-term plus add-document in the writer batch.
Deletes are tombstoned and reclaimed by normal segment merging. Merge policy, disk headroom, and
write backpressure must be tested under sustained catalog churn.

## RocksDB-backed Tantivy directory

The current storage architecture is defined in [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md).
The Harper release persists every Tantivy object and publication in Harper's existing RocksDB;
the standalone native backend remains a library feature and performance reference.

The integration uses Harper's supported storage APIs and shared derived runtime. The delivery
protocol does not itself implement byte storage. The first milestone proves a bounded transport
between Tantivy native workers and Harper storage, immutable Directory slices, atomic publication,
durability, close/drop and crash/reopen. Exact transport topology and durability options remain
proof obligations.

No new native capability table, storage lease, pinned-read API, target-CF flush, SST-ingestion
extension or private patched rocksdb-js is a prerequisite. There is no delivered standalone
rocksdb-js backend. The retained experimental bridge supplies historical evidence and reusable
conformance tests only.

Harper owns store registration, record/log recovery, retention and generation activation. fulltext
owns Tantivy logical-file mapping, bounded engine execution and completion reporting. RocksDB
continues to own its native database, cache, WAL, transactions, flush and compaction behavior.
Harper schema accepts no physical backend selector or filesystem fallback.

Qualification uses the real Harper storage integration for Directory conformance, process-crash
and durability tests, online backup/restore, multi-index fairness and foreground-write interference.
Compare with native Tantivy at explicit measurement scopes; use targeted profiling when the
results differ. The product p99 goal remains below 50 ms for the agreed catalog workload.

## RocksDB and LMDB behavior

The initial feature is enabled only for RocksDB-backed databases. If an application declares
`@fullText` while using LMDB, schema activation fails before accepting writes:

```text
Full-text index "Product.search" requires the RocksDB storage engine; LMDB is not supported in this release
```

Harper rejects an unsupported `@fullText` declaration during activation rather than accepting
metadata it cannot maintain or silently scanning. `RocksDbDirectory` uses raw-binary column families and the existing database
handle through a Harper storage context; it does not open a second RocksDB database. This release does not
implement an LMDB storage adapter or derived-index lifecycle, and it never falls back to Tantivy
filesystem storage.

## Performance model and validation

The stated objective is end-to-end p99 below 50 ms for product-catalog search. It cannot be guaranteed
until the reference workload is defined. A provisional warm-path budget is useful for preventing any
one layer from consuming the entire objective:

| Layer                                     | Provisional p99 budget |
| ----------------------------------------- | ---------------------: |
| Parse, plan, authorize                    |                   5 ms |
| Native full-text search and filtering     |                  15 ms |
| Current-record validation/materialization |                  15 ms |
| Projection and serialization              |                   5 ms |
| Scheduling/network/variance headroom      |                  10 ms |

These are engineering allocations, not customer promises.
The validation/materialization budget covers every oversampled candidate examined across the one
candidate window or all cursor pulls, not only the requested `limit`. A top-20 request that examines
80 candidates must fit the same 15 ms allocation or reduce its candidate-production work.

### Reference workload contract

Phase 0 produces a checked-in workload manifest, and Phase 5 freezes it for release qualification.
Every benchmark result includes the manifest hash, Harper/native build, structural schema
fingerprint, ranking fingerprint, dataset seed, and hardware profile. A result without that metadata
cannot satisfy the release gate.

The canonical generator models product catalogs with deterministic `small`, `typical`, `large`, and
`heavy-tail` record tiers instead of one assumed average. The checked-in manifest defines exact UTF-8
byte, field-count, array-cardinality, token, and term-frequency distributions for each tier and the
explicit weights used by the 100-million-record blend. Native, Rocks, and Harper product arms receive
the same generated records. Results report every tier separately as well as the blend so an average
cannot conceal a scaling cliff.

The initial boundaries and weights are provisional and stress-oriented while representative
production measurements are unavailable. Recalibration requires a reviewed manifest version, new
comparison cohort and baselines, and retention of the prior results; it never silently changes the
meaning of an existing trend. The deterministic generator and seed remain shareable without customer
records.

| Manifest area | Required values                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset       | Record count; total indexed bytes; per-source p50/p95/max bytes; array cardinality; null/empty rate; language and SKU corpus; term-frequency distribution. |
| Index schema  | Source field identities; analyzer; position/surface-term settings; generation format; segment and merge policy.                                            |
| Ranking       | Canonical schema-defined source weights and ranking fingerprint.                                                                                           |
| Hardware      | CPU model/count; RAM; local-storage model, filesystem, capacity, and measured bandwidth/IOPS; operating system; Node and native package versions.          |
| State         | Warm or cold page cache; segment count; index age; merge/rebuild activity; delivery queue and log-watermark lag; record cache state.                       |
| Traffic       | Query-class mix; QPS; concurrency; arrival pattern; top-k; filters and selectivity; selected fields; cancellation rate; update/delete rate.                |
| Relevance     | Versioned query set, judged products, expected phrase/SKU/typo behavior, and ranking metrics.                                                              |
| Operations    | Commit cadence; accepted freshness bound; disk budget; rebuild target; restart and recovery targets.                                                       |

The latency objective applies to the complete Harper request path on the agreed production-class
hardware. The initial headline gate is warm, steady-state, top-20 search without exact counts at p99
below 50 ms. Term-any, term-all, phrase, prefix/autocomplete, and fuzzy each report and pass their own
gate; results are not blended into one percentile. Cold-cache, count-preference, deep-page, rebuild,
and merge-saturation behavior has separate published limits; exact count is verified as unavailable
and deep pages are verified against their rejection boundary.

The steady-state freshness gate measures from a successful source-changing record commit through
Tantivy commit, RocksDB publication, and reader reload. Its p99 objective is one second. The internal
maximum unpublished age must leave enough measured time for all publication steps; it is not itself
the customer-visible SLO.

Reader reload includes a fixed byte/time/read-budget structural warm-up of newly introduced segment
term-dictionary, field-norm, fast-field, and posting metadata selected by benchmarks. It does not scan
the index or replay/retain customer queries. Hard read, checksum, or decode errors fail searchable
activation and preserve the prior validated searcher only during the host-supplied process-level
`maxStaleSearcherAgeMs` interval.
Status and metrics expose published-versus-searchable revision/time lag and reload failures while
bounded background retries continue. If the durable publication is still not readable when the
interval expires, new query admission fails with `FULLTEXT_INDEX_FAILED` until reload or reopen
recovers; the Harper façade maps the wrapper's `FULLTEXT_INDEX_UNAVAILABLE` category to that existing
public full-text failure. Stale service does not continue indefinitely. An invalid prior searcher
fails immediately.
Warm-budget exhaustion is not corruption: the healthy new searcher activates as partially warmed,
and status/metrics expose warm duration, bytes, coverage, and subsequent cold-tail latency. The one-
second freshness objective includes this bounded work. Harper chooses the degraded interval from
trusted server runtime policy during one-time wrapper initialization; standalone hosts must provide
their own value. It is not schema/customer configurable and has no per-index override. The deadline
is anchored to the persisted timestamp of the oldest unresolved durable publication, so restart or
retries cannot renew it; zero disables stale serving.

Before Phase 5, the team replaces every symbolic operational bound—freshness lag, sustained QPS,
concurrency, timeout rate, index-to-source-byte ratio, peak rebuild disk, and rebuild duration—with a
number approved for the target deployment. Qualification fails if any latency class exceeds its
bound, if work is rejected below documented query limits, or if correctness/relevance gates regress.

### Required benchmark matrix

The benchmark must measure at least:

- 1 million, 10 million, and 100 million records, with an extrapolation or staged plan beyond that;
- separate small, typical, large, and heavy-tail title/description/keyword distributions plus their
  explicitly weighted blend;
- index bytes per record and peak disk during merge/rebuild;
- warm and cold page cache;
- top-k of 10, 20, 100, and larger export cases;
- rare, common, stop-word-heavy, SKU, phrase-like, typo, and empty queries;
- one-, two-, three-, and longer-character prefixes, including rejected short prefixes and maximum
  expansion behavior;
- edit-distance-one fuzzy terms across rare and extremely common term neighborhoods;
- autocomplete bursts with debounce, superseded-request cancellation, and abandoned clients;
- no filter, selective category filter, broad status filter, table-level authorization, rejected
  row-level authorization, and compound filters;
- sustained updates/deletes while querying;
- sustained source-changing writes at a fixed rate with a freshness-lag SLO, plus an equal rate of
  unrelated PATCHes that complete their log position without a Tantivy mutation;
- QPS/concurrency sweeps and CPU oversubscription;
- commit cadence versus freshness and throughput;
- eligible-key term-set construction across candidate counts up to and beyond its fallback threshold;
- the one-pass candidate window and, if qualification requires it, one through the maximum cursor
  pulls, including cumulative native work and cancellation;
- crash during apply, commit, merge, rebuild, and generation swap;
- p50/p95/p99/p99.9 latency, throughput, queue time, and timeout rate;
- relevance judgments, not only latency.

A 1-million-record Node integration benchmark precedes the 100-million-record build. It will
validate NAPI batching, ID mapping, worker ownership, reader reloads, and filtering before scale makes
iteration expensive.

### Performance invariants

- No tokenization, postings traversal, or scoring on the JavaScript event loop.
- No per-document NAPI call during indexing or search.
- No unbounded queue, Boolean clause list, term expansion, oversampling, or result materialization.
- No duplicate Tantivy writer per physical index.
- Backpressure reaches ingestion before memory grows without bound.
- Search readers see an immutable published generation/checkpoint.
- Background merge and rebuild concurrency are bounded.

### Risks and controls

| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tantivy segments and shadow generations amplify disk use | Merge or rebuild can exhaust local storage. | Reserve measured headroom, throttle merges/rebuilds, and refuse a rebuild that cannot complete within its disk budget. |
| Frequent updates create tombstones and merge pressure | Search latency and write amplification degrade over time. | Churn benchmarks, bounded merge pools, segment-count alerts, and a steady-state p99 gate after prolonged updates. |
| Fuzzy and prefix expansion is data-dependent | Common prefixes or misspellings can consume CPU and violate workload fairness. | Minimum lengths, expansion/work budgets, cancellation, per-class metrics, and adversarial corpus tests. |
| BM25 score changes with corpus and engine versions | Thresholds and cross-node score comparisons become unstable. | Scores are query-local; version ranking fixtures and avoid a public absolute-score guarantee. |
| Node-local generations differ temporarily | Replicas can return different ranked sets during lag or rollout. | Per-node checkpoint/status visibility, bounded lag, current-record validation, and no promise of cross-node score identity. |
| Encoded-primary-key filters are larger than numeric bitmaps | Selective structured-first queries can exceed their p99 or allocation budget. | Pack canonical keys once, use Tantivy `TermSetQuery`, cap count/bytes/time, fall back to bounded text-first acquisition, and benchmark against a numeric-bitmap reference before GA. |
| Global BM25 statistics cross row-visibility boundaries | `$score` or relevance order leaks aggregate term rarity from unauthorized records. | Require one row-read audience per physical index and reject record-level `allowRead` queries before native acquisition. |
| Per-query bounds still allow aggregate workload saturation | Concurrent maximum-expansion queries starve ordinary searches. | Queue admission before analysis, per-class concurrency/work budgets, reserved ordinary-search capacity, cancellation, and retryable 503. |
| Analyzer choices or dependency upgrades change emitted tokens | Relevant products are missed or one generation contains mixed analysis. | Explicit `english@1` chain, dependency fingerprint, golden token/position fixtures, and a new analyzer generation for every change. |
| Derived objects share RocksDB resources with primary records | Full-text flushes, compactions, and shared-cache use degrade primary traffic. | Targeted-flush isolation, process-wide cache accounting, CF-density tests, bounded merge work, and a mixed-workload regression gate. |
| A derived-CF background I/O error sets RocksDB's database-wide background error | Authoritative writes can become read-only even though full text is derived. | Accept this shared-database failure domain explicitly. Prevent predictable pressure with disk floors and admission, reuse rocksdb-js's `'error'`/`getLastError()` surface backed by RocksDB `OnBackgroundError`, stop all derived work immediately, and use Harper/rocksdb-js database-level recovery; never clear or downgrade an I/O/corruption error inside the wrapper. |
| One unresolved Blob holds a contiguous watermark | Later work fills staging and the complete index can become stale or unavailable. | Cap blocking Blob retry by the freshness/staging envelope, quarantine before the cap is crossed, and test sustained traffic behind a permanently missing Blob. |

## Operations and observability

Every derived index exposes common status and metrics:

- lifecycle state and reason;
- active generation and schema fingerprint;
- source head and visible/durable checkpoints;
- accepted/deferred/retried delivery counts, oldest unresolved log-position age, retained-log
  bytes, and publication age;
- mutation queue depth and oldest queued age;
- source-unchanged residency/cache transitions skipped and actual delete/TTL/lifecycle
  invalidations emitted;
- apply batch size/latency and commit latency;
- search p50/p95/p99, queue time, candidate count, native-call count, and cursor-pull count;
- eligible-key count/bytes, term-set build latency, and fallback count;
- prefix/fuzzy expansion count, expansion-budget rejection, and work-budget exhaustion;
- autocomplete request, cancellation, completion, and superseded-work rates;
- stale/deleted/unauthorized candidates rejected;
- underfilled result count;
- rebuild progress, rate, ETA, and failure;
- segment count, merge activity, disk bytes, and temporary disk headroom;
- RocksDB directory format, object/chunk read counts, `MultiGet` width, cache hit rate, bytes copied,
  incomplete/pending object bytes, GC candidate bytes, and compaction debt;
- native search/index pool utilization and saturation;
- corruption/recovery/rebuild counters.

Operators need actions to inspect, rebuild, pause/resume a rebuild, and validate an index. Schema
activation remains declarative; operational controls are not schema directives.

Logical record export omits derived full-text generations and restores them as `ABSENT`, then
rebuilds from records. It never treats derived RocksDB objects as record data.
Current `rocksdb-js` BackupEngine, streaming backup, and checkpoint paths always include every
column family, so physical RocksDB backups carry full-text generations; they cannot exclude a
full-text CF or generation key range. Physical backup capacity must therefore count all
`RocksDbDirectory` bytes unless a new selective-backup architecture is implemented. Directory and
streaming backups must explicitly enable `flushBeforeBackup` when invoked from Harper's WAL-enabled
root handle; checkpoints already flush all column families. Restore treats
included derived bytes as an optimization only and validates the descriptor, head, manifest, every
referenced object, native/Tantivy formats, schema fingerprint, publication checkpoint, and restored
log-watermark/retention frontier before serving. A valid compatible generation opens ready to serve; any
mismatch fails closed, drops the generation after leases drain, and rebuilds from authoritative
Harper records. A replica join or reseed that transfers a physical RocksDB checkpoint necessarily
transfers the full-text CF as well; it follows this same validation path and serves a compatible
complete generation rather than discarding and rebuilding 100-million-record derived state. A join
mechanism that transfers only logical records has no derived bytes to trust and uses the ordinary
scan-plus-log rebuild path. Live replication continues to send only authoritative record mutations,
never Tantivy objects or watermarks.

## Security and correctness

- Harper authorization remains authoritative for every returned record. Tantivy never bypasses
  table or field permissions.
- All source fields in one `@fullText` declaration must have identical field-level read policy.
  Schema activation rejects a mixed-policy declaration because matching across a shared weighted
  field would otherwise reveal whether a record contains text in a field the caller cannot read.
- Current-record lookup validates candidate existence/version before returning it.
- Full-text source fields that a caller cannot read must not leak through highlighting or selected
  generated values.
- Tantivy computes BM25 collection statistics over the complete physical generation. An eligible-key
  filter restricts matching documents but does not recompute IDF, so `$score` and relevance order can
  reveal aggregate term rarity from records a caller cannot read. The initial release therefore
  supports full-text queries only when all records in that physical index share one row-read
  audience. If Harper applies a record-level `allowRead`/row filter, the query fails with
  `FULLTEXT_QUERY_UNSUPPORTED` before native acquisition. The first release does not add a
  partitioned authorization or BM25-statistics model.
- Raw Tantivy query syntax is never accepted.
- Structural schema fingerprints include the canonical order-independent set of source field
  identities/types, analyzer version, stop-word behavior, canonical synonym rules, positions/surface
  settings, internal format, and every option that changes indexed meaning. Source weights and
  declaration order are excluded; weights have a separate ranking fingerprint and order remains
  Harper highlight metadata.
- An index opened with the wrong identity or fingerprint fails closed and rebuilds; it is never
  attached by path alone.
- Cancellation, environment teardown, and shutdown with in-flight native work require dedicated
  tests.

## Implementation map

The feature extends Harper's Resource and derived-index paths. It does not add an operations-style
search endpoint, route through the legacy `dataLayer/search.js`, or introduce a second query parser.

| Existing area                                                     | Execution responsibility                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.graphql`                                                  | Define `FullTextSource`, `FullTextSynonymRule`, `FullTextHighlighting`, `FullText`, and `@fullText`.                                                                                                                                                                                                                            |
| `resources/graphql.ts`                                            | Extend `coerceDirectiveValue` to recursively decode `ObjectValue` and `ListValue`; validate sources/options; compile `@fullText` to a canonical derived descriptor; reuse `@embed` conflict and unknown-source validation without sharing its custom-index registration or write hook.                                          |
| `resources/indexes/customIndexes.ts`                              | No full-text registration. This registry remains for synchronous custom indexes such as current HNSW.                                                                                                                                                                                                                           |
| `resources/databases.ts`                                          | Add `openDerivedIndexStore()` beside `openIndex()`; obtain the raw CF view through the root Rocks store's existing `use()` API, register it in Harper's lifecycle, run capability preflight, keep active/building generations distinct, and invoke the shared rebuild driver. Full text never enters the ordinary index opener. |
| `resources/Table.ts` write-resolution seam                        | Capture the final source-relevant projection and lifecycle action after conflict resolution. Do not tokenize or touch Tantivy. Invalidation retains the document; delete and cache eviction project a delete. For a derived RocksDB table, commit the local-only `EVICT` log fact atomically with eviction/TTL removal.         |
| `resources/DatabaseTransaction.ts`                                | Retain only the winning attempt's hot projection. An aborted attempt emits no derived delivery. Retained-log replay source-resolves every record identity because a durable first-attempt audit body can differ after a transaction retry.                                                                                      |
| `resources/Table.ts` (`search`, `transformEntryForSelect`)        | Dispatch full-text through the derived query path, generalize count handling with `touchesDerivedIndex()`, enforce relevance sorting, validate current record/version/authorization, and project select-only `$score` and optional `$highlights`.                                                                               |
| `resources/search.ts`                                             | Register string-decoded REST comparators; reject unsupported query shapes before `filterByType`; construct bounded eligible-key term sets; support asynchronous derived-index result acquisition; use cached synchronous estimates.                                                                                             |
| `resources/ResourceInterface.ts` and `resources/RequestTarget.ts` | Add typed comparators, `$score`, `$highlights`, cancellation, candidate-work budgets, and planner-only eligible-key state without exposing native query syntax or internal cursors.                                                                                                                                             |
| `resources/openApi.ts` and resource metadata                      | Describe full-text comparators and conditional metadata; omit query-only `FullText` from writable and ordinary response properties.                                                                                                                                                                                             |
| Existing Resource/HTTP error path                                 | Reuse Harper's typed `ClientError`/`ServerError` and RFC 9457 serialization, including existing rebuilding behavior, without a full-text-specific response envelope.                                                                                                                                                            |

New modules have narrow ownership:

| New area                                          | Responsibility                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources/derivedIndexes/DerivedIndexBackend.ts` | Storage-neutral backend contract: nonblocking post-commit delivery, opaque watermark, retry/defer outcomes, status, close, and rebuild handle.                                                                          |
| `resources/derivedIndexes/DerivedIndexRuntime.ts` | Attach once to `aftercommit`; fan out locally projected entries; drive exact replay, retention reservations, gap handling, bounded publication scheduling, shutdown, and scan-plus-log rebuild for all derived engines. |
| `resources/derivedIndexes/GenerationManifest.ts`  | Engine compatibility, storage/table incarnation, opaque checkpoint, and active/building generation state subordinate to the attribute descriptor.                                                                       |
| `resources/indexes/FullTextIndex.ts`              | Harper adapter implementing nonblocking `deliver`, asynchronous search, cached estimates, result/version decoding, checkpoint/status, and capability errors over `@harperfast/fulltext/harper`.                         |
| `resources/indexes/fullTextBinding.ts`            | Lazy preflight/loading and platform diagnostics for the optional native package.                                                                                                                                        |
| `HarperFast/fulltext`                             | Storage-neutral Rust/Tantivy engine; `RocksDbDirectory`; process-global writer/reader registry; sharded ingestion lanes; exclusive commit actor; analyzer; bounded search/index/merge resources; Node-API façade.       |
| `HarperFast/fulltext` benchmark tooling           | Separately exported native `MmapDirectory` reference and Rocks adapter harness; neither is a Harper production backend selector or fallback.                                                                            |

Tests follow the same boundaries: schema and query tests under `unitTests/resources/`, native adapter
contract and crash tests beside the Rust binding, REST parity under `unitTests/apiTests/`, and scale,
rebuild, upgrade, and recovery scenarios under `integrationTests/`. The native spike must settle the
adapter contract and primary-key identity encoding before the schema surface is merged; otherwise the public
schema could commit Harper to an index representation the engine cannot operate efficiently.

Harper owns the derived delivery/replay/retention fixtures; fulltext owns its engine, Directory, packed protocol and query fixtures. Qualify their integration against Harper's actual storage dependencies and persist the tested versions and evidence in the compatibility manifest.

The unit matrix includes skipped/out-of-order replicated writes, concurrent PATCH merging,
source-unchanged PATCHes, residency transitions, TTL/eviction/invalidation, audit-disabled tables,
literal REST values containing colons and type-like prefixes, supported bounded same-index full-text
Boolean trees, rejected mixed/cross-index trees, pure-negative trees, and relationship queries,
unanchored negative OR branches, `enforceExecutionOrder`, clear/drop teardown, and missing native
packages. Missing-package and unsupported-platform behavior remains covered generically, while
Windows x64 runs the supported native/Harper functional and crash gates rather than an unsupported-
platform-only test.

Equal-version tests use exact canonical mutation bytes: identical content suppresses as a duplicate,
different content or operation never selects a winner by node or arrival order, derived delivery
holds the opaque position until Harper's exact-bound authoritative repair publishes, and standalone
apply rejects before changing its batch. Crash points around repair and publication must converge to
a clean rebuild without silently advancing the watermark. Searches retain the complete prior
snapshot only through the original conflict-timestamp-based stale deadline, publish no temporary
deletion or later partial state, and then fail admission if repair remains unresolved. A late repair
restores service automatically only after durable publication and validated searcher activation;
faults at enqueue, apply, commit, reload, and activation prove no earlier transition admits queries.

Integration coverage includes:

- write a record, poll exported REST `matches` with `waitFor`, and observe the record within the
  configured freshness bound;
- start a prefix/autocomplete search and abandon it before iteration, proving every submitted native
  promise is owned/cancelled and no rejection becomes unhandled;
- run concurrent indexed-write/YCSB load during ordinary publication and `BUILDING`, measure
  admission/defer/replay behavior, and enforce the benchmark-frozen primary-write regression gate;
- add a source to an index after historical records became partial; prove bounded authoritative
  hydration completes the shadow generation, and prove a table without such a source remains
  unpublishable with an exact incomplete count;
- exercise authoritative recovery and the selected supported derived durability barrier, `kill -9`, and prove
  the transaction log plus last published watermark restores every committed record mutation;
- crash mid-shadow-build, resume the bounded scan, replay from its captured log boundary, and prove
  the active generation remains serviceable whether the shadow resumes or is discarded;
- cover multi-worker delivery ordering, log gaps, deferral, watermark-behind-retention rebuild,
  WAL-asymmetric recovery, open-iterator replay, branch rejection, environment teardown during
  ingestion, and process shutdown during Directory sync;
- assert exact results for table/field authorization plus highly selective filters and fail closed
  for record-level authorization;
- round-trip fractional `float64` versions bit-exactly, reject an older late delivery, resume a scan
  after an already-scanned key changes, exercise realistic CF/memtable density, and restart on both
  sides of publication.

Benchmark-only mmap portability is not a release requirement. Async convergence tests use
`waitFor`, never a fixed sleep.

## Approaches considered

The invariant is: **Harper publishes a full-text head only when every index object it names is
complete, durable to the selected backend's contract, immutable to active readers, and its opaque
watermark covers one contiguous prefix of the retained transaction log. Any later committed entry
remains replayable.**

| Axis                | Candidate                                                                                           | Disposition                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Different layer     | Implement term/posting/position column families directly in Harper                                  | Rejected because Harper would own analyzers, compressed postings, phrase positions, top-k pruning, BM25 statistics, merge policy, fuzzy dictionaries, and every future format migration.                                                         |
| Existing index only | Store computed token arrays in Harper's multivalue secondary index and calculate BM25 in JavaScript | Rejected because common terms require scanning millions of keys before top-k is known, the index has no phrase positions, and prefix/fuzzy expansion would recreate a search engine. It cannot satisfy the 100-million-record, sub-50-ms target. |
| Separate datastore  | Open a second RocksDB instance at a distinct derived-data path                                      | Rejected: it creates a second datastore, duplicates cache/recovery/backup/lifecycle coordination, and cannot participate in Harper's existing physical RocksDB ownership.                                                                        |
| Process boundary    | Run Tantivy in a sidecar                                                                            | Rejected: a sidecar cannot borrow Harper's live RocksDB handles; per-read IPC or a second database open violates the storage and latency architecture.                                                                                           |
| Higher layer        | Expose the schema/comparator contract but drive an external search component                        | Rejected because it adds a separately operated service, another authorization/filter boundary, IPC/network latency, and a second public consistency model.                                                                                       |

The HNSW work motivates measuring storage access and boundary cost rather than assuming a native engine makes the whole query faster. Profile the actual Harper integration. Native Tantivy remains the reference, and no measurement authorizes a filesystem fallback or required base rocksdb-js addition.

Document identity is intentionally not a second durable subsystem:

| Candidate                                                 | Disposition                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allocate table-scoped `u64` IDs with forward/reverse maps | Rejected initially. It gives compact bitmaps but adds an allocator, durable high watermark, two mappings, reuse rules, and another recovery invariant.                                                                              |
| Hash primary keys into fixed-width IDs                    | Rejected because collision handling either weakens identity or recreates a mapping.                                                                                                                                                 |
| Use Harper's canonical encoded primary key                | Chosen. Index/store it as an untokenized term, delete by term, return it in packed results, and use bounded `TermSetQuery` filters. A numeric mapping may be reconsidered only if measured filter performance cannot meet GA gates. |

Mutation delivery was considered independently from physical index storage:

| Candidate                                                   | Disposition                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make Tantivy or HNSW transactional with the record write    | Rejected at the root-cause level because neither engine can participate atomically in Harper's RocksDB transaction; a synchronous call would extend or abort the authoritative commit without eliminating split state. |
| Add a second transaction log or dirty-marker column family  | Rejected because it duplicates an existing durable fact and adds another write, recovery path, retention policy, and lifecycle to the authoritative hot path.                                                          |
| Continuously scan the primary table for incremental changes | Reserved for initial build and explicit repair. It cannot meet the freshness/cost goals and has no exact incremental publication boundary.                                                                             |

Query acquisition was considered separately:

| Candidate                                                                      | Disposition                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse promises returned by existing iterable mapper callbacks                  | Rejected as the complete solution because those promises begin after `customIndex.search()` synchronously returns a source iterable; full-text acquisition itself is asynchronous. A Phase-0 spike verifies this code-trace before implementation. |
| Return a custom lazy synchronous iterable that starts native work on iteration | Rejected because it hides asynchronous acquisition, makes abandoned-iterable rejection ownership implicit, and still requires auditing consumers that assume synchronous errors or explainability.                                                 |
| Add explicit `asyncSearch` capability and `searchAsync` branch                 | Chosen. Existing HNSW behavior remains synchronous; every unsupported acquisition site fails before starting native work, and every submitted promise has an explicit owner/cancellation path.                                                     |

## Implementation plan

The next milestone is a real Harper storage vertical slice using the existing fulltext engine and supported Harper storage APIs. The earlier cross-addon lease experiment remains unmerged historical work and is not a release prerequisite.

### Phase 0 — reuse the native reference

The standalone native backend is already implemented in fulltext. Reuse it and the Directory
conformance harness as the engine and behavioral reference; do not repeat that implementation or
make the experimental native rocksdb-js branch a release prerequisite.

### Phase 1 — Harper storage feasibility and Directory conformance

Implement the vertical slice in [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md).
Use the supported Harper/rocksdb-js stack to persist actual Tantivy state, reopen and query it.
Prove bounded transport, lifecycle and durable metadata ordering before freezing the Harper factory.
Test multi-worker delivery and shared-database interference early.

Exact source revisions, invoked APIs and durability options must accompany the result. A
DerivedIndexBackend sketch, mocked key/value store or successful Harper storage context test does not prove
this path. If an existing primitive cannot meet a correctness guarantee, report that blocker; no
new rocksdb-js interface or filesystem fallback is authorized by this plan.

### Phase 2 — shared coordination, publication, and recovery

1. Define `DerivedIndexBackend`, committed-entry projection, index identity, opaque log position and
   watermark, lifecycle state, retention reservation, and rebuild handle.
2. Attach one shared runtime to the existing same-thread `aftercommit` event, deliver each winning
   local/replicated write from its originating worker, and replay the exact retained log from each
   backend's last durable contiguous watermark.
3. Implement canonical-primary-key identity, per-record version idempotence, gap tracking,
   accepted/deferred/retry outcomes, reserved replay capacity, and watermark-behind-retention
   transition to `NEEDS_REBUILD`.
4. Implement the process-global writer/reader registry, sharded native ingestion lanes, exclusive
   commit actor, strict payload/watermark/opstamp classification, active/previous heads, and
   publication-receipt-fenced object reclamation.
5. Integrate `BUILDING` admission, bounded scan boundary, retained-log catch-up, invalidation,
   teardown, and atomic generation swap with Harper's existing attribute lifecycle.
6. Pass crash tests at every delivery, gap, barrier, head, reclamation, and reload boundary; cover
   open-iterator replay, raw TTL eviction, replicated writes, environment teardown, and fractional
   record versions.
7. Adapt HNSW to the shared control plane later or prove the interface accommodates its watermark
   and durability barrier without claiming current HNSW behavior.

### Phase 3 — full-text schema and maintenance

1. Add the `FullText` type/input and `@fullText` directive to `schema.graphql`.
2. Add recursive object/list directive decoding, canonical type validation, and schema fingerprints.
3. Compile @fullText into separate derived descriptors and preflight the qualified Harper storage
   integration and fulltext package without requiring a native rocksdb-js capability.

4. Add post-conflict projection capture and post-commit delivery for every record lifecycle path,
   including source-unchanged position completion, invalidation, eviction, delete, clear, and drop.
5. Implement schema-add backfill and structural-change shadow rebuild.
6. Add fail-closed LMDB, branch, platform, bare-declaration, missing-binary, and native-ABI errors.
7. Prove the no-index path performs zero derived work and benchmark indexed writes against the
   Phase-0-frozen regression gate, including active-plus-building, admission saturation, replay,
   and derived publication under storage pressure cases.

### Phase 4 — query integration

1. Add `matches`, `matches_all`, `matches_phrase`, `matches_prefix`, `matches_fuzzy`, and preview
   `matches_fuzzy_prefix` to Harper's comparator registry and REST FIQL translation.
2. Implement structured native queries, weighted BM25, phrase isolation, exact-over-fuzzy boosting,
   and bounded prefix/fuzzy/fuzzy-prefix/autocomplete expansion.
3. Add asynchronous derived-index acquisition, full-text lead promotion, relevance ordering, and
   select-only `$score`.
4. Add version/RBAC validation, bounded eligible-key term sets, one-pass text-first candidate
   materialization, and typed cumulative budget exhaustion. If the release benchmark gate requires
   incremental production, add the pinned-searcher opaque cursor before release.
5. Compile a bounded same-index full-text AND/OR/negation subtree to one native Boolean query; reject
   mixed structured/text or cross-index trees, pure-negative trees, relationship, arbitrary-sort,
   SQL, explain, and subscription paths before derived-index acquisition.
6. Add equivalent `Table.search()` and exported REST coverage, including kill/restart between record
   commit and index publication.
7. Apply one benchmark-defined maximum offset identically through `Table.search()` and REST. Verify
   that larger offsets fail with `FULLTEXT_QUERY_LIMIT` before native acquisition and that no native
   cursor appears in either response or permits deep-pagination bypass.
8. Verify missing, infinite, and oversized limits return `FULLTEXT_QUERY_LIMIT` through both public
   APIs, while unsupported Boolean, relationship, sort, SQL, explain, and subscription shapes return
   `FULLTEXT_QUERY_UNSUPPORTED`. Run boundary tests directly against both wrapper storage modes and
   prove an embedding caller can lower, but never raise, the package hard result-window ceiling.
   Verify Harper preflight reads the loaded package capability instead of a copied constant and
   rejects an incompatible host limit before creating a column family or accepting writes. Assert
   the existing programmatic and RFC 9457 error surfaces contain only the violated constraint,
   reason, and effective maximum, never the supplied value or query text.

### Phase 5 — production qualification

1. Run RocksDB-backed scale, churn, crash, upgrade, rebuild, backup/restore, relevance,
   autocomplete, and adversarial fuzzy/prefix suites.
2. Run chunk-size sweeps and compare with the non-shipping mmap reference at one million, ten
   million, and a
   production-representative hundred-million records. Capture directory calls, RocksDB reads,
   bytes requested/fetched, pinned ratio, copies, allocations, shared-cache eviction, write stalls,
   CF/memtable density, L0 growth, compaction debt, backup effects, and primary-store regression.
3. Run sanitizer and crash tests for Harper store/worker lifetime, in-flight search/merge
   teardown, every publication boundary, prior-head recovery, payload/range decoding, writer-health
   failure detection, and bounded garbage collection.
4. Freeze the release workload manifest, reference hardware, bounded defaults, and physical-backup
   validation contract.
5. Qualify rolling upgrades, rollback retention, incompatible-format rebuilds, and downgrade
   failure behavior.
6. Add operational status, metrics, alerts, and runbooks.
7. Release behind an opt-in schema capability only after every RocksDB correctness, absolute
   latency, mmap-relative, and primary-store-isolation gate passes. Missing a gate blocks release.

### Phase 6 — ranking and suggestion enhancements

Add, in evidence-driven order, phrase slop, native “did you mean?” corrections, optional suggestion-
event aggregation, and business-signal score composition. Matching remains a Harper condition, not
a Tantivy query string; behaviorally ranked suggestions remain normal Harper records.

## Open questions before GA

These workload inputs determine capacity and safe limits without changing the architecture:

- typical, p95, and maximum bytes for every indexed source field;
- total indexed text bytes, not only record count;
- write/update/delete rate and burst behavior;
- expected search QPS and concurrency per node;
- expected autocomplete sessions, keystrokes/request rate, debounce behavior, and cancellation rate;
- reference hardware: CPU, RAM, local NVMe, filesystem, and node count;
- warm versus cold-cache expectations and restart/recovery objectives;
- maximum acceptable impact of full-text object flush/compaction and cache pressure on primary
  RocksDB reads and writes;
- dominant filters and their selectivity, especially category, status, price, and inventory;
- top-k/page sizes and the benchmark-defined maximum accepted offset;
- SKU/identifier search behavior, typo tolerance, phrase needs, accents, synonyms, and stop words;
- ranking judgments or click/conversion data for relevance evaluation;
- maximum Blob retry age and the operational visibility and retention period for quarantined Blob
  extraction failures;
- disk budget per record and allowable temporary headroom during merge/rebuild;
- rebuild-time objective and whether old results may serve through schema changes;
- whether popularity, inventory, geography, freshness, or personalization must influence ranking.

Until those inputs exist, the p99 target is a design objective, not a credible guarantee.

## Acceptance criteria

The first production release is complete when:

- a valid RocksDB schema can declare a multi-source English full-text field;
- every Harper production index object is stored through `RocksDbDirectory`; the wrapper's native
  subpath remains usable by standalone callers and benchmarks but is neither a Harper schema option
  nor a fallback, and a missing/incompatible RocksDB capability fails schema activation;
- Harper imports only `@harperfast/fulltext/harper` and opens the named derived factory with an
  identity-checked Harper storage integration. The native subpath and its filesystem-path types are absent
  from Harper's runtime imports and configuration surface;
- invalid schemas and all LMDB declarations fail early with actionable errors;
- only `@fullText` creates a full-text derived descriptor; this design adds no `@indexed`
  compatibility spelling or migration behavior;
- every source in a shared full-text field has identical field-read authorization, and mixed-policy
  declarations fail activation before any text is indexed;
- a query requiring record-level `allowRead`/row filtering fails before native acquisition so global
  BM25 statistics cannot cross that authorization boundary;
- schema/reference documentation states that full-text sources are not retained in partial records;
  invalidation preserves the active index document while actual cache eviction removes it;
- a rebuild encountering an invalidated partial uses the table's existing source resolution, waits
  for the cache-fill commit position before publication, and handles duplicate scan/log delivery
  idempotently;
- adding or changing a source hydrates historical incomplete partials through Harper's bounded
  source-load path before shadow publication, or leaves the generation visibly `BUILDING` when no
  authoritative source exists; it never publishes a silently incomplete generation;
- inserts, PUTs, PATCHes, deletes, replication replay, and schema backfills produce correct index
  mutations from conflict-resolved record state after every skipped-write decision;
- unrelated PATCHes emit no derived mutation; invalidation preserves the active searchable
  document; and cache eviction, residency, refresh, actual delete, clear, and drop transitions
  produce the documented upsert/delete/lifecycle behavior;
- the accepted record transaction writes one existing transaction-log fact; only its winning
  attempt is delivered after commit with the final projection and opaque committed position. An
  unclean restart resumes from the last published contiguous watermark, and the canonical encoded
  primary key round-trips through Tantivy without a second identity map;
- startup mechanically verifies the required RocksDB flush/publication profile, and power-loss
  testing proves a derived-only durability barrier cannot advance Harper's authoritative flushed
  log watermark or leave a durable record mutation outside retained replay;
- the production full-text object CF uses Tantivy-compressed immutable objects and the same
  qualified RocksDB options as the wrapper plan. It meets measured read-amplification,
  cache-isolation, and sub-50-ms gates without an unplanned second object cache;
- fractional Harper record versions round-trip as exact IEEE-754 bits through delivery, Tantivy
  stored/fast fields, native results, and current-record comparison;
- a divergent-state local transaction retry and fresh-transaction replication replay converge on
  the current record identity and one current Tantivy document;
- forcing a transaction retry whose winning record differs from the first durable audit body, then
  killing before derived publication, converges through authoritative source resolution rather than
  indexing the losing body;
- RocksDB TTL/cache eviction on a derived table atomically writes the local-only `EVICT` fact and
  removes the record; deferral or a crash before derived publication replays the delete, while the
  marker never reaches replication or customer audit/subscription results;
- every write-capable worker delivers its own local and replicated commits through the same
  `aftercommit` path. A full native admission shard returns `deferred` without blocking the source
  commit or retaining projected content; reserved replay capacity later consumes the log entry;
- positions complete only as one contiguous aggregate watermark. Out-of-order completion, Blob
  retry, version repair, or queue deferral holds the gap while later entries remain bounded, and a
  watermark older than retained history transitions to `NEEDS_REBUILD` rather than skipping;
- `BUILDING`, invalidation, swap, clear, and retirement update Harper's authoritative attribute and
  generation state, so a stale environment cannot activate or maintain the wrong generation;
- sustained churn stays within the benchmark-frozen indexed-write latency/throughput gate under
  derived publication under storage pressure, active-plus-building load, queue saturation, and replay. Worker 0's
  event-loop delay does not scale with writes committed by other workers;
- a transaction retry whose losing attempt had different projected text hot-delivers only the
  winning in-memory projection; recovery treats the durable audit body as non-authoritative and
  resolves the current record;
- canonical primary-key identity remains stable and unambiguous through update, delete, retry, and
  shadow rebuild;
- concurrent workers cannot publish past an unresolved log gap; object reclamation requires a
  successful publication receipt or a covering retained head, and replay begins strictly after the
  recovered durable watermark;
- source, merge, and rebuild publication use strict payload/watermark/opstamp classification. A
  stuck writer retains exclusive index ownership in a fail-closed restart state rather than permitting duplicate
  ownership or force-freeing storage;
- killing the process on either side of prepared commit and atomic `meta.json` publication recovers
  the previous or new complete head, never a head with missing objects or an advanced watermark;
- `Table.search()` and REST return equivalent weighted-BM25 results and optional `$score` for
  `matches`, `matches_all`, and `matches_phrase`;
- relevance ordering uses the full-text attribute, `$score` is select-only, literal REST values are
  not type-coerced, bounded same-index Boolean trees sum distinct matched positive scores without
  duplicate-clause inflation, a term's weighted matches across fields accumulate, exclusions affect
  no score, equal scores order by ascending canonical encoded primary key, query-time field-boost
  overrides are rejected, and unsupported mixed/cross-index, pure-negative, relationship, and
  ordering shapes fail before planning;
- schema and query surfaces reject `minScore`; score remains ordering/diagnostic metadata scoped to
  one query and ranking/index revision;
- BM25 uses fixed `k1 = 1.2` and `b = 0.75`; neither is customer-configurable. Changing the effective
  native constants changes the ranking revision and requires relevance/pruning qualification; a
  generation rebuild occurs only if the pinned Tantivy upgrade proves index-format incompatibility;
- full text exposes no separate customer timeout; all stages and candidate-production work share the
  remaining existing Harper request deadline and cancellation signal, capped by a hard server
  ceiling;
- timeout, cancellation, or work-budget failure returns no hits; successful underfilled pages are
  allowed only after the captured searcher proves exhaustion, while optional highlight metadata may
  independently report `complete: false`;
- a weight-only schema update atomically changes subsequent ranking, preserves each in-flight
  query's captured ranking fingerprint, and performs no rebuild, Tantivy commit, or Directory write;
- reordering an unchanged source set performs no rebuild or Directory write, preserves native field
  identity by canonical name, and changes only Harper's deterministic highlight tie order;
- customer `Table.search()` and REST queries cannot supply or await a write watermark and always use
  the latest published generation immediately; internal checkpoint waits remain bounded and
  operator-only;
- `[String]` sources use native repeated-field BM25 statistics while phrase queries remain isolated
  to one array element;
- records whose complete projection analyzes to zero terms are delete-only index mutations that
  still advance the watermark; index document counts represent searchable records;
- a query leaf whose complete value analyzes to zero terms becomes match-none without native
  execution, analyzer fallback, or an error; its supported Boolean parent applies ordinary match-
  none conjunction/disjunction semantics;
- `matches_all` requires every analyzed term at record scope and permits different terms to match
  different declared sources, while phrase matching remains within one field and array element;
- set-based matching and completed prefix terms deduplicate analyzed query terms before scoring and
  expansion, while phrase matching preserves duplicate tokens and order;
- `Prefer: count=exact` reports an unavailable derived-index total without draining the match set,
  while bounded estimated counts never claim exactness;
- bounded `matches_prefix` returns current authorized product records suitable for autocomplete;
- exact- and fuzzy-prefix leaves whose final completion token is removed by analysis become match-
  none rather than broadening to their completed terms or bypassing configured stop words;
- when prefix input ends at an analyzer-recognized token boundary, all surviving terms are required
  exactly and no prefix expansion occurs; no implementation may trim away that distinction or walk
  the term dictionary with an empty prefix;
- multiple terms matching one final prefix are scored through native disjunction-max with no tie
  increment, so only the strongest expanded completion contributes;
- preview `matches_fuzzy_prefix` keeps completed terms exact and required, applies native edit-
  distance-one fuzzy-prefix matching only to a final surface token of at least four characters,
  excludes identifiers from fuzzy expansion, prefers the exact-prefix branch without score stacking,
  and cannot exceed its automaton, work, cancellation, admission, or result budgets;
- exact-preference fixtures include a common exact term in a long field against a rare typo-only
  match and prove the exact-match bonus wins the logical-token group despite fuzzy constant scoring;
- all minimum-length gates count normalized pre-stem Unicode scalar values identically in Harper and
  native validation, while independent byte ceilings continue to protect storage and allocation;
- optional top-k highlighting uses the wrapper's versioned bounded match trace for every released
  comparator and analyzer transformation; Harper does not independently implement text matching;
- one- and two-character prefix/autocomplete requests fail before native execution and cannot consume
  expansion capacity, while fuzzy-prefix inputs shorter than four characters do the same;
- bounded `matches_fuzzy` uses term-any semantics and zero-tie exact-versus-fuzzy groups, so exact
  matches outrank but never stack with lower-boost fallbacks, and cannot exceed its configured
  expansion/work budget;
- an oversized source is never truncated and never rejects the Harper write; that source is
  quarantined for the record version, remaining valid sources are indexed, the watermark advances,
  and a later valid version clears the quarantine;
- an unpaired UTF-16 surrogate in any string source quarantines the complete record version: the
  prior full-text document is deleted, no sibling source is indexed, progress advances, and a later
  well-formed version clears the condition; malformed query text instead receives a typed 400, and
  neither path substitutes `U+FFFD`;
- a structurally malformed packed mutation batch fails complete prevalidation before writer-state
  mutation; no valid prefix or sibling record is applied, while explicit content-quarantine markers
  remain valid batch entries and commit remains the durability boundary;
- queued standalone application cancels without mutation, while an admitted bounded batch always
  finishes and resolves its receipt even if cancellation arrives during application; no applied
  prefix can be paired with a cancellation rejection;
- an unprovable internal partial application poisons the writer health epoch, rejects pending work, blocks
  commit and watermark publication, and recovers only by reopening the last durable commit and
  replaying from the applicable checkpoint; the same writer never retries and continues;
- standalone commit completion means durable publication, not immediate reader visibility;
  background reload proceeds automatically, while explicit `reload()` waits for the publication
  revision current at invocation without forcing redundant I/O;
- standalone native/Harper use never auto-commits: the application owns commit cadence, checkpoint,
  and replay, while only Harper's derived runtime runs the bounded hybrid publication scheduler
  over the shared commit implementation;
- a standalone caller checkpoint is opaque and limited to 65,536 input bytes before the wrapper's
  base64url envelope; the wrapper validates the limit before native allocation, persists and returns
  accepted bytes exactly, and leaves format versioning, decoding, and migration to the caller;
- default standalone close refuses queued or uncommitted work with
  `FULLTEXT_UNCOMMITTED_WORK` while leaving the handle usable; only explicit rollback discards work
  after the last commit, and no standalone close path commits implicitly;
- quarantined-source state appears in operator status, metrics, and bounded failure diagnostics only;
  it neither adds per-result metadata nor makes healthy queries fail;
- deleting N of M matching records yields exactly M-N current results and an exhausted result set,
  including across publication and restart;
- query-class admission prevents prefix/fuzzy/fuzzy-prefix/autocomplete saturation from consuming every ordinary
  search slot, and budget exhaustion returns a typed error without revealing authorization-rejection
  cardinality or presenting an underfilled page as complete;
- p99 and saturation gates pass without a wrapper result/query-plan cache or repeated identical-
  query assumption; warm behavior comes from Tantivy readers and Harper's existing RocksDB cache;
- searcher activation performs only bounded segment-aware structural warming, exposes complete versus
  partial warm state, preserves the prior validated searcher on hard read failure only for the host-
  supplied process-level degraded interval, then fails query admission if retries cannot catch up,
  and includes its work in the freshness and primary-cache-pressure gates; the deadline is persisted
  and cannot restart on retry or process restart;
- suggestion records can use the same schema/index/query mechanisms without a separate search
  service or Tantivy query language; customer popularity fields remain returnable/filterable record
  metadata and do not alter initial `$score` ordering or enable an unbounded post-sort;
- normal indexed filters and authorization compose without unbounded post-filtering;
- version-mismatched candidates are never returned, eligible-key term sets stay within count/byte/time
  limits, candidate production never exceeds its cumulative work budget, and supported
  authorization/AND filters either return exactly the requested results, exhaust Tantivy, or return
  the typed budget error; one bounded over-fetch must pass correctness and p99 qualification or the
  pinned-searcher opaque cursor is required before release; that cursor remains an internal,
  request-scoped execution primitive and never becomes customer pagination state;
- every documented readiness, capability, query-budget, timeout, storage, and native-package failure
  returns the specified Harper error without a scan fallback;
- delivery queue, oldest unresolved gap, retained-log bytes, durable watermark, and searchable
  revision are visible; crash recovery cannot advance past an unrepresented log entry;
- the existing attribute lifecycle owns build/resume state, while manifests cannot start a second
  builder; snapshotless shadow rebuilds catch up and atomically replace serving generations;
- binary-first rolling upgrades and compatible rollback preserve serving generations, while
  incompatible upgrades and downgrades fail closed or rebuild as documented;
- `english@1` golden fixtures pin tokens, positions, surface terms, and configured synonym emissions
  across dependency upgrades; any change produces a new analyzer generation rather than mixed
  analysis; compatibility fixtures pin NFKC output for full-width, ligature, circled, composed, and
  decomposed forms together with original-source highlight offsets; case fixtures pin full Unicode
  folds, including multi-character and script-specific results, and their source offsets; Latin-
  folding fixtures pin accented and special-letter mappings, prove that no duplicate original term
  is emitted, and prove that non-Latin scripts are not transliterated; mixed-script fixtures prove
  that non-Latin terms bypass English stemming and pin the documented word-boundary behavior,
  including the first release's CJK limitation; stop-word fixtures assert the frozen 33-term literal
  set, canonical hash, enabled/disabled behavior, and identifier bypass; stemming fixtures pin
  Tantivy English-stemmer output and fail upgrades that would change `english@1` terms; synonym
  fixtures prove full-base-analyzer canonicalization, post-stem matching, and non-recursive
  expansion for inflected, reciprocal, and chained rules, plus replacement participation and source-
  token provenance in prefix, fuzzy, fuzzy-prefix, autocomplete, suggestion, and highlight paths when
  `surfaceTerms` is enabled; relevance fixtures prove literal and synonym-derived terms receive the
  same BM25 treatment while same-position no-op and duplicate emissions do not inflate frequency;
  phrase fixtures prove removed stop words retain matching index/query position gaps and cannot make
  otherwise nonadjacent terms satisfy an exact phrase, while same-position synonym replacements do
  participate in adjacency and highlight their originating source tokens;
- identifier fixtures pin whole-plus-component emission, exact-whole boosting, stop-word/stemming
  bypass, no-fuzzy behavior, phrase positions, prefixes, and highlight provenance for product codes;
  separator fixtures prove that only `-`, `_`, and `/` are ordinary internal separators while other
  punctuation remains a boundary outside the explicit decimal and compact symbolic exceptions;
  classifier fixtures prove index/query symmetry and distinguish digit-, underscore-, and slash-
  bearing identifiers from alphabetic hyphenated prose; apostrophe fixtures normalize straight and curly forms, preserve
  contractions, remove possessive endings before stemming, and retain original highlight offsets;
  letter/digit-transition fixtures pin whole-plus-component output and exact-whole ranking for terms
  such as `RTX4090`, `128GB`, and `iPhone15`; decimal fixtures retain an inter-digit period in `12.5`
  and treat `12.5mm` as whole plus `12.5` and `mm` without emitting weak `12` or `5` terms; unit
  fixtures prove there is no implicit aliasing or conversion and that explicit synonyms plus Harper
  structured filters compose as documented; identifier-position fixtures prove whole and components
  share one position, joined-identifier phrases use the whole term, and separated components do not
  manufacture source adjacency; symbolic fixtures distinguish `C++`, `C#`, `AT&T`, and `R&D`, pin
  their two-character-minimum same-position components and full-token highlights, and prove one-
  character components, spaced text, and symbol-only text do not enter the symbolic path; global
  component-length fixtures prove one-character parts from punctuated and letter/digit identifiers
  are also discarded while their whole terms remain searchable;
- selecting `$highlights` produces only authorized, bounded, structured top-k fragments, while
  omitting it performs no highlight reanalysis or response allocation; spans are half-open UTF-16
  code-unit offsets, non-exact modes mark the full original token, phrases span the complete matched
  sequence, and Unicode fixtures prove JavaScript `slice()` compatibility; public match entries
  expose no analyzer match-kind taxonomy; unavailable Blob content and exhausted highlight budgets
  preserve hits while setting `complete: false`; `[String]` fragments identify their exact zero-
  based `valueIndex`, while scalar and Blob fragments omit it; every fragment carries a validated
  UTF-16 `sourceStart`, exact source-substring text, and fragment-relative match spans; fragments may
  exceed the configured context target only to preserve a complete match within the server hard cap,
  and an over-cap match is omitted with `complete: false` rather than truncated; overlapping or
  touching windows in the same source value merge when their union fits the cap, coalesce match
  spans, and consume `maxFragments` only after merging and ranking; excess candidates rank by clause
  coverage, query-plan match quality and source weight, density, then stable source/value/offset ties,
  without affecting document ordering; selection uses one global candidate pool with no source/value
  diversity quota, so multiple distinct fragments from the same value may win on relevance;
- a schema without `@fullText` has no measurable write-path regression and executes no source scan,
  descriptor scan, allocation, or delivery lookup; a schema with `@fullText` meets its separate
  indexed-write latency and throughput gate without loading the source projection in the commit
  callback;
- no long-running full-text work executes on the JavaScript event loop or default libuv pool;
- full-text maintenance never enters synchronous `customIndex.index`, never opens an ordinary
  `RocksIndexStore`, and a compatible rebuild serves the previous active generation throughout;
- async full-text acquisition composes with `Table.search()` without changing synchronous HNSW
  behavior or making a native planning call; `explain`, SQL, and subscription initial loads are
  either proven async-safe or reject full text explicitly;
- missing/corrupt/incompatible native indexes fail closed and rebuild deterministically;
- open-iterator replay and every coordinated retry preserve the record's transaction-log position
  and final projection semantics; branch databases cannot collide with or drain the base generation;
- the agreed representative workload meets the accepted latency, throughput, freshness, relevance,
  disk, and rebuild targets with a reproducible manifest and separate query-class percentiles;
- documentation states the eventual-consistency and score-stability contracts plainly.

### RocksDB full-text release criteria

Native full text is released only when:

- The Harper Directory uses bounded storage transport through supported APIs, preserves immutable
  slices and atomic replacement, and safely drains or fails requests when its store closes;
- a published RocksDB directory head references only complete objects that crossed the durability
  barrier, carries the same checkpoint as Tantivy and the derived consumer, rejects stale-writer
  publication, and can recover from the retained previous head;
- incomplete writers, abandoned objects, merges, clear, rebuild, attribute drop, table drop, and
  database drop reclaim only their exact key ranges without invalidating a live `FileHandle`;
- the RocksDB directory passes the absolute full-text latency gates, stays within the Phase-0-frozen
  mmap-relative envelope, keeps primary-store regression within the Phase-0-frozen limit, and stays
  within the write-stall/L0 compaction bounds on the accepted mixed workload;
- predictable derived ENOSPC and pressure are stopped above the reserved authoritative disk floor;
  injected background I/O/corruption proves that RocksDB's database-wide error is surfaced, all
  derived activity stops, and only Harper/rocksdb-js database-level recovery resumes writes. The
  wrapper does not claim column-family fault isolation that RocksDB does not provide.

## References

- [Derived-index delivery protocol (DerivedIndexBackend): shared post-commit delivery, watermark/replay, and blob-content contract for HNSW and full-text indexes](https://github.com/HarperFast/harper/issues/2489)
- [Native HNSW traversal plane: mmap graph file, off-event-loop search, opt-in dual-write (phase 1)](https://github.com/HarperFast/harper/pull/2430)
- [Tantivy Node wrapper implementation plan](./tantivy-node-wrapper-plan.md)
- [Tantivy on Harper RocksDB](./tantivy-rocksdb-directory-design.md)
- [Tantivy architecture](https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md)
- [Tantivy 0.26.1 `Directory` contract](https://docs.rs/tantivy/0.26.1/tantivy/directory/trait.Directory.html)
- [Tantivy 0.26.1 `FileHandle` contract](https://docs.rs/tantivy/0.26.1/tantivy/directory/trait.FileHandle.html)
- [Tantivy 0.26.1 `IndexWriter`](https://docs.rs/tantivy/0.26.1/tantivy/indexer/struct.IndexWriter.html)
- [Tantivy 0.26.1 BM25 implementation](https://docs.rs/tantivy/0.26.1/src/tantivy/query/bm25.rs.html)
- [Tantivy configurable-BM25 discussion and block-max implications](https://github.com/quickwit-oss/tantivy/issues/2924)
- [Tantivy 0.26.1 index metadata and commit payload](https://docs.rs/tantivy/0.26.1/tantivy/index/struct.IndexMeta.html)
- [Tantivy 0.26.1 reader reload policy](https://docs.rs/tantivy/0.26.1/tantivy/enum.ReloadPolicy.html)
- [Tantivy 0.26.1 phrase queries](https://docs.rs/tantivy/0.26.1/tantivy/query/struct.PhraseQuery.html)
- [Tantivy 0.26.1 disjunction-max queries](https://docs.rs/tantivy/0.26.1/tantivy/query/struct.DisjunctionMaxQuery.html)
- [Tantivy 0.26.1 phrase-prefix queries (deferred explicit comparator)](https://docs.rs/tantivy/0.26.1/tantivy/query/struct.PhrasePrefixQuery.html)
- [Tantivy 0.26.1 fuzzy-term queries](https://docs.rs/tantivy/0.26.1/tantivy/query/struct.FuzzyTermQuery.html)
- [Tantivy 0.26.1 index position options](https://docs.rs/tantivy/0.26.1/tantivy/schema/enum.IndexRecordOption.html)
- [RocksDB options](https://github.com/facebook/rocksdb/blob/main/include/rocksdb/options.h)
- [RocksDB atomic flush](https://github.com/facebook/rocksdb/wiki/Atomic-flush)
- [RocksDB WAL durability and performance](https://github.com/facebook/rocksdb/wiki/WAL-Performance)
- [napi-rs getting started](https://napi.rs/docs/introduction/getting-started)
- [napi-rs release and platform packaging](https://napi.rs/docs/deep-dive/release)
