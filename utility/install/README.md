# HarperDB

### Documentation

[HarperDB Documentation https://docs.harperdb.io/docs](https://docs.harperdb.io/docs) 

### Getting Started

To display all available commands:

```bash
harperdb help
```

### HarperDB Filesystem Structure

- `hdb` - This is the root folder for HarperDB. It contains all the files and folders that HarperDB uses.
- `hdb/harperdb-config.yaml` - This is the configuration file, It contains all the settings for HarperDB. This file is read by HarperDB when it starts up. It is also written to when you change settings through the API.
- `hdb/database` - This folder is the default location for all your database files (that contain the actual data in your databases).
- `hdb/keys` - This folder contains the private keys (and can also have certificates) for your PKI/TLS.
- `hdb/components` - This folder contains editable components that are stored in HarperDB. Note that the standard approach for components is that they are deployed from NPM or github, in which case they are not stored in HarperDB (will not be in this folder), and instead are installed (copied from the canonical location) in hdb/node_modules. This folder is intended for components that are edited and canonically stored on this server.
- `hdb/log` - This folder contains the log file for HarperDB
- `hdb/backup` - This folder contains backup copies for files when they are modified. When harperdb-config.yaml is modified through the API, previous versions are stored here.