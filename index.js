const { Resource } = require('./resources/Resource');
const { tables, databases } = require('./resources/database');
const plugins = {};
const resources = new Map();
module.exports = { Resource, tables, databases, plugins, resources };
