---
section: 'Pull Request Previews'
---

### Preview Setup Creates the Actions Policy a Public Repository Needs

From December 2, 2026, GitHub Actions blocks `pull_request_target` in public repositories unless an Actions event policy allows it, and the preview workflow runs on that event. From v5.4.2, for a public repository, `harper preview setup` reads the repository's Actions policies with `gh` and, when none allows the event and you agree (`actions_policy=true` without a terminal), creates one that targets only the preview workflow and allows exactly the events it runs on. It never changes an existing policy: one that blocks the event, or one for the workflow that is turned off, is reported with what to change. When it cannot create the policy, it prints the steps and the `gh api` command. For a repository whose visibility it could not look up, it prints the steps, and the starter workflow carries a comment about the policy. A repository set up earlier needs the policy too: run setup again with the same arguments. See [Public repositories: allow `pull_request_target`](/reference/v5/cli/commands#public-repositories-allow-pull_request_target).
