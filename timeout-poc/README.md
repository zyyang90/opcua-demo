# timeout-poc — 复现 taosx-opc 在 iFIX OPC UA Server 上的两个报错

## 目标

现场使用 iFIX 的 OPC UA Server 时,`taosx-opc points -c a.toml` 命令出现两个报错(时而其一、时而其二):

| 报错 | 状态码 | 现象 |
| ---- | ------ | ---- |
| **① License 上限** | `StatusBadLicenseLimitsExceeded (0x810F0000)` | Connect 阶段被拒:`error in Client Connection: The server has limits on number of allowed operations / objects ...` |
| **② 请求超时** | `StatusBadTimeout (0x800A0000)` | `get points properties error` / `browse error` 超时 |

本工程用 node-opcua 搭一个**能稳定复现这两个报错**的模拟服务器,并用于验证修复。**不开发任何功能,纯模拟。**

## 根因与复现原理

### 报错②(超时)—— 真正的根因

taosx 在 `getServerLimit` 中读取服务器上报的 `MaxNodesPerRead`(`i=11705`)与 `MaxNodesPerBrowse`(`i=11710`),并**直接信任该值**作为单次请求的分批大小,没有任何上限封顶:

```
maxNodePerGetPoints = maxNodesPerRead / len(attributes)
```

iFIX 上报的是虚高的 **65536**,于是 taosx 会把上万个节点塞进**一次** Read/Browse 请求。iFIX 这种较慢的 server 无法在 `request_timeout` 内完成这么大的单批请求 → 返回 `StatusBadTimeout`。

本服务器据此复现:
1. 在 OperationLimits 上报 `maxNodesPerRead = 65536`、`maxNodesPerBrowse = 65536`;
2. 在 Read/Browse 处理上注入**与请求规模成正比**的延迟(模拟慢 server),使巨量单批请求超过客户端 `request_timeout`。
   修复后 taosx 给上报值封顶(批次变小),同样的延迟下不再超时。

### 报错①(License 上限)—— 下游症状

iFIX 的 license 限制了**并发会话数**。当 taosx 因报错②反复重跑、上一次的会话尚未被 server 回收时,会话数撞到 license 上限,新的 Connect 直接被拒。

本服务器用 `--license-max` 限制会话数,超限时在 `CreateSession` 阶段直接返回 `BadLicenseLimitsExceeded`(状态码与 iFIX 完全一致)。

## 实现要点

- 通过 node-opcua 的 `serverCapabilities.operationLimits` 上报 `maxNodesPerRead/Browse = 65536`;
- monkey-patch `_on_ReadRequest` / `_on_BrowseRequest` 注入延迟(`delay = min(节点数 × per-node-delay, max-delay)`);
- monkey-patch `_on_CreateSessionRequest`,会话数 `>= license-max` 时返回 `ServiceFault{ BadLicenseLimitsExceeded }`;
- `buildInfo.productName` 故意**不叫** `KEPServerEX`,确保 taosx 走通用分支(KEPServerEX 分支会硬编码 10000,不受影响)。

## 地址空间结构

```
Objects/
└── Plant1                       (ns=2;s=Plant1)
    ├── Tag_00000                (ns=2;s=Plant1.Tag_00000, Double)
    ├── Tag_00001
    └── ... 共 --children 个扁平子节点
```

扁平结构让某一层 BFS 的节点数 ≈ `--children`,使 taosx 形成一个 `≈ children × 2` 个 ReadValueID 的巨量单批请求。

## 运行

```bash
npm install            # 仓库根目录安装共享依赖

npm run timeout-poc    # 默认:端口 4840,6000 子节点,1ms/节点延迟,license 不限制

# 或直接指定参数
node timeout-poc/simulate-timeout.js [--port 4840] [--path ""] \
     [--children 6000] [--per-node-delay 1] [--max-delay 30000] [--license-max 100]
```

| 参数               | 说明                                                                 | 默认  |
| ------------------ | -------------------------------------------------------------------- | ----- |
| `--port`           | 监听端口                                                             | 4840  |
| `--path`           | 资源路径(默认空,endpoint = `opc.tcp://<host>:<port>`)             | ""    |
| `--children`       | Plant 下扁平子节点数量(越大单批越大越易超时)                       | 6000  |
| `--per-node-delay` | 每个节点在 Read/Browse 上注入的延迟(ms)                            | 1     |
| `--max-delay`      | 单次请求注入延迟的上限(ms)                                         | 30000 |
| `--license-max`    | 最大并发会话数;`>=` 该值时 CreateSession 返回 `BadLicenseLimitsExceeded` | 100   |

