---
title: Data Loader
---

<!-- Source: versioned_docs/version-4.7/developers/applications/data-loader.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (data loader introduced) -->

# Data Loader

<VersionBadge version="v4.6.0" />

The Data Loader is a built-in component that loads data from JSON or YAML files into Harper tables as part of component deployment. It is designed for seeding tables with initial records — configuration data, reference data, default users, or other records that should exist when a component is first deployed or updated.

## Configuration

In your component's `config.yaml`, use the `dataLoader` key to specify the data files to load:

```yaml
dataLoader:
  files: 'data/*.json'
```

`dataLoader` is a [plugin](../components/plugin-api.md) and supports the standard `files` configuration option, including glob patterns.

## Data File Format

Each data file loads records into a single table. The file specifies the target database, table, and an array of records. `database` is optional; a file without it loads into the default `data` database.

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

### Target Database

<VersionBadge type="changed" version="v5.4.0" />

A file that names a database loads only into that database. If the table does not exist there, the Data Loader creates it there. Earlier versions, when the named database had no such table, loaded the file into a same-named table in the default `data` database if one existed.

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
3. Each record is matched to the stored record with the same primary key, and inserted or updated based on content hash comparison:
   - New records are inserted if they don't exist
   - Existing records are updated only if the data file content has changed
   - Records created outside the Data Loader (via Operations API, REST, etc.) are never overwritten
   - Records modified by users after being loaded are preserved and not overwritten
   - Extra fields added by users to data-loaded records are preserved during updates
4. SHA-256 content hashes are stored in the [`hdb_dataloader_hash`](./system-tables.md#hdb_dataloader_hash) system table to track which records have been loaded and detect changes

### Change Detection

<VersionBadge type="changed" version="v5.4.0" />

Records are matched and tracked by the table's primary key, whether that is `id` or a custom [`@primaryKey`](./schema.md#primarykey) field. Versions before v5.4.0 looked up and tracked records by their `id` field, so on a table with another primary key any record whose `id` field did not match its primary key was not found and was rewritten on each load, overwriting user edits.

| Scenario                                           | Behavior                                         |
| -------------------------------------------------- | ------------------------------------------------ |
| New record                                         | Inserted; content hash stored                    |
| Unchanged record                                   | Skipped (no writes)                              |
| Same content with object keys in a different order | Skipped (no writes)                              |
| Changed data file                                  | Updated via `patch`, preserving any extra fields |
| Record created by user (not data loader)           | Never overwritten                                |
| Record modified by user after load                 | Preserved, not overwritten                       |
| Extra fields added by user to a data-loaded record | Preserved during updates                         |

Key order in nested objects does not count as a content change, so reordering a nested object's keys in the data file does not update the record. Before v5.4.0, only the order of a record's top-level keys was ignored. Array element order still counts.

This design makes data files safe to redeploy repeatedly — across deployments, node scaling, and system restarts — without losing manual modifications or causing unnecessary writes.

:::note Upgrading from versions before 5.4.0

Records loaded by an earlier version stay as they are, and most keep receiving data file updates. These stop receiving them:

- **Tables with a custom primary key.** Earlier versions tracked these records by their `id` field. Records with a unique `id` value keep receiving updates. Records with no `id` field shared one tracking entry, as did records with the same `id` value; of each such group, only one record is still recognized as loaded from the data file.
- **Files that name a database other than `data`, whose table name also exists in the default `data` database.** Records an earlier version loaded into the named database's table are no longer recognized. Records it loaded into the `data` table instead are no longer the file's target and are left there.
- **Names that contain a colon.** Records an earlier version loaded are no longer recognized when the table's name or the data file's `database` contains `:`, or when the default `data` database has a table named after the file's database and table joined by `:` (such as `inventory:items` for a file that loads the `items` table of the `inventory` database).
- **Primary keys that do not survive a JSON round trip.** Records with a non-finite numeric primary key (such as YAML `.inf` or `-.inf`, which JSON serializes as `null`) are no longer recognized because earlier content hashes did not distinguish them.

To have the data file manage such a record again, delete it; the next load inserts it from the data file.

:::

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
- [Components](../components/overview.md) — Plugin system that the data loader is built on
