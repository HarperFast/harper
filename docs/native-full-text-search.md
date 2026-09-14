# Native full-text search in Harper

Status: product design; native-storage integration and query features require qualification.
Storage direction updated September 14, 2026.

## Architecture and scope

Harper declares full-text projections from source fields through `@fullText`, following the schema
lifecycle used for embedded fields. English analysis and weighted BM25 are the initial baseline.
Queries use `Table.search()` and the exported-table REST API, with Harper authorization, structured
conditions, selection, relevance sorting, and pagination.

The wrapper and Harper use Tantivy's native filesystem storage exclusively. Each node builds its
own index from locally committed primary records, including accepted replicated changes. The shared
derived-index runtime owns delivery, replay, ownership, backpressure, rebuild, and readiness.
Tantivy files and their source checkpoints are local and are not replicated.

Reuse valid files and replay on ordinary restart. Missing, corrupt, incompatible, or unresumable
indexes rebuild locally. Fresh replicas and source restores do not serve full-text until rebuild
and catch-up complete. Source records and schema suffice for backup. Ordinary Harper service can
operate while an index is unready, subject to Harper's existing admission and resource policies.

The complete architecture, writer/publication flows, failure behavior, performance plan, source
grounding, and implementation sequence are in
[Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).
[Shared derived-index coordination](hnsw-fulltext-coordination.md) describes the Harper/HNSW boundary.
The original storage/implementation proposal is preserved in
[the September 14 archive](archive/2026-09-14/native-full-text-search.md); it is not the current
storage or runtime specification.

The detailed schema, analyzer, and query requirements below are retained from the agreed product
design. Examples describe planned Harper APIs, not features available in the current release.
The native wrapper's currently implemented defaults and query subset can differ until this contract
is implemented and qualified. No customer storage selector, file path, or RocksDB provider belongs
in the schema. LMDB remains outside the initial qualified derived runtime.

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
writers/readers, shadow generations, admission/replay memory, searches, and commits from the same
process-wide envelope. Account separately for file mappings and observed resident memory; the
wrapper cannot hard-cap the operating system's global file page cache. A repeated identical initialization is
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
present and is not a customer sort option. It makes equal-score ordering deterministic for a
qualified searcher snapshot; independent node publication and BM25 statistics do not guarantee
identical instantaneous scores or pagination across replicas.

Full-text search keeps Harper's existing `limit` and `offset` controls. Ranked searches enforce a
benchmark-defined maximum offset to protect tail latency. The maximum is release-owned, documented,
and identical through `Table.search()` and REST; it is not a schema or request option. A larger
offset fails with `FULLTEXT_QUERY_LIMIT` before native execution. The internal candidate cursor, if
required by qualification, cannot bypass this limit and is never returned to the caller. Harper's
result-window limit must be equal to or lower than the wrapper's fixed release ceiling. The wrapper
also enforces that non-bypassable ceiling for standalone callers for both standalone and Harper use of native storage.
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
Tantivy's reader structures and the operating system's file page cache for warm-path index reuse.
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

## Implementation and qualification

First expose native opaque checkpoint publication/readback using the existing Tantivy engine.
Then bind Harper's structural backend to native open/publish/close and prove exact replay, actual
worker handoff, replica bootstrap, source restore, and reader visibility. Apply schema/query work
through the existing tracked issues. Remove the obsolete hosted wrapper export and KV Directory in
an audited cleanup; keep reusable engine, ABI, queue, and fault tests.

The catalog goal remains hundreds of millions of records and end-to-end search p99 below 50 ms
per accepted query class on an agreed workload. The steady-state source-to-search freshness
objective remains one second at p99. Neither target is established by selecting native storage.

Compare standalone native-wrapper measurements with a complete Harper-derived native path and a
no-index Harper control. Match corpus, analysis, query/mutation mix, publication cadence, hardware,
and sample validity. Include unrelated traffic, multiple indexes, replica catch-up, merges, rebuild,
warm/cold caches, source-write latency, queue/backlog drain, memory, disk and errors. Keep compatible
versioned results in GitHub across releases, with CI smoke and controlled scheduled/release profiles.

## Operator requirements and open inputs

Harper selects contained generation paths beneath an operator-owned native index root. Index files
contain sensitive derived text and require restrictive permissions and suitable filesystem/volume
encryption; RocksDB encryption and backups do not cover them. Budget active files, retained readers,
merge output and shadow rebuilds, with authoritative-store disk headroom and bounded cleanup retries.

Capacity and release qualification still require field-size distributions, total indexed bytes,
query/update rates, filter selectivity, reference hardware, acceptable recovery/rebuild time, and
disk/memory budgets. These are workload and deployment inputs; the native-only storage direction,
local replica indexing, restart reuse, and rebuild-on-restore behavior are settled.
