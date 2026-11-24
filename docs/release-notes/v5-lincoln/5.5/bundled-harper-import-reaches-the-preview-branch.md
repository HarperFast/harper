---
section: 'Pull Request Previews'
---

### A Bundled `harper` Import Reaches the Preview's Branch

From v5.4.2, in an isolated application with branched databases, such as a pull request preview, code outside Harper's component loader that imports `harper`, such as a Next.js server bundle, reads and writes the preview's branch, as the bare `databases` and `tables` globals already did. Before, it reached the cluster's own databases, so a preview's writes through that import landed in the data its production application serves. See [Using Harper APIs from bundled code](/reference/v5/components/javascript-environment).
