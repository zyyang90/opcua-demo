// simulate-timeout.js
// OPC UA 模拟服务器 —— 复现 taosx-opc `points` 命令在 iFIX OPC UA Server 上的两个报错：
//
//   报错① StatusBadLicenseLimitsExceeded (0x810F0000) —— Connect 阶段被拒
//   报错② StatusBadTimeout            (0x800A0000) —— get points properties / browse 超时
//
// 复现原理（与现场一致）：
//   1) 服务器在 OperationLimits 上报 maxNodesPerRead=65536、maxNodesPerBrowse=65536
//      （i=11705 / i=11710）。taosx 的 getServerLimit 直接信任该值，导致
//      maxNodePerGetPoints = 65536/2 = 32768，把上万个节点塞进一次 Read/Browse。
//   2) 服务器在 Read/Browse 处理上注入“与请求规模成正比”的延迟（模拟慢 server），
//      使巨量单批请求超过客户端 request_timeout → 客户端报 StatusBadTimeout。
//      修复后 taosx 给上报值封顶（批次变小），同样的延迟下不再超时。
//   3) 通过 --license-max 限制会话数，超限时在 CreateSession 阶段直接返回
//      BadLicenseLimitsExceeded（与 iFIX license 限制行为一致）。
//
// 用法：
//   node simulate-timeout.js [--port 4840] [--path ""]
//                            [--children 6000] [--per-node-delay 1] [--max-delay 30000]
//                            [--license-max 100]
//
// 参数：
//   --port           监听端口（默认 4840）
//   --path           资源路径（默认空，endpoint = opc.tcp://<host>:<port>）
//   --children       Plant 下的扁平子节点数量（默认 6000，越大单批越大越易超时）
//   --per-node-delay 每个节点在 Read/Browse 上注入的延迟 ms（默认 1）
//   --max-delay      单次请求注入延迟的上限 ms（默认 30000）
//   --license-max    最大并发会话数；当前会话数 >= 该值时 CreateSession 返回
//                    BadLicenseLimitsExceeded（默认 100=基本不限制；设 0 可直接复现报错①）

import pkg from "node-opcua";

const {
  OPCUAServer,
  Variant,
  DataType,
  ServiceFault,
  StatusCodes,
} = pkg;

// ---------- 1) 解析命令行参数 ----------
const argv = process.argv.slice(2);
let port = 4840;
let resourcePath = "";
let children = 6000;
let perNodeDelay = 1;
let maxDelay = 30000;
let licenseMax = 100;

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--port": port = parseInt(argv[++i], 10); break;
    case "--path": resourcePath = argv[++i]; break;
    case "--children": children = parseInt(argv[++i], 10); break;
    case "--per-node-delay": perNodeDelay = parseFloat(argv[++i]); break;
    case "--max-delay": maxDelay = parseInt(argv[++i], 10); break;
    case "--license-max": licenseMax = parseInt(argv[++i], 10); break;
  }
}

// ---------- 2) 启动服务器，关键：上报虚高的 OperationLimits ----------
const server = new OPCUAServer({
  port,
  resourcePath,
  buildInfo: {
    productName: "Timeout Repro OPC UA Server", // 注意：非 "KEPServerEX"，走 taosx 通用分支
    manufacturerName: "taosx-test",
  },
  serverCapabilities: {
    // 复现现场 iFIX 上报的虚高值
    operationLimits: {
      maxNodesPerRead: 65536,
      maxNodesPerBrowse: 65536,
    },
  },
});

await server.initialize();

// ---------- 3) 构建地址空间：Plant 下挂 N 个扁平子节点 ----------
// 扁平结构让某一层 BFS 节点数 ≈ N，使 taosx 形成一个 ~N*2 ReadValueID 的巨量单批。
const addressSpace = server.engine.addressSpace;
const namespace = addressSpace.registerNamespace("urn:taosdata:timeout-poc");
const objects = addressSpace.rootFolder.objects;
const nsIndex = namespace.index; // 通常为 2

const plant = namespace.addObject({
  organizedBy: objects,
  browseName: "Plant1",
  nodeId: `ns=${nsIndex};s=Plant1`,
});

for (let i = 0; i < children; i++) {
  const name = `Tag_${String(i).padStart(5, "0")}`;
  namespace.addVariable({
    componentOf: plant,
    browseName: name,
    nodeId: `ns=${nsIndex};s=Plant1.${name}`,
    dataType: "Double",
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.Double, value: Math.random() * 100 }),
    },
  });
}

// ---------- 4) 注入“与请求规模成正比”的延迟，模拟慢 server ----------
function delayMsFor(count) {
  return Math.min(Math.ceil(count * perNodeDelay), maxDelay);
}

function wrapWithDelay(methodName, countFn) {
  const orig = server[methodName].bind(server);
  server[methodName] = function (message, channel) {
    let count = 0;
    try { count = countFn(message.request) || 0; } catch (_) { count = 0; }
    const delay = delayMsFor(count);
    if (delay > 0) {
      setTimeout(() => {
        try { orig(message, channel); } catch (e) { /* 客户端可能已超时关闭通道，忽略 */ }
      }, delay);
    } else {
      orig(message, channel);
    }
  };
}

wrapWithDelay("_on_ReadRequest", (req) => (req.nodesToRead ? req.nodesToRead.length : 0));
wrapWithDelay("_on_BrowseRequest", (req) => (req.nodesToBrowse ? req.nodesToBrowse.length : 0));

// ---------- 5) license 限制：会话超限时返回 BadLicenseLimitsExceeded ----------
const origCreateSession = server._on_CreateSessionRequest.bind(server);
server._on_CreateSessionRequest = function (message, channel) {
  if (server.currentSessionCount >= licenseMax) {
    console.log(`[timeout-poc] reject CreateSession: currentSessions=${server.currentSessionCount} >= licenseMax=${licenseMax} -> BadLicenseLimitsExceeded`);
    const fault = new ServiceFault({
      responseHeader: { serviceResult: StatusCodes.BadLicenseLimitsExceeded },
    });
    channel.send_response("MSG", fault, message);
    return;
  }
  return origCreateSession(message, channel);
};

await server.start();

console.log(`[timeout-poc] Server started: ${server.getEndpointUrl()}`);
console.log(`[timeout-poc] children=${children} per-node-delay=${perNodeDelay}ms max-delay=${maxDelay}ms license-max=${licenseMax}`);
console.log(`[timeout-poc] advertised MaxNodesPerRead=65536 MaxNodesPerBrowse=65536`);
console.log(`[timeout-poc] 单批 ${children} 节点 -> Read 注入约 ${delayMsFor(children)}ms，Browse 注入约 ${delayMsFor(1)}ms(按父节点数)`);
