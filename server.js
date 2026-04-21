#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const http = require('http');
const { spawn, execSync } = require('child_process');

// ── Constants ───────────────────────────────────────────
const PORT = process.env.PORT || 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSION_NAMES_FILE = path.join(__dirname, 'session-names.json');
const AI_SUMMARIES_DIR = path.join(CLAUDE_DIR, 'claude-code-dashboard');
const AI_SUMMARIES_FILE = path.join(AI_SUMMARIES_DIR, 'ai-summaries.json');
const GLOBAL_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

// ── Copilot Paths ──────────────────────────────────────
const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const COPILOT_SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');
const COPILOT_MCP_CONFIG = path.join(COPILOT_DIR, 'mcp-config.json');
const COPILOT_CONFIG = path.join(COPILOT_DIR, 'config.json');
const COPILOT_AGENTS_DIR = path.join(COPILOT_DIR, 'agents');

const WS_PUSH_INTERVAL_MS = 5000;
const WS_MAX_SESSIONS = 30;
const AI_SUMMARY_CACHE_TTL_MS = 600000; // 10 min

// ── Truncation Limits ─────────────────────────────────
const T = {
  TIMELINE: 1024,     // user/assistant/cron event text
  REMOTE_INPUT: 1024, // remote input (chat platform messages)
  BASH_CMD: 150,      // Bash command summary
  URL: 100,           // WebFetch URL
  CRON_PROMPT: 80,    // CronCreate prompt
  TOOL_INPUT: 120,    // generic tool input summary
  BRIEF_NAME: 80,     // AI summary brief name
  DISPLAY_NAME: 60,   // session display name
  SESSION_ID: 8,      // session ID prefix
  HINT: 100,          // suggestSessionName hint
  HINTS_COMBINED: 500, // suggestSessionName combined
  DESC: 120,          // file/command descriptions
  REPO_CLAUDE_MD: 2000, // repo CLAUDE.md preview
  LONG_CONTENT: 3000, // copilot instructions etc.
  STDERR: 200,        // error message preview
};

// ── Chat Platform Detection ───────────────────────────
const CHAT_PLATFORM_KEYWORDS = {
  feishu: ['feishu', '飞书', 'lark'],
  teams: ['teams'],
  wechat: ['wechat', '微信'],
  slack: ['slack'],
};

function detectChatChannel(text) {
  const lower = text.toLowerCase();
  for (const [channel, keywords] of Object.entries(CHAT_PLATFORM_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return channel;
  }
  return 'remote';
}

// ── Conversation Parsing Patterns ─────────────────────
const MESSAGE_POLL_PATTERN = /(?:poll|check|fetch|read)\s+(?:for\s+)?(?:new\s+)?(?:\w+\s+)?(?:message|消息|指令)|feishu-poll|slack-poll|teams-poll|wechat-poll|消息轮询|轮询消息|检查.*消息|查看.*消息/i;
const EMPTY_RESULT_PATTERNS = [
  '(Bash completed with no output)',
  'No new', 'no new', 'null', '""', "''", '{}', '[]'
];

// ── Agent Definitions ─────────────────────────────────
const AGENT_DEFINITIONS = [
  { id: 'claude-code', name: 'Claude Code', shortName: 'CC', icon: 'C', color: '#f78166', hasSettings: true },
  { id: 'github-copilot', name: 'GitHub Copilot', shortName: 'GHC', icon: 'G', color: '#3fb950', hasSettings: true },
];

// ── Claude CLI Check ───────────────────────────────────
let claudeCliStatus = { available: false, version: null, checkedAt: null };

function checkClaudeCli() {
  try {
    const version = execSync('claude --version', { encoding: 'utf8', timeout: 5000, shell: true }).trim();
    claudeCliStatus = { available: true, version, checkedAt: Date.now() };
  } catch {
    claudeCliStatus = { available: false, version: null, checkedAt: Date.now() };
  }
  return claudeCliStatus;
}

// ── Session Names Persistence ───────────────────────────

function loadSessionNames() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_NAMES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessionNames(names) {
  fs.writeFileSync(SESSION_NAMES_FILE, JSON.stringify(names, null, 2), 'utf8');
}

/** Generate a suggested name for a session based on its content */
function suggestSessionName(session) {
  const hints = [];

  // From user messages — extract key topics
  const userEvents = (session.recentEvents || []).filter(e => e.type === 'user' && e.text);
  if (userEvents.length > 0) {
    // Take first few user messages as topic indicators
    const firstMsgs = userEvents.slice(0, 3).map(e => e.text.slice(0, T.HINT));
    hints.push(...firstMsgs);
  }

  // From todos — task descriptions are very descriptive
  const todos = session.todos || [];
  if (todos.length > 0) {
    hints.push(todos.map(t => t.content).join('; '));
  }

  // From agent descriptions
  const agents = session.agents || [];
  if (agents.length > 0) {
    const uniqueDescs = [...new Set(agents.map(a => a.description))].slice(0, 5);
    hints.push(uniqueDescs.join(', '));
  }

  // From skills used
  const skills = (session.recentEvents || []).filter(e => e.type === 'skill').map(e => e.skill);
  if (skills.length > 0) {
    hints.push('Skills: ' + [...new Set(skills)].join(', '));
  }

  // Build a simple summary: take the most informative hint
  const combined = hints.join(' | ').slice(0, T.HINTS_COMBINED);
  return combined || session.title || 'Unnamed session';
}

// ── Helpers ──────────────────────────────────────────────

/** List files in a directory matching an extension, returning [] on error */
function safeReadDir(dirPath, ext) {
  try {
    return fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
  } catch {
    return [];
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sort sessions: alive first, then by most recent activity */
function sortByActivity(sessions) {
  return sessions.sort((a, b) => {
    if (a.alive !== b.alive) return (b.alive ? 1 : 0) - (a.alive ? 1 : 0);
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : (a.startedAt || 0);
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : (b.startedAt || 0);
    return bTime - aTime;
  });
}

/** Get sessions from session metadata files */
function getSessionMetadata() {
  const map = new Map();
  for (const f of safeReadDir(SESSIONS_DIR, '.json')) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (data.sessionId) map.set(data.sessionId, data);
    } catch {}
  }
  return map;
}

/** Discover ALL conversation JSONL files across all projects */
function discoverAllConversations() {
  const conversations = [];
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      for (const f of safeReadDir(dirPath, '.jsonl')) {
        const sessionId = f.replace('.jsonl', '');
        const fullPath = path.join(dirPath, f);
        const stat = fs.statSync(fullPath);
        conversations.push({
          sessionId,
          project: dir,
          path: fullPath,
          size: stat.size,
          lastModified: stat.mtimeMs
        });
      }
    }
  } catch {}
  return conversations.sort((a, b) => b.lastModified - a.lastModified);
}

