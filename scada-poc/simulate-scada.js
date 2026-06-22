// simulate-scada.js
// 基于一份 taosX OPCUA 采集 toml 配置（如 1.toml），
// 用 node-opcua 还原一个与第三方 SCADA OPC UA Server 等价的仿真服务器。
//
// 用法：
//   node simulate-scada.js [path/to/1.toml] [--port 64121] [--path //ScadaOpcUaServer]
//
// 默认读取同目录下 1.toml；端口/路径优先级：CLI > toml 中 endpoint 解析 > 默认 64121 + //ScadaOpcUaServer

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import pkg from "node-opcua";

const {
  OPCUAServer,
  Variant,
  DataType,
  StatusCodes,
  LocalizedText,
  standardUnits,
  AccessLevelFlag,
} = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 1) 解析参数 ----------
const argv = process.argv.slice(2);
let cfgPath = path.join(__dirname, "1.toml");
let cliPort, cliResourcePath;
let enableAlarms = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") cliPort = parseInt(argv[++i], 10);
  else if (a === "--path") cliResourcePath = argv[++i];
  else if (a === "--alarms") enableAlarms = true;
  else if (!a.startsWith("--")) cfgPath = a;
}
if (!existsSync(cfgPath)) {
  console.error(`[fatal] toml not found: ${cfgPath}`);
  process.exit(1);
}
function loadTomlTolerant(p) {
  let text = readFileSync(p, "utf8");
  try {
    return TOML.parse(text);
  } catch (e) {
    // 末尾损坏（如截断/拼接残片）：丢弃最后一段，重试若干次
    for (let i = 0; i < 50; i++) {
      const idx = text.lastIndexOf("\n");
      if (idx < 0) break;
      text = text.slice(0, idx);
      try {
        const parsed = TOML.parse(text);
        console.warn(
          `[warn] toml tail truncated by ${i + 1} line(s) due to: ${e.message}`,
        );
        return parsed;
      } catch {
        /* keep trimming */
      }
    }
    throw e;
  }
}
const cfg = loadTomlTolerant(cfgPath);
const nodes = cfg?.collect?.ua?.nodes ?? [];
console.log(`[load] ${nodes.length} nodes from ${cfgPath}`);

// 从 endpoint 解析端口和 resourcePath（如 opc.tcp://<server-ip>:64121//ScadaOpcUaServer）
let port = 64121;
let resourcePath = "//ScadaOpcUaServer";
const ep = cfg?.connect?.ua?.endpoint;
if (ep) {
  const m = /^opc\.tcp:\/\/[^:/]+(?::(\d+))?(\/[^\s]*)?$/.exec(ep);
  if (m) {
    if (m[1]) port = parseInt(m[1], 10);
    if (m[2]) resourcePath = m[2];
  }
}
if (cliPort) port = cliPort;
if (cliResourcePath) resourcePath = cliResourcePath;

// ---------- 2) 节点分类 ----------
// 静态元数据后缀（这些都附在父变量上，不单独建 dynamic 监控点）
const STATIC_SUFFIX = new Set([
  "EURange",
  "EngineeringUnits",
  "ValuePrecision",
  "Measurement_Unit_ID",
  "EnumValues",
  "ValueAsText",
  "SecondLanguageDescription",
]);

// Alarm 子字段：识别到 _OpcuaAlarm 后缀仅取前缀作为 alarm 实例 base，再后跟点的全跳过
function classify(idStr) {
  const m = /^ns=2;s=(.+)$/.exec(idStr);
  if (!m) return null;
  const sym = m[1];

  const alarmIdx = sym.indexOf("_OpcuaAlarm");
  if (alarmIdx >= 0) {
    const base = sym.slice(0, alarmIdx + "_OpcuaAlarm".length);
    // 不论是 base 自身还是 base.<subfield>，都登记 base 一次；subfield 由 node-opcua 自动展开
    return { kind: "alarm", path: sym, base };
  }

  const last = sym.split(".").pop();
  if (STATIC_SUFFIX.has(last)) {
    const parent = sym.slice(0, sym.length - last.length - 1);
    return { kind: "static", path: sym, parent, suffix: last };
  }

  return { kind: "dynamic", path: sym };
}

