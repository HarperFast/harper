---
section: 'Pull Request Previews'
---

### The Starter Preview Workflow Runs HarperFast/deploy-action

From v5.4.2, the workflow `harper preview setup write_workflow=true` writes runs [`HarperFast/deploy-action`](https://github.com/HarperFast/deploy-action), pinned by commit, instead of installing the CLI and running `harper preview deploy` and `drop` itself. Each preview then gets a PR comment with its URL and a GitHub Deployment, which the action records. A workflow setup wrote earlier keeps working, and setup never changes an existing file. See [`harper preview setup`](/reference/v5/cli/commands#harper-preview-setup).
