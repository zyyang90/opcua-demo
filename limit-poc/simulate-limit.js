// simulate-limit.js
// OPC UA 模拟服务器 —— 让点位本身携带 LIMIT（限值）信息
//
// 背景：
//   IDMP 从 OPC 构建元素树时，可以把点位携带的 LIMIT 等属性直接读出来，
//   从而 taosx 导入生成的子表自动携带 LIMIT 信息。本脚本不开发任何功能，
//   只用 node-opcua 搭一个地址空间，让每个测点同时携带：
//     1) AnalogItem 标准属性：EURange（工程量程限）、InstrumentRange（仪表量程限）、
//        EngineeringUnits（单位）、ValuePrecision（精度）；
//     2) 报警四级限值：ExclusiveLimitAlarm 的
//        HighHighLimit / HighLimit / LowLimit / LowLowLimit。
//
// 地址空间结构（贴合 IDMP 元素树，便于生成层级化子表）：
//   Objects/
//   └── Plant1
//       ├── Area_A
//       │   ├── Device_01
//       │   │   ├── Temperature (AnalogItem + 限值属性 + 报警限值)
//       │   │   ├── Pressure    (...)
//       │   │   └── ...
//       │   └── Device_02 ...
//       └── Area_B ...
//
// 用法：
//   node simulate-limit.js [--port 4840] [--path /UA/LimitServer]
//                          [--areas 2] [--devices 2] [--interval 1000] [--no-alarms]
//
// 参数：
//   --port       OPC UA 服务器端口（默认 4840）
//   --path       OPC UA 资源路径（默认 /UA/LimitServer）
//   --areas      区域数量（默认 2）
//   --devices    每个区域的设备数量（默认 2）
//   --interval   数据刷新间隔，毫秒（默认 1000）
//   --no-alarms  不挂载报警四级限值（默认挂载）

import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "node-opcua";

const {
  OPCUAServer,
  Variant,
  DataType,
  standardUnits,
} = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 1) 解析命令行参数 ----------
const argv = process.argv.slice(2);
let port = 4840;
let resourcePath = "/UA/LimitServer";
let areaCount = 2;
let devicesPerArea = 2;
let interval = 1000;
let enableLimitTags = true;

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--port": port = parseInt(argv[++i], 10); break;
    case "--path": resourcePath = argv[++i]; break;
    case "--areas": areaCount = parseInt(argv[++i], 10); break;
    case "--devices": devicesPerArea = parseInt(argv[++i], 10); break;
    case "--interval": interval = parseInt(argv[++i], 10); break;
    case "--no-limit-tags": enableLimitTags = false; break;
  }
}

// ---------- 2) 测点类型定义（每类点位携带不同的单位与限值）----------
// 这些限值都会作为测点变量的 HasProperty 子节点（Property）暴露，
// taosx 会把它们识别为 Property、不建子表，而是把 BrowseName→值 合并为
// 该动态点位子表的 Tag 写入 TDengine。
// euRange         -> EURange（AnalogItem 标准属性），工程量程（运行限）
// instrumentRange -> InstrumentRange（标准属性），仪表量程（物理限）
// limits          -> 自定义 Property：HighHighLimit/HighLimit/LowLimit/LowLowLimit
// precision       -> ValuePrecision（标准属性）
const MEASUREMENTS = [
  {
    name: "Temperature",
    unit: standardUnits.degree_celsius,
    euRange: { low: -20, high: 150 },
    instrumentRange: { low: -40, high: 200 },
    limits: { HighHighLimit: 140, HighLimit: 120, LowLimit: 0, LowLowLimit: -10 },
    precision: 0.1,
  },
  {
    name: "Pressure",
    unit: standardUnits.bar,
    euRange: { low: 0, high: 10 },
    instrumentRange: { low: 0, high: 16 },
    limits: { HighHighLimit: 9, HighLimit: 8, LowLimit: 1, LowLowLimit: 0.5 },
    precision: 0.01,
  },
  {
    name: "FlowRate",
    unit: standardUnits.cubic_metre_per_hour,
    euRange: { low: 0, high: 100 },
    instrumentRange: { low: 0, high: 120 },
    limits: { HighHighLimit: 95, HighLimit: 90, LowLimit: 5, LowLowLimit: 2 },
    precision: 0.1,
  },
  {
    name: "Level",
    unit: standardUnits.percent,
    euRange: { low: 0, high: 100 },
    instrumentRange: { low: 0, high: 100 },
    limits: { HighHighLimit: 90, HighLimit: 80, LowLimit: 20, LowLowLimit: 10 },
    precision: 0.1,
  },
  {
    name: "Current",
    unit: standardUnits.ampere,
    euRange: { low: 0, high: 50 },
    instrumentRange: { low: 0, high: 63 },
    limits: { HighHighLimit: 48, HighLimit: 45, LowLimit: 2, LowLowLimit: 1 },
    precision: 0.01,
  },
  {
    name: "Voltage",
    unit: standardUnits.volt,
    euRange: { low: 360, high: 400 },
    instrumentRange: { low: 320, high: 440 },
    limits: { HighHighLimit: 398, HighLimit: 395, LowLimit: 365, LowLowLimit: 362 },
    precision: 0.1,
  },
];

