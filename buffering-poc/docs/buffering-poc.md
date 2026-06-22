# OPC UA 断链缓存验证 PoC

## 客户背景

**客户**：某制造业客户（具体名称已脱敏）

**部署架构**：

- **数据中心**（云端/远程机房）：部署 TDengine TSDB + taosx
- **工厂侧**（本地工厂网络）：部署 taosx-agent，连接本地 OPC UA Server

两侧通过 VPN 连接，VPN 链路不稳定，可能出现 **2～3 天** 的网络中断。

**客户核心诉求**：

> 在 taosx 和 taosx-agent 之间网络断开期间，taosx-agent 能否继续采集 OPC UA 数据并缓存到本地磁盘？网络恢复后能否自动将缓存数据推送到 TDengine，保证数据零丢失？

**数据规模**：

- 约 10000 个 OPC UA 点位
- 每秒更新一次
- 断链期间预计产生约 1GB 数据（2～3 天）

## 模拟程序说明

### 文件：`buffering-poc.js`

**语言/框架**：Node.js + [node-opcua](https://github.com/node-opcua/node-opcua) v2.169+

**功能**：模拟客户工厂侧的 OPC UA Server

**运行方式**：

```bash
# 使用默认参数（10000 点位，1秒间隔，端口 4840）
node buffering-poc/buffering-poc.js

# 自定义参数
node buffering-poc/buffering-poc.js --port 4840 --points 10000 --interval 1000 --log-dir ./logs
```

### 主要逻辑

1. **启动 OPC UA Server**（端口 4840，资源路径 `/UA/BufferingTest`）
2. **注册 10000 个变量节点**：
   - Node ID 格式：`ns=2;s=point_0` ～ `ns=2;s=point_9999`
   - 数据类型：Double
   - 另有一个全局序列号节点：`ns=2;s=seq`（Int64，递增计数器）
3. **每秒更新所有点位**：
   - 值 = 正弦波 + 随机噪声（确保每秒有变化，贴近真实工业数据特征）
   - 全局序列号 +1（用于验证数据连续性）
   - 通过 `setValueFromSource` 主动推送变更通知给订阅客户端
4. **同步写 CSV 日志**：
   - 每次更新同时将 `timestamp, seq, point_0, ..., point_9999` 写入本地 CSV
   - CSV 文件作为"真实值基准"，用于事后验证 TDengine 中的数据是否完整

### 为什么这样模拟

| 设计点 | 原因 |
|--------|------|
| 10000 点位 | 匹配客户实际 OPC UA Server 的数据规模 |
| 1 秒更新间隔 | 匹配客户实际采集频率 |
| 递增序列号 | 便于检测数据是否有缺失、重复或乱序 |
| 正弦波 + 噪声 | 模拟真实传感器数据特征，非恒定值 |
| CSV 日志 | 提供不依赖 taosx 的独立数据基准，用于端到端完整性校验 |
| sourceTimestamp | OPC UA 标准中数据源时间戳，确保 taosx 写入 TDengine 的时间戳来自源端 |

## 启动与验证

### 前置依赖

```bash
cd <project-root>
npm install   # 安装 node-opcua 等依赖（顶层共享）
```

### 启动 OPC UA 模拟器

```bash
# 默认参数：10000 点位，1 秒间隔，端口 4840
node buffering-poc/buffering-poc.js

# 自定义（例如 100 个点位用于快速调试）
node buffering-poc/buffering-poc.js --points 100 --interval 1000
```

启动成功后会输出：

```
========================================
  Buffering Test OPC UA Server
========================================
  Endpoint : opc.tcp://xxx:4840/UA/BufferingTest
  Points   : 10000
  Interval : 1000ms
  Log file : <project-root>/logs/buffering-test-2026-05-12T...csv
  Node IDs : ns=2;s=seq, ns=2;s=point_0 ~ ns=2;s=point_9999
========================================
```

每 60 秒在终端打印一次状态行：

```
[data] seq=60 ts=2026-05-12T08:31:00.000Z point_0=52.317
```

按 `Ctrl+C` 优雅退出，日志文件自动保存。

### 验证模拟器是否正常工作

**方法 1：使用项目自带的 quick-client.js**

```bash
node quick-client.js
```

连接到本地 4840 端口，读取几个节点的值。

**方法 2：使用 UaExpert 等 OPC UA 客户端工具**

连接地址：`opc.tcp://localhost:4840/UA/BufferingTest`

浏览到 `Objects > BufferingTest`，可以看到 `seq` 和 `point_0` \~ `point_9999` 节点，值每秒变化。

**方法 3：确认 CSV 日志正在写入**

```bash
# 查看日志文件行数（等于产生的数据秒数 + 1 行表头）
wc -l logs/buffering-test-*.csv

# 实时查看最新写入
tail -f logs/buffering-test-*.csv
```

### 配合 taosx-agent 进行测试

1. 确认模拟器已启动且 CSV 正在增长
2. 在 Explorer 中创建 OPC UA 任务，Endpoint 填写 `opc.tcp://<Mac-IP>:4840/UA/BufferingTest`
3. 订阅点位选择 `ns=2;s=seq` 和部分或全部 `ns=2;s=point_*`
4. 任务运行后，在 TDengine 中查询确认数据写入：

```sql
SELECT * FROM <database>.<stable> ORDER BY ts DESC LIMIT 10;
```

### 测试完成后验证数据完整性

```bash
# 参数：CSV日志路径、TDengine地址、数据库名、超级表名
node verify-data.js \
  --csv ./logs/buffering-test-2026-05-12T....csv \
  --host <taosx-host-ip> \
  --port 6041 \
  --db test_opcua \
  --stable buffering_test
```

输出示例：

```
=== 数据完整性报告 ===
CSV 基准行数: 540
TDengine 行数: 480
完整率: 88.9%
缺失段:
  [2026-05-12T08:35:00Z ~ 2026-05-12T08:36:00Z] (60 秒)
```

## 辅助工具

| 文件 | 用途 |
|------|------|
| `verify-data.js` | 读取 CSV 基准，查询 TDengine REST API，对比并输出数据缺失报告 |
| `scripts/network-simulate.sh` | macOS 上使用 pfctl 模拟网络断开/恢复 |

## 测试环境

| 角色 | 设备 | 组件 |
|------|------|------|
| 数据中心 | <taosx-host-ip> | taosx + TDengine TSDB |
| 工厂侧 | 本地 Mac | taosx-agent + buffering-poc.js |

## 相关文档

- 内部测试报告（链接已脱敏）
- 需求来源会议记录（链接已脱敏）

## 当前结论（基于代码分析）

**persist_data_enable=true 不能解决长时间断链的数据丢失问题。**

根本原因：taosx-agent 检测到与 taosx 的连接断开后，会通过 `wait_handle!()` 宏杀死所有运行中的任务（包括 OPC UA 子进程）。OPC UA 子进程被杀后，不再有程序从 OPC UA Server 读取数据，persist_queue 自然也无数据可缓存。

**需要的改造**：

1. **P0**：agent 断链时不杀死带 persist_queue 的任务（解耦控制面与数据面）
2. **P0**：taosx-opc 的 OPC UA 重连参数可配置（当前硬编码 60×5s = 5 分钟上限）
3. **P1**：persist_queue 支持磁盘容量管理（淘汰策略、空间预警）
