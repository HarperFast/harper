'use strict';
(global as any).Resource = exports.Resource = undefined;
(global as any).tables = exports.tables = {};
(global as any).databases = exports.databases = {};
(global as any).server = exports.server = {};
(global as any).contentTypes = exports.contentTypes = null;
(global as any).threads = exports.threads = [];
(global as any).logger = {};
export const _assignPackageExport = (name, value) => {
	(global as any)[name] = exports[name] = value;
};
