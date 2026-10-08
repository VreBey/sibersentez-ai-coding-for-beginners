// An app job's id on the page (server/job-id.mjs issues it: J and 32 hex digits). One rule for every reader, so the
// Building (views/job.js) and the terminal (dockState.js) never disagree on what names a job.
export const JOB_ID_RE = /^J[0-9a-f]{32}$/;
export const validJobId = (id) => typeof id === 'string' && JOB_ID_RE.test(id);
// The job a session was started for (the server reads it from the first prompt before redaction: ingest jobId)
export const sessionJobId = (s) => (validJobId(s?.jobId) ? s.jobId : null);

// The AI tools whose sessions the server reads (Claude Code's own logs, server/toolLogs.mjs for the others) and that
// can continue a session where it stopped (server/tools.mjs resume): one list for the drawer, the menu, the job box
// and the terminal. A session says its tool (claude when the server is older).
export const SESSION_TOOL_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen Code', copilot: 'Copilot CLI', opencode: 'OpenCode', cursor: 'Cursor CLI' });
// Continued where it stopped by the server's start-ai (a UUID session id): OpenCode's ids (ses_...) are not, so its
// sessions are shown but not continued from here
const CONTINUE_TOOLS = new Set(['claude', 'codex', 'gemini', 'qwen', 'copilot', 'cursor']);
export const sessionTool = (s) => (typeof s?.tool === 'string' && s.tool ? s.tool : 'claude');
export const sessionToolName = (s) => SESSION_TOOL_NAMES[sessionTool(s)] || sessionTool(s);
export const canContinueTool = (tool) => CONTINUE_TOOLS.has(tool || 'claude');
