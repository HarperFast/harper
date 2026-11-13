---
section: 'Security'
---

### CommonJS require() Follows the Same Rules as import

Under the default VM loader, a CommonJS component's `require()` now applies the same rules as `import`. `allowedDirectory` and `allowedBuiltInModules` are enforced, `child_process` is the constrained module, `dependencyLoader` applies, required `.ts` files are type-stripped, and `__filename` is a path instead of a `file://` URL. A file loaded both ways has one instance per application. A CommonJS module that throws at run time is no longer retried as ESM.

**Upgrade impact:** a CommonJS component that requires a file outside its directory, or spawns a child process without a `name`, now fails. Set `allowedDirectory: any` for the first. See [Allowed Directory](/reference/v5/components/module-loading#allowed-directory) ([harper#3507](https://github.com/HarperFast/harper/pull/3507)).
