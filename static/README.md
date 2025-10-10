# Harper

Harper is an open-source Node.js performance platform that unifies database, cache, application, and messaging layers into one in-memory process.

## Harper Filesystem Structure

- `hdb` - This is the root folder for HarperDB. It contains all the files and folders that HarperDB uses.
- `hdb/harperdb-config.yaml` - This is the configuration file, It contains all the settings for HarperDB. This file is read by HarperDB when it starts up. It is also written to when you change settings through the API.
- `hdb/database` - This folder is the default location for all your database files (that contain the actual data in your databases).
- `hdb/keys` - This folder contains the private keys (and can also have certificates) for your PKI/TLS.
- `hdb/components` - This folder contains editable components that are stored in HarperDB. This folder is intended for components that are edited and canonically stored on this server. The standard approach for components is that they are deployed from npm or GitHub and installed to the `hdb/components` directory, then symlinked to the `node_modules/` folder for dependency resolution purposes.
- `hdb/log` - This folder contains the log file for HarperDB
- `hdb/backup` - This folder contains backup copies for files when they are modified. When harperdb-config.yaml is modified through the API, previous versions are stored here.