/** Process a user-type message: track user text, skill expansion, remote input */
function processUserMessage(obj, state) {
  state.totalUserMessages++;
  const rawContent = obj.message?.content;
  const contentArr = Array.isArray(rawContent) ? rawContent :
    typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : [];
  const hasToolResults = contentArr.some(c => c.type === 'tool_result');
  const rawText = contentArr
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join(' ');
  const isCommandMsg = typeof rawContent === 'string' && rawText.trimStart().startsWith('<command-message>');
  const cmdNameMatch = isCommandMsg && rawText.match(/<command-name>\/?([^<]+)<\/command-name>/);
  const cmdArgsMatch = cmdNameMatch && rawText.match(/<command-args>([^<]*)<\/command-args>/);
  if (cmdNameMatch) {
    state.pendingSkillExpansion = true;
    state.lastSkillInfo = { skill: cmdNameMatch[1].trim(), args: (cmdArgsMatch?.[1] || '').trim() };
  }
  const textParts = rawText
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '')
    .trim();

  // Detect if this user message contains a Skill tool_result —
  // the NEXT text-only user message will be the expanded skill prompt
  for (const c of contentArr) {
    if (c.type === 'tool_result' && state.skillToolUseIds.has(c.tool_use_id)) {
      state.pendingSkillExpansion = true;
      state.skillToolUseIds.delete(c.tool_use_id);
    }
  }

  if (textParts) {
    const isSkillPrompt = state.pendingSkillExpansion && !hasToolResults;
    if (isSkillPrompt) state.pendingSkillExpansion = false;
    const isCronPrompt = state.inCronContext && !isSkillPrompt;
    if (isCronPrompt) state.inCronContext = false;
    const evt = {
      type: isSkillPrompt ? 'skill-prompt' : isCronPrompt ? 'cron-prompt' : 'user',
      timestamp: obj.timestamp,
      text: textParts.slice(0, T.TIMELINE),
      uuid: obj.uuid
    };
    if (isSkillPrompt && state.lastSkillInfo) {
      evt.skill = state.lastSkillInfo.skill;
      evt.args = state.lastSkillInfo.args;
    }
    state.timeline.push(evt);
  }

  // Check tool_result items for remote user input or AskUserQuestion answers
  for (const c of contentArr) {
    if (c.type === 'tool_result' && state.askQuestionIds.has(c.tool_use_id)) {
      const text = typeof c.content === 'string' ? c.content :
        Array.isArray(c.content) ? c.content.map(p => p.text || '').join(' ') : '';
      if (text.trim()) {
        state.timeline.push({
          type: 'user-answer',
          timestamp: obj.timestamp,
          text: text.slice(0, T.TIMELINE)
        });
      }
      state.askQuestionIds.delete(c.tool_use_id);
    }
    if (c.type === 'tool_result' && state.messagePollIds.has(c.tool_use_id)) {
      const text = typeof c.content === 'string' ? c.content :
        Array.isArray(c.content) ? c.content.map(p => p.text || '').join(' ') : '';
      const trimmed = text.trim();
      const isEmpty = trimmed.length <= 5 ||
        EMPTY_RESULT_PATTERNS.some(p => trimmed === p || trimmed.startsWith(p));
      const isApiResponse = (trimmed.startsWith('{') && trimmed.includes('"ok"')) ||
        (trimmed.startsWith('{') && trimmed.includes('"status"'));
      if (!isEmpty && !isApiResponse) {
        state.timeline.push({
          type: 'remote-input',
          channel: state.cronChannel,
          timestamp: obj.timestamp,
          text: text.slice(0, T.REMOTE_INPUT)
        });
      }
      state.messagePollIds.delete(c.tool_use_id);
    }
  }
}

/** Process a queue-operation (cron trigger) */
function processQueueOperation(obj, state) {
  if (MESSAGE_POLL_PATTERN.test(obj.content)) {
    state.inCronContext = true;
    state.cronChannel = detectChatChannel(obj.content);
  }
  state.timeline.push({
    type: 'cron-trigger',
    timestamp: obj.timestamp,
    text: obj.content.slice(0, T.TIMELINE)
  });
}

/** Process an assistant-type message: track tool calls, agents, todos, crons, skills */
function processAssistantMessage(obj, state) {
  state.totalAssistantMessages++;
  const msg = obj.message || {};
  const contentArr = msg.content || [];

  const toolUses = [];
  let textContent = '';

  for (const c of contentArr) {
    if (c.type === 'tool_use') {
      state.totalToolCalls++;
      toolUses.push({ tool: c.name, id: c.id, input: summarizeInput(c.name, c.input) });

      if (state.inCronContext && (c.name === 'Bash' || c.name.startsWith('mcp__'))) {
        state.messagePollIds.add(c.id);
        state.inCronContext = false;
      }

      if (c.name === 'Agent') {
        state.agents.push({
          id: c.id, description: c.input?.description || 'Sub-agent',
          subagentType: c.input?.subagent_type || 'general-purpose',
          runInBackground: c.input?.run_in_background || false,
          spawnedAt: obj.timestamp, status: 'running'
        });
      }
      if (c.name === 'TodoWrite' && c.input?.todos) {
        state.todos.length = 0;
        state.todos.push(...c.input.todos);
      }
      if (c.name === 'Skill') {
        state.skillToolUseIds.add(c.id);
        state.lastSkillInfo = { skill: c.input?.skill || '?', args: c.input?.args || '' };
        state.timeline.push({ type: 'skill', timestamp: obj.timestamp, skill: c.input?.skill || '?', args: c.input?.args || '' });
      }
      if (c.name === 'CronCreate') {
        state.cronJobs.push({
          toolUseId: c.id, cron: c.input?.cron || '', prompt: c.input?.prompt || '',
          recurring: c.input?.recurring !== false, durable: c.input?.durable || false,
          createdAt: obj.timestamp, status: 'active'
        });
      }
      if (c.name === 'CronDelete' && c.input?.id) {
        const job = state.cronJobs.find(j => j.jobId === c.input.id);
        if (job) job.status = 'deleted';
      }
      if (c.name === 'AskUserQuestion') {
        state.askQuestionIds.add(c.id);
      }
    }
    if (c.type === 'text') textContent += c.text;
  }

  state.timeline.push({
    type: 'assistant', timestamp: obj.timestamp,
    text: textContent.trim().slice(0, T.TIMELINE),
    tools: toolUses, model: msg.model, stopReason: msg.stop_reason
  });
}

/** Process tool results: update agent status and capture cron job IDs */
function processToolResults(obj, state) {
  const results = obj.message?.content?.filter(c => c.type === 'tool_result') || [];
  if (obj.type === 'tool_result' && obj.tool_use_id) {
    const agent = state.agents.find(a => a.id === obj.tool_use_id);
    if (agent) agent.status = 'completed';
    const cron = state.cronJobs.find(j => j.toolUseId === obj.tool_use_id);
    if (cron) {
      const text = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || '');
      const match = text.match(/([a-f0-9]{8})/);
      if (match) cron.jobId = match[1];
    }
  }
  for (const r of results) {
    if (r.tool_use_id) {
      const agent = state.agents.find(a => a.id === r.tool_use_id);
      if (agent) agent.status = 'completed';
      const cron = state.cronJobs.find(j => j.toolUseId === r.tool_use_id);
      if (cron) {
        const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content || '');
        const match = text.match(/([a-f0-9]{8})/);
        if (match) cron.jobId = match[1];
      }
    }
  }
}

