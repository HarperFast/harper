'use strict';
global.Resource = exports.Resource = undefined;
global.tables = exports.tables = {};
global.databases = {};
global.user = exports.user = undefined;
global.server = exports.server = {};
global.config = exports.config = {};
global.contentTypes = exports.contentTypes = null;
exports._assignPackageExport = (name, value) => {
	global[name] = exports[name] = value;
};
/*exports.Resource = require('./resources/Resource').Resource;
const table_loader = require('./resources/databases');
exports.tables = table_loader.tables;
Object.defineProperty(exports, 'tables', { get: function () { return table_loader.tables; } });
Object.defineProperty(exports, 'databases', { get: function () { return table_loader.databases; } });
exports.user = require('./security/user').findAndValidateUser;*/
