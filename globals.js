'use strict';
global.contentTypes = exports.contentTypes = null;
global.createBlob = exports.createBlob = undefined;
global.databases = exports.databases = {};
global.defineBackend = exports.defineBackend = undefined;
global.logger = exports.logger = {};
global.models = exports.models = undefined;
global.operation = exports.operation = undefined;
global.registerBackend = exports.registerBackend = undefined;
global.Resource = exports.Resource = undefined;
global.server = exports.server = {};
global.tables = exports.tables = {};
global.threads = exports.threads = [];
global.transaction = exports.transaction = undefined;
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
};