/** Classify timeline events with content quality flags for client-side filtering */
function classifyTimelineEvents(timeline) {
  return timeline.map(evt => {
    if (evt.type === 'user') {
      evt.hasContent = true;
    } else if (evt.type === 'skill-prompt') {
      evt.hasContent = false;
      evt.isSkillPrompt = true;
    } else if (evt.type === 'remote-input') {
      evt.hasContent = true;
    } else if (evt.type === 'cron-trigger') {
      evt.hasContent = false;
      evt.isCron = true;
    } else if (evt.type === 'cron-prompt') {
      evt.hasContent = false;
      evt.isCron = true;
    } else if (evt.type === 'assistant') {
      const hasText = evt.text && evt.text.trim().length > 10;
      const hasAgent = (evt.tools || []).some(t => t.tool === 'Agent');
      const hasSkill = (evt.tools || []).some(t => t.tool === 'Skill');
      const hasMcp = (evt.tools || []).some(t => t.tool.startsWith('mcp__'));
      evt.hasContent = hasText || hasAgent || hasSkill || hasMcp;
      evt.isToolOnly = !hasText && (evt.tools || []).length > 0;
      evt.hasAgent = hasAgent;
      evt.hasMcp = hasMcp;
    } else if (evt.type === 'skill') {
      evt.hasContent = true;
    } else if (evt.type === 'user-answer') {
      evt.hasContent = true;
    }
    return evt;
  });
}

/** Full parse of a JSONL conversation file — extracts agents, todos, events */
function parseConversation(jsonlPath, recentLineCount = 200) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n');

    let title = null;
    let firstTimestamp = null;
    let lastActivity = null;

    const state = {
      totalUserMessages: 0, totalAssistantMessages: 0, totalToolCalls: 0,
      agents: [], todos: [], cronJobs: [], timeline: [],
      messagePollIds: new Set(), skillToolUseIds: new Set(), askQuestionIds: new Set(),
      inCronContext: false, cronChannel: 'remote', pendingSkillExpansion: false,
    };

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'ai-title') title = obj.aiTitle;
        if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
        if (obj.timestamp) lastActivity = obj.timestamp;

        if (obj.type === 'user') {
          processUserMessage(obj, state);
        } else if (obj.type === 'assistant') {
          processAssistantMessage(obj, state);
        }

        if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && obj.content
            && !obj.content.trimStart().startsWith('<task-notification>')) {
          processQueueOperation(obj, state);
        }

        if (obj.type === 'tool_result' || (obj.message?.content || []).some(c => c.type === 'tool_result')) {
          processToolResults(obj, state);
        }
      } catch {}
    }

    return {
      title,
      totalUserMessages: state.totalUserMessages,
      totalAssistantMessages: state.totalAssistantMessages,
      totalToolCalls: state.totalToolCalls,
      firstTimestamp,
      lastActivity,
      agents: state.agents,
      todos: state.todos,
      cronJobs: state.cronJobs.filter(j => j.status === 'active'),
      recentEvents: classifyTimelineEvents(state.timeline),
      timelineLength: state.timeline.length
    };
  } catch {
    return {
      title: null, totalUserMessages: 0, totalAssistantMessages: 0,
      totalToolCalls: 0, agents: [], todos: [], cronJobs: [], recentEvents: [], timelineLength: 0
    };
  }
}

function summarizeInput(toolName, input) {
  if (!input) return '';
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.replace(/^mcp__/, '').split('__');
    const server = parts[0] || '';
    const command = parts.slice(1).join('__') || '';
    const detail = input.intent || input.command || '';
    return `[${server}] ${command}${detail ? ': ' + detail : ''}`.slice(0, T.TOOL_INPUT);
  }
  switch (toolName) {
    case 'Bash': return input.command?.slice(0, T.BASH_CMD) || '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Grep': return `${input.pattern || ''} in ${input.path || '.'}`;
    case 'Glob': return input.pattern || '';
    case 'Agent': return `[${input.subagent_type || 'general'}] ${input.description || ''}`;
    case 'WebFetch': return input.url?.slice(0, T.URL) || '';
    case 'WebSearch': return input.query || '';
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    case 'Skill': return input.skill || '';
    case 'CronCreate': return input.prompt?.slice(0, T.CRON_PROMPT) || '';
    case 'AskUserQuestion': return (input.questions || []).map(q => q.question).join('; ').slice(0, T.TOOL_INPUT) || '';
    default: return JSON.stringify(input).slice(0, T.TOOL_INPUT);
  }
}

/** Build the full session list: metadata sessions + orphan JSONL conversations */
function buildSessionList(includeHistorical = true) {
  const metaMap = getSessionMetadata();
  const conversations = discoverAllConversations();

  const sessionsById = new Map();

  // First, add all sessions from metadata
  for (const [sid, meta] of metaMap) {
    sessionsById.set(sid, {
      sessionId: sid,
      pid: meta.pid,
      alive: isProcessRunning(meta.pid),
      cwd: meta.cwd,
      entrypoint: meta.entrypoint || meta.kind || 'unknown',
      startedAt: meta.startedAt,
      hasMetadata: true
    });
  }

  // Then, for each conversation JSONL, attach or create session entry
  const results = [];
  const seen = new Set();

  for (const conv of conversations) {
    if (seen.has(conv.sessionId)) continue;
    seen.add(conv.sessionId);

    const meta = sessionsById.get(conv.sessionId);
    const parsed = parseConversation(conv.path);

    const session = {
      sessionId: conv.sessionId,
      pid: meta?.pid || null,
      alive: meta?.alive || false,
      cwd: meta?.cwd || null,
      entrypoint: meta?.entrypoint || 'unknown',
      startedAt: meta?.startedAt || (parsed.firstTimestamp ? new Date(parsed.firstTimestamp).getTime() : conv.lastModified),
      project: conv.project,
      jsonlPath: conv.path,
      fileSizeKB: Math.round(conv.size / 1024),
      hasMetadata: !!meta,
      title: parsed.title || null,
      totalUserMessages: parsed.totalUserMessages,
      totalAssistantMessages: parsed.totalAssistantMessages,
      totalToolCalls: parsed.totalToolCalls,
      lastActivity: parsed.lastActivity,
      agents: parsed.agents,
      todos: parsed.todos,
      cronJobs: parsed.cronJobs,
      recentEvents: parsed.recentEvents,
      timelineLength: parsed.timelineLength
    };

    results.push(session);
  }

  // Add metadata-only sessions (no JSONL found)
  for (const [sid, meta] of metaMap) {
    if (!seen.has(sid)) {
      results.push({
        sessionId: sid,
        pid: meta.pid,
        alive: isProcessRunning(meta.pid),
        cwd: meta.cwd,
        entrypoint: meta.entrypoint || meta.kind || 'unknown',
        startedAt: meta.startedAt,
        project: null,
        hasMetadata: true,
        title: null,
        totalUserMessages: 0, totalAssistantMessages: 0, totalToolCalls: 0,
        agents: [], todos: [], recentEvents: [], timelineLength: 0
      });
    }
  }

  // Sort: alive first, then by last activity desc
  sortByActivity(results);

  // Merge custom session names + generate suggestions + attach AI summaries
  const names = loadSessionNames();
  for (const s of results) {
    s.customName = names[s.sessionId] || null;
    // Also use AI summary brief name as a display name fallback
    const cachedSummary = aiSummaryCache.get(s.sessionId);
    if (cachedSummary) {
      s.aiSummary = cachedSummary;
    }
    s.displayName = s.customName || cachedSummary?.briefName || s.title || s.sessionId.slice(0, T.SESSION_ID);
    s.suggestedName = suggestSessionName(s);
  }

  return includeHistorical ? results : results.filter(s => s.alive);
}

// ── Express + WebSocket ──────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Session rename API
app.put('/api/sessions/:id/name', (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
  const names = loadSessionNames();
  if (name.trim()) {
    names[req.params.id] = name.trim();
  } else {
    delete names[req.params.id]; // empty = remove custom name
  }
  saveSessionNames(names);
  res.json({ ok: true, name: names[req.params.id] || null });
});

