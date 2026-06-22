# ae-explore — OPC UA 事件（Event/Alarm）仿真服务器

一个最小化的 [node-opcua](https://github.com/node-opcua/node-opcua) 仿真服务器，用于演示和验证 OPC UA **事件（Event）**与**告警（Alarm）**机制。服务器同时产生两类事件：

1. **ExclusiveLevelAlarm**：绑定到一个周期性变化的液位变量，当液位穿越高/低阈值时自动触发。
2. **自定义普通 Event**：每 5 秒模拟一次“门被打开”，携带自定义字段 `UserName`。

## 文件

| 文件 | 说明 |
|------|------|
| `server.js` | 仿真服务器：构建地址空间、液位变量、告警和自定义事件 |
| `client.js` | 验证客户端：用 `EventFilter` 订阅 `Server` 节点的事件通知 |

> 依赖统一在仓库根 `package.json`，本目录无独立 `package.json`。先在仓库根执行 `npm install`。

## 快速开始

```bash
# 仓库根目录
npm install

# 启动仿真服务器（端口 4840）
npm run ae-server
# 等价于：node ae-explore/server.js

# 另开一个终端，运行验证客户端
npm run ae-client
# 等价于：node ae-explore/client.js
```

默认 Endpoint：`opc.tcp://localhost:4840/UA/AeServer`

## 地址空间结构

```
Objects/
├── Server                         (OPC UA 标准 Server 对象，作为事件源)
└── Tank                           (ns=2;s=...Tank, Object, eventSourceOf: Server)
    ├── Level                      (AnalogItemType, Double, 0~100)
    │   └── EURange                (AnalogItem 标准属性)
    └── LevelAlarm                 (ExclusiveLevelAlarmType, Object)
        ├── HighHighLimit = 90
        ├── HighLimit     = 70
        ├── LowLimit      = 30
        └── LowLowLimit   = 10

EventTypes/
└── DoorOpenedEventType            (继承 BaseEventType)
    └── UserName                   (自定义 String 属性)
```

## 事件源说明

| 事件 | 触发条件 | 事件类型 | 来源节点 | 说明 |
|------|----------|----------|----------|------|
| 液位告警 | `Level` 穿越阈值 | `ExclusiveLevelAlarmType` | `Tank` | node-opcua 自动驱动状态机，状态变化时产生事件 |
| 开门事件 | 每 5 秒触发一次 | `DoorOpenedEventType` | `Server` | 普通瞬时事件，自定义 `UserName` 字段 |

液位按 `level = round(50 + 50 * sin(t / 3000))` 每秒更新，会在约 0~100 之间周期性变化，因此会交替触发高/低/高高/低低告警。

## 客户端验证

`client.js` 使用 OPC UA 事件订阅标准流程：

1. 以 `SecurityMode.None` 连接服务器；
2. 创建 `ClientSubscription`；
3. 用 `constructEventFilter` 指定要返回的字段：`EventId`、`EventType`、`SourceName`、`Time`、`Severity`、`Message`；
4. 监控 `Server` 节点的 `EventNotifier` 属性，等待事件通知。

运行客户端后会打印类似：

```
Connected to opc.tcp://localhost:4840/UA/AeServer
Subscribed to events on Server. Press Ctrl+C to exit.
[07:59:08] severity=500 type=ns=0;i=9347 source=Tank msg="Level has exceeded high limit!"
[07:59:10] severity=100 type=ns=2;i=1002 source=FrontDoor msg="Door opened by alice"
```

> `ns=0;i=9347` 即 `ExclusiveLevelAlarmType` 的 NodeId。

## 备注

- **ES Modules**：使用 `import` / `export`，node-opcua 为 CJS，代码中通过 `import pkg from "node-opcua"` 后解构使用。
- 进程支持 `Ctrl+C`（SIGINT）优雅关闭。
- 服务器默认无安全策略，仅用于本地测试验证。