const buckets = { dynamic: [], static: [], alarm: new Set(), other: 0 };
for (const n of nodes) {
  const c = classify(n.id);
  if (!c) {
    buckets.other++;
    continue;
  }
  if (c.kind === "dynamic") buckets.dynamic.push(c.path);
  else if (c.kind === "static") buckets.static.push(c);
  else if (c.kind === "alarm") buckets.alarm.add(c.base);
}
console.log(
  `[classify] dynamic=${buckets.dynamic.length}  static=${buckets.static.length}` +
    `  alarm_instances=${buckets.alarm.size}  unrecognized=${buckets.other}`,
);

// ---------- 3) 启动 server ----------
const server = new OPCUAServer({
  port,
  resourcePath,
  buildInfo: {
    productName: "ScadaOpcUaServer (sim)",
    manufacturerName: "node-opcua simulator",
  },
  serverCapabilities: {
    maxMonitoredItems: 100000,
    maxMonitoredItemsPerSubscription: 100000,
  },
});
await server.initialize();
const addressSpace = server.engine.addressSpace;
const ns = addressSpace.registerNamespace("urn:scada:simulator"); // -> ns=2
const objects = addressSpace.rootFolder.objects;
const serverObject = objects.server;

// ---------- 4) 预扫描：决定每个路径建成 Object 还是 Variable ----------
// - valuePaths   : 自身有值（dynamic 列表里的 + 任何静态属性的父）
// - alarmPaths   : alarm 实例基名
// - allPaths     : 上述 + 所有它们的祖先路径（祖先若不在 valuePaths/alarmPaths 中则为 Object）
const valuePaths = new Set(buckets.dynamic);
for (const s of buckets.static) valuePaths.add(s.parent);
const alarmPaths = new Set(buckets.alarm);

const allPaths = new Set();
function addWithAncestors(p) {
  if (!p) return;
  if (allPaths.has(p)) return;
  allPaths.add(p);
  const dot = p.lastIndexOf(".");
  if (dot > 0) addWithAncestors(p.slice(0, dot));
}
for (const p of valuePaths) addWithAncestors(p);
for (const p of alarmPaths) addWithAncestors(p);

// 路径 -> 节点 缓存（同时被 Variable 和 Object 共用）
const nodeByPath = new Map(); // sym path -> any Node (Object 或 Variable)
const variableByPath = new Map();

function parentOf(symPath) {
  const dot = symPath.lastIndexOf(".");
  if (dot < 0)
    return { parentPath: "", parentNode: objects, browseName: symPath };
  const parentPath = symPath.slice(0, dot);
  const browseName = symPath.slice(dot + 1);
  let parentNode = nodeByPath.get(parentPath);
  if (!parentNode) parentNode = ensureObject(parentPath);
  return { parentPath, parentNode, browseName };
}

function attachOpts(parentNode) {
  // 顶层挂在 objects 下用 organizedBy；其余用 componentOf
  return parentNode === objects
    ? { organizedBy: objects }
    : { componentOf: parentNode };
}

function ensureObject(symPath) {
  const cached = nodeByPath.get(symPath);
  if (cached) return cached;
  const { parentNode, browseName } = parentOf(symPath);
  const node = ns.addObject({
    ...attachOpts(parentNode),
    nodeId: `ns=2;s=${symPath}`,
    browseName,
    eventNotifier: 1,
    eventSourceOf: serverObject,
  });
  nodeByPath.set(symPath, node);
  return node;
}

