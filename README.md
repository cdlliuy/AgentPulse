# AgentPulse

AI Agent Management Dashboard — monitor and manage Claude Code, GitHub Copilot, and other AI agent sessions from a single local web interface.

**Key Features:**
- Real-time session monitoring with WebSocket live updates
- Multi-agent view (Claude Code + GitHub Copilot side by side)
- Settings & config viewer (MCP servers, CLAUDE.md, memory files, skills)
- AI-powered session summaries via `claude -p`
- Remote command input detection (Slack/Teams/WeChat and more)
- Session naming, closing, and activity timeline

**Architecture:** Single `server.js` + single `public/index.html`. No build step, no framework dependencies.

---

## For Users

### Prerequisites

- Node.js 18+
- Claude Code installed and configured (`~/.claude/` directory exists)
- (Optional) GitHub Copilot with agent mode for dual-agent view

### Install from npm

```bash
npm install -g agentpulse
agentpulse
```

Or run directly without installing:

```bash
npx agentpulse
```

### Install from source

```bash
git clone https://github.com/cdlliuy/AgentPulse.git
cd AgentPulse
npm install
npm start
```

The dashboard opens at **http://localhost:3456**. To use a different port:

```bash
PORT=8080 agentpulse
```

### Background Mode (persistent)

```bash
PORT=3456 nohup agentpulse > server.log 2>&1 & echo $! > server.pid
```

To stop: `kill $(cat server.pid)`

### What You See

| Tab | Description |
|-----|-------------|
| **Sessions** | All active and historical Claude Code / Copilot sessions with timeline, agents, todos, cron jobs |
| **Settings & Config** | Global and per-project settings, MCP servers, CLAUDE.md instructions, memory files, skills |

- Click a session card to view its detailed timeline
- Click the agent icons (C / G) in the top nav to switch between Claude Code and GitHub Copilot views
- Use the "AI Summary" button on any session to generate a summary via `claude -p`
- Session names can be customized — click the rename icon

### Configuration

No configuration file needed. The dashboard auto-discovers:
- Sessions from `~/.claude/sessions/` and `~/.claude/projects/*/`
- Settings from `~/.claude/settings.json` and `~/.claude.json`
- Memory files from `~/.claude/projects/*/memory/`
- Skills from `~/.claude/commands/` and per-project `.claude/commands/`
- Copilot data from `~/.copilot/`

---

## For Contributors

### Project Structure

```
agentpulse/
  server.js          — Express server, REST APIs, WebSocket, all business logic
  server.test.js     — Jest + Supertest tests (96 tests, ~85% line coverage)
  public/index.html  — Single-page frontend (vanilla JS, no framework)
  package.json       — Dependencies: express, ws; devDeps: jest, supertest
  LICENSE            — MIT License
  .npmignore         — Controls which files are published to npm
```

### Development Workflow

```bash
# Install dependencies
npm install

# Start in development (same as npm start)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npx jest --coverage
```

### Making Changes

#### 1. Code Style Rules

- **No build step** — everything runs directly in Node.js, no TypeScript, no bundler
- **Single-file architecture** — server logic stays in `server.js`, frontend in `index.html`
- **Extract shared helpers** — if you duplicate logic 3+ times, extract a function (e.g., `parseFrontmatter()`, `displayNameFromSlug()`)
- **Consistent error handling** — use `try/catch` with empty catch for best-effort file reads, return `null` for missing data
- **Mask sensitive data** — always pass MCP env configs through `maskMcpEnv()` before sending to the client

#### 2. Testing Requirements

Before committing any change:

```bash
# Run the full test suite — all tests must pass
npm test

# Check coverage — maintain above 80% line coverage
npx jest --coverage
```

