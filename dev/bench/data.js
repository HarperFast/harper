window.BENCHMARK_DATA = {
  "lastUpdate": 1787053371961,
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
          "id": "31de6a3bebc5fec85a8eba98087fda00dbc3f477",
          "message": "fix: pin uWebSockets.js via tarball URL, not a github: git spec\n\nSame issue as harper-pro#561: the github: shorthand\n(github:uNetworking/uWebSockets.js#v20.68.0) gets re-resolved by npm as\ngit+ssh://github.com/... on any npm install. Our Docker build stage has\nno SSH credentials for github.com, so npm silently skips the (optional)\ndependency and the shipped image never bundles the native addon —\nHARPER_UWS_UDS / HARPER_UWS_HTTP are inert even when set.\n\nAn explicit git+https:// spec doesn't fix this either — confirmed with\na clean npm cache that npm/hosted-git-info canonicalizes ANY\ngithub.com git dependency back to git+ssh:// regardless of requested\nprotocol. Switching to a plain tarball URL\n(https://.../archive/<sha>.tar.gz) sidesteps hosted-git-info entirely:\nnpm treats it as a remote-tarball dependency, resolved stays a plain\nhttps URL with a pinned integrity hash, and it can't regress on a\nfuture npm install.\n\nVerified npm ci installs all 15 native .node binaries in a\nHOME-stripped, credential-less environment (matching the Docker build\nstage) both before and after a full npm install regenerates the\nlockfile from package.json.",
          "timestamp": "2026-07-10T21:38:26Z",
          "url": "https://github.com/HarperFast/harper/commit/31de6a3bebc5fec85a8eba98087fda00dbc3f477"
        },
        "date": 1783843150159,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5935.58,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8405.96,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8363.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6585.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4785.17,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8352.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1080.04,
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
          "id": "8bf5921e06349611773b4c1d4363088801d3b974",
          "message": "ci(review): canary Claude reviews on claude-sonnet-5 (harper only) (#1759)\n\nOverride the reusable's model default (claude-sonnet-4-6) for this\nrepo's claude-review caller. harper is the A/B canary: highest review\ntraffic, and every ai-review-log entry records Model:, so calibration\ncan compare sonnet-5 vs sonnet-4-6 verdict mix directly at the same\nprompt ref (9cf49d2). Intro pricing ($2/$10 through 2026-08-31) offsets\nthe new tokenizer (~30% more tokens for equivalent text).\n\nWatch item: Sonnet 5 follows blocker-only severity instructions more\nliterally (documented code-review-harness effect) — if the deflation\nrate rises in the next calibration cycle, add coverage-first reporting\nto the run-notes surface before fleet rollout; if clean, promote to the\nreusable default.\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-13T00:05:21Z",
          "url": "https://github.com/HarperFast/harper/commit/8bf5921e06349611773b4c1d4363088801d3b974"
        },
        "date": 1783930269482,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 15304.63,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 24321.13,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 24072.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 16735.61,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 12299.5,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 22195.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 2341.32,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "56f8891b933e4638c9f622a0030570de4fd711a8",
          "message": "fix(deps): update all non-major dependencies",
          "timestamp": "2026-07-13T23:29:07Z",
          "url": "https://github.com/HarperFast/harper/commit/56f8891b933e4638c9f622a0030570de4fd711a8"
        },
        "date": 1784015433493,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5857.23,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8323.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8327.43,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6477.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4683.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8337.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1052.23,
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
          "id": "182971ad16a3ba6986ffae194067965505d5bfa8",
          "message": "Typed, discoverable resources — code-first defineTable + per-method request contract (RFC 0001) (#1767)\n\n* feat(resources): typed, discoverable resources — code-first defineTable + per-method request contract\n\nImplements RFC 0001 (design PR #1503): the mergeable implementation of both\nauthoring front-ends, integrated onto current main.\n\nPillar 1/2b — code-first schema (resources/defineTable.ts):\n  `defineTable(name, shape, opts)` + `types` author a table in TypeScript and\n  eagerly register through the same `table()` factory GraphQL drives — the return\n  IS the live class, with per-verb shapes inferred as `$record/$insert/$upsert/\n  $patch/$query` projections. Relations via lazy thunks (+ relationOf/hasManyOf\n  escape hatch for mutual pairs).\n\nPillar 2 — per-method request contract (resources/withSchema.ts):\n  `defineResource(contract, impl)` (function form) + `Resource.withSchema(contract)`\n  (class form). Handler types are derived from a runtime contract; a handler gets\n  the SAME RequestTarget, structurally narrowed (subset, not fork). Each declared\n  verb validates/coerces query/body before dispatch and throws a structured 400\n  (ValidationError, per-field {path,code,message}[]). Built-in `t`/`schemaOf`\n  reduce to JsonSchemaFragment — one vocabulary across table fields, query, and\n  bodies; a defineTable projection slots into a contract body via\n  schemaOf({ table, projection }). Nullability: non-nullable by default, `.nullable`\n  opts into null (table-derived bodies mirror Table.validate).\n\nCross-cutting:\n  - ValidationError (extends ClientError, 400); Table.validate refactored to the\n    same structured shape (HTTP-title message preserved).\n  - OpenAPI emits declared query/body/response for parameterised routes.\n  - MCP drives tool input/output off the contract and binds arbitrary path params\n    + query (applyContractInputs), lifting the generated-verb binding restriction\n    for contract resources.\n  - Shared attributeToFragment hardened with a nested-object branch; derive.ts\n    Object/Array projection bugfix.\n\nIntegration with main (the RFC branch was ~1007 lines behind on these files):\n  merged with main's newer MCP paramroutes work (paramBinding gating, isSimpleIdRoute,\n  mcpResources) and the liveResource authz fix — a request contract now exempts a\n  resource from the generated-handler binding restriction.\n\nDesign summary in resources/DESIGN.md; full RFC + type spikes remain in #1503.\nType contract verified against built exports in docs/rfcs/spikes/0001/*-real.check.ts.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(withSchema): address PR review — validation hardening + lint-safe test import\n\n- scope the Date type-check exception to string/date-time fields (a Date must not\n  pass validation for number/boolean/array/object schemas)\n- override target.getAll alongside get so multi-value query params read coerced\n- reject empty/whitespace numeric query params instead of Number('')→0\n- harden MCP wrapError: read the untrusted err's props inside a try/catch (revoked\n  Proxy / throwing getters must not crash the error path)\n- application-contract.test.js: require('assert') + strict methods (node:assert/strict\n  is oxlint-banned via no-restricted-imports)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor: rename withSchema.ts → defineResource.ts; drop spike/RFC artifacts\n\n- rename resources/withSchema.ts → resources/defineResource.ts (defineResource is\n  the primary API; Resource.withSchema stays the class-form name) + the test file\n- remove docs/rfcs/ (the *-real.check.ts type-contract proofs + tsconfig) — a real\n  PR shouldn't carry spike/RFC scaffolding; those live in the design PR (#1503)\n- strip references to the spikes and the RFC doc (which are not in this PR) from\n  code/test comments and resources/DESIGN.md; keep the #1503 pointer for the record\n\nNo behavior change. 100 unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(types): re-add public type-contract tests + wire into CI\n\nStandalone type-tests under unitTests/types/ (no spike/RFC framing): assert the\nSHIPPED public types (imported from the built dist) against the contract —\ndefineTable projections + relations, and the defineResource/withSchema handler\ninference, narrowed target, subset property, and negative (@ts-expect-error) cases.\n\n- unitTests/types/{defineResource,defineTable}.type-test.ts + tsconfig.json (strict,\n  noEmit, skipLibCheck; isolated from the main build/typecheck, which don't include\n  unitTests/, and from mocha, which only loads js/mjs)\n- `npm run test:types` (tsc --project unitTests/types/tsconfig.json)\n- CI: a \"Type contract tests\" step in unit-test.yml (after Build, gated to one Node\n  version) so a regression in the public type surface fails CI\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-14T19:37:17Z",
          "url": "https://github.com/HarperFast/harper/commit/182971ad16a3ba6986ffae194067965505d5bfa8"
        },
        "date": 1784101943061,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5968.3,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8359.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8410.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6695.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4828.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8458.49,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1045.81,
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
          "id": "3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02",
          "message": "Reshape deploy_component registryAuth into a general-purpose credentials array (#1797)\n\n* Reshape deploy_component registryAuth into a general-purpose credentials array\n\n`registryAuth` was an npm-only array of `{ registry, token|secret, scope }`\nentries. Rename it to `credentials` and treat the array as kind-heterogeneous:\nan entry's kind is implied by its identifying key (`registry` = npm registry\nauth) rather than a discriminator field, so a git-host kind keyed by `host`\n(#1792) becomes another item alternative rather than another schema rewrite.\n\nThe ingest/resolve pipeline, secrets-store integration, reference-only\nreplication, and every security invariant from #1717 are unchanged — this is a\nrename plus the seams for a second kind. Identifiers follow: ingestRegistryAuth\n→ ingestCredentials, resolveRegistryAuth → resolveCredentials, and the persisted\nforms (applicationConfig.credentials, hdb_deployment.credentials) match the\noperation field.\n\nSince #1717 has not shipped in a GA release, this is a clean break rather than an\nalias. Because operation validation allows unknown keys, a stale `registryAuth`\nis explicitly rejected — otherwise the deploy would silently install with no\ncredentials. It also stays in the operations-log strip list, since that redaction\nruns ahead of validation and a stale caller's token must not reach the log.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Filter Application.registryCredentials to registry-shaped entries\n\nThe credentials array is kind-heterogeneous by design (registry today,\na planned git-host kind later), but Application's constructor assigned\nit straight to registryCredentials, which buildNpmrcContent assumes is\nregistry-shaped. Filter defensively so a future non-registry entry\ncan't reach it.\n\nAddresses gemini-code-assist review comment on PR #1797.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Authenticate private git-reference deploys from an in-memory credential (#1799)\n\n* Authenticate private git-reference deploys from an in-memory credential\n\nA `github:org/repo` package against a private repo needs a credential for the\n`git ls-remote`/`git clone` npm shells out to. Every obvious way to supply one\npersists it: userinfo in the URL lands in the package spec and the lockfile, a\ncredential helper or `.npmrc` is a file, and an env var is readable by every\ndescendant process.\n\nInstead the token stays in the deploying process's memory and is served over a\nper-deploy Unix socket in a 0700 directory. git is pointed at\ngitCredentialHelper.js — a secret-free script that relays git's request over\nthat socket — and the socket dies with the spawn that needed it. The token\nreaches disk, argv, the package spec, the operation body and the operations log\nnowhere along the way.\n\nThe credential rides as a second kind in the `credentials` array from #1797:\n`{ host, token|secret, username? }`, discriminated by `host` the way npm entries\nare by `registry`. Ingest, seal-into-hdb_secret, grant-check, resolve-at-use and\nreplicate-as-reference are the existing #1717 paths, unchanged — only the\nderived secret name (`deploy.<component>.<host>`) and the injection mechanism are\nnew. resolveCredentials now rejects an unrecognized kind rather than resolving it\ninto a half-empty entry, symmetric with the guard ingestCredentials already had.\n\nWiring, in order of preference: `credential.helper` via GIT_CONFIG_* (structured\nkey=value protocol, no prompt parsing) with GIT_ASKPASS as the fallback for git\n< 2.31, which ignores GIT_CONFIG_*. Inherited credential helpers are reset to\nempty first, so a machine configured with `credential.helper=store` cannot write\nthis token to ~/.git-credentials when git reports the successful authentication\nback to its helper chain. The askpass path decides username-vs-password prompt\nstructurally (userinfo present in the echoed URL) rather than by matching\nEnglish, since git localizes those prompts.\n\nOnly the spawn that clones (`npm pack`) is given this environment. The\n`npm install` that follows — where a dependency's install script can run — never\nsees it, and the socket is already closed by then.\n\nRefs #1792. Stacked on #1797.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Keep the git credential out of reach of clone-time install scripts\n\nPacking a git reference is not just a download. npm clones the repo and, when\nits manifest has a prepare/build/install script, runs `npm install` inside the\nclone and then that script — so the repository's own code and its dependencies'\ninstall scripts execute on this node, inside the clone spawn, inheriting its\nenvironment. Verified against real npm: a transitive dependency's `preinstall`\nsees HARPER_GIT_CREDENTIAL_SOCKET and can ask the socket for the token. That is\nexactly the reach #1792 says the credential must not have, and closing the\nsocket before `npm install` did not close it, because this all happens earlier,\nduring `npm pack`.\n\nSo a credentialed clone runs with `--ignore-scripts` unless the deploy set\ninstall_allow_scripts, which is the operator explicitly asking for that code to\nrun here; that case is allowed and logged, naming the exposure it accepts. Note\nthis also means a git-reference deploy runs scripts at pack time regardless of\ninstall_allow_scripts today — the flag only ever reached the install spawn. That\ninconsistency is left alone here (fixing it changes behavior for existing public\ngit deploys) but is worth its own issue.\n\nWindows now fails closed instead of serving the credential over a named pipe: a\npipe is created with a default security descriptor that can leave it readable by\nother local users, and the whole confinement argument rests on the 0700\ndirectory a Unix socket sits in. Better to refuse than to offer a quietly weaker\nchannel.\n\nAlso from review: cap the request a peer can stream at the socket (an unbounded\n`request +=` was an OOM), and remove the socket's temp directory when listen()\nfails, since no session is returned and nothing would otherwise clean it up.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Harden the git credential channel against persistence and downgrade\n\nA second cross-model review pass (Codex) surfaced several ways the credential\ncould still escape memory:\n\n- **Cleartext transport.** git asks for `http://` credentials exactly as it\n  asks for `https://`, so a `git+http://` package (or a remote downgraded by a\n  redirect) would put the token on the wire in the clear. answerFor now serves\n  only over https, with an exemption for loopback (where no network is involved\n  and the integration tests run).\n\n- **git < 2.31.** Those versions ignore GIT_CONFIG_* entirely, so the\n  credential.helper reset that stops an inherited `store` helper from writing the\n  token to ~/.git-credentials is silently dead — and the GIT_ASKPASS fallback\n  would still feed that helper a successful credential to persist. There is no way\n  to disable an inherited helper on those versions, so the session now refuses to\n  start on one rather than leak. (The reset itself is verified end-to-end against\n  a real clone with both a global and a URL-scoped `store` helper configured; the\n  earlier concern that a URL-scoped helper bypasses the reset did not reproduce —\n  git's credential machinery honors the reset, `--get-urlmatch` merely shows raw\n  config.)\n\n- **Newline in a resolved token.** A literal token is schema-rejected for CR/LF,\n  but one resolved from an hdb_secret row was not — and git's protocol is\n  line-based (askpass reads only the first line), so such a token would truncate\n  or inject protocol attributes. Guarded at the serve boundary, matching the\n  .npmrc writer.\n\n- **Unknown keys persisting.** Operation validation runs allowUnknown, so a\n  credential entry like `{host, secret, password: \"literal\"}` would carry that\n  stray field through ingest into config, hdb_deployment, and replication. Both\n  entry schemas are now `.unknown(false)`, and each forbids the other's\n  discriminator. assertApplicationConfig likewise rejects an entry that is both\n  kinds or carries a literal token, rather than coercing it to one kind.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Warn on duplicate git-credential hosts; lock in the no-custody strip\n\nReview follow-ups. Two entries for the same host in one deploy silently\nlast-write-wins (they also seal to the same derived secret name), so warn rather\nthan drop quietly. And a regression test pins the security property that a\nliteral git token on a node without custody yields no persistable reference and\nis therefore stripped from the replicated op body.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Address 5 review comments; fix a backpressure bug hanging the OOM-cap test\n\n- close(): snapshot the connections Set before destroying, so destroy()'s\n  synchronous 'close' listener (which deletes from the same Set) can't skip\n  a connection mid-iteration.\n- answerFor(): guard against a non-object request before touching .host.\n- parseAskpassPrompt(): move the URL parse+decode inside the existing\n  try/catch so a malformed percent-encoded username can't throw past it.\n- gitCredentialClone.test.js: resolve GIT_HTTP_BACKEND in a try/catch so a\n  missing git binary can't crash the whole suite loader before before()\n  gets a chance to skip; before() now also checks for that case.\n- operationsValidation.js: cap the git credential entry's token at\n  SECRET_MAX_LENGTH, matching the same limit already applied elsewhere.\n\nAlso fixes an unrelated pre-existing bug found while verifying: the OOM-cap\ntest's write loop gave up permanently the first time socket.write() returned\nfalse for backpressure (the `&&` chain short-circuits), which happens well\nbefore the server-side 64KB cap is reached — so the test hung forever\nwaiting for a 'close' the server had no reason to send. Confirmed via a\nclean-checkout diff that this predates this task's changes. The production\ncap-enforcement logic itself was already correct; only the test's flow\ncontrol was wrong. Now resumes writing on 'drain' instead of giving up.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Update components/secretOperations.ts\n\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Fix CI: git-secret naming test drift, and prepare-script leak on npm<11\n\nsecretOperations.test.js still asserted the pre-review-fix secret name\n(deploy.<app>.<host>); a prior commit on this branch added the `.git`\nkind segment to deriveGitSecretName to close a same-host collision\nbetween git and registry secrets (per review), but didn't update the\ntests that pin the literal name. Update the 5 affected assertions to\nthe new, collision-safe name and note why in deriveGitSecretName's doc\ncomment.\n\nAlso fix a real Node-22-only failure: a credentialed git clone relied\non `npm pack --ignore-scripts <git-url>` to keep a repository's\nprepare script from running while the credential socket is reachable.\npacote's DirFetcher runs `prepare` unconditionally on npm <11.0.0 (the\nignoreScripts guard was only added upstream in npm 11) — exactly what\nNode 22's bundled npm ships, confirmed by reproducing against the real\nnpm 10.9.8 binary. For a recognized git-reference identifier with\nscripts disallowed, clone it ourselves (still authenticated via the\ncredential session's env) and strip its lifecycle scripts before\npacking, sidestepping the buggy npm code path entirely — the same\nmechanism harper#1819 lands for the uncredentialed case.\n\nVerified against npm 10.9.8: the prepare-script test fails identically\nto CI on the pre-fix code and passes reliably with the fix.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Resolve hosted-git shorthand (github:/gitlab:/bitbucket:/gist:) in parseGitReference\n\nderivePackageIdentifier defaults a bare owner/repo package identifier to\ngithub:owner/repo, but parseGitReference only recognized explicit\ngit+.../git:// URL forms, so that shorthand — the PR's own worked example —\nfell through to the npm pack --ignore-scripts fallback documented as\nunreliable on npm <11. Extend parseGitReference to resolve github:, gitlab:,\nbitbucket:, and gist: shorthand to a concrete https clone URL so it routes\nthrough the clone-and-strip-scripts path instead.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Resolve npm-style semver: committishes before git checkout\n\n#1799's own worked example (`github:my-org/my-app#semver:v1.2.3`) documented a\ncommittish naming a semver range, but packGitReferenceWithoutScripts passed it\nstraight to `git checkout`, which has no notion of npm's `semver:` syntax and\nsimply failed.\n\nAdds resolveCommittish(), which lists the clone's tags and resolves the range\nagainst them with the `semver` package (already a direct dependency), matching\nnpm's own git-dependency resolution: tags may carry a prefix ahead of the\nversion (`release-v1.2.3`), a percent-encoded range is decoded, and the\nresolved ref is checked out as `refs/tags/<name>` to avoid an ambiguous\nsame-named branch. A non-semver committish is unaffected.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Reject unsafe tag names before checkout in semver-committish resolution\n\nThe automated PR review on the previous commit found that resolveCommittish\nonly validated the semver-shaped suffix it matched in a tag name (e.g. the\n`v1.2.3` in `release-v1.2.3`), not the full tag string. Since git ref names\npermit shell metacharacters (`$`, backticks, `;`, `&`, `|`, parens — only\nwhitespace and a few other forms are disallowed), and nonInteractiveSpawn\nruns through a shell with no argument escaping, a tag name from the cloned\nrepository such as `$(touch${IFS}/tmp/x)v9.9.9` would execute as a command\nsubstitution on checkout — reachable specifically because semver resolution\npicks a tag out of the (untrusted, upstream) repo's own tag list, unlike a\nliteral committish which the deploying operator supplies directly.\n\nAdds a conservative safe-charset check on the full tag name; a tag failing\nit is excluded from resolution rather than sanitized, so it can never reach\nthe checkout spawn. Confirmed exploitable pre-fix (marker file executes) and\nblocked post-fix via a new regression test.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-15T23:03:58Z",
          "url": "https://github.com/HarperFast/harper/commit/3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02"
        },
        "date": 1784188502981,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6481.55,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9651.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10000.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7284.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5356.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9949.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1292.43,
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
          "id": "1df0df5609a20664029fa21e5ccb3e76e903f5b7",
          "message": "Release v5.2.0-alpha.6",
          "timestamp": "2026-07-17T00:33:58Z",
          "url": "https://github.com/HarperFast/harper/commit/1df0df5609a20664029fa21e5ccb3e76e903f5b7"
        },
        "date": 1784274925628,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5729.45,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8084.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8226.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6376.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4663.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8222.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1029.99,
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
          "id": "56a2bace9f27526d9066a1d05ff9161d012ecab6",
          "message": "fix(tls): honor `ciphers`/`SECLEVEL` from every configured source when building TLS listeners (#1841)\n\n* fix(tls): honor ciphers/SECLEVEL from every configured source when building TLS listeners\n\nA TLS listener has exactly one effective cipher string: OpenSSL takes the\ncipher list (and any @SECLEVEL, which governs client-cert chain\nverification) from the context the server was created with; SNI-swapped\ncontexts don't carry their own cipher list onto the connection. Harper\napplied only tls.ciphers ?? tls[0].ciphers and silently ignored every\nother configured value — tls[] entries beyond [0] and certificate\nrecords, including client-CA records carrying DEFAULT@SECLEVEL=0 for\nSHA-1-signed chains, which then failed with authorizationError\nUNSPECIFIED on valid in-date certs.\n\nresolveEffectiveTlsCiphers (security/keys.ts) now resolves the listener\nstring from all sources: top-level tls.ciphers wins; otherwise tls[]\nentries plus relevant cert records (uses-matched, and authorities when\nthe listener verifies client certs) are candidates, with the lowest\nexplicit @SECLEVEL winning conflicts and everything ignored logged.\nPost-boot changes to the resolved value warn (once per value) that a\nrestart is required. Bun path untouched (BoringSSL has no @SECLEVEL).\n\nCloses #1840\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test(tls): guard seclevel test teardown when setup fails early\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(tls): compose suite and minimum SECLEVEL per listener instead of picking one cipher string\n\nAddresses the external review on #1841: config array entries are now\nrelevance-filtered like certificate records (CA entries only when the\nlistener verifies client certs; uses matched with the selector's\ntolerant rule incl. legacy 'https' and no-uses generics), the suite\nlist is preserved from the highest-priority suite-bearing candidate\nwith only the minimum explicit @SECLEVEL composed on (no assumed\nruntime default level), and the operations API listener resolves from\noperationsApi.tls before root tls so an inherited-certificate override\nis no longer ignored.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:39:05Z",
          "url": "https://github.com/HarperFast/harper/commit/56a2bace9f27526d9066a1d05ff9161d012ecab6"
        },
        "date": 1784360808853,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6114.33,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9148.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9278.13,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6697.41,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4887.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9038.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1217.41,
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
          "id": "8b1c12b6b0de289f9b1657b3b66a9f43209adcb9",
          "message": "Merge pull request #1385 from HarperFast/kris/nextjs-caller-ci\n\nci: run Next.js adapter integration suite against harper PRs (downstream gate)",
          "timestamp": "2026-07-18T21:23:10Z",
          "url": "https://github.com/HarperFast/harper/commit/8b1c12b6b0de289f9b1657b3b66a9f43209adcb9"
        },
        "date": 1784447639216,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 8079.3,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 12100.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 12272.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 9222.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 6688.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 12216.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1587.52,
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
          "id": "1e2877d0f19535352d4e70b5a0db36388eee6ded",
          "message": "Merge pull request #1825 from HarperFast/fix/typed-resources-sandbox-exports\n\nfix(sandbox): wire the six typed-resources exports into the component sandbox",
          "timestamp": "2026-07-20T04:17:11Z",
          "url": "https://github.com/HarperFast/harper/commit/1e2877d0f19535352d4e70b5a0db36388eee6ded"
        },
        "date": 1784535304002,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6633.18,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9959.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10105.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7395.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5399.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10039.89,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1285.84,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "jcohen-hdb",
            "username": "jcohen-hdb",
            "email": "jacob@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "1e1edc666ad373a0fbfec4df4d3f0e130be13529",
          "message": "Ignore node_modules symlinked into integration fixtures by dev-mode boots\n\nharper dev <fixture> runs symlinkHarperModule against the component dir,\nplanting node_modules/harper inside integrationTests/fixtures/* — untracked\nand unignored, it has previously slipped into a commit (#1828 required an\namend). Discovered during runtime verification of this branch.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-20T18:56:00Z",
          "url": "https://github.com/HarperFast/harper/commit/1e1edc666ad373a0fbfec4df4d3f0e130be13529"
        },
        "date": 1784621042785,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 5890.3,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8447.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8452.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6599.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4784.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8522.96,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1039.08,
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
          "id": "2738680a414308b556ab10c19d9dedc5555077c3",
          "message": "Register the MCP durable quota policy as a function, not a config-referenced Resource (#1809) (#1821)\n\n* Register the MCP durable quota policy as a function, not a config-referenced Resource (#1809)\n\nThe quota hook was configured by `mcp.<profile>.quota.resource` pointing at an\nexported Resource, whose inherited CRUD then surfaced on every transport\n(update_/delete_ MCP tools + REST/SSE/WS/GraphQL/MQTT) — a permitted client\ncould reset its own counter. The docs example worked around it by turning six\nexportTypes flags off, which made the safe path the easy-to-forget one.\n\nReplace it with a registration function: `server.setMcpQuotaHandler(fn)`. The\npolicy is a plain function (never an exposed Resource), enabled by registering\nit (no config). checkDurableQuota invokes the registered handler; no handler =>\nallowed (opt-in), throw => fail-closed deny (unchanged). The handler receives\n`profile` so one handler can gate operations vs application.\n\n- Remove the `mcp.<profile>.quota.resource`/`.method` config params.\n- Wire `server.setMcpQuotaHandler` next to `server.registerOperation`.\n- Migrate the mcp-quota fixture off `tables.QuotaCounter`: an exported tool\n  (Answerer) + an internal (non-@export) counter table + a registered handler,\n  so nothing exposes the counter. Integration test asserts the counter is not\n  REST-reachable.\n\nSupersedes the docs#576 six-`false` example; docs follow-up separately.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Isolate the quota handler from deploy pre-flight validation; allow clearing (review)\n\nCodex review:\n- P1: the quota handler is a process-wide singleton, so a candidate component's\n  top-level server.setMcpQuotaHandler(...) during deploy pre-flight validation\n  would outlive the throwaway load and alter live enforcement on a failed deploy.\n  Snapshot the handler before the validation load and restore it in the finally\n  (added getMcpQuotaHandler()).\n- P2: the Server interface rejected undefined though the setter supports clearing;\n  widen the public type to McpQuotaHandler | undefined.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Test: assert the internal counter exposes no REST route and no MCP CRUD tools (#1809)\n\nCodify the security property the redesign delivers (and that /verify checked by\nhand): the counter table is internal, so GET /QuotaCounter 404s and tools/list\ncarries no QuotaCounter update_/delete_ tools a client could call to reset its\nquota. Tightened the counter-not-exposed assertion from !=200 to ==404.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Extract withMcpQuotaHandlerPreserved and unit-test the deploy-validation isolation (#1809)\n\nThe P1 snapshot/restore was inline in the deploy op and only its get/set primitive\nwas covered. Extract it into withMcpQuotaHandlerPreserved(fn) — operations.js wraps\nthe throwaway validation load in it — and unit-test the isolation directly: a\ncandidate that registers a different handler, one that clears it, and a load that\nthrows all leave the live worker's handler intact.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Simplify quota-handler wiring; note the snapshot-restore tradeoff (review)\n\n/code-review: assign server.setMcpQuotaHandler directly instead of a redundant\nwrapper (also keeps the impl param type in sync with the Server interface's\nMcpQuotaHandler | undefined). Document that withMcpQuotaHandlerPreserved restores\nunconditionally, so a legitimate interleaving registration would be reverted — a\nnarrow window, and the lesser evil vs leaking a candidate policy live.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Generalize deploy-validation isolation to all process-wide server.* registrations (#1809)\n\n/code-review #3: the deploy pre-flight snapshot/restore only isolated the quota\nhandler; a candidate's server.registerOperation during the throwaway validation\nload still mutated the process-wide operation map AND announced to the main thread,\nleaking onto the live worker on a failed deploy.\n\nReplace the quota-specific withMcpQuotaHandlerPreserved with a general guard\n(deployValidationState.ts): server.registerOperation and server.setMcpQuotaHandler\nboth no-op while a validation load is in flight (validation only needs to surface\nload-time errors, not register anything). operations.js wraps the validation load\nin runWithDeployValidationGuard. Skipping is cleaner than snapshot/restore here —\nit also suppresses the cross-thread operation announce, which a local restore can't\nundo. Depth-counted; the narrow interleaving caveat is documented.\n\nTests: registerOperation + setMcpQuotaHandler are skipped during validation and\nresume after (incl. after a thrown load), in serverUtilities.test.js.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-22T04:07:08Z",
          "url": "https://github.com/HarperFast/harper/commit/2738680a414308b556ab10c19d9dedc5555077c3"
        },
        "date": 1784707323728,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7380.48,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9733.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9870.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7520.06,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5495.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9650.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1195.82,
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
          "id": "cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa",
          "message": "Fix indentation drift in getStringPrefixUpperBound\n\nApplying Gemini's suggested diff verbatim left the function body one\ntab shallow, failing prettier --check.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-22T11:50:18Z",
          "url": "https://github.com/HarperFast/harper/commit/cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa"
        },
        "date": 1784793876515,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6476.62,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8208.81,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8213.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6767.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4974.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8185.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1035.08,
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
          "id": "b8c843a24a4b2b3f002a2b786415333fd7f3b597",
          "message": "fix(query): stop query planning from mutating the caller's conditions (#1911)\n\n* fix(query): stop query planning from mutating the caller's conditions\n\nTable.search()/get() took the caller's conditions by reference and annotated\nthem in place as it planned the query: it pushes a `{ comparator: 'sort' }`\npseudo-condition for index-order alignment, sets `descending`, caches\n`estimated_count`, collapses chained conditions, and coerces values — all on\nthe caller's entry objects. A caller that reuses the same array or condition\nobjects across queries (a natural pattern for a module-level `const`) then hits\nleaked state: a kept sort pseudo-condition is treated as a real valueless\ncondition and throws `Invalid value for attribute … \"undefined\"`; a stale\n`descending` silently reverses a later scan; a cached `estimated_count`\nmisplans. Whether it surfaced depended on live index estimates, so it read as\nphantom nondeterminism.\n\nClone the conditions array and every entry (recursing into nested and/or groups)\nat intake, so all downstream planning mutation happens on our own objects and\nnever reaches the caller. Entries are small and shallow, so the copy is\nnegligible next to the query itself.\n\nFixes harper#1572.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* test(query): make the array-form target guard assert entry immutability\n\nPost-review follow-up. The array-form-target regression case only checked array\nlength + absence of a sort pseudo-condition, which don't change on that path\n(no sort → no push) — so it passed with or without the fix. Assert instead that\nthe caller's condition entry is untouched: its Date-typed bound stays the\noriginal string (not coerced in place) and no estimated_count is annotated. Now\nfails on origin/main and passes with the fix, like the other three cases.\n\nAlso note in cloneConditions why chainedConditions sub-entries are left shared\n(read-only during planning).\n\nComment generated by kAIle (Claude Opus 4.8)\n\n* refactor(query): hoist cloneConditions to module scope; plain node:assert in test\n\nReview follow-up (both non-blocking):\n- cloneConditions is stateless (no closure over search/makeTable), so hoist it\n  to module scope rather than re-creating the function on every search() call.\n- Use plain node:assert in the regression test per house style, with explicit\n  strictEqual/deepStrictEqual where strict semantics are wanted.\n\nComment generated by kAIle (Claude Opus 4.8)\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-24T00:33:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b8c843a24a4b2b3f002a2b786415333fd7f3b597"
        },
        "date": 1784880133211,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7100.73,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9377.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9499.62,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7397.67,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5475.5,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9353.68,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1194.81,
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1784965931707,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7033.55,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9221.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9644.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7266.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5394.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9467.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1280.61,
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1785053146452,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6282.24,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8041.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8106.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6560.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4773.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8008.39,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 984.99,
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
          "id": "fe3994f4031714027098f6ce250fa78e1264107b",
          "message": "test(txn): afterEach stub-restore safety net + unref race timers (bot review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-18T14:13:10Z",
          "url": "https://github.com/HarperFast/harper/commit/fe3994f4031714027098f6ce250fa78e1264107b"
        },
        "date": 1785140776387,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6443.49,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8252.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8216.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6762.93,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4963.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8269.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1027.27,
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
          "id": "e1a0cae0bda2596a77bf0b450ed6b2dc4039035d",
          "message": "test(packaging): make manifest assertions robust",
          "timestamp": "2026-07-23T21:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/e1a0cae0bda2596a77bf0b450ed6b2dc4039035d"
        },
        "date": 1785225935275,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7338.4,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9802.31,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9966.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7564.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5575.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9644.51,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1253.87,
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
          "id": "35c1f423b9e05ac858ec14bec4346d06d274c2e1",
          "message": "fix(cli): refresh expired agent tokens; fix --once approval hang\n\nAddress heskew's two remaining non-blocking review notes on #1553:\n\n- `harper agent` hard-failed on an expired stored operation token instead\n  of self-healing via the refresh_token, unlike cliOperations.ts. Extract\n  the refresh logic into a shared `refreshExpiredOperationToken` helper in\n  cliOperations.ts and call it from both cliOperations and agentCli, so the\n  two transports can't drift again.\n- `--once` against a real TTY drains stdin via readAllStdin() before the\n  first turn; if that turn then needed approval, resolveApprovals() built a\n  new readline on the already-ended stdin and question() never resolved.\n  Track actual stdin consumption (opts.stdinConsumed) instead of relying on\n  isTTY, and fail loudly in that case like the non-TTY path already does.\n\nRefs #1553\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T13:58:29Z",
          "url": "https://github.com/HarperFast/harper/commit/35c1f423b9e05ac858ec14bec4346d06d274c2e1"
        },
        "date": 1785312631817,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6621.34,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8539.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8489.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7013.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5130.15,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8498.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1057.4,
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
          "id": "b04af4d08dc96ffd6f657991b4fe105528e88c98",
          "message": "Merge pull request #1956 from HarperFast/fix/instance-post-create\n\nfix(resources): restore v4 super.post create on collection posts",
          "timestamp": "2026-07-29T23:58:36Z",
          "url": "https://github.com/HarperFast/harper/commit/b04af4d08dc96ffd6f657991b4fe105528e88c98"
        },
        "date": 1785398631360,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6519.29,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8344.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8508.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6897.21,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5058.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8485.05,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1041.18,
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
          "id": "fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:46Z",
          "url": "https://github.com/HarperFast/harper/commit/fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20"
        },
        "date": 1785485344602,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 11562.27,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 17925.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 18471.97,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 11662.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 8740.11,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 16495.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1866.23,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "8dc2fa61797ce88a49ec6c9c0c8c847b6c116886",
          "message": "Document legacy compression metadata semantics in DESIGN.md\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-31T23:42:40Z",
          "url": "https://github.com/HarperFast/harper/commit/8dc2fa61797ce88a49ec6c9c0c8c847b6c116886"
        },
        "date": 1785544018707,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7423.32,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9794.92,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9820.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7695.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5717.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9709.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1268.17,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785571072577,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7387.57,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 10008.74,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 10182.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7771.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5764.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9910.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1298.15,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785657763115,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6098.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 7850.88,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 7932.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6416.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4747.46,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 7841.01,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 965.97,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785745478796,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6431.7,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8173.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8349.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6799.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4967.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8202.2,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1022.06,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "5db8251124f186d88b8c925dc923cd051bde71a0",
          "message": "chore(deps): update dependency @harperfast/integration-testing to ^0.7.0 (#2053)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-04T06:31:32Z",
          "url": "https://github.com/HarperFast/harper/commit/5db8251124f186d88b8c925dc923cd051bde71a0"
        },
        "date": 1785830886153,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6410.11,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8299.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8307.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6716.64,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4903.41,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8188.11,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1019.62,
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
          "id": "1201afb01221c87fd298babef05d12e38dc99755",
          "message": "Close remaining bypass_auth trust gaps in MCP tokens and SQL AST checks\n\nTwo review findings on the operation-authorization refactor:\n- createTokens() still trusted a caller-supplied authObj.bypass_auth\n  field, and MCP's tool handler didn't strip it — an MCP caller could\n  spoof bypass_auth and mint tokens for an arbitrary username without a\n  password. createTokens now reads only the trusted ALS-scoped\n  isOperationAuthorizationBypassed() state; MCP strips bypass_auth/\n  bypassAuth from tool args before dispatch as defense in depth.\n- processAST() still read jsonMessage.bypass_auth from the body, so\n  trusted authorize=false SQL calls (via legacy differential dispatch)\n  were being re-authorized. processAST now consults the same ALS-scoped\n  bypass state; differential.ts's runLegacy wraps evaluateSQL in\n  runWithOperationAuthorizationBypass instead of passing bypass_auth in\n  the message body.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-27T15:25:19Z",
          "url": "https://github.com/HarperFast/harper/commit/1201afb01221c87fd298babef05d12e38dc99755"
        },
        "date": 1785917359912,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6280.42,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8095.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 7730.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6513.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4935.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8066.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1027.84,
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
          "id": "ffef12f8c8992eb86c5014d85d4bd273df8f18d5",
          "message": "Test Bun resolution candidate tracking directly\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-05T00:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/ffef12f8c8992eb86c5014d85d4bd273df8f18d5"
        },
        "date": 1785933862956,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7224.03,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9603.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9802.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6989.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5245.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9803.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1235.34,
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
          "id": "01d8562225c88abe8d62ba37e520aa5b289f76c7",
          "message": "Merge pull request #2075 from HarperFast/david/last-super-user-guard\n\nReject user and role changes that would remove the last active super_user",
          "timestamp": "2026-08-05T21:25:48Z",
          "url": "https://github.com/HarperFast/harper/commit/01d8562225c88abe8d62ba37e520aa5b289f76c7"
        },
        "date": 1786003597558,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7151.68,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9590.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9374.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7026.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5172.63,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9701.54,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1228.22,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f85e66b92abda03b6dd7cbcfde05e09a46215da7",
          "message": "chore(deps): raise msgpackr floor to ^2.0.5\n\nThe published harper@5.2.0 shipped an npm-shrinkwrap.json pinning\nmsgpackr 2.0.4. main's package-lock.json already resolves 2.0.5\n(bumped after the v5.2.0 tag in a264242b4 as an npm-install side\neffect of ^2.0.4), so the next release cut from main already ships\n2.0.5. This raises the declared floor to ^2.0.5 to make that intent\nexplicit and guard against a future lock regeneration ever pinning\nbelow 2.0.5. No functional change; the resolved lock entry is\nunchanged.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-06T16:19:21Z",
          "url": "https://github.com/HarperFast/harper/commit/f85e66b92abda03b6dd7cbcfde05e09a46215da7"
        },
        "date": 1786088620656,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7846.21,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 11051.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 11117.36,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7662.05,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5659.01,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10465.57,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1220.25,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786174403354,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7921.23,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 11255.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 11026.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7790.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5714.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 10747.25,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1291.4,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786260905337,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6909.31,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9552.51,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9639.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7069.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5228.79,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9790.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1280.31,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786348090420,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6171.66,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8298.42,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8280.77,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6542.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4745.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8500.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 997.43,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786434053003,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7266.67,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9763.26,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9905.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7025.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5186.85,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9670.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1254.29,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "0a727e8bd5931e9266344b757a8680f50f5980ff",
          "message": "fix(deps): update dependency argon2 to v0.45.1 (#2132)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-12T01:50:06Z",
          "url": "https://github.com/HarperFast/harper/commit/0a727e8bd5931e9266344b757a8680f50f5980ff"
        },
        "date": 1786520843544,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6305.06,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8146.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8210.75,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6265.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4553.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 7961.24,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1000.74,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "09c4580106cc399ea7a4dd7132361a61d2d2d561",
          "message": "Merge pull request #2124 from HarperFast/fix/sql-engine-top-limit-normalization\n\nfix(sql-engine): honor SELECT TOP n and floor fractional LIMIT/OFFSET",
          "timestamp": "2026-08-12T22:47:19Z",
          "url": "https://github.com/HarperFast/harper/commit/09c4580106cc399ea7a4dd7132361a61d2d2d561"
        },
        "date": 1786607091316,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 7027.71,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 9489.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 9263.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 7016.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 5121.18,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 9811.08,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1221.06,
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
          "id": "871fad0fa2ece52e4adfbfa102536c54560c67e3",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:23:55Z",
          "url": "https://github.com/HarperFast/harper/commit/871fad0fa2ece52e4adfbfa102536c54560c67e3"
        },
        "date": 1786693636959,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6368.96,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8105.8,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 7820.35,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6192.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4433.66,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8042.72,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 968.38,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786778865787,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6240,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8084.44,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 7896.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6248.47,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4394.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8188.23,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 943.95,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786865313433,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6463.85,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8226.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8251.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6445.29,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4646.58,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 7960.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 1024.54,
            "unit": "ops/sec"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786952265526,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6385.26,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8256.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8301.07,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6298.14,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4471.08,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8250.3,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 993.78,
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
          "id": "058ba377b18446b557fc1b8d3f11ff0683bf2686",
          "message": "Pin the load-bearing native and encoder dependencies (#2179)\n\n* chore(deps): pin the load-bearing native and encoder dependencies\n\nA caret range means the manifest gate does not bind. harper-pro, a container\nrebuild, and anyone installing published harper without this lockfile all\nresolve to whatever is newest at install time, so a rocksdb-js or msgpackr\nminor reaches a running node with no Harper PR and no human merge.\n\nThat is the mechanism behind 5.1.22 shipping rocksdb-js 2.4.0 while the\ncross-column-family read fix was in 2.5.0: the pin permitted the fix and the\nimage predated it. The same latitude equally admits a regression.\n\nextended-iterable is pinned for a sharper reason than the rest. rocksdb-js\nrequires exactly 1.0.3 while the root asked for ^1.0.1, so the day 1.0.4\npublishes a fresh resolution hoists 1.0.4 for the root and nests 1.0.3 under\nrocksdb-js — two modules, two SKIP sentinels. A vector query whose candidate\nrecord was deleted then returns harper's SKIP into a map() belonging to\nrocksdb-js's ExtendedIterable, which does not recognise it and emits the\nsentinel as a result row: a phantom record on the read path, no exception and\nno log line. msgpackr has the same shape via its extension registry, where the\nnested copy never saw addExtension for Blob.\n\nupdate-rocksdb-js.yml gains --save-exact. It ran `npm install --save`, and with\nno .npmrc the default save-prefix of ^ applies, so the next rocksdb-js release\nwould have rewritten 2.7.1 back to ^2.8.0 and reverted this commit unattended.\n\nEvery pin is the version the lockfile already resolved, so no dependency moves\nhere; only the range narrows. lmdb, cbor-x, ordered-binary, alasql and argon2\nwere already exact.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n* fix(build): keep shrinkwrap canaries discriminating\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): fail closed on unresolved canary queries\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): back off dependency canary retries\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): enforce rocksdb encoder alignment\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* test(build): keep alignment fixtures version-agnostic\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* test(build): cover ranged encoder regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Handle npm E404 in dependency canary check\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Harden dependency canary registry responses\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-18T02:44:24Z",
          "url": "https://github.com/HarperFast/harper/commit/058ba377b18446b557fc1b8d3f11ff0683bf2686"
        },
        "date": 1787038319799,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "load — bulk insert",
            "value": 6359.84,
            "unit": "records/sec"
          },
          {
            "name": "workload C — Read only (100% read)",
            "value": 8267.95,
            "unit": "ops/sec"
          },
          {
            "name": "workload B — Read mostly (95% read / 5% update)",
            "value": 8063.16,
            "unit": "ops/sec"
          },
          {
            "name": "workload A — Update heavy (50% read / 50% update)",
            "value": 6400.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload F — Read-modify-write (50% read / 50% read-modify-write)",
            "value": 4614.4,
            "unit": "ops/sec"
          },
          {
            "name": "workload D — Read latest (95% read / 5% insert), read recently inserted",
            "value": 8352.9,
            "unit": "ops/sec"
          },
          {
            "name": "workload E — Short ranges (95% scan / 5% insert)",
            "value": 996.17,
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
        "date": 1783755721057,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 9.29,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.7,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 14.17,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 20.78,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 8.65,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 9.58,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 24.92,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 9.72,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 12.62,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 96.02,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.02,
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
          "id": "31de6a3bebc5fec85a8eba98087fda00dbc3f477",
          "message": "fix: pin uWebSockets.js via tarball URL, not a github: git spec\n\nSame issue as harper-pro#561: the github: shorthand\n(github:uNetworking/uWebSockets.js#v20.68.0) gets re-resolved by npm as\ngit+ssh://github.com/... on any npm install. Our Docker build stage has\nno SSH credentials for github.com, so npm silently skips the (optional)\ndependency and the shipped image never bundles the native addon —\nHARPER_UWS_UDS / HARPER_UWS_HTTP are inert even when set.\n\nAn explicit git+https:// spec doesn't fix this either — confirmed with\na clean npm cache that npm/hosted-git-info canonicalizes ANY\ngithub.com git dependency back to git+ssh:// regardless of requested\nprotocol. Switching to a plain tarball URL\n(https://.../archive/<sha>.tar.gz) sidesteps hosted-git-info entirely:\nnpm treats it as a remote-tarball dependency, resolved stays a plain\nhttps URL with a pinned integrity hash, and it can't regress on a\nfuture npm install.\n\nVerified npm ci installs all 15 native .node binaries in a\nHOME-stripped, credential-less environment (matching the Docker build\nstage) both before and after a full npm install regenerates the\nlockfile from package.json.",
          "timestamp": "2026-07-10T21:38:26Z",
          "url": "https://github.com/HarperFast/harper/commit/31de6a3bebc5fec85a8eba98087fda00dbc3f477"
        },
        "date": 1783843153599,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.77,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.38,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.02,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.42,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.09,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.65,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.09,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.65,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.87,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.92,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 159.81,
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
          "id": "8bf5921e06349611773b4c1d4363088801d3b974",
          "message": "ci(review): canary Claude reviews on claude-sonnet-5 (harper only) (#1759)\n\nOverride the reusable's model default (claude-sonnet-4-6) for this\nrepo's claude-review caller. harper is the A/B canary: highest review\ntraffic, and every ai-review-log entry records Model:, so calibration\ncan compare sonnet-5 vs sonnet-4-6 verdict mix directly at the same\nprompt ref (9cf49d2). Intro pricing ($2/$10 through 2026-08-31) offsets\nthe new tokenizer (~30% more tokens for equivalent text).\n\nWatch item: Sonnet 5 follows blocker-only severity instructions more\nliterally (documented code-review-harness effect) — if the deflation\nrate rises in the next calibration cycle, add coverage-first reporting\nto the run-notes surface before fleet rollout; if clean, promote to the\nreusable default.\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-13T00:05:21Z",
          "url": "https://github.com/HarperFast/harper/commit/8bf5921e06349611773b4c1d4363088801d3b974"
        },
        "date": 1783930272475,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 7.59,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 7.45,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 11.22,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 7.8,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 15.15,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 7.54,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 17.48,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 7.78,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 10.14,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 83.42,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 39.72,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "56f8891b933e4638c9f622a0030570de4fd711a8",
          "message": "fix(deps): update all non-major dependencies",
          "timestamp": "2026-07-13T23:29:07Z",
          "url": "https://github.com/HarperFast/harper/commit/56f8891b933e4638c9f622a0030570de4fd711a8"
        },
        "date": 1784015437164,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.06,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.61,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 21.64,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.77,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.36,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.89,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.01,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.79,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.93,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 175.43,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.22,
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
          "id": "182971ad16a3ba6986ffae194067965505d5bfa8",
          "message": "Typed, discoverable resources — code-first defineTable + per-method request contract (RFC 0001) (#1767)\n\n* feat(resources): typed, discoverable resources — code-first defineTable + per-method request contract\n\nImplements RFC 0001 (design PR #1503): the mergeable implementation of both\nauthoring front-ends, integrated onto current main.\n\nPillar 1/2b — code-first schema (resources/defineTable.ts):\n  `defineTable(name, shape, opts)` + `types` author a table in TypeScript and\n  eagerly register through the same `table()` factory GraphQL drives — the return\n  IS the live class, with per-verb shapes inferred as `$record/$insert/$upsert/\n  $patch/$query` projections. Relations via lazy thunks (+ relationOf/hasManyOf\n  escape hatch for mutual pairs).\n\nPillar 2 — per-method request contract (resources/withSchema.ts):\n  `defineResource(contract, impl)` (function form) + `Resource.withSchema(contract)`\n  (class form). Handler types are derived from a runtime contract; a handler gets\n  the SAME RequestTarget, structurally narrowed (subset, not fork). Each declared\n  verb validates/coerces query/body before dispatch and throws a structured 400\n  (ValidationError, per-field {path,code,message}[]). Built-in `t`/`schemaOf`\n  reduce to JsonSchemaFragment — one vocabulary across table fields, query, and\n  bodies; a defineTable projection slots into a contract body via\n  schemaOf({ table, projection }). Nullability: non-nullable by default, `.nullable`\n  opts into null (table-derived bodies mirror Table.validate).\n\nCross-cutting:\n  - ValidationError (extends ClientError, 400); Table.validate refactored to the\n    same structured shape (HTTP-title message preserved).\n  - OpenAPI emits declared query/body/response for parameterised routes.\n  - MCP drives tool input/output off the contract and binds arbitrary path params\n    + query (applyContractInputs), lifting the generated-verb binding restriction\n    for contract resources.\n  - Shared attributeToFragment hardened with a nested-object branch; derive.ts\n    Object/Array projection bugfix.\n\nIntegration with main (the RFC branch was ~1007 lines behind on these files):\n  merged with main's newer MCP paramroutes work (paramBinding gating, isSimpleIdRoute,\n  mcpResources) and the liveResource authz fix — a request contract now exempts a\n  resource from the generated-handler binding restriction.\n\nDesign summary in resources/DESIGN.md; full RFC + type spikes remain in #1503.\nType contract verified against built exports in docs/rfcs/spikes/0001/*-real.check.ts.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(withSchema): address PR review — validation hardening + lint-safe test import\n\n- scope the Date type-check exception to string/date-time fields (a Date must not\n  pass validation for number/boolean/array/object schemas)\n- override target.getAll alongside get so multi-value query params read coerced\n- reject empty/whitespace numeric query params instead of Number('')→0\n- harden MCP wrapError: read the untrusted err's props inside a try/catch (revoked\n  Proxy / throwing getters must not crash the error path)\n- application-contract.test.js: require('assert') + strict methods (node:assert/strict\n  is oxlint-banned via no-restricted-imports)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor: rename withSchema.ts → defineResource.ts; drop spike/RFC artifacts\n\n- rename resources/withSchema.ts → resources/defineResource.ts (defineResource is\n  the primary API; Resource.withSchema stays the class-form name) + the test file\n- remove docs/rfcs/ (the *-real.check.ts type-contract proofs + tsconfig) — a real\n  PR shouldn't carry spike/RFC scaffolding; those live in the design PR (#1503)\n- strip references to the spikes and the RFC doc (which are not in this PR) from\n  code/test comments and resources/DESIGN.md; keep the #1503 pointer for the record\n\nNo behavior change. 100 unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(types): re-add public type-contract tests + wire into CI\n\nStandalone type-tests under unitTests/types/ (no spike/RFC framing): assert the\nSHIPPED public types (imported from the built dist) against the contract —\ndefineTable projections + relations, and the defineResource/withSchema handler\ninference, narrowed target, subset property, and negative (@ts-expect-error) cases.\n\n- unitTests/types/{defineResource,defineTable}.type-test.ts + tsconfig.json (strict,\n  noEmit, skipLibCheck; isolated from the main build/typecheck, which don't include\n  unitTests/, and from mocha, which only loads js/mjs)\n- `npm run test:types` (tsc --project unitTests/types/tsconfig.json)\n- CI: a \"Type contract tests\" step in unit-test.yml (after Build, gated to one Node\n  version) so a regression in the public type surface fails CI\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-14T19:37:17Z",
          "url": "https://github.com/HarperFast/harper/commit/182971ad16a3ba6986ffae194067965505d5bfa8"
        },
        "date": 1784101946221,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.8,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.34,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.6,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.1,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.52,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.35,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.58,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.67,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.96,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.57,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 173.17,
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
          "id": "3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02",
          "message": "Reshape deploy_component registryAuth into a general-purpose credentials array (#1797)\n\n* Reshape deploy_component registryAuth into a general-purpose credentials array\n\n`registryAuth` was an npm-only array of `{ registry, token|secret, scope }`\nentries. Rename it to `credentials` and treat the array as kind-heterogeneous:\nan entry's kind is implied by its identifying key (`registry` = npm registry\nauth) rather than a discriminator field, so a git-host kind keyed by `host`\n(#1792) becomes another item alternative rather than another schema rewrite.\n\nThe ingest/resolve pipeline, secrets-store integration, reference-only\nreplication, and every security invariant from #1717 are unchanged — this is a\nrename plus the seams for a second kind. Identifiers follow: ingestRegistryAuth\n→ ingestCredentials, resolveRegistryAuth → resolveCredentials, and the persisted\nforms (applicationConfig.credentials, hdb_deployment.credentials) match the\noperation field.\n\nSince #1717 has not shipped in a GA release, this is a clean break rather than an\nalias. Because operation validation allows unknown keys, a stale `registryAuth`\nis explicitly rejected — otherwise the deploy would silently install with no\ncredentials. It also stays in the operations-log strip list, since that redaction\nruns ahead of validation and a stale caller's token must not reach the log.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Filter Application.registryCredentials to registry-shaped entries\n\nThe credentials array is kind-heterogeneous by design (registry today,\na planned git-host kind later), but Application's constructor assigned\nit straight to registryCredentials, which buildNpmrcContent assumes is\nregistry-shaped. Filter defensively so a future non-registry entry\ncan't reach it.\n\nAddresses gemini-code-assist review comment on PR #1797.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Authenticate private git-reference deploys from an in-memory credential (#1799)\n\n* Authenticate private git-reference deploys from an in-memory credential\n\nA `github:org/repo` package against a private repo needs a credential for the\n`git ls-remote`/`git clone` npm shells out to. Every obvious way to supply one\npersists it: userinfo in the URL lands in the package spec and the lockfile, a\ncredential helper or `.npmrc` is a file, and an env var is readable by every\ndescendant process.\n\nInstead the token stays in the deploying process's memory and is served over a\nper-deploy Unix socket in a 0700 directory. git is pointed at\ngitCredentialHelper.js — a secret-free script that relays git's request over\nthat socket — and the socket dies with the spawn that needed it. The token\nreaches disk, argv, the package spec, the operation body and the operations log\nnowhere along the way.\n\nThe credential rides as a second kind in the `credentials` array from #1797:\n`{ host, token|secret, username? }`, discriminated by `host` the way npm entries\nare by `registry`. Ingest, seal-into-hdb_secret, grant-check, resolve-at-use and\nreplicate-as-reference are the existing #1717 paths, unchanged — only the\nderived secret name (`deploy.<component>.<host>`) and the injection mechanism are\nnew. resolveCredentials now rejects an unrecognized kind rather than resolving it\ninto a half-empty entry, symmetric with the guard ingestCredentials already had.\n\nWiring, in order of preference: `credential.helper` via GIT_CONFIG_* (structured\nkey=value protocol, no prompt parsing) with GIT_ASKPASS as the fallback for git\n< 2.31, which ignores GIT_CONFIG_*. Inherited credential helpers are reset to\nempty first, so a machine configured with `credential.helper=store` cannot write\nthis token to ~/.git-credentials when git reports the successful authentication\nback to its helper chain. The askpass path decides username-vs-password prompt\nstructurally (userinfo present in the echoed URL) rather than by matching\nEnglish, since git localizes those prompts.\n\nOnly the spawn that clones (`npm pack`) is given this environment. The\n`npm install` that follows — where a dependency's install script can run — never\nsees it, and the socket is already closed by then.\n\nRefs #1792. Stacked on #1797.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Keep the git credential out of reach of clone-time install scripts\n\nPacking a git reference is not just a download. npm clones the repo and, when\nits manifest has a prepare/build/install script, runs `npm install` inside the\nclone and then that script — so the repository's own code and its dependencies'\ninstall scripts execute on this node, inside the clone spawn, inheriting its\nenvironment. Verified against real npm: a transitive dependency's `preinstall`\nsees HARPER_GIT_CREDENTIAL_SOCKET and can ask the socket for the token. That is\nexactly the reach #1792 says the credential must not have, and closing the\nsocket before `npm install` did not close it, because this all happens earlier,\nduring `npm pack`.\n\nSo a credentialed clone runs with `--ignore-scripts` unless the deploy set\ninstall_allow_scripts, which is the operator explicitly asking for that code to\nrun here; that case is allowed and logged, naming the exposure it accepts. Note\nthis also means a git-reference deploy runs scripts at pack time regardless of\ninstall_allow_scripts today — the flag only ever reached the install spawn. That\ninconsistency is left alone here (fixing it changes behavior for existing public\ngit deploys) but is worth its own issue.\n\nWindows now fails closed instead of serving the credential over a named pipe: a\npipe is created with a default security descriptor that can leave it readable by\nother local users, and the whole confinement argument rests on the 0700\ndirectory a Unix socket sits in. Better to refuse than to offer a quietly weaker\nchannel.\n\nAlso from review: cap the request a peer can stream at the socket (an unbounded\n`request +=` was an OOM), and remove the socket's temp directory when listen()\nfails, since no session is returned and nothing would otherwise clean it up.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Harden the git credential channel against persistence and downgrade\n\nA second cross-model review pass (Codex) surfaced several ways the credential\ncould still escape memory:\n\n- **Cleartext transport.** git asks for `http://` credentials exactly as it\n  asks for `https://`, so a `git+http://` package (or a remote downgraded by a\n  redirect) would put the token on the wire in the clear. answerFor now serves\n  only over https, with an exemption for loopback (where no network is involved\n  and the integration tests run).\n\n- **git < 2.31.** Those versions ignore GIT_CONFIG_* entirely, so the\n  credential.helper reset that stops an inherited `store` helper from writing the\n  token to ~/.git-credentials is silently dead — and the GIT_ASKPASS fallback\n  would still feed that helper a successful credential to persist. There is no way\n  to disable an inherited helper on those versions, so the session now refuses to\n  start on one rather than leak. (The reset itself is verified end-to-end against\n  a real clone with both a global and a URL-scoped `store` helper configured; the\n  earlier concern that a URL-scoped helper bypasses the reset did not reproduce —\n  git's credential machinery honors the reset, `--get-urlmatch` merely shows raw\n  config.)\n\n- **Newline in a resolved token.** A literal token is schema-rejected for CR/LF,\n  but one resolved from an hdb_secret row was not — and git's protocol is\n  line-based (askpass reads only the first line), so such a token would truncate\n  or inject protocol attributes. Guarded at the serve boundary, matching the\n  .npmrc writer.\n\n- **Unknown keys persisting.** Operation validation runs allowUnknown, so a\n  credential entry like `{host, secret, password: \"literal\"}` would carry that\n  stray field through ingest into config, hdb_deployment, and replication. Both\n  entry schemas are now `.unknown(false)`, and each forbids the other's\n  discriminator. assertApplicationConfig likewise rejects an entry that is both\n  kinds or carries a literal token, rather than coercing it to one kind.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Warn on duplicate git-credential hosts; lock in the no-custody strip\n\nReview follow-ups. Two entries for the same host in one deploy silently\nlast-write-wins (they also seal to the same derived secret name), so warn rather\nthan drop quietly. And a regression test pins the security property that a\nliteral git token on a node without custody yields no persistable reference and\nis therefore stripped from the replicated op body.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Address 5 review comments; fix a backpressure bug hanging the OOM-cap test\n\n- close(): snapshot the connections Set before destroying, so destroy()'s\n  synchronous 'close' listener (which deletes from the same Set) can't skip\n  a connection mid-iteration.\n- answerFor(): guard against a non-object request before touching .host.\n- parseAskpassPrompt(): move the URL parse+decode inside the existing\n  try/catch so a malformed percent-encoded username can't throw past it.\n- gitCredentialClone.test.js: resolve GIT_HTTP_BACKEND in a try/catch so a\n  missing git binary can't crash the whole suite loader before before()\n  gets a chance to skip; before() now also checks for that case.\n- operationsValidation.js: cap the git credential entry's token at\n  SECRET_MAX_LENGTH, matching the same limit already applied elsewhere.\n\nAlso fixes an unrelated pre-existing bug found while verifying: the OOM-cap\ntest's write loop gave up permanently the first time socket.write() returned\nfalse for backpressure (the `&&` chain short-circuits), which happens well\nbefore the server-side 64KB cap is reached — so the test hung forever\nwaiting for a 'close' the server had no reason to send. Confirmed via a\nclean-checkout diff that this predates this task's changes. The production\ncap-enforcement logic itself was already correct; only the test's flow\ncontrol was wrong. Now resumes writing on 'drain' instead of giving up.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Update components/secretOperations.ts\n\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Fix CI: git-secret naming test drift, and prepare-script leak on npm<11\n\nsecretOperations.test.js still asserted the pre-review-fix secret name\n(deploy.<app>.<host>); a prior commit on this branch added the `.git`\nkind segment to deriveGitSecretName to close a same-host collision\nbetween git and registry secrets (per review), but didn't update the\ntests that pin the literal name. Update the 5 affected assertions to\nthe new, collision-safe name and note why in deriveGitSecretName's doc\ncomment.\n\nAlso fix a real Node-22-only failure: a credentialed git clone relied\non `npm pack --ignore-scripts <git-url>` to keep a repository's\nprepare script from running while the credential socket is reachable.\npacote's DirFetcher runs `prepare` unconditionally on npm <11.0.0 (the\nignoreScripts guard was only added upstream in npm 11) — exactly what\nNode 22's bundled npm ships, confirmed by reproducing against the real\nnpm 10.9.8 binary. For a recognized git-reference identifier with\nscripts disallowed, clone it ourselves (still authenticated via the\ncredential session's env) and strip its lifecycle scripts before\npacking, sidestepping the buggy npm code path entirely — the same\nmechanism harper#1819 lands for the uncredentialed case.\n\nVerified against npm 10.9.8: the prepare-script test fails identically\nto CI on the pre-fix code and passes reliably with the fix.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Resolve hosted-git shorthand (github:/gitlab:/bitbucket:/gist:) in parseGitReference\n\nderivePackageIdentifier defaults a bare owner/repo package identifier to\ngithub:owner/repo, but parseGitReference only recognized explicit\ngit+.../git:// URL forms, so that shorthand — the PR's own worked example —\nfell through to the npm pack --ignore-scripts fallback documented as\nunreliable on npm <11. Extend parseGitReference to resolve github:, gitlab:,\nbitbucket:, and gist: shorthand to a concrete https clone URL so it routes\nthrough the clone-and-strip-scripts path instead.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Resolve npm-style semver: committishes before git checkout\n\n#1799's own worked example (`github:my-org/my-app#semver:v1.2.3`) documented a\ncommittish naming a semver range, but packGitReferenceWithoutScripts passed it\nstraight to `git checkout`, which has no notion of npm's `semver:` syntax and\nsimply failed.\n\nAdds resolveCommittish(), which lists the clone's tags and resolves the range\nagainst them with the `semver` package (already a direct dependency), matching\nnpm's own git-dependency resolution: tags may carry a prefix ahead of the\nversion (`release-v1.2.3`), a percent-encoded range is decoded, and the\nresolved ref is checked out as `refs/tags/<name>` to avoid an ambiguous\nsame-named branch. A non-semver committish is unaffected.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Reject unsafe tag names before checkout in semver-committish resolution\n\nThe automated PR review on the previous commit found that resolveCommittish\nonly validated the semver-shaped suffix it matched in a tag name (e.g. the\n`v1.2.3` in `release-v1.2.3`), not the full tag string. Since git ref names\npermit shell metacharacters (`$`, backticks, `;`, `&`, `|`, parens — only\nwhitespace and a few other forms are disallowed), and nonInteractiveSpawn\nruns through a shell with no argument escaping, a tag name from the cloned\nrepository such as `$(touch${IFS}/tmp/x)v9.9.9` would execute as a command\nsubstitution on checkout — reachable specifically because semver resolution\npicks a tag out of the (untrusted, upstream) repo's own tag list, unlike a\nliteral committish which the deploying operator supplies directly.\n\nAdds a conservative safe-charset check on the full tag name; a tag failing\nit is excluded from resolution rather than sanitized, so it can never reach\nthe checkout spawn. Confirmed exploitable pre-fix (marker file executes) and\nblocked post-fix via a new regression test.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-15T23:03:58Z",
          "url": "https://github.com/HarperFast/harper/commit/3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02"
        },
        "date": 1784188505597,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.64,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.74,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.56,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.69,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.43,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.73,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.8,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.05,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 53.76,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 145.7,
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
          "id": "1df0df5609a20664029fa21e5ccb3e76e903f5b7",
          "message": "Release v5.2.0-alpha.6",
          "timestamp": "2026-07-17T00:33:58Z",
          "url": "https://github.com/HarperFast/harper/commit/1df0df5609a20664029fa21e5ccb3e76e903f5b7"
        },
        "date": 1784274927758,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.65,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.75,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.55,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.14,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.65,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.04,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.42,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.04,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.03,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.24,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 188.84,
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
          "id": "56a2bace9f27526d9066a1d05ff9161d012ecab6",
          "message": "fix(tls): honor `ciphers`/`SECLEVEL` from every configured source when building TLS listeners (#1841)\n\n* fix(tls): honor ciphers/SECLEVEL from every configured source when building TLS listeners\n\nA TLS listener has exactly one effective cipher string: OpenSSL takes the\ncipher list (and any @SECLEVEL, which governs client-cert chain\nverification) from the context the server was created with; SNI-swapped\ncontexts don't carry their own cipher list onto the connection. Harper\napplied only tls.ciphers ?? tls[0].ciphers and silently ignored every\nother configured value — tls[] entries beyond [0] and certificate\nrecords, including client-CA records carrying DEFAULT@SECLEVEL=0 for\nSHA-1-signed chains, which then failed with authorizationError\nUNSPECIFIED on valid in-date certs.\n\nresolveEffectiveTlsCiphers (security/keys.ts) now resolves the listener\nstring from all sources: top-level tls.ciphers wins; otherwise tls[]\nentries plus relevant cert records (uses-matched, and authorities when\nthe listener verifies client certs) are candidates, with the lowest\nexplicit @SECLEVEL winning conflicts and everything ignored logged.\nPost-boot changes to the resolved value warn (once per value) that a\nrestart is required. Bun path untouched (BoringSSL has no @SECLEVEL).\n\nCloses #1840\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test(tls): guard seclevel test teardown when setup fails early\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(tls): compose suite and minimum SECLEVEL per listener instead of picking one cipher string\n\nAddresses the external review on #1841: config array entries are now\nrelevance-filtered like certificate records (CA entries only when the\nlistener verifies client certs; uses matched with the selector's\ntolerant rule incl. legacy 'https' and no-uses generics), the suite\nlist is preserved from the highest-priority suite-bearing candidate\nwith only the minimum explicit @SECLEVEL composed on (no assumed\nruntime default level), and the operations API listener resolves from\noperationsApi.tls before root tls so an inherited-certificate override\nis no longer ignored.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:39:05Z",
          "url": "https://github.com/HarperFast/harper/commit/56a2bace9f27526d9066a1d05ff9161d012ecab6"
        },
        "date": 1784360811036,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.49,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.76,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.46,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.09,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 27.23,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.19,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.18,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.71,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 20.3,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 50.61,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 169.22,
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
          "id": "8b1c12b6b0de289f9b1657b3b66a9f43209adcb9",
          "message": "Merge pull request #1385 from HarperFast/kris/nextjs-caller-ci\n\nci: run Next.js adapter integration suite against harper PRs (downstream gate)",
          "timestamp": "2026-07-18T21:23:10Z",
          "url": "https://github.com/HarperFast/harper/commit/8b1c12b6b0de289f9b1657b3b66a9f43209adcb9"
        },
        "date": 1784447642296,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 12.01,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 11.71,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 16.18,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 13.21,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 19.5,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 12.71,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 26.12,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 11.86,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 15.29,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 113.63,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 50.3,
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
          "id": "1e2877d0f19535352d4e70b5a0db36388eee6ded",
          "message": "Merge pull request #1825 from HarperFast/fix/typed-resources-sandbox-exports\n\nfix(sandbox): wire the six typed-resources exports into the component sandbox",
          "timestamp": "2026-07-20T04:17:11Z",
          "url": "https://github.com/HarperFast/harper/commit/1e2877d0f19535352d4e70b5a0db36388eee6ded"
        },
        "date": 1784535306207,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.01,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.48,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.65,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.39,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.45,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.53,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.83,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.82,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.91,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 149.96,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 51.45,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "jcohen-hdb",
            "username": "jcohen-hdb",
            "email": "jacob@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "1e1edc666ad373a0fbfec4df4d3f0e130be13529",
          "message": "Ignore node_modules symlinked into integration fixtures by dev-mode boots\n\nharper dev <fixture> runs symlinkHarperModule against the component dir,\nplanting node_modules/harper inside integrationTests/fixtures/* — untracked\nand unignored, it has previously slipped into a commit (#1828 required an\namend). Discovered during runtime verification of this branch.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-20T18:56:00Z",
          "url": "https://github.com/HarperFast/harper/commit/1e1edc666ad373a0fbfec4df4d3f0e130be13529"
        },
        "date": 1784621045564,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.7,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.29,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.56,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.43,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.83,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.62,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.2,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.54,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.53,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.75,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 177.69,
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
          "id": "2738680a414308b556ab10c19d9dedc5555077c3",
          "message": "Register the MCP durable quota policy as a function, not a config-referenced Resource (#1809) (#1821)\n\n* Register the MCP durable quota policy as a function, not a config-referenced Resource (#1809)\n\nThe quota hook was configured by `mcp.<profile>.quota.resource` pointing at an\nexported Resource, whose inherited CRUD then surfaced on every transport\n(update_/delete_ MCP tools + REST/SSE/WS/GraphQL/MQTT) — a permitted client\ncould reset its own counter. The docs example worked around it by turning six\nexportTypes flags off, which made the safe path the easy-to-forget one.\n\nReplace it with a registration function: `server.setMcpQuotaHandler(fn)`. The\npolicy is a plain function (never an exposed Resource), enabled by registering\nit (no config). checkDurableQuota invokes the registered handler; no handler =>\nallowed (opt-in), throw => fail-closed deny (unchanged). The handler receives\n`profile` so one handler can gate operations vs application.\n\n- Remove the `mcp.<profile>.quota.resource`/`.method` config params.\n- Wire `server.setMcpQuotaHandler` next to `server.registerOperation`.\n- Migrate the mcp-quota fixture off `tables.QuotaCounter`: an exported tool\n  (Answerer) + an internal (non-@export) counter table + a registered handler,\n  so nothing exposes the counter. Integration test asserts the counter is not\n  REST-reachable.\n\nSupersedes the docs#576 six-`false` example; docs follow-up separately.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Isolate the quota handler from deploy pre-flight validation; allow clearing (review)\n\nCodex review:\n- P1: the quota handler is a process-wide singleton, so a candidate component's\n  top-level server.setMcpQuotaHandler(...) during deploy pre-flight validation\n  would outlive the throwaway load and alter live enforcement on a failed deploy.\n  Snapshot the handler before the validation load and restore it in the finally\n  (added getMcpQuotaHandler()).\n- P2: the Server interface rejected undefined though the setter supports clearing;\n  widen the public type to McpQuotaHandler | undefined.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Test: assert the internal counter exposes no REST route and no MCP CRUD tools (#1809)\n\nCodify the security property the redesign delivers (and that /verify checked by\nhand): the counter table is internal, so GET /QuotaCounter 404s and tools/list\ncarries no QuotaCounter update_/delete_ tools a client could call to reset its\nquota. Tightened the counter-not-exposed assertion from !=200 to ==404.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Extract withMcpQuotaHandlerPreserved and unit-test the deploy-validation isolation (#1809)\n\nThe P1 snapshot/restore was inline in the deploy op and only its get/set primitive\nwas covered. Extract it into withMcpQuotaHandlerPreserved(fn) — operations.js wraps\nthe throwaway validation load in it — and unit-test the isolation directly: a\ncandidate that registers a different handler, one that clears it, and a load that\nthrows all leave the live worker's handler intact.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Simplify quota-handler wiring; note the snapshot-restore tradeoff (review)\n\n/code-review: assign server.setMcpQuotaHandler directly instead of a redundant\nwrapper (also keeps the impl param type in sync with the Server interface's\nMcpQuotaHandler | undefined). Document that withMcpQuotaHandlerPreserved restores\nunconditionally, so a legitimate interleaving registration would be reverted — a\nnarrow window, and the lesser evil vs leaking a candidate policy live.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* Generalize deploy-validation isolation to all process-wide server.* registrations (#1809)\n\n/code-review #3: the deploy pre-flight snapshot/restore only isolated the quota\nhandler; a candidate's server.registerOperation during the throwaway validation\nload still mutated the process-wide operation map AND announced to the main thread,\nleaking onto the live worker on a failed deploy.\n\nReplace the quota-specific withMcpQuotaHandlerPreserved with a general guard\n(deployValidationState.ts): server.registerOperation and server.setMcpQuotaHandler\nboth no-op while a validation load is in flight (validation only needs to surface\nload-time errors, not register anything). operations.js wraps the validation load\nin runWithDeployValidationGuard. Skipping is cleaner than snapshot/restore here —\nit also suppresses the cross-thread operation announce, which a local restore can't\nundo. Depth-counted; the narrow interleaving caveat is documented.\n\nTests: registerOperation + setMcpQuotaHandler are skipped during validation and\nresume after (incl. after a thrown load), in serverUtilities.test.js.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-22T04:07:08Z",
          "url": "https://github.com/HarperFast/harper/commit/2738680a414308b556ab10c19d9dedc5555077c3"
        },
        "date": 1784707327597,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.55,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.87,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.19,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.05,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.69,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.15,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.46,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.59,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.76,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 52.26,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 147.09,
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
          "id": "cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa",
          "message": "Fix indentation drift in getStringPrefixUpperBound\n\nApplying Gemini's suggested diff verbatim left the function body one\ntab shallow, failing prettier --check.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-22T11:50:18Z",
          "url": "https://github.com/HarperFast/harper/commit/cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa"
        },
        "date": 1784793879954,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.62,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.46,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.74,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.45,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.33,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.53,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.07,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.62,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 178.58,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.5,
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
          "id": "b8c843a24a4b2b3f002a2b786415333fd7f3b597",
          "message": "fix(query): stop query planning from mutating the caller's conditions (#1911)\n\n* fix(query): stop query planning from mutating the caller's conditions\n\nTable.search()/get() took the caller's conditions by reference and annotated\nthem in place as it planned the query: it pushes a `{ comparator: 'sort' }`\npseudo-condition for index-order alignment, sets `descending`, caches\n`estimated_count`, collapses chained conditions, and coerces values — all on\nthe caller's entry objects. A caller that reuses the same array or condition\nobjects across queries (a natural pattern for a module-level `const`) then hits\nleaked state: a kept sort pseudo-condition is treated as a real valueless\ncondition and throws `Invalid value for attribute … \"undefined\"`; a stale\n`descending` silently reverses a later scan; a cached `estimated_count`\nmisplans. Whether it surfaced depended on live index estimates, so it read as\nphantom nondeterminism.\n\nClone the conditions array and every entry (recursing into nested and/or groups)\nat intake, so all downstream planning mutation happens on our own objects and\nnever reaches the caller. Entries are small and shallow, so the copy is\nnegligible next to the query itself.\n\nFixes harper#1572.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* test(query): make the array-form target guard assert entry immutability\n\nPost-review follow-up. The array-form-target regression case only checked array\nlength + absence of a sort pseudo-condition, which don't change on that path\n(no sort → no push) — so it passed with or without the fix. Assert instead that\nthe caller's condition entry is untouched: its Date-typed bound stays the\noriginal string (not coerced in place) and no estimated_count is annotated. Now\nfails on origin/main and passes with the fix, like the other three cases.\n\nAlso note in cloneConditions why chainedConditions sub-entries are left shared\n(read-only during planning).\n\nComment generated by kAIle (Claude Opus 4.8)\n\n* refactor(query): hoist cloneConditions to module scope; plain node:assert in test\n\nReview follow-up (both non-blocking):\n- cloneConditions is stateless (no closure over search/makeTable), so hoist it\n  to module scope rather than re-creating the function on every search() call.\n- Use plain node:assert in the regression test per house style, with explicit\n  strictEqual/deepStrictEqual where strict semantics are wanted.\n\nComment generated by kAIle (Claude Opus 4.8)\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-24T00:33:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b8c843a24a4b2b3f002a2b786415333fd7f3b597"
        },
        "date": 1784880135709,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.51,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.22,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.25,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.22,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.1,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.87,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.17,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.55,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 164.89,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.7,
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1784965933827,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.05,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.99,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.79,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.26,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.16,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.25,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.55,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.13,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.81,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 54.06,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 173.23,
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1785053148594,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.6,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.92,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.98,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.33,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.64,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.13,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.65,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.65,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 20.16,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 203.45,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.14,
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
          "id": "fe3994f4031714027098f6ce250fa78e1264107b",
          "message": "test(txn): afterEach stub-restore safety net + unref race timers (bot review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-18T14:13:10Z",
          "url": "https://github.com/HarperFast/harper/commit/fe3994f4031714027098f6ce250fa78e1264107b"
        },
        "date": 1785140779586,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.05,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.72,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.13,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.8,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.66,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.5,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.93,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.14,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.83,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.89,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 168.32,
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
          "id": "e1a0cae0bda2596a77bf0b450ed6b2dc4039035d",
          "message": "test(packaging): make manifest assertions robust",
          "timestamp": "2026-07-23T21:11:19Z",
          "url": "https://github.com/HarperFast/harper/commit/e1a0cae0bda2596a77bf0b450ed6b2dc4039035d"
        },
        "date": 1785225937460,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.31,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.81,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.84,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.76,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.36,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.85,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.84,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.9,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.06,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 56.64,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 142.55,
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
          "id": "35c1f423b9e05ac858ec14bec4346d06d274c2e1",
          "message": "fix(cli): refresh expired agent tokens; fix --once approval hang\n\nAddress heskew's two remaining non-blocking review notes on #1553:\n\n- `harper agent` hard-failed on an expired stored operation token instead\n  of self-healing via the refresh_token, unlike cliOperations.ts. Extract\n  the refresh logic into a shared `refreshExpiredOperationToken` helper in\n  cliOperations.ts and call it from both cliOperations and agentCli, so the\n  two transports can't drift again.\n- `--once` against a real TTY drains stdin via readAllStdin() before the\n  first turn; if that turn then needed approval, resolveApprovals() built a\n  new readline on the already-ended stdin and question() never resolved.\n  Track actual stdin consumption (opts.stdinConsumed) instead of relying on\n  isTTY, and fail loudly in that case like the non-TTY path already does.\n\nRefs #1553\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T13:58:29Z",
          "url": "https://github.com/HarperFast/harper/commit/35c1f423b9e05ac858ec14bec4346d06d274c2e1"
        },
        "date": 1785312635077,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.57,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.23,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.91,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.99,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.74,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.88,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.79,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.68,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.41,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 168.52,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 45.95,
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
          "id": "b04af4d08dc96ffd6f657991b4fe105528e88c98",
          "message": "Merge pull request #1956 from HarperFast/fix/instance-post-create\n\nfix(resources): restore v4 super.post create on collection posts",
          "timestamp": "2026-07-29T23:58:36Z",
          "url": "https://github.com/HarperFast/harper/commit/b04af4d08dc96ffd6f657991b4fe105528e88c98"
        },
        "date": 1785398633463,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.8,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.11,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.65,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.23,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.41,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.18,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.28,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.78,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.03,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 190.89,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.36,
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
          "id": "fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:46Z",
          "url": "https://github.com/HarperFast/harper/commit/fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20"
        },
        "date": 1785485347743,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 9.6,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 8.43,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 13.49,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 10.81,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 18.99,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 10.42,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 23.22,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 10.3,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 13.83,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.46,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 99.33,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "8dc2fa61797ce88a49ec6c9c0c8c847b6c116886",
          "message": "Document legacy compression metadata semantics in DESIGN.md\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-31T23:42:40Z",
          "url": "https://github.com/HarperFast/harper/commit/8dc2fa61797ce88a49ec6c9c0c8c847b6c116886"
        },
        "date": 1785544021316,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.31,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.12,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.68,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.72,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.49,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.49,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.96,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.73,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.69,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 55.33,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 143.49,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785571074841,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.05,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.29,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.59,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.27,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 21.61,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.21,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 30.43,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.27,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.69,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 144.05,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 55.17,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785657766690,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.98,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.25,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.28,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.77,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.44,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.25,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.61,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 17.16,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 21.57,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 51.02,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 194.19,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T00:42:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785745481999,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.1,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.48,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.17,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.65,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.11,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.49,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 34.84,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.25,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.78,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 171.19,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.32,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "5db8251124f186d88b8c925dc923cd051bde71a0",
          "message": "chore(deps): update dependency @harperfast/integration-testing to ^0.7.0 (#2053)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-04T06:31:32Z",
          "url": "https://github.com/HarperFast/harper/commit/5db8251124f186d88b8c925dc923cd051bde71a0"
        },
        "date": 1785830889523,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 15.97,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.55,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.75,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.94,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.82,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.53,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.39,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.24,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.43,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 182.25,
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
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "1201afb01221c87fd298babef05d12e38dc99755",
          "message": "Close remaining bypass_auth trust gaps in MCP tokens and SQL AST checks\n\nTwo review findings on the operation-authorization refactor:\n- createTokens() still trusted a caller-supplied authObj.bypass_auth\n  field, and MCP's tool handler didn't strip it — an MCP caller could\n  spoof bypass_auth and mint tokens for an arbitrary username without a\n  password. createTokens now reads only the trusted ALS-scoped\n  isOperationAuthorizationBypassed() state; MCP strips bypass_auth/\n  bypassAuth from tool args before dispatch as defense in depth.\n- processAST() still read jsonMessage.bypass_auth from the body, so\n  trusted authorize=false SQL calls (via legacy differential dispatch)\n  were being re-authorized. processAST now consults the same ALS-scoped\n  bypass state; differential.ts's runLegacy wraps evaluateSQL in\n  runWithOperationAuthorizationBypass instead of passing bypass_auth in\n  the message body.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-27T15:25:19Z",
          "url": "https://github.com/HarperFast/harper/commit/1201afb01221c87fd298babef05d12e38dc99755"
        },
        "date": 1785917363281,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.51,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.85,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 22.49,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.63,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.58,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.54,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.34,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.66,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 20.17,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 48.51,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 180.86,
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
          "id": "ffef12f8c8992eb86c5014d85d4bd273df8f18d5",
          "message": "Test Bun resolution candidate tracking directly\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-05T00:14:40Z",
          "url": "https://github.com/HarperFast/harper/commit/ffef12f8c8992eb86c5014d85d4bd273df8f18d5"
        },
        "date": 1785933865339,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.49,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.05,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.94,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.81,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.11,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.34,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.61,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.23,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.41,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 54.76,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 157.6,
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
          "id": "01d8562225c88abe8d62ba37e520aa5b289f76c7",
          "message": "Merge pull request #2075 from HarperFast/david/last-super-user-guard\n\nReject user and role changes that would remove the last active super_user",
          "timestamp": "2026-08-05T21:25:48Z",
          "url": "https://github.com/HarperFast/harper/commit/01d8562225c88abe8d62ba37e520aa5b289f76c7"
        },
        "date": 1786003600251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.47,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.9,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.87,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.75,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.07,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.05,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.58,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.16,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.03,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 50.76,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 150.75,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f85e66b92abda03b6dd7cbcfde05e09a46215da7",
          "message": "chore(deps): raise msgpackr floor to ^2.0.5\n\nThe published harper@5.2.0 shipped an npm-shrinkwrap.json pinning\nmsgpackr 2.0.4. main's package-lock.json already resolves 2.0.5\n(bumped after the v5.2.0 tag in a264242b4 as an npm-install side\neffect of ^2.0.4), so the next release cut from main already ships\n2.0.5. This raises the declared floor to ^2.0.5 to make that intent\nexplicit and guard against a future lock regeneration ever pinning\nbelow 2.0.5. No functional change; the resolved lock entry is\nunchanged.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-06T16:19:21Z",
          "url": "https://github.com/HarperFast/harper/commit/f85e66b92abda03b6dd7cbcfde05e09a46215da7"
        },
        "date": 1786088624142,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 13.57,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.77,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.57,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 16.18,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.64,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.38,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.94,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.72,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.86,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.71,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 163.09,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786174406957,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 13.12,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 12.42,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.57,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 15.84,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.94,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 15.07,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 31.51,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 13.62,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.35,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.67,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 159.56,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786260907986,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.88,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.24,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.54,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.83,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.15,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.75,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 32.68,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.49,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.3,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 137.63,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 53.37,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786348093616,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.09,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.89,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.35,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 18.98,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.72,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 17.98,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.4,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.55,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 20.19,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.59,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 180.35,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786434056305,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.32,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 13.66,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.12,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.67,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 22.98,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.51,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.03,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.53,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 17.17,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 52.88,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 158.79,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "0a727e8bd5931e9266344b757a8680f50f5980ff",
          "message": "fix(deps): update dependency argon2 to v0.45.1 (#2132)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-12T01:50:06Z",
          "url": "https://github.com/HarperFast/harper/commit/0a727e8bd5931e9266344b757a8680f50f5980ff"
        },
        "date": 1786520847389,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.19,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.79,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.29,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.92,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.86,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.71,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.71,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.74,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.19,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.7,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 172.62,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "09c4580106cc399ea7a4dd7132361a61d2d2d561",
          "message": "Merge pull request #2124 from HarperFast/fix/sql-engine-top-limit-normalization\n\nfix(sql-engine): honor SELECT TOP n and floor fractional LIMIT/OFFSET",
          "timestamp": "2026-08-12T22:47:19Z",
          "url": "https://github.com/HarperFast/harper/commit/09c4580106cc399ea7a4dd7132361a61d2d2d561"
        },
        "date": 1786607094232,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 14.95,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 14.98,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.65,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 17.76,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.82,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 16.8,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 33.66,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 14.36,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 19.16,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 164.32,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 55.34,
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
          "id": "871fad0fa2ece52e4adfbfa102536c54560c67e3",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:23:55Z",
          "url": "https://github.com/HarperFast/harper/commit/871fad0fa2ece52e4adfbfa102536c54560c67e3"
        },
        "date": 1786693640298,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.38,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.81,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 19.81,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 20.23,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 24.73,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 19.26,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 37.94,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.25,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.7,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 177.27,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 47.01,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786778869583,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.64,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 17.01,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 20.12,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 20.08,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.34,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 19.58,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 38.63,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.28,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 20.49,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 211.78,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.4,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786865316143,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.03,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.63,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 17.86,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.19,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.49,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.31,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 35.94,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 16.41,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.2,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 46.28,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 172.77,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786952268856,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.04,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 15.5,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.15,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.68,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 25.01,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 19.27,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 38.05,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.89,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.59,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 194.2,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 49.5,
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
          "id": "058ba377b18446b557fc1b8d3f11ff0683bf2686",
          "message": "Pin the load-bearing native and encoder dependencies (#2179)\n\n* chore(deps): pin the load-bearing native and encoder dependencies\n\nA caret range means the manifest gate does not bind. harper-pro, a container\nrebuild, and anyone installing published harper without this lockfile all\nresolve to whatever is newest at install time, so a rocksdb-js or msgpackr\nminor reaches a running node with no Harper PR and no human merge.\n\nThat is the mechanism behind 5.1.22 shipping rocksdb-js 2.4.0 while the\ncross-column-family read fix was in 2.5.0: the pin permitted the fix and the\nimage predated it. The same latitude equally admits a regression.\n\nextended-iterable is pinned for a sharper reason than the rest. rocksdb-js\nrequires exactly 1.0.3 while the root asked for ^1.0.1, so the day 1.0.4\npublishes a fresh resolution hoists 1.0.4 for the root and nests 1.0.3 under\nrocksdb-js — two modules, two SKIP sentinels. A vector query whose candidate\nrecord was deleted then returns harper's SKIP into a map() belonging to\nrocksdb-js's ExtendedIterable, which does not recognise it and emits the\nsentinel as a result row: a phantom record on the read path, no exception and\nno log line. msgpackr has the same shape via its extension registry, where the\nnested copy never saw addExtension for Blob.\n\nupdate-rocksdb-js.yml gains --save-exact. It ran `npm install --save`, and with\nno .npmrc the default save-prefix of ^ applies, so the next rocksdb-js release\nwould have rewritten 2.7.1 back to ^2.8.0 and reverted this commit unattended.\n\nEvery pin is the version the lockfile already resolved, so no dependency moves\nhere; only the range narrows. lmdb, cbor-x, ordered-binary, alasql and argon2\nwere already exact.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n\n* fix(build): keep shrinkwrap canaries discriminating\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): fail closed on unresolved canary queries\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): back off dependency canary retries\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* fix(build): enforce rocksdb encoder alignment\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* test(build): keep alignment fixtures version-agnostic\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* test(build): cover ranged encoder regression\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Handle npm E404 in dependency canary check\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n* Harden dependency canary registry responses\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-18T02:44:24Z",
          "url": "https://github.com/HarperFast/harper/commit/058ba377b18446b557fc1b8d3f11ff0683bf2686"
        },
        "date": 1787038323756,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "C read p99 — read only",
            "value": 16.01,
            "unit": "ms"
          },
          {
            "name": "B read p99 — read mostly",
            "value": 16.2,
            "unit": "ms"
          },
          {
            "name": "B update p99 — read mostly",
            "value": 18.61,
            "unit": "ms"
          },
          {
            "name": "A read p99 — update heavy",
            "value": 19.5,
            "unit": "ms"
          },
          {
            "name": "A update p99 — update heavy",
            "value": 23.89,
            "unit": "ms"
          },
          {
            "name": "F read p99 — read-modify-write",
            "value": 18.48,
            "unit": "ms"
          },
          {
            "name": "F rmw p99 — read-modify-write",
            "value": 36.21,
            "unit": "ms"
          },
          {
            "name": "D read p99 — read latest",
            "value": 15.72,
            "unit": "ms"
          },
          {
            "name": "D insert p99 — read latest",
            "value": 18.29,
            "unit": "ms"
          },
          {
            "name": "E scan p99 — short ranges",
            "value": 184.05,
            "unit": "ms"
          },
          {
            "name": "E insert p99 — short ranges",
            "value": 43.7,
            "unit": "ms"
          }
        ]
      }
    ],
    "Storage Benchmarks Throughput (ST-1/ST-2/ST-5)": [
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
        "date": 1783425529000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 25145
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 14764
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 15149
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 35929344
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 3406
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 839622
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
          "timestamp": "2026-07-08T03:08:21Z",
          "url": "https://github.com/HarperFast/harper/commit/a0f4a51acfa917fd544c88eec4b8893b5d04512e"
        },
        "date": 1783510436000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 32862
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15470
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 14433
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34320704
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10007
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2618
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Lavinia",
            "username": "ldt1996",
            "email": "lavinia@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "f10eba31e88286b53f10f7cdfc29dcd45d1cabfa",
          "message": "fix(storage): replay conflict retry on a fresh transaction after ERR_TRY_AGAIN (#1696)\n\n* fix(storage): replay conflict retry on a fresh transaction after ERR_TRY_AGAIN\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): keep retries from deduping against their own audit entry\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* chore: log the swallowed abort error (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): per-write sticky own-audit-entry marker for retry dedup (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): abort before the MAX_RETRIES throw, pin change-feed entries in tests (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>",
          "timestamp": "2026-07-09T11:46:49Z",
          "url": "https://github.com/HarperFast/harper/commit/f10eba31e88286b53f10f7cdfc29dcd45d1cabfa"
        },
        "date": 1783598387000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 29151
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 21797
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13342
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 35098432
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 4641
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 495055
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
        "date": 1783684739000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 15746
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15816
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 12979
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34163008
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10849
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 3591
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
        "date": 1783768882000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 23692
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15917
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 15240
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 36285952
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 9396
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 1266
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
          "id": "31de6a3bebc5fec85a8eba98087fda00dbc3f477",
          "message": "fix: pin uWebSockets.js via tarball URL, not a github: git spec\n\nSame issue as harper-pro#561: the github: shorthand\n(github:uNetworking/uWebSockets.js#v20.68.0) gets re-resolved by npm as\ngit+ssh://github.com/... on any npm install. Our Docker build stage has\nno SSH credentials for github.com, so npm silently skips the (optional)\ndependency and the shipped image never bundles the native addon —\nHARPER_UWS_UDS / HARPER_UWS_HTTP are inert even when set.\n\nAn explicit git+https:// spec doesn't fix this either — confirmed with\na clean npm cache that npm/hosted-git-info canonicalizes ANY\ngithub.com git dependency back to git+ssh:// regardless of requested\nprotocol. Switching to a plain tarball URL\n(https://.../archive/<sha>.tar.gz) sidesteps hosted-git-info entirely:\nnpm treats it as a remote-tarball dependency, resolved stays a plain\nhttps URL with a pinned integrity hash, and it can't regress on a\nfuture npm install.\n\nVerified npm ci installs all 15 native .node binaries in a\nHOME-stripped, credential-less environment (matching the Docker build\nstage) both before and after a full npm install regenerates the\nlockfile from package.json.",
          "timestamp": "2026-07-11T22:53:13Z",
          "url": "https://github.com/HarperFast/harper/commit/31de6a3bebc5fec85a8eba98087fda00dbc3f477"
        },
        "date": 1783855434000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 16952
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15049
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 14151
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 35653440
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 12070
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4678
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
          "id": "8bf5921e06349611773b4c1d4363088801d3b974",
          "message": "ci(review): canary Claude reviews on claude-sonnet-5 (harper only) (#1759)\n\nOverride the reusable's model default (claude-sonnet-4-6) for this\nrepo's claude-review caller. harper is the A/B canary: highest review\ntraffic, and every ai-review-log entry records Model:, so calibration\ncan compare sonnet-5 vs sonnet-4-6 verdict mix directly at the same\nprompt ref (9cf49d2). Intro pricing ($2/$10 through 2026-08-31) offsets\nthe new tokenizer (~30% more tokens for equivalent text).\n\nWatch item: Sonnet 5 follows blocker-only severity instructions more\nliterally (documented code-review-harness effect) — if the deflation\nrate rises in the next calibration cycle, add coverage-first reporting\nto the run-notes surface before fleet rollout; if clean, promote to the\nreusable default.\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-13T00:05:21Z",
          "url": "https://github.com/HarperFast/harper/commit/8bf5921e06349611773b4c1d4363088801d3b974"
        },
        "date": 1783944022000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 22576
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 12735
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 11000
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 30499264
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10121
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 3336
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "56f8891b933e4638c9f622a0030570de4fd711a8",
          "message": "fix(deps): update all non-major dependencies",
          "timestamp": "2026-07-14T00:14:28Z",
          "url": "https://github.com/HarperFast/harper/commit/56f8891b933e4638c9f622a0030570de4fd711a8"
        },
        "date": 1784028540000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 15753
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 11434
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 11552
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 24449856
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 8095
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 1670
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
          "id": "182971ad16a3ba6986ffae194067965505d5bfa8",
          "message": "Typed, discoverable resources — code-first defineTable + per-method request contract (RFC 0001) (#1767)\n\n* feat(resources): typed, discoverable resources — code-first defineTable + per-method request contract\n\nImplements RFC 0001 (design PR #1503): the mergeable implementation of both\nauthoring front-ends, integrated onto current main.\n\nPillar 1/2b — code-first schema (resources/defineTable.ts):\n  `defineTable(name, shape, opts)` + `types` author a table in TypeScript and\n  eagerly register through the same `table()` factory GraphQL drives — the return\n  IS the live class, with per-verb shapes inferred as `$record/$insert/$upsert/\n  $patch/$query` projections. Relations via lazy thunks (+ relationOf/hasManyOf\n  escape hatch for mutual pairs).\n\nPillar 2 — per-method request contract (resources/withSchema.ts):\n  `defineResource(contract, impl)` (function form) + `Resource.withSchema(contract)`\n  (class form). Handler types are derived from a runtime contract; a handler gets\n  the SAME RequestTarget, structurally narrowed (subset, not fork). Each declared\n  verb validates/coerces query/body before dispatch and throws a structured 400\n  (ValidationError, per-field {path,code,message}[]). Built-in `t`/`schemaOf`\n  reduce to JsonSchemaFragment — one vocabulary across table fields, query, and\n  bodies; a defineTable projection slots into a contract body via\n  schemaOf({ table, projection }). Nullability: non-nullable by default, `.nullable`\n  opts into null (table-derived bodies mirror Table.validate).\n\nCross-cutting:\n  - ValidationError (extends ClientError, 400); Table.validate refactored to the\n    same structured shape (HTTP-title message preserved).\n  - OpenAPI emits declared query/body/response for parameterised routes.\n  - MCP drives tool input/output off the contract and binds arbitrary path params\n    + query (applyContractInputs), lifting the generated-verb binding restriction\n    for contract resources.\n  - Shared attributeToFragment hardened with a nested-object branch; derive.ts\n    Object/Array projection bugfix.\n\nIntegration with main (the RFC branch was ~1007 lines behind on these files):\n  merged with main's newer MCP paramroutes work (paramBinding gating, isSimpleIdRoute,\n  mcpResources) and the liveResource authz fix — a request contract now exempts a\n  resource from the generated-handler binding restriction.\n\nDesign summary in resources/DESIGN.md; full RFC + type spikes remain in #1503.\nType contract verified against built exports in docs/rfcs/spikes/0001/*-real.check.ts.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(withSchema): address PR review — validation hardening + lint-safe test import\n\n- scope the Date type-check exception to string/date-time fields (a Date must not\n  pass validation for number/boolean/array/object schemas)\n- override target.getAll alongside get so multi-value query params read coerced\n- reject empty/whitespace numeric query params instead of Number('')→0\n- harden MCP wrapError: read the untrusted err's props inside a try/catch (revoked\n  Proxy / throwing getters must not crash the error path)\n- application-contract.test.js: require('assert') + strict methods (node:assert/strict\n  is oxlint-banned via no-restricted-imports)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor: rename withSchema.ts → defineResource.ts; drop spike/RFC artifacts\n\n- rename resources/withSchema.ts → resources/defineResource.ts (defineResource is\n  the primary API; Resource.withSchema stays the class-form name) + the test file\n- remove docs/rfcs/ (the *-real.check.ts type-contract proofs + tsconfig) — a real\n  PR shouldn't carry spike/RFC scaffolding; those live in the design PR (#1503)\n- strip references to the spikes and the RFC doc (which are not in this PR) from\n  code/test comments and resources/DESIGN.md; keep the #1503 pointer for the record\n\nNo behavior change. 100 unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(types): re-add public type-contract tests + wire into CI\n\nStandalone type-tests under unitTests/types/ (no spike/RFC framing): assert the\nSHIPPED public types (imported from the built dist) against the contract —\ndefineTable projections + relations, and the defineResource/withSchema handler\ninference, narrowed target, subset property, and negative (@ts-expect-error) cases.\n\n- unitTests/types/{defineResource,defineTable}.type-test.ts + tsconfig.json (strict,\n  noEmit, skipLibCheck; isolated from the main build/typecheck, which don't include\n  unitTests/, and from mocha, which only loads js/mjs)\n- `npm run test:types` (tsc --project unitTests/types/tsconfig.json)\n- CI: a \"Type contract tests\" step in unit-test.yml (after Build, gated to one Node\n  version) so a regression in the public type surface fails CI\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-14T19:37:17Z",
          "url": "https://github.com/HarperFast/harper/commit/182971ad16a3ba6986ffae194067965505d5bfa8"
        },
        "date": 1784115004000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 19952
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 14152
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13042
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 30032960
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 3081
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 805997
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
          "id": "3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02",
          "message": "Reshape deploy_component registryAuth into a general-purpose credentials array (#1797)\n\n* Reshape deploy_component registryAuth into a general-purpose credentials array\n\n`registryAuth` was an npm-only array of `{ registry, token|secret, scope }`\nentries. Rename it to `credentials` and treat the array as kind-heterogeneous:\nan entry's kind is implied by its identifying key (`registry` = npm registry\nauth) rather than a discriminator field, so a git-host kind keyed by `host`\n(#1792) becomes another item alternative rather than another schema rewrite.\n\nThe ingest/resolve pipeline, secrets-store integration, reference-only\nreplication, and every security invariant from #1717 are unchanged — this is a\nrename plus the seams for a second kind. Identifiers follow: ingestRegistryAuth\n→ ingestCredentials, resolveRegistryAuth → resolveCredentials, and the persisted\nforms (applicationConfig.credentials, hdb_deployment.credentials) match the\noperation field.\n\nSince #1717 has not shipped in a GA release, this is a clean break rather than an\nalias. Because operation validation allows unknown keys, a stale `registryAuth`\nis explicitly rejected — otherwise the deploy would silently install with no\ncredentials. It also stays in the operations-log strip list, since that redaction\nruns ahead of validation and a stale caller's token must not reach the log.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Filter Application.registryCredentials to registry-shaped entries\n\nThe credentials array is kind-heterogeneous by design (registry today,\na planned git-host kind later), but Application's constructor assigned\nit straight to registryCredentials, which buildNpmrcContent assumes is\nregistry-shaped. Filter defensively so a future non-registry entry\ncan't reach it.\n\nAddresses gemini-code-assist review comment on PR #1797.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Authenticate private git-reference deploys from an in-memory credential (#1799)\n\n* Authenticate private git-reference deploys from an in-memory credential\n\nA `github:org/repo` package against a private repo needs a credential for the\n`git ls-remote`/`git clone` npm shells out to. Every obvious way to supply one\npersists it: userinfo in the URL lands in the package spec and the lockfile, a\ncredential helper or `.npmrc` is a file, and an env var is readable by every\ndescendant process.\n\nInstead the token stays in the deploying process's memory and is served over a\nper-deploy Unix socket in a 0700 directory. git is pointed at\ngitCredentialHelper.js — a secret-free script that relays git's request over\nthat socket — and the socket dies with the spawn that needed it. The token\nreaches disk, argv, the package spec, the operation body and the operations log\nnowhere along the way.\n\nThe credential rides as a second kind in the `credentials` array from #1797:\n`{ host, token|secret, username? }`, discriminated by `host` the way npm entries\nare by `registry`. Ingest, seal-into-hdb_secret, grant-check, resolve-at-use and\nreplicate-as-reference are the existing #1717 paths, unchanged — only the\nderived secret name (`deploy.<component>.<host>`) and the injection mechanism are\nnew. resolveCredentials now rejects an unrecognized kind rather than resolving it\ninto a half-empty entry, symmetric with the guard ingestCredentials already had.\n\nWiring, in order of preference: `credential.helper` via GIT_CONFIG_* (structured\nkey=value protocol, no prompt parsing) with GIT_ASKPASS as the fallback for git\n< 2.31, which ignores GIT_CONFIG_*. Inherited credential helpers are reset to\nempty first, so a machine configured with `credential.helper=store` cannot write\nthis token to ~/.git-credentials when git reports the successful authentication\nback to its helper chain. The askpass path decides username-vs-password prompt\nstructurally (userinfo present in the echoed URL) rather than by matching\nEnglish, since git localizes those prompts.\n\nOnly the spawn that clones (`npm pack`) is given this environment. The\n`npm install` that follows — where a dependency's install script can run — never\nsees it, and the socket is already closed by then.\n\nRefs #1792. Stacked on #1797.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Keep the git credential out of reach of clone-time install scripts\n\nPacking a git reference is not just a download. npm clones the repo and, when\nits manifest has a prepare/build/install script, runs `npm install` inside the\nclone and then that script — so the repository's own code and its dependencies'\ninstall scripts execute on this node, inside the clone spawn, inheriting its\nenvironment. Verified against real npm: a transitive dependency's `preinstall`\nsees HARPER_GIT_CREDENTIAL_SOCKET and can ask the socket for the token. That is\nexactly the reach #1792 says the credential must not have, and closing the\nsocket before `npm install` did not close it, because this all happens earlier,\nduring `npm pack`.\n\nSo a credentialed clone runs with `--ignore-scripts` unless the deploy set\ninstall_allow_scripts, which is the operator explicitly asking for that code to\nrun here; that case is allowed and logged, naming the exposure it accepts. Note\nthis also means a git-reference deploy runs scripts at pack time regardless of\ninstall_allow_scripts today — the flag only ever reached the install spawn. That\ninconsistency is left alone here (fixing it changes behavior for existing public\ngit deploys) but is worth its own issue.\n\nWindows now fails closed instead of serving the credential over a named pipe: a\npipe is created with a default security descriptor that can leave it readable by\nother local users, and the whole confinement argument rests on the 0700\ndirectory a Unix socket sits in. Better to refuse than to offer a quietly weaker\nchannel.\n\nAlso from review: cap the request a peer can stream at the socket (an unbounded\n`request +=` was an OOM), and remove the socket's temp directory when listen()\nfails, since no session is returned and nothing would otherwise clean it up.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Harden the git credential channel against persistence and downgrade\n\nA second cross-model review pass (Codex) surfaced several ways the credential\ncould still escape memory:\n\n- **Cleartext transport.** git asks for `http://` credentials exactly as it\n  asks for `https://`, so a `git+http://` package (or a remote downgraded by a\n  redirect) would put the token on the wire in the clear. answerFor now serves\n  only over https, with an exemption for loopback (where no network is involved\n  and the integration tests run).\n\n- **git < 2.31.** Those versions ignore GIT_CONFIG_* entirely, so the\n  credential.helper reset that stops an inherited `store` helper from writing the\n  token to ~/.git-credentials is silently dead — and the GIT_ASKPASS fallback\n  would still feed that helper a successful credential to persist. There is no way\n  to disable an inherited helper on those versions, so the session now refuses to\n  start on one rather than leak. (The reset itself is verified end-to-end against\n  a real clone with both a global and a URL-scoped `store` helper configured; the\n  earlier concern that a URL-scoped helper bypasses the reset did not reproduce —\n  git's credential machinery honors the reset, `--get-urlmatch` merely shows raw\n  config.)\n\n- **Newline in a resolved token.** A literal token is schema-rejected for CR/LF,\n  but one resolved from an hdb_secret row was not — and git's protocol is\n  line-based (askpass reads only the first line), so such a token would truncate\n  or inject protocol attributes. Guarded at the serve boundary, matching the\n  .npmrc writer.\n\n- **Unknown keys persisting.** Operation validation runs allowUnknown, so a\n  credential entry like `{host, secret, password: \"literal\"}` would carry that\n  stray field through ingest into config, hdb_deployment, and replication. Both\n  entry schemas are now `.unknown(false)`, and each forbids the other's\n  discriminator. assertApplicationConfig likewise rejects an entry that is both\n  kinds or carries a literal token, rather than coercing it to one kind.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Warn on duplicate git-credential hosts; lock in the no-custody strip\n\nReview follow-ups. Two entries for the same host in one deploy silently\nlast-write-wins (they also seal to the same derived secret name), so warn rather\nthan drop quietly. And a regression test pins the security property that a\nliteral git token on a node without custody yields no persistable reference and\nis therefore stripped from the replicated op body.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Address 5 review comments; fix a backpressure bug hanging the OOM-cap test\n\n- close(): snapshot the connections Set before destroying, so destroy()'s\n  synchronous 'close' listener (which deletes from the same Set) can't skip\n  a connection mid-iteration.\n- answerFor(): guard against a non-object request before touching .host.\n- parseAskpassPrompt(): move the URL parse+decode inside the existing\n  try/catch so a malformed percent-encoded username can't throw past it.\n- gitCredentialClone.test.js: resolve GIT_HTTP_BACKEND in a try/catch so a\n  missing git binary can't crash the whole suite loader before before()\n  gets a chance to skip; before() now also checks for that case.\n- operationsValidation.js: cap the git credential entry's token at\n  SECRET_MAX_LENGTH, matching the same limit already applied elsewhere.\n\nAlso fixes an unrelated pre-existing bug found while verifying: the OOM-cap\ntest's write loop gave up permanently the first time socket.write() returned\nfalse for backpressure (the `&&` chain short-circuits), which happens well\nbefore the server-side 64KB cap is reached — so the test hung forever\nwaiting for a 'close' the server had no reason to send. Confirmed via a\nclean-checkout diff that this predates this task's changes. The production\ncap-enforcement logic itself was already correct; only the test's flow\ncontrol was wrong. Now resumes writing on 'drain' instead of giving up.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Update components/secretOperations.ts\n\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Fix CI: git-secret naming test drift, and prepare-script leak on npm<11\n\nsecretOperations.test.js still asserted the pre-review-fix secret name\n(deploy.<app>.<host>); a prior commit on this branch added the `.git`\nkind segment to deriveGitSecretName to close a same-host collision\nbetween git and registry secrets (per review), but didn't update the\ntests that pin the literal name. Update the 5 affected assertions to\nthe new, collision-safe name and note why in deriveGitSecretName's doc\ncomment.\n\nAlso fix a real Node-22-only failure: a credentialed git clone relied\non `npm pack --ignore-scripts <git-url>` to keep a repository's\nprepare script from running while the credential socket is reachable.\npacote's DirFetcher runs `prepare` unconditionally on npm <11.0.0 (the\nignoreScripts guard was only added upstream in npm 11) — exactly what\nNode 22's bundled npm ships, confirmed by reproducing against the real\nnpm 10.9.8 binary. For a recognized git-reference identifier with\nscripts disallowed, clone it ourselves (still authenticated via the\ncredential session's env) and strip its lifecycle scripts before\npacking, sidestepping the buggy npm code path entirely — the same\nmechanism harper#1819 lands for the uncredentialed case.\n\nVerified against npm 10.9.8: the prepare-script test fails identically\nto CI on the pre-fix code and passes reliably with the fix.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Resolve hosted-git shorthand (github:/gitlab:/bitbucket:/gist:) in parseGitReference\n\nderivePackageIdentifier defaults a bare owner/repo package identifier to\ngithub:owner/repo, but parseGitReference only recognized explicit\ngit+.../git:// URL forms, so that shorthand — the PR's own worked example —\nfell through to the npm pack --ignore-scripts fallback documented as\nunreliable on npm <11. Extend parseGitReference to resolve github:, gitlab:,\nbitbucket:, and gist: shorthand to a concrete https clone URL so it routes\nthrough the clone-and-strip-scripts path instead.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Resolve npm-style semver: committishes before git checkout\n\n#1799's own worked example (`github:my-org/my-app#semver:v1.2.3`) documented a\ncommittish naming a semver range, but packGitReferenceWithoutScripts passed it\nstraight to `git checkout`, which has no notion of npm's `semver:` syntax and\nsimply failed.\n\nAdds resolveCommittish(), which lists the clone's tags and resolves the range\nagainst them with the `semver` package (already a direct dependency), matching\nnpm's own git-dependency resolution: tags may carry a prefix ahead of the\nversion (`release-v1.2.3`), a percent-encoded range is decoded, and the\nresolved ref is checked out as `refs/tags/<name>` to avoid an ambiguous\nsame-named branch. A non-semver committish is unaffected.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Reject unsafe tag names before checkout in semver-committish resolution\n\nThe automated PR review on the previous commit found that resolveCommittish\nonly validated the semver-shaped suffix it matched in a tag name (e.g. the\n`v1.2.3` in `release-v1.2.3`), not the full tag string. Since git ref names\npermit shell metacharacters (`$`, backticks, `;`, `&`, `|`, parens — only\nwhitespace and a few other forms are disallowed), and nonInteractiveSpawn\nruns through a shell with no argument escaping, a tag name from the cloned\nrepository such as `$(touch${IFS}/tmp/x)v9.9.9` would execute as a command\nsubstitution on checkout — reachable specifically because semver resolution\npicks a tag out of the (untrusted, upstream) repo's own tag list, unlike a\nliteral committish which the deploying operator supplies directly.\n\nAdds a conservative safe-charset check on the full tag name; a tag failing\nit is excluded from resolution rather than sanitized, so it can never reach\nthe checkout spawn. Confirmed exploitable pre-fix (marker file executes) and\nblocked post-fix via a new regression test.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-15T23:03:58Z",
          "url": "https://github.com/HarperFast/harper/commit/3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02"
        },
        "date": 1784201439000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 13809
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 12484
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 12944
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 28852096
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 11682
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2391
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
          "id": "bf0c51a69c0b875e755b55a8036ace486aa5a1e9",
          "message": "Merge pull request #1285: New SQL engine on the Resource API (phases 0-5)\n\nNew SQL engine on the Resource API (phases 0-4; phase-5 cutover gated)",
          "timestamp": "2026-07-17T11:10:18Z",
          "url": "https://github.com/HarperFast/harper/commit/bf0c51a69c0b875e755b55a8036ace486aa5a1e9"
        },
        "date": 1784287680000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 15247
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 12826
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 12534
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 27314048
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 2849
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 764849
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
          "id": "56a2bace9f27526d9066a1d05ff9161d012ecab6",
          "message": "fix(tls): honor `ciphers`/`SECLEVEL` from every configured source when building TLS listeners (#1841)\n\n* fix(tls): honor ciphers/SECLEVEL from every configured source when building TLS listeners\n\nA TLS listener has exactly one effective cipher string: OpenSSL takes the\ncipher list (and any @SECLEVEL, which governs client-cert chain\nverification) from the context the server was created with; SNI-swapped\ncontexts don't carry their own cipher list onto the connection. Harper\napplied only tls.ciphers ?? tls[0].ciphers and silently ignored every\nother configured value — tls[] entries beyond [0] and certificate\nrecords, including client-CA records carrying DEFAULT@SECLEVEL=0 for\nSHA-1-signed chains, which then failed with authorizationError\nUNSPECIFIED on valid in-date certs.\n\nresolveEffectiveTlsCiphers (security/keys.ts) now resolves the listener\nstring from all sources: top-level tls.ciphers wins; otherwise tls[]\nentries plus relevant cert records (uses-matched, and authorities when\nthe listener verifies client certs) are candidates, with the lowest\nexplicit @SECLEVEL winning conflicts and everything ignored logged.\nPost-boot changes to the resolved value warn (once per value) that a\nrestart is required. Bun path untouched (BoringSSL has no @SECLEVEL).\n\nCloses #1840\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test(tls): guard seclevel test teardown when setup fails early\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(tls): compose suite and minimum SECLEVEL per listener instead of picking one cipher string\n\nAddresses the external review on #1841: config array entries are now\nrelevance-filtered like certificate records (CA entries only when the\nlistener verifies client certs; uses matched with the selector's\ntolerant rule incl. legacy 'https' and no-uses generics), the suite\nlist is preserved from the highest-priority suite-bearing candidate\nwith only the minimum explicit @SECLEVEL composed on (no assumed\nruntime default level), and the operations API listener resolves from\noperationsApi.tls before root tls so an inherited-certificate override\nis no longer ignored.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:39:05Z",
          "url": "https://github.com/HarperFast/harper/commit/56a2bace9f27526d9066a1d05ff9161d012ecab6"
        },
        "date": 1784373627000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 20707
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 13120
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13984
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 32207872
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 11656
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4848
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
          "id": "8b1c12b6b0de289f9b1657b3b66a9f43209adcb9",
          "message": "Merge pull request #1385 from HarperFast/kris/nextjs-caller-ci\n\nci: run Next.js adapter integration suite against harper PRs (downstream gate)",
          "timestamp": "2026-07-18T21:23:10Z",
          "url": "https://github.com/HarperFast/harper/commit/8b1c12b6b0de289f9b1657b3b66a9f43209adcb9"
        },
        "date": 1784460185000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 20543
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15686
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 12727
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 31884160
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 11744
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2538
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
          "id": "1e2877d0f19535352d4e70b5a0db36388eee6ded",
          "message": "Merge pull request #1825 from HarperFast/fix/typed-resources-sandbox-exports\n\nfix(sandbox): wire the six typed-resources exports into the component sandbox",
          "timestamp": "2026-07-20T04:17:11Z",
          "url": "https://github.com/HarperFast/harper/commit/1e2877d0f19535352d4e70b5a0db36388eee6ded"
        },
        "date": 1784548487000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 18093
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 14292
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13797
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 29915200
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10012
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2327
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "jcohen-hdb",
            "username": "jcohen-hdb",
            "email": "jacob@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "1e1edc666ad373a0fbfec4df4d3f0e130be13529",
          "message": "Ignore node_modules symlinked into integration fixtures by dev-mode boots\n\nharper dev <fixture> runs symlinkHarperModule against the component dir,\nplanting node_modules/harper inside integrationTests/fixtures/* — untracked\nand unignored, it has previously slipped into a commit (#1828 required an\namend). Discovered during runtime verification of this branch.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-21T02:16:25Z",
          "url": "https://github.com/HarperFast/harper/commit/1e1edc666ad373a0fbfec4df4d3f0e130be13529"
        },
        "date": 1784633636000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 17993
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 13137
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13193
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 25443392
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 9215
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2010
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
          "id": "07c2bbcb9ec535a7d0c529cc47301bfc33c8ed31",
          "message": "Pin Bun version in integration CI\n\nAvoid setup-bun's floating-version tag lookup so transient GitHub API failures do not fan out across all Bun shards.\n\nCo-Authored-By: Codex <noreply@openai.com>",
          "timestamp": "2026-07-22T11:20:50Z",
          "url": "https://github.com/HarperFast/harper/commit/07c2bbcb9ec535a7d0c529cc47301bfc33c8ed31"
        },
        "date": 1784720037000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 27399
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 18706
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 17911
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 33254720
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10829
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2396
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
          "id": "cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa",
          "message": "Fix indentation drift in getStringPrefixUpperBound\n\nApplying Gemini's suggested diff verbatim left the function body one\ntab shallow, failing prettier --check.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-22T23:34:08Z",
          "url": "https://github.com/HarperFast/harper/commit/cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa"
        },
        "date": 1784806567000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 21351
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 19808
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13803
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34964288
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10073
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2028
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
          "id": "b8c843a24a4b2b3f002a2b786415333fd7f3b597",
          "message": "fix(query): stop query planning from mutating the caller's conditions (#1911)\n\n* fix(query): stop query planning from mutating the caller's conditions\n\nTable.search()/get() took the caller's conditions by reference and annotated\nthem in place as it planned the query: it pushes a `{ comparator: 'sort' }`\npseudo-condition for index-order alignment, sets `descending`, caches\n`estimated_count`, collapses chained conditions, and coerces values — all on\nthe caller's entry objects. A caller that reuses the same array or condition\nobjects across queries (a natural pattern for a module-level `const`) then hits\nleaked state: a kept sort pseudo-condition is treated as a real valueless\ncondition and throws `Invalid value for attribute … \"undefined\"`; a stale\n`descending` silently reverses a later scan; a cached `estimated_count`\nmisplans. Whether it surfaced depended on live index estimates, so it read as\nphantom nondeterminism.\n\nClone the conditions array and every entry (recursing into nested and/or groups)\nat intake, so all downstream planning mutation happens on our own objects and\nnever reaches the caller. Entries are small and shallow, so the copy is\nnegligible next to the query itself.\n\nFixes harper#1572.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* test(query): make the array-form target guard assert entry immutability\n\nPost-review follow-up. The array-form-target regression case only checked array\nlength + absence of a sort pseudo-condition, which don't change on that path\n(no sort → no push) — so it passed with or without the fix. Assert instead that\nthe caller's condition entry is untouched: its Date-typed bound stays the\noriginal string (not coerced in place) and no estimated_count is annotated. Now\nfails on origin/main and passes with the fix, like the other three cases.\n\nAlso note in cloneConditions why chainedConditions sub-entries are left shared\n(read-only during planning).\n\nComment generated by kAIle (Claude Opus 4.8)\n\n* refactor(query): hoist cloneConditions to module scope; plain node:assert in test\n\nReview follow-up (both non-blocking):\n- cloneConditions is stateless (no closure over search/makeTable), so hoist it\n  to module scope rather than re-creating the function on every search() call.\n- Use plain node:assert in the regression test per house style, with explicit\n  strictEqual/deepStrictEqual where strict semantics are wanted.\n\nComment generated by kAIle (Claude Opus 4.8)\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-24T00:33:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b8c843a24a4b2b3f002a2b786415333fd7f3b597"
        },
        "date": 1784892701000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 21811
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 17484
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 12018
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 32657792
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10169
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 1606
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1784978680000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 29709
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 19058
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 11250
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 29991296
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 9566
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2289
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1785065224000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 23074
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 13505
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 11529
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34915776
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10524
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4050
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
          "id": "fe3994f4031714027098f6ce250fa78e1264107b",
          "message": "test(txn): afterEach stub-restore safety net + unref race timers (bot review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-27T04:46:02Z",
          "url": "https://github.com/HarperFast/harper/commit/fe3994f4031714027098f6ce250fa78e1264107b"
        },
        "date": 1785153777000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 33736
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 18576
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 14677
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34188160
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 9795
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4130
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
          "id": "3e317c7f58f9263de64fd11cac8a0052831d16f8",
          "message": "Update integrationTests/upgrade/qa606-upgrade-structgrowth/resources.js\n\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-28T11:32:18Z",
          "url": "https://github.com/HarperFast/harper/commit/3e317c7f58f9263de64fd11cac8a0052831d16f8"
        },
        "date": 1785238745000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 16640
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15447
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 21691
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 36660736
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 11261
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4867
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
          "id": "35c1f423b9e05ac858ec14bec4346d06d274c2e1",
          "message": "fix(cli): refresh expired agent tokens; fix --once approval hang\n\nAddress heskew's two remaining non-blocking review notes on #1553:\n\n- `harper agent` hard-failed on an expired stored operation token instead\n  of self-healing via the refresh_token, unlike cliOperations.ts. Extract\n  the refresh logic into a shared `refreshExpiredOperationToken` helper in\n  cliOperations.ts and call it from both cliOperations and agentCli, so the\n  two transports can't drift again.\n- `--once` against a real TTY drains stdin via readAllStdin() before the\n  first turn; if that turn then needed approval, resolveApprovals() built a\n  new readline on the already-ended stdin and question() never resolved.\n  Track actual stdin consumption (opts.stdinConsumed) instead of relying on\n  isTTY, and fail loudly in that case like the non-TTY path already does.\n\nRefs #1553\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T23:46:42Z",
          "url": "https://github.com/HarperFast/harper/commit/35c1f423b9e05ac858ec14bec4346d06d274c2e1"
        },
        "date": 1785325381000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 29954
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 16858
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 23335
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34249664
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10983
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 1006
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
          "id": "b04af4d08dc96ffd6f657991b4fe105528e88c98",
          "message": "Merge pull request #1956 from HarperFast/fix/instance-post-create\n\nfix(resources): restore v4 super.post create on collection posts",
          "timestamp": "2026-07-29T23:58:36Z",
          "url": "https://github.com/HarperFast/harper/commit/b04af4d08dc96ffd6f657991b4fe105528e88c98"
        },
        "date": 1785411323000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 30148
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 16559
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 18682
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 29543040
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 8512
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2793
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
          "id": "fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:46Z",
          "url": "https://github.com/HarperFast/harper/commit/fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20"
        },
        "date": 1785498060000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 23190
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 15391
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 14512
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 33876416
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10960
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2080
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T02:50:15Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785583611000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 32130
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 21721
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 19134
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 34603008
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 10663
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 4460
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T02:50:15Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785669947000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 32342
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 14955
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 14008
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 32126144
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 9756
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 2889
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
          "id": "f3246b9982eec796599740931f1c236e94957cd5",
          "message": "ci: invert canary conclusion polarity so it doesn't poison nightly-gate\n\nPer cross-model review (domain adjudication) — the sharpest finding\nacross this whole review cycle: moving the canary to its own workflow\nfixed integration-tests.yml's conclusion, but the nightly-gate triage\nroutine sweeps every `--event schedule` workflow with no per-workflow\nallowlist. Wiring the test step's raw exit code to the job conclusion\nwould make the every-night-until-fixed EXPECTED outcome (harper#2025\nstill reproducing) a permanent red that nightly-gate dutifully triages\nforever — while the one outcome anyone actually wants to hear about,\nthe defect clearing upstream, would be silently green and fire no\nalert. Backwards polarity for every consumer.\n\nInvert it: the canary tests failing (matching harper#2025) is now this\njob's SUCCESS; the tests unexpectedly passing is what fails it loudly,\nwith an ::error:: pointing at removing the pin. Also restores the\ncoverage-scope note that got dropped in the move to the standalone\nfile, adds a least-privilege permissions block, and cross-references\nthe duplicated pin-version constant between the two files.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-03T12:02:20Z",
          "url": "https://github.com/HarperFast/harper/commit/f3246b9982eec796599740931f1c236e94957cd5"
        },
        "date": 1785758633000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 6857
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 5910
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 5641
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 9306368
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 3221
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 766
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
          "id": "b4196a3b4d32eac6c73c353fc5970f7a01ca5fe1",
          "message": "test(server): pin both HTTP servers' mid-stream SSE throw shapes (uWS divergence)\n\n`b: ThrowGen (throws after 2 of 5) over SSE` was the sole failure on\n`Integration Tests 5/6 (uWS HTTP)`; every other shard was green. Rather\nthan assume the assertion over-reached, QA-886 characterized the two\nservers byte-for-byte on the identical workload.\n\nBoth deliver exactly the two pre-throw events (`{\"n\":0}`, `{\"n\":1}`),\nbyte-identical modulo a uWS-only leading `:\\n\\n` header-flush comment.\nThey diverge only at termination:\n\n- Node (`server/http.ts` pipeBodyToResponse, ~426-461) closes the socket\n  WITHOUT the terminal `0\\r\\n\\r\\n` chunk, deliberately -- its own comment\n  says this \"correctly signals a failed/truncated transfer... instead of\n  implying it completed\". The incomplete chunked framing is the only\n  signal a client gets, and it is the intended one.\n- uWS (`server/serverHelpers/uwsServer.ts` streamResponse, ~340-356)\n  routes the source's 'error' and 'end' handlers through the SAME\n  `finish(true)` -> `res.end()` path, so it DOES write the terminal\n  chunk. The wire response becomes byte-indistinguishable from a\n  generator that legitimately finished: a mid-stream failure is silently\n  presented to the client as success.\n\nSo the spec was right and the uWS path is wrong. `HttpResponse.close()`\nis available and is the correct primitive for the error branch; that is a\nproduct fix, tracked separately as F-272 and not made here.\n\nThis change pins BOTH shapes explicitly rather than skipping under uWS,\nso the divergence stays visible in the suite and cannot drift or be\n\"fixed\" in the wrong direction unnoticed. Verified locally at\n`c28e5f83f`: 11/11 green under Node and 11/11 under HARPER_UWS_HTTP=1.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-04T11:40:48Z",
          "url": "https://github.com/HarperFast/harper/commit/b4196a3b4d32eac6c73c353fc5970f7a01ca5fe1"
        },
        "date": 1785843749000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 30682
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 16470
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13408
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 29251072
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 5006
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 1536
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
          "id": "ffef12f8c8992eb86c5014d85d4bd273df8f18d5",
          "message": "Test Bun resolution candidate tracking directly\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-05T11:21:29Z",
          "url": "https://github.com/HarperFast/harper/commit/ffef12f8c8992eb86c5014d85d4bd273df8f18d5"
        },
        "date": 1785929980000,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "unit": "ops/sec",
            "value": 20473
          },
          {
            "name": "indexed-write indexed3",
            "unit": "ops/sec",
            "value": 18032
          },
          {
            "name": "indexed-write indexed5",
            "unit": "ops/sec",
            "value": 13149
          },
          {
            "name": "ttl-churn total inserts",
            "unit": "records",
            "value": 22312512
          },
          {
            "name": "concurrent-rw read ops",
            "unit": "ops",
            "value": 3161
          },
          {
            "name": "concurrent-rw write ops",
            "unit": "ops",
            "value": 370490
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
          "id": "3406de50c541f18e42a693b21e4d208f7936cc16",
          "message": "Address PR review: fileURLToPath for the CLI guard, fix README claim\n\n- Use fileURLToPath(import.meta.url) instead of a raw file:// string\n  comparison against process.argv[1] — the latter breaks on Windows\n  path separators/drive-letter formatting (gemini-code-assist).\n- The README's \"only quick-scale/non-main runs are excluded\" claim was\n  only true for the new storage workflow; ycsb-nightly.yml's auto-push\n  has no scale gate at all, so a manual YCSB dispatch at any scale still\n  publishes today. Narrowed the doc to state the actual, differing\n  conditions for each workflow (claude bot).\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-05T13:03:00Z",
          "url": "https://github.com/HarperFast/harper/commit/3406de50c541f18e42a693b21e4d208f7936cc16"
        },
        "date": 1785941142200,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 28726,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 18695,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 11240,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 25131136,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 3317,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 495760,
            "unit": "ops"
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
          "id": "01d8562225c88abe8d62ba37e520aa5b289f76c7",
          "message": "Merge pull request #2075 from HarperFast/david/last-super-user-guard\n\nReject user and role changes that would remove the last active super_user",
          "timestamp": "2026-08-05T21:25:48Z",
          "url": "https://github.com/HarperFast/harper/commit/01d8562225c88abe8d62ba37e520aa5b289f76c7"
        },
        "date": 1786019196708,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 6089,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 5549,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 5709,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 10294016,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 3955,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 1102,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f85e66b92abda03b6dd7cbcfde05e09a46215da7",
          "message": "chore(deps): raise msgpackr floor to ^2.0.5\n\nThe published harper@5.2.0 shipped an npm-shrinkwrap.json pinning\nmsgpackr 2.0.4. main's package-lock.json already resolves 2.0.5\n(bumped after the v5.2.0 tag in a264242b4 as an npm-install side\neffect of ^2.0.4), so the next release cut from main already ships\n2.0.5. This raises the declared floor to ^2.0.5 to make that intent\nexplicit and guard against a future lock regeneration ever pinning\nbelow 2.0.5. No functional change; the resolved lock entry is\nunchanged.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-06T16:19:21Z",
          "url": "https://github.com/HarperFast/harper/commit/f85e66b92abda03b6dd7cbcfde05e09a46215da7"
        },
        "date": 1786103461385,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 32641,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 19343,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 17542,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 28797056,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 8485,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 918,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786189436586,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 20329,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 16284,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 12949,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 31904704,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 9382,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 1397,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786275832959,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 31376,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 15460,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 11658,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 30793920,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 7626,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 1387,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786363091533,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 33932,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 16757,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 16464,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 31341312,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 9060,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 2348,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786449077638,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 27995,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 15437,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 19058,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 31617792,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 8765,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 3296,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "0a727e8bd5931e9266344b757a8680f50f5980ff",
          "message": "fix(deps): update dependency argon2 to v0.45.1 (#2132)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-12T01:50:06Z",
          "url": "https://github.com/HarperFast/harper/commit/0a727e8bd5931e9266344b757a8680f50f5980ff"
        },
        "date": 1786535518519,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 27659,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 16037,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 12429,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 30357184,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 4033,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 341593,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "09c4580106cc399ea7a4dd7132361a61d2d2d561",
          "message": "Merge pull request #2124 from HarperFast/fix/sql-engine-top-limit-normalization\n\nfix(sql-engine): honor SELECT TOP n and floor fractional LIMIT/OFFSET",
          "timestamp": "2026-08-12T22:47:19Z",
          "url": "https://github.com/HarperFast/harper/commit/09c4580106cc399ea7a4dd7132361a61d2d2d561"
        },
        "date": 1786621936602,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 24304,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 24447,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 14552,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 26711552,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 3775,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 262124,
            "unit": "ops"
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
          "id": "871fad0fa2ece52e4adfbfa102536c54560c67e3",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:23:55Z",
          "url": "https://github.com/HarperFast/harper/commit/871fad0fa2ece52e4adfbfa102536c54560c67e3"
        },
        "date": 1786708298869,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 22658,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 14751,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 11735,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 29975936,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 7874,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 1767,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786793942996,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 24971,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 17177,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 15996,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 34213056,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 9328,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 3798,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786880335030,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 31160,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 28212,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 16943,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 30453120,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 4074,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 325335,
            "unit": "ops"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786966931008,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 33116,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 13939,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 14245,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 31155584,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 8878,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 2624,
            "unit": "ops"
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
          "id": "c2cae054c4c317af1e7a1e2d1aea4e8095a39df5",
          "message": "refactor(integrationTests): extract waitForRouteReady from restartHttpWorkers (#1904)\n\n* refactor(integrationTests): extract waitForRouteReady from restartHttpWorkers\n\nThe HTTP-route-readiness polling loop was duplicated: restartHttpWorkers()\nin lifecycle.mjs has it inline, and eviction-secondary-index.test.ts\nre-implements the same ~15-line block verbatim for the no-restart-needed\ncase (component pre-installed). Extract the polling loop into a standalone\nexported waitForRouteReady(client, probePath, timeoutMs), used both by\nrestartHttpWorkers() internally and directly by tests that only need to\nawait route registration without triggering a worker restart.\n\nRefs #1886\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Apply suggestion from @gemini-code-assist[bot]\n\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>\n\n---------\n\nCo-authored-by: Claude Sonnet 5 <noreply@anthropic.com>\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-18T11:34:37Z",
          "url": "https://github.com/HarperFast/harper/commit/c2cae054c4c317af1e7a1e2d1aea4e8095a39df5"
        },
        "date": 1787053370243,
        "tool": "customBiggerIsBetter",
        "benches": [
          {
            "name": "indexed-write baseline",
            "value": 21714,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed3",
            "value": 14723,
            "unit": "ops/sec"
          },
          {
            "name": "indexed-write indexed5",
            "value": 13269,
            "unit": "ops/sec"
          },
          {
            "name": "ttl-churn total inserts",
            "value": 31157056,
            "unit": "records"
          },
          {
            "name": "concurrent-rw read ops",
            "value": 2938,
            "unit": "ops"
          },
          {
            "name": "concurrent-rw write ops",
            "value": 497947,
            "unit": "ops"
          }
        ]
      }
    ],
    "Storage Benchmarks Latency/Size (ST-1/ST-2/ST-5)": [
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
        "date": 1783425529000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 10118.76
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 10118.76
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 452.9
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1453.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1915
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
          "timestamp": "2026-07-08T03:08:21Z",
          "url": "https://github.com/HarperFast/harper/commit/a0f4a51acfa917fd544c88eec4b8893b5d04512e"
        },
        "date": 1783510436000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9712.09
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9712.09
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 155.1
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 439.9
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 714.9
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Lavinia",
            "username": "ldt1996",
            "email": "lavinia@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "f10eba31e88286b53f10f7cdfc29dcd45d1cabfa",
          "message": "fix(storage): replay conflict retry on a fresh transaction after ERR_TRY_AGAIN (#1696)\n\n* fix(storage): replay conflict retry on a fresh transaction after ERR_TRY_AGAIN\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): keep retries from deduping against their own audit entry\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* chore: log the swallowed abort error (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): per-write sticky own-audit-entry marker for retry dedup (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(storage): abort before the MAX_RETRIES throw, pin change-feed entries in tests (review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>",
          "timestamp": "2026-07-09T11:46:49Z",
          "url": "https://github.com/HarperFast/harper/commit/f10eba31e88286b53f10f7cdfc29dcd45d1cabfa"
        },
        "date": 1783598387000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9903.27
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9903.27
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 271.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1296.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1748.8
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
        "date": 1783684739000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9755.74
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9755.74
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 173
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 399.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 806.9
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
        "date": 1783768882000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 10324.4
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 10324.4
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 181.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 362.2
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 590.7
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
          "id": "31de6a3bebc5fec85a8eba98087fda00dbc3f477",
          "message": "fix: pin uWebSockets.js via tarball URL, not a github: git spec\n\nSame issue as harper-pro#561: the github: shorthand\n(github:uNetworking/uWebSockets.js#v20.68.0) gets re-resolved by npm as\ngit+ssh://github.com/... on any npm install. Our Docker build stage has\nno SSH credentials for github.com, so npm silently skips the (optional)\ndependency and the shipped image never bundles the native addon —\nHARPER_UWS_UDS / HARPER_UWS_HTTP are inert even when set.\n\nAn explicit git+https:// spec doesn't fix this either — confirmed with\na clean npm cache that npm/hosted-git-info canonicalizes ANY\ngithub.com git dependency back to git+ssh:// regardless of requested\nprotocol. Switching to a plain tarball URL\n(https://.../archive/<sha>.tar.gz) sidesteps hosted-git-info entirely:\nnpm treats it as a remote-tarball dependency, resolved stays a plain\nhttps URL with a pinned integrity hash, and it can't regress on a\nfuture npm install.\n\nVerified npm ci installs all 15 native .node binaries in a\nHOME-stripped, credential-less environment (matching the Docker build\nstage) both before and after a full npm install regenerates the\nlockfile from package.json.",
          "timestamp": "2026-07-11T22:53:13Z",
          "url": "https://github.com/HarperFast/harper/commit/31de6a3bebc5fec85a8eba98087fda00dbc3f477"
        },
        "date": 1783855434000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 10175.76
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 10175.76
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 134.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 378.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 512.6
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
          "id": "8bf5921e06349611773b4c1d4363088801d3b974",
          "message": "ci(review): canary Claude reviews on claude-sonnet-5 (harper only) (#1759)\n\nOverride the reusable's model default (claude-sonnet-4-6) for this\nrepo's claude-review caller. harper is the A/B canary: highest review\ntraffic, and every ai-review-log entry records Model:, so calibration\ncan compare sonnet-5 vs sonnet-4-6 verdict mix directly at the same\nprompt ref (9cf49d2). Intro pricing ($2/$10 through 2026-08-31) offsets\nthe new tokenizer (~30% more tokens for equivalent text).\n\nWatch item: Sonnet 5 follows blocker-only severity instructions more\nliterally (documented code-review-harness effect) — if the deflation\nrate rises in the next calibration cycle, add coverage-first reporting\nto the run-notes surface before fleet rollout; if clean, promote to the\nreusable default.\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-13T00:05:21Z",
          "url": "https://github.com/HarperFast/harper/commit/8bf5921e06349611773b4c1d4363088801d3b974"
        },
        "date": 1783944022000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8799.72
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8799.72
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 129.9
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 515.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1126.1
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "56f8891b933e4638c9f622a0030570de4fd711a8",
          "message": "fix(deps): update all non-major dependencies",
          "timestamp": "2026-07-14T00:14:28Z",
          "url": "https://github.com/HarperFast/harper/commit/56f8891b933e4638c9f622a0030570de4fd711a8"
        },
        "date": 1784028540000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 7179.26
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 7179.26
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 190.3
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 682.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1178.1
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
          "id": "182971ad16a3ba6986ffae194067965505d5bfa8",
          "message": "Typed, discoverable resources — code-first defineTable + per-method request contract (RFC 0001) (#1767)\n\n* feat(resources): typed, discoverable resources — code-first defineTable + per-method request contract\n\nImplements RFC 0001 (design PR #1503): the mergeable implementation of both\nauthoring front-ends, integrated onto current main.\n\nPillar 1/2b — code-first schema (resources/defineTable.ts):\n  `defineTable(name, shape, opts)` + `types` author a table in TypeScript and\n  eagerly register through the same `table()` factory GraphQL drives — the return\n  IS the live class, with per-verb shapes inferred as `$record/$insert/$upsert/\n  $patch/$query` projections. Relations via lazy thunks (+ relationOf/hasManyOf\n  escape hatch for mutual pairs).\n\nPillar 2 — per-method request contract (resources/withSchema.ts):\n  `defineResource(contract, impl)` (function form) + `Resource.withSchema(contract)`\n  (class form). Handler types are derived from a runtime contract; a handler gets\n  the SAME RequestTarget, structurally narrowed (subset, not fork). Each declared\n  verb validates/coerces query/body before dispatch and throws a structured 400\n  (ValidationError, per-field {path,code,message}[]). Built-in `t`/`schemaOf`\n  reduce to JsonSchemaFragment — one vocabulary across table fields, query, and\n  bodies; a defineTable projection slots into a contract body via\n  schemaOf({ table, projection }). Nullability: non-nullable by default, `.nullable`\n  opts into null (table-derived bodies mirror Table.validate).\n\nCross-cutting:\n  - ValidationError (extends ClientError, 400); Table.validate refactored to the\n    same structured shape (HTTP-title message preserved).\n  - OpenAPI emits declared query/body/response for parameterised routes.\n  - MCP drives tool input/output off the contract and binds arbitrary path params\n    + query (applyContractInputs), lifting the generated-verb binding restriction\n    for contract resources.\n  - Shared attributeToFragment hardened with a nested-object branch; derive.ts\n    Object/Array projection bugfix.\n\nIntegration with main (the RFC branch was ~1007 lines behind on these files):\n  merged with main's newer MCP paramroutes work (paramBinding gating, isSimpleIdRoute,\n  mcpResources) and the liveResource authz fix — a request contract now exempts a\n  resource from the generated-handler binding restriction.\n\nDesign summary in resources/DESIGN.md; full RFC + type spikes remain in #1503.\nType contract verified against built exports in docs/rfcs/spikes/0001/*-real.check.ts.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* fix(withSchema): address PR review — validation hardening + lint-safe test import\n\n- scope the Date type-check exception to string/date-time fields (a Date must not\n  pass validation for number/boolean/array/object schemas)\n- override target.getAll alongside get so multi-value query params read coerced\n- reject empty/whitespace numeric query params instead of Number('')→0\n- harden MCP wrapError: read the untrusted err's props inside a try/catch (revoked\n  Proxy / throwing getters must not crash the error path)\n- application-contract.test.js: require('assert') + strict methods (node:assert/strict\n  is oxlint-banned via no-restricted-imports)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* refactor: rename withSchema.ts → defineResource.ts; drop spike/RFC artifacts\n\n- rename resources/withSchema.ts → resources/defineResource.ts (defineResource is\n  the primary API; Resource.withSchema stays the class-form name) + the test file\n- remove docs/rfcs/ (the *-real.check.ts type-contract proofs + tsconfig) — a real\n  PR shouldn't carry spike/RFC scaffolding; those live in the design PR (#1503)\n- strip references to the spikes and the RFC doc (which are not in this PR) from\n  code/test comments and resources/DESIGN.md; keep the #1503 pointer for the record\n\nNo behavior change. 100 unit tests green.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n* test(types): re-add public type-contract tests + wire into CI\n\nStandalone type-tests under unitTests/types/ (no spike/RFC framing): assert the\nSHIPPED public types (imported from the built dist) against the contract —\ndefineTable projections + relations, and the defineResource/withSchema handler\ninference, narrowed target, subset property, and negative (@ts-expect-error) cases.\n\n- unitTests/types/{defineResource,defineTable}.type-test.ts + tsconfig.json (strict,\n  noEmit, skipLibCheck; isolated from the main build/typecheck, which don't include\n  unitTests/, and from mocha, which only loads js/mjs)\n- `npm run test:types` (tsc --project unitTests/types/tsconfig.json)\n- CI: a \"Type contract tests\" step in unit-test.yml (after Build, gated to one Node\n  version) so a regression in the public type surface fails CI\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-14T19:37:17Z",
          "url": "https://github.com/HarperFast/harper/commit/182971ad16a3ba6986ffae194067965505d5bfa8"
        },
        "date": 1784115004000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8685.21
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8685.21
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 467.4
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1585.9
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 3342.1
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
          "id": "3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02",
          "message": "Reshape deploy_component registryAuth into a general-purpose credentials array (#1797)\n\n* Reshape deploy_component registryAuth into a general-purpose credentials array\n\n`registryAuth` was an npm-only array of `{ registry, token|secret, scope }`\nentries. Rename it to `credentials` and treat the array as kind-heterogeneous:\nan entry's kind is implied by its identifying key (`registry` = npm registry\nauth) rather than a discriminator field, so a git-host kind keyed by `host`\n(#1792) becomes another item alternative rather than another schema rewrite.\n\nThe ingest/resolve pipeline, secrets-store integration, reference-only\nreplication, and every security invariant from #1717 are unchanged — this is a\nrename plus the seams for a second kind. Identifiers follow: ingestRegistryAuth\n→ ingestCredentials, resolveRegistryAuth → resolveCredentials, and the persisted\nforms (applicationConfig.credentials, hdb_deployment.credentials) match the\noperation field.\n\nSince #1717 has not shipped in a GA release, this is a clean break rather than an\nalias. Because operation validation allows unknown keys, a stale `registryAuth`\nis explicitly rejected — otherwise the deploy would silently install with no\ncredentials. It also stays in the operations-log strip list, since that redaction\nruns ahead of validation and a stale caller's token must not reach the log.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Filter Application.registryCredentials to registry-shaped entries\n\nThe credentials array is kind-heterogeneous by design (registry today,\na planned git-host kind later), but Application's constructor assigned\nit straight to registryCredentials, which buildNpmrcContent assumes is\nregistry-shaped. Filter defensively so a future non-registry entry\ncan't reach it.\n\nAddresses gemini-code-assist review comment on PR #1797.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Authenticate private git-reference deploys from an in-memory credential (#1799)\n\n* Authenticate private git-reference deploys from an in-memory credential\n\nA `github:org/repo` package against a private repo needs a credential for the\n`git ls-remote`/`git clone` npm shells out to. Every obvious way to supply one\npersists it: userinfo in the URL lands in the package spec and the lockfile, a\ncredential helper or `.npmrc` is a file, and an env var is readable by every\ndescendant process.\n\nInstead the token stays in the deploying process's memory and is served over a\nper-deploy Unix socket in a 0700 directory. git is pointed at\ngitCredentialHelper.js — a secret-free script that relays git's request over\nthat socket — and the socket dies with the spawn that needed it. The token\nreaches disk, argv, the package spec, the operation body and the operations log\nnowhere along the way.\n\nThe credential rides as a second kind in the `credentials` array from #1797:\n`{ host, token|secret, username? }`, discriminated by `host` the way npm entries\nare by `registry`. Ingest, seal-into-hdb_secret, grant-check, resolve-at-use and\nreplicate-as-reference are the existing #1717 paths, unchanged — only the\nderived secret name (`deploy.<component>.<host>`) and the injection mechanism are\nnew. resolveCredentials now rejects an unrecognized kind rather than resolving it\ninto a half-empty entry, symmetric with the guard ingestCredentials already had.\n\nWiring, in order of preference: `credential.helper` via GIT_CONFIG_* (structured\nkey=value protocol, no prompt parsing) with GIT_ASKPASS as the fallback for git\n< 2.31, which ignores GIT_CONFIG_*. Inherited credential helpers are reset to\nempty first, so a machine configured with `credential.helper=store` cannot write\nthis token to ~/.git-credentials when git reports the successful authentication\nback to its helper chain. The askpass path decides username-vs-password prompt\nstructurally (userinfo present in the echoed URL) rather than by matching\nEnglish, since git localizes those prompts.\n\nOnly the spawn that clones (`npm pack`) is given this environment. The\n`npm install` that follows — where a dependency's install script can run — never\nsees it, and the socket is already closed by then.\n\nRefs #1792. Stacked on #1797.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Keep the git credential out of reach of clone-time install scripts\n\nPacking a git reference is not just a download. npm clones the repo and, when\nits manifest has a prepare/build/install script, runs `npm install` inside the\nclone and then that script — so the repository's own code and its dependencies'\ninstall scripts execute on this node, inside the clone spawn, inheriting its\nenvironment. Verified against real npm: a transitive dependency's `preinstall`\nsees HARPER_GIT_CREDENTIAL_SOCKET and can ask the socket for the token. That is\nexactly the reach #1792 says the credential must not have, and closing the\nsocket before `npm install` did not close it, because this all happens earlier,\nduring `npm pack`.\n\nSo a credentialed clone runs with `--ignore-scripts` unless the deploy set\ninstall_allow_scripts, which is the operator explicitly asking for that code to\nrun here; that case is allowed and logged, naming the exposure it accepts. Note\nthis also means a git-reference deploy runs scripts at pack time regardless of\ninstall_allow_scripts today — the flag only ever reached the install spawn. That\ninconsistency is left alone here (fixing it changes behavior for existing public\ngit deploys) but is worth its own issue.\n\nWindows now fails closed instead of serving the credential over a named pipe: a\npipe is created with a default security descriptor that can leave it readable by\nother local users, and the whole confinement argument rests on the 0700\ndirectory a Unix socket sits in. Better to refuse than to offer a quietly weaker\nchannel.\n\nAlso from review: cap the request a peer can stream at the socket (an unbounded\n`request +=` was an OOM), and remove the socket's temp directory when listen()\nfails, since no session is returned and nothing would otherwise clean it up.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Harden the git credential channel against persistence and downgrade\n\nA second cross-model review pass (Codex) surfaced several ways the credential\ncould still escape memory:\n\n- **Cleartext transport.** git asks for `http://` credentials exactly as it\n  asks for `https://`, so a `git+http://` package (or a remote downgraded by a\n  redirect) would put the token on the wire in the clear. answerFor now serves\n  only over https, with an exemption for loopback (where no network is involved\n  and the integration tests run).\n\n- **git < 2.31.** Those versions ignore GIT_CONFIG_* entirely, so the\n  credential.helper reset that stops an inherited `store` helper from writing the\n  token to ~/.git-credentials is silently dead — and the GIT_ASKPASS fallback\n  would still feed that helper a successful credential to persist. There is no way\n  to disable an inherited helper on those versions, so the session now refuses to\n  start on one rather than leak. (The reset itself is verified end-to-end against\n  a real clone with both a global and a URL-scoped `store` helper configured; the\n  earlier concern that a URL-scoped helper bypasses the reset did not reproduce —\n  git's credential machinery honors the reset, `--get-urlmatch` merely shows raw\n  config.)\n\n- **Newline in a resolved token.** A literal token is schema-rejected for CR/LF,\n  but one resolved from an hdb_secret row was not — and git's protocol is\n  line-based (askpass reads only the first line), so such a token would truncate\n  or inject protocol attributes. Guarded at the serve boundary, matching the\n  .npmrc writer.\n\n- **Unknown keys persisting.** Operation validation runs allowUnknown, so a\n  credential entry like `{host, secret, password: \"literal\"}` would carry that\n  stray field through ingest into config, hdb_deployment, and replication. Both\n  entry schemas are now `.unknown(false)`, and each forbids the other's\n  discriminator. assertApplicationConfig likewise rejects an entry that is both\n  kinds or carries a literal token, rather than coercing it to one kind.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Warn on duplicate git-credential hosts; lock in the no-custody strip\n\nReview follow-ups. Two entries for the same host in one deploy silently\nlast-write-wins (they also seal to the same derived secret name), so warn rather\nthan drop quietly. And a regression test pins the security property that a\nliteral git token on a node without custody yields no persistable reference and\nis therefore stripped from the replicated op body.\n\nRefs #1792.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n\n* Address 5 review comments; fix a backpressure bug hanging the OOM-cap test\n\n- close(): snapshot the connections Set before destroying, so destroy()'s\n  synchronous 'close' listener (which deletes from the same Set) can't skip\n  a connection mid-iteration.\n- answerFor(): guard against a non-object request before touching .host.\n- parseAskpassPrompt(): move the URL parse+decode inside the existing\n  try/catch so a malformed percent-encoded username can't throw past it.\n- gitCredentialClone.test.js: resolve GIT_HTTP_BACKEND in a try/catch so a\n  missing git binary can't crash the whole suite loader before before()\n  gets a chance to skip; before() now also checks for that case.\n- operationsValidation.js: cap the git credential entry's token at\n  SECRET_MAX_LENGTH, matching the same limit already applied elsewhere.\n\nAlso fixes an unrelated pre-existing bug found while verifying: the OOM-cap\ntest's write loop gave up permanently the first time socket.write() returned\nfalse for backpressure (the `&&` chain short-circuits), which happens well\nbefore the server-side 64KB cap is reached — so the test hung forever\nwaiting for a 'close' the server had no reason to send. Confirmed via a\nclean-checkout diff that this predates this task's changes. The production\ncap-enforcement logic itself was already correct; only the test's flow\ncontrol was wrong. Now resumes writing on 'drain' instead of giving up.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Update components/secretOperations.ts\n\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Fix CI: git-secret naming test drift, and prepare-script leak on npm<11\n\nsecretOperations.test.js still asserted the pre-review-fix secret name\n(deploy.<app>.<host>); a prior commit on this branch added the `.git`\nkind segment to deriveGitSecretName to close a same-host collision\nbetween git and registry secrets (per review), but didn't update the\ntests that pin the literal name. Update the 5 affected assertions to\nthe new, collision-safe name and note why in deriveGitSecretName's doc\ncomment.\n\nAlso fix a real Node-22-only failure: a credentialed git clone relied\non `npm pack --ignore-scripts <git-url>` to keep a repository's\nprepare script from running while the credential socket is reachable.\npacote's DirFetcher runs `prepare` unconditionally on npm <11.0.0 (the\nignoreScripts guard was only added upstream in npm 11) — exactly what\nNode 22's bundled npm ships, confirmed by reproducing against the real\nnpm 10.9.8 binary. For a recognized git-reference identifier with\nscripts disallowed, clone it ourselves (still authenticated via the\ncredential session's env) and strip its lifecycle scripts before\npacking, sidestepping the buggy npm code path entirely — the same\nmechanism harper#1819 lands for the uncredentialed case.\n\nVerified against npm 10.9.8: the prepare-script test fails identically\nto CI on the pre-fix code and passes reliably with the fix.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Resolve hosted-git shorthand (github:/gitlab:/bitbucket:/gist:) in parseGitReference\n\nderivePackageIdentifier defaults a bare owner/repo package identifier to\ngithub:owner/repo, but parseGitReference only recognized explicit\ngit+.../git:// URL forms, so that shorthand — the PR's own worked example —\nfell through to the npm pack --ignore-scripts fallback documented as\nunreliable on npm <11. Extend parseGitReference to resolve github:, gitlab:,\nbitbucket:, and gist: shorthand to a concrete https clone URL so it routes\nthrough the clone-and-strip-scripts path instead.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>\n\n* Resolve npm-style semver: committishes before git checkout\n\n#1799's own worked example (`github:my-org/my-app#semver:v1.2.3`) documented a\ncommittish naming a semver range, but packGitReferenceWithoutScripts passed it\nstraight to `git checkout`, which has no notion of npm's `semver:` syntax and\nsimply failed.\n\nAdds resolveCommittish(), which lists the clone's tags and resolves the range\nagainst them with the `semver` package (already a direct dependency), matching\nnpm's own git-dependency resolution: tags may carry a prefix ahead of the\nversion (`release-v1.2.3`), a percent-encoded range is decoded, and the\nresolved ref is checked out as `refs/tags/<name>` to avoid an ambiguous\nsame-named branch. A non-semver committish is unaffected.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n* Reject unsafe tag names before checkout in semver-committish resolution\n\nThe automated PR review on the previous commit found that resolveCommittish\nonly validated the semver-shaped suffix it matched in a tag name (e.g. the\n`v1.2.3` in `release-v1.2.3`), not the full tag string. Since git ref names\npermit shell metacharacters (`$`, backticks, `;`, `&`, `|`, parens — only\nwhitespace and a few other forms are disallowed), and nonInteractiveSpawn\nruns through a shell with no argument escaping, a tag name from the cloned\nrepository such as `$(touch${IFS}/tmp/x)v9.9.9` would execute as a command\nsubstitution on checkout — reachable specifically because semver resolution\npicks a tag out of the (untrusted, upstream) repo's own tag list, unlike a\nliteral committish which the deploying operator supplies directly.\n\nAdds a conservative safe-charset check on the full tag name; a tag failing\nit is excluded from resolution rather than sanitized, so it can never reach\nthe checkout spawn. Confirmed exploitable pre-fix (marker file executes) and\nblocked post-fix via a new regression test.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-15T23:03:58Z",
          "url": "https://github.com/HarperFast/harper/commit/3dbcf7b9e1eb107f1f242d9a01d74c5d67f06b02"
        },
        "date": 1784201439000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8352.35
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8352.35
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 141.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 340.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 455.9
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
          "id": "bf0c51a69c0b875e755b55a8036ace486aa5a1e9",
          "message": "Merge pull request #1285: New SQL engine on the Resource API (phases 0-5)\n\nNew SQL engine on the Resource API (phases 0-4; phase-5 cutover gated)",
          "timestamp": "2026-07-17T11:10:18Z",
          "url": "https://github.com/HarperFast/harper/commit/bf0c51a69c0b875e755b55a8036ace486aa5a1e9"
        },
        "date": 1784287680000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8082.13
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8082.13
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 483.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1751.1
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 2235.8
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
          "id": "56a2bace9f27526d9066a1d05ff9161d012ecab6",
          "message": "fix(tls): honor `ciphers`/`SECLEVEL` from every configured source when building TLS listeners (#1841)\n\n* fix(tls): honor ciphers/SECLEVEL from every configured source when building TLS listeners\n\nA TLS listener has exactly one effective cipher string: OpenSSL takes the\ncipher list (and any @SECLEVEL, which governs client-cert chain\nverification) from the context the server was created with; SNI-swapped\ncontexts don't carry their own cipher list onto the connection. Harper\napplied only tls.ciphers ?? tls[0].ciphers and silently ignored every\nother configured value — tls[] entries beyond [0] and certificate\nrecords, including client-CA records carrying DEFAULT@SECLEVEL=0 for\nSHA-1-signed chains, which then failed with authorizationError\nUNSPECIFIED on valid in-date certs.\n\nresolveEffectiveTlsCiphers (security/keys.ts) now resolves the listener\nstring from all sources: top-level tls.ciphers wins; otherwise tls[]\nentries plus relevant cert records (uses-matched, and authorities when\nthe listener verifies client certs) are candidates, with the lowest\nexplicit @SECLEVEL winning conflicts and everything ignored logged.\nPost-boot changes to the resolved value warn (once per value) that a\nrestart is required. Bun path untouched (BoringSSL has no @SECLEVEL).\n\nCloses #1840\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* test(tls): guard seclevel test teardown when setup fails early\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n* fix(tls): compose suite and minimum SECLEVEL per listener instead of picking one cipher string\n\nAddresses the external review on #1841: config array entries are now\nrelevance-filtered like certificate records (CA entries only when the\nlistener verifies client certs; uses matched with the selector's\ntolerant rule incl. legacy 'https' and no-uses generics), the suite\nlist is preserved from the highest-priority suite-bearing candidate\nwith only the minimum explicit @SECLEVEL composed on (no assumed\nruntime default level), and the operations API listener resolves from\noperationsApi.tls before root tls so an inherited-certificate override\nis no longer ignored.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n\n---------\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-17T20:39:05Z",
          "url": "https://github.com/HarperFast/harper/commit/56a2bace9f27526d9066a1d05ff9161d012ecab6"
        },
        "date": 1784373627000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9259.53
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9259.53
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 135.3
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 392.6
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 487.1
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
          "id": "8b1c12b6b0de289f9b1657b3b66a9f43209adcb9",
          "message": "Merge pull request #1385 from HarperFast/kris/nextjs-caller-ci\n\nci: run Next.js adapter integration suite against harper PRs (downstream gate)",
          "timestamp": "2026-07-18T21:23:10Z",
          "url": "https://github.com/HarperFast/harper/commit/8b1c12b6b0de289f9b1657b3b66a9f43209adcb9"
        },
        "date": 1784460185000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9161.23
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9161.23
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 140
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 340.2
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 409.2
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
          "id": "1e2877d0f19535352d4e70b5a0db36388eee6ded",
          "message": "Merge pull request #1825 from HarperFast/fix/typed-resources-sandbox-exports\n\nfix(sandbox): wire the six typed-resources exports into the component sandbox",
          "timestamp": "2026-07-20T04:17:11Z",
          "url": "https://github.com/HarperFast/harper/commit/1e2877d0f19535352d4e70b5a0db36388eee6ded"
        },
        "date": 1784548487000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8613.42
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8613.42
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 136.9
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 474.1
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 927.6
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "jcohen-hdb",
            "username": "jcohen-hdb",
            "email": "jacob@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "1e1edc666ad373a0fbfec4df4d3f0e130be13529",
          "message": "Ignore node_modules symlinked into integration fixtures by dev-mode boots\n\nharper dev <fixture> runs symlinkHarperModule against the component dir,\nplanting node_modules/harper inside integrationTests/fixtures/* — untracked\nand unignored, it has previously slipped into a commit (#1828 required an\namend). Discovered during runtime verification of this branch.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-21T02:16:25Z",
          "url": "https://github.com/HarperFast/harper/commit/1e1edc666ad373a0fbfec4df4d3f0e130be13529"
        },
        "date": 1784633636000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 7436.32
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 7436.32
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 153.6
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 536.7
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1022.9
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
          "id": "07c2bbcb9ec535a7d0c529cc47301bfc33c8ed31",
          "message": "Pin Bun version in integration CI\n\nAvoid setup-bun's floating-version tag lookup so transient GitHub API failures do not fan out across all Bun shards.\n\nCo-Authored-By: Codex <noreply@openai.com>",
          "timestamp": "2026-07-22T11:20:50Z",
          "url": "https://github.com/HarperFast/harper/commit/07c2bbcb9ec535a7d0c529cc47301bfc33c8ed31"
        },
        "date": 1784720037000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9508.3
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9508.3
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 143.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 403
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 619.3
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
          "id": "cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa",
          "message": "Fix indentation drift in getStringPrefixUpperBound\n\nApplying Gemini's suggested diff verbatim left the function body one\ntab shallow, failing prettier --check.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-22T23:34:08Z",
          "url": "https://github.com/HarperFast/harper/commit/cda8d63f6154b1cc9e766e561d7a6ce17b0a85fa"
        },
        "date": 1784806567000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9972.74
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9972.74
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 155.1
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 439.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 790.8
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
          "id": "b8c843a24a4b2b3f002a2b786415333fd7f3b597",
          "message": "fix(query): stop query planning from mutating the caller's conditions (#1911)\n\n* fix(query): stop query planning from mutating the caller's conditions\n\nTable.search()/get() took the caller's conditions by reference and annotated\nthem in place as it planned the query: it pushes a `{ comparator: 'sort' }`\npseudo-condition for index-order alignment, sets `descending`, caches\n`estimated_count`, collapses chained conditions, and coerces values — all on\nthe caller's entry objects. A caller that reuses the same array or condition\nobjects across queries (a natural pattern for a module-level `const`) then hits\nleaked state: a kept sort pseudo-condition is treated as a real valueless\ncondition and throws `Invalid value for attribute … \"undefined\"`; a stale\n`descending` silently reverses a later scan; a cached `estimated_count`\nmisplans. Whether it surfaced depended on live index estimates, so it read as\nphantom nondeterminism.\n\nClone the conditions array and every entry (recursing into nested and/or groups)\nat intake, so all downstream planning mutation happens on our own objects and\nnever reaches the caller. Entries are small and shallow, so the copy is\nnegligible next to the query itself.\n\nFixes harper#1572.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0188G62J9fZQg4J9rVuqLzjy\n\n* test(query): make the array-form target guard assert entry immutability\n\nPost-review follow-up. The array-form-target regression case only checked array\nlength + absence of a sort pseudo-condition, which don't change on that path\n(no sort → no push) — so it passed with or without the fix. Assert instead that\nthe caller's condition entry is untouched: its Date-typed bound stays the\noriginal string (not coerced in place) and no estimated_count is annotated. Now\nfails on origin/main and passes with the fix, like the other three cases.\n\nAlso note in cloneConditions why chainedConditions sub-entries are left shared\n(read-only during planning).\n\nComment generated by kAIle (Claude Opus 4.8)\n\n* refactor(query): hoist cloneConditions to module scope; plain node:assert in test\n\nReview follow-up (both non-blocking):\n- cloneConditions is stateless (no closure over search/makeTable), so hoist it\n  to module scope rather than re-creating the function on every search() call.\n- Use plain node:assert in the regression test per house style, with explicit\n  strictEqual/deepStrictEqual where strict semantics are wanted.\n\nComment generated by kAIle (Claude Opus 4.8)\n\n---------\n\nCo-authored-by: Kyle Bernhardy <kyle.bernhardy@gmail.com>\nCo-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-07-24T00:33:14Z",
          "url": "https://github.com/HarperFast/harper/commit/b8c843a24a4b2b3f002a2b786415333fd7f3b597"
        },
        "date": 1784892701000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9368.3
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9368.3
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 161
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 427.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 759.4
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1784978680000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8657.58
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8657.58
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 150.3
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 547.1
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 904.3
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
          "id": "d112560b6244cf5c914d047a8178942f841d5c6e",
          "message": "chore(ci): bump mention + issue-to-pr pins to 54d9e61 (Opus 5) (#1938)\n\nCompletes the Opus 5 rollout for this repo: the @claude mention\n'deep' path and the claude-fix:bug/:test escalation now run\nclaude-opus-5 (ai-review-prompts#79). Reusable interface unchanged\nacross the jump — the i2p reusable's only delta since the old pin is\nthe model swap itself; mention's delta is the model bumps plus a\nnet-reverted permissions pair (#39/#40).\n\nCo-authored-by: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-24T23:34:11Z",
          "url": "https://github.com/HarperFast/harper/commit/d112560b6244cf5c914d047a8178942f841d5c6e"
        },
        "date": 1785065224000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9965.86
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9965.86
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 132.9
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 512.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 866.4
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
          "id": "fe3994f4031714027098f6ce250fa78e1264107b",
          "message": "test(txn): afterEach stub-restore safety net + unref race timers (bot review)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-27T04:46:02Z",
          "url": "https://github.com/HarperFast/harper/commit/fe3994f4031714027098f6ce250fa78e1264107b"
        },
        "date": 1785153777000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9751.8
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9751.8
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 139.3
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 533.7
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 931.3
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
          "id": "3e317c7f58f9263de64fd11cac8a0052831d16f8",
          "message": "Update integrationTests/upgrade/qa606-upgrade-structgrowth/resources.js\n\nCo-authored-by: Chris Barber <chris@harperdb.io>",
          "timestamp": "2026-07-28T11:32:18Z",
          "url": "https://github.com/HarperFast/harper/commit/3e317c7f58f9263de64fd11cac8a0052831d16f8"
        },
        "date": 1785238745000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 10435.88
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 10435.88
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 140.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 429.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 569.6
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
          "id": "35c1f423b9e05ac858ec14bec4346d06d274c2e1",
          "message": "fix(cli): refresh expired agent tokens; fix --once approval hang\n\nAddress heskew's two remaining non-blocking review notes on #1553:\n\n- `harper agent` hard-failed on an expired stored operation token instead\n  of self-healing via the refresh_token, unlike cliOperations.ts. Extract\n  the refresh logic into a shared `refreshExpiredOperationToken` helper in\n  cliOperations.ts and call it from both cliOperations and agentCli, so the\n  two transports can't drift again.\n- `--once` against a real TTY drains stdin via readAllStdin() before the\n  first turn; if that turn then needed approval, resolveApprovals() built a\n  new readline on the already-ended stdin and question() never resolved.\n  Track actual stdin consumption (opts.stdinConsumed) instead of relying on\n  isTTY, and fail loudly in that case like the non-TTY path already does.\n\nRefs #1553\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-07-28T23:46:42Z",
          "url": "https://github.com/HarperFast/harper/commit/35c1f423b9e05ac858ec14bec4346d06d274c2e1"
        },
        "date": 1785325381000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9761.7
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9761.7
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 150.2
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 339.7
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 551
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
          "id": "b04af4d08dc96ffd6f657991b4fe105528e88c98",
          "message": "Merge pull request #1956 from HarperFast/fix/instance-post-create\n\nfix(resources): restore v4 super.post create on collection posts",
          "timestamp": "2026-07-29T23:58:36Z",
          "url": "https://github.com/HarperFast/harper/commit/b04af4d08dc96ffd6f657991b4fe105528e88c98"
        },
        "date": 1785411323000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 8539.54
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 8539.54
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 147.3
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 624.2
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1349.2
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
          "id": "fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20",
          "message": "Release v5.2.0-beta.4",
          "timestamp": "2026-07-31T03:37:46Z",
          "url": "https://github.com/HarperFast/harper/commit/fd4be1612c543a16d40ee4aa1d4d2d5091aa1b20"
        },
        "date": 1785498060000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 9709.28
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 9709.28
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 135.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 427.7
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 782.2
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T02:50:15Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785583611000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 6180.01
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 6180.01
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 129.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 489.2
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 871.6
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "b852a722c4abe562cab72a2f25313664fa74547d",
          "message": "Widen atomicWriteFile's Windows rename-retry budget and sleep without spinning\n\nThe ~910ms backoff budget (8 retries, 200ms cap) was exhausted twice in a row\nby the same test on a Windows CI runner (harper#2036) - an AV real-time scan\ncan hold harper-config.yaml for over a second. Widen to 12 retries with a\n500ms cap (~3.6s worst case), and replace the performance.now() busy-spin\nwith a timeout-only Atomics.wait so the wait is CPU-idle, which is what makes\nthe longer budget affordable.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-01T02:50:15Z",
          "url": "https://github.com/HarperFast/harper/commit/b852a722c4abe562cab72a2f25313664fa74547d"
        },
        "date": 1785669947000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 5773.98
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 5773.98
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 141.6
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 561.8
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 978.9
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
          "id": "f3246b9982eec796599740931f1c236e94957cd5",
          "message": "ci: invert canary conclusion polarity so it doesn't poison nightly-gate\n\nPer cross-model review (domain adjudication) — the sharpest finding\nacross this whole review cycle: moving the canary to its own workflow\nfixed integration-tests.yml's conclusion, but the nightly-gate triage\nroutine sweeps every `--event schedule` workflow with no per-workflow\nallowlist. Wiring the test step's raw exit code to the job conclusion\nwould make the every-night-until-fixed EXPECTED outcome (harper#2025\nstill reproducing) a permanent red that nightly-gate dutifully triages\nforever — while the one outcome anyone actually wants to hear about,\nthe defect clearing upstream, would be silently green and fire no\nalert. Backwards polarity for every consumer.\n\nInvert it: the canary tests failing (matching harper#2025) is now this\njob's SUCCESS; the tests unexpectedly passing is what fails it loudly,\nwith an ::error:: pointing at removing the pin. Also restores the\ncoverage-scope note that got dropped in the move to the standalone\nfile, adds a least-privilege permissions block, and cross-references\nthe duplicated pin-version constant between the two files.\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-03T12:02:20Z",
          "url": "https://github.com/HarperFast/harper/commit/f3246b9982eec796599740931f1c236e94957cd5"
        },
        "date": 1785758633000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 2199.4
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 2199.4
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 418.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 2225.1
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 3306.8
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
          "id": "b4196a3b4d32eac6c73c353fc5970f7a01ca5fe1",
          "message": "test(server): pin both HTTP servers' mid-stream SSE throw shapes (uWS divergence)\n\n`b: ThrowGen (throws after 2 of 5) over SSE` was the sole failure on\n`Integration Tests 5/6 (uWS HTTP)`; every other shard was green. Rather\nthan assume the assertion over-reached, QA-886 characterized the two\nservers byte-for-byte on the identical workload.\n\nBoth deliver exactly the two pre-throw events (`{\"n\":0}`, `{\"n\":1}`),\nbyte-identical modulo a uWS-only leading `:\\n\\n` header-flush comment.\nThey diverge only at termination:\n\n- Node (`server/http.ts` pipeBodyToResponse, ~426-461) closes the socket\n  WITHOUT the terminal `0\\r\\n\\r\\n` chunk, deliberately -- its own comment\n  says this \"correctly signals a failed/truncated transfer... instead of\n  implying it completed\". The incomplete chunked framing is the only\n  signal a client gets, and it is the intended one.\n- uWS (`server/serverHelpers/uwsServer.ts` streamResponse, ~340-356)\n  routes the source's 'error' and 'end' handlers through the SAME\n  `finish(true)` -> `res.end()` path, so it DOES write the terminal\n  chunk. The wire response becomes byte-indistinguishable from a\n  generator that legitimately finished: a mid-stream failure is silently\n  presented to the client as success.\n\nSo the spec was right and the uWS path is wrong. `HttpResponse.close()`\nis available and is the correct primitive for the error branch; that is a\nproduct fix, tracked separately as F-272 and not made here.\n\nThis change pins BOTH shapes explicitly rather than skipping under uWS,\nso the divergence stays visible in the suite and cannot drift or be\n\"fixed\" in the wrong direction unnoticed. Verified locally at\n`c28e5f83f`: 11/11 green under Node and 11/11 under HARPER_UWS_HTTP=1.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-04T11:40:48Z",
          "url": "https://github.com/HarperFast/harper/commit/b4196a3b4d32eac6c73c353fc5970f7a01ca5fe1"
        },
        "date": 1785843749000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 5339.82
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 5339.82
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 276.8
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1145.2
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 1772.7
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
          "id": "ffef12f8c8992eb86c5014d85d4bd273df8f18d5",
          "message": "Test Bun resolution candidate tracking directly\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-05T11:21:29Z",
          "url": "https://github.com/HarperFast/harper/commit/ffef12f8c8992eb86c5014d85d4bd273df8f18d5"
        },
        "date": 1785929980000,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "unit": "MB",
            "value": 4266.22
          },
          {
            "name": "ttl-churn final size",
            "unit": "MB",
            "value": 4266.22
          },
          {
            "name": "concurrent-rw read p50",
            "unit": "ms",
            "value": 308.9
          },
          {
            "name": "concurrent-rw read p95",
            "unit": "ms",
            "value": 1944.3
          },
          {
            "name": "concurrent-rw read p99",
            "unit": "ms",
            "value": 3927.2
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
          "id": "3406de50c541f18e42a693b21e4d208f7936cc16",
          "message": "Address PR review: fileURLToPath for the CLI guard, fix README claim\n\n- Use fileURLToPath(import.meta.url) instead of a raw file:// string\n  comparison against process.argv[1] — the latter breaks on Windows\n  path separators/drive-letter formatting (gemini-code-assist).\n- The README's \"only quick-scale/non-main runs are excluded\" claim was\n  only true for the new storage workflow; ycsb-nightly.yml's auto-push\n  has no scale gate at all, so a manual YCSB dispatch at any scale still\n  publishes today. Narrowed the doc to state the actual, differing\n  conditions for each workflow (claude bot).\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
          "timestamp": "2026-08-05T13:03:00Z",
          "url": "https://github.com/HarperFast/harper/commit/3406de50c541f18e42a693b21e4d208f7936cc16"
        },
        "date": 1785941146040,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 4708.56,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 4708.56,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 435.7,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 1662.5,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 3046.3,
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
          "id": "01d8562225c88abe8d62ba37e520aa5b289f76c7",
          "message": "Merge pull request #2075 from HarperFast/david/last-super-user-guard\n\nReject user and role changes that would remove the last active super_user",
          "timestamp": "2026-08-05T21:25:48Z",
          "url": "https://github.com/HarperFast/harper/commit/01d8562225c88abe8d62ba37e520aa5b289f76c7"
        },
        "date": 1786019201401,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 2385.66,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 2385.66,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 296.3,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 1895.3,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 3222.7,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "f85e66b92abda03b6dd7cbcfde05e09a46215da7",
          "message": "chore(deps): raise msgpackr floor to ^2.0.5\n\nThe published harper@5.2.0 shipped an npm-shrinkwrap.json pinning\nmsgpackr 2.0.4. main's package-lock.json already resolves 2.0.5\n(bumped after the v5.2.0 tag in a264242b4 as an npm-install side\neffect of ^2.0.4), so the next release cut from main already ships\n2.0.5. This raises the declared floor to ^2.0.5 to make that intent\nexplicit and guard against a future lock regeneration ever pinning\nbelow 2.0.5. No functional change; the resolved lock entry is\nunchanged.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-06T16:19:21Z",
          "url": "https://github.com/HarperFast/harper/commit/f85e66b92abda03b6dd7cbcfde05e09a46215da7"
        },
        "date": 1786103465591,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5281.29,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5281.29,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 192.3,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 607.9,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 952.9,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786189441054,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5771.91,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5771.91,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 197,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 565.6,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 879,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786275837546,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5603.05,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5603.05,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 209.1,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 596.2,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 792.5,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786363096127,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5684.28,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5684.28,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 181.2,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 586,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 928,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "Kris Zyp",
            "username": "kriszyp",
            "email": "kriszyp@gmail.com"
          },
          "id": "eb702ee52ef8f97085dc9d20f81ba52234cf077b",
          "message": "fix(blob): re-encode inline blobs from the copied buffer, not a read-buffer view\n\nA small blob decoded inline retained `storageBuffer` — the raw msgpack ext-body,\nwhich is a *view* into the store's read buffer — and `pack()` re-emitted it verbatim\non re-encode. The read buffer is recycled by later reads, so a read-modify-write\n(the shape of a REST PATCH: fetch record, carry the unchanged Blob, put it back)\nserialized whatever foreign bytes had since overwritten that buffer, corrupting the\nrecord. The next read then failed with \"Data read, but end of buffer not reached\".\n\nThe sibling `contentBuffer` is already a stable copy (copyingUnpacker uses\ncopyBuffers), so drop `storageBuffer` entirely and let `pack()` fall through to the\nexisting contentBuffer re-encode. No read-path allocation cost — this supersedes the\n`needsStableBuffer` approach in #2103, which masked the corruption by forcing every\nprimary-store read to allocate a fresh buffer. The clobber is on re-ENCODE, not\nmid-decode, which is why a decode-path canary never observed it.\n\nAlso fixes slice() on an inline blob (previously gated off by storageBuffer's\npresence and left to throw).\n\nRepro/regression guard: unitTests/resources/recordCacheStableBuffer.test.js — the\nRMW-with-interleaved-read case failed 25/25 before this change, passes after.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-08-07T19:16:01Z",
          "url": "https://github.com/HarperFast/harper/commit/eb702ee52ef8f97085dc9d20f81ba52234cf077b"
        },
        "date": 1786449081828,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5723.05,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5723.05,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 167.7,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 637.8,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 1080.7,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "0a727e8bd5931e9266344b757a8680f50f5980ff",
          "message": "fix(deps): update dependency argon2 to v0.45.1 (#2132)\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>",
          "timestamp": "2026-08-12T01:50:06Z",
          "url": "https://github.com/HarperFast/harper/commit/0a727e8bd5931e9266344b757a8680f50f5980ff"
        },
        "date": 1786535523152,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5528.86,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5528.86,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 346,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 1313.9,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 2134.7,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Chris Barber",
            "username": "cb1kenobi",
            "email": "chris@harperdb.io"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "09c4580106cc399ea7a4dd7132361a61d2d2d561",
          "message": "Merge pull request #2124 from HarperFast/fix/sql-engine-top-limit-normalization\n\nfix(sql-engine): honor SELECT TOP n and floor fractional LIMIT/OFFSET",
          "timestamp": "2026-08-12T22:47:19Z",
          "url": "https://github.com/HarperFast/harper/commit/09c4580106cc399ea7a4dd7132361a61d2d2d561"
        },
        "date": 1786621941466,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 4956.45,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 4956.45,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 378.5,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 1506.2,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 2799.5,
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
          "id": "871fad0fa2ece52e4adfbfa102536c54560c67e3",
          "message": "Release v5.2.2",
          "timestamp": "2026-08-14T02:23:55Z",
          "url": "https://github.com/HarperFast/harper/commit/871fad0fa2ece52e4adfbfa102536c54560c67e3"
        },
        "date": 1786708304077,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5472.6,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5472.6,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 197.3,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 682,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 1006.3,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786793947190,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 6124.18,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 6124.18,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 135.5,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 571.6,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 1142.3,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786880339772,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5530.23,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5530.23,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 354.9,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 1264.1,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 2296.9,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "renovate[bot]",
            "username": "renovate[bot]",
            "email": "29139614+renovate[bot]@users.noreply.github.com"
          },
          "committer": {
            "name": "GitHub",
            "username": "web-flow",
            "email": "noreply@github.com"
          },
          "id": "11a1c489168dfb00c6a66472cef14cb3f875286f",
          "message": "fix(deps): update all non-major dependencies (#2131)\n\n* fix(deps): update all non-major dependencies\n\n* test: make record count budget explicit\n\nCo-Authored-By: GPT-5 Codex <noreply@openai.com>\n\n---------\n\nCo-authored-by: renovate[bot] <29139614+renovate[bot]@users.noreply.github.com>\nCo-authored-by: Kris Zyp <kriszyp@gmail.com>\nCo-authored-by: GPT-5 Codex <noreply@openai.com>",
          "timestamp": "2026-08-14T23:33:30Z",
          "url": "https://github.com/HarperFast/harper/commit/11a1c489168dfb00c6a66472cef14cb3f875286f"
        },
        "date": 1786966935594,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "ttl-churn peak size",
            "value": 5645.85,
            "unit": "MB"
          },
          {
            "name": "ttl-churn final size",
            "value": 5645.85,
            "unit": "MB"
          },
          {
            "name": "concurrent-rw read p50",
            "value": 163.4,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p95",
            "value": 605.8,
            "unit": "ms"
          },
          {
            "name": "concurrent-rw read p99",
            "value": 938.8,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}