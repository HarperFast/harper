window.BENCHMARK_DATA = {
  "lastUpdate": 1780648774770,
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
      }
    ]
  }
}