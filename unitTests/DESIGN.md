# Unit tests

Index of design notes: [DESIGN.md](../DESIGN.md).

## Source and compiled test lanes

`runTypeStripTests.mts` uses Mocha's own selection and `typeStripSuites.mts` partitions it by explicit `#js` references, local helpers and statically named child fixtures; export-cache manipulation remains compiled. The native lane propagates `typestrip` through `NODE_OPTIONS`; `#js` is denied there. Legacy and built-artifact suites run separately with `#src` and `#js` both resolving to `dist`. Compiled CI still runs every suite; native CI has no distribution.

`nativeModules.mts` observes real ESM database loads for `perFileDatabaseTeardown.js`, without loading storage for a resolver probe, and rejects this checkout's compiled core in the source process. `rocksdbBindings.mts` selects the same vendor entry as core, avoiding a second native-addon wrapper. `mocha.init.js` marks completion from global teardown; merely preloading it for a probe is distinct from starting Mocha. `typeStripSuites.test.js`, `preTestPrepNative.test.js` and the ESM teardown fixtures enforce these boundaries.
