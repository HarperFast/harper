---
title: Jobs
---

<!-- Source: versioned_docs/version-4.7/administration/jobs.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/bulk-operations.md (bulk operations detail) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/jobs.md (job management operations) -->

# Jobs

Harper uses an asynchronous job system for long-running data operations. When a bulk operation is initiated — such as loading a large CSV file or exporting millions of records — Harper starts a background job and immediately returns a job ID. Use the job ID to check progress and status.

Job status values:

- `IN_PROGRESS` — the job is currently running
- `COMPLETE` — the job finished successfully

## Bulk Operations

The following operations create jobs. All bulk operations are sent to the [Operations API](../operations-api/overview.md).

### CSV Data Load

Ingests CSV data provided directly in the request body.

- `operation` _(required)_ — `csv_data_load`
- `database` _(optional)_ — target database; defaults to `data`
- `table` _(required)_ — target table
- `action` _(optional)_ — `insert`, `update`, or `upsert`; defaults to `insert`
- `data` _(required)_ — CSV content as a string

```json
{
	"operation": "csv_data_load",
	"database": "dev",
	"action": "insert",
	"table": "breed",
	"data": "id,name,country\n1,Labrador,Canada\n2,Poodle,France\n"
}
```

Response:

```json
{
	"message": "Starting job with id 2fe25039-566e-4670-8bb3-2db3d4e07e69",
	"job_id": "2fe25039-566e-4670-8bb3-2db3d4e07e69"
}
```

---

### CSV File Load

Ingests CSV data from a file on the server's local filesystem.

> The CSV file must reside on the same machine running Harper.

- `operation` _(required)_ — `csv_file_load`
- `database` _(optional)_ — target database; defaults to `data`
- `table` _(required)_ — target table
- `action` _(optional)_ — `insert`, `update`, or `upsert`; defaults to `insert`
- `file_path` _(required)_ — absolute path to the CSV file on the host

```json
{
	"operation": "csv_file_load",
	"action": "insert",
	"database": "dev",
	"table": "breed",
	"file_path": "/home/user/imports/breeds.csv"
}
```

---

### CSV URL Load

Ingests CSV data from a URL.

- `operation` _(required)_ — `csv_url_load`
- `database` _(optional)_ — target database; defaults to `data`
- `table` _(required)_ — target table
- `action` _(optional)_ — `insert`, `update`, or `upsert`; defaults to `insert`
- `csv_url` _(required)_ — URL pointing to the CSV file

```json
{
	"operation": "csv_url_load",
	"action": "insert",
	"database": "dev",
	"table": "breed",
	"csv_url": "https://s3.amazonaws.com/mydata/breeds.csv"
}
```

---

### Import from S3

Imports CSV or JSON files from an AWS S3 bucket.

- `operation` _(required)_ — `import_from_s3`
- `database` _(optional)_ — target database; defaults to `data`
- `table` _(required)_ — target table
- `action` _(optional)_ — `insert`, `update`, or `upsert`; defaults to `insert`
- `s3` _(required)_ — S3 connection details:
  - `aws_access_key_id`
  - `aws_secret_access_key`
  - `bucket`
  - `key` — filename including extension (`.csv` or `.json`)
  - `region`

```json
{
	"operation": "import_from_s3",
	"action": "insert",
	"database": "dev",
	"table": "dog",
	"s3": {
		"aws_access_key_id": "YOUR_KEY",
		"aws_secret_access_key": "YOUR_SECRET_KEY",
		"bucket": "BUCKET_NAME",
		"key": "dogs.json",
		"region": "us-east-1"
	}
}
```

---

### Export Local

Exports table data to a local file in JSON or CSV format.

- `operation` _(required)_ — `export_local`
- `format` _(required)_ — `json` or `csv`
- `path` _(required)_ — local directory path where the export file will be written
- `search_operation` _(required)_ — query to select records: `search_by_hash`, `search_by_value`, `search_by_conditions`, or `sql`

<VersionBadge type="changed" version="v4.3.0" /> — `search_by_conditions` added as a supported search operation for exports

- `filename` _(optional)_ — filename without extension; auto-generated from epoch timestamp if omitted

```json
{
	"operation": "export_local",
	"format": "json",
	"path": "/data/exports/",
	"search_operation": {
		"operation": "sql",
		"sql": "SELECT * FROM dev.breed"
	}
}
```

---

### Export to S3

Exports table data to an AWS S3 bucket in JSON or CSV format.

<VersionBadge type="changed" version="v4.3.0" /> — `search_by_conditions` added as a supported search operation

- `operation` _(required)_ — `export_to_s3`
- `format` _(required)_ — `json` or `csv`
- `s3` _(required)_ — S3 connection details (same fields as Import from S3, plus `key` for the output object name)
- `search_operation` _(required)_ — `search_by_hash`, `search_by_value`, `search_by_conditions`, or `sql`

```json
{
	"operation": "export_to_s3",
	"format": "json",
	"s3": {
		"aws_access_key_id": "YOUR_KEY",
		"aws_secret_access_key": "YOUR_SECRET_KEY",
		"bucket": "BUCKET_NAME",
		"key": "exports/dogs.json",
		"region": "us-east-1"
	},
	"search_operation": {
		"operation": "sql",
		"sql": "SELECT * FROM dev.dog"
	}
}
```

---

### Delete Records Before

Deletes records older than a given timestamp from a table. Operates only on the local node — clustered replicas retain their data.

_Restricted to `super_user` roles._

- `operation` _(required)_ — `delete_records_before`
- `schema` _(required)_ — database name
- `table` _(required)_ — table name
- `date` _(required)_ — records with `__createdtime__` before this timestamp are deleted. Format: `YYYY-MM-DDThh:mm:ss.sZ`

```json
{
	"operation": "delete_records_before",
	"date": "2024-01-01T00:00:00.000Z",
	"schema": "dev",
	"table": "breed"
}
```

## Managing Jobs

### Get Job

Returns status, metrics, and messages for a specific job by ID.

- `operation` _(required)_ — `get_job`
- `id` _(required)_ — job ID

```json
{
	"operation": "get_job",
	"id": "4a982782-929a-4507-8794-26dae1132def"
}
```

Response:

```json
[
	{
		"__createdtime__": 1611615798782,
		"__updatedtime__": 1611615801207,
		"created_datetime": 1611615798774,
		"end_datetime": 1611615801206,
		"id": "4a982782-929a-4507-8794-26dae1132def",
		"job_body": null,
		"message": "successfully loaded 350 of 350 records",
		"start_datetime": 1611615798805,
		"status": "COMPLETE",
		"type": "csv_url_load",
		"user": "HDB_ADMIN",
		"start_datetime_converted": "2021-01-25T23:03:18.805Z",
		"end_datetime_converted": "2021-01-25T23:03:21.206Z"
	}
]
```

---

### Search Jobs by Start Date

Returns all jobs started within a time window.

_Restricted to `super_user` roles._

- `operation` _(required)_ — `search_jobs_by_start_date`
- `from_date` _(required)_ — start of the search window (ISO 8601 format)
- `to_date` _(required)_ — end of the search window (ISO 8601 format)

```json
{
	"operation": "search_jobs_by_start_date",
	"from_date": "2024-01-01T00:00:00.000+0000",
	"to_date": "2024-01-02T00:00:00.000+0000"
}
```

## Related Documentation

- [Data Loader](./data-loader.md) — Component-based data loading as part of deployment
- [Operations API](../operations-api/overview.md) — Sending operations to Harper
- [Transaction Logging](./transaction.md) — Recording a history of changes made to tables
