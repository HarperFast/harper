---
section: 'Pull Request Previews'
---

### Preview Setup Names the Actions Policy a Public Repository Needs

From December 2, 2026, GitHub Actions blocks `pull_request_target` in public repositories unless an Actions event policy allows it, and the preview workflow runs on that event. `harper preview setup` now prints, for a public repository or one whose visibility it could not look up, where to allow the event for the preview workflow alone, and the starter workflow carries a comment about it. A repository set up earlier needs the same policy. See [Public repositories: allow `pull_request_target`](/reference/v5/cli/commands#public-repositories-allow-pull_request_target).
