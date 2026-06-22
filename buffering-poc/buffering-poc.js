// simulate-buffering-test.js
// OPC UA 模拟服务器 —— 用于验证 taosx-agent persist_queue 断链缓存能力
//
// 功能：
//   - 每秒生成带时间戳的递增计数器数据（多个点位）
//   - 同时将所有生成的数据记录到本地 CSV 文件，作为数据完整性校验的基准
//
// 用法：
//   node simulate-buffering-test.js [--port 4840] [--points 10] [--interval 1000] [--log-dir ./logs]
//                                   [--csv-start-file /path/to/signal] [--stop-after 60]
//
// 参数：
//   --port            OPC UA 服务器端口（默认 4840）
//   --points          模拟点位数量（默认 10000）
//   --interval        数据更新间隔，毫秒（默认 1000）
//   --log-dir         数据日志目录（默认 ./logs）
//   --path            OPC UA 资源路径（默认 /UA/BufferingTest）
//   --csv-start-file  只有当该文件存在时才开始 CSV 记录（用于精确对齐 pipeline 就绪时刻）
//   --stop-after      CSV 开始后生成 N 秒数据即停止更新（服务器保持运行，等待管道排空）

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "node-opcua";

const { OPCUAServer, Variant, DataType, DataValue, StatusCodes } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 解析命令行参数 ----------
const argv = process.argv.slice(2);
let port = 4840;
let pointCount = 1000;
let interval = 1000;
let logDir = path.join(__dirname, "logs");
let resourcePath = "/UA/BufferingTest";

let csvStartFile = "";  // 当设置时，只有该文件存在才开始记录 CSV
let stopAfter = 0;     // 当 >0 时，生成 N 秒数据后停止更新（服务器保持运行）

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--port": port = parseInt(argv[++i], 10); break;
    case "--points": pointCount = parseInt(argv[++i], 10); break;
    case "--interval": interval = parseInt(argv[++i], 10); break;
    case "--log-dir": logDir = argv[++i]; break;
    case "--path": resourcePath = argv[++i]; break;
    case "--csv-start-file": csvStartFile = argv[++i]; break;
    case "--stop-after": stopAfter = parseInt(argv[++i], 10); break;
  }
}

// ---------- 准备日志目录和文件 ----------
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const startTime = new Date();
const logFileName = `buffering-test-${startTime.toISOString().replace(/[:.]/g, "-")}.csv`;
const logFilePath = path.join(logDir, logFileName);

// CSV 表头 —— 只有当 csv-start-file 模式下，延迟创建
let csvReady = !csvStartFile; // 无 csv-start-file 参数时立即开始
if (csvReady) {
  const header = ["timestamp", "seq", ...Array.from({ length: pointCount }, (_, i) => `point_${i}`)].join(",");
  writeFileSync(logFilePath, header + "\n");
}
console.log(`[log] Data log: ${logFilePath}${csvStartFile ? " (waiting for start signal)" : ""}`);
if (csvStartFile) console.log(`[log] CSV will start when file exists: ${csvStartFile}`);
if (stopAfter > 0) console.log(`[log] Will stop generating after ${stopAfter} seconds`);

// ---------- 数据状态 ----------
let globalSeq = 0;
const pointValues = new Float64Array(pointCount);
const pointTimestamps = new Array(pointCount).fill(new Date());

// ---------- 启动 OPC UA 服务器 ----------
const server = new OPCUAServer({
  port,
  resourcePath,
  maxAllowedSessionNumber: 100,
  buildInfo: {
    productName: "Buffering Test OPC UA Server",
    manufacturerName: "taosx-test",
  },
  serverCapabilities: {
    maxMonitoredItems: 100000,
    maxMonitoredItemsPerSubscription: 100000,
    maxSessions: 100,
  },
});

await server.initialize();
const addressSpace = server.engine.addressSpace;
const ns = addressSpace.registerNamespace("urn:taosx:buffering-test");
const objects = addressSpace.rootFolder.objects;

// 创建容器对象
const container = ns.addObject({
  organizedBy: objects,
  browseName: "BufferingTest",
});

// 创建序列号变量
const seqVar = ns.addVariable({
  componentOf: container,
  nodeId: `ns=2;s=seq`,
  browseName: "seq",
  dataType: "Int64",
  minimumSamplingInterval: 1000,
  value: {
    get: () => new Variant({ dataType: DataType.Int64, value: globalSeq }),
  },
});

