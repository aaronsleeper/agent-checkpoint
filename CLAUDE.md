# Agent Checkpoint

VS Code extension + MCP server for secure agent-to-user questions.

## Architecture

```
Agent (Claude Code) → MCP stdio → server.ts → HTTP localhost → extension.ts → VS Code UI → User
                                                                     ↓
                                                              classifier.ts (gate)
                                                              rate-limiter.ts (throttle)
                                                              audit.ts (log)
```

**Trust boundary:** The extension is the trusted component. The MCP server is untrusted — it only forwards requests. All security decisions (classification, rate limiting, blocking) happen in the extension.

## Security Layers

1. **Classification gate** — regex-based, blocks sensitive questions (credentials, keys, payments)
2. **Rate limiter** — 3/min, 20/session, cooldown after rejection, duplicate detection
3. **Auth token** — random 32-byte token written to `~/.agent-checkpoint/bridge.json` (mode 0600), required on every HTTP request
4. **Provenance display** — agent ID, tool chain, session count shown in UI (non-forgeable)
5. **Audit log** — JSONL at extension global storage, viewable via command palette
6. **Body size limit** — 64KB max request body

## Development

```bash
npm install
npm run compile       # or npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

## MCP Registration (Claude Code)

```bash
claude mcp add agent-checkpoint -- node /Users/aaronsleeper/Desktop/Vaults/Lab/agent-checkpoint/out/server.js
```

## Files

- `src/extension.ts` — VS Code extension entry, HTTP bridge, UI rendering
- `src/server.ts` — MCP server (stdio), `ask_user` tool
- `src/classifier.ts` — Question classification (informational/permission/sensitive)
- `src/rate-limiter.ts` — Rate limiting and circuit breaker
- `src/audit.ts` — Append-only audit log (JSONL)
- `src/types.ts` — Shared type definitions