// Session title rename — modifies the ai-title in the JSONL file (only for completed sessions)
app.put('/api/sessions/:id/title', (req, res) => {
  const { title } = req.body;
  if (typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });

  const sessions = buildSessionList(true);
  const session = sessions.find(s => s.sessionId === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.alive) return res.status(400).json({ error: 'Cannot modify title of active session — JSONL is still being written' });

  // Find the JSONL file for this session
  const conversations = discoverAllConversations();
  const conv = conversations.find(c => c.sessionId === req.params.id);
  if (!conv) return res.status(404).json({ error: 'JSONL file not found for session' });

  try {
    const content = fs.readFileSync(conv.path, 'utf8');
    const lines = content.split('\n');
    const newTitle = title.trim();
    let replaced = false;

    // Find and replace existing ai-title line
    const updatedLines = lines.map(line => {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'ai-title') {
          replaced = true;
          return JSON.stringify({ ...obj, aiTitle: newTitle });
        }
      } catch {}
      return line;
    });

    // If no ai-title line existed, prepend one
    if (!replaced && newTitle) {
      updatedLines.unshift(JSON.stringify({ type: 'ai-title', sessionId: req.params.id, aiTitle: newTitle }));
    }

    fs.writeFileSync(conv.path, updatedLines.join('\n'), 'utf8');
    res.json({ ok: true, title: newTitle });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:id/suggest-name', (req, res) => {
  const sessions = buildSessionList(true);
  const session = sessions.find(s => s.sessionId === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ suggestion: session.suggestedName });
});

// Session close (kill) API — terminates the Claude Code process
app.post('/api/sessions/:id/close', (req, res) => {
  const sessions = buildSessionList(true);
  const session = sessions.find(s => s.sessionId === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.alive) return res.status(400).json({ error: 'Session is not active' });
  if (!session.pid) return res.status(400).json({ error: 'No PID found for session' });

  try {
    process.kill(session.pid, 'SIGTERM');
    res.json({ ok: true, pid: session.pid, message: `Sent SIGTERM to PID ${session.pid}` });
  } catch (e) {
    if (e.code === 'ESRCH') {
      res.json({ ok: true, pid: session.pid, message: 'Process already terminated' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// REST API
app.get('/api/sessions', (req, res) => {
  const includeHistorical = req.query.historical !== 'false';
  const limit = parseInt(req.query.limit) || 0;
  let sessions = buildSessionList(includeHistorical);
  if (limit > 0) sessions = sessions.slice(0, limit);
  res.json(sessions);
});

app.get('/api/sessions/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
  const needle = q.toLowerCase();
  const conversations = discoverAllConversations();
  const results = [];
  for (const conv of conversations) {
    try {
      const content = fs.readFileSync(conv.path, 'utf8');
      const lower = content.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx === -1) continue;
      // Count occurrences (up to 999)
      let matches = 0;
      let pos = 0;
      while (pos < lower.length && matches < 999) {
        const found = lower.indexOf(needle, pos);
        if (found === -1) break;
        matches++;
        pos = found + needle.length;
      }
      // Extract snippet around first match
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + q.length + 60);
      const snippet = (start > 0 ? '...' : '') + content.slice(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : '');
      results.push({
        sessionId: conv.sessionId,
        project: conv.project,
        matches,
        snippet,
        lastModified: conv.lastModified
      });
      if (results.length >= 50) break;
    } catch {}
  }
  res.json(results);
});

app.get('/api/sessions/:id', (req, res) => {
  const sessions = buildSessionList(true);
  const session = sessions.find(s => s.sessionId === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Attach cached AI summary if available
  const cached = aiSummaryCache.get(req.params.id);
  if (cached) session.aiSummary = cached;
  res.json(session);
});

app.get('/api/stats', (req, res) => {
  const sessions = buildSessionList(true);
  res.json({
    totalSessions: sessions.length,
    activeSessions: sessions.filter(s => s.alive).length,
    totalMessages: sessions.reduce((s, x) => s + x.totalUserMessages + x.totalAssistantMessages, 0),
    totalToolCalls: sessions.reduce((s, x) => s + x.totalToolCalls, 0),
    totalAgentSpawns: sessions.reduce((s, x) => s + (x.agents?.length || 0), 0),
    totalActiveCronJobs: sessions.reduce((s, x) => s + (x.cronJobs?.length || 0), 0),
    projects: [...new Set(sessions.map(s => s.project).filter(Boolean))]
  });
});

app.get('/api/cron-jobs', (req, res) => {
  const sessions = buildSessionList(true);
  const allCrons = [];
  for (const s of sessions) {
    for (const cj of (s.cronJobs || [])) {
      allCrons.push({
        ...cj,
        sessionId: s.sessionId,
        sessionTitle: s.title,
        sessionAlive: s.alive,
        project: s.project
      });
    }
  }
  res.json(allCrons);
});

// ── Settings & Memory APIs ─────────────────────────────

const GLOBAL_SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const GLOBAL_CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const GLOBAL_CLAUDE_LOCAL_MD = path.join(CLAUDE_DIR, 'CLAUDE.local.md');

/** Read a JSON file safely */
function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/** Read a text file safely */
function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/** Parse YAML-like frontmatter from a markdown file's content.
 *  Returns { meta: { key: value, ... }, body: string } */
function parseFrontmatter(content) {
  if (!content) return { meta: {}, body: '' };
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content.trim() };
  const meta = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: fmMatch[2].trim() };
}

/** Convert project slug to display name (last segment after --) */
function displayNameFromSlug(slug) {
  return slug.split('--').pop();
}

/** Read Copilot custom agents from ~/.copilot/agents/ */
function readCopilotAgents() {
  const agents = [];
  for (const f of safeReadDir(COPILOT_AGENTS_DIR, '.md')) {
    const content = readTextFile(path.join(COPILOT_AGENTS_DIR, f));
    if (!content) continue;
    const { meta } = parseFrontmatter(content);
    agents.push({
      name: meta.name || f.replace('.md', ''),
      file: f,
      description: meta.description || '',
      path: path.join(COPILOT_AGENTS_DIR, f)
    });
  }
  return agents;
}

/** Discover all project directories under ~/.claude/projects/ */
function discoverProjects() {
  const projects = [];
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory()) {
        projects.push({ slug: dir, path: dirPath });
      }
    }
  } catch {}
  return projects;
}

/** Mask sensitive values in env/settings */
function maskSensitive(obj) {
  if (!obj) return obj;
  const masked = { ...obj };
  const sensitiveKeys = /token|secret|key|password|auth/i;
  for (const [k, v] of Object.entries(masked)) {
    if (sensitiveKeys.test(k) && typeof v === 'string') {
      masked[k] = v.slice(0, 4) + '***' + v.slice(-4);
    }
  }
  return masked;
}

/** Mask sensitive env values in MCP server configs */
function maskMcpEnv(servers) {
  const result = {};
  for (const [name, config] of Object.entries(servers)) {
    result[name] = { ...config };
    if (config.env) result[name].env = maskSensitive(config.env);
  }
  return result;
}

/** Parse a memory .md file with YAML frontmatter into a structured object */
function parseMemoryFile(filePath, projectSlug) {
  const content = readTextFile(filePath);
  if (!content) return null;
  const f = path.basename(filePath);
  const displayProject = displayNameFromSlug(projectSlug);

  if (f === 'MEMORY.md') {
    return { project: projectSlug, displayProject, file: f, isIndex: true, content, path: filePath };
  }

  const { meta, body } = parseFrontmatter(content);

  return {
    project: projectSlug, displayProject, file: f, isIndex: false,
    name: meta.name || f.replace('.md', ''),
    type: meta.type || 'unknown',
    description: meta.description || '',
    body,
    path: filePath
  };
}

