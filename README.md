# Harper

Harper is an open-source Node.js unified development platform that fuses database, cache, application, and messaging layers into one in-memory process. With Harper you can build ultra-high-performance services without boilerplate code and scale them horizontally. 

**Key Features:**

**Unified Runtime:** Database, cache, application logic, and messaging all operate within a single in-memory Node.js process, eliminating external dependencies and reducing latency.

**In-Memory Performance:** Data and compute share memory space for microsecond-level access times and exceptional throughput under load.

**Native Messaging:** Built-in publish/subscribe messaging with Websockets and MQTT enables real-time communication between nodes and clients without external brokers.

**Developer Simplicity:** Annotate your data schema with `@export` to instantly generate REST APIs. Extend functionality by defining custom endpoints in JavaScript.

---

**Deploy with [Harper Fabric](https://fabric.harper.fast/#/sign-in) for Horizontal Scalability:** Distribute workloads across multiple Harper nodes by selecting your regions and latency targets.

---

## Getting Started

1. [Install Harper](https://docs.harperdb.io/docs/getting-started/installation)
2. [Create Your First App](https://docs.harperdb.io/docs/getting-started/quickstart)

## Open Source Note

This repository represents Harper's future direction as an open-source-first platform. The code here is under active development and targets the upcoming **Harper v5** release. If you're looking for production-ready Harper, please refer to **Harper v4** — our current closed-source release documented at https://docs.harper.fast . We're rebuilding Harper from the ground up with an open source core and modular source-available plugins. This code is not yet published or production-ready, but we're excited to build the next generation of Harper in the open. Follow along, provide feedback, and watch as we shape the future of the platform together.

## What is HarperDB?

HarperDB is our previous name. Earlier in 2025, [we rebranded](https://www.harper.fast/announcements/harperdb-proclaims-new-era-for-web-performance-with-corporate-rebrand) to just "Harper" to reflect our evolution from a database to a full performance platform. The core technology remains the same, but we've expanded our vision to encompass more than just database functionality. Since this repo was created from the existing Harper codebase, you may still see references to the old name "HarperDB" in certain places.

## Contributing to Harper

Harper's open source core accepts contributions from the community! Please read our [guidelines](./CONTRIBUTING.md) before contributing.

Open an issue if you find a bug, or reach out on our [Discord](https://discord.gg/VzZuaw3Xay) if you have questions or want to discuss ideas.

For more information on how to contribute, please see our:

- [Contributing Guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Support](./SUPPORT.md)

## Security

Please review our [Security Policy](./SECURITY.md) for reporting vulnerabilities.

Please always disclose vulnerabilities privately to `security@harperdb.io` before making them public.

## License

Harper is available under the Apache-2.0 License. See the [LICENSE](./LICENSE) for the full license text or the [License FAQ](https://harper.fast/resources/licensing-faq) for more information.
