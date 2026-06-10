window.BENCHMARK_DATA = {
  "lastUpdate": 1781080836429,
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
            "name": "load",
            "value": 6424.8,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 9565.7,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 9750.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 7224.04,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 5238.82,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 10144.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 6014.66,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8531.99,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8412.78,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6739.69,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4828.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8647.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 6079.56,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8562.34,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8380.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6764.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4776.19,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8689.98,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 6145.21,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8761.31,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8545.25,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6579.87,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4740.65,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8608.6,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 7712.24,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 11959.71,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 11316.53,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 8650.02,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 6188.12,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 11683.37,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 5905.75,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8302.94,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8204.48,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6536.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4688.55,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8503.27,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 6023.1,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8575.83,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 8601.1,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6686.91,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4802.03,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8694.32,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
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
            "name": "load",
            "value": 5872.86,
            "unit": "records/sec"
          },
          {
            "name": "workload C",
            "value": 8294.84,
            "unit": "ops/sec"
          },
          {
            "name": "workload B",
            "value": 7968.52,
            "unit": "ops/sec"
          },
          {
            "name": "workload A",
            "value": 6516.38,
            "unit": "ops/sec"
          },
          {
            "name": "workload F",
            "value": 4586.22,
            "unit": "ops/sec"
          },
          {
            "name": "workload D",
            "value": 8201.85,
            "unit": "ops/sec"
          },
          {
            "name": "workload E",
            "value": 935.35,
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
            "name": "C read p99",
            "value": 14.49,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 13.97,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 19.61,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 16.95,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 23.12,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 16.14,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 32.57,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 13.74,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 17.52,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 46,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
            "name": "C read p99",
            "value": 15.39,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 15.63,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 18.65,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.07,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 22.47,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 17.44,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 34.48,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 15.26,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.05,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 39.61,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
            "name": "C read p99",
            "value": 15.41,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 15.72,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 18.63,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.02,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 22.6,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 17.56,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 34.95,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 15.05,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.42,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 194.35,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 15.18,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 15.12,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 18.31,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.51,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 24.44,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 17.67,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 35.29,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 15.2,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.34,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 39.64,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
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
            "name": "C read p99",
            "value": 12.38,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 12.7,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 17.98,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 14.04,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 21.85,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 13.67,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 28.9,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 12.12,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 15.93,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 147.81,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 16.07,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 16.03,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 18.78,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.7,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 24.17,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 17.92,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 35.56,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 15.47,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.69,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 205.82,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 15.32,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 15.04,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 18.08,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.27,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 23.16,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 17.47,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 34.71,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 14.99,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.61,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 187.87,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
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
            "name": "C read p99",
            "value": 15.81,
            "unit": "ms"
          },
          {
            "name": "B read p99",
            "value": 16.68,
            "unit": "ms"
          },
          {
            "name": "B update p99",
            "value": 19.44,
            "unit": "ms"
          },
          {
            "name": "A read p99",
            "value": 18.77,
            "unit": "ms"
          },
          {
            "name": "A update p99",
            "value": 23.59,
            "unit": "ms"
          },
          {
            "name": "F read p99",
            "value": 18.39,
            "unit": "ms"
          },
          {
            "name": "F rmw p99",
            "value": 36.78,
            "unit": "ms"
          },
          {
            "name": "D read p99",
            "value": 15.93,
            "unit": "ms"
          },
          {
            "name": "D insert p99",
            "value": 18.94,
            "unit": "ms"
          },
          {
            "name": "E insert p99",
            "value": 40.32,
            "unit": "ms"
          },
          {
            "name": "E scan p99",
            "value": 187.93,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}