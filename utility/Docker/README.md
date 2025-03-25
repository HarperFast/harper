<img src="https://hdb-marketing.s3.amazonaws.com/GRYHORIZ_HDB_Drk_Gry.png" width="692" height="156">

## Harper Overview

Harper is a globally-distributed edge application platform. It reduces complexity, increases performance, and lowers costs by combining user-defined applications, a high-performance database, and an enterprise-grade streaming broker into a single package. The platform offers unlimited horizontal scale at the click of a button, and syncs data across the cluster in milliseconds. Harper simplifies the process of delivering applications and the data that drives them to the edge, which dramatically improves both the user experience and total cost of ownership for large-scale applications. Deploying Harper on global infrastructure enables a CDN-like solution for enterprise data and applications.

[Learn more about Harper](https://www.harpersystems.dev//?utm_source=repo&utm_medium=dockerhub)

## Harper Studio

Every Installation of Harper can be administered online using Harper Studio. This web-based interface provides you the ability to set up new schemas and tables, configure users and roles, manage data replication, and purchase and deploy enterprise licenses.

- Simplify Administration – handle all Harper administration tasks from one simple interface

[Harper Studio](https://studio.harperdb.io/sign-up)

## Harper APIs

The preferred way to interact with Harper for typical querying, accessing, and updating data (CRUD) operations is through the REST interface, described in the REST documentation.

The complete [Harper Operations API documentation](https://docs.harperdb.io/docs/operations-api) provides important administrative functions. Generally it is recommended that use the [RESTful interface](https://docs.harperdb.io/docs/rest/) as your primary interface for scalable and performant data interaction for building production applications, and the operations API for administrative purposes.

## Documentation and Support

[Docs](https://docs.harperdb.io/)

[Support](https://www.harpersystems.dev/support/)

## How to Use This Image

### Configuring Harper

[Harper configuration settings](https://harperdb.io/docs/reference/configuration-file/) can be passed as `docker run` environment variables.

If no environment variables are passed to `docker run`, Harper will run with default configuration settings, except for the following:

- `ROOTPATH=/home/harperdb/hdb`
- `OPERATIONSAPI_NETWORK_PORT=9925`
- `HDB_ADMIN_USERNAME=HDB_ADMIN`
- `HDB_ADMIN_PASSWORD=password`
- `LOGGING_STDSTREAMS=true`

### Persisting Data

Containers created from this image will store all data and Harper configuration at `/home/harperdb/hdb`. To persist this data beyond the lifecycle of a container, use a Docker volume to mount this directory to the container host.

### Examples

To run a Harper container in the background, with the ROOTPATH directory mounted to the container host, and expose the Harper Operations API and HTTP ports on the container host:

```
docker run -d \
  -v <host directory>:/home/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -e THREADS=4 \
  -p 9925:9925 \
  -p 9926:9926 \
  harpersystems/harper
```

To enable HTTPS and replication:

```
docker run -d \
  -v <host directory>:/home/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -e THREADS=4 \
  -e OPERATIONSAPI_NETWORK_PORT=null \
  -e OPERATIONSAPI_NETWORK_SECUREPORT=9925 \
  -e HTTP_SECUREPORT=9926 \
  -e REPLICATION_HOSTNAME=server-one \
  -p 9925:9925 \
  -p 9926:9926 \
  harpersystems/harper
```

To enable HTTPS, enable Harper replication via NATS (NATS is the legacy replication, the replication above is recommended), and expose the Harper clustering port on the container host:

```
docker run -d \
  -v <host directory>:/home/harperdb/hdb \
  -e HDB_ADMIN_USERNAME=HDB_ADMIN \
  -e HDB_ADMIN_PASSWORD=password \
  -e THREADS=4 \
  -e OPERATIONSAPI_NETWORK_PORT=null \
  -e OPERATIONSAPI_NETWORK_SECUREPORT=9925 \
  -e HTTP_SECUREPORT=9926 \
  -e CLUSTERING_ENABLED=true \
  -e CLUSTERING_USER=cluster_user \
  -e CLUSTERING_PASSWORD=password \
  -e CLUSTERING_NODENAME=hdb1 \
  -p 9925:9925 \
  -p 9926:9926 \
  -p 9932:9932 \
  harpersystems/harper
```

To execute the `harperdb version` command, and remove the container when finished:

```
docker run --rm harpersystems/harper /bin/bash -c "harperdb version"
```
