let payload = {}
payload.msg = {"operation": "read_log"};
payload.node = {"name":"node_2"}
global.cluster_server.send(payload, res);

