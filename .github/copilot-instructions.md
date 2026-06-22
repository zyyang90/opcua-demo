# Copilot Instructions

## Project Overview

A collection of OPC UA server simulators, each tailored for a specific customer PoC or internal testing scenario against TDengine (via taosx/taosx-agent). Each scenario lives in its own subdirectory with its own scripts and docs.

## Architecture

- **Each subdirectory is an independent scenario** — its own OPC UA server, optional client/verifier, and documentation.
- **Shared dependencies** are at root `package.json`; no per-scenario `package.json`.
- **Data flow**: OPC UA simulator → taosx-agent (collector) → taosx → TDengine TSDB.
- **Verification pattern** (buffering-poc): simulator logs ground-truth CSV → compare against TDengine after ingestion → report gaps.

## Build & Run

```bash
npm install                # shared dependencies at repo root

# Per-scenario npm scripts:
npm run ae-server          # ae-explore/server.js
npm run ae-client          # ae-explore/client.js
npm run scada-poc          # scada-poc/simulate-scada.js
npm run buffering-poc      # buffering-poc/buffering-poc.js
```

### Direct invocation with options

```bash
# SCADA PoC (third-party SCADA simulator) — reads node list from a taosX TOML config
node scada-poc/simulate-scada.js [path/to/config.toml] [--port 64121] [--path //ScadaOpcUaServer] [--alarms]

# Buffering PoC — 10k points, 1s interval, logs CSV baseline
node buffering-poc/buffering-poc.js [--port 4840] [--points 10000] [--interval 1000] [--log-dir ./logs]

# Data integrity verification (buffering PoC)
node buffering-poc/verify-data.js --csv ./logs/buffering-test-xxx.csv --host <taosx-host-ip> --db test_buffering --stable opc_data
```

### Network Simulation (macOS, requires sudo)

```bash
sudo ./scripts/network-simulate.sh block <taosx-host-ip>   # simulate network outage
sudo ./scripts/network-simulate.sh unblock               # restore
```

## Scenarios

| Directory | Purpose | Key File |
|-----------|---------|----------|
| `ae-explore/` | OPC UA Alarms & Events learning | `server.js` + `client.js` |
| `scada-poc/` | Third-party SCADA simulator — thousands of nodes from TOML config | `simulate-scada.js` |
| `buffering-poc/` | OPC UA buffering/断链缓存 verification — 10k points, CSV ground-truth | `buffering-poc.js` + `verify-data.js` |

## Key Conventions

- **ES Modules** — `"type": "module"` in package.json; use `import`/`export` syntax exclusively.
- **node-opcua CJS interop** — The library is CJS-only. Always import and destructure like this:
  ```js
  import pkg from "node-opcua";
  const { OPCUAServer, Variant, DataType, StatusCodes } = pkg;
  ```
- **`__dirname` in ESM** — Use this pattern in every script:
  ```js
  import { fileURLToPath } from "node:url";
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  ```
- **Top-level await** — Scripts use top-level `await` directly (ESM `.js` files).
- **CLI argument parsing** — Manual `process.argv` loop with `--flag value` pattern; no external arg-parsing library. Use `switch` for many flags, simple `if/else` for few.
- **TOML config driven** — `scada-poc/simulate-scada.js` derives its address space from a taosX collector TOML file. It tolerates truncated TOML via progressive tail trimming.
- **Data integrity workflow** — Generate data → log to CSV → ingest via taosx pipeline → compare CSV vs TDengine → report gaps.
- **Chinese comments** — In-code comments are in Chinese; README/docs may mix Chinese and English.

## Adding a New Scenario

1. Create a new top-level subdirectory (e.g., `customer-poc/`).
2. Add the main server script (follow existing patterns for OPCUAServer setup).
3. Optionally add a `quick-client.js` for verification and a `docs/` subfolder.
4. Register an npm script in root `package.json`.
5. No separate `package.json` — all dependencies go in root.