// ---------- 5) 动态测量值 ----------
// 所有动态值统一走一个 Float64Array + 周期更新；每个 Variable 用 lazy getter 读对应槽位。
const dynPaths = [...valuePaths].sort(
  (a, b) => a.split(".").length - b.split(".").length,
);
const dynState = new Float64Array(dynPaths.length);
const idxByPath = new Map(dynPaths.map((p, i) => [p, i]));

function inferDataType(symPath) {
  const last = symPath.split(".").pop();
  if (
    /^(Is|HardwareAlarm|LINK_OK|L3DIAG|ATTN|ALM_PRESENT|ACK_PB|AVR_|HORN_)/.test(
      last,
    )
  )
    return "Boolean";
  return "Double";
}

console.log(`[build] creating ${dynPaths.length} value variables ...`);
const t0 = Date.now();
for (let i = 0; i < dynPaths.length; i++) {
  const sym = dynPaths[i];
  const { parentNode, browseName } = parentOf(sym);
  const dt = inferDataType(sym);
  const v = ns.addVariable({
    ...attachOpts(parentNode),
    nodeId: `ns=2;s=${sym}`,
    browseName,
    dataType: dt,
    accessLevel: "CurrentRead",
    userAccessLevel: "CurrentRead",
    minimumSamplingInterval: 1000,
    value: {
      get: () =>
        dt === "Boolean"
          ? new Variant({
              dataType: DataType.Boolean,
              value: dynState[i] >= 0.5,
            })
          : new Variant({ dataType: DataType.Double, value: dynState[i] }),
    },
  });
  nodeByPath.set(sym, v);
  variableByPath.set(sym, v);
  if ((i + 1) % 2000 === 0) console.log(`  .. ${i + 1}/${dynPaths.length}`);
}
console.log(`[build] value vars done in ${Date.now() - t0}ms`);

// 周期刷新动态值
setInterval(() => {
  const t = Date.now() / 1000;
  for (let i = 0; i < dynState.length; i++) {
    dynState[i] = 50 + 40 * Math.sin(t / 7 + i * 0.0017);
  }
}, 1000);

// ---------- 6) 静态元数据 ----------
console.log(
  `[build] attaching ${buckets.static.length} static metadata properties ...`,
);
let staticAttached = 0;
for (const item of buckets.static) {
  try {
    const parentVar = variableByPath.get(item.parent);
    if (!parentVar) continue; // 理论上不会发生，因为已加入 valuePaths
    let dataType = "String";
    let value;
    switch (item.suffix) {
      case "EURange":
        dataType = "Range";
        value = new Variant({
          dataType: DataType.ExtensionObject,
          value: addressSpace.constructExtensionObject(
            addressSpace.findDataType("Range"),
            { low: 0, high: 100 },
          ),
        });
        break;
      case "EngineeringUnits":
        dataType = "EUInformation";
        value = new Variant({
          dataType: DataType.ExtensionObject,
          value: standardUnits.degree_celsius,
        });
        break;
      case "ValuePrecision":
        dataType = "Double";
        value = new Variant({ dataType: DataType.Double, value: 0.01 });
        break;
      case "Measurement_Unit_ID":
        dataType = "Int32";
        value = new Variant({ dataType: DataType.Int32, value: 0 });
        break;
      case "EnumValues":
        // EnumValues 是 EnumValueType[]，给一个最小合法数组
        dataType = "EnumValueType";
        value = new Variant({
          dataType: DataType.ExtensionObject,
          arrayType: pkg.VariantArrayType.Array,
          value: [
            addressSpace.constructExtensionObject(
              addressSpace.findDataType("EnumValueType"),
              {
                value: [0, 0],
                displayName: new LocalizedText({ text: "Default" }),
                description: new LocalizedText({ text: "" }),
              },
            ),
          ],
        });
        break;
      case "ValueAsText":
        dataType = "LocalizedText";
        value = new Variant({
          dataType: DataType.LocalizedText,
          value: new LocalizedText({ text: "" }),
        });
        break;
      case "SecondLanguageDescription":
      default:
        dataType = "String";
        value = new Variant({ dataType: DataType.String, value: item.parent });
        break;
    }
    ns.addVariable({
      propertyOf: parentVar,
      nodeId: `ns=2;s=${item.path}`,
      browseName: item.suffix,
      dataType,
      accessLevel: "CurrentRead",
      value,
    });
    staticAttached++;
  } catch (e) {
    if (staticAttached < 5)
      console.warn(`[warn] static ${item.path}: ${e.message}`);
  }
}
console.log(
  `[build] static props attached: ${staticAttached}/${buckets.static.length}`,
);

