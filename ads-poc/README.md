# ads-poc — GE Cimplicity (CSS) OPC UA 仿真服务器

基于一份 **taosX OPC UA 采集 TOML 配置**，用 [node-opcua](https://github.com/node-opcua/node-opcua) 还原一个与真实 **GE CSS OPC UA Server** 等价的仿真服务器，用于 PoC 联调（OPC UA 仿真器 → taosx-agent → taosx → TDengine）。

服务器会从 TOML 中的 `collect.ua.nodes` 列表派生整个地址空间（数千个节点），并按周期刷新动态测量值，供采集端订阅 / 读取。

## 文件

| 文件 | 说明 |
|------|------|
| `simulate-ge-css.js` | 主程序：解析 TOML，构建地址空间并启动 OPC UA Server |
| `quick-client.js`    | 验证客户端：连接服务器、读取若干探针节点并订阅一个动态值 |

> 依赖统一在仓库根 `package.json`，本目录无独立 `package.json`。先在仓库根执行 `npm install`。

## 快速开始

```bash
# 仓库根目录
npm install

# 启动仿真服务器（默认读取 ads-poc/1.toml）
npm run ads-poc
# 等价于：node ads-poc/simulate-ge-css.js

# 另开一个终端，运行验证客户端
node ads-poc/quick-client.js
```

## 用法

```bash
node ads-poc/simulate-ge-css.js [path/to/config.toml] [--port 64121] [--path //GeCssOpcUaServer] [--alarms]
```

参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `[config.toml]` | taosX 采集配置文件路径（位置参数） | 同目录下 `1.toml` |
| `--port <n>`    | 监听端口 | `64121` |
| `--path <p>`    | OPC UA resourcePath | `//GeCssOpcUaServer` |
| `--alarms`      | 启用告警实例（见下文「告警」说明） | 关闭 |

**端口 / 路径优先级**：CLI 参数 > TOML 中 `connect.ua.endpoint` 解析 > 默认值。
例如 `endpoint = "opc.tcp://192.168.201.205:64121//GeCssOpcUaServer"` 会被自动解析出 `port=64121`、`resourcePath=//GeCssOpcUaServer`。

> TOML 解析具备容错能力：当文件末尾被截断或拼接了残片时，会逐行裁剪末尾后重试，最多 50 次。

## 工作原理

### 1. 节点分类

从 `collect.ua.nodes` 读取所有 `ns=2;s=<symbol>` 节点，按 symbol 后缀分为三类：

- **dynamic（动态测量值）**：普通测量点，建成可读 `Variable`。
- **static（静态元数据）**：后缀属于 `EURange` / `EngineeringUnits` / `ValuePrecision` / `Measurement_Unit_ID` / `EnumValues` / `ValueAsText` / `SecondLanguageDescription`，作为属性附在父变量上。
- **alarm（告警实例）**：symbol 含 `_OpcuaAlarm` 后缀，取前缀作为告警实例 base，子字段由 node-opcua 自动展开。

### 2. 地址空间构建

- 为所有取值路径及其祖先路径建节点；祖先若自身无值则建成 `Object`，否则建成 `Variable`。
- 顶层节点挂在 `Objects` 下（`organizedBy`），其余按点号层级用 `componentOf` 嵌套。
- 数据类型推断：以 `Is` / `HardwareAlarm` / `LINK_OK` / `L3DIAG` / `ATTN` / `ALM_PRESENT` / `ACK_PB` / `AVR_` / `HORN_` 开头的为 `Boolean`，其余为 `Double`。

### 3. 动态刷新

所有动态值共用一个 `Float64Array`，每秒按 `50 + 40*sin(t/7 + i*0.0017)` 更新；每个变量用 lazy getter 读取对应槽位（Boolean 取 `>= 0.5`）。

## 告警

默认**关闭**告警。原因：node-opcua 的 `instantiateExclusiveLimitAlarm` 不接受字符串 NodeId（构建 38 个子字段时会断言失败）。

加 `--alarms` 启用后，告警实例会获得**自动分配的数字 NodeId**（形如 `ns=2;i=NNNN`），与 TOML 中 `ns=2;s=...OpcuaAlarm.<field>` 的字符串 NodeId **不一致**——客户端无法按原 NodeId 订阅，但仍可通过订阅 `Server` 节点的事件（EventFilter）拿到告警事件流。

启用后会创建一个共享激励源 `__sim__.AlarmInput`（每秒 `50 + 50*sin(t/6)`），驱动所有告警实例的高高/高/低/低低限触发。

## 验证

```bash
node ads-poc/quick-client.js [opc.tcp://127.0.0.1:64121//GeCssOpcUaServer]
```

客户端会：
1. 以 `SecurityMode.None` 连接服务器；
2. 读取若干探针节点（布尔位、温度变量、静态 `EURange` 等）；
3. 订阅 `ns=2;s=CRM1_SVR.TempVariable0044`，打印 3 次变更后退出。

## 备注

- **ES Modules**：使用 `import` / `export`，node-opcua 为 CJS，需 `import pkg from "node-opcua"` 后解构。
- 进程支持 `Ctrl+C`（SIGINT）优雅关闭。
- 启动日志会打印各类节点统计：`dynamic` / `static` / `alarm_instances` / `unrecognized`。
