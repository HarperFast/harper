/** Like harperLogger, but conditionally exports functions based on the log level. */
const harperLogger = require('./harper_logger.js');

for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify']) {
	if (harperLogger.logsAtLevel(level)) exports[level] = harperLogger[level];
}
exports.loggerWithTag = (tag) => {
	return harperLogger.loggerWithTag(tag, true);
};

exports.setLogLevel = harperLogger.setLogLevel;
