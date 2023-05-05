'use strict';
exports.Resource = require('./resources/Resource').Resource;
const table_loader = require('./resources/tableLoader');
exports.tables = table_loader.tables;
Object.defineProperty(exports, 'tables', { get: function () { return table_loader.tables; } });
Object.defineProperty(exports, 'databases', { get: function () { return table_loader.databases; } });
exports.user = require('./security/user').findAndValidateUser;