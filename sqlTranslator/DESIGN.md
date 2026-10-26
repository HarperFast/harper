# SQL translation

## CommonJS date functions

`alasqlFunctionImporter.ts` imports the CommonJS date-helper object by default; native namespace imports did not expose its object-literal properties in [#562](https://github.com/HarperFast/harper/pull/562). `unitTests/sqlTranslator/alasqlFunctionImporter.test.js` verifies the registered date functions in both test runtimes.
