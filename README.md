<img src="https://hdb-marketing.s3.amazonaws.com/GRYHORIZ_HDB_Drk_Gry.png" width="692" height="156">

## Contents
1. [HarperDB Overview](#harperdb-overview)
2. [HarperDB Studio](#harperdb-studio)
3. [Built-In API](#built-in-api)
4. [Documentation and Support](#documentation-and-support)
5. [Prerequisites](#prerequisites)
6. [Installing HarperDB](#installing-harperdb)

## HarperDB Overview
HarperDB is a turn-key solution for the collection, distribution, and analysis of data throughout your organization. Projects that have historically taken months (or even years) of consulting, configuration, and custom development can be completed in days or weeks with HarperDB.

HarperDB provides unmatched flexibility, security, and value for just about every use case, and we do it all with a single installation that can run in the cloud, on-premises, and at the edge.

[Learn more about HarperDB](https://harperdb.io/?utm_source=repo&utm_medium=npm)

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

## Prerequisites
Node.js 14.0.0 or higher. Our tested & fully supported Node.js version is 16.17.1

HarperDB has been tested on the following platforms
- Linux on AMD64
- Linux on ARM64
- MacOS on Intel
- MacOS on Apple silicon (Rosetta AMD64 emulation required for Node.js versions older than Node.js 16)

Other UNIX-like operating systems and other CPU architectures may be able to run HarperDB, but these have not been tested and may require the following
- GCC
- Make
- Python v3.7, v3.8, v3.9, or v3.10
- Xcode (macOS)
- Go 1.19.1

HarperDB can run natively on Windows 10 & 11. HarperDB running on Windows is only intended for evaluation or development purposes.

## Installing HarperDB
```
npm install -g harperdb
harperdb
```
HarperDB will prompt you for configuration options during install, and then automatically start after install.

***

