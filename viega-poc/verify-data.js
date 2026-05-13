// verify-data.js
// 数据完整性验证脚本 —— 对比 OPC UA 模拟器的本地日志与 TDengine 中的实际数据
//
// 用法：
//   node verify-data.js --csv ./logs/buffering-test-xxx.csv \
//                       --host 192.168.2.139 --port 6041 \
//                       --db test_buffering --stable opc_data
//
// 功能：
//   1. 读取 OPC UA 模拟器生成的 CSV 日志（基准数据）
//   2. 从 TDengine 查询实际写入的数据
//   3. 按时间戳对比，找出缺失的数据段
//   4. 生成完整性报告

import { readFileSync } from "node:fs";

// ---------- 解析参数 ----------
const argv = process.argv.slice(2);
let csvPath = "";
let host = "192.168.2.139";
let port = 6041;
let user = "root";
let password = "taosdata";
let db = "test_buffering";
let stable = "opc_data";

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case "--csv": csvPath = argv[++i]; break;
    case "--host": host = argv[++i]; break;
    case "--port": port = parseInt(argv[++i], 10); break;
    case "--user": user = argv[++i]; break;
    case "--password": password = argv[++i]; break;
    case "--db": db = argv[++i]; break;
    case "--stable": stable = argv[++i]; break;
  }
}

if (!csvPath) {
  console.error("Usage: node verify-data.js --csv <csv-file> [--host host] [--db db]");
  process.exit(1);
}

// ---------- 读取 CSV 基准数据 ----------
console.log(`\n[1/3] Reading CSV baseline: ${csvPath}`);
const csvContent = readFileSync(csvPath, "utf-8");
const csvLines = csvContent.trim().split("\n");
const csvHeader = csvLines[0].split(",");
const csvData = csvLines.slice(1).map(line => {
  const parts = line.split(",");
  return {
    timestamp: parts[0],
    seq: parseInt(parts[1], 10),
  };
});
console.log(`      Total records in CSV: ${csvData.length}`);
console.log(`      Time range: ${csvData[0]?.timestamp} ~ ${csvData[csvData.length - 1]?.timestamp}`);
console.log(`      Seq range: ${csvData[0]?.seq} ~ ${csvData[csvData.length - 1]?.seq}`);

// ---------- 从 TDengine 查询数据 ----------
console.log(`\n[2/3] Querying TDengine: ${host}:${port}/${db}`);

const url = `http://${host}:${port}/rest/sql/${db}`;
const authHeader = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

async function queryTD(sql) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!resp.ok) {
    throw new Error(`TDengine query failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

try {
  // 查询总行数
  const countResult = await queryTD(`SELECT COUNT(*) as cnt FROM ${stable}`);
  const tdCount = countResult?.data?.[0]?.[0] ?? 0;
  console.log(`      Total records in TDengine: ${tdCount}`);

  // 查询时间范围
  const rangeResult = await queryTD(
    `SELECT FIRST(ts) as first_ts, LAST(ts) as last_ts FROM ${stable}`
  );
  const firstTs = rangeResult?.data?.[0]?.[0];
  const lastTs = rangeResult?.data?.[0]?.[1];
  console.log(`      Time range: ${firstTs} ~ ${lastTs}`);

  // 按秒统计 TDengine 中每秒有多少条数据（每秒应约=点位数）
  // 使用 time_truncate 将时间戳截断到秒级别
  const secCountResult = await queryTD(
    `SELECT TIMETRUNCATE(ts, 1s) as sec, COUNT(*) as cnt FROM ${stable} GROUP BY TIMETRUNCATE(ts, 1s) ORDER BY sec`
  );
  const tdSecondMap = new Map();
  for (const row of (secCountResult?.data ?? [])) {
    // row[0] = truncated timestamp, row[1] = count
    const secKey = new Date(row[0]).toISOString().slice(0, 19); // "2026-05-12T10:57:16"
    tdSecondMap.set(secKey, (tdSecondMap.get(secKey) ?? 0) + row[1]);
  }
  console.log(`      Distinct seconds with data: ${tdSecondMap.size}`);

  // ---------- 对比分析 ----------
  console.log(`\n[3/3] Comparing data (by second-level granularity)...`);
  console.log(`      Each CSV row = 1 second of data across all points`);
  console.log(`      Match = TDengine has records for that second\n`);

  let matched = 0;
  let missing = 0;
  const missingRanges = [];
  let currentMissingStart = null;
  let currentMissingEnd = null;
  let currentMissingStartSeq = null;

  for (const record of csvData) {
    // 截断到秒级别对比
    const csvSecKey = new Date(record.timestamp).toISOString().slice(0, 19);
    const found = tdSecondMap.has(csvSecKey);

    if (found) {
      matched++;
      if (currentMissingStart) {
        missingRanges.push({
          start: currentMissingStart,
          end: currentMissingEnd,
          startSeq: currentMissingStartSeq,
          endSeq: record.seq - 1,
        });
        currentMissingStart = null;
        currentMissingEnd = null;
        currentMissingStartSeq = null;
      }
    } else {
      missing++;
      if (!currentMissingStart) {
        currentMissingStart = record.timestamp;
        currentMissingStartSeq = record.seq;
      }
      currentMissingEnd = record.timestamp;
    }
  }

  // 收尾最后一个缺失段
  if (currentMissingStart) {
    missingRanges.push({
      start: currentMissingStart,
      end: currentMissingEnd,
      startSeq: currentMissingStartSeq,
      endSeq: csvData[csvData.length - 1].seq,
    });
  }

  // ---------- 输出报告 ----------
  const completeness = csvData.length > 0 ? ((matched / csvData.length) * 100).toFixed(2) : "0.00";
  console.log(`${"=".repeat(60)}`);
  console.log(`  数据完整性验证报告`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  CSV 基准秒数：${csvData.length} 秒`);
  console.log(`  TDengine 总行数：${tdCount} 条`);
  console.log(`  TDengine 覆盖秒数：${tdSecondMap.size} 秒`);
  console.log(`  匹配成功：${matched} 秒`);
  console.log(`  缺失秒数：${missing} 秒`);
  console.log(`  完整率：${completeness}%`);

  if (missingRanges.length > 0) {
    console.log(`\n  缺失数据段（共 ${missingRanges.length} 段）：`);
    for (const range of missingRanges) {
      const duration = (new Date(range.end) - new Date(range.start)) / 1000;
      console.log(`    ${range.start} ~ ${range.end}`);
      console.log(`      seq ${range.startSeq} ~ ${range.endSeq}, 持续 ${duration.toFixed(0)}s`);
    }
  } else {
    console.log(`\n  ✅ 数据完整，无缺失！`);
  }
  console.log(`${"=".repeat(60)}\n`);

  // 退出码
  process.exit(missing > 0 ? 1 : 0);

} catch (e) {
  console.error(`\n[error] ${e.message}`);
  console.error(`\n提示：请确认 TDengine REST 服务已启动，且数据库 ${db} 和超级表 ${stable} 存在。`);
  console.error(`你可能需要先检查 OPC UA 任务的目标数据库和表名配置。`);
  process.exit(2);
}
