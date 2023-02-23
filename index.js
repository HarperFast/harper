const { Resource } = require('./resources/Resource');
const { tables, databases } = require('./resources/database');
const { httpServer } = require('./server/threads/thread-http-server');
module.exports = { Resource, tables, databases, httpServer };
