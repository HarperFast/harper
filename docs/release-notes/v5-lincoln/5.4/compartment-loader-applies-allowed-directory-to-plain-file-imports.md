---
section: 'Security'
---

### The Compartment Loader Applies allowedDirectory to Plain File Imports

Under `applications.moduleLoader: compartment`, `allowedDirectory` now applies to plain `.js`, `.ts` and `.json` imports as well, as it already did under the VM loaders. Before, only native addons and dependencies under `node_modules` were checked. Named imports of the enumerable data properties a CommonJS dependency assigns to `module.exports` at run time now resolve in compartment mode too.

**Upgrade impact:** a compartment-mode component that imports a plain file from outside its own directory, by a relative or absolute path, a symlink or a linked workspace package, now fails to load with `Can not load module at <path> outside of allowed path <path>`. Set `allowedDirectory: any` to allow these imports. The check is the same path-prefix test the VM loaders use, a configuration guardrail rather than a security boundary. See [Allowed Directory](/reference/v5/components/module-loading#allowed-directory) ([harper#3485](https://github.com/HarperFast/harper/pull/3485)).
