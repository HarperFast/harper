---
section: 'Pull Request Previews'
---

### The Starter Preview Workflow Runs HarperFast/deploy-action

From v5.4.2, the workflow `harper preview setup write_workflow=true` writes runs [`HarperFast/deploy-action`](https://github.com/HarperFast/deploy-action), pinned by commit, instead of installing the CLI and running `harper preview deploy` and `drop` itself. The action also tries to keep a PR comment with each preview's URL and to record a GitHub Deployment, and a run still succeeds when GitHub refuses either. Both jobs stay skipped until setup has set `HARPER_PREVIEW_TARGET`. The action refuses an `http://` target other than a loopback address, so setup refuses to write the starter for one. A workflow setup wrote earlier keeps working, and setup never changes an existing file. See [`harper preview setup`](/reference/v5/cli/commands#harper-preview-setup).
