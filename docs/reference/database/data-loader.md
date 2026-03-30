---
title: Data Loader
---

<!-- Source: versioned_docs/version-4.7/developers/applications/data-loader.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (data loader introduced) -->

# Data Loader

Added in: v4.6.0

The Data Loader is a built-in component that loads data from JSON or YAML files into Harper tables as part of component deployment. It is designed for seeding tables with initial records — configuration data, reference data, default users, or other records that should exist when a component is first deployed or updated.

## Configuration

In your component's `config.yaml`, use the `dataLoader` key to specify the data files to load:

```yaml
dataLoader:
  files: 'data/*.json'
```

`dataLoader` is an [Extension](../components/extension-api.md) and supports the standard `files` configuration option, including glob patterns.

## Data File Format

Each data file loads records into a single table. The file specifies the target database, table, and an array of records.

### JSON Example

```json
{
	"database": "myapp",
	"table": "users",
	"records": [
		{
			"id": 1,
			"username": "admin",
			"email": "admin@example.com",
			"role": "administrator"
		},
		{
			"id": 2,
			"username": "user1",
			"email": "user1@example.com",
			"role": "standard"
		}
	]
}
```

### YAML Example

```yaml
database: myapp
table: settings
records:
  - id: 1
    setting_name: app_name
    setting_value: My Application
  - id: 2
    setting_name: version
    setting_value: '1.0.0'
```

One table per file. To load data into multiple tables, create a separate file for each table.

## File Patterns

The `files` option accepts a single path, a list of paths, or a glob pattern:

```yaml
# Single file
dataLoader:
  files: 'data/seed-data.json'

# Multiple specific files
dataLoader:
  files:
    - 'data/users.json'
    - 'data/settings.yaml'
    - 'data/initial-products.json'

# Glob pattern
dataLoader:
  files: 'data/**/*.{json,yaml,yml}'
```

## Loading Behavior

The Data Loader runs on every full system start and every component deployment — this includes fresh installs, restarts of the Harper process or threads, and redeployments of the component.

Because the Data Loader runs on every startup and deployment, change detection is central to how it works safely. On each run:

1. All specified data files are read (JSON or YAML)
2. Each file is validated to reference a single table
3. Records are inserted or updated based on content hash comparison:
   - New records are inserted if they don't exist
   - Existing records are updated only if the data file content has changed
   - Records created outside the Data Loader (via Operations API, REST, etc.) are never overwritten
   - Records modified by users after being loaded are preserved and not overwritten
   - Extra fields added by users to data-loaded records are preserved during updates
4. SHA-256 content hashes are stored in the [`hdb_dataloader_hash`](./system-tables.md#hdb_dataloader_hash) system table to track which records have been loaded and detect changes

### Change Detection

| Scenario                                           | Behavior                                         |
| -------------------------------------------------- | ------------------------------------------------ |
| New record                                         | Inserted; content hash stored                    |
| Unchanged record                                   | Skipped (no writes)                              |
| Changed data file                                  | Updated via `patch`, preserving any extra fields |
| Record created by user (not data loader)           | Never overwritten                                |
| Record modified by user after load                 | Preserved, not overwritten                       |
| Extra fields added by user to a data-loaded record | Preserved during updates                         |

This design makes data files safe to redeploy repeatedly — across deployments, node scaling, and system restarts — without losing manual modifications or causing unnecessary writes.

## Best Practices

**Define schemas first.** While the Data Loader can infer schemas from the records it loads, it is strongly recommended to define table schemas explicitly using the [graphqlSchema component](./schema.md) before loading data. This ensures proper types, constraints, and relationships.

**One table per file.** Each data file must target a single table. Organize files accordingly.

**Idempotent data.** Design files to be safe to load multiple times without creating duplicate or conflicting records.

**Version control.** Include data files in version control for consistency across deployments and environments.

**Environment-specific data.** Consider using different data files for different environments (development, staging, production) to avoid loading inappropriate records.

**Validate before deploying.** Ensure data files are valid JSON or YAML and match your table schemas before deployment to catch type mismatches early.

**No sensitive data.** Do not include passwords, API keys, or secrets directly in data files. Use environment variables or secure configuration management instead.

## Example Component Structure

A common production use case is shipping reference data — lookup tables like countries and regions — as part of a component. The records are version-controlled alongside the code, consistent across every environment, and the data loader keeps them in sync on every deployment without touching any user-modified fields.

```
my-component/
├── config.yaml
├── schemas.graphql
├── roles.yaml
└── data/
    ├── countries.json    # ISO country codes — reference data, ships with component
    └── regions.json      # region/subdivision codes
```

**`config.yaml`**:

```yaml
graphqlSchema:
  files: 'schemas.graphql'

roles:
  files: 'roles.yaml'

dataLoader:
  files: 'data/*.json'

rest: true
```

**`schemas.graphql`**:

```graphql
type Country @table(database: "myapp") @export {
	id: String @primaryKey # ISO 3166-1 alpha-2, e.g. "US"
	name: String @indexed
	region: String @indexed
}

type Region @table(database: "myapp") @export {
	id: String @primaryKey # ISO 3166-2, e.g. "US-CA"
	name: String @indexed
	countryId: String @indexed
	country: Country @relationship(from: countryId)
}
```

**`data/countries.json`**:

```json
{
	"database": "myapp",
	"table": "Country",
	"records": [
		{ "id": "US", "name": "United States", "region": "Americas" },
		{ "id": "GB", "name": "United Kingdom", "region": "Europe" },
		{ "id": "DE", "name": "Germany", "region": "Europe" }
		// ... all ~250 ISO countries
	]
}
```

**`data/regions.json`**:

```json
{
	"database": "myapp",
	"table": "Region",
	"records": [
		{ "id": "US-CA", "name": "California", "countryId": "US" },
		{ "id": "US-NY", "name": "New York", "countryId": "US" },
		{ "id": "GB-ENG", "name": "England", "countryId": "GB" }
		// ...
	]
}
```

Because the data loader uses content hashing, adding new countries or correcting a name in the file will update only the changed records on the next deployment — existing records that haven't changed are skipped entirely.

## Related Documentation

- [Schema](./schema.md) — Defining table structure before loading data
- [Jobs](./jobs.md) — Bulk data operations via the Operations API (CSV/JSON import from file, URL, or S3)
- [Components](../components/overview.md) — Extension and plugin system that the data loader is built on