> 设 `--license-max 0` 可让**首次连接**即被拒,直接复现报错①。

## 复现步骤

需要先构建 `taosx-opc` 二进制(在 tsdb 仓库内):

```bash
cd <tsdb>/source/taos-xservice/plugins/opc
go build -o /tmp/taosx-opc .
```

### 复现报错②(超时)

> 修复后的 taosx 默认即套用安全上限(见下文「验证修复」),用 `a.toml`(不配上限)已不会超时。
> 因此在**已修复**的 taosx 上复现超时,需用 `a-nolimit.toml`(显式把上限放宽到 65536 = 等于不封顶);
> 若手头是**修复前**的旧二进制,则用 `a.toml` 即可复现。

```bash
# 终端 A:启动服务器(license 不限制)
node timeout-poc/simulate-timeout.js --children 6000 --per-node-delay 1 --license-max 100

# 终端 B:
cd timeout-poc
/tmp/taosx-opc points -c a-nolimit.toml   # 修复前的旧二进制可用 a.toml
```

预期日志(与现场截图一致):

```
info  "get max node per read success 65536"
info  "get max nodes per browse success, 65536"
error "get points properties error" error=The operation timed out. StatusBadTimeout (0x800A0000)
error "browse error"                error=The operation timed out. StatusBadTimeout (0x800A0000)
```

### 复现报错①(License 上限)

```bash
# 终端 A:license-max 设为 0
node timeout-poc/simulate-timeout.js --children 100 --license-max 0

# 终端 B:
cd timeout-poc
/tmp/taosx-opc points -c a.toml
```

预期日志:

```
panic "connect error" error=error in Client Connection: The server has limits on number of allowed operations / objects, based on installed licenses, and these limits where exceeded. StatusBadLicenseLimitsExceeded (0x810F0000)
```

## 验证修复

修复方案:taosx 侧暴露**可选**的 `max_nodes_per_read` / `max_nodes_per_browse`,把服务器上报的虚高值封顶。
两个参数都是 optional,**未配置时套用内置默认安全上限(1000)** —— 因此即使前端不传参,也不会触发超时(向后兼容)。

### ① 默认即安全(前端不传参,用 `a.toml`)

```bash
/tmp/taosx-opc points -c a.toml      # 不含任何 max_nodes_* 配置
```

预期:默认上限自动生效、**不再超时**、采到点位:

```
info  "get max node per read success 65536"
info  "maxNodesPerRead 65536 exceeds limit, cap to 1000"
info  "maxNodesPerBrowse 65536 exceeds limit, cap to 1000"
debug "get points success, total: 6002"
```

### ② 显式配置(用 `a-capped.toml`,可自定义上限)

```bash
/tmp/taosx-opc points -c a-capped.toml   # max_nodes_per_read/browse = 1000
```

预期同样不超时;把值调大(如 `a-nolimit.toml` 的 65536)即可放宽封顶 → 退回超时,用于对照。

| 配置 | max_nodes_* | 修复后结果 |
| ---- | ----------- | ---------- |
| `a.toml`        | 不设置(用默认 1000) | ✅ 不超时,`total: 6002` |
| `a-capped.toml` | 显式 1000            | ✅ 不超时 |
| `a-nolimit.toml`| 显式 65536(放宽)    | ❌ 超时(对照,等价修复前行为) |

## 文件说明

| 文件                   | 说明                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `simulate-timeout.js`  | 模拟服务器                                                                   |
| `a.toml`               | 不设上限(`request_timeout = 3`)。修复后→默认上限生效不超时;修复前→复现超时 |
| `a-capped.toml`        | 显式 `max_nodes_per_read/browse = 1000`,验证显式封顶                        |
| `a-nolimit.toml`       | 显式 65536(放宽=不封顶),在已修复 taosx 上仍复现超时,作对照               |

> `a.toml` 把 `request_timeout` 调到 3s,使"单批 ≈6–12s 超时、单批 ≈1s 不超时"有清晰的判定边界。
