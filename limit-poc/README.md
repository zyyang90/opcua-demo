# limit-poc — 让 OPC UA 点位携带 LIMIT 并被 taosx 写成 Tag

## 目标

搭一个 OPC UA Server，让每个动态点位携带 **LIMIT（限值）等元数据**。taosx 采集后，依据 OPC Dynamic Variable 分类规则，把这些 LIMIT **作为 Tag 合并进该点位的子表**写入 TDengine。本场景**不开发任何功能**，纯模拟数据。

## 设计依据：taosx 的节点分类规则

taosx（PR #3871 起）在遍历 OPC UA 地址空间时区分两类 `Variable` 节点：

| 类型                 | 判定条件                                                                                           | taosx 处理                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Dynamic Variable** | TypeDefinition 属于 ItemType 白名单（`AnalogItemType` 等）                                         | 建独立子表，订阅时序值                                                    |
| **Property**         | 父节点是 Variable **且** 引用类型是 `HasProperty`(i=46)；或 TypeDefinition 是 `PropertyType`(i=68) | **不建子表**，读一次当前值，按 `BrowseName→值` 合并为父点位子表的 **Tag** |

**关键结论**：要让 LIMIT 成为某点位的 Tag，LIMIT 必须是**该点位变量的 `HasProperty` 子节点**。

> ⚠️ 不能用 `ExclusiveLimitAlarm`：报警是 **Object** 节点，taosx 走 `opc_object` 通道，
> 其 HH/H/L/LL 限值不会合并到测点子表的 Tag。本场景因此用 Property 节点直接挂限值。

## 本服务器如何满足规则

每个测点是一个 `AnalogItemType` 动态变量（→ 子表），其下挂 8 个 `HasProperty` 子节点（→ Tag）：

| Property（BrowseName） | 来源                | 含义                    | 示例（Temperature）      |
| ---------------------- | ------------------- | ----------------------- | ------------------------ |
| `EURange`              | AnalogItem 标准属性 | 工程量程（运行高/低限） | `{"low":-20,"high":150}` |
| `InstrumentRange`      | AnalogItem 标准属性 | 仪表量程（物理高/低限） | `{"low":-40,"high":200}` |
| `EngineeringUnits`     | AnalogItem 标准属性 | 工程单位                | `°C`                     |
| `ValuePrecision`       | AnalogItem 标准属性 | 数值精度                | `0.1`                    |
| `HighHighLimit`        | 自定义 Property     | 高高限                  | `140`                    |
| `HighLimit`            | 自定义 Property     | 高限                    | `120`                    |
| `LowLimit`             | 自定义 Property     | 低限                    | `0`                      |
| `LowLowLimit`          | 自定义 Property     | 低低限                  | `-10`                    |

所有节点使用字符串 NodeId（命名空间 `ns=2`，全路径分层），例如
`ns=2;s=Plant1.Area_A.Device_01.Temperature`。

## 地址空间结构

```
Objects/
└── Plant1                                         (ns=2;s=Plant1)
    ├── Area_A                                      (ns=2;s=Plant1.Area_A)
    │   ├── Device_01                               (ns=2;s=Plant1.Area_A.Device_01)
    │   │   ├── Temperature (AnalogItem, 动态点位)  (ns=2;s=...Device_01.Temperature)
    │   │   │   ├─ EURange / InstrumentRange / EngineeringUnits / ValuePrecision   (HasProperty)
    │   │   │   └─ HighHighLimit / HighLimit / LowLimit / LowLowLimit               (HasProperty)
    │   │   ├── Pressure   (bar)
    │   │   ├── FlowRate   (m³/h)
    │   │   ├── Level      (%)
    │   │   ├── Current    (A)
    │   │   └── Voltage    (V)
    │   └── Device_02 ...
    └── Area_B ...
```

测点值在 `EURange` 内做正弦波动（相位错开）。

## 运行

```bash
npm install            # 仓库根目录安装共享依赖

npm run limit-poc      # 默认：端口 4840，2 区域 × 2 设备 × 6 测点 = 24 个动态点位

# 或直接指定参数
node limit-poc/simulate-limit.js [--port 4840] [--path /UA/LimitServer] \
                                 [--areas 2] [--devices 2] [--interval 1000] [--no-limit-tags]
```

| 参数              | 说明                                                                            | 默认            |
| ----------------- | ------------------------------------------------------------------------------- | --------------- |
| `--port`          | OPC UA 服务器端口                                                               | 4840            |
| `--path`          | 资源路径                                                                        | /UA/LimitServer |
| `--areas`         | 区域数量                                                                        | 2               |
| `--devices`       | 每区域设备数                                                                    | 2               |
| `--interval`      | 数据刷新间隔（ms）                                                              | 1000            |
| `--no-limit-tags` | 不挂载 HighHighLimit/HighLimit/LowLimit/LowLowLimit（EURange 等标准属性仍保留） | （默认挂载）    |

Endpoint：`opc.tcp://<host>:<port><path>`，如 `opc.tcp://localhost:4840/UA/LimitServer`。

## taosx 采集后预期的 TDengine 表结构

以 `Temperature` 为例（动态点位 → 1 张子表，8 个 LIMIT → 8 个 Tag）：

```
超级表 opc_xxx (
    ts        TIMESTAMP,
    val       DOUBLE,
    quality   INT
) TAGS (
    ...,                          -- 用户 custom_tags
    EURange          VARCHAR(1024),
    InstrumentRange  VARCHAR(1024),
    EngineeringUnits VARCHAR(1024),
    ValuePrecision   VARCHAR(1024),
    HighHighLimit    VARCHAR(1024),
    HighLimit        VARCHAR(1024),
    LowLimit         VARCHAR(1024),
    LowLowLimit      VARCHAR(1024)
)
  └── 子表 (Temperature)
        TAGS('{"low":-20,"high":150}', '{"low":-40,"high":200}', 'degree Celsius',
             '0.1', '140', '120', '0', '-10')
```

> Tag 列为所有动态点位 Property 名的并集（union），缺值的点位对应 Tag 填空串。
> Property 值由 taosx 序列化为字符串：数值→`"140"`，Range 结构体→JSON，LocalizedText→取文本。

## 验证（不依赖 taosx）

用任意 OPC UA 客户端（UaExpert / taosx 浏览）连到 endpoint，浏览到
`Plant1 → Area_A → Device_01 → Temperature`，确认：

1. `Temperature` 的 NodeClass = Variable、TypeDefinition = AnalogItemType；
2. 其下 8 个子节点的引用类型均为 `HasProperty`(i=46)，值如上表。

满足这两点即说明 taosx 会把这 8 个 LIMIT 写成该子表的 Tag。
