# Copilot Instructions

## Project Overview

A collection of OPC UA server simulators, each tailored for a specific customer PoC or testing scenario against TDengine (via taosx/taosx-agent). Each scenario lives in its own subdirectory.

## Project Structure

```
opcua-demo/
├── ae-explore/        # OPC UA Alarms & Events learning/exploration
├── ads-poc/           # ADS customer PoC — GE Cimplicity (CSS) simulator
├── viega-poc/         # Viega customer PoC — buffering/断链缓存 verification
├── scripts/           # Shared utility scripts (network simulation, etc.)
├── package.json       # Shared dependencies (node-opcua, @iarna/toml)
└── .github/
```

When adding a new simulation scenario, create a new top-level subdirectory with its own scripts and docs.

## Build & Run

```bash
npm install                # shared dependencies at repo root

# Per-scenario npm scripts:
npm run ae-server          # ae-explore/server.js
npm run ae-client          # ae-explore/client.js
npm run ads-poc            # ads-poc/simulate-ge-css.js
npm run viega-poc          # viega-poc/viega-poc.js
```

### Direct invocation with options

```bash
# ADS PoC (GE CSS simulator) — reads node list from a taosX TOML config
node ads-poc/simulate-ge-css.js [path/to/config.toml] [--port 64121] [--path //GeCssOpcUaServer] [--alarms]

# Viega PoC — 10k points, 1s interval, logs CSV baseline
node viega-poc/viega-poc.js [--port 4840] [--points 10000] [--interval 1000] [--log-dir ./logs]

# Data integrity verification (Viega)
node viega-poc/verify-data.js --csv ./logs/buffering-test-xxx.csv --host 192.168.2.139 --db test_buffering --stable opc_data
```

### Network Simulation (macOS, requires sudo)

```bash
sudo ./scripts/network-simulate.sh block 192.168.2.139   # simulate network outage
sudo ./scripts/network-simulate.sh unblock               # restore
```

## Scenario Details

### ae-explore/

Minimal OPC UA server with an `ExclusiveLevelAlarm` on a sine-wave Tank/Level variable and a periodic `DoorOpenedEvent`. Paired client subscribes to events. Good for learning OPC UA A&E concepts.

### ads-poc/

Production-scale GE Cimplicity simulator. Reads a taosX TOML config (`connect.ua.endpoint`, `collect.ua.nodes[]`) and builds an equivalent OPC UA address space (thousands of nodes). Classifies nodes into dynamic values, static metadata, and alarm instances.

### viega-poc/

Simulates Viega factory-side OPC UA Server (10k points, 1s updates). Writes all generated data to a local CSV log as ground truth. Used with `verify-data.js` to confirm zero data loss after network interruptions. See `viega-poc/docs/Viega-POC.md` for full test procedure.

## Key Conventions

- **ES Modules** — `"type": "module"` in package.json; use `import`/`export` syntax exclusively.
- **node-opcua CJS interop** — The library is CJS; import as `import pkg from "node-opcua"` then destructure from `pkg`.
- **Top-level await** — Scripts use top-level `await` directly (ESM `.js` files).
- **CLI argument parsing** — Manual `process.argv` loop with `--flag value` pattern; no external arg-parsing library.
- **TOML config driven** — `ads-poc/simulate-ge-css.js` derives its address space from a taosX collector TOML file. It tolerates truncated TOML via progressive tail trimming.
- **Data integrity workflow** — Generate data → log to CSV → ingest via taosx pipeline → compare CSV vs TDengine → report gaps.
