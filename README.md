<img src="https://cdn.prod.website-files.com/6374050260446c42f94dc90f/68017805c782145469de5f0f_Harper%20Logo.png" width="30%">

## Contents

1. [Harper Overview](#harper-overview)
2. [Harper Studio](#harper-studio)
3. [Harper APIs](#harper-apis)
4. [Documentation and Support](#documentation-and-support)
5. [Prerequisites](#prerequisites)
6. [Installing Harper](#installing-harper)

## Harper Overview

Harper eliminates the complexity typically synonymous with distributed services by combining an ultra-fast document data store, in-memory cache, real-time message broker, and your application components into a single distributed technology. When clustered and geo-distributed, Harper nodes instantly synchronize data creating a real-time service fabric, ensuring low-latency in-region responses for clients worldwide. In addition to massive cost savings at scale, Harper’s REST, GraphQL, SQL, and real-time interfaces make light work of servicing frontend requirements. Install and manage on your hardware with npm, or have us host your services with Harper Cloud. For questions, reach us at [hello@harperdb.io](mailto:hello@harperdb.io).

[Learn more about Harper](https://www.harpersystems.dev/?utm_source=repo&utm_medium=npm)

## Harper Studio

Every Installation of Harper can be administered online using Harper Studio. This web-based interface provides you the ability to set up new schemas and tables, configure users and roles, manage data replication, and purchase and deploy enterprise licenses.

- Simplify Administration – handle all Harper administration tasks from one simple interface

[Harper Studio](https://studio.harperdb.io/sign-up)

## Harper APIs

The preferred way to interact with Harper for typical querying, accessing, and updating data (CRUD) operations is through the REST interface, described in the REST documentation.

The complete [Harper Operations API documentation](https://docs.harperdb.io/docs/operations-api) provides important administrative functions. Generally it is recommended that use the [RESTful interface](https://docs.harperdb.io/docs/rest/) as your primary interface for scalable and performant data interaction for building production applications, and the operations API for administrative purposes.

## Documentation and Support

[Docs](https://docs.harperdb.io/)

[Support](https://harperdb.io/support/)

## Prerequisites

Harper requires Node.js 14 or higher. Our fully tested and supported Node.js version is 18.15.0.

Harper has been tested on the following platforms

- Linux on AMD64
- Linux on ARM64
- MacOS on Intel
- MacOS on Apple silicon (Rosetta AMD64 emulation required for Node.js versions older than Node.js 16)

Other UNIX-like operating systems and other CPU architectures may be able to run Harper, but these have not been tested and may require the following

- GCC
- Make
- Python v3.7, v3.8, v3.9, or v3.10
- Xcode (macOS)
- Go 1.19.1

Harper can run natively on Windows 10 & 11. Harper running on Windows is only intended for evaluation or development purposes.

## Installing Harper

```
npm install -g harperdb
harperdb
```

Harper will prompt you for configuration options during install, and then automatically start after install.

---
