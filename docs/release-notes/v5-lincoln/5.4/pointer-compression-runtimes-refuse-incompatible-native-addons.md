---
section: 'Native Addons'
order: 10
---

### Pointer-Compression Runtimes Refuse Incompatible Native Addons

Free and Hobby tier clusters on Harper Fabric run on pointer-compression runtimes; other plans run a standard Node.js. On a Node.js build with V8 pointer compression, Harper now checks native addons before they load, in every thread. It refuses an addon that links V8's C++ API built for the standard ABI, which would otherwise load and then crash the process on first use. The refusal is an `IncompatibleNativeAddonError` that names the file, its package and the fixes.

These still load as before:

- Node-API addons;
- addons that node-gyp built under the running Node.js, load from the package's `build/` directory, and meet the `config.gypi` and binary-age checks in the reference;
- packages marked with `.pointer-compression-build`.

Standard Node.js builds are unchanged. See [Native Addons on Pointer-Compression Runtimes](/reference/v5/components/module-loading#native-addons-on-pointer-compression-runtimes).
