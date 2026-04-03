---
id: api
title: Logging API
---

<!-- Source: versioned_docs/version-4.7/reference/globals.md (logger global - primary) -->
<!-- Source: versioned_docs/version-4.7/administration/logging/standard-logging.md (log levels, thread context) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (confirmed logger based on Node.js Console API) -->

## `logger`

The `logger` global is available in all JavaScript components without any imports. It writes structured log entries to the standard Harper log file (`hdb.log`) at the configured `logging.external` level and path. See [Logging Configuration](./configuration#loggingexternal) for per-component log configuration.

The `logger` global is a `MainLogger`. Calling `logger.withTag(tag)` returns a `TaggedLogger` scoped to that tag.

### `MainLogger`

`MainLogger` always has all log-level methods defined. It also exposes `withTag()` to create a `TaggedLogger`.

```typescript
interface MainLogger {
	trace(...messages: any[]): void;
	debug(...messages: any[]): void;
	info(...messages: any[]): void;
	warn(...messages: any[]): void;
	error(...messages: any[]): void;
	fatal(...messages: any[]): void;
	notify(...messages: any[]): void;
	withTag(tag: string): TaggedLogger;
}
```

Each method corresponds to a log level. Only entries at or above the configured `logging.level` (or `logging.external.level`) are written. See [Log Levels](./overview#log-levels) for the full hierarchy.

### `TaggedLogger`

`TaggedLogger` is returned by `logger.withTag(tag)`. It prefixes every log entry with the given tag, making it easy to filter log output by component or context.

Because `TaggedLogger` is bound to the configured log level at creation time, methods for levels that are currently disabled are `null`. Always use optional chaining (`?.`) when calling methods on a `TaggedLogger`.

```typescript
interface TaggedLogger {
	trace: ((...messages: any[]) => void) | null;
	debug: ((...messages: any[]) => void) | null;
	info: ((...messages: any[]) => void) | null;
	warn: ((...messages: any[]) => void) | null;
	error: ((...messages: any[]) => void) | null;
	fatal: ((...messages: any[]) => void) | null;
	notify: ((...messages: any[]) => void) | null;
}
```

`TaggedLogger` does not have a `withTag()` method.

### Usage

#### Basic logging with `logger`

```javascript
export class MyResource extends Resource {
	async get(id) {
		logger.debug('Fetching record', { id });
		const record = await super.get(id);
		if (!record) {
			logger.warn('Record not found', { id });
		}
		return record;
	}

	async put(record) {
		logger.info('Updating record', { id: record.id });
		try {
			return await super.put(record);
		} catch (err) {
			logger.error('Failed to update record', err);
			throw err;
		}
	}
}
```

#### Tagged logging with `withTag()`

Create a tagged logger once per module or class and reuse it. Always use `?.` when calling methods since a given level may be `null` if it is below the configured log level.

```javascript
const log = logger.withTag('my-resource');

export class MyResource extends Resource {
	async get(id) {
		log.debug?.('Fetching record', { id });
		const record = await super.get(id);
		if (!record) {
			log.warn?.('Record not found', { id });
		}
		return record;
	}

	async put(record) {
		log.info?.('Updating record', { id: record.id });
		try {
			return await super.put(record);
		} catch (err) {
			log.error?.('Failed to update record', err);
			throw err;
		}
	}
}
```

Tagged entries appear in the log with the tag included in the entry header:

```
2023-03-09T14:25:05.269Z [info] [my-resource]: Updating record
```

### Log Entry Format

Entries written via `logger` appear in `hdb.log` with the standard format:

```
<timestamp> [<level>] [<thread>/<id>]: <message>
```

Entries written via a `TaggedLogger` include the tag:

```
<timestamp> [<level>] [<tag>]: <message>
```

For external components, the thread context is set automatically based on which worker thread executes the code.

<!--
Fake news (for now)
### TypeScript / Module Import

The `logger` global is also exported from the `harperdb` package for better TypeScript support:

```typescript
import { logger } from 'harperdb';
import type { MainLogger, TaggedLogger } from 'harperdb';

logger.info('Component started');

const log: TaggedLogger = logger.withTag('my-component');
log.info?.('Tagged message');
``` -->

## Related

- [Logging Overview](./overview)
- [Logging Configuration](./configuration)
- [Logging Operations](./operations)
