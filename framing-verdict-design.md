# Framing-verdict receipt gate

## Intent

Extend the public `review-coverage` JavaScript action with an independent planning-receipt check. A ready, organization-member pull request that changes a caller-configured core-shared source path must carry either a clearing `Framing-Verdict` or a recorded non-clearing verdict in `## For the human reviewer`. Preserve every existing `Review-Coverage`, `Human-Review-Need`, format, and exemption decision.

## Verified current behavior

- `origin/main` contains harper#2552 (`a9961c5d2`). `.github/workflows/review-coverage.yml` now runs on `pull_request_target`, checks out the base ref with read-only permissions and no persisted credentials, and never executes pull-request code.
- The workflow already retrieves every changed file through GitHub's paginated pull-request files API, validates the event head before and after collection, and writes a bounded normalized artifact through `collectPrFiles.mjs`. That artifact contains `path`, patch availability, and line ranges; it currently discards a renamed file's `previous_filename`.
- `ci-review-coverage.mjs` evaluates review coverage and description format independently. Coverage has `report|enforce`; format has `off|report|enforce`. The public action defaults to report-only coverage and disabled format checking, while Harper's trusted workflow opts into enforcement.
- `classifyPullRequest()` exempts bots, non-members, and changes of at most two lines from existing coverage and format rules. Drafts defer enforcement. The framing policy decision in the dispatch log instead governs every ready member/owner change to a configured path, including a one-line edit; drafts, outside contributors, and bots remain report-only. Current dispatch PRs authenticate as the user's member account, so the target agent-authored population is included without a bot exception.
- `prFormatLinks.mjs` already produces a prose view that blanks fenced/indented code and HTML comments while retaining offsets. It is the existing parser boundary for body fields that must not match examples.
- The current production files directly importing `lmdb` or `@harperfast/rocksdb-js` were enumerated from current `origin/main`; test, fixture, benchmark, generated, and distribution paths were excluded.

## Invariant

For every ready member/owner pull request, a changed path in the caller's framing-required set implies a live planning outcome in the body: `chosen-approach-sound`, or `better-alternative-exists`/`option-set-too-narrow` with a `## For the human reviewer` section. No configured-path match implies no framing requirement.

## Proposed design

1. Add independent `framing_mode` and `framing_paths` action inputs. `framing_mode` defaults to `report`; `framing_paths` defaults to empty so the public action remains repository-neutral and backward-compatible. Harper's trusted base-owned workflow sets `framing_mode: enforce` and supplies its policy. Harper Pro can supply its own paths while pinning this action.
2. Reuse harper#2552's normalized PR-files artifact rather than adding a second checkout or API call. Extend each normalized entry with optional `previousPath`, populated from GitHub's `previous_filename`, so renaming a governed source out of the protected set cannot evade the gate. Keep artifact version 1 because the field is optional and existing consumers accept extra object properties.
3. Interpret each nonblank `framing_paths` line as either an exact repository-relative path or a directory prefix ending in `/**`. Reject absolute paths, parent traversal, and other wildcard syntax. Match both `path` and `previousPath`.
4. Add a pure framing evaluator. It uses the existing body inspector so fenced, indented, quoted, inline-code, and HTML-comment examples cannot become receipts. It recognizes only line-anchored `Framing-Verdict: chosen-approach-sound|better-alternative-exists|option-set-too-narrow`. A clearing value passes; either non-clearing value passes only with a live exact `## For the human reviewer` heading. If duplicate recognized verdicts exist, any non-clearing value requires the reviewer section; malformed-only fields are treated as missing.
5. Govern framing separately from `classifyPullRequest()`: enforce only when `draft` is false, `author_association` is `MEMBER` or `OWNER`, and the author is not a bot. Deliberately do not inherit the existing trivial-size exemption. The current dispatch author route is a member user; unrelated GitHub Apps, external contributors, and drafts stay green with a report-only explanation.
6. Fail closed in framing enforce mode when a governed PR needs file evidence but the artifact is missing, invalid, stale/superseded, or incomplete without a discovered match. An incomplete artifact that already contains a matching path is sufficient because omitted later pages cannot negate that match. Report mode emits the same diagnosis but stays green. Existing coverage and format error behavior is unchanged.
7. Add a separate step-summary/console section and exit decision for framing, leaving the existing coverage evaluator and its fields untouched. Extend the trusted workflow's collection condition so ready member/owner PRs are collected even when their diff is at most two lines; this is required because framing deliberately has no trivial waiver.
8. Configure Harper's workflow with the four named resource files, `resources/tracked.ts`, `replication/**`, and the current production direct-import surface for `lmdb` and `@harperfast/rocksdb-js`. Document that this is an explicit policy snapshot maintained by the caller, not a parser embedded in the reusable action.
9. Extend pure and real-entrypoint tests for the four acceptance cases: missing receipt fails on a matched path, clearing receipt passes, non-clearing receipt requires the reviewer section, and an unmatched docs/test/CI-only diff passes without a receipt. Also cover report mode, drafts/non-members/bots, trivial governed edits, prefix matching, renames, incomplete/missing evidence, malformed path inputs, action wiring/defaults, and the trusted workflow's enforced caller policy.

