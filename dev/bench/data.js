window.BENCHMARK_DATA = {
  "lastUpdate": 1782547750213,
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
      }
    ]
  }
}