/** Resolve a session's cwd to find the repo-level .claude directory */
function findRepoClaudeDir(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  // Walk up to find .claude directory (max 5 levels)
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.claude');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// GET /api/projects — returns all projects with their settings, memory, MCP, CLAUDE.md
app.get('/api/projects', (req, res) => {
  const globalSettings = readJsonFile(GLOBAL_SETTINGS_FILE);
  const globalClaudeMd = readTextFile(GLOBAL_CLAUDE_MD);
  const globalClaudeLocalMd = readTextFile(GLOBAL_CLAUDE_LOCAL_MD);
  const globalClaudeJson = readJsonFile(GLOBAL_CLAUDE_JSON);
  const globalMcpServers = globalClaudeJson?.mcpServers || {};

  if (globalSettings?.env) globalSettings.env = maskSensitive(globalSettings.env);

  const projects = discoverProjects();
  const projectList = projects.map(proj => {
    const projSettings = readJsonFile(path.join(proj.path, 'settings.json'));
    const memDir = path.join(proj.path, 'memory');
    let memoryCount = 0;
    let memories = [];
    if (fs.existsSync(memDir)) {
      const files = safeReadDir(memDir, '.md');
      memoryCount = files.filter(f => f !== 'MEMORY.md').length;
      memories = files.map(f => parseMemoryFile(path.join(memDir, f), proj.slug)).filter(Boolean);
    }

    // MCP from project settings
    const projectMcp = projSettings?.mcpServers || {};

    // Project-level instructions (CLAUDE.md, copilot-instructions.md)
    const workDir = slugToPath(proj.slug);
    let projectClaudeMd = null, projectClaudeMdPath = null;
    let projectCopilotInstructions = null, projectCopilotInstructionsPath = null;
    if (workDir) {
      // CLAUDE.md — check both repo root and .claude/ dir
      const claudeDir = findRepoClaudeDir(workDir);
      if (claudeDir) {
        const candidates = [
          path.join(claudeDir, 'CLAUDE.md'),                  // .claude/CLAUDE.md
          path.join(path.dirname(claudeDir), 'CLAUDE.md')     // repo-root/CLAUDE.md
        ];
        for (const cmdPath of candidates) {
          const content = readTextFile(cmdPath);
          if (content) {
            projectClaudeMd = content;
            projectClaudeMdPath = cmdPath;
            break;
          }
        }
      }
      // .github/copilot-instructions.md
      const copilotInstPath = path.join(workDir, '.github', 'copilot-instructions.md');
      const copilotContent = readTextFile(copilotInstPath);
      if (copilotContent) {
        projectCopilotInstructions = copilotContent;
        projectCopilotInstructionsPath = copilotInstPath;
      }
    }

    return {
      slug: proj.slug,
      displayName: displayNameFromSlug(proj.slug),
      settings: projSettings,
      memoryCount,
      memories,
      mcpServers: maskMcpEnv(projectMcp),
      claudeMd: projectClaudeMd,
      claudeMdPath: projectClaudeMdPath,
      claudeMdLines: projectClaudeMd ? projectClaudeMd.split('\n').length : 0,
      copilotInstructions: projectCopilotInstructions,
      copilotInstructionsPath: projectCopilotInstructionsPath,
      copilotInstructionsLines: projectCopilotInstructions ? projectCopilotInstructions.split('\n').length : 0
    };
  });

  res.json({
    global: {
      settings: globalSettings,
      settingsPath: GLOBAL_SETTINGS_FILE,
      claudeMd: globalClaudeMd,
      claudeMdPath: GLOBAL_CLAUDE_MD,
      claudeMdLines: globalClaudeMd ? globalClaudeMd.split('\n').length : 0,
      claudeLocalMd: globalClaudeLocalMd,
      claudeLocalMdPath: GLOBAL_CLAUDE_LOCAL_MD,
      claudeLocalMdLines: globalClaudeLocalMd ? globalClaudeLocalMd.split('\n').length : 0,
      mcpServers: maskMcpEnv(globalMcpServers),
      mcpServersPath: GLOBAL_CLAUDE_JSON
    },
    projects: projectList
  });
});

// GET /api/settings — returns global + project-specific settings
// Accepts ?project=slug&cwd=path to scope to a specific project
app.get('/api/settings', (req, res) => {
  const projectSlug = req.query.project;
  const sessionCwd = req.query.cwd;

  const globalSettings = readJsonFile(GLOBAL_SETTINGS_FILE);
  const globalClaudeMd = readTextFile(GLOBAL_CLAUDE_MD);

  // Mask env values
  if (globalSettings?.env) {
    globalSettings.env = maskSensitive(globalSettings.env);
  }

  // Discover project-level settings (scoped to requested project if provided)
  const projects = discoverProjects();
  const projectConfigs = [];
  for (const proj of projects) {
    if (projectSlug && proj.slug !== projectSlug) continue;
    const localSettings = readJsonFile(path.join(proj.path, 'settings.json'));
    projectConfigs.push({
      slug: proj.slug,
      displayName: displayNameFromSlug(proj.slug),
      settings: localSettings,
      hasMemory: fs.existsSync(path.join(proj.path, 'memory'))
    });
  }

  // Resolve repo-level .claude from session's cwd
  let repoSettings = null;
  let repoClaudeMd = null;
  let repoClaudeDir = null;
  if (sessionCwd) {
    repoClaudeDir = findRepoClaudeDir(sessionCwd);
  }
  if (repoClaudeDir) {
    try {
      repoSettings = readJsonFile(path.join(repoClaudeDir, 'settings.local.json'));
      repoClaudeMd = readTextFile(path.join(repoClaudeDir, 'CLAUDE.md'));
    } catch {}
  }

  // Read MCP server configs from ~/.claude.json and project-level settings
  const globalClaudeJson = readJsonFile(GLOBAL_CLAUDE_JSON);
  const globalMcpServers = globalClaudeJson?.mcpServers || {};

  // Check project-level MCP servers (from project settings.json under mcpServers key)
  let projectMcpServers = {};
  if (projectSlug) {
    const projPath = path.join(PROJECTS_DIR, projectSlug, 'settings.json');
    const projSettings = readJsonFile(projPath);
    if (projSettings?.mcpServers) projectMcpServers = projSettings.mcpServers;
  }
  // Also check repo-level .claude.json for MCP servers
  let repoMcpServers = {};
  if (sessionCwd) {
    const repoClaudeJson = path.join(sessionCwd, '.claude.json');
    const repoData = readJsonFile(repoClaudeJson);
    if (repoData?.mcpServers) repoMcpServers = repoData.mcpServers;
  }

  res.json({
    global: {
      settings: globalSettings,
      settingsPath: GLOBAL_SETTINGS_FILE,
      claudeMd: globalClaudeMd,
      claudeMdPath: GLOBAL_CLAUDE_MD,
      claudeMdLines: globalClaudeMd ? globalClaudeMd.split('\n').length : 0,
      mcpServers: maskMcpEnv(globalMcpServers),
      mcpServersPath: GLOBAL_CLAUDE_JSON
    },
    repo: {
      settings: repoSettings,
      settingsPath: repoClaudeDir ? path.join(repoClaudeDir, 'settings.local.json') : null,
      claudeMd: repoClaudeMd ? repoClaudeMd.slice(0, T.REPO_CLAUDE_MD) + (repoClaudeMd.length > T.REPO_CLAUDE_MD ? '\n... (truncated)' : '') : null,
      claudeMdPath: repoClaudeDir ? path.join(repoClaudeDir, 'CLAUDE.md') : null,
      claudeMdLines: repoClaudeMd ? repoClaudeMd.split('\n').length : 0,
      mcpServers: maskMcpEnv(repoMcpServers)
    },
    projects: projectConfigs,
    projectMcpServers: maskMcpEnv(projectMcpServers)
  });
});

// GET /api/memory — returns memory, optionally scoped to a project
// Accepts ?project=slug to filter to a specific project
app.get('/api/memory', (req, res) => {
  const projectSlug = req.query.project;
  const projects = discoverProjects();
  const allMemory = [];

  for (const proj of projects) {
    if (projectSlug && proj.slug !== projectSlug) continue;
    const memDir = path.join(proj.path, 'memory');
    if (!fs.existsSync(memDir)) continue;

    for (const f of safeReadDir(memDir, '.md')) {
      const parsed = parseMemoryFile(path.join(memDir, f), proj.slug);
      if (parsed) allMemory.push(parsed);
    }
  }

  res.json(allMemory);
});

// DELETE /api/memory — delete a memory file
app.delete('/api/memory', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !filePath.includes('.claude')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  // Safety: only allow deleting files under ~/.claude/projects/*/memory/
  const normalized = path.resolve(filePath);
  if (!normalized.includes(path.join('.claude', 'projects')) || !normalized.includes('memory')) {
    return res.status(403).json({ error: 'Can only delete memory files' });
  }
  try {
    fs.unlinkSync(normalized);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/memory — update a memory file's content
app.put('/api/memory', (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath || !filePath.includes('.claude') || typeof content !== 'string') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const normalized = path.resolve(filePath);
  if (!normalized.includes(path.join('.claude', 'projects')) || !normalized.includes('memory')) {
    return res.status(403).json({ error: 'Can only edit memory files' });
  }
  try {
    fs.writeFileSync(normalized, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/global — update global CLAUDE.md
app.put('/api/settings/global-claude-md', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    fs.writeFileSync(GLOBAL_CLAUDE_MD, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI Summary via claude -p
// ── AI Summary Persistence ─────────────────────────────
function loadAISummaries() {
  try {
    return JSON.parse(fs.readFileSync(AI_SUMMARIES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAISummary(sessionId, data) {
  try {
    if (!fs.existsSync(AI_SUMMARIES_DIR)) fs.mkdirSync(AI_SUMMARIES_DIR, { recursive: true });
    const all = loadAISummaries();
    all[sessionId] = data;
    fs.writeFileSync(AI_SUMMARIES_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.error('[AI Summary] Failed to save:', e.message);
  }
}

const aiSummaryCache = new Map(); // in-memory hot cache
// Pre-load from disk on startup
(() => {
  const saved = loadAISummaries();
  for (const [id, data] of Object.entries(saved)) aiSummaryCache.set(id, data);
  console.log(`[AI Summary] Loaded ${Object.keys(saved).length} cached summaries from disk`);
})();

app.post('/api/sessions/:id/ai-summary', async (req, res) => {
  const sessions = buildSessionList(true);
  const session = sessions.find(s => s.sessionId === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Check cache (valid for 10 min)
  const cached = aiSummaryCache.get(req.params.id);
  if (cached && (Date.now() - cached.generatedAt < AI_SUMMARY_CACHE_TTL_MS) && !req.body.force) {
    return res.json(cached);
  }

  // Build context from session events
  const events = session.recentEvents || [];
  const userMsgs = events
    .filter(e => e.type === 'user' || e.type === 'remote-input')
    .map(e => e.text || '')
    .filter(t => t.length > 5);
  const assistantMsgs = events
    .filter(e => e.type === 'assistant' && e.text && e.text.length > 10)
    .map(e => e.text);
  const todos = (session.todos || []).map(t => `[${t.status}] ${t.content}`);
  const agents = (session.agents || []).map(a => `${a.subagentType}: ${a.description} (${a.status})`);

  // Take a representative sample to fit in prompt
  const sampleUser = userMsgs.slice(0, 15).join('\n---\n');
  const sampleAssistant = assistantMsgs.slice(0, 10).join('\n---\n');
  const todoList = todos.join('\n');
  const agentList = agents.slice(0, 10).join('\n');

  const contextText = [
    `Session: ${session.title || session.sessionId}`,
    `Project: ${session.project || 'unknown'}`,
    `Messages: ${session.totalUserMessages} user, ${session.totalAssistantMessages} assistant`,
    `Tool calls: ${session.totalToolCalls}`,
    `Agents: ${(session.agents || []).length}`,
    '',
    '=== User Messages (sample) ===',
    sampleUser,
    '',
    '=== Assistant Responses (sample) ===',
    sampleAssistant,
    '',
    todos.length > 0 ? '=== Tasks ===\n' + todoList : '',
    agents.length > 0 ? '=== Sub-Agents ===\n' + agentList : ''
  ].filter(Boolean).join('\n');

  const prompt = `You are analyzing a Claude Code session transcript. Provide THREE sections in your response:

## Brief Name
A short name (under 60 characters) for this session that captures its main purpose. Examples: "Hypernet migration planning", "Code review skill refactor", "Dashboard AI summary feature". No quotes, no period.

## Summary
A concise summary (3-5 sentences) of what this session accomplished. Focus on the user's goals and what was delivered.

## Lessons Learned
List 2-5 key lessons or insights from this session that would be useful for future work. Focus on:
- Non-obvious decisions or approaches that worked well
- Problems encountered and how they were solved
- Patterns or techniques worth reusing

Keep the total response under 400 words. Use plain text, no markdown headers beyond the three section headers above. Always respond in English regardless of the language used in the session.

=== SESSION DATA ===
${contextText}`;

  try {
    const child = spawn('claude', ['-p', '--max-turns', '1'], {
      shell: true,
      env: { ...process.env },
      cwd: os.homedir(),
      timeout: 120000
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('[AI Summary] claude -p exited with code', code, stderr);
        return res.status(500).json({ error: 'claude -p failed (exit ' + code + '): ' + stderr.slice(0, T.STDERR) });
      }

      const output = stdout.trim();
      // Parse sections
      let briefName = '';
      let summary = output;
      let lessons = '';
      const briefMatch = output.match(/##\s*Brief\s*Name\s*\n([\s\S]*?)(?=##\s*Summary|$)/i);
      const summaryMatch = output.match(/##\s*Summary\s*\n([\s\S]*?)(?=##\s*Lessons|$)/i);
      const lessonsMatch = output.match(/##\s*Lessons?\s*Learned?([\s\S]*?)$/i);
      if (briefMatch) briefName = briefMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, T.BRIEF_NAME);
      if (summaryMatch) summary = summaryMatch[1].trim();
      if (lessonsMatch) lessons = lessonsMatch[1].trim();

      const result = { briefName, summary, lessons, generatedAt: Date.now(), sessionId: req.params.id };
      aiSummaryCache.set(req.params.id, result);
      saveAISummary(req.params.id, result);
      res.json(result);
    });

    child.on('error', (err) => {
      console.error('[AI Summary] spawn error:', err);
      res.status(500).json({ error: err.message });
    });

    // Send prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude CLI Status ─────────────────────────────────
app.get('/api/claude-cli-status', (req, res) => {
  if (!claudeCliStatus.checkedAt || req.query.refresh) checkClaudeCli();
  res.json({
    ...claudeCliStatus,
    installInstructions: claudeCliStatus.available ? null : {
      npm: 'npm install -g @anthropic-ai/claude-code',
      info: 'https://docs.anthropic.com/en/docs/claude-code'
    }
  });
});

// WebSocket: push updates
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  const sendUpdate = () => {
    if (ws.readyState === ws.OPEN) {
      // Only send active sessions + recent 20 historical for live updates
      const active = buildSessionList(true).slice(0, WS_MAX_SESSIONS);
      ws.send(JSON.stringify({ type: 'sessions', data: active }));
    }
  };
  sendUpdate();
  const interval = setInterval(sendUpdate, WS_PUSH_INTERVAL_MS);
  ws.on('close', () => { clearInterval(interval); console.log('[WS] Client disconnected'); });
});

// ── Skills & Commands APIs ─────────────────────────────

const CLAUDE_BUILTIN_COMMANDS = [
  { name: '/help', description: 'Get help with using Claude Code' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Compact conversation to save context' },
  { name: '/config', description: 'View/modify configuration' },
  { name: '/cost', description: 'Show token usage and cost for this session' },
  { name: '/doctor', description: 'Check Claude Code installation health' },
  { name: '/init', description: 'Initialize project with CLAUDE.md' },
  { name: '/login', description: 'Switch accounts or auth method' },
  { name: '/logout', description: 'Sign out of current account' },
  { name: '/memory', description: 'View or edit CLAUDE.md instructions' },
  { name: '/model', description: 'Switch AI model' },
  { name: '/permissions', description: 'View or update tool permissions' },
  { name: '/review', description: 'Review a pull request' },
  { name: '/status', description: 'Show current session status' },
  { name: '/terminal-setup', description: 'Install shell integration (Shift+Enter)' },
  { name: '/vim', description: 'Toggle vim keybindings' },
  { name: '/bug', description: 'Report a bug' }
];

const COPILOT_BUILTIN_COMMANDS = [
  { name: '/explain', description: 'Explain selected code' },
  { name: '/fix', description: 'Fix problems in selected code' },
  { name: '/tests', description: 'Generate tests for selected code' },
  { name: '/doc', description: 'Generate documentation' },
  { name: '/generate', description: 'Generate code based on prompt' },
  { name: '/optimize', description: 'Optimize selected code' },
  { name: '/new', description: 'Scaffold a new project or file' },
  { name: '/newNotebook', description: 'Create a new Jupyter notebook' },
  { name: '/search', description: 'Search workspace for relevant code' },
  { name: '/setupTests', description: 'Set up testing framework' },
  { name: '/startDebugging', description: 'Start debugging session' },
  { name: '/runCommand', description: 'Run a VS Code command' }
];

const COPILOT_BUILTIN_PARTICIPANTS = [
  { name: '@workspace', description: 'Ask about your workspace and code' },
  { name: '@terminal', description: 'Ask about terminal commands and output' },
  { name: '@vscode', description: 'Ask about VS Code features and settings' },
  { name: '@github', description: 'Ask about GitHub repos, issues, and PRs' }
];

/** Read skill/command .md files from a directory */
function readCommandFiles(dirPath) {
  const commands = [];
  for (const f of safeReadDir(dirPath, '.md')) {
    const content = readTextFile(path.join(dirPath, f));
    if (!content) continue;
    const name = f.replace(/\.md$/, '').replace(/\.prompt$/, '');
    const { meta } = parseFrontmatter(content);
    let description = meta.description || '';
    // If no frontmatter description, use first non-empty line as description
    if (!description) {
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
      if (firstLine) description = firstLine.trim().slice(0, T.DESC);
    }
    commands.push({ name: '/' + name, file: f, description, path: path.join(dirPath, f) });
  }
  return commands;
}

/** Convert a project slug (e.g. 'q--src-AdsAppsMT') to an actual filesystem path.
 *  Slug format: segments joined by '--', where first segment is the drive letter (on Windows).
 *  Within each segment, '-' may represent either a literal '-' or a path separator '/'.
 *  We try the most likely interpretation: replace '--' with '/' for the drive separator,
 *  then for remaining '-' characters, try replacing them with '/' and check if the path exists. */
function slugToPath(slug) {
  // Split on '--' to get segments
  const parts = slug.split('--');
  if (parts.length < 2) return null;
  const drive = parts[0]; // e.g. 'q' or 'C'
  // Reconstruct: first try simply joining remaining parts with path.sep
  // parts[1..n] each represent a directory name, with internal '-' being literal
  const candidate = drive + ':/' + parts.slice(1).join('/');
  if (fs.existsSync(candidate)) return candidate;

  // If that doesn't exist, try replacing '-' with '/' in each part
  // This handles cases like 'Users-lying' -> 'Users/lying'
  const expanded = parts.slice(1).map(p => p.replace(/-/g, '/'));
  const candidate2 = drive + ':/' + expanded.join('/');
  if (fs.existsSync(candidate2)) return candidate2;

  return null;
}

/** Discover all project working directories from project slugs */
function discoverProjectWorkDirs() {
  return discoverProjects()
    .map(p => ({ slug: p.slug, workDir: slugToPath(p.slug) }))
    .filter(p => p.workDir && fs.existsSync(p.workDir));
}

// GET /api/claude-code/skills — Claude Code slash commands & skills by scope
app.get('/api/claude-code/skills', (req, res) => {
  const globalCmdsDir = path.join(CLAUDE_DIR, 'commands');

  // Scan all known projects for .claude/commands/
  const projectSkills = [];
  for (const { slug, workDir } of discoverProjectWorkDirs()) {
    const cmdsDir = path.join(workDir, '.claude', 'commands');
    const cmds = readCommandFiles(cmdsDir);
    if (cmds.length > 0) {
      projectSkills.push({ project: displayNameFromSlug(slug), dir: cmdsDir, commands: cmds });
    }
  }

  res.json({
    builtin: CLAUDE_BUILTIN_COMMANDS,
    projects: projectSkills,
    global: readCommandFiles(globalCmdsDir),
    globalDir: globalCmdsDir
  });
});

// GET /api/copilot/skills — Copilot slash commands & prompts by scope
app.get('/api/copilot/skills', (req, res) => {
  // Scan all known projects for .github/prompts/
  const projectPrompts = [];
  for (const { slug, workDir } of discoverProjectWorkDirs()) {
    const promptsDir = path.join(workDir, '.github', 'prompts');
    const prompts = [];
    for (const f of safeReadDir(promptsDir, '.prompt.md')) {
      const content = readTextFile(path.join(promptsDir, f));
      let description = '';
      if (content) {
        const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
        if (firstLine) description = firstLine.trim().slice(0, T.DESC);
      }
      prompts.push({ name: '#' + f.replace('.prompt.md', ''), file: f, description, path: path.join(promptsDir, f) });
    }
    if (prompts.length > 0) {
      projectPrompts.push({ project: displayNameFromSlug(slug), dir: promptsDir, commands: prompts });
    }
  }

  // Custom agents from ~/.copilot/agents/
  const agents = readCopilotAgents().map(a => ({ ...a, name: '@' + a.name }));

  res.json({
    builtinCommands: COPILOT_BUILTIN_COMMANDS,
    builtinParticipants: COPILOT_BUILTIN_PARTICIPANTS,
    projects: projectPrompts,
    global: agents,
    globalDir: COPILOT_AGENTS_DIR
  });
});

// ── Copilot Session Support ────────────────────────────

/** Parse a Copilot agent-mode JSONL session file */
function parseCopilotSession(jsonlPath) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n');

    let sessionId = null, model = null, startTime = null, lastActivity = null;
    let totalUserMessages = 0, totalAssistantMessages = 0, totalToolCalls = 0;
    const timeline = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.timestamp) lastActivity = obj.timestamp;

        switch (obj.type) {
          case 'session.start':
            sessionId = obj.data?.sessionId;
            model = obj.data?.selectedModel;
            startTime = obj.data?.startTime || obj.timestamp;
            break;
          case 'session.model_change':
            model = obj.data?.newModel;
            break;
          case 'user.message':
            totalUserMessages++;
            timeline.push({
              type: 'user',
              timestamp: obj.timestamp,
              text: (obj.data?.content || '').slice(0, T.TIMELINE)
            });
            break;
          case 'assistant.message':
            totalAssistantMessages++;
            timeline.push({
              type: 'assistant',
              timestamp: obj.timestamp,
              text: (obj.data?.content || '').slice(0, T.TIMELINE),
              hasContent: (obj.data?.content || '').trim().length > 10
            });
            break;
          case 'tool.execution_start':
            totalToolCalls++;
            timeline.push({
              type: 'assistant',
              timestamp: obj.timestamp,
              text: '',
              tools: [{ tool: obj.data?.toolName || '?', input: JSON.stringify(obj.data?.arguments || {}).slice(0, T.TOOL_INPUT) }],
              isToolOnly: true
            });
            break;
        }
      } catch {}
    }

    return {
      sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
      model,
      startTime,
      lastActivity,
      totalUserMessages,
      totalAssistantMessages,
      totalToolCalls,
      recentEvents: timeline
    };
  } catch {
    return null;
  }
}

/** Build list of all Copilot agent-mode sessions */
function buildCopilotSessionList() {
  const results = [];
  for (const f of safeReadDir(COPILOT_SESSION_STATE_DIR, '.jsonl')) {
    const fullPath = path.join(COPILOT_SESSION_STATE_DIR, f);
    const stat = fs.statSync(fullPath);
    const parsed = parseCopilotSession(fullPath);
    if (!parsed) continue;

    results.push({
      sessionId: parsed.sessionId,
      alive: false, // Copilot agent sessions don't have persistent PIDs we can check
      entrypoint: 'copilot-agent',
      startedAt: parsed.startTime ? new Date(parsed.startTime).getTime() : stat.mtimeMs,
      model: parsed.model,
      fileSizeKB: Math.round(stat.size / 1024),
      totalUserMessages: parsed.totalUserMessages,
      totalAssistantMessages: parsed.totalAssistantMessages,
      totalToolCalls: parsed.totalToolCalls,
      lastActivity: parsed.lastActivity,
      recentEvents: parsed.recentEvents,
      displayName: parsed.recentEvents.find(e => e.type === 'user')?.text?.slice(0, T.DISPLAY_NAME) || parsed.sessionId.slice(0, T.SESSION_ID)
    });
  }

  sortByActivity(results);
  return results;
}

/** Build Copilot settings/config data */
function buildCopilotSettings() {
  const config = readJsonFile(COPILOT_CONFIG);
  const mcpConfig = readJsonFile(COPILOT_MCP_CONFIG);
  const mcpServers = mcpConfig?.mcpServers || {};

  // Custom agents
  const agents = readCopilotAgents();

  // Copilot instructions from all known projects
  const projectInstructions = [];
  for (const { slug, workDir } of discoverProjectWorkDirs()) {
    const instrPaths = [
      path.join(workDir, '.github', 'copilot-instructions.md'),
      path.join(workDir, 'copilot-instructions.md')
    ];
    for (const p of instrPaths) {
      const content = readTextFile(p);
      if (content) {
        projectInstructions.push({
          project: displayNameFromSlug(slug),
          content: content.slice(0, T.LONG_CONTENT) + (content.length > T.LONG_CONTENT ? '\n... (truncated)' : ''),
          path: p,
          lines: content.split('\n').length
        });
        break;
      }
    }
  }

  // Reusable prompts from all known projects
  const prompts = [];
  const promptsDirs = [];
  for (const { slug, workDir } of discoverProjectWorkDirs()) {
    const promptsDir = path.join(workDir, '.github', 'prompts');
    const files = safeReadDir(promptsDir, '.prompt.md');
    for (const f of files) {
      prompts.push({ file: f, name: f.replace('.prompt.md', ''), path: path.join(promptsDir, f), project: displayNameFromSlug(slug) });
    }
    if (files.length > 0) promptsDirs.push(promptsDir);
  }

  return {
    config,
    configPath: COPILOT_CONFIG,
    mcpServers: maskMcpEnv(mcpServers),
    mcpConfigPath: COPILOT_MCP_CONFIG,
    agents,
    agentsDir: COPILOT_AGENTS_DIR,
    projectInstructions,
    prompts,
    promptsDirs
  };
}

// GET /api/copilot/sessions
app.get('/api/copilot/sessions', (req, res) => {
  res.json(buildCopilotSessionList());
});

// GET /api/copilot/settings
app.get('/api/copilot/settings', (req, res) => {
  res.json(buildCopilotSettings());
});

// GET /api/agents — returns list of available AI agents with status
app.get('/api/agents', (req, res) => {
  const claudeSessions = buildSessionList(true);
  const copilotSessions = buildCopilotSessionList();

  const sessionCounts = {
    'claude-code': { active: claudeSessions.filter(s => s.alive).length, total: claudeSessions.length },
    'github-copilot': { active: 0, total: copilotSessions.length },
  };

  res.json(AGENT_DEFINITIONS.map(def => ({
    ...def,
    activeSessions: sessionCounts[def.id]?.active || 0,
    totalSessions: sessionCounts[def.id]?.total || 0,
  })));
});

// Start server only when run directly (not when imported by tests)
if (require.main === module) {
  checkClaudeCli(); // Check claude CLI availability at startup
  server.listen(PORT, () => {
    const sessions = buildSessionList(true);
    console.log(`\n  AgentPulse — AI Agent Management Dashboard`);
    console.log(`  ──────────────────────────────────────────`);
    console.log(`  Local:    http://localhost:${PORT}`);
    console.log(`  Sessions: ${sessions.filter(s => s.alive).length} active / ${sessions.length} total`);
    console.log(`  Projects: ${[...new Set(sessions.map(s => s.project).filter(Boolean))].join(', ')}`);
    console.log(`  Claude:   ${claudeCliStatus.available ? 'v' + claudeCliStatus.version : '✗ not found — install: npm i -g @anthropic-ai/claude-code'}\n`);
  });
}

module.exports = {
  isProcessRunning,
  parseConversation,
  summarizeInput,
  suggestSessionName,
  loadSessionNames,
  saveSessionNames,
  maskSensitive,
  maskMcpEnv,
  parseFrontmatter,
  displayNameFromSlug,
  readCopilotAgents,
  parseMemoryFile,
  findRepoClaudeDir,
  buildSessionList,
  parseCopilotSession,
  buildCopilotSessionList,
  buildCopilotSettings,
  slugToPath,
  discoverProjectWorkDirs,
  readCommandFiles,
  checkClaudeCli,
  app,
  server,
  PORT
};
