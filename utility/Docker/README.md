<img src="https://hdb-marketing.s3.amazonaws.com/large_purple_horiz_new.png" width="562" height="161" alt="HarperDB Logo">

## HarperDB Overview

HarperDB is a turn-key solution for the collection, distribution, and analysis of data throughout your organization. Projects that have historically taken months (or even years) of consulting, configuration, and custom development can be completed in days or weeks with HarperDB.

HarperDB provides unmatched flexibility, security, and value for just about every use case, and we do it all with a single installation that can run in the cloud, on-premise, and at the edge.

[Learn more about HarperDB](https://harperdb.io/?utm_source=docker&utm_medium=hub)

## HarperDB Studio

Every Installation of HarperDB can be administered online using HarperDB Studio. This web-based interface provides you the ability to set up new schemas and tables, configure users and roles, manage data replication, and purchase and deploy enterprise licenses.
- Simplify Administration – handle all HarperDB administration tasks from one simple interface

[HarperDB Studio](https://studio.harperdb.io/sign-up)

## Built-In API

Reduce or eliminate complexity by using HarperDB’s built-in API. Create and manage not only the data you’re storing but all configuration and replication settings from a single endpoint that supports HTTP and HTTPS.
- Reduce or Eliminate Middleware – speed up development and lower costs
- Reduce Overhead, Increase Security – API requests are individually authenticated and self-closing

[API Reference](https://api.harperdb.io/)

## Documentation and Support

[Docs](https://docs.harperdb.io/)

[Support](https://harperdb.io/docs/support/)

## How to Use This Image

### Configuring HarperDB
[HarperDB configuration settings](https://harperdb.io/docs/reference/configuration-file/) can be passed as `docker run` environment variables.

If no environment variables are passed to `docker run`, HarperDB will run with default configuration settings, except for the following:
- `HDB_ROOT=/opt/harperdb/hdb`
- `SERVER_PORT=9925`
- `HDB_ADMIN_USERNAME=HDB_ADMIN`
- `HDB_ADMIN_PASSWORD=password`
- `LOG_TO_STDSTREAMS=true`
- `RUN_IN_FOREGROUND=true`

### Persisting Data
Containers created from this image will store all data and HarperDB configuration at `/opt/harperdb/hdb`. To persist this data beyond the lifecycle of a container, use a Docker volume to mount this directory to the container host.

### Examples

Run a HarperDB container in the background, with the HDB_ROOT directory mounted to the container host, and expose the HarperDB API port on the container host:
```
docker run -d \
  -v /host/directory:/opt/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -p 9925:9925 \
  harperdb/harperdb
```

Enable HarperDB Custom Functions and expose the HarperDB Custom Functions on the container host:
```
docker run -d \
  -v /host/directory:/opt/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -e CUSTOM_FUNCTIONS=true \
  -p 9925:9925 \
  -p 9926:9926 \
  harperdb/harperdb
```

Enable HTTPS for the HarperDB API, enable HarperDB clustering, and expose the HarperDB clustering port on the container host:
```
docker run -d \
  -v /host/directory:/opt/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -e CUSTOM_FUNCTIONS=true \
  -e HTTPS_ON=true \
  -e CLUSTERING=true \
  -e CLUSTERING_USER=cluster_user \
  -e CLUSTERING_PASSWORD=password \
  -e CLUSTERING_PORT=12345 \
  -e NODE_NAME=hdb1 \
  -p 9925:9925 \
  -p 9926:9926 \
  -p 12345:12345 \
  harperdb/harperdb
```

Execute the `harperdb version` command, and remove the container when finished:
```
docker run --rm harperdb/harperdb /bin/bash -c "harperdb version"
```