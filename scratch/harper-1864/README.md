# harper#1864 repro: schema-churn upgrade-boot point-read orphaning

`churn-repro.sh` builds a 5.1.10 root with a multi-file GraphQL schema, relocates type
declarations across files over many restarts (simulating real schema-evolution history),
concatenates back to a single file, seeds rows throughout, then upgrade-boots to 5.2.0-beta.1
and hammers `GET /dispatch/health` + `GET /dispatch/storeprobe` (sub-second polling) looking
for a long-lived (not brief self-healing) point-read divergence.

Requires the `probe-app`/`dispatch` component assets and `hdb5110`/`hdb52` npm installs used
in the original investigation (paths hardcoded for the investigation box — adjust
`H5110`/`H52`/`CHURN_SRC` at the top of the script for another machine).

## Usage

```
RESTARTS=15 HAMMER_SECONDS=90 bash churn-repro.sh
```

Logs to `/home/kzyp/dev/tmp/churn-repro.log`; leaves the 5.2 instance running at the end for
further live diagnosis.

## Observed reliability (this investigation, 2026-07-18)

15 attempts (`RESTARTS=4` and `RESTARTS=15`, `HAMMER_SECONDS` 30-180): **1/15 produced a
long-lived break** (~175s, essentially the full hammer window) on a `RESTARTS=4` run. The
other 14 either showed no divergence at all, or a sub-second self-healing blip. This is
consistent with the field reports being non-deterministic even with real schema-churn
history — churn appears to be a necessary but not sufficient ingredient; something else
(boot-time race window width, e.g. disk cache state / scheduling jitter) gates whether the
window is brief or long-lived. Fresh-install-only repros (no churn) never showed anything
beyond a sub-second blip in the small number of manual checks during this investigation.

## What the one caught long-lived break showed

- `GET /dispatch/health` reported `{"ok":false,"orphaned":[{"table":"User","rawCount":3,
  "scanCount":3,"getHits":0,"firstErr":"NULL"}]}` continuously for ~175s: the `User` table's
  full-scan (`search({})`) and `getKeys` both saw all 3 rows; `Table.get(k)` returned `null`
  for **all 3** (`getHits:0`), no exceptions. The `Worker` table (seeded identically) was
  unaffected.
- `firstErr` was `'NULL'` for the entire window, never `'ERR:...'` — the health probe code
  explicitly distinguishes a caught exception (`'ERR:'+message`) from a clean miss (`'NULL'`),
  so this rules out a bare exception on this path during the sampled window.
- Once healed, `GET /dispatch/storeprobe` showed `storeGetEntry.flags: 234881088` (0x0E000040
  = `HAS_NODE_ID` only, no `INVALIDATED`/`EVICTED`) for the previously-orphaned rows — matching
  the healthy-boot decode already confirmed in the investigation log, so whatever caused the
  miss did not persist in the entry's flags after healing.
- The window healed on its own with **no write** to the affected rows (the script issued none
  during the hammer phase); this matches the field report of a later write "healing" a row,
  but shows a write is not actually required for it to resolve — time/some other async
  completion is sufficient.
- The catch was NOT accompanied by a captured mid-window `storeprobe` snapshot (the sampled
  keys happened to heal between the failing `/health` call and the immediately-following
  `/storeprobe` call in that run); a later run with tighter interleaved capture logic is in
  the script but has not yet caught a second long-lived window to confirm entry-level
  `metadataFlags`/`version` state DURING the break.
