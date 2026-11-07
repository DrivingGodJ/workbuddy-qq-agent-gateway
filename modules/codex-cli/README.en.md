[简体中文](README.md) | **English**

# Codex CLI Compatibility Module

Retains Codex app-server integration for the gateway, implemented in `src/codex/client.js` from the repository root. The main project is designed around WorkBuddy; feature parity between engines is not guaranteed.

## Usage

The default CLI path is `/Applications/Codex.app/Contents/Resources/codex`. Override it in the deployment environment:

```bash
CODEX_CLI_PATH=/path/to/codex
```

Replace the example with the actual executable path and follow the [main configuration guide](../../README.en.md) to enable the compatibility path.

## Sessions and data

Each QQ group maps to a persistent Codex thread. Group workspaces use the same isolated layout as WorkBuddy: `runtime/group-workspaces/<groupId>/`. Thread IDs and pending messages live in `runtime/qq-only-data/group-sessions.json`. All paths are relative to the repository root and contain runtime data that must not be published.
