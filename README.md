<img src="https://hdb-marketing.s3.amazonaws.com/GRYHORIZ_HDB_Drk_Gry.png" width="692" height="156">

## Contents
1. [HarperDB Overview](#harperdb-overview)
2. [HarperDB Studio](#harperdb-studio)
3. [HarperDB APIs](#harperdb-apis)
4. [Documentation and Support](#documentation-and-support)
5. [Prerequisites](#prerequisites)
6. [Installing HarperDB](#installing-harperdb)

## HarperDB Overview
HarperDB eliminates the complexity typically synonymous with distributed services by combining an ultra-fast document data store, in-memory cache, real-time message broker, and your application components into a single distributed technology. When clustered and geo-distributed, HarperDB nodes instantly synchronize data creating a real-time service fabric, ensuring low-latency in-region responses for clients worldwide. In addition to massive cost savings at scale, HarperDB’s REST, GraphQL, SQL, and real-time interfaces make light work of servicing frontend requirements. Install and manage on your hardware with npm, or have us host your services with HarperDB Cloud. For questions, reach us at [hello@harperdb.io](mailto:hello@harperdb.io).

[Learn more about HarperDB](https://www.harperdb.io/?utm_source=repo&utm_medium=npm)

## HarperDB Studio
Every Installation of HarperDB can be administered online using HarperDB Studio. This web-based interface provides you the ability to set up new schemas and tables, configure users and roles, manage data replication, and purchase and deploy enterprise licenses.
- Simplify Administration – handle all HarperDB administration tasks from one simple interface

[HarperDB Studio](https://studio.harperdb.io/sign-up)

## HarperDB APIs

The preferred way to interact with HarperDB for typical querying, accessing, and updating data (CRUD) operations is through the REST interface, described in the REST documentation.

The complete [HarperDB Operations API documentation](https://docs.harperdb.io/docs/operations-api) provides important administrative functions. Generally it is recommended that use the [RESTful interface](https://docs.harperdb.io/docs/rest/) as your primary interface for scalable and performant data interaction for building production applications, and the operations API for administrative purposes.

## Documentation and Support
[Docs](https://docs.harperdb.io/)

[Support](https://harperdb.io/support/)

## Prerequisites
HarperDB requires Node.js 14 or higher. Our fully tested and supported Node.js version is 18.15.0.

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

