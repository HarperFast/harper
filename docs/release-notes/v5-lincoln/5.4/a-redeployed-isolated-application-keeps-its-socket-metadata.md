---
section: 'Component Deploys'
order: 86
---

### A Redeployed Isolated Application Keeps Its Socket Metadata

Redeploying an isolated application, with `restart: true` or `restart: "rolling"`, no longer leaves its Unix domain sockets without the `.yaml` file beside each one. A proxy that routes only sockets with that file, as Harper Fabric's does, stopped routing the application until Harper restarted, so a pull request preview went unreachable after its second push. A worker now writes the `.yaml` only once its socket is listening. See [reaching an isolated application](/reference/v5/components/applications#reaching-an-isolated-application).
