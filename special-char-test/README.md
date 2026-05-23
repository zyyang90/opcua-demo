# special-char-test — OPC UA 特殊字符 Description 复现服务器

## 背景

复现飞书项目缺陷：[#6995142330](https://project.feishu.cn/taosdata_td/defect/detail/6995142330)

问题现象：当 OPC UA 点位的 `description` 字段包含特殊 Unicode 字符（如 °C、Ω、µ 等）时，taosx/taosx-agent 在采集或写入 TDengine 过程中可能出现异常。

## 模拟器说明

本服务器提供 7 个点位，每个点位的 `description` 包含不同类型的特殊字符：

| NodeId | Description | 特殊字符 |
|--------|-------------|----------|
| `ns=2;s=beijing.chaoyang.temperature` | 北京市朝阳区的气温，单位为°C | ° (度数) |
| `ns=2;s=factory.pressure` | 管道压力，精度±0.5%，量程0~10MPa | ± (正负号) |
| `ns=2;s=factory.flow` | 流量计读数，单位m³/h，最大量程100m³/h | ³ (上标3) |
| `ns=2;s=factory.angle` | 旋转角度0~360°，分辨率0.01° | ° (度数) |
| `ns=2;s=factory.resistance` | 电阻值，单位Ω（欧姆），量程0~1000Ω | Ω (欧姆) |
| `ns=2;s=factory.micro_current` | 微电流传感器，量程0~100µA，精度≤0.1µA | µ (微), ≤ (小于等于) |
| `ns=2;s=factory.power` | 功率≈2.5kW（额定），电压×电流=功率 | ≈ (约等于), × (乘号) |

所有点位每秒随机波动更新数值，模拟真实传感器行为。

## 使用方法

### 检查端口占用

本机可能已有其他 OPC UA 模拟器在运行（如 ae-explore、viega-poc 等），默认都使用 4840 端口。启动前先检查：

```bash
# 检查 4840 端口是否被占用
lsof -i :4840

# 查看所有正在运行的 OPC UA 相关 node 进程
ps aux | grep -E 'node.*(viega-poc|simulate-ge-css|ae-explore|special-char)' | grep -v grep
```

如果端口已被占用，有两种处理方式：
1. 停掉已有的模拟器：`kill <PID>`
2. 使用 `--port` 指定其他端口（建议使用 48401~48499 范围，避免与常见服务冲突）

### 启动服务器

```bash
# 默认启动（端口 4840）
npm run special-char-test

# 指定端口（推荐，避免与其他模拟器冲突）
node special-char-test/server.js --port 48410 --path /UA/SpecialCharTest
```

启动后会打印 endpoint URL，将该 URL 配置到 taosx 数据源中即可。

## 验证步骤

1. 启动本服务器
2. 在 taosx 中配置 OPC UA 数据源，指向本服务器
3. 创建采集任务，观察：
   - 点位发现（browse）阶段是否能正确读取 description
   - 数据写入 TDengine 后，description 相关字段是否完整保留
   - 是否出现 parsing error 或乱码

## 当前结论

从 taosx 代码分析来看，度数符号（°）本身不太可能直接导致 "import fails" 或 "description parsing errors"，整个数据链对 UTF-8 字符的处理是正确的。本模拟器用于实际端到端验证这一判断。
