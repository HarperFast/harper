---
id: overview
title: Logging
---

<!-- Source: versioned_docs/version-4.7/administration/logging/index.md (primary) -->
<!-- Source: versioned_docs/version-4.7/administration/logging/standard-logging.md (primary for log format, rotation, stdStreams) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (confirmed logging revamp, consolidated into hdb.log) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (confirmed per-component logging, dynamic reload, HTTP logging, Node.js Console API) -->

Harper's core logging system is used for diagnostics, monitoring, and observability. It has an extensive configuration system, and even supports feature-specific (per-component) configurations in latest versions. Furthermore, the `logger` global API is available for creating custom logs from any JavaScript application or plugin code.

> If you are looking for information on Harper's Audit and Transaction logging system, refer to the [Database](../database/transaction.md) section.

## Log File

<VersionBadge type="changed" version="v4.1.0" /> — All logs consolidated into a single `hdb.log` file

All standard log output is written to `<ROOTPATH>/log/hdb.log` (default: `~/hdb/log/hdb.log`).

## Log Entry Format

Each log entry follows this structure:

```
<timestamp> [<thread>/<id>] [<level>] ...[<tags>]: <message>
```

Example:

```
2023-03-09T14:25:05.269Z [main/0] [notify]: HarperDB successfully started.
```

Fields:

| Field       | Description                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------- |
| `timestamp` | ISO 8601 date/time when the event occurred.                                                  |
| `level`     | Severity level. See [Log Levels](#log-levels) below.                                         |
| `thread/id` | Name and ID of the thread that produced the log entry (generally, `main`, `http`, or `job`). |
| `tags`      | Additional context tags (e.g., `custom-function`, `auth-event`). Most entries have no tags.  |
| `message`   | The log message.                                                                             |

### Log Levels

From least to most severe (most verbose to least verbose):

| Level    | Description                                                                                   |
| -------- | --------------------------------------------------------------------------------------------- |
| `trace`  | Highly detailed internal execution tracing.                                                   |
| `debug`  | Diagnostic information useful during development.                                             |
| `info`   | General operational events.                                                                   |
| `warn`   | Potential issues that don't prevent normal operation.                                         |
| `error`  | Errors that affect specific operations.                                                       |
| `fatal`  | Critical errors causing process termination.                                                  |
| `notify` | Important operational milestones (e.g., "server started"). Always logged regardless of level. |

The default log level is `warn`. Setting a level includes that level and all more-severe levels. For example, `warn` logs `warn`, `error`, `fatal`, and `notify`.

## Standard Streams

<VersionBadge type="changed" version="v4.6.0" />

By default, logs are written only to the log file. To also log to `stdout`/`stderr`, set [`logging.stdStreams: true`](./configuration.md#loggingstdstreams) (this is automatically enabled by the `DEFAULT_MODE=dev` configuration during installation).

When logging to standard streams, run Harper in the foreground (i.e. `harper`, not `harper start`).

As of v4.6.0, logging to standard streams does **not** include timestamps, and console logging (`console.log`, etc.) does not get forwarded to log files unless the [`logging.console: true`](./configuration.md#loggingconsole) option is enabled.

## Logger API

JavaScript components can use the `logger` global to write structured log entries:

```javascript
logger.trace('detailed trace message');
logger.debug('debug info', { someContext: 'value' });
logger.info('informational message');
logger.warn('potential issue');
logger.error('error occurred', error);
logger.fatal('fatal error');
logger.notify('server is ready');
```

The `logger` global provides `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `notify` methods. The logger is based on the Node.js Console API. See [Logging API](./api) for full details.

## Related

- [Logging Configuration](./configuration)
- [Logging API](./api)
- [Logging Operations](./operations)
- [Database / Transaction Logging](../database/transaction.md)
