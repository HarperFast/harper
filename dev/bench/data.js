window.BENCHMARK_DATA = {
  "lastUpdate": 1783755719235,
  "repoUrl": "https://github.com/HarperFast/harper",
  "entries": {
    "YCSB Throughput (single-node)": [
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "6fc63072c0d4321b8905e4ea6f92f711172b6d23",
          "message": "fix(ci): add registry-url to setup-node in publish-harper-npm-package job\n\nWithout registry-url, setup-node does not write an .npmrc with the auth\ntoken, causing ENEEDAUTH on npm publish despite NODE_AUTH_TOKEN being set.\nThe harperfast job had this correct; the harper job was missing it.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-02T21:17:06Z",
          "url": "https://github.com/HarperFast/harper/commit/6fc63072c0d4321b8905e4ea6f92f711172b6d23"
        },
        "date": 1780476817880,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6424.8,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9565.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9750.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7224.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5238.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10144.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1146.5,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "caeb66683673f6850c70df55222e4d6deda28a50",
          "message": "Merge pull request #1118 from HarperFast/chore/bump-ai-review-prompts-2be0f70\n\nci: bump ai-review-prompts pin to 2be0f70",
          "timestamp": "2026-06-03T19:52:04Z",
          "url": "https://github.com/HarperFast/harper/commit/caeb66683673f6850c70df55222e4d6deda28a50"
        },
        "date": 1780562701842,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6014.66,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8531.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8412.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6739.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4828.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8647.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 939.49,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "chris nelson",
            "email": "chris.nelson@harperdb.io"
          },
          "committer": {
            "name": "chris nelson",
            "username": "sleekmountaincat",
            "email": "sleekmountaincat@gmail.com"
          },
          "id": "266d5d8ba425b77d80692637e605a7c6f9e82d23",
          "message": "fix(upgrade): run upgrade directives without interactive confirmation\n\nA directive-driven upgrade runs on the normal `harper run` startup path, where\nthe upgrade-confirmation prompt (forceUpdatePrompt) blocked on stdin — or, with\nno TTY, defaulted to \"no\" and refused to start — breaking unattended/scripted\nstarts (systemd, containers, CI). `upgrade()` only ever runs when an upgrade\ndirective applies (getVersionUpdateInfo returns an object solely when\nhasUpgradesRequired is true), so this prompt was exclusively a directive-upgrade\ngate. Remove it; directives now run automatically with a non-blocking notice\nthat keeps the release-notes link. Downgrades still confirm (forceDowngradePrompt).\n\n- bin/upgrade.js: drop the forceUpdatePrompt gate + cancel/exit branch.\n- upgrade/upgradePrompt.ts: remove the now-unused forceUpdatePrompt.\n- unitTests/bin/upgrade.test.js: remove the obsolete (skipped) upgrade() prompt\n  tests + the vars/imports they owned; runUpgrade() tests unchanged.\n- integrationTests/upgrade/4.x-upgrade.test.ts: revert the CONFIRM_UPGRADE=yes\n  workaround now that startup no longer prompts.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T04:23:38Z",
          "url": "https://github.com/HarperFast/harper/commit/266d5d8ba425b77d80692637e605a7c6f9e82d23"
        },
        "date": 1780648772295,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6079.56,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8562.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8380.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6764.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4776.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8689.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 919.09,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780733606150,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6145.21,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8761.31,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8545.25,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6579.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4740.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8608.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 931.98,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780820670656,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7712.24,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 11959.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 11316.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 8650.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6188.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 11683.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1239.61,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780908786827,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5905.75,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8302.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8204.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6536.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4688.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8503.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 870.34,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "chris nelson",
            "email": "chris.nelson@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "88c94e67e9a1d33562776d160d3dc3b4833616d5",
          "message": "fix(indexing): yield the event loop during a synchronous custom-index backfill\n\nA custom index (HNSW vector index) indexes synchronously: in runIndexing's\nper-row loop, index.customIndex.index() runs inline and returns void, so it\nnever assigns lastResolution and never raises `outstanding`. The existing\nyield is gated on `outstanding > MIN_OUTSTANDING_INDEXING`, so for a\ncustom-index backfill it never fires — the entire backfill over the populated\nrows runs in a single event-loop turn, freezing the worker's main thread for\nthe whole build (starving replication keepalive, the operations API, and\nschema signalling, and never letting isIndexing be observed; vector search\nreturns 503 the entire time).\n\nTrack whether a row performed synchronous custom-index work and yield once per\nsuch row when the outstanding-based yields don't apply.\n\nValidated on a live 5.1.0-beta.1 instance with a 100ms main-thread heartbeat\nover an identical 2,000-row int8 HNSW backfill (clean A/B, same box/data):\n  before: max event-loop stall 71,030 ms (frozen for the entire 71.2s build)\n  after:  max event-loop stall    166 ms; build 67.5s (no measurable throughput cost)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-05T19:48:12Z",
          "url": "https://github.com/HarperFast/harper/commit/88c94e67e9a1d33562776d160d3dc3b4833616d5"
        },
        "date": 1780993822142,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6023.1,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8575.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8601.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6686.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4802.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8694.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 923.75,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "7845a096ece532e116275d23033bbd48c6bd2bf0",
          "message": "Merge pull request #1217 from HarperFast/feat/config-union-directive\n\nfeat(config): add `$union` array directive for config env vars",
          "timestamp": "2026-06-10T04:21:59Z",
          "url": "https://github.com/HarperFast/harper/commit/7845a096ece532e116275d23033bbd48c6bd2bf0"
        },
        "date": 1781080833920,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5872.86,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8294.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 7968.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6516.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4586.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8201.85,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 935.35,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781338935479,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6781.71,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9811.01,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9844.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7368.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5426.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9933.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1171.12,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781426287255,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6641.83,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9766.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10020.76,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7443.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5356.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9979.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1143,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781515365192,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6712.99,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9691.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10000.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7587.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5443.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9936.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1218.38,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "71d629c4fe5938b1393054cb933738992c7ad2bd",
          "message": "5.1.2",
          "timestamp": "2026-06-16T05:02:27Z",
          "url": "https://github.com/HarperFast/harper/commit/71d629c4fe5938b1393054cb933738992c7ad2bd"
        },
        "date": 1781601178487,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6212.04,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8693.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8775.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6906.89,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4951.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8444.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 932.39,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "2de38eac8877cd4e58c8f4b2263ae4fe2dd69fa9",
          "message": "5.1.3",
          "timestamp": "2026-06-16T22:22:27Z",
          "url": "https://github.com/HarperFast/harper/commit/2de38eac8877cd4e58c8f4b2263ae4fe2dd69fa9"
        },
        "date": 1781686722406,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6807.95,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9922.31,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10171.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7672.01,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5523.13,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10255.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1190.65,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "1b65d7dadfa43f4bc942249d53ecca74f82d8d0f",
          "message": "feat(mcp): implement ping + logging/setLevel + notifications/message (#1350)\n\n* feat(mcp): implement ping + logging/setLevel + notifications/message\n\nThe MCP server advertised the `logging` capability but `logging/setLevel`\nreturned -32601, and `ping` (a base-protocol utility) was unanswered. Both are\nnow implemented, reconciling the advertised capability with real behavior.\n\n- ping: returns an empty result. Routed after session validation so a stale /\n  expired / wrong-user session surfaces the normal 404/403 rather than being\n  masked by an unconditional success; a ping notification gets the standard 202.\n- logging/setLevel: validates an RFC 5424 level and stores it. The level is\n  persisted on the durable session record (system.mcp_session) so it survives an\n  SSE reconnect, is order-independent of GET-stream open, and expires with the\n  session TTL — no separate cache to leak. The live SSE record is seeded from it\n  on (re)connect and updated in place on setLevel.\n- notifications/message: new logging.ts emitter delivers to a session over its\n  SSE channel, filtered by the session's level (no messages before setLevel).\n  Deliberately scoped to MCP-layer events — NOT the global harperLogger stream,\n  which has no subscription hook and is process-wide/cross-worker (forwarding it\n  would be a data leak + firehose). One call site wired: tools/call rate-limit\n  rejections emit a `notice`.\n\nKnown limitation (consistent with the existing listChanged channel): server\npush is per-worker in v1, so a setLevel POST handled on a different worker than\nthe session's SSE stream takes effect on that stream only at the next reconnect.\nCross-worker push is a subsystem-wide design item tracked in the MCP design-doc\nissue.\n\nUnit tests: logging level taxonomy + per-session filtering + profile fan-out;\ntransport ping (valid/invalid-session/notification) and setLevel (valid, -32602,\npersistence, reconnect seeding).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor(mcp): harden log-level admission + simplify live-record seeding\n\nAddress Gemini review on the logging PR:\n- admits(): reject an unrecognized level instead of defaulting its rank to 0\n  (which could slip past a 'debug' minimum). Both ranks must resolve.\n- handleGet: assign session.logLevel directly (a fresh record's level is\n  already undefined), dropping the redundant guard.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(mcp): adopt touchSession's return so per-request saves keep fresh lastActivity\n\nhandlePost called `await touchSession(session)` but discarded the returned copy\n(which carries the new lastActivity), leaving the local `session` stale. Any\nlater save in the same request then rolled lastActivity back to the load-time\nvalue — pre-existing for `notifications/initialized` (handleInitialized) and now\nalso `logging/setLevel` (dispatchSetLevel) added in this PR.\n\nReassign `session = await touchSession(session)` so every downstream save\npersists the current activity time. Regression test forces a stale lastActivity\nand asserts setLevel advances rather than rolls it back. (TTL is unaffected\neither way — it keys off the record's put timestamp — but the field is now\naccurate.)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-18T03:15:33Z",
          "url": "https://github.com/HarperFast/harper/commit/1b65d7dadfa43f4bc942249d53ecca74f82d8d0f"
        },
        "date": 1781772281688,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 8593.95,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 12795.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12956.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9576.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6922.96,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 12867.96,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1477.43,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d6a8ca8beec08459f8802c19979aab66062520ec",
          "message": "Release v5.1.5",
          "timestamp": "2026-06-18T18:56:04Z",
          "url": "https://github.com/HarperFast/harper/commit/d6a8ca8beec08459f8802c19979aab66062520ec"
        },
        "date": 1781859661400,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6752.16,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9858.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10270.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7639.59,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5550.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10365.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1178.93,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "06e79bcb268be2ee22d054c50e3b716fac87e496",
          "message": "docs(AGENTS): prefer plain assert over node:assert/strict\n\nnode:assert/strict is a dumpster fire and terrible — its deep-equality and\ncoercion semantics cause more friction and surprising failures than they\nprevent. Drop the strict requirement from the test-style guidance and\nencourage plain `assert` (the house style) instead. The sinon/rewire\nprohibition is unchanged.\n\nPer Kris.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-19T17:19:32Z",
          "url": "https://github.com/HarperFast/harper/commit/06e79bcb268be2ee22d054c50e3b716fac87e496"
        },
        "date": 1781943951808,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5968.56,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8340.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8376.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6611.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4753.06,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8215.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1020.06,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d0d04ebce7436180219d5d045f490a84b68b6ab4",
          "message": "chore(deps): bump @harperfast/integration-testing to ^0.6.2\n\nPicks up the loopback conflict-canary HTTP-port fix (integration-testing#20):\nthe canary now probes both the operations port AND the HTTP port, detecting a\nlingering Harper worker (main thread exited, HTTP workers still bound via\nSO_REUSEPORT) before recycling its loopback address — fixing the ECONNREFUSED\nshard-contamination seen under CI sharding.\n\n0.5.2 -> 0.6.2 has no breaking API changes: the only runtime deltas are\n'fix: Prevent global state smashing' (0.5.4) and the canary (0.6.2); the 0.6.0\nminor is purely the semantic-release CI automation feat, not an API change.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-20T22:26:51Z",
          "url": "https://github.com/HarperFast/harper/commit/d0d04ebce7436180219d5d045f490a84b68b6ab4"
        },
        "date": 1782031592992,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6061.05,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8578,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8667.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6865.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4898.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8680.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1071.75,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d0d04ebce7436180219d5d045f490a84b68b6ab4",
          "message": "chore(deps): bump @harperfast/integration-testing to ^0.6.2\n\nPicks up the loopback conflict-canary HTTP-port fix (integration-testing#20):\nthe canary now probes both the operations port AND the HTTP port, detecting a\nlingering Harper worker (main thread exited, HTTP workers still bound via\nSO_REUSEPORT) before recycling its loopback address — fixing the ECONNREFUSED\nshard-contamination seen under CI sharding.\n\n0.5.2 -> 0.6.2 has no breaking API changes: the only runtime deltas are\n'fix: Prevent global state smashing' (0.5.4) and the canary (0.6.2); the 0.6.0\nminor is purely the semantic-release CI automation feat, not an API change.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-20T22:26:51Z",
          "url": "https://github.com/HarperFast/harper/commit/d0d04ebce7436180219d5d045f490a84b68b6ab4"
        },
        "date": 1782119935055,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6055.44,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8417.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8473.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6751.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4845.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8369.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1040.86,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "79b532c2c6188e8ada7bcf547e6ee21a1e4587bd",
          "message": "Clarify upgrade migration log: show the data→software transition and migration purpose (#1452)\n\n* Clarify upgrade migration log: show the data→software transition and migration purpose\n\nThe upgrade runner logged `Running upgrade for version <X>` where <X> is the\nversion that *introduced* a migration directive, not the software version being\ninstalled. With only the 5.1.0 directive registered, that line prints \"5.1.0\"\nfor any upgrade crossing it (e.g. while installing 5.1.7), which reads like a\ndowngrade and says nothing about what the migration does.\n\nLog a header with the real data → software transition and the migration count,\nand frame each migration as \"Applying migration N of M (introduced in <version>)\n— <description>\". Adds an optional `description` field to the directive object\n(set on the 5.1.0 directive). Log/notify text only — no change to upgrade logic.\n\nRefs #1451\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(upgrade): drop sinon/chai; extract pure log formatters for node:assert/strict tests\n\nAddresses the automated review on #1452. AGENTS.md prohibits new uses of sinon/\nrewire and targets node:assert/strict against real modules; the new test file had\nbootstrapped sinon + chai.\n\nExtract the log-string construction into two pure exported functions\n(formatUpgradeHeader, formatMigrationLine) and test them directly with\nnode:assert/strict — no stubbing, no sinon, no chai. processDirectives now calls\nthe helpers. Also widens coverage (pluralization, the no-description branch).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-22T23:47:17Z",
          "url": "https://github.com/HarperFast/harper/commit/79b532c2c6188e8ada7bcf547e6ee21a1e4587bd"
        },
        "date": 1782203109515,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6718.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9754.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9990.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7611.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5477.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10133.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1338.1,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "541a3d33d787acb1d6b338714110ca4a6dcd8107",
          "message": "Release v5.1.11",
          "timestamp": "2026-06-24T02:09:49Z",
          "url": "https://github.com/HarperFast/harper/commit/541a3d33d787acb1d6b338714110ca4a6dcd8107"
        },
        "date": 1782289360104,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6642.14,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9778.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10077.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7584.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5491.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10022.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1289.53,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "a0b59b3c0b08f029e3d5860f69eab7ee679a2cb7",
          "message": "chore: drop accidentally committed node_modules symlink\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-23T12:15:28Z",
          "url": "https://github.com/HarperFast/harper/commit/a0b59b3c0b08f029e3d5860f69eab7ee679a2cb7"
        },
        "date": 1782375593694,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7954.96,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 11879.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12197.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9237.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6658.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 12147.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1561.52,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782462541143,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5969.24,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8443.97,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8534.41,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6699.11,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4821.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8618.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1054.24,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782547746488,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 8411.71,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 12136.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 11970.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9031.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6550.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 12162.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1558.84,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782635032008,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6120.33,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8653.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8703.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6815.86,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4942.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8671.05,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1039.9,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "5f8e4256795cfe86e30d6fe129580788efe62048",
          "message": "style: prettier-format .gemini/config.yaml\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T20:08:55Z",
          "url": "https://github.com/HarperFast/harper/commit/5f8e4256795cfe86e30d6fe129580788efe62048"
        },
        "date": 1782723289444,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6095.58,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8630.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8622.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6733.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4905.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8558.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1046.98,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "deb638f8bd4681f2195385e30766b06d79fdf432",
          "message": "chore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71) (#1519)\n\n* chore(ci): bump ai-review-prompts to 67d7611 (prompt-ref tracking)\n\nForward bump 1bbc562 -> 67d7611 (ai-review-prompts #71): the log step now\nrecords which prompt version produced each ai-review-log entry — a\n`**Prompt ref:**` body field plus a `prompt:<shortsha>` label — so\ncalibration can attribute verdicts to a specific prompt version instead\nof a date bucket. No prompt-content change vs 1bbc562 (which already\ncarried the #67 calibration + #69 log-count fix); this turns on\nper-version tracking.\n\n`uses:` and `ai-review-prompts-ref:` move in lockstep.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* chore(ci): re-point bump to 9cf49d2 (add #70 week-of-06-22 calibration)\n\n#70 (week-of-06-22 calibration) merged after this bump was opened, so\nre-point 67d7611 -> 9cf49d2 to land the calibration AND the #71 prompt-ref\ntracking together in a single bump rather than forcing a second one.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-30T04:45:14Z",
          "url": "https://github.com/HarperFast/harper/commit/deb638f8bd4681f2195385e30766b06d79fdf432"
        },
        "date": 1782808082158,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6076.59,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8554.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8600.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6742.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4805.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8685.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1047.46,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "email": "kris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f8368e454c10ac6803cd2e30c50941dd293ea0fd",
          "message": "test(terminology): optional-chain waitFor response to avoid masking server errors\n\nAddresses Gemini review: a non-JSON/empty error body would make res.body.message\nthrow a TypeError (masking the real error and suppressing r.text in the failure).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-24T14:16:14Z",
          "url": "https://github.com/HarperFast/harper/commit/f8368e454c10ac6803cd2e30c50941dd293ea0fd"
        },
        "date": 1782895275734,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5827.33,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8219.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8211.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6440.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4686.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8251.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1062.14,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "1b45db9ea5fecc6cd07c3102f4fd8a5fadb098e4",
          "message": "Merge pull request #1528 from HarperFast/feat/env-secret-encryption\n\nfeat(env): dormant decrypt hook + enc:v1 contract for env-secret encryption",
          "timestamp": "2026-07-01T23:03:37Z",
          "url": "https://github.com/HarperFast/harper/commit/1b45db9ea5fecc6cd07c3102f4fd8a5fadb098e4"
        },
        "date": 1782980186960,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6842.4,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9916.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10224.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7608.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5485,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10129.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1376.94,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6dcfbd09b0b55722cf4b3a6a56f9a8a519590335",
          "message": "fix(blob): decompress (inflate) on read instead of re-deflating (#1393)\n\nFileBackedBlob.bytes() called deflate() on the already-compressed on-disk\nbody for DEFLATE_TYPE blobs, double-compressing instead of decompressing,\nand inflate was never imported. The streaming read path had a\n\"TODO: Implement support for decompression\" and likewise returned the raw\ncompressed bytes. Reading any DEFLATE-compressed blob therefore returned\ncorrupt data. Latent today because blob compression (compress?: boolean) is\nexposed but unused/off by default; this makes it correct before it is enabled.\n\n- bytes(): inflate the body for DEFLATE_TYPE; inflate-then-slice so start/end\n  range over the uncompressed content. Completeness for a compressed blob\n  can't be judged from the (uncompressed) header size vs the compressed body\n  length, and the header size is finalized up front when the size is known,\n  so completeness is verified via the writer's existing fileId+\":blob\" lock\n  (new mustVerifyViaLock probe) before inflating. Uncompressed path behavior\n  is preserved (exact size-vs-body comparison).\n- stream(): on detecting DEFLATE_TYPE in the header, delegate to the buffered\n  inflate path and emit a single chunk. Correct-or-safe fallback: a true\n  streaming inflate was left out as too risky given the position-seeking /\n  watcher framing (uncompressed-offset seeking into a deflate stream isn't\n  possible).\n- Tests: compressed round-trip via bytes() and stream(), plus a ranged read.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T16:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/6dcfbd09b0b55722cf4b3a6a56f9a8a519590335"
        },
        "date": 1783066675527,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6010.15,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8559.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8585.33,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6740.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4856.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8580.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1074.8,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6dcfbd09b0b55722cf4b3a6a56f9a8a519590335",
          "message": "fix(blob): decompress (inflate) on read instead of re-deflating (#1393)\n\nFileBackedBlob.bytes() called deflate() on the already-compressed on-disk\nbody for DEFLATE_TYPE blobs, double-compressing instead of decompressing,\nand inflate was never imported. The streaming read path had a\n\"TODO: Implement support for decompression\" and likewise returned the raw\ncompressed bytes. Reading any DEFLATE-compressed blob therefore returned\ncorrupt data. Latent today because blob compression (compress?: boolean) is\nexposed but unused/off by default; this makes it correct before it is enabled.\n\n- bytes(): inflate the body for DEFLATE_TYPE; inflate-then-slice so start/end\n  range over the uncompressed content. Completeness for a compressed blob\n  can't be judged from the (uncompressed) header size vs the compressed body\n  length, and the header size is finalized up front when the size is known,\n  so completeness is verified via the writer's existing fileId+\":blob\" lock\n  (new mustVerifyViaLock probe) before inflating. Uncompressed path behavior\n  is preserved (exact size-vs-body comparison).\n- stream(): on detecting DEFLATE_TYPE in the header, delegate to the buffered\n  inflate path and emit a single chunk. Correct-or-safe fallback: a true\n  streaming inflate was left out as too risky given the position-seeking /\n  watcher framing (uncompressed-offset seeking into a deflate stream isn't\n  possible).\n- Tests: compressed round-trip via bytes() and stream(), plus a ranged read.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T16:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/6dcfbd09b0b55722cf4b3a6a56f9a8a519590335"
        },
        "date": 1783152807003,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5894.03,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8395.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8410.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6581.51,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4792.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8343.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1024.82,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "228eacc0fb41dd521b4d990a46533ecaccd6c3f3",
          "message": "fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test (#1476)\n\n* fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test\n\nWhen `restart_service http_workers` tears a worker down mid-backfill, runIndexing's\nrange scan/puts throw against the closing store (\"Database not open\"). The old catch\nlogged a misleading error and then tried to persist `indexingFailed` against the\nalready-closed store, which also failed (\"Failed to persist indexing failure state\").\nTreat a store closed by shutdown (`primaryStore.rootStore.status === 'closed'`) as a\nbenign interruption: skip the doomed persist and log at debug. Recovery is unchanged —\nthe next worker generation re-runs the backfill via the existing crash-recovery trigger\n(indexingPID !== process.pid / restartNumber < current generation).\n\nAlso de-flakes the reindex integration test: a recovery-reindex window after the\nrestart-interrupted first backfill legitimately returns a transient INDEX_REBUILDING\n(503), which the test's single-success gate didn't tolerate. A new vectorSearchStable()\npolls past the transient window; a permanently-stuck index (never recovers) still fails.\n\nAdds a unit test for the shutdown-interruption path (runIndexing resolves, no indexingFailed).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(indexing): preserve interruption error in debug logs; use sleep() in test\n\nAddresses Gemini review: pass the underlying error to logger.debug on the\nshutdown-interruption paths so the root cause (e.g. \"Database not open\") is captured;\nuse the already-imported sleep() helper in vectorSearchStable.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kris Zyp <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-04T12:42:35Z",
          "url": "https://github.com/HarperFast/harper/commit/228eacc0fb41dd521b4d990a46533ecaccd6c3f3"
        },
        "date": 1783239369207,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6004.72,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8530.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8478,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6784.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4899.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8504.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1064.59,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "228eacc0fb41dd521b4d990a46533ecaccd6c3f3",
          "message": "fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test (#1476)\n\n* fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test\n\nWhen `restart_service http_workers` tears a worker down mid-backfill, runIndexing's\nrange scan/puts throw against the closing store (\"Database not open\"). The old catch\nlogged a misleading error and then tried to persist `indexingFailed` against the\nalready-closed store, which also failed (\"Failed to persist indexing failure state\").\nTreat a store closed by shutdown (`primaryStore.rootStore.status === 'closed'`) as a\nbenign interruption: skip the doomed persist and log at debug. Recovery is unchanged —\nthe next worker generation re-runs the backfill via the existing crash-recovery trigger\n(indexingPID !== process.pid / restartNumber < current generation).\n\nAlso de-flakes the reindex integration test: a recovery-reindex window after the\nrestart-interrupted first backfill legitimately returns a transient INDEX_REBUILDING\n(503), which the test's single-success gate didn't tolerate. A new vectorSearchStable()\npolls past the transient window; a permanently-stuck index (never recovers) still fails.\n\nAdds a unit test for the shutdown-interruption path (runIndexing resolves, no indexingFailed).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(indexing): preserve interruption error in debug logs; use sleep() in test\n\nAddresses Gemini review: pass the underlying error to logger.debug on the\nshutdown-interruption paths so the root cause (e.g. \"Database not open\") is captured;\nuse the already-imported sleep() helper in vectorSearchStable.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kris Zyp <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-04T12:42:35Z",
          "url": "https://github.com/HarperFast/harper/commit/228eacc0fb41dd521b4d990a46533ecaccd6c3f3"
        },
        "date": 1783327628698,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5821.02,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8242.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8516.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6605.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4733.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8526.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1075.52,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "ece7da47672d8ee175a87b39b2a21340169c376a",
          "message": "feat: re-authorize live subscriptions; revoke on permission loss or token expiry (#1414) (#1535)\n\n* feat: re-authorize live subscriptions; revoke on permission loss or token expiry (#1414)\n\nSubscribe-time authorization is point-in-time: once an SSE/WebSocket/MQTT stream is\nopen it keeps delivering even after the principal loses access (drop_user, role or\npermission change) or the bearer token it was opened with expires. This adds a\ncontinuous re-authorization registry that terminates such subscriptions.\n\n- server/liveSubscriptionAuth.ts: a registry of live subscriptions, each with a\n  table/RBAC-level recheck and a terminate handler. Swept (1) immediately on the ITC\n  user-change broadcast — serverHandlers rebuilds the user/role cache before firing\n  listeners, so the recheck sees current permissions — and (2) on a 30s interval as a\n  backstop and to catch token expiry, which is not event-signaled. Re-auth is\n  table-level (re-runs the same allowRead the subscription was granted with against a\n  freshly-fetched user); there is NO per-record evaluation. An error during recheck\n  fails closed (revokes). Normal teardown auto-unregisters.\n\n- resources/Resource.ts: at the common authorization chokepoint\n  (authorizeActionOnResource), register the resulting subscription for both the\n  'subscribe' (MQTT) and 'connect' (SSE/WebSocket) actions. Subscriptions with no user\n  principal (internal watchers, replication, local-bypass) are skipped.\n\n- security/auth.ts: capture the bearer token's JWT exp on the authenticated user so a\n  subscription opened with it can be revoked once it expires.\n\nRe-auth interval is overridable via HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS (tests).\n\nTest: integrationTests/security/subscription-revocation.test.ts opens an SSE collection\nsubscription and asserts delivery STOPS after (1) drop_user (event-driven) and (2)\nbearer-token expiry (interval-driven), while an authorized stream keeps delivering. 2/2\npass.\n\nCloses #1414.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix: address review — fresh user in recheck context, forward end() args, format\n\n- recheck advances context.user to the freshly-fetched user before re-running allowRead,\n  so a custom allowRead reading context.user / getCurrentUser() evaluates current state\n  rather than the stale subscribe-time user (Gemini critical).\n- the wrapped subscription.end() forwards all arguments to the original end() so stream\n  cleanup semantics are preserved (Gemini high).\n- prettier formatting on the new test.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* style: prettier formatting on subscription-revocation test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(lint): use node:assert instead of restricted node:assert/strict\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kris@harperdb.io>",
          "timestamp": "2026-07-06T23:39:00Z",
          "url": "https://github.com/HarperFast/harper/commit/ece7da47672d8ee175a87b39b2a21340169c376a"
        },
        "date": 1783412427391,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6504.95,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9275.56,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9685.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7338.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5192.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9800.73,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1330.46,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "a0f4a51acfa917fd544c88eec4b8893b5d04512e",
          "message": "fix(mqtt): close last-will persistence race; give retained-message test more headroom\n\nTwo independent causes behind the flaky \"test MQTT connections and commands\"\nsuite:\n\n- \"last will should be published on connection loss\": getSession() wrote the\n  Last Will record via getLastWill().put(will) without awaiting it, before\n  CONNACK is sent. A client that connected and then disconnected abruptly\n  could race ahead of that write; session.disconnect() would then find no\n  will record and silently drop it, hanging the test until mocha's timeout.\n  Reproduced deterministically with an artificial delay before the write, and\n  confirmed the fix (await the write) closes the race. Fix: await\n  getLastWill().put(will).\n\n- \"subscribe to retained/persisted record\": already raced the real message\n  event against a backstop timer, but the backstop (8000ms) left only 2s of\n  margin under the suite's 10000ms mocha timeout, and delivery is known to\n  routinely exceed 1s on loaded CI runners. Bump this test's own timeout to\n  20000ms (same precedent as the QoS=1 reconnect test) and derive the inner\n  backstop from this.timeout() - 2000 so the two can't race each other.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-07T23:40:40Z",
          "url": "https://github.com/HarperFast/harper/commit/a0f4a51acfa917fd544c88eec4b8893b5d04512e"
        },
        "date": 1783497517329,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 8431.95,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 12113.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12272.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9310.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6751.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 12406.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1617.1,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9018760e480a61e54d280eb07e93fa26c96c9a0b",
          "message": "Merge pull request #1621 from HarperFast/kris/blob-send-drain-core\n\nfeat(threads): graceful drain hook for in-flight work before worker shutdown",
          "timestamp": "2026-07-08T22:56:41Z",
          "url": "https://github.com/HarperFast/harper/commit/9018760e480a61e54d280eb07e93fa26c96c9a0b"
        },
        "date": 1783585237706,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 9189.07,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 15799.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 15289.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 10371.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 7706.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 14807.09,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1581.34,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "bd1dce0b1bbb91aeea15e5380f5b98e311f631a8",
          "message": "feat(#914): uWebSockets.js HTTP/WebSocket backend (default-off) (#1096)\n\n* feat(http): add uWebSockets.js request adapter (spike, #914)\n\nSpike for evaluating uWS as a per-worker HTTP server on the plaintext-UDS\npath behind symphony (TLS/mTLS/HTTP-2 terminated upstream). Adds:\n\n- UwsRequest in Request.ts: a Harper request adapter modeled on BunRequest,\n  sourced from uWS-extracted method/url/headers/body. Real client IP comes\n  from X-Forwarded-For; peerCertificate/authorized are null (terminated\n  upstream).\n- uwsServer.ts: createUwsServer(), a non-SSL uWS App on a unix socket that\n  bridges each request through httpChain[port] and serializes the Harper\n  response descriptor back onto the uWS HttpResponse.\n\nBenchmarks (CPU-µs/request, vs Node http on the same UDS) show uWS holds a\n~1.56x efficiency edge with the real Request abstraction in the loop. Not yet\nwired into getUwsHTTPServer/threadServer.js; uWS is not yet a dependency.\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\n* feat(http): wire uWS UDS server behind HARPER_UWS_UDS flag (spike, #914)\n\nMakes the per-worker plaintext-UDS mirror optionally served by uWebSockets.js\ninstead of a Node http server, gated behind the HARPER_UWS_UDS env flag\n(default off -> no behavior change). When set:\n\n- getHTTPServer registers a uwsServeConfigs entry for the UDS path instead of\n  creating the Node udsServer.\n- makeUwsHandler mirrors the Bun fetchHandler's post-processing (httpChain,\n  unhandled, universalHeaders, Server-Timing, analytics, logging) and returns a\n  Harper response descriptor; createUwsServer serializes it onto the uWS res.\n- threadServer.listenOnPorts() starts the uWS UDS servers from uwsServeConfigs.\n- uWebSockets.js added as an optionalDependency (GitHub tag; ABI-locked, no\n  musl build -> CI must build per Node major).\n\nSymphony must use sourceAddressHeader 'xForwardedFor' for these sockets (uWS\ndoes not parse the PROXY protocol). Fastify status===-1 fallback and response\nstreaming are not wired in this spike. Type-checks clean (tsc --noEmit); not\nyet exercised against a live booted Harper.\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\n* fix(http): null-guard request._nodeRequest in unhandled() (spike, #914)\n\nunhandled() (the middleware-chain terminal) set request._nodeRequest.user when\nan authenticated request hit no route, to hand auth to a Node fallback server.\n_nodeRequest is null for both BunRequest and UwsRequest, so an authenticated\nrequest to an unmatched route threw \"Cannot set properties of null (setting\n'user')\" -> 500. Latent on the Bun path; surfaced by the live uWS-UDS bench.\n\nGuard on _nodeRequest: the handoff only applies to the Node fallback path; the\nBun/uWS adapters have no Node fallback server. With this, the uWS UDS path\nreturns 404 like Node. Verified on a live booted Harper.\n\n* fix(#914): harden uWS UDS adapter for production + add adapter unit test\n\nGraduates the uWS-behind-symphony spike toward landing by fixing the\ncorrectness issues surfaced in review and adding a regression suite.\n\n- Request body corruption (critical): Buffer.from(arrayBuffer) aliased\n  uWS's receive buffer, which is neutered/reused once the onData callback\n  returns while the body is read asynchronously in the handler. Multi-chunk\n  POST/PUT bodies came back truncated/corrupt. Copy the bytes out\n  synchronously via Buffer.from(new Uint8Array(chunk)).\n- Duplicate request headers were clobbered (headers[k] = v, last wins);\n  accumulate repeats into an array like the Node path.\n- Empty reason phrase for uncommon status codes (\"429 \"); derive the\n  status line from node:http STATUS_CODES with an \"Unknown\" fallback.\n- Route by method rather than a single app.any(hasBody:true) so bodyless\n  methods dispatch immediately and unknown methods can't stall a connection.\n- Collapse of streaming/iterable response bodies now bails when the client\n  disconnects (thread the request AbortSignal into uwsBodyToBuffer).\n- Refresh the stale adapter header comment (wiring is done).\n\nAdds unitTests/server/serverHelpers/uwsServer.test.js: exercises GET,\nbodyless OPTIONS, multi-chunk POST round-trip (guards the aliasing bug),\nduplicate headers, 404, thrown->500, and reason-phrase serialization over\na real UDS. Skips gracefully when the uWebSockets.js optional dep is absent.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of uWS UDS adapter\n\nFollow-up to the adapter hardening, resolving issues surfaced by the\ncross-model review (Codex + Gemini + Harper-domain adjudication).\n\n- WHATWG Response return path (significant): makeUwsHandler mutated\n  response.status/response.body, which throws for a handler that returns a\n  standard Response (read-only accessors) — a divergence from the Node/Bun\n  paths, which build a fresh descriptor. Return a new descriptor instead of\n  mutating the chain's result.\n- Write-method throttling was dropped on the uWS UDS mirror: the Node UDS\n  path routes non-GET/OPTIONS/HEAD through the request-queue throttle (503 on\n  overflow), the uWS path bypassed it. Restore parity via throttle() so\n  data-modifying bursts shed instead of saturating a worker.\n- QUERY (and other non-standard body-bearing methods) had their body\n  silently dropped: the per-method routing sent the any() fallback down the\n  bodyless path. Route known-bodyless methods explicitly and treat the\n  fallback as body-bearing (uWS still fires onData(len=0) for bodyless).\n- Shutdown shim entered the Node keep-alive drain loop and force-exited\n  noisily every shutdown (uWS close() takes no callback): wrap close() to\n  invoke the callback and omit closeIdleConnections so the drain is skipped.\n- UwsRequestBody now extends Readable, matching the RequestBody/BunRequestBody\n  contract (for-await async iteration + destroy(), not a duck-typed subset).\n- Tidy: remove abort listener on the stream-error path in uwsBodyToBuffer,\n  drop the unused AbortController param from writeResponse, add the\n  uWebSockets.js optionalDependency to package-lock.json.\n\nAdds QUERY-body-routing and 413-over-limit tests; suite now 9 green.\nThe WHATWG-Response, throttle, and shutdown-teardown paths live above the\nadapter unit boundary — flagged for the integration bench in the PR.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* feat(#914): plaintext uWS-over-HTTP path + full streaming responses\n\nExtends the uWS adapter beyond the symphony-UDS mirror toward a fully\ncapable HTTP backend.\n\nPlaintext TCP path (HARPER_UWS_HTTP):\n- createUwsServer now accepts a `port`/`host` (app.listen, SO_REUSEPORT by\n  default) in addition to `socketPath`, so uWS can back a non-secure HTTP\n  TCP port directly — not just the UDS mirror.\n- getHTTPServer registers a uWS TCP config (and skips the Node server) for\n  non-secure app HTTP ports when HARPER_UWS_HTTP is set; threadServer's\n  start loop is generalized to UDS- or port-keyed configs.\n- This is the flag used to run the integration suite through uWS: a\n  representative slice passes 45/45 (REST/SQL, data types, dates, arrays,\n  binary/Brotli blob responses byte-exact, Content-Encoding, caching).\n\nStreaming responses:\n- normalizeUwsBody (was uwsBodyToBuffer) now passes Node streams and\n  async-iterables through as a Readable instead of buffering — buffering an\n  SSE/event-stream body never returns.\n- writeResponse streams a Readable body to uWS with real backpressure\n  (res.write + res.onWritable pause/resume) and omits Content-Length so uWS\n  uses chunked encoding. uWS only flushes headers on the first body write,\n  so text/event-stream responses emit a spec-valid ':\\n\\n' comment to open\n  the stream immediately (fixes SSE \"headers never flushed\"). Client abort\n  or a source error destroys the source and stops writing.\n- Verified: MCP SSE integration test passes 4/4 (headers flushed up front);\n  3 new adapter unit tests cover SSE, a plain Readable, and a 4 MiB\n  backpressure stream. Suite now 12 green.\n\nRemaining: WebSocket upgrade (MQTT-over-WS/subscriptions) — next.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* feat(#914): WebSocket upgrade support on the uWS path\n\nCompletes uWS as a full HTTP+WS backend. uWS owns its sockets, so WS can't\nbe delegated to the ws library's WebSocketServer; instead the adapter uses\nuWS's native app.ws() and bridges each connection to a ws-library-shaped\nobject that Harper's existing websocket chain consumes unchanged.\n\n- UwsWebSocket (server/serverHelpers/uwsServer.ts): adapts a uWS WebSocket\n  to the subset of the ws interface Harper uses — send/close/terminate/ping,\n  'message'/'close' events, readyState, and a _socket shim exposing\n  remoteAddress + backpressure (writableNeedDrain/'drain' via\n  getBufferedAmount + the drain callback). Inbound frames are copied out of\n  uWS's neutered buffer.\n- createUwsServer accepts a wsHandler; when set it registers app.ws('/*')\n  (capturing the upgrade request's url/headers/ip, IPv4-mapped address\n  normalized) alongside the HTTP routes — both coexist on one port.\n- onWebSocket (server/http.ts) detects a uWS-backed port and wires the\n  wsHandler (build a WS UwsRequest, run httpChain auth, invoke\n  websocketChains) instead of the Node ws.WebSocketServer + 'upgrade' event.\n  Previously this crashed under HARPER_UWS_HTTP (\"server.on is not a\n  function\"), failing MQTT component load; also guards a NaN-port config.\n\nValidated through the real harness: MQTT-over-WS passes 11/11 (RS256 JWT\nauth, topic ACLs, pub/sub, $SYS monitoring); SSE 4/4 and HTTP unaffected\n(24/24 combined). 2 new adapter unit tests (HTTP+WS coexistence on one port;\nupgrade + text/binary frame round-trip); suite now 14 green.\n\nWith this, the full integration slice runs over uWS: HTTP, SSE/streaming,\nand WebSocket subscriptions.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of plaintext/streaming/WS uWS work\n\nFindings from the Codex+Gemini+domain review of the streaming/WS commits.\n\n- Client IP on the direct-TCP path (P1, Codex+sweep): the uWS HTTP handler\n  never captured the peer address, so request.ip was '' and local auth\n  (security/auth.ts AUTHORIZE_LOCAL, request.ip.includes('127.0.0.')) failed\n  — anonymous localhost requests got \"Must login\". The integration sweep hit\n  this: early-hints/redirector/risk-query (pass on baseline, \"pass 0\" under\n  the flag). Fix: capture res.getRemoteAddressAsText() for the TCP path\n  (left unset for UDS). AND flip UwsRequest.ip to prefer the real socket\n  address over X-Forwarded-For, so a direct client can't spoof\n  `X-Forwarded-For: 127.0.0.1` to satisfy local auth; XFF is trusted only on\n  the symphony-UDS path (where the socket has no client address).\n- HEAD body (P2, Codex): uWS has no ServerResponse HEAD guard, so a handler\n  returning a body on HEAD would send it. REST already nulls HEAD bodies;\n  enforce it in writeResponse for any other handler.\n- WebSocket maxPayload (P2, Codex): the onWebSocket uWS branch didn't forward\n  options.maxPayload, so a configured smaller WS frame limit wasn't enforced\n  (defaulted to 100 MiB). Thread it through as wsMaxPayload.\n\nGemini's headline \"Buffer.from(new Uint8Array(message)) aliases uWS memory\"\nblocker is a false positive (same conflation as last review): it COPIES —\nproven (survives source neutering) and corroborated by MQTT-over-WS 11/11\nwith async frame processing.\n\nNoted, not fixed (out of scope / parity): GraphQL POST reads _nodeRequest\nwhich is null on uWS AND Bun (pre-existing non-Node-adapter gap, needs a\nbody-based deserialize); a raw Fastify server registered on a uWS-backed\nport could collide in SERVERS (low reachability; MCP Fastify passes).\n\nIntegration sweep: 43/43 pass under HARPER_UWS_HTTP after the IP fix.\nAdapter unit suite now 16 (adds request.ip + HEAD-suppression tests).\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs(#914): refresh uwsServer header (TCP+streaming+WS, not UDS-only)\n\n* fix(#914): deserialize GraphQL POST body via request.body\n\nThe GraphQL POST handler read the body from request._nodeRequest, the raw\nNode IncomingMessage. That is null on the Bun and uWS request adapters, so\nGraphQL POST 500'd off the Node path. Read through request.body instead —\na Readable-compatible body stream on every adapter, matching how REST.ts\nalready deserializes bodies. Verified 24/24 graphql integration tests on\nboth the Node and HARPER_UWS_HTTP paths.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): don't let raw-Fastify listeners collide with the uWS HTTP port\n\nUnder HARPER_UWS_HTTP the app port is backed by uWebSockets.js and getHTTPServer\nearly-returns a { uws: true } marker before it would have called\nregisterServer(server, port). SERVERS[port] therefore stays empty. If a legacy\nFastify-routes app is then deployed, fastifyRoutes registers its raw http.Server\nvia server.http(fastify.server); with the port looking unused, registerServer set\nSERVERS[port] = fastifyServer and threadServer bound a Node http server competing\nwith uWS on the same TCP port (Codex P2).\n\nMirror the Bun path: divert non-function listeners on a uWS-backed port into the\nfallback map instead of registerServer(), so nothing lands in SERVERS to double\n-bind. Renamed bunFallbackServers -> fallbackServers since the map is now shared\nby both non-Node backends. Request-time delegation to this fallback is not yet\nwired on the uWS handler, so raw-Fastify routes are unreachable (clean, not a\ncompeting bind) under this flag - an accepted limitation of the bench vehicle,\nnoted for a parity follow-up.\n\nVerified: components.test.mjs (deploys a Fastify-routes component) 25/25 on both\nthe Node and HARPER_UWS_HTTP paths, with the Fastify registration diverting\ncleanly and no bind collision.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* feat(#914): delegate to the Fastify fallback from the uWS HTTP path\n\nCompletes the raw-Fastify story on HARPER_UWS_HTTP. Previously a legacy\ncustom-function route (server.http(fastify.server)) was diverted to the fallback\nmap to avoid a competing bind, but the uWS handler had no way to reach it, so the\nroute 404'd. Now, when the chain doesn't handle a request (status === -1) and a\nFastify instance is registered for the port, the uWS handler delegates via\nfastify.inject() — its internal router, no socket — mirroring the Bun path,\nincluding SSE streaming and the AUTHORIZE_LOCAL pre-auth user forward.\n\n- Extracted the shared inject core into injectToFastify() and routed both the Bun\n  and uWS delegation paths through it (strip forged pre-auth header, forward\n  resolved user when no Authorization, payloadAsStream for SSE).\n- fastifyRoutes now registers its app instance for the http port(s); it only ever\n  registered the http.Server, so neither Bun nor uWS could delegate to legacy\n  routes. Renamed bunFastifyInstances -> fastifyInstances /\n  registerBunFastifyInstance -> registerFastifyInstance (shared, not Bun-only).\n- UwsRequest exposes rawBody for the inject payload.\n\nVerified: fastifyRoutes-test.mjs (GET /testApp/ping -> 'pong' + REST on the same\ncomponent) passes on BOTH the Node and HARPER_UWS_HTTP paths; under uWS the route\nis served purely via inject-delegation. graphql 24/24, components 25/25,\nmcp/sse-listchanged 4/4 under the flag; 16 uWS unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): run the full integration suite under HARPER_UWS_HTTP\n\nAdds a run-integration-tests-uws job mirroring the existing Bun variant: the same\n6-shard test:integration:all on Node 24, but with HARPER_UWS_HTTP=1 so the\nplaintext app HTTP port(s) are served by uWebSockets.js. Secure/replication/ops\npaths keep running on Node, so this gives continuous coverage of the uWS\nrequest/streaming/WS/GraphQL/Fastify-fallback path across the whole suite instead\nof relying on a manual local flag.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): make the uWS integration job informational (non-blocking)\n\nThe first full-suite run under HARPER_UWS_HTTP surfaced two known uWS-path gaps\n(Bun and Node are green on the same tests):\n  - static-file serving via `send` never flushes headers on the uWS response\n    (client HeadersTimeout) — the deploy/static-access tests hang;\n  - multiple Set-Cookie headers collapse to one (the WHATWG Headers comma-join\n    limitation Harper-on-Bun already skips).\nNeither is a regression from the Fastify-delegation work. Mark the job\ncontinue-on-error so it reports the per-shard uWS signal without gating merges;\nremove once the gaps are closed.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): serve static files (send SendStream) on the uWS HTTP path\n\nStatic handlers return a `send` SendStream, which only begins work when piped to\na Node ServerResponse and writes its own headers there. The uWS path has no such\nobject: it treated the stream as a plain Readable and attached .on('data') (which\nnever starts a SendStream), and uWS only flushes status/headers on the first body\nwrite — so static responses hung and the client saw a HeadersTimeout. This is why\nevery deploy+access integration test (deployed apps serve a static site) timed out\nunder the flag.\n\nPipe the SendStream into a Writable shim that captures the headers it writes\n(setHeader/writeHead) onto the response Headers and buffers the file, mirroring the\nBun fetchHandler's SendStream path (incl. finished:false so on-finished doesn't\ntear down early). Gated on handlesHeaders, which only static.ts sets, so real\nstreaming/SSE bodies keep streaming through normalizeUwsBody.\n\nVerified: deploy/deploy-from-source.test.ts (deploys an app with a web/ static\nsite, polls the static index, asserts the served HTML) now passes 4/4 under\nHARPER_UWS_HTTP — previously deploy+access both hung ~300s.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): preserve multiple Set-Cookie headers on the uWS HTTP path\n\nA WHATWG Headers comma-joins Set-Cookie when iterated, which merges multiple\ncookies into one and corrupts values containing commas (e.g. `expires=` dates).\nThe uWS response path iterated the headers directly (and writeResponse converted a\nWHATWG Headers via `new Headers()`, comma-joining before serialization), so a\nresponse setting N cookies reached the client as 1.\n\n- writeHeaders now emits Set-Cookie individually via getSetCookie() when present\n  (WHATWG), skipping the joined entry; a Harper Headers stores them as an array,\n  already handled by the array branch.\n- writeResponse keeps an existing Headers-like object (Harper or WHATWG) as-is\n  instead of round-tripping a WHATWG Headers through `new Headers()` (which would\n  comma-join before writeHeaders could split it), wrapping only plain objects.\n- the Fastify-delegation path keeps Set-Cookie multi-valued instead of comma-\n  joining inject()'s array.\n\nThis is the multi-Set-Cookie limitation Harper-on-Bun documents and skips; uWS now\nhandles it correctly. Verified: headers.test.mjs 2/2 under HARPER_UWS_HTTP (was\n0/2); graphql/components/mcp-sse/deploy-from-source/fastifyRoutes all green under\nthe flag; 16 uWS unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): gate on the uWS integration job (full suite now green)\n\nThe full test:integration:all suite passes on all 6 shards under HARPER_UWS_HTTP\n(CI run 28724670219) now that the static-`send` and multiple-Set-Cookie gaps are\nfixed, so the job no longer needs continue-on-error — make it a required check\nalongside the Node and Bun variants.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of the uWS Fastify/static/header work\n\nCross-model review (Codex + Gemini + Harper-domain adjudication) of the new uWS\nwork. Both outside-model legs led with false positives (request.headers.asObject\n'undefined' → auth bypass, and Set-Cookie comma-coercion) — both refuted: headers\nis a RequestHeaders with a real .asObject used across the REST path, and the uWS\nHeaders is Harper's Map-based class that preserves Set-Cookie arrays. The\nINTERNAL_USER_HEADER pre-auth forward was probed and is spoof-safe (client-supplied\nheader is stripped before the user is re-added). Real items addressed:\n\n- bufferSendStream no longer swallows send's status: capture statusCode / writeHead\n  status and return it, so a 304 (conditional GET) or 206/416 (Range) is honored\n  instead of flattened to 200. (End-to-end 304/Range is still gated upstream by\n  send not reading Harper's RequestHeaders — a pre-existing limitation on all\n  backends incl. Node, verified by probe; left as a separate follow-up.)\n- avoid re-copying already-Buffer chunks when draining a delegated Fastify response.\n- document the lowercased-'authorization' contract in injectToFastify.\n- refresh the fallback-divert comment: request-time delegation IS now wired, and\n  the { uws: true } marker is guaranteed set by the getServer(port) call above.\n\nRegression under HARPER_UWS_HTTP: deploy-from-source 4/4 (static), headers 2/2\n(Set-Cookie), fastifyRoutes 2/2 (delegation), 16 uWS unit tests.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* feat(#914): stream uWS request bodies + address review comments\n\nFeed the uWS request body into a push-based Readable and dispatch the\nhandler on headers instead of buffering the whole body and dispatching on\nthe last chunk. streamToBuffer (contentTypes.ts) already owns\nconcatenation and the HTTP_MAXREQUESTBODYSIZE limit and is the entry point\nfor the upcoming streaming deserializers, so the adapter no longer\nconcatenates (drops the O(n^2) Buffer.concat) or enforces its own body\nlimit; maxBodyBytes is demoted to a coarse socket-level DoS ceiling since\nuWS offers no inbound backpressure. The Fastify-delegation path passes the\nbody stream to inject() (light-my-request consumes it), so rawBody is gone.\n\nAlso address review feedback:\n- use when() so a synchronous handler stays synchronous (no extra promise)\n- rename logBunRequest -> logHttpRequest (shared Bun/uWS path)\n- correct the stale \"WebSocket upgrades are not yet wired\" comment\n- reword the SPIKE/spike comments now that this is graduating\n- document uWebSockets.js in dependencies.md\n\nAdds a test asserting the handler is dispatched before the request body\nends (proves streaming, not full buffering).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(uws): guard 413 write against completed response + test XFF spoofing defense (#914)\n\nAddress cb1kenobi PR review:\n- Track responseCompleted in onRequest and guard all three response-write\n  sites (handler result, error, 413). The handler can respond (or start\n  streaming) without consuming the body; a later over-limit 413 would then\n  write to an already-completed uWS response and abort the process.\n- Add unit tests for request.ip trust boundary: a spoofed X-Forwarded-For\n  must not override the authoritative TCP peer address, while the UDS path\n  (no socket peer) still honors the trusted proxy's XFF.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: sync package-lock with merged package.json (prettier 3.9.5, globals 17.7.0, aws-sdk lib-storage 3.1076.0)\n\nThe npm-merge-driver left the lock resolved to the branch's older\nversions while package.json took main's bumps, breaking npm ci.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* style: reformat uwsServer.ts per prettier 3.9.5 (trailing comment placement)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.7 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kris@harperdb.io>",
          "timestamp": "2026-07-10T05:51:34Z",
          "url": "https://github.com/HarperFast/harper/commit/bd1dce0b1bbb91aeea15e5380f5b98e311f631a8"
        },
        "date": 1783671820238,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6013.36,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8478.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8530.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6674.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4777.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8375.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1048.51,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "f55de88a610e53cef28f06c99735a4d21417c72d",
          "message": "feat(server): surface external port conflicts on all platforms; single-worker default without SO_REUSEPORT (#1605)\n\n* feat(server): surface external port conflicts on all platforms; single-worker default without SO_REUSEPORT\n\nlistenOnPorts() used to swallow every EADDRINUSE (a workaround for a Node\n<20.11.1 reusePort bug now outside Harper's supported range), hiding real\nexternal squatters: an unrelated process holding e.g. the MQTT port silently\nreceived Harper's traffic with no error anywhere (original symptom: a second\nHarper instance on 8883).\n\nEvery EADDRINUSE with an in-process explanation is now structurally ruled out,\nso the remaining ones are logged loudly (port + owning component + error):\n- reusePort listeners (Linux): siblings share the port and never collide, even\n  across overlapping restarts — any EADDRINUSE is external.\n- Main thread (HTTP/operations ports): binds before any worker, never restarts —\n  any EADDRINUSE is external.\n- Dedicated listeners (onSocket, e.g. MQTT — never bound by the main thread):\n  when exclusive (macOS/Windows), bound only by a single owner worker (lowest\n  eligible index) instead of every worker racing; combined with non-overlapping\n  restarts (below), the owner's EADDRINUSE is external.\nThe one remaining benign case — a worker's exclusive HTTP bind losing to the\nmain thread on macOS/Windows — stays silently swallowed. All cases still\nresolve so a squatted port never stalls boot.\n\nrestartWorkers() no longer pre-starts replacement HTTP workers on macOS\n(canPreStartReplacement now excludes darwin, like Windows/Bun): without working\nSO_REUSEPORT the replacement could never bind ports the old worker still held —\nits EADDRINUSE was swallowed and worker-owned listeners like MQTT were left\npermanently unbound after every component-reload restart. The main thread keeps\nserving the HTTP ports throughout, so only worker-owned listeners see the brief\nshutdown-first gap.\n\nthreads.count now defaults to 1 on macOS/Windows (setDefaultThreads): without\nSO_REUSEPORT, additional HTTP workers can never share the server ports, so the\nCPU-based default just spawned workers that serve no direct TCP traffic. An\nexplicit threads.count still overrides.\n\nAdds an integration test that squats the MQTT secure port before boot and\nasserts the conflict is logged and Harper still starts — on every platform.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(lint): use node:assert not node:assert/strict in external-port-conflict test\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-10T22:22:00Z",
          "url": "https://github.com/HarperFast/harper/commit/f55de88a610e53cef28f06c99735a4d21417c72d"
        },
        "date": 1783755718598,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 10836.26,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 18140.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 18261.96,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 12354.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 9167.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 16919.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2020.27,
            "unit": "ops/sec"
          }
        ]
      }
    ],
    "YCSB Latency p99 (single-node)": [
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "6fc63072c0d4321b8905e4ea6f92f711172b6d23",
          "message": "fix(ci): add registry-url to setup-node in publish-harper-npm-package job\n\nWithout registry-url, setup-node does not write an .npmrc with the auth\ntoken, causing ENEEDAUTH on npm publish despite NODE_AUTH_TOKEN being set.\nThe harperfast job had this correct; the harper job was missing it.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>",
          "timestamp": "2026-06-02T21:17:06Z",
          "url": "https://github.com/HarperFast/harper/commit/6fc63072c0d4321b8905e4ea6f92f711172b6d23"
        },
        "date": 1780476820082,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.49,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.97,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.61,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.95,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.12,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.14,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.57,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.74,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.52,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 154.68,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "caeb66683673f6850c70df55222e4d6deda28a50",
          "message": "Merge pull request #1118 from HarperFast/chore/bump-ai-review-prompts-2be0f70\n\nci: bump ai-review-prompts pin to 2be0f70",
          "timestamp": "2026-06-03T19:52:04Z",
          "url": "https://github.com/HarperFast/harper/commit/caeb66683673f6850c70df55222e4d6deda28a50"
        },
        "date": 1780562704889,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.39,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.63,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.65,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.07,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.47,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.44,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.48,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.26,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.05,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.61,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 177.8,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "chris nelson",
            "email": "chris.nelson@harperdb.io"
          },
          "committer": {
            "name": "chris nelson",
            "username": "sleekmountaincat",
            "email": "sleekmountaincat@gmail.com"
          },
          "id": "266d5d8ba425b77d80692637e605a7c6f9e82d23",
          "message": "fix(upgrade): run upgrade directives without interactive confirmation\n\nA directive-driven upgrade runs on the normal `harper run` startup path, where\nthe upgrade-confirmation prompt (forceUpdatePrompt) blocked on stdin — or, with\nno TTY, defaulted to \"no\" and refused to start — breaking unattended/scripted\nstarts (systemd, containers, CI). `upgrade()` only ever runs when an upgrade\ndirective applies (getVersionUpdateInfo returns an object solely when\nhasUpgradesRequired is true), so this prompt was exclusively a directive-upgrade\ngate. Remove it; directives now run automatically with a non-blocking notice\nthat keeps the release-notes link. Downgrades still confirm (forceDowngradePrompt).\n\n- bin/upgrade.js: drop the forceUpdatePrompt gate + cancel/exit branch.\n- upgrade/upgradePrompt.ts: remove the now-unused forceUpdatePrompt.\n- unitTests/bin/upgrade.test.js: remove the obsolete (skipped) upgrade() prompt\n  tests + the vars/imports they owned; runUpgrade() tests unchanged.\n- integrationTests/upgrade/4.x-upgrade.test.ts: revert the CONFIRM_UPGRADE=yes\n  workaround now that startup no longer prompts.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T04:23:38Z",
          "url": "https://github.com/HarperFast/harper/commit/266d5d8ba425b77d80692637e605a7c6f9e82d23"
        },
        "date": 1780648774346,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.41,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.72,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.63,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.02,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.6,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.56,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.95,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.05,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.42,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 194.35,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 37.49,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780733608484,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.18,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.12,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.31,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.51,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.44,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.67,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.29,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.2,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.34,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.64,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 212.72,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780820672957,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 12.38,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.7,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 14.04,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.85,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 13.67,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 28.9,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 12.12,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 15.93,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 147.81,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 42.51,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "986943d746d9d19f245dbc520355776d2b95dceb",
          "message": "fix(replay): contain rocksdb-js corrupt-entry throws to a single log\n\nrocksdb-js@1.4.2's hardened transaction-log reader throws a bounded\nRangeError (\"Corrupt transaction log entry … declared length …\noverruns the log\") when an entry's length header overshoots the\ncommitted bound — a real condition after a SIGKILL-induced torn\nwrite. That throw originates inside the per-log iterator's next(),\nupstream of the .map() callback's per-entry try/catch, so it escaped\nthrough the aggregate iterator and landed as an uncaughtException\ninside notifyFromTransactionData (scheduled via setImmediate),\ncrashing the worker on every commit. Integration Tests shard 2\n(replay-stress) failed on every platform on main after the 1.4.2\nbump.\n\n- RocksTransactionLogStore.getRange: wrap each iterators[i].next()\n  call at the aggregate boundary in a safeNext() that logs once,\n  marks the iterator failed (WeakSet), and returns done. Subsequent\n  retry-polls skip the failed iterator, so a single corrupt log\n  doesn't spam errors or burn CPU on every commit. Other peer logs\n  keep draining.\n\n- transactionBroadcast.notifyFromTransactionData: defense-in-depth\n  try/catch around iterator.next() — a setImmediate-scheduled\n  consumer should never be a one-line patch away from an\n  uncaughtException that kills the worker.\n\n- Unit test asserting (a) iteration completes without throwing,\n  (b) good entries before the throw drain, (c) healthy peer logs\n  continue, (d) the failed iterator is not re-polled on later\n  drain cycles.\n\nRefs HarperFast/rocksdb-js#612 (the read-side hardening that\nexposed this).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>",
          "timestamp": "2026-06-04T03:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/986943d746d9d19f245dbc520355776d2b95dceb"
        },
        "date": 1780908789981,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.07,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.03,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.78,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.7,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.17,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.56,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.47,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.69,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 205.82,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.2,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "chris nelson",
            "email": "chris.nelson@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "88c94e67e9a1d33562776d160d3dc3b4833616d5",
          "message": "fix(indexing): yield the event loop during a synchronous custom-index backfill\n\nA custom index (HNSW vector index) indexes synchronously: in runIndexing's\nper-row loop, index.customIndex.index() runs inline and returns void, so it\nnever assigns lastResolution and never raises `outstanding`. The existing\nyield is gated on `outstanding > MIN_OUTSTANDING_INDEXING`, so for a\ncustom-index backfill it never fires — the entire backfill over the populated\nrows runs in a single event-loop turn, freezing the worker's main thread for\nthe whole build (starving replication keepalive, the operations API, and\nschema signalling, and never letting isIndexing be observed; vector search\nreturns 503 the entire time).\n\nTrack whether a row performed synchronous custom-index work and yield once per\nsuch row when the outstanding-based yields don't apply.\n\nValidated on a live 5.1.0-beta.1 instance with a 100ms main-thread heartbeat\nover an identical 2,000-row int8 HNSW backfill (clean A/B, same box/data):\n  before: max event-loop stall 71,030 ms (frozen for the entire 71.2s build)\n  after:  max event-loop stall    166 ms; build 67.5s (no measurable throughput cost)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-05T19:48:12Z",
          "url": "https://github.com/HarperFast/harper/commit/88c94e67e9a1d33562776d160d3dc3b4833616d5"
        },
        "date": 1780993824173,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.32,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.04,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.08,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.27,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.16,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.47,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.71,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.99,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.61,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 187.87,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.9,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "7845a096ece532e116275d23033bbd48c6bd2bf0",
          "message": "Merge pull request #1217 from HarperFast/feat/config-union-directive\n\nfeat(config): add `$union` array directive for config env vars",
          "timestamp": "2026-06-10T04:21:59Z",
          "url": "https://github.com/HarperFast/harper/commit/7845a096ece532e116275d23033bbd48c6bd2bf0"
        },
        "date": 1781080836023,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.81,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.68,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.44,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.77,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.59,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.39,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.78,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.93,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.94,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 40.32,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 187.93,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781338937254,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.09,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.6,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.42,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.51,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.62,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.56,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.5,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.98,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.3,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 174.74,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.74,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781426289184,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.51,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.36,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.64,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.48,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.65,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.85,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.71,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.01,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.28,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 50.72,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 157.06,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "001bf7b9c55963f7dcd938087acd0047d19b8a62",
          "message": "chore: bump version to 5.1.0",
          "timestamp": "2026-06-13T00:11:08Z",
          "url": "https://github.com/HarperFast/harper/commit/001bf7b9c55963f7dcd938087acd0047d19b8a62"
        },
        "date": 1781515367355,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.23,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.42,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.36,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.21,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.13,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.55,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.1,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.8,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.88,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 144.45,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "71d629c4fe5938b1393054cb933738992c7ad2bd",
          "message": "5.1.2",
          "timestamp": "2026-06-16T05:02:27Z",
          "url": "https://github.com/HarperFast/harper/commit/71d629c4fe5938b1393054cb933738992c7ad2bd"
        },
        "date": 1781601181303,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.18,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.71,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.3,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.67,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.81,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.94,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.86,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.55,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.68,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 190.52,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 40.64,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "2de38eac8877cd4e58c8f4b2263ae4fe2dd69fa9",
          "message": "5.1.3",
          "timestamp": "2026-06-16T22:22:27Z",
          "url": "https://github.com/HarperFast/harper/commit/2de38eac8877cd4e58c8f4b2263ae4fe2dd69fa9"
        },
        "date": 1781686724435,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 13.97,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.09,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.19,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 15.95,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 20.73,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.29,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.7,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.64,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 16.96,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.18,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 150.82,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kyle Bernhardy",
            "username": "kylebernhardy",
            "email": "kyle@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "1b65d7dadfa43f4bc942249d53ecca74f82d8d0f",
          "message": "feat(mcp): implement ping + logging/setLevel + notifications/message (#1350)\n\n* feat(mcp): implement ping + logging/setLevel + notifications/message\n\nThe MCP server advertised the `logging` capability but `logging/setLevel`\nreturned -32601, and `ping` (a base-protocol utility) was unanswered. Both are\nnow implemented, reconciling the advertised capability with real behavior.\n\n- ping: returns an empty result. Routed after session validation so a stale /\n  expired / wrong-user session surfaces the normal 404/403 rather than being\n  masked by an unconditional success; a ping notification gets the standard 202.\n- logging/setLevel: validates an RFC 5424 level and stores it. The level is\n  persisted on the durable session record (system.mcp_session) so it survives an\n  SSE reconnect, is order-independent of GET-stream open, and expires with the\n  session TTL — no separate cache to leak. The live SSE record is seeded from it\n  on (re)connect and updated in place on setLevel.\n- notifications/message: new logging.ts emitter delivers to a session over its\n  SSE channel, filtered by the session's level (no messages before setLevel).\n  Deliberately scoped to MCP-layer events — NOT the global harperLogger stream,\n  which has no subscription hook and is process-wide/cross-worker (forwarding it\n  would be a data leak + firehose). One call site wired: tools/call rate-limit\n  rejections emit a `notice`.\n\nKnown limitation (consistent with the existing listChanged channel): server\npush is per-worker in v1, so a setLevel POST handled on a different worker than\nthe session's SSE stream takes effect on that stream only at the next reconnect.\nCross-worker push is a subsystem-wide design item tracked in the MCP design-doc\nissue.\n\nUnit tests: logging level taxonomy + per-session filtering + profile fan-out;\ntransport ping (valid/invalid-session/notification) and setLevel (valid, -32602,\npersistence, reconnect seeding).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor(mcp): harden log-level admission + simplify live-record seeding\n\nAddress Gemini review on the logging PR:\n- admits(): reject an unrecognized level instead of defaulting its rank to 0\n  (which could slip past a 'debug' minimum). Both ranks must resolve.\n- handleGet: assign session.logLevel directly (a fresh record's level is\n  already undefined), dropping the redundant guard.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(mcp): adopt touchSession's return so per-request saves keep fresh lastActivity\n\nhandlePost called `await touchSession(session)` but discarded the returned copy\n(which carries the new lastActivity), leaving the local `session` stale. Any\nlater save in the same request then rolled lastActivity back to the load-time\nvalue — pre-existing for `notifications/initialized` (handleInitialized) and now\nalso `logging/setLevel` (dispatchSetLevel) added in this PR.\n\nReassign `session = await touchSession(session)` so every downstream save\npersists the current activity time. Regression test forces a stale lastActivity\nand asserts setLevel advances rather than rolls it back. (TTL is unaffected\neither way — it keys off the record's put timestamp — but the field is now\naccurate.)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-18T03:15:33Z",
          "url": "https://github.com/HarperFast/harper/commit/1b65d7dadfa43f4bc942249d53ecca74f82d8d0f"
        },
        "date": 1781772283880,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 11.29,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 10.58,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 15.99,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 12.79,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 17.27,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 12.3,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 25.15,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.19,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 14.84,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 40.95,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 121.18,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d6a8ca8beec08459f8802c19979aab66062520ec",
          "message": "Release v5.1.5",
          "timestamp": "2026-06-18T18:56:04Z",
          "url": "https://github.com/HarperFast/harper/commit/d6a8ca8beec08459f8802c19979aab66062520ec"
        },
        "date": 1781859663394,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.06,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.09,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.88,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.09,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 20.55,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.29,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.65,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.22,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 16.28,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.78,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 149.45,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "06e79bcb268be2ee22d054c50e3b716fac87e496",
          "message": "docs(AGENTS): prefer plain assert over node:assert/strict\n\nnode:assert/strict is a dumpster fire and terrible — its deep-equality and\ncoercion semantics cause more friction and surprising failures than they\nprevent. Drop the strict requirement from the test-style guidance and\nencourage plain `assert` (the house style) instead. The sinon/rewire\nprohibition is unchanged.\n\nPer Kris.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-19T17:19:32Z",
          "url": "https://github.com/HarperFast/harper/commit/06e79bcb268be2ee22d054c50e3b716fac87e496"
        },
        "date": 1781943953876,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.81,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.37,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.38,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.6,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.27,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.73,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.38,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.94,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.18,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 166.72,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 47.93,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d0d04ebce7436180219d5d045f490a84b68b6ab4",
          "message": "chore(deps): bump @harperfast/integration-testing to ^0.6.2\n\nPicks up the loopback conflict-canary HTTP-port fix (integration-testing#20):\nthe canary now probes both the operations port AND the HTTP port, detecting a\nlingering Harper worker (main thread exited, HTTP workers still bound via\nSO_REUSEPORT) before recycling its loopback address — fixing the ECONNREFUSED\nshard-contamination seen under CI sharding.\n\n0.5.2 -> 0.6.2 has no breaking API changes: the only runtime deltas are\n'fix: Prevent global state smashing' (0.5.4) and the canary (0.6.2); the 0.6.0\nminor is purely the semantic-release CI automation feat, not an API change.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-20T22:26:51Z",
          "url": "https://github.com/HarperFast/harper/commit/d0d04ebce7436180219d5d045f490a84b68b6ab4"
        },
        "date": 1782031595784,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.35,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.88,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.36,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.75,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.51,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.2,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.11,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.08,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 16.73,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 157.54,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.92,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "d0d04ebce7436180219d5d045f490a84b68b6ab4",
          "message": "chore(deps): bump @harperfast/integration-testing to ^0.6.2\n\nPicks up the loopback conflict-canary HTTP-port fix (integration-testing#20):\nthe canary now probes both the operations port AND the HTTP port, detecting a\nlingering Harper worker (main thread exited, HTTP workers still bound via\nSO_REUSEPORT) before recycling its loopback address — fixing the ECONNREFUSED\nshard-contamination seen under CI sharding.\n\n0.5.2 -> 0.6.2 has no breaking API changes: the only runtime deltas are\n'fix: Prevent global state smashing' (0.5.4) and the canary (0.6.2); the 0.6.0\nminor is purely the semantic-release CI automation feat, not an API change.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-20T22:26:51Z",
          "url": "https://github.com/HarperFast/harper/commit/d0d04ebce7436180219d5d045f490a84b68b6ab4"
        },
        "date": 1782119937545,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.64,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.22,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.8,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.01,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.6,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.31,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.69,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.84,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.33,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.78,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 190.94,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "79b532c2c6188e8ada7bcf547e6ee21a1e4587bd",
          "message": "Clarify upgrade migration log: show the data→software transition and migration purpose (#1452)\n\n* Clarify upgrade migration log: show the data→software transition and migration purpose\n\nThe upgrade runner logged `Running upgrade for version <X>` where <X> is the\nversion that *introduced* a migration directive, not the software version being\ninstalled. With only the 5.1.0 directive registered, that line prints \"5.1.0\"\nfor any upgrade crossing it (e.g. while installing 5.1.7), which reads like a\ndowngrade and says nothing about what the migration does.\n\nLog a header with the real data → software transition and the migration count,\nand frame each migration as \"Applying migration N of M (introduced in <version>)\n— <description>\". Adds an optional `description` field to the directive object\n(set on the 5.1.0 directive). Log/notify text only — no change to upgrade logic.\n\nRefs #1451\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(upgrade): drop sinon/chai; extract pure log formatters for node:assert/strict tests\n\nAddresses the automated review on #1452. AGENTS.md prohibits new uses of sinon/\nrewire and targets node:assert/strict against real modules; the new test file had\nbootstrapped sinon + chai.\n\nExtract the log-string construction into two pure exported functions\n(formatUpgradeHeader, formatMigrationLine) and test them directly with\nnode:assert/strict — no stubbing, no sinon, no chai. processDirectives now calls\nthe helpers. Also widens coverage (pluralization, the no-description branch).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-22T23:47:17Z",
          "url": "https://github.com/HarperFast/harper/commit/79b532c2c6188e8ada7bcf547e6ee21a1e4587bd"
        },
        "date": 1782203111558,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.18,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.32,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.63,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.14,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.72,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.45,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.79,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 16.98,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.1,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 139.63,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "541a3d33d787acb1d6b338714110ca4a6dcd8107",
          "message": "Release v5.1.11",
          "timestamp": "2026-06-24T02:09:49Z",
          "url": "https://github.com/HarperFast/harper/commit/541a3d33d787acb1d6b338714110ca4a6dcd8107"
        },
        "date": 1782289362113,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.08,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.21,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.6,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.11,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.08,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.34,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.9,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.1,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.18,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 53.63,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 147.41,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "a0b59b3c0b08f029e3d5860f69eab7ee679a2cb7",
          "message": "chore: drop accidentally committed node_modules symlink\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-23T12:15:28Z",
          "url": "https://github.com/HarperFast/harper/commit/a0b59b3c0b08f029e3d5860f69eab7ee679a2cb7"
        },
        "date": 1782375596540,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 11.91,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.06,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.13,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 13.38,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.98,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 12.81,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 26.19,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.77,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 15.74,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 119.92,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 55.09,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782462544804,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.6,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.22,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.22,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.18,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.19,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.48,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.03,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.24,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.45,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 173.01,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 44.47,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782547749376,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 11.48,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.25,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 15.81,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 13.52,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 13.05,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 27.94,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.13,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 13.49,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 125.42,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 53.25,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Dawson Toth",
            "username": "dawsontoth",
            "email": "dawson@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "572640741bdd980d4c2811fc28674358de455fda",
          "message": "perf(describe): add skip_record_count to skip the per-table count scan (#1498)\n\ndescribe_all/describe_table/describe_schema compute record_count by scanning each\ntable's primary store, which dominates describe latency on large databases and is\npaid serially, per table, by describe_all. Add an opt-in `skip_record_count` flag\nthat omits record_count (and estimated_record_range) so callers needing only schema\nget a fast response; the count can then be fetched separately/asynchronously.\n\nThe cheap O(1) stats (table_size, db_audit_size, last_updated_record) are still\nreturned. The flag is Joi-validated and threaded through describeAll/describeSchema,\nand documented in the MCP operation input schemas.\n\nBackward compatible: omitting the flag preserves today's behavior, and\nvalidateBySchema already allows unknown keys, so older clients/servers are unaffected.\n\nSupports HarperFast/studio#1367.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T04:24:14Z",
          "url": "https://github.com/HarperFast/harper/commit/572640741bdd980d4c2811fc28674358de455fda"
        },
        "date": 1782635034293,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.29,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.8,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.72,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.92,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.15,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.96,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.15,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.21,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.44,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 171.57,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "5f8e4256795cfe86e30d6fe129580788efe62048",
          "message": "style: prettier-format .gemini/config.yaml\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-26T20:08:55Z",
          "url": "https://github.com/HarperFast/harper/commit/5f8e4256795cfe86e30d6fe129580788efe62048"
        },
        "date": 1782723291343,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.27,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.01,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.86,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.14,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.16,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.06,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.65,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.38,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.82,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.4,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 182.95,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Nathan Heskew",
            "username": "heskew",
            "email": "heskew@pm.me"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "deb638f8bd4681f2195385e30766b06d79fdf432",
          "message": "chore(ci): bump ai-review-prompts to 9cf49d2 (calibration #70 + prompt-ref tracking #71) (#1519)\n\n* chore(ci): bump ai-review-prompts to 67d7611 (prompt-ref tracking)\n\nForward bump 1bbc562 -> 67d7611 (ai-review-prompts #71): the log step now\nrecords which prompt version produced each ai-review-log entry — a\n`**Prompt ref:**` body field plus a `prompt:<shortsha>` label — so\ncalibration can attribute verdicts to a specific prompt version instead\nof a date bucket. No prompt-content change vs 1bbc562 (which already\ncarried the #67 calibration + #69 log-count fix); this turns on\nper-version tracking.\n\n`uses:` and `ai-review-prompts-ref:` move in lockstep.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* chore(ci): re-point bump to 9cf49d2 (add #70 week-of-06-22 calibration)\n\n#70 (week-of-06-22 calibration) merged after this bump was opened, so\nre-point 67d7611 -> 9cf49d2 to land the calibration AND the #71 prompt-ref\ntracking together in a single bump rather than forcing a second one.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-06-30T04:45:14Z",
          "url": "https://github.com/HarperFast/harper/commit/deb638f8bd4681f2195385e30766b06d79fdf432"
        },
        "date": 1782808084098,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.49,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.06,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.05,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.18,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.67,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.52,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.96,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.02,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.89,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 165.7,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.45,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "email": "kris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f8368e454c10ac6803cd2e30c50941dd293ea0fd",
          "message": "test(terminology): optional-chain waitFor response to avoid masking server errors\n\nAddresses Gemini review: a non-JSON/empty error body would make res.body.message\nthrow a TypeError (masking the real error and suppressing r.text in the failure).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-06-24T14:16:14Z",
          "url": "https://github.com/HarperFast/harper/commit/f8368e454c10ac6803cd2e30c50941dd293ea0fd"
        },
        "date": 1782895277865,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.98,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.63,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.19,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.04,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.13,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.03,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.02,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.79,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.06,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 47.29,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 163.44,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "1b45db9ea5fecc6cd07c3102f4fd8a5fadb098e4",
          "message": "Merge pull request #1528 from HarperFast/feat/env-secret-encryption\n\nfeat(env): dormant decrypt hook + enc:v1 contract for env-secret encryption",
          "timestamp": "2026-07-01T23:03:37Z",
          "url": "https://github.com/HarperFast/harper/commit/1b45db9ea5fecc6cd07c3102f4fd8a5fadb098e4"
        },
        "date": 1782980190024,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 13.95,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.46,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.09,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.45,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.01,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.64,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.66,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 130.48,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.02,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6dcfbd09b0b55722cf4b3a6a56f9a8a519590335",
          "message": "fix(blob): decompress (inflate) on read instead of re-deflating (#1393)\n\nFileBackedBlob.bytes() called deflate() on the already-compressed on-disk\nbody for DEFLATE_TYPE blobs, double-compressing instead of decompressing,\nand inflate was never imported. The streaming read path had a\n\"TODO: Implement support for decompression\" and likewise returned the raw\ncompressed bytes. Reading any DEFLATE-compressed blob therefore returned\ncorrupt data. Latent today because blob compression (compress?: boolean) is\nexposed but unused/off by default; this makes it correct before it is enabled.\n\n- bytes(): inflate the body for DEFLATE_TYPE; inflate-then-slice so start/end\n  range over the uncompressed content. Completeness for a compressed blob\n  can't be judged from the (uncompressed) header size vs the compressed body\n  length, and the header size is finalized up front when the size is known,\n  so completeness is verified via the writer's existing fileId+\":blob\" lock\n  (new mustVerifyViaLock probe) before inflating. Uncompressed path behavior\n  is preserved (exact size-vs-body comparison).\n- stream(): on detecting DEFLATE_TYPE in the header, delegate to the buffered\n  inflate path and emit a single chunk. Correct-or-safe fallback: a true\n  streaming inflate was left out as too risky given the position-seeking /\n  watcher framing (uncompressed-offset seeking into a deflate stream isn't\n  possible).\n- Tests: compressed round-trip via bytes() and stream(), plus a ranged read.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T16:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/6dcfbd09b0b55722cf4b3a6a56f9a8a519590335"
        },
        "date": 1783066677316,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.48,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.01,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.48,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.06,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.75,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.36,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.79,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.18,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.55,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 178.29,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.41,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "6dcfbd09b0b55722cf4b3a6a56f9a8a519590335",
          "message": "fix(blob): decompress (inflate) on read instead of re-deflating (#1393)\n\nFileBackedBlob.bytes() called deflate() on the already-compressed on-disk\nbody for DEFLATE_TYPE blobs, double-compressing instead of decompressing,\nand inflate was never imported. The streaming read path had a\n\"TODO: Implement support for decompression\" and likewise returned the raw\ncompressed bytes. Reading any DEFLATE-compressed blob therefore returned\ncorrupt data. Latent today because blob compression (compress?: boolean) is\nexposed but unused/off by default; this makes it correct before it is enabled.\n\n- bytes(): inflate the body for DEFLATE_TYPE; inflate-then-slice so start/end\n  range over the uncompressed content. Completeness for a compressed blob\n  can't be judged from the (uncompressed) header size vs the compressed body\n  length, and the header size is finalized up front when the size is known,\n  so completeness is verified via the writer's existing fileId+\":blob\" lock\n  (new mustVerifyViaLock probe) before inflating. Uncompressed path behavior\n  is preserved (exact size-vs-body comparison).\n- stream(): on detecting DEFLATE_TYPE in the header, delegate to the buffered\n  inflate path and emit a single chunk. Correct-or-safe fallback: a true\n  streaming inflate was left out as too risky given the position-seeking /\n  watcher framing (uncompressed-offset seeking into a deflate stream isn't\n  possible).\n- Tests: compressed round-trip via bytes() and stream(), plus a ranged read.\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>",
          "timestamp": "2026-07-02T16:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/6dcfbd09b0b55722cf4b3a6a56f9a8a519590335"
        },
        "date": 1783152809472,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.35,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.08,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.51,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.62,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.48,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.85,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.75,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.45,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 166.85,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.37,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "228eacc0fb41dd521b4d990a46533ecaccd6c3f3",
          "message": "fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test (#1476)\n\n* fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test\n\nWhen `restart_service http_workers` tears a worker down mid-backfill, runIndexing's\nrange scan/puts throw against the closing store (\"Database not open\"). The old catch\nlogged a misleading error and then tried to persist `indexingFailed` against the\nalready-closed store, which also failed (\"Failed to persist indexing failure state\").\nTreat a store closed by shutdown (`primaryStore.rootStore.status === 'closed'`) as a\nbenign interruption: skip the doomed persist and log at debug. Recovery is unchanged —\nthe next worker generation re-runs the backfill via the existing crash-recovery trigger\n(indexingPID !== process.pid / restartNumber < current generation).\n\nAlso de-flakes the reindex integration test: a recovery-reindex window after the\nrestart-interrupted first backfill legitimately returns a transient INDEX_REBUILDING\n(503), which the test's single-success gate didn't tolerate. A new vectorSearchStable()\npolls past the transient window; a permanently-stuck index (never recovers) still fails.\n\nAdds a unit test for the shutdown-interruption path (runIndexing resolves, no indexingFailed).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(indexing): preserve interruption error in debug logs; use sleep() in test\n\nAddresses Gemini review: pass the underlying error to logger.debug on the\nshutdown-interruption paths so the root cause (e.g. \"Database not open\") is captured;\nuse the already-imported sleep() helper in vectorSearchStable.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kris Zyp <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-04T12:42:35Z",
          "url": "https://github.com/HarperFast/harper/commit/228eacc0fb41dd521b4d990a46533ecaccd6c3f3"
        },
        "date": 1783239371529,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.37,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.17,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.58,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.01,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.11,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.12,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.93,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.4,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.76,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 162.16,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.67,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "228eacc0fb41dd521b4d990a46533ecaccd6c3f3",
          "message": "fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test (#1476)\n\n* fix(indexing): treat shutdown-closed store during backfill as benign; de-flake reindex test\n\nWhen `restart_service http_workers` tears a worker down mid-backfill, runIndexing's\nrange scan/puts throw against the closing store (\"Database not open\"). The old catch\nlogged a misleading error and then tried to persist `indexingFailed` against the\nalready-closed store, which also failed (\"Failed to persist indexing failure state\").\nTreat a store closed by shutdown (`primaryStore.rootStore.status === 'closed'`) as a\nbenign interruption: skip the doomed persist and log at debug. Recovery is unchanged —\nthe next worker generation re-runs the backfill via the existing crash-recovery trigger\n(indexingPID !== process.pid / restartNumber < current generation).\n\nAlso de-flakes the reindex integration test: a recovery-reindex window after the\nrestart-interrupted first backfill legitimately returns a transient INDEX_REBUILDING\n(503), which the test's single-success gate didn't tolerate. A new vectorSearchStable()\npolls past the transient window; a permanently-stuck index (never recovers) still fails.\n\nAdds a unit test for the shutdown-interruption path (runIndexing resolves, no indexingFailed).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(indexing): preserve interruption error in debug logs; use sleep() in test\n\nAddresses Gemini review: pass the underlying error to logger.debug on the\nshutdown-interruption paths so the root cause (e.g. \"Database not open\") is captured;\nuse the already-imported sleep() helper in vectorSearchStable.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Kris Zyp <kris@harperdb.io>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-04T12:42:35Z",
          "url": "https://github.com/HarperFast/harper/commit/228eacc0fb41dd521b4d990a46533ecaccd6c3f3"
        },
        "date": 1783327630629,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.04,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.14,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.97,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.5,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.49,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.84,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.52,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.84,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 52.41,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 170.56,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "ece7da47672d8ee175a87b39b2a21340169c376a",
          "message": "feat: re-authorize live subscriptions; revoke on permission loss or token expiry (#1414) (#1535)\n\n* feat: re-authorize live subscriptions; revoke on permission loss or token expiry (#1414)\n\nSubscribe-time authorization is point-in-time: once an SSE/WebSocket/MQTT stream is\nopen it keeps delivering even after the principal loses access (drop_user, role or\npermission change) or the bearer token it was opened with expires. This adds a\ncontinuous re-authorization registry that terminates such subscriptions.\n\n- server/liveSubscriptionAuth.ts: a registry of live subscriptions, each with a\n  table/RBAC-level recheck and a terminate handler. Swept (1) immediately on the ITC\n  user-change broadcast — serverHandlers rebuilds the user/role cache before firing\n  listeners, so the recheck sees current permissions — and (2) on a 30s interval as a\n  backstop and to catch token expiry, which is not event-signaled. Re-auth is\n  table-level (re-runs the same allowRead the subscription was granted with against a\n  freshly-fetched user); there is NO per-record evaluation. An error during recheck\n  fails closed (revokes). Normal teardown auto-unregisters.\n\n- resources/Resource.ts: at the common authorization chokepoint\n  (authorizeActionOnResource), register the resulting subscription for both the\n  'subscribe' (MQTT) and 'connect' (SSE/WebSocket) actions. Subscriptions with no user\n  principal (internal watchers, replication, local-bypass) are skipped.\n\n- security/auth.ts: capture the bearer token's JWT exp on the authenticated user so a\n  subscription opened with it can be revoked once it expires.\n\nRe-auth interval is overridable via HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS (tests).\n\nTest: integrationTests/security/subscription-revocation.test.ts opens an SSE collection\nsubscription and asserts delivery STOPS after (1) drop_user (event-driven) and (2)\nbearer-token expiry (interval-driven), while an authorized stream keeps delivering. 2/2\npass.\n\nCloses #1414.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix: address review — fresh user in recheck context, forward end() args, format\n\n- recheck advances context.user to the freshly-fetched user before re-running allowRead,\n  so a custom allowRead reading context.user / getCurrentUser() evaluates current state\n  rather than the stale subscribe-time user (Gemini critical).\n- the wrapped subscription.end() forwards all arguments to the original end() so stream\n  cleanup semantics are preserved (Gemini high).\n- prettier formatting on the new test.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* style: prettier formatting on subscription-revocation test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(lint): use node:assert instead of restricted node:assert/strict\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kris@harperdb.io>",
          "timestamp": "2026-07-06T23:39:00Z",
          "url": "https://github.com/HarperFast/harper/commit/ece7da47672d8ee175a87b39b2a21340169c376a"
        },
        "date": 1783412429407,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.87,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.82,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.96,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.66,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.89,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.37,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.23,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.93,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.26,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 138.25,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.43,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "a0f4a51acfa917fd544c88eec4b8893b5d04512e",
          "message": "fix(mqtt): close last-will persistence race; give retained-message test more headroom\n\nTwo independent causes behind the flaky \"test MQTT connections and commands\"\nsuite:\n\n- \"last will should be published on connection loss\": getSession() wrote the\n  Last Will record via getLastWill().put(will) without awaiting it, before\n  CONNACK is sent. A client that connected and then disconnected abruptly\n  could race ahead of that write; session.disconnect() would then find no\n  will record and silently drop it, hanging the test until mocha's timeout.\n  Reproduced deterministically with an artificial delay before the write, and\n  confirmed the fix (await the write) closes the race. Fix: await\n  getLastWill().put(will).\n\n- \"subscribe to retained/persisted record\": already raced the real message\n  event against a backstop timer, but the backstop (8000ms) left only 2s of\n  margin under the suite's 10000ms mocha timeout, and delivery is known to\n  routinely exceed 1s on loaded CI runners. Bump this test's own timeout to\n  20000ms (same precedent as the QoS=1 reconnect test) and derive the inner\n  backstop from this.timeout() - 2000 so the two can't race each other.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-07T23:40:40Z",
          "url": "https://github.com/HarperFast/harper/commit/a0f4a51acfa917fd544c88eec4b8893b5d04512e"
        },
        "date": 1783497521143,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 11.56,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.12,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.16,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 13.11,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 20.84,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 12.62,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 26.87,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.61,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 14.53,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.99,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 125.38,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "9018760e480a61e54d280eb07e93fa26c96c9a0b",
          "message": "Merge pull request #1621 from HarperFast/kris/blob-send-drain-core\n\nfeat(threads): graceful drain hook for in-flight work before worker shutdown",
          "timestamp": "2026-07-08T22:56:41Z",
          "url": "https://github.com/HarperFast/harper/commit/9018760e480a61e54d280eb07e93fa26c96c9a0b"
        },
        "date": 1783585239892,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 10.88,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 10.45,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.9,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 10.82,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 26.41,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 11.58,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.79,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.14,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 130.5,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 51.91,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "bd1dce0b1bbb91aeea15e5380f5b98e311f631a8",
          "message": "feat(#914): uWebSockets.js HTTP/WebSocket backend (default-off) (#1096)\n\n* feat(http): add uWebSockets.js request adapter (spike, #914)\n\nSpike for evaluating uWS as a per-worker HTTP server on the plaintext-UDS\npath behind symphony (TLS/mTLS/HTTP-2 terminated upstream). Adds:\n\n- UwsRequest in Request.ts: a Harper request adapter modeled on BunRequest,\n  sourced from uWS-extracted method/url/headers/body. Real client IP comes\n  from X-Forwarded-For; peerCertificate/authorized are null (terminated\n  upstream).\n- uwsServer.ts: createUwsServer(), a non-SSL uWS App on a unix socket that\n  bridges each request through httpChain[port] and serializes the Harper\n  response descriptor back onto the uWS HttpResponse.\n\nBenchmarks (CPU-µs/request, vs Node http on the same UDS) show uWS holds a\n~1.56x efficiency edge with the real Request abstraction in the loop. Not yet\nwired into getUwsHTTPServer/threadServer.js; uWS is not yet a dependency.\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\n* feat(http): wire uWS UDS server behind HARPER_UWS_UDS flag (spike, #914)\n\nMakes the per-worker plaintext-UDS mirror optionally served by uWebSockets.js\ninstead of a Node http server, gated behind the HARPER_UWS_UDS env flag\n(default off -> no behavior change). When set:\n\n- getHTTPServer registers a uwsServeConfigs entry for the UDS path instead of\n  creating the Node udsServer.\n- makeUwsHandler mirrors the Bun fetchHandler's post-processing (httpChain,\n  unhandled, universalHeaders, Server-Timing, analytics, logging) and returns a\n  Harper response descriptor; createUwsServer serializes it onto the uWS res.\n- threadServer.listenOnPorts() starts the uWS UDS servers from uwsServeConfigs.\n- uWebSockets.js added as an optionalDependency (GitHub tag; ABI-locked, no\n  musl build -> CI must build per Node major).\n\nSymphony must use sourceAddressHeader 'xForwardedFor' for these sockets (uWS\ndoes not parse the PROXY protocol). Fastify status===-1 fallback and response\nstreaming are not wired in this spike. Type-checks clean (tsc --noEmit); not\nyet exercised against a live booted Harper.\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n\n* fix(http): null-guard request._nodeRequest in unhandled() (spike, #914)\n\nunhandled() (the middleware-chain terminal) set request._nodeRequest.user when\nan authenticated request hit no route, to hand auth to a Node fallback server.\n_nodeRequest is null for both BunRequest and UwsRequest, so an authenticated\nrequest to an unmatched route threw \"Cannot set properties of null (setting\n'user')\" -> 500. Latent on the Bun path; surfaced by the live uWS-UDS bench.\n\nGuard on _nodeRequest: the handoff only applies to the Node fallback path; the\nBun/uWS adapters have no Node fallback server. With this, the uWS UDS path\nreturns 404 like Node. Verified on a live booted Harper.\n\n* fix(#914): harden uWS UDS adapter for production + add adapter unit test\n\nGraduates the uWS-behind-symphony spike toward landing by fixing the\ncorrectness issues surfaced in review and adding a regression suite.\n\n- Request body corruption (critical): Buffer.from(arrayBuffer) aliased\n  uWS's receive buffer, which is neutered/reused once the onData callback\n  returns while the body is read asynchronously in the handler. Multi-chunk\n  POST/PUT bodies came back truncated/corrupt. Copy the bytes out\n  synchronously via Buffer.from(new Uint8Array(chunk)).\n- Duplicate request headers were clobbered (headers[k] = v, last wins);\n  accumulate repeats into an array like the Node path.\n- Empty reason phrase for uncommon status codes (\"429 \"); derive the\n  status line from node:http STATUS_CODES with an \"Unknown\" fallback.\n- Route by method rather than a single app.any(hasBody:true) so bodyless\n  methods dispatch immediately and unknown methods can't stall a connection.\n- Collapse of streaming/iterable response bodies now bails when the client\n  disconnects (thread the request AbortSignal into uwsBodyToBuffer).\n- Refresh the stale adapter header comment (wiring is done).\n\nAdds unitTests/server/serverHelpers/uwsServer.test.js: exercises GET,\nbodyless OPTIONS, multi-chunk POST round-trip (guards the aliasing bug),\nduplicate headers, 404, thrown->500, and reason-phrase serialization over\na real UDS. Skips gracefully when the uWebSockets.js optional dep is absent.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of uWS UDS adapter\n\nFollow-up to the adapter hardening, resolving issues surfaced by the\ncross-model review (Codex + Gemini + Harper-domain adjudication).\n\n- WHATWG Response return path (significant): makeUwsHandler mutated\n  response.status/response.body, which throws for a handler that returns a\n  standard Response (read-only accessors) — a divergence from the Node/Bun\n  paths, which build a fresh descriptor. Return a new descriptor instead of\n  mutating the chain's result.\n- Write-method throttling was dropped on the uWS UDS mirror: the Node UDS\n  path routes non-GET/OPTIONS/HEAD through the request-queue throttle (503 on\n  overflow), the uWS path bypassed it. Restore parity via throttle() so\n  data-modifying bursts shed instead of saturating a worker.\n- QUERY (and other non-standard body-bearing methods) had their body\n  silently dropped: the per-method routing sent the any() fallback down the\n  bodyless path. Route known-bodyless methods explicitly and treat the\n  fallback as body-bearing (uWS still fires onData(len=0) for bodyless).\n- Shutdown shim entered the Node keep-alive drain loop and force-exited\n  noisily every shutdown (uWS close() takes no callback): wrap close() to\n  invoke the callback and omit closeIdleConnections so the drain is skipped.\n- UwsRequestBody now extends Readable, matching the RequestBody/BunRequestBody\n  contract (for-await async iteration + destroy(), not a duck-typed subset).\n- Tidy: remove abort listener on the stream-error path in uwsBodyToBuffer,\n  drop the unused AbortController param from writeResponse, add the\n  uWebSockets.js optionalDependency to package-lock.json.\n\nAdds QUERY-body-routing and 413-over-limit tests; suite now 9 green.\nThe WHATWG-Response, throttle, and shutdown-teardown paths live above the\nadapter unit boundary — flagged for the integration bench in the PR.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* feat(#914): plaintext uWS-over-HTTP path + full streaming responses\n\nExtends the uWS adapter beyond the symphony-UDS mirror toward a fully\ncapable HTTP backend.\n\nPlaintext TCP path (HARPER_UWS_HTTP):\n- createUwsServer now accepts a `port`/`host` (app.listen, SO_REUSEPORT by\n  default) in addition to `socketPath`, so uWS can back a non-secure HTTP\n  TCP port directly — not just the UDS mirror.\n- getHTTPServer registers a uWS TCP config (and skips the Node server) for\n  non-secure app HTTP ports when HARPER_UWS_HTTP is set; threadServer's\n  start loop is generalized to UDS- or port-keyed configs.\n- This is the flag used to run the integration suite through uWS: a\n  representative slice passes 45/45 (REST/SQL, data types, dates, arrays,\n  binary/Brotli blob responses byte-exact, Content-Encoding, caching).\n\nStreaming responses:\n- normalizeUwsBody (was uwsBodyToBuffer) now passes Node streams and\n  async-iterables through as a Readable instead of buffering — buffering an\n  SSE/event-stream body never returns.\n- writeResponse streams a Readable body to uWS with real backpressure\n  (res.write + res.onWritable pause/resume) and omits Content-Length so uWS\n  uses chunked encoding. uWS only flushes headers on the first body write,\n  so text/event-stream responses emit a spec-valid ':\\n\\n' comment to open\n  the stream immediately (fixes SSE \"headers never flushed\"). Client abort\n  or a source error destroys the source and stops writing.\n- Verified: MCP SSE integration test passes 4/4 (headers flushed up front);\n  3 new adapter unit tests cover SSE, a plain Readable, and a 4 MiB\n  backpressure stream. Suite now 12 green.\n\nRemaining: WebSocket upgrade (MQTT-over-WS/subscriptions) — next.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* feat(#914): WebSocket upgrade support on the uWS path\n\nCompletes uWS as a full HTTP+WS backend. uWS owns its sockets, so WS can't\nbe delegated to the ws library's WebSocketServer; instead the adapter uses\nuWS's native app.ws() and bridges each connection to a ws-library-shaped\nobject that Harper's existing websocket chain consumes unchanged.\n\n- UwsWebSocket (server/serverHelpers/uwsServer.ts): adapts a uWS WebSocket\n  to the subset of the ws interface Harper uses — send/close/terminate/ping,\n  'message'/'close' events, readyState, and a _socket shim exposing\n  remoteAddress + backpressure (writableNeedDrain/'drain' via\n  getBufferedAmount + the drain callback). Inbound frames are copied out of\n  uWS's neutered buffer.\n- createUwsServer accepts a wsHandler; when set it registers app.ws('/*')\n  (capturing the upgrade request's url/headers/ip, IPv4-mapped address\n  normalized) alongside the HTTP routes — both coexist on one port.\n- onWebSocket (server/http.ts) detects a uWS-backed port and wires the\n  wsHandler (build a WS UwsRequest, run httpChain auth, invoke\n  websocketChains) instead of the Node ws.WebSocketServer + 'upgrade' event.\n  Previously this crashed under HARPER_UWS_HTTP (\"server.on is not a\n  function\"), failing MQTT component load; also guards a NaN-port config.\n\nValidated through the real harness: MQTT-over-WS passes 11/11 (RS256 JWT\nauth, topic ACLs, pub/sub, $SYS monitoring); SSE 4/4 and HTTP unaffected\n(24/24 combined). 2 new adapter unit tests (HTTP+WS coexistence on one port;\nupgrade + text/binary frame round-trip); suite now 14 green.\n\nWith this, the full integration slice runs over uWS: HTTP, SSE/streaming,\nand WebSocket subscriptions.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of plaintext/streaming/WS uWS work\n\nFindings from the Codex+Gemini+domain review of the streaming/WS commits.\n\n- Client IP on the direct-TCP path (P1, Codex+sweep): the uWS HTTP handler\n  never captured the peer address, so request.ip was '' and local auth\n  (security/auth.ts AUTHORIZE_LOCAL, request.ip.includes('127.0.0.')) failed\n  — anonymous localhost requests got \"Must login\". The integration sweep hit\n  this: early-hints/redirector/risk-query (pass on baseline, \"pass 0\" under\n  the flag). Fix: capture res.getRemoteAddressAsText() for the TCP path\n  (left unset for UDS). AND flip UwsRequest.ip to prefer the real socket\n  address over X-Forwarded-For, so a direct client can't spoof\n  `X-Forwarded-For: 127.0.0.1` to satisfy local auth; XFF is trusted only on\n  the symphony-UDS path (where the socket has no client address).\n- HEAD body (P2, Codex): uWS has no ServerResponse HEAD guard, so a handler\n  returning a body on HEAD would send it. REST already nulls HEAD bodies;\n  enforce it in writeResponse for any other handler.\n- WebSocket maxPayload (P2, Codex): the onWebSocket uWS branch didn't forward\n  options.maxPayload, so a configured smaller WS frame limit wasn't enforced\n  (defaulted to 100 MiB). Thread it through as wsMaxPayload.\n\nGemini's headline \"Buffer.from(new Uint8Array(message)) aliases uWS memory\"\nblocker is a false positive (same conflation as last review): it COPIES —\nproven (survives source neutering) and corroborated by MQTT-over-WS 11/11\nwith async frame processing.\n\nNoted, not fixed (out of scope / parity): GraphQL POST reads _nodeRequest\nwhich is null on uWS AND Bun (pre-existing non-Node-adapter gap, needs a\nbody-based deserialize); a raw Fastify server registered on a uWS-backed\nport could collide in SERVERS (low reachability; MCP Fastify passes).\n\nIntegration sweep: 43/43 pass under HARPER_UWS_HTTP after the IP fix.\nAdapter unit suite now 16 (adds request.ip + HEAD-suppression tests).\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n\n* docs(#914): refresh uwsServer header (TCP+streaming+WS, not UDS-only)\n\n* fix(#914): deserialize GraphQL POST body via request.body\n\nThe GraphQL POST handler read the body from request._nodeRequest, the raw\nNode IncomingMessage. That is null on the Bun and uWS request adapters, so\nGraphQL POST 500'd off the Node path. Read through request.body instead —\na Readable-compatible body stream on every adapter, matching how REST.ts\nalready deserializes bodies. Verified 24/24 graphql integration tests on\nboth the Node and HARPER_UWS_HTTP paths.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): don't let raw-Fastify listeners collide with the uWS HTTP port\n\nUnder HARPER_UWS_HTTP the app port is backed by uWebSockets.js and getHTTPServer\nearly-returns a { uws: true } marker before it would have called\nregisterServer(server, port). SERVERS[port] therefore stays empty. If a legacy\nFastify-routes app is then deployed, fastifyRoutes registers its raw http.Server\nvia server.http(fastify.server); with the port looking unused, registerServer set\nSERVERS[port] = fastifyServer and threadServer bound a Node http server competing\nwith uWS on the same TCP port (Codex P2).\n\nMirror the Bun path: divert non-function listeners on a uWS-backed port into the\nfallback map instead of registerServer(), so nothing lands in SERVERS to double\n-bind. Renamed bunFallbackServers -> fallbackServers since the map is now shared\nby both non-Node backends. Request-time delegation to this fallback is not yet\nwired on the uWS handler, so raw-Fastify routes are unreachable (clean, not a\ncompeting bind) under this flag - an accepted limitation of the bench vehicle,\nnoted for a parity follow-up.\n\nVerified: components.test.mjs (deploys a Fastify-routes component) 25/25 on both\nthe Node and HARPER_UWS_HTTP paths, with the Fastify registration diverting\ncleanly and no bind collision.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* feat(#914): delegate to the Fastify fallback from the uWS HTTP path\n\nCompletes the raw-Fastify story on HARPER_UWS_HTTP. Previously a legacy\ncustom-function route (server.http(fastify.server)) was diverted to the fallback\nmap to avoid a competing bind, but the uWS handler had no way to reach it, so the\nroute 404'd. Now, when the chain doesn't handle a request (status === -1) and a\nFastify instance is registered for the port, the uWS handler delegates via\nfastify.inject() — its internal router, no socket — mirroring the Bun path,\nincluding SSE streaming and the AUTHORIZE_LOCAL pre-auth user forward.\n\n- Extracted the shared inject core into injectToFastify() and routed both the Bun\n  and uWS delegation paths through it (strip forged pre-auth header, forward\n  resolved user when no Authorization, payloadAsStream for SSE).\n- fastifyRoutes now registers its app instance for the http port(s); it only ever\n  registered the http.Server, so neither Bun nor uWS could delegate to legacy\n  routes. Renamed bunFastifyInstances -> fastifyInstances /\n  registerBunFastifyInstance -> registerFastifyInstance (shared, not Bun-only).\n- UwsRequest exposes rawBody for the inject payload.\n\nVerified: fastifyRoutes-test.mjs (GET /testApp/ping -> 'pong' + REST on the same\ncomponent) passes on BOTH the Node and HARPER_UWS_HTTP paths; under uWS the route\nis served purely via inject-delegation. graphql 24/24, components 25/25,\nmcp/sse-listchanged 4/4 under the flag; 16 uWS unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): run the full integration suite under HARPER_UWS_HTTP\n\nAdds a run-integration-tests-uws job mirroring the existing Bun variant: the same\n6-shard test:integration:all on Node 24, but with HARPER_UWS_HTTP=1 so the\nplaintext app HTTP port(s) are served by uWebSockets.js. Secure/replication/ops\npaths keep running on Node, so this gives continuous coverage of the uWS\nrequest/streaming/WS/GraphQL/Fastify-fallback path across the whole suite instead\nof relying on a manual local flag.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): make the uWS integration job informational (non-blocking)\n\nThe first full-suite run under HARPER_UWS_HTTP surfaced two known uWS-path gaps\n(Bun and Node are green on the same tests):\n  - static-file serving via `send` never flushes headers on the uWS response\n    (client HeadersTimeout) — the deploy/static-access tests hang;\n  - multiple Set-Cookie headers collapse to one (the WHATWG Headers comma-join\n    limitation Harper-on-Bun already skips).\nNeither is a regression from the Fastify-delegation work. Mark the job\ncontinue-on-error so it reports the per-shard uWS signal without gating merges;\nremove once the gaps are closed.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): serve static files (send SendStream) on the uWS HTTP path\n\nStatic handlers return a `send` SendStream, which only begins work when piped to\na Node ServerResponse and writes its own headers there. The uWS path has no such\nobject: it treated the stream as a plain Readable and attached .on('data') (which\nnever starts a SendStream), and uWS only flushes status/headers on the first body\nwrite — so static responses hung and the client saw a HeadersTimeout. This is why\nevery deploy+access integration test (deployed apps serve a static site) timed out\nunder the flag.\n\nPipe the SendStream into a Writable shim that captures the headers it writes\n(setHeader/writeHead) onto the response Headers and buffers the file, mirroring the\nBun fetchHandler's SendStream path (incl. finished:false so on-finished doesn't\ntear down early). Gated on handlesHeaders, which only static.ts sets, so real\nstreaming/SSE bodies keep streaming through normalizeUwsBody.\n\nVerified: deploy/deploy-from-source.test.ts (deploys an app with a web/ static\nsite, polls the static index, asserts the served HTML) now passes 4/4 under\nHARPER_UWS_HTTP — previously deploy+access both hung ~300s.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): preserve multiple Set-Cookie headers on the uWS HTTP path\n\nA WHATWG Headers comma-joins Set-Cookie when iterated, which merges multiple\ncookies into one and corrupts values containing commas (e.g. `expires=` dates).\nThe uWS response path iterated the headers directly (and writeResponse converted a\nWHATWG Headers via `new Headers()`, comma-joining before serialization), so a\nresponse setting N cookies reached the client as 1.\n\n- writeHeaders now emits Set-Cookie individually via getSetCookie() when present\n  (WHATWG), skipping the joined entry; a Harper Headers stores them as an array,\n  already handled by the array branch.\n- writeResponse keeps an existing Headers-like object (Harper or WHATWG) as-is\n  instead of round-tripping a WHATWG Headers through `new Headers()` (which would\n  comma-join before writeHeaders could split it), wrapping only plain objects.\n- the Fastify-delegation path keeps Set-Cookie multi-valued instead of comma-\n  joining inject()'s array.\n\nThis is the multi-Set-Cookie limitation Harper-on-Bun documents and skips; uWS now\nhandles it correctly. Verified: headers.test.mjs 2/2 under HARPER_UWS_HTTP (was\n0/2); graphql/components/mcp-sse/deploy-from-source/fastifyRoutes all green under\nthe flag; 16 uWS unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* ci(#914): gate on the uWS integration job (full suite now green)\n\nThe full test:integration:all suite passes on all 6 shards under HARPER_UWS_HTTP\n(CI run 28724670219) now that the static-`send` and multiple-Set-Cookie gaps are\nfixed, so the job no longer needs continue-on-error — make it a required check\nalongside the Node and Bun variants.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(#914): address cross-model review of the uWS Fastify/static/header work\n\nCross-model review (Codex + Gemini + Harper-domain adjudication) of the new uWS\nwork. Both outside-model legs led with false positives (request.headers.asObject\n'undefined' → auth bypass, and Set-Cookie comma-coercion) — both refuted: headers\nis a RequestHeaders with a real .asObject used across the REST path, and the uWS\nHeaders is Harper's Map-based class that preserves Set-Cookie arrays. The\nINTERNAL_USER_HEADER pre-auth forward was probed and is spoof-safe (client-supplied\nheader is stripped before the user is re-added). Real items addressed:\n\n- bufferSendStream no longer swallows send's status: capture statusCode / writeHead\n  status and return it, so a 304 (conditional GET) or 206/416 (Range) is honored\n  instead of flattened to 200. (End-to-end 304/Range is still gated upstream by\n  send not reading Harper's RequestHeaders — a pre-existing limitation on all\n  backends incl. Node, verified by probe; left as a separate follow-up.)\n- avoid re-copying already-Buffer chunks when draining a delegated Fastify response.\n- document the lowercased-'authorization' contract in injectToFastify.\n- refresh the fallback-divert comment: request-time delegation IS now wired, and\n  the { uws: true } marker is guaranteed set by the getServer(port) call above.\n\nRegression under HARPER_UWS_HTTP: deploy-from-source 4/4 (static), headers 2/2\n(Set-Cookie), fastifyRoutes 2/2 (delegation), 16 uWS unit tests.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* feat(#914): stream uWS request bodies + address review comments\n\nFeed the uWS request body into a push-based Readable and dispatch the\nhandler on headers instead of buffering the whole body and dispatching on\nthe last chunk. streamToBuffer (contentTypes.ts) already owns\nconcatenation and the HTTP_MAXREQUESTBODYSIZE limit and is the entry point\nfor the upcoming streaming deserializers, so the adapter no longer\nconcatenates (drops the O(n^2) Buffer.concat) or enforces its own body\nlimit; maxBodyBytes is demoted to a coarse socket-level DoS ceiling since\nuWS offers no inbound backpressure. The Fastify-delegation path passes the\nbody stream to inject() (light-my-request consumes it), so rawBody is gone.\n\nAlso address review feedback:\n- use when() so a synchronous handler stays synchronous (no extra promise)\n- rename logBunRequest -> logHttpRequest (shared Bun/uWS path)\n- correct the stale \"WebSocket upgrades are not yet wired\" comment\n- reword the SPIKE/spike comments now that this is graduating\n- document uWebSockets.js in dependencies.md\n\nAdds a test asserting the handler is dispatched before the request body\nends (proves streaming, not full buffering).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(uws): guard 413 write against completed response + test XFF spoofing defense (#914)\n\nAddress cb1kenobi PR review:\n- Track responseCompleted in onRequest and guard all three response-write\n  sites (handler result, error, 413). The handler can respond (or start\n  streaming) without consuming the body; a later over-limit 413 would then\n  write to an already-completed uWS response and abort the process.\n- Add unit tests for request.ip trust boundary: a spoofed X-Forwarded-For\n  must not override the authoritative TCP peer address, while the UDS path\n  (no socket peer) still honors the trusted proxy's XFF.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix: sync package-lock with merged package.json (prettier 3.9.5, globals 17.7.0, aws-sdk lib-storage 3.1076.0)\n\nThe npm-merge-driver left the lock resolved to the branch's older\nversions while package.json took main's bumps, breaking npm ci.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* style: reformat uwsServer.ts per prettier 3.9.5 (trailing comment placement)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.7 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kris@harperdb.io>",
          "timestamp": "2026-07-10T05:51:34Z",
          "url": "https://github.com/HarperFast/harper/commit/bd1dce0b1bbb91aeea15e5380f5b98e311f631a8"
        },
        "date": 1783671823189,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.58,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.15,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.44,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.28,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.06,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.61,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.09,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.53,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 170.49,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.93,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}