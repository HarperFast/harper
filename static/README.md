# Harper

This directory contains the files used by a local Harper installation.

## Directory Guide

- `harper-config.yaml` - Local configuration read by Harper at startup and updated when settings change through the API.
- `database/` - Default location for database storage files.
- `components/` - Editable local components stored on this server.
- `keys/` - Private keys and certificates used for PKI/TLS.
- `log/` - Harper log output.
- `backup/` - Backup copies of files Harper updates, such as previous `harper-config.yaml` versions.

For installation, configuration, and API documentation, see https://docs.harperdb.io/.
