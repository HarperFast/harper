'use strict';
global.Resource = exports.Resource = undefined;
global.tables = exports.tables = {};
global.databases = {};
global.getUser = exports.getUser = undefined;
global.server = exports.server = {};
global.contentTypes = exports.contentTypes = null;
global.logger = {};
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
};
/*exports.Resource = require('./resources/Resource').Resource;
const table_loader = require('./resources/databases');
exports.tables = table_loader.tables;
Object.defineProperty(exports, 'tables', { get: function () { return table_loader.tables; } });
Object.defineProperty(exports, 'databases', { get: function () { return table_loader.databases; } });
exports.getUser = require('./security/getUser').findAndValidateUser;*/