### Harper caller path policy

- `resources/Table.ts`
- `resources/RecordEncoder.ts`
- `resources/tracked.ts`
- `resources/PrimaryRocksDatabase.ts`
- `replication/**`
- `bin/copyDb.ts`
- `dataLayer/harperBridge/ResourceBridge.ts`
- `dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbGetBackup.js`
- `dataLayer/restoreMarker.ts`
- `dataLayer/rocksdbBackup.ts`
- `dataLayer/schemaDescribe.ts`
- `resources/DatabaseTransaction.ts`
- `resources/LMDBTransaction.ts`
- `resources/RocksIndexStore.ts`
- `resources/RocksTransactionLogStore.ts`
- `resources/analytics/write.ts`
- `resources/auditStore.ts`
- `resources/blob.ts`
- `resources/branchDatabase.ts`
- `resources/databases.ts`
- `resources/indexes/HierarchicalNavigableSmallWorld.ts`
- `resources/longLivedTransactions.ts`
- `resources/nodeIdMapping.ts`
- `resources/replayLogs.ts`
- `resources/search.ts`
- `server/http.ts`
- `server/transactionLogCooling.ts`
- `utility/environment/systemInformation.ts`
- `utility/lmdb/commonUtility.ts`
- `utility/lmdb/deleteUtility.ts`
- `utility/lmdb/environmentUtility.ts`
- `utility/lmdb/searchUtility.ts`
- `utility/lmdb/writeUtility.ts`

## Approaches considered

### Different layer

Enforce the field only in `pr-body-review-need.mjs`, where review footers are materialized. That helper is author-local and can be skipped—the motivating #2360/#2368 failure was precisely an omitted authoring step—so it cannot own the server-side invariant.

### Deeper cause

Make every authoring harness unconditionally run planning mode and publish its verdict. This improves compliant producers but cannot detect a skipped harness or a later body edit removing the verdict. The CI receipt consumer is still required to make omission visible.

### Do less

Use workflow `paths` filters or put a path boolean directly in each caller. Required path-filtered workflows remain pending when they do not run, while a preinterpreted boolean duplicates path semantics across callers and cannot safely account for incomplete enumeration. Reusing the complete file artifact keeps one bounded implementation.

### Chosen

Evaluate the caller-supplied path policy inside the existing trusted public action using #2552's normalized PR-files artifact. One already-authenticated enumeration now serves line-link validation and framing, and stale-head validation, pagination, permissions, and fail-closed collection already exist at the owning layer.

### Rejected previous choice: repository-local merge checkout

The earlier plan added a synthetic merge checkout solely to enumerate changed paths. After #2552, that duplicates the existing API artifact, expands the trusted workflow from one base checkout to base plus untrusted merge objects, and creates a second freshness contract. The merged artifact is the concrete disqualifier: it already enumerates the PR diff under head-before/head-after validation and never executes head code.

### Stronger receipt binding

Require a planning nonce and reviewed SHA in the PR field. The current producer contract deliberately publishes only `Framing-Verdict: <value>`; planning nonces validate reviewer output inside the private CLI but are not materialized into PR bodies. An author-typed SHA would not prove continuity. This first cut detects omission, not authenticity or freshness.

### Platform ownership

Use CODEOWNERS and a required design-team review on these paths. GitHub cannot distinguish a clearing planning verdict from a recorded disagreement, and mandatory human approval replaces rather than enforces the requested planning-review outcome.

## Verification route

The behavior is observable end to end through the JavaScript action entrypoint: spawn it with synthesized pull-request payloads and normalized file artifacts, then assert status and diagnostics for governed, non-governed, renamed, incomplete, and stale/superseded cases. Run `node --test .github/actions/review-coverage/*.test.mjs`, formatting and lint over changed files, the Harper build, and the repository's required full unit/integration gates. The production change is isolated to CI tooling and does not exercise the running Harper server.

## Planning review

`Framing-Verdict: chosen-approach-sound` — external Claude planning review, 2026-09-14.
