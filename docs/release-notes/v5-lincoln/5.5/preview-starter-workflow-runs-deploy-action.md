---
section: 'Pull Request Previews'
---

### The Starter Preview Workflow Runs HarperFast/deploy-action

From v5.4.2, the workflow `harper preview setup write_workflow=true` writes runs [`HarperFast/deploy-action`](https://github.com/HarperFast/deploy-action), pinned by commit, instead of installing the CLI and running `harper preview deploy` and `drop` itself. The action also keeps a PR comment with each preview's URL, and records a GitHub Deployment, when the workflow's token may write them. It refuses an `http://` target other than a loopback address, so set up previews against the cluster's `https://` URL. A workflow setup wrote earlier keeps working, and setup never changes an existing file. See [`harper preview setup`](/reference/v5/cli/commands#harper-preview-setup).
