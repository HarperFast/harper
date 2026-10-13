# Unit tests

Index of design notes: [DESIGN.md](../DESIGN.md).

## Source and compiled test lanes

`runTypeStripTests.mts` uses Mocha's own selection and `typeStripSuites.mts` follows local helpers and statically named child fixtures. A `#js` reference (including a root-path resolver), export-cache mutation, a statically resolved `dist` path, or a bare RocksDB/msgpackr require selects compiled execution. The native lane propagates `typestrip` through `NODE_OPTIONS`; `#js` is denied there. Legacy and built-artifact suites run separately with `#src` and `#js` both resolving to `dist`. Compiled CI still runs every suite; native CI has no distribution.

`perFileDatabaseTeardown.js` observes the cached CommonJS `globals.js` publication of the null-prototype database registry before requiring its evaluated ESM namespace. It never calls the scanning database getter; a utility-only suite leaves storage unloaded, a later first scan remains possible, and disk entries present at the initial run census survive cleanup. Later files' residue is eligible for removal after reopening. Reading the cached publication also survives tests replacing or deleting `globalThis.databases`. `nativeModules.mts` checks this checkout's compiled CommonJS cache at file boundaries and global teardown, including empty and filtered runs, without loader hooks that break CommonJS translation on supported Node floors. The source CI matrix includes Node 22.18.0 and 24.0.0 as well as current supported majors.

`packageBindings.mts` selects the same vendor entry as core; `rocksdbBindings.mts` delegates to it. Separate RocksDB wrappers lose class identity, and separate msgpackr entries lose blob extension registration. `mocha.init.js` stages statistics in global teardown and commits the loaded file list in Mocha's final callback; merely preloading it for a probe is distinct from starting Mocha. `typeStripSuites.test.js`, `preTestPrepNative.test.js` and the ESM teardown fixtures enforce these boundaries.

The conversion of [#562](https://github.com/HarperFast/harper/pull/562) exposed read-only export mutation and database cleanup that only observed the CommonJS cache. The launcher honors Mocha's per-test timeout; its enclosing CI step or local test invocation owns the total wall-time limit. Completion paths stay private to that process. Serial and parallel runs finish through Mocha's final callback, including workers with no matching tests; nested runs must also finish. Interrupts use the wrapper's SIGINT forwarding path so its re-executed process stops too.
