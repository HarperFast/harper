# Harper

This directory contains the files used by a local Harper installation.

## Directory Guide

- `harper-config.yaml` - Local configuration read by Harper at startup and updated when settings change through the API.
- `backup/` - Backup copies of files Harper updates, such as previous `harper-config.yaml` versions.
- `components/` - Editable local components stored on this server.
- `database/` - Default location for database storage files.
- `keys/` - Private keys and certificates used for PKI/TLS.
- `log/` - Harper log output.

For installation, configuration, and API documentation, see https://docs.harperdb.io/.
