window.BENCHMARK_DATA = {
  "lastUpdate": 1780733609009,
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
      }
    ]
  }
}