**Test categories:**
- **Pure function unit tests** — test helpers like `parseFrontmatter()`, `maskSensitive()`, `summarizeInput()` with various inputs
- **JSONL parsing tests** — test `parseConversation()` with fixture `.jsonl` files covering all event types
- **REST API integration tests** — test each endpoint with `supertest` for status codes, response shapes, error cases
- **Security tests** — verify path traversal protection on `DELETE /api/memory` and `PUT /api/memory`

**Adding tests for new features:**
1. If adding a helper function — add unit tests in the matching `describe()` block
2. If adding an API endpoint — add integration tests in the `REST API` describe block
3. If modifying JSONL parsing — add a fixture `.jsonl` file and test in `parseConversation` block
4. Use `writeFixture()` helper to create temporary test files (auto-cleaned after tests)

#### 3. Code Review Checklist

When reviewing changes (your own or others), verify:

- [ ] All 96+ tests pass (`npm test`)
- [ ] No test coverage regression (`npx jest --coverage` — maintain >80%)
- [ ] No duplicated logic — check if an existing helper can be reused
- [ ] Sensitive data masked — any new API that returns env vars or secrets uses `maskSensitive()`/`maskMcpEnv()`
- [ ] No new dependencies unless absolutely necessary (keep the zero-build-step philosophy)
- [ ] Frontend changes: async API calls use the slot-filling pattern (render placeholder, fetch, fill `getElementById().innerHTML`)
- [ ] New exports added to `module.exports` if the function needs testing

#### 4. Manual Validation After Changes

After code changes, always verify the running dashboard:

```bash
# 1. Restart the server
kill $(cat server.pid 2>/dev/null) 2>/dev/null
PORT=3456 nohup node server.js > server.log 2>&1 & echo $! > server.pid

# 2. Check server started successfully
cat server.log

# 3. Verify API responses
curl -s http://localhost:3456/api/sessions | python -m json.tool | head -20
curl -s http://localhost:3456/api/stats | python -m json.tool
curl -s http://localhost:3456/api/claude-code/skills | python -m json.tool | head -20
curl -s http://localhost:3456/api/projects | python -m json.tool | head -20

# 4. Open in browser and check:
#    - Sessions tab loads and shows active/historical sessions
#    - Session detail timeline renders correctly
#    - Settings & Config tab shows global settings, MCP, instructions
#    - Project cards expand with correct data
#    - Agent switcher (C/G) works in top nav
```

### API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all sessions (query: `?historical=false&limit=N`) |
| GET | `/api/sessions/:id` | Get single session detail |
| PUT | `/api/sessions/:id/name` | Rename a session |
| POST | `/api/sessions/:id/close` | Kill an active session (SIGTERM) |
| GET | `/api/sessions/:id/suggest-name` | Get auto-suggested name |
| POST | `/api/sessions/:id/ai-summary` | Generate AI summary via `claude -p` |
| PUT | `/api/sessions/:id/title` | Modify session title in JSONL (completed sessions only) |
| GET | `/api/claude-cli-status` | Check claude CLI availability (query: `?refresh=true`) |
| GET | `/api/stats` | Aggregate statistics |
| GET | `/api/cron-jobs` | List all active cron jobs across sessions |
| GET | `/api/projects` | All projects with settings, MCP, CLAUDE.md, memory |
| GET | `/api/settings` | Global + project settings (query: `?project=slug&cwd=path`) |
| GET | `/api/memory` | All memory files (query: `?project=slug`) |
| PUT | `/api/memory` | Update a memory file |
| DELETE | `/api/memory` | Delete a memory file |
| PUT | `/api/settings/global-claude-md` | Update global CLAUDE.md |
| GET | `/api/claude-code/skills` | Claude Code skills by scope |
| GET | `/api/copilot/skills` | Copilot commands and prompts |
| GET | `/api/copilot/sessions` | Copilot agent-mode sessions |
| GET | `/api/copilot/settings` | Copilot config and agents |
| GET | `/api/agents` | List all supported agent types |
| WS | `ws://localhost:3456` | Real-time session updates (5s interval) |

## License

MIT
