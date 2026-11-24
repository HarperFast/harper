'use strict';
global.contentTypes = exports.contentTypes = null;
global.createBlob = exports.createBlob = undefined;
global.databases = exports.databases = {};
global.logger = exports.logger = {};
global.models = exports.models = undefined;
global.operation = exports.operation = undefined;
global.Resource = exports.Resource = undefined;
global.secrets = exports.secrets = undefined;
global.server = exports.server = {};
global.tables = exports.tables = {};
global.threads = exports.threads = [];
global.transaction = exports.transaction = undefined;
// The package entry (index.ts) copies these exports when it loads. Linking it keeps a later assignment, such as an
// isolated application's worker taking its branch view of `databases` and `tables`, visible to code that imported it.
const packageEntries = new Set();
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
	for (const entry of packageEntries) entry[name] = value;
};
exports._linkPackageEntry = (entry) => {
	packageEntries.add(entry);
};