// ---------- 3) 启动 OPC UA 服务器 ----------
const server = new OPCUAServer({
  port,
  resourcePath,
  buildInfo: {
    productName: "Limit Demo OPC UA Server",
    manufacturerName: "taosx-test",
  },
  serverCapabilities: {
    maxMonitoredItems: 100000,
    maxMonitoredItemsPerSubscription: 100000,
  },
});

await server.initialize();

const addressSpace = server.engine.addressSpace;
// 注册自定义命名空间 -> 索引为 2（ns=0 标准、ns=1 为 server 自身命名空间）
// 这样所有节点的 NodeId 形如 ns=2;s=...，使用可读的字符串标识而非自动数字
const namespace = addressSpace.registerNamespace("urn:taosdata:limit-poc");
const objects = addressSpace.rootFolder.objects;

// 用全路径分层构造字符串 NodeId，保证唯一且与元素树对应
// 例：ns=2;s=Plant1.Area_A.Device_01.Current
const sid = (p) => `ns=${namespace.index};s=${p}`;

// 每个测点对应一个值生成器，使值在 EURange 内周期性波动
const generators = [];

// 工厂根节点
const PLANT = "Plant1";
const plant = namespace.addObject({
  organizedBy: objects,
  browseName: PLANT,
  nodeId: sid(PLANT),
});

let deviceSeq = 0;
let pointTotal = 0;

for (let a = 0; a < areaCount; a++) {
  const areaName = `Area_${String.fromCharCode(65 + a)}`; // Area_A, Area_B ...
  const areaPath = `${PLANT}.${areaName}`;
  const area = namespace.addObject({
    organizedBy: plant,
    browseName: areaName,
    nodeId: sid(areaPath),
  });

  for (let d = 0; d < devicesPerArea; d++) {
    deviceSeq++;
    const deviceName = `Device_${String(deviceSeq).padStart(2, "0")}`;
    const devicePath = `${areaPath}.${deviceName}`;
    const device = namespace.addObject({
      componentOf: area,
      browseName: deviceName,
      nodeId: sid(devicePath),
    });

    for (const m of MEASUREMENTS) {
      // 初始值取 EURange 中点
      const mid = (m.euRange.low + m.euRange.high) / 2;
      let currentValue = mid;

      // 3.1 动态点位（AnalogItem）：TypeDefinition=AnalogItemType，会被 taosx 识别为
      //     Dynamic Variable，单独建子表订阅时序值。
      //     同时自动生成 EURange / InstrumentRange / EngineeringUnits / ValuePrecision
      //     这四个 HasProperty 子节点 —— taosx 会把它们合并为该子表的 Tag。
      const item = namespace.addAnalogDataItem({
        componentOf: device,
        browseName: m.name,
        nodeId: sid(`${devicePath}.${m.name}`),
        dataType: "Double",
        engineeringUnits: m.unit,
        engineeringUnitsRange: m.euRange,
        instrumentRange: m.instrumentRange,
        valuePrecision: m.precision,
        minimumSamplingInterval: 1000,
        value: {
          get: () => new Variant({ dataType: DataType.Double, value: currentValue }),
        },
      });

      // 3.2 限值 LIMIT：作为测点变量的 Property（HasProperty + PropertyType）挂载。
      //     这样 taosx 分类为 Property，不建子表，而是把 BrowseName→值 作为 Tag
      //     合并进该动态点位的子表 TAGS（如 HighHighLimit/HighLimit/LowLimit/LowLowLimit）。
      if (enableLimitTags) {
        for (const [limitName, limitValue] of Object.entries(m.limits)) {
          const prop = namespace.addVariable({
            propertyOf: item,            // 自动建立 HasProperty 引用 + PropertyType 类型定义
            browseName: limitName,
            dataType: "Double",
            minimumSamplingInterval: 0,  // 静态元数据，exception-based（避免客户端监控时断言 -1）
          });
          prop.setValueFromSource({ dataType: DataType.Double, value: limitValue });
        }
      }

      // 3.3 值生成器：在 EURange 内做正弦波动，相位错开
      const amplitude = (m.euRange.high - m.euRange.low) * 0.4;
      const phase = pointTotal;
      generators.push((t) => {
        const v = mid + amplitude * Math.sin(t / 3000 + phase);
        currentValue = Math.round(v / m.precision) * m.precision;
        item.setValueFromSource({ dataType: DataType.Double, value: currentValue });
      });

      pointTotal++;
    }
  }
}

// ---------- 4) 周期性刷新点位值 ----------
setInterval(() => {
  const t = Date.now();
  for (const gen of generators) gen(t);
}, interval);

await server.start();

console.log(`[limit-poc] Server started: ${server.getEndpointUrl()}`);
console.log(`[limit-poc] Areas=${areaCount} DevicesPerArea=${devicesPerArea} Devices=${deviceSeq}`);
console.log(`[limit-poc] Measurements/device=${MEASUREMENTS.length} DynamicPoints=${pointTotal} LimitTags=${enableLimitTags ? "on" : "off"}`);
console.log(`[limit-poc] Each dynamic point exposes Properties (-> taosx Tag): EURange / InstrumentRange / EngineeringUnits / ValuePrecision` + (enableLimitTags ? " + HighHighLimit / HighLimit / LowLimit / LowLowLimit" : ""));