// 创建点位变量
const pointVars = [];
for (let i = 0; i < pointCount; i++) {
  const idx = i;
  const v = ns.addVariable({
    componentOf: container,
    nodeId: `ns=2;s=point_${i}`,
    browseName: `point_${i}`,
    dataType: "Double",
    minimumSamplingInterval: 1000,
    value: {
      timestamped_get: () => new DataValue({
        value: new Variant({ dataType: DataType.Double, value: pointValues[idx] }),
        sourceTimestamp: pointTimestamps[idx],
        sourcePicoseconds: 0,
      }),
    },
  });
  pointVars.push(v);
}

// ---------- 定时更新数据 ----------
let csvLogging = csvReady;
let csvSeqStart = 0;      // CSV 开始记录时的 globalSeq
let generateStopped = false;

function updateAndLog() {
  // 如果设置了 stop-after 且已达到限制，停止更新（但服务器保持运行）
  if (stopAfter > 0 && csvLogging && (globalSeq - csvSeqStart) > stopAfter) {
    if (!generateStopped) {
      generateStopped = true;
      console.log(`[stop] Reached ${stopAfter} updates since CSV start. Stopping data generation (server stays alive).`);
      clearInterval(timer);
    }
    return;
  }

  globalSeq++;
  const now = new Date();
  const ts = now.toISOString();

  // 更新所有点位：使用正弦波 + 噪声，确保数据有变化
  for (let i = 0; i < pointCount; i++) {
    const t = Date.now() / 1000;
    pointValues[i] = Math.round(
      (50 + 30 * Math.sin(t / 10 + i * 0.7) + 5 * Math.random()) * 1000
    ) / 1000;
    pointTimestamps[i] = now;

    // 通知 OPC UA 客户端值已变化
    pointVars[i].setValueFromSource({
      dataType: DataType.Double,
      value: pointValues[i],
    }, StatusCodes.Good, now);
  }

  // 更新序列号
  seqVar.setValueFromSource({
    dataType: DataType.Int64,
    value: globalSeq,
  }, StatusCodes.Good, now);

  // CSV 记录：检查是否应该开始记录
  if (!csvLogging && csvStartFile && existsSync(csvStartFile)) {
    csvLogging = true;
    csvSeqStart = globalSeq;
    const header = ["timestamp", "seq", ...Array.from({ length: pointCount }, (_, i) => `point_${i}`)].join(",");
    writeFileSync(logFilePath, header + "\n");
    console.log(`[csv] Start signal detected. Begin CSV logging at seq=${globalSeq}`);
  }

  // 写入 CSV 日志
  if (csvLogging) {
    const row = [ts, globalSeq, ...Array.from(pointValues)].join(",");
    appendFileSync(logFilePath, row + "\n");
  }

  // 每 60 秒打印一次状态
  if (globalSeq % 60 === 0) {
    console.log(`[data] seq=${globalSeq} ts=${ts} point_0=${pointValues[0].toFixed(3)}${csvLogging ? "" : " (CSV not started)"}`);
  }
}

const timer = setInterval(updateAndLog, interval);

// ---------- 启动服务器 ----------
await server.start();
const url = server.getEndpointUrl();
console.log(`\n========================================`);
console.log(`  Buffering Test OPC UA Server`);
console.log(`========================================`);
console.log(`  Endpoint : ${url}`);
console.log(`  Points   : ${pointCount}`);
console.log(`  Interval : ${interval}ms`);
console.log(`  Log file : ${logFilePath}`);
console.log(`  Node IDs : ns=2;s=seq, ns=2;s=point_0 ~ ns=2;s=point_${pointCount - 1}`);
console.log(`========================================\n`);

// ---------- 优雅退出 ----------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);

  // 移除 CSV 最后一行数据 —— 最后一次 updateAndLog 写入了 CSV 但 OPC UA
  // 通知可能尚未传播到 taosx pipeline，保留它会导致验证时产生 1s 的假缺失
  if (csvLogging) {
    const content = readFileSync(logFilePath, "utf-8").trimEnd().split("\n");
    if (content.length > 1) {
      content.pop();
      writeFileSync(logFilePath, content.join("\n") + "\n");
      globalSeq--;
    }
  }

  console.log(`\n[shutdown] Stopping... (total seq=${globalSeq})`);
  await server.shutdown(1000);
  console.log(`[shutdown] Server stopped. Log saved to ${logFilePath}`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
