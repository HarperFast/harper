/** Like harper_logger, but conditionally exports functions based on the log level. */
const harper_logger = require('./harper_logger');

for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify']) {
	if (harper_logger.logsAtLevel(level)) exports[level] = harper_logger[level];
}
exports.loggerWithTag = (tag) => {
	return harper_logger.loggerWithTag(tag, true);
};
