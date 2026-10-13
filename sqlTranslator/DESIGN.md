# SQL translation

## CommonJS date functions

`alasqlFunctionImporter.ts` imports the CommonJS date-helper object by default; native namespace imports do not expose its object-literal properties. `unitTests/sqlTranslator/alasqlFunctionImporter.test.js` verifies the registered date functions in both test runtimes.
