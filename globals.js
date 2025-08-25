'use strict';
global.Resource = exports.Resource = undefined;
global.tables = exports.tables = {};
global.databases = exports.databases = {};
global.getUser = exports.getUser = undefined;
global.authenticateUser = exports.authenticateUser = undefined;
global.server = exports.server = {};
global.contentTypes = exports.contentTypes = null;
global.threads = exports.threads = [];
global.logger = {};
global.RequestTarget = exports.RequestTarget = undefined;
global.operation = exports.operation = undefined;
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
};
