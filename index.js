const { Resource } = require('./resources/Resource');
const { tables, databases } = require('./resources/database');
const server = {};
module.exports = { Resource, tables, databases, server };
