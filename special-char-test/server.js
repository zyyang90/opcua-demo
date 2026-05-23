// server.js
// OPC UA 模拟服务器 —— 用于复现 description 中包含特殊字符导致的问题
// 飞书项目: https://project.feishu.cn/taosdata_td/defect/detail/6995142330
//
// 用法：
//   node special-char-test/server.js [--port 4840] [--path /UA/SpecialCharTest]

import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "node-opcua";

const { OPCUAServer, Variant, DataType, StatusCodes } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 解析命令行参数 ----------
const argv = process.argv.slice(2);
let port = 4840;
let resourcePath = "/UA/SpecialCharTest";

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--port": port = parseInt(argv[++i], 10); break;
    case "--path": resourcePath = argv[++i]; break;
  }
}

// ---------- 点位定义（description 包含各种特殊字符）----------
const points = [
  {
    nodeId: "beijing.chaoyang.temperature",
    browseName: "Temperature",
    description: "北京市朝阳区的气温，单位为°C",
    dataType: DataType.Double,
    initialValue: 25.6,
    range: { min: -10, max: 42 },
  },
  {
    nodeId: "factory.pressure",
    browseName: "Pressure",
    description: "管道压力，精度±0.5%，量程0~10MPa",
    dataType: DataType.Double,
    initialValue: 5.2,
    range: { min: 0, max: 10 },
  },
  {
    nodeId: "factory.flow",
    browseName: "Flow",
    description: "流量计读数，单位m³/h，最大量程100m³/h",
    dataType: DataType.Double,
    initialValue: 42.7,
    range: { min: 0, max: 100 },
  },
  {
    nodeId: "factory.angle",
    browseName: "Angle",
    description: "旋转角度0~360°，分辨率0.01°",
    dataType: DataType.Double,
    initialValue: 180.0,
    range: { min: 0, max: 360 },
  },
  {
    nodeId: "factory.resistance",
    browseName: "Resistance",
    description: "电阻值，单位Ω（欧姆），量程0~1000Ω",
    dataType: DataType.Double,
    initialValue: 470.0,
    range: { min: 0, max: 1000 },
  },
  {
    nodeId: "factory.micro_current",
    browseName: "MicroCurrent",
    description: "微电流传感器，量程0~100µA，精度≤0.1µA",
    dataType: DataType.Double,
    initialValue: 50.0,
    range: { min: 0, max: 100 },
  },
  {
    nodeId: "factory.power",
    browseName: "Power",
    description: "功率≈2.5kW（额定），电压×电流=功率",
    dataType: DataType.Double,
    initialValue: 2500.0,
    range: { min: 0, max: 5000 },
  },
];

// ---------- 启动服务器 ----------
const server = new OPCUAServer({
  port,
  resourcePath,
  buildInfo: { productName: "Special Char Test Server" },
});

await server.initialize();

const addressSpace = server.engine.addressSpace;
const namespace = addressSpace.getOwnNamespace();

// 创建根目录对象
const deviceFolder = namespace.addObject({
  organizedBy: addressSpace.rootFolder.objects,
  browseName: "SpecialCharDevices",
});

// 当前值存储（用于动态更新）
const currentValues = {};

for (const pt of points) {
  currentValues[pt.nodeId] = pt.initialValue;

  namespace.addVariable({
    componentOf: deviceFolder,
    nodeId: `s=${pt.nodeId}`,
    browseName: pt.browseName,
    description: pt.description,
    dataType: pt.dataType,
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: pt.dataType, value: currentValues[pt.nodeId] }),
    },
  });
}

// ---------- 定时更新值（模拟数据变化）----------
setInterval(() => {
  for (const pt of points) {
    const range = pt.range.max - pt.range.min;
    // 在初始值附近随机波动 ±5%
    const delta = (Math.random() - 0.5) * range * 0.1;
    let newVal = currentValues[pt.nodeId] + delta;
    newVal = Math.max(pt.range.min, Math.min(pt.range.max, newVal));
    currentValues[pt.nodeId] = Math.round(newVal * 100) / 100;
  }
}, 1000);

await server.start();

const endpointUrl = server.getEndpointUrl();
console.log(`[special-char-test] 服务器已启动: ${endpointUrl}`);
console.log(`[special-char-test] 点位数: ${points.length}`);
console.log(`[special-char-test] 包含特殊字符: °C, ±, ³, °, Ω, µ, ≤, ≈, ×`);
console.log(`\n点位列表:`);
for (const pt of points) {
  console.log(`  ns=2;s=${pt.nodeId} — ${pt.description}`);
}

process.on("SIGINT", async () => {
  console.log("\n正在关闭服务器...");
  await server.shutdown();
  process.exit(0);
});
