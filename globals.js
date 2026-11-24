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
// The package entry (index.ts) copies these exports when it loads, so it links its copy to follow later assignments.
const packageEntries = new Set();
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
	for (const entry of packageEntries) entry[name] = value;
};
// Not enumerable, so the entry's copy of these exports leaves it out of the public package.
Object.defineProperty(exports, '_linkPackageEntry', { value: (entry) => packageEntries.add(entry) });
