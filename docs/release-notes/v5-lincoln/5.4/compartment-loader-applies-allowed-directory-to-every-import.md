---
section: 'Security'
---

### The Compartment Loader Applies allowedDirectory to Every Import

Under `applications.moduleLoader: compartment`, `allowedDirectory` now applies to plain `.js`, `.ts` and `.json` imports as well, as it already did under the VM loaders. Before, only native addons and dependencies under `node_modules` were checked. Named imports from a CommonJS dependency that assigns its `module.exports` names at run time now resolve in compartment mode too.

**Upgrade impact:** a compartment-mode component that imports a file outside its own directory now fails to load with `Can not load module at <path> outside of allowed path <path>`. This covers relative and absolute paths, symlinks and linked workspace packages. Set `allowedDirectory: any` to allow it. See [Allowed Directory](/reference/v5/components/module-loading#allowed-directory) ([harper#3485](https://github.com/HarperFast/harper/pull/3485)).