// ---------- 7) 告警实例 ----------
// 注：node-opcua 的 instantiateExclusiveLimitAlarm 不接受字符串 NodeId
// （会在内部 assert 失败，因为它要为 38 个子字段批量派生 NodeId）。
// 因此告警默认关闭；加 --alarms 启用时，告警会获得自动分配的数字 NodeId
// （形如 ns=2;i=NNNN），这与用户 toml 里的 ns=2;s=...OpcuaAlarm.<field>
// 字符串 NodeId 不一致——客户端无法按原 NodeId 订阅，但可以通过 EventFilter
// 订阅 Server 节点的事件，仍能拿到告警事件流。
let alarmCreated = 0;
if (enableAlarms) {
  console.log(
    `[build] instantiating ${buckets.alarm.size} alarm instances (numeric NodeIds) ...`,
  );
  let alarmInputVal = 50;
  const alarmInputVar = ns.addAnalogDataItem({
    organizedBy: objects,
    nodeId: "ns=2;s=__sim__.AlarmInput",
    browseName: "__sim_alarm_input",
    engineeringUnitsRange: { low: 0, high: 100 },
    engineeringUnits: standardUnits.degree_celsius,
    dataType: "Double",
    value: {
      get: () =>
        new Variant({ dataType: DataType.Double, value: alarmInputVal }),
    },
  });

  for (const base of buckets.alarm) {
    try {
      const { parentNode, browseName } = parentOf(base);
      ns.instantiateExclusiveLimitAlarm("ExclusiveLimitAlarmType", {
        ...attachOpts(parentNode),
        browseName,
        conditionSource: parentNode === objects ? serverObject : parentNode,
        inputNode: alarmInputVar,
        highHighLimit: 90,
        highLimit: 70,
        lowLimit: 30,
        lowLowLimit: 10,
        severity: 500,
        optionals: [
          "ConfirmedState",
          "Confirm",
          "SuppressedState",
          "ShelvingState",
        ],
      });
      alarmCreated++;
      if (alarmCreated % 100 === 0)
        console.log(`  .. ${alarmCreated}/${buckets.alarm.size}`);
    } catch (e) {
      if (alarmCreated < 3)
        console.warn(`[warn] alarm ${base}: ${e?.stack || e?.message || e}`);
    }
  }
  console.log(`[build] alarms created: ${alarmCreated}/${buckets.alarm.size}`);

  setInterval(() => {
    const t = Date.now() / 1000;
    alarmInputVal = 50 + 50 * Math.sin(t / 6);
    alarmInputVar.setValueFromSource({
      dataType: DataType.Double,
      value: alarmInputVal,
    });
  }, 1000);
} else {
  console.log(
    `[skip] ${buckets.alarm.size} alarm instances skipped (use --alarms to enable, will get numeric NodeIds)`,
  );
}

// ---------- 8) 启动 ----------
await server.start();
const url = server.getEndpointUrl();
console.log(`[ready] OPC UA server listening at ${url}`);
console.log(`        port=${port}  resourcePath=${resourcePath}`);
console.log(
  `        nodes: dynamic=${dynPaths.length} static=${staticAttached} alarms=${alarmCreated}`,
);

process.on("SIGINT", async () => {
  console.log("\n[shutdown] stopping ...");
  await server.shutdown(500);
  process.exit(0);
});
