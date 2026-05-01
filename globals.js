'use strict';
global.contentTypes = exports.contentTypes = null;
global.createBlob = exports.createBlob = undefined;
global.databases = exports.databases = {};
global.logger = exports.logger = {};
global.operation = exports.operation = undefined;
global.Resource = exports.Resource = undefined;
global.server = exports.server = {};
global.tables = exports.tables = {};
global.threads = exports.threads = [];
global.transaction = exports.transaction = undefined;
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
};
