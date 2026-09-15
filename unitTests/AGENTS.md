# unitTests/AGENTS.md

Guidance specific to writing and fixing unit tests. See the repo-root [AGENTS.md](../AGENTS.md)
for everything else.

## Antipattern: an absolute count against a thread-global capture

A test replaces a process-global collector — most often `harperLogger.warn`/`.error`, or a
thread-global counter like `getOutstandingCommits()` — and then asserts an **absolute** count
(`.length === 1`, `.count === 0`) against it.

That count is not a count of what the test did. The hook or counter catches every caller on the
thread, and mocha runs every suite in one worker: an analytics-aggregation write, a
transaction-expiration abort, or another suite's own log line can land inside the same window and
flip the assertion red. Three separate fixes landed on `main` within three days, each correcting
this exact shape —
[Fix flaky outstanding-commit tracking unit test under concurrent analytics commits](https://github.com/HarperFast/harper/pull/2579)
(2026-09-13), [Attribute the getRecordCount entry-count spy to the call under test](https://github.com/HarperFast/harper/pull/2590)
(2026-09-14), [Attribute the stuck-commit log assertions to the commit under test](https://github.com/HarperFast/harper/pull/2596)
(2026-09-15) — which makes it a defect class, not three unrelated flakes.
[Commit 52512e85a](https://github.com/HarperFast/harper/commit/52512e85a)'s message has the full
anatomy of one instance.

**The tell:** a `beforeEach`/`try` block that swaps `harperLogger.warn`/`.error` (or reads a
thread-global counter) into a local array, then asserts `array.length === N` with no filtering
and no delta against a captured baseline. The same defect wears a second disguise: positional
indexing into the capture (`warnings[0]?.[0]`, as in `unitTests/resources/auditLog.test.js:1603`
and `:1607`, inside "contains and retries a failed last-removed write") — index 0 is just "the
first line any caller on the thread logged," so it is exactly as exposed as an absolute length
check.

### Remedy 1 — delta across a synchronous window

Read the global counter before and after the operation under test, with no `await` between the
two reads. No foreign work can be linked or unlinked inside a synchronous window, so the delta is
this test's alone.

Worked example: `trackedAcross()` in
[`unitTests/resources/outstandingCommitTracking.test.js`](resources/outstandingCommitTracking.test.js)
(see its header comment for the full rationale). It also pairs with `settleOutstandingCommits()`
there for the async case — wait for the thread to _drain to_ the expected count (with a timeout
and a diagnostic failure message) rather than asserting the raw count is already there. That still
polls an absolute count, so it is a narrower tradeoff, not the same guarantee as a delta: any node
still outstanding when the wait's own (short, test-only) timeout elapses fails the assertion, even
one that is merely slow rather than stuck. It is sound only empirically, not by construction:
legitimate foreign work (the analytics burst the header comment describes) settles within tens of
milliseconds, far inside the 5s deadline, while a node that is actually stuck never settles at all
— so in practice the deadline separates real bugs from noise. It is not a general license to
lower `setMaxOutstandingTxnDuration()`: the shed-on-age path fires on the _oldest_ outstanding node
regardless of owner, so lowering it to make this helper resolve faster 503s every other write on
the thread in the process.

### Remedy 2 — filter by the fixture's own identity

Give the operation under test some identifying value (a commit id, a table name, a distinguishing
substring), then filter the captured lines down to the ones carrying that identity before
asserting a count against the filtered set. Report the unattributed lines in the failure message
so a future failure names its own noise, and inject synthetic foreign lines as a positive control
so the filter is proven to reject them, not merely never see them.

Worked example: `shedLinesFor()` in
[`unitTests/resources/longLivedTransactions.test.js`](resources/longLivedTransactions.test.js),
with the positive control in `injectForeignErrorLines()` / `assertForeignLinesWereCaptured()`
just below it.

### Candidates to convert (not confirmed flaky — do not describe as known-flaky)

A grep for the same shape (a global logger swap followed by an absolute `.length` assertion)
turned up these call sites, still unguarded. Whether each is actually racy in practice has **not**
been verified — treat them as candidates for the same treatment, not as known bugs:

Line numbers are as of this writing and will drift as these files change; the test titles are the
durable anchor if a line has moved.

- `unitTests/resources/auditLog.test.js:345` and `:386` — "deleteHistory contains a mid-loop
  rejection" and "deleteHistory reports a purge that attempted removals and completed none"
- `unitTests/resources/auditLog.test.js:1603` and `:1607` — the positional-index variant of the
  same tell, inside "contains and retries a failed last-removed write"
- `unitTests/resources/transaction.test.js:285` — "abandons the retained handle writes when a
  commit with outstanding iterators replays"

**Grep match that is not a candidate:** `unitTests/resources/recordEncoder.test.js:136` and
`:173-174` ("returns null (non-fatal) and warns distinctly when a typed structure is absent on
this node" and "still returns null (tolerant) for a decode failure that is not a missing
structure") match the syntactic shape but not the exposure: both tests are synchronous
end-to-end, with no `await` between installing the collector and restoring it, so nothing else
can interleave a log line in between. Left here so the grep's full match set stays visible,
without asking anyone to spend effort converting it.
