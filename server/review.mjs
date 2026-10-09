// @ts-check
// Review of a skill or agent before it enters the library (docs/github-import.md §4). Three questions per item:
//   - Is it safe? Script and program files, a broad shell grant in the frontmatter, dangerous command patterns, prompt
//     injection wording, hidden instructions (HTML comments, invisible characters), network use and key formats.
//   - What is its license? The item's frontmatter `license`, a license file in the item folder, else the repository's.
//   - (Which project it fits is answered by server/fit.mjs projectsFor.)
// The answer is a level (ok, caution, danger) and short English reason codes the page localizes; a reason names the
// first file and line it was seen in (paths relative to the item, never absolute).
//
// Read-only: nothing is run, nothing is written, no link is followed. Every walk reads the entry type itself and
// skips links; a file larger than REVIEW_LIMITS.maxFileBytes is read up to that size only.
// What is reviewed is what an import copies: the vendored folders (.git, node_modules) are never copied into the
// library (library.mjs VENDORED_DIRS), so the review does not read them either and says they were left out.
// Pure module: node built-ins and library.mjs (its vendored-folder rule) only.
import fs from 'node:fs';
import path from 'node:path';
import { isVendoredDir } from './library.mjs';

const RANK = { ok: 0, caution: 1, danger: 2 };
// Files read per item, bytes read per file and in all; a text file above maxFileBytes is scanned up to it
export const REVIEW_LIMITS = Object.freeze({ maxFiles: 500, maxFileBytes: 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxDepth: 16 });
// Frontmatter bytes read for allowed-tools, tools, license, hooks and mcpServers (a long description cannot push a key
// out of sight)
const HEAD_BYTES = 64 * 1024;
const BINARY_PROBE = 8000;

// ---------------------------------------------------------------------------------------------------------------
// File classes
// ---------------------------------------------------------------------------------------------------------------

// Scripts an interpreter runs as they are (a finding: caution)
const SCRIPT_EXTS = Object.freeze(['.sh', '.bash', '.zsh', '.fish', '.ksh', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.py', '.pyw', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.rb', '.pl', '.php', '.lua', '.vbs', '.vbe', '.wsf', '.jse', '.ahk', '.applescript', '.scpt', '.command', '.r', '.tcl', '.awk']);
// Programs and libraries that cannot be read (a finding: danger)
const BINARY_EXTS = Object.freeze(['.exe', '.dll', '.msi', '.msp', '.scr', '.com', '.sys', '.cpl', '.ocx', '.so', '.dylib', '.jar', '.class', '.pyc', '.pyo', '.node', '.apk', '.deb', '.rpm', '.pkg', '.dmg', '.app', '.appx', '.msix', '.lnk', '.hta', '.reg']);
// Files read as text besides the scripts; any other file is read only when it has no NUL byte in its first bytes
const TEXT_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.yaml', '.yml', '.json', '.jsonc', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm', '.csv', '.tsv', '.env', '.properties', '.gradle', '.make', '.mk', '.dockerfile', '.gitignore', '']);
// Archives and disk images: what they hold cannot be reviewed without unpacking (a finding: caution)
const ARCHIVE_EXTS = Object.freeze(['.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.cab', '.iso', '.xz', '.bz2', '.tbz', '.tbz2', '.txz', '.zst', '.lz', '.lzma', '.z', '.cpio', '.img', '.vhd', '.vhdx', '.wim']);
// Media, fonts and office documents: never read (their bytes say nothing a person reads). Their first bytes are still
// checked for a program header: a program under an image name is a danger.
const SKIP_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.psd', '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.webm', '.avi', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.html', '.htm']);

// ---------------------------------------------------------------------------------------------------------------
// Patterns (a line of text at a time). level: what one hit weighs. In a document (not a script), outside a code
// block, a danger weighs one level less when a word that says not to do it ("never", "do not", "asla", ...) stands
// right before it in the same sentence (NEGATION_NEAR characters at most). A pattern with nosoft never weighs less:
// no warning makes running a download, an encoded command, a permission bypass, an autostart entry or a settings hook
// safe to copy along. An injection phrase (hard) weighs less only inside a real pair of quotation marks.
// ---------------------------------------------------------------------------------------------------------------

// The gap between two parts of one command is bounded ({0,400}, not *): an unbounded gap made these patterns quadratic
// on a long line (a 1 MB line of "pwsh pwsh ..." held the server for minutes, review round 2). A command whose parts
// stand more than 400 characters apart is not matched.
// PowerShell takes any unambiguous prefix of -EncodedCommand (-e, -en, -enc, ...) and the alias -ec, with - or /
const PS_ENCODED = '[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)';

export const PATTERNS = Object.freeze([
  // Permission bypass flags of AI command line tools (and an agent's permissionMode: bypassPermissions)
  { code: 'permission-bypass', level: 'danger', nosoft: true, re: /dangerously[-_ ]?skip[-_ ]?permissions|--dangerously|bypass-?permissions|--allow-all-tools|--full-auto|--yolo\b|\byolo\s+mode\b/i },
  // A download piped into a shell or an interpreter
  { code: 'pipe-to-shell', level: 'danger', nosoft: true, re: /\b(?:curl|wget)\b[^\n|]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\b(?:curl|wget)\b[^\n|]{0,400}\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|php)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b[^\n|]{0,400}\|\s*(?:iex|Invoke-Expression)\b/i },
  { code: 'invoke-expression', level: 'danger', re: /\bInvoke-Expression\b|\|\s*iex\b|(?:^|[\s;(])iex\s*[($'"]/i },
  // Encoded commands decoded and run: base64 into a shell, PowerShell's -EncodedCommand (any short form after
  // powershell or pwsh; the long forms anywhere), FromBase64String into iex, eval(atob(...))
  { code: 'encoded-exec', level: 'danger', nosoft: true, re: new RegExp(`base64\\s+(?:-d|--decode)\\b[^\\n]{0,400}\\|\\s*(?:ba|z)?sh\\b|-(?:EncodedCommand|enc|ec)\\s+['"]?[A-Za-z0-9+/=]{20,}|\\b(?:powershell|pwsh)(?:\\.exe)?\\b[^\\n]{0,400}\\s${PS_ENCODED}\\s+['"]?[A-Za-z0-9+/=]{20,}|FromBase64String[^\\n]{0,400}(?:iex|Invoke-Expression)|(?:eval|exec)\\s*\\(\\s*(?:atob|base64\\.b64decode|Buffer\\.from)\\s*\\(`, 'i') },
  { code: 'execution-policy', level: 'danger', re: /Set-ExecutionPolicy\b[^\n]{0,400}\b(?:Unrestricted|Bypass)\b|-ExecutionPolicy\s+(?:Bypass|Unrestricted)\b/i },
  // Windows programs used to fetch or unpack a payload: certutil -urlcache/-decode, bitsadmin /transfer, mshta <url>
  { code: 'lolbin', level: 'danger', re: /\bcertutil(?:\.exe)?\b[^\n]{0,400}[-/](?:urlcache|decode(?:hex)?)\b|\bbitsadmin(?:\.exe)?\b[^\n]{0,400}[-/]transfer\b|\bmshta(?:\.exe)?\s+['"]?(?:https?|javascript|vbscript):/i },
  // Something that starts again by itself: a scheduled task, a Run or RunOnce registry entry
  { code: 'persistence', level: 'danger', nosoft: true, re: /\bschtasks(?:\.exe)?\b[^\n]{0,400}[-/]create\b|\bRegister-ScheduledTask\b|\breg(?:\.exe)?\s+add\b[^\n]{0,400}\\(?:Run|RunOnce)\b|\b(?:New|Set)-ItemProperty\b[^\n]{0,400}\\(?:Run|RunOnce)\b/i },
  // Hooks or permissions written into Claude Code's settings (~/.claude/settings.json, .claude/settings.local.json):
  // a hook runs a command on every matching event without asking, a permission rule stops the asking
  { code: 'settings-hook', level: 'danger', nosoft: true, re: /^(?=.*(?:\.claude[\\/]+settings(?:\.local)?\.json|\bsettings\.local\.json\b))(?=.*(?:\bhooks?\b|\bpermissions\b|["']allow["']|\bdefaultMode\b|\bbypassPermissions\b|\b(?:PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|SessionEnd|SubagentStop|PreCompact)\b))/i },
  // Deleting a whole drive or home folder
  { code: 'delete-everything', level: 'danger', re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~\/?|\$HOME\/?|\/\*|\*|"\$HOME"|~\/\*)(?:\s|$|;)|Remove-Item\b(?=[^\n]*-Recurse)[^\n]*\s(?:-(?:Literal)?Path\s+)?['"]?(?:[A-Za-z]:\\?|~|\$HOME|\$env:USERPROFILE)['"]?(?:\s|$)|\bformat\s+[A-Za-z]:|\b(?:rd|rmdir|del)\s+\/s\s+\/q\s+[A-Za-z]:\\?(?:\s|$)/i },
  // Skipping hooks and rewriting history
  { code: 'skip-hooks', level: 'danger', re: /--no-verify\b/i },
  { code: 'force-push', level: 'danger', re: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)\b|\s-f\b)|\bpush\s+-f\b/i },
  // Electron and browser safety switched off
  { code: 'weak-sandbox', level: 'danger', re: /--no-sandbox\b|nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|webSecurity\s*:\s*false/i },
  // Prompt injection: instructions to drop earlier instructions or to keep something from the person
  { code: 'injection', level: 'danger', hard: true, re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|messages?|rules|directions|guidelines)\b|\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify)\s+the\s+user\s+(?:about\s+(?:this|it|these|that|any\s+of)|what\s+you|that\s+you|you\s+(?:did|have|are|were))\b|\b(?:do\s+not|don'?t|never)\s+(?:mention|reveal|show)\s+(?:this|these|it|them)\s+to\s+the\s+user\b|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b|\b(?:hide|conceal|keep)\s+(?:this|it)\s+(?:secret\s+)?from\s+the\s+user\b|\b(?:your|here\s+is\s+(?:your|the|a))\s+new\s+system\s+prompt\b|^\s*new\s+system\s+prompt\s*:|\byou\s+are\s+no\s+longer\s+(?:an?\s+)?(?:assistant|claude|bound)\b/i },
  { code: 'injection', level: 'danger', hard: true, re: /önceki\s+(?:tüm\s+|bütün\s+)?(?:talimatlar|yönergeler|kurallar)\S*\s+(?:yok\s+say|unut|görmezden\s+gel|dikkate\s+alma)|kullanıcıya\s+(?:bunu\s+|bundan\s+|hiçbir\s+şey\s+)?(?:söyleme|bahsetme|gösterme|haber\s+verme)|kullanıcıya\s+(?:haber\s+vermeden|sormadan|söylemeden)/i },
  // Other recursive deletes and forced operations: worth a look
  { code: 'recursive-delete', level: 'caution', re: /\brm\s+-(?:[a-z]*r)[a-z]*\b|Remove-Item\b[^\n]*-Recurse|\b(?:rd|rmdir)\s+\/s\b|shutil\.rmtree|fs\.rm(?:Sync)?\([^\n]*recursive\s*:\s*true/i },
  { code: 'force-flag', level: 'caution', re: /(?:^|\s)--force\b(?!-with-lease)/i },
  // The item talks to the network by itself
  { code: 'network', level: 'caution', re: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|urlopen|httpx)\b|\b(?:iwr|irm)\s+['"]?https?:|urllib\.request|\brequests\.(?:get|post|put|patch|delete)\s*\(|\baxios(?:\.[a-z]+)?\s*\(|\bfetch\s*\(\s*['"`]https?:|\bhttps?\.(?:get|request)\s*\(|\bnet\.connect\s*\(|\bsocket\.connect\b|Net\.Sockets|\bncat\s+-e\b|\bnc\s+-e\b/i },
  // Starts another program (PowerShell)
  { code: 'start-process', level: 'caution', re: /\bStart-Process\b/i },
  // Adds an MCP server (a program the AI tool starts and talks to)
  { code: 'mcp-server', level: 'caution', re: /\b(?:claude|codex|gemini|qwen)\s+mcp\s+add(?:-json|-from-claude-desktop)?\b|["']mcpServers["']\s*:/i },
]);

// Key formats (a finding: caution; the key would be copied along)
export const SECRET_RE = /\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/;
// A long base64 run (a caution; decoded and run is encoded-exec, a danger)
const BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/;
// Characters that hide text: bidirectional overrides and Unicode tag characters (danger), zero-width ones (caution)
const HIDDEN_RE = /[\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/;
const INVISIBLE_RE = /[\u200B\u2060\u2061\u2062\u2063\u2064\u180E]|(?!^)\uFEFF/;
// Words that say "do not" (English and Turkish)
const NEGATION_RE = /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not|shouldn'?t|avoid|forbidden|prohibited|not\s+allowed|refuse|reject|flag|detect|warn|asla|yapma|kullanma|çalıştırma|calistirma|etme|yasak|kaçın|kacin)\b/gi;
// How far before a danger a negation may stand (characters between the two), and what ends a sentence between them
const NEGATION_NEAR = 40;
const SENTENCE_END_RE = /[.!?;](?:\s|$)/;
// An HTML comment in a document that carries instructions rather than a note
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const COMMENT_INSTRUCTION_RE = /\b(?:ignore|disregard)\b[\s\S]*\b(?:instructions?|previous|above|user|rules)\b|\bsystem\s+prompt\b|\byou\s+(?:must|should|will|are\s+now)\b|\bsecretly\b|\bdo\s+not\s+(?:tell|mention|reveal|show)\b|\bas\s+an?\s+(?:ai|assistant|language\s+model)\b|\b(?:assistant|claude|ai|model)\s*[:,]\s*(?:please\s+)?(?:always|never|ignore|run|execute|send|upload|delete|copy)\b|\b(?:talimat\w*|yok\s+say|gizlice|kullanıcıya)\b/i;
// Claude Code's dynamic context in a skill: !`command` at the start of a line or after a space, and a ```! block, run
// before the model sees the skill (code.claude.com/docs/en/skills, "Inject dynamic context")
const DYNAMIC_INLINE_RE = /(?:^|\s)!`[^`\n]+`/;
const DYNAMIC_FENCE_RE = /^\s*(?:```|~~~)!/;

// A phrase inside a real pair of quotation marks: quoted as an example ("avoid wording such as 'ignore the previous
// instruction'"). The pair must close after the phrase: a single quotation mark at the start of a line that is never
// closed quotes nothing.
function quotedAt(line, index, end) {
  const before = line.slice(0, index);
  const after = line.slice(end);
  const straight = (before.match(/"/g) || []).length % 2 === 1 && after.includes('"');
  const ticks = (before.match(/`/g) || []).length % 2 === 1 && after.includes('`');
  const curly = before.lastIndexOf('“') > before.lastIndexOf('”') && after.includes('”');
  return straight || ticks || curly;
}

// A word that says not to do it, right before index in the same sentence: at most NEGATION_NEAR characters between
// its end and the danger, and no sentence end between them. A negation after the danger softens nothing.
function negatedBefore(line, index) {
  const before = line.slice(0, index);
  let last = null;
  NEGATION_RE.lastIndex = 0;
  for (let m = NEGATION_RE.exec(before); m; m = NEGATION_RE.exec(before)) last = m;
  if (!last) return false;
  const gap = before.slice(last.index + last[0].length);
  return gap.length <= NEGATION_NEAR && !SENTENCE_END_RE.test(gap);
}

// ---------------------------------------------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------------------------------------------

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The files of an item: a skill folder (every file below it) or an agent file. Links and special entries are skipped;
// a vendored folder (.git, node_modules, any letter case, at any depth) is not entered, as an import does not copy it.
// Returns { files: [{ abs, rel, size }] in byte order of the relative paths (at most limits.maxFiles), vendored: [rel
// of each vendored folder] }.
function itemFiles(p, limits) {
  const st = lstat(p);
  if (!st || st.isSymbolicLink()) return { files: [], vendored: [] };
  if (st.isFile()) return { files: [{ abs: p, rel: path.basename(p), size: st.size }], vendored: [] };
  if (!st.isDirectory()) return { files: [], vendored: [] };
  const out = [];
  const vendored = [];
  const walk = (dir, rel, depth) => {
    if (depth > limits.maxDepth) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
    } catch {
      return;
    }
    for (const d of ents) {
      if (out.length >= limits.maxFiles) return;
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (isVendoredDir(d.name)) vendored.push(r);
        else walk(abs, r, depth + 1);
      } else if (d.isFile()) out.push({ abs, rel: r, size: lstat(abs)?.size || 0 });
    }
  };
  walk(p, '', 1);
  return { files: out, vendored };
}

// UTF-16 by its byte order mark: 'le', 'be' or null
function utf16Bom(buf) {
  if (buf && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'le';
  if (buf && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'be';
  return null;
}

// The text of a file's bytes: UTF-16 decoded by its byte order mark, anything else as UTF-8 with NUL bytes dropped
// (a shell drops them too, and UTF-16 without a mark then reads as its ASCII letters)
function decodeText(buf, bom) {
  if (bom) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    if (bom === 'be') body.swap16();
    return body.toString('utf16le');
  }
  const s = buf.toString('utf8');
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

// The first bytes of a file (at most n); null when it cannot be read
function head(file, n) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

// A program: Windows (MZ) or ELF or Mach-O header
function isProgram(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
  const m = buf.readUInt32BE(0);
  return m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe;
}

// ---------------------------------------------------------------------------------------------------------------
// Frontmatter (the keys a review needs: allowed-tools, tools, license, hooks, mcpServers)
// ---------------------------------------------------------------------------------------------------------------

// A top-level key whose value holds something: not empty, {}, [], null or ~ (a block below it counts)
const EMPTY_VALUE_RE = /^(?:|\{\s*\}|\[\s*\]|null|~|""|'')$/i;

// { 'allowed-tools': [..], tools: [..], license: '...', hooks: <line>, mcpServers: <line> } from the YAML frontmatter
// at the top of a file; {} without one. A list may be written inline (a, b), as a flow sequence ([a, b]) or as block
// items (- a). hooks and mcpServers (Claude Code: a skill's or an agent's own hooks, an agent's own MCP servers) are the
// 1-based line of the key when it holds something.
export function reviewFrontmatter(file) {
  const buf = head(file, HEAD_BYTES);
  if (!buf) return {};
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const out = {};
  const unq = (v) => v.trim().replace(/^["']|["']$/g, '').trim();
  const splitList = (v) =>
    v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unq)
      .filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '---') break;
    // A quoted key ("hooks": / 'mcpServers':) is the same key in YAML
    const hm = /^["']?(hooks|mcpServers|mcp_servers|mcp-servers)["']?\s*:\s*(.*?)\s*(?:#.*)?$/.exec(l);
    if (hm) {
      const key = hm[1] === 'hooks' ? 'hooks' : 'mcpServers';
      const block = i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && lines[i + 1].trim() !== '---';
      if (!out[key] && (!EMPTY_VALUE_RE.test(hm[2]) || block)) out[key] = i + 1;
      continue;
    }
    const m = /^(allowed-tools|allowed_tools|tools|license):\s*(.*)$/.exec(l);
    if (!m) continue;
    const key = m[1] === 'allowed_tools' ? 'allowed-tools' : m[1];
    const v = m[2].trim();
    if (key === 'license') {
      if (v && !/^[|>][-+]?$/.test(v)) out.license = unq(v);
      else {
        const parts = [];
        for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
        out.license = parts.join(' ');
      }
      continue;
    }
    if (v) out[key] = splitList(v);
    else {
      const items = [];
      for (let j = i + 1; j < lines.length && /^\s+-\s*/.test(lines[j]); j++) items.push(unq(lines[j].replace(/^\s+-\s*/, '')));
      out[key] = items.filter(Boolean);
    }
  }
  return out;
}

// A tool grant that lets the item run any shell command: Bash (or PowerShell, Shell) without a command pattern, or
// with a pattern that allows everything (Bash(*), Bash(*:*), Bash(:*))
export function broadShell(list) {
  return (Array.isArray(list) ? list : []).some((t) => {
    const s = String(t).trim();
    const m = /^(bash|powershell|pwsh|shell|cmd|terminal)\s*(?:\(\s*([^)]*)\s*\))?$/i.exec(s);
    if (!m) return false;
    return m[2] === undefined || /^[*:\s]*$/.test(m[2]);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------------------------

// Review of one item (a skill folder or an agent file). Returns { level, reasons: [{ code, level, file, line, count }],
// scanned (files read), truncated (the item had more files than the review reads) }. Reasons: one per code (the first
// file and line it was seen in, how many lines showed it), danger first, then caution, each in table order.
export function reviewItem(p, { limits = REVIEW_LIMITS } = {}) {
  const L = limits === REVIEW_LIMITS ? REVIEW_LIMITS : { ...REVIEW_LIMITS, ...limits };
  const found = new Map(); // code -> { code, level, file, line, count }
  const add = (code, level, file, line = 0) => {
    const prev = found.get(code);
    if (!prev) found.set(code, { code, level, file, line, count: 1 });
    else {
      prev.count++;
      if (RANK[level] > RANK[prev.level]) Object.assign(prev, { level, file, line });
    }
  };
  const { files, vendored } = itemFiles(p, L);
  const st = lstat(p);
  const isDir = !!st && st.isDirectory();
  // Frontmatter: SKILL.md of a skill, the agent file itself
  const main = isDir ? path.join(p, 'SKILL.md') : p;
  const meta = reviewFrontmatter(main);
  const mainRel = isDir ? 'SKILL.md' : path.basename(p);
  if (broadShell(meta['allowed-tools']) || broadShell(meta.tools)) add('broad-shell', 'caution', mainRel, 0);
  // Hooks of its own run a command on every matching event, without the permission prompt and (a skill's) for the
  // rest of the session; Claude Code ignores them in plugin agents "for security reasons". An agent's own MCP servers
  // are programs it starts.
  if (meta.hooks) add('frontmatter-hooks', 'danger', mainRel, meta.hooks);
  if (meta.mcpServers) add('mcp-server', 'caution', mainRel, meta.mcpServers);
  // Not copied into the library, so not read: named so the person knows the item came with them
  for (const v of vendored) add('vendored-folder', 'caution', v);

  let total = 0;
  let scanned = 0;
  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase();
    const base = path.basename(f.rel).toLowerCase();
    if (BINARY_EXTS.includes(ext)) {
      add('binary-files', 'danger', f.rel);
      continue;
    }
    // Every file's first bytes are read: a program is a danger under any name (an image or a font name included)
    const probe = head(f.abs, BINARY_PROBE);
    if (!probe) {
      add('unreadable', 'caution', f.rel);
      continue;
    }
    if (isProgram(probe)) {
      add('binary-files', 'danger', f.rel);
      continue;
    }
    if (ARCHIVE_EXTS.includes(ext)) {
      add('unreviewed-binary', 'caution', f.rel);
      continue;
    }
    if (SKIP_EXTS.has(ext)) continue;
    const bom = utf16Bom(probe);
    const script = SCRIPT_EXTS.includes(ext) || (!ext && decodeText(probe.subarray(0, 64), bom).startsWith('#!'));
    if (script) add('script-files', 'caution', f.rel);
    // Another binary format (data): not read, and said so
    if (!bom && !script && !TEXT_EXTS.has(ext) && probe.includes(0)) {
      add('unreviewed-binary', 'caution', f.rel);
      continue;
    }
    if (total >= L.maxTotalBytes) {
      add('not-reviewed', 'caution', f.rel);
      continue;
    }
    const n = Math.min(f.size, L.maxFileBytes, L.maxTotalBytes - total);
    if (f.size > n) add('large-file', 'caution', f.rel);
    const buf = n <= probe.length ? probe.subarray(0, n) : head(f.abs, n);
    if (!buf) {
      add('unreadable', 'caution', f.rel);
      continue;
    }
    total += buf.length;
    scanned++;
    scanText(decodeText(buf, bom), { rel: f.rel, doc: !script && (DOC_EXTS.has(ext) || base === 'readme'), skill: isDir && f.rel === 'SKILL.md', add });
  }
  const reasons = [...found.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
  const level = reasons.reduce((lv, r) => (RANK[r.level] > RANK[lv] ? r.level : lv), 'ok');
  return { level, reasons, scanned, truncated: files.length >= L.maxFiles };
}

// Reason codes in display order (within a level)
export const ORDER = Object.freeze([
  'binary-files',
  'permission-bypass',
  'pipe-to-shell',
  'invoke-expression',
  'encoded-exec',
  'execution-policy',
  'lolbin',
  'persistence',
  'settings-hook',
  'frontmatter-hooks',
  'delete-everything',
  'skip-hooks',
  'force-push',
  'weak-sandbox',
  'injection',
  'hidden-comment',
  'hidden-chars',
  'script-files',
  'broad-shell',
  'dynamic-command',
  'mcp-server',
  'start-process',
  'network',
  'secret',
  'encoded-blob',
  'invisible-chars',
  'recursive-delete',
  'force-flag',
  'vendored-folder',
  'unreviewed-binary',
  'large-file',
  'not-reviewed',
  'unreadable',
]);

// One file's text: line by line against the patterns; in a document the HTML comments too. skill: the text is a
// skill's SKILL.md, where !`command` and ```! blocks run before the model reads it (dynamic-command).
export function scanText(text, { rel = '', doc = false, skill = false, add }) {
  const lines = text.split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skill && (DYNAMIC_FENCE_RE.test(line) || DYNAMIC_INLINE_RE.test(line))) add('dynamic-command', 'caution', rel, i + 1);
    if (doc && /^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      // In a document a danger weighs less only when a negation stands right before it in the same sentence, outside a
      // code block (an injection phrase: only inside a real pair of quotation marks); never for a nosoft pattern
      let soft = false;
      if (doc && p.level === 'danger' && !p.nosoft) soft = p.hard ? quotedAt(line, m.index, m.index + m[0].length) : !fence && negatedBefore(line, m.index);
      add(p.code, soft ? 'caution' : p.level, rel, i + 1);
    }
    if (SECRET_RE.test(line)) add('secret', 'caution', rel, i + 1);
    if (BLOB_RE.test(line)) add('encoded-blob', 'caution', rel, i + 1);
    if (HIDDEN_RE.test(line)) add('hidden-chars', 'danger', rel, i + 1);
    else if (INVISIBLE_RE.test(line)) add('invisible-chars', 'caution', rel, i + 1);
  }
  if (!doc) return;
  // Lines inside a fenced code block: a comment there is shown to the reader as code, it hides nothing
  const inFence = new Set();
  let open = false;
  lines.forEach((l, i) => {
    if (/^\s*(?:```|~~~)/.test(l)) {
      open = !open;
      inFence.add(i);
    } else if (open) inFence.add(i);
  });
  COMMENT_RE.lastIndex = 0;
  for (let m = COMMENT_RE.exec(text); m; m = COMMENT_RE.exec(text)) {
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    if (inFence.has(line - 1)) continue;
    if (COMMENT_INSTRUCTION_RE.test(m[1])) add('hidden-comment', 'danger', rel, line);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// License
// ---------------------------------------------------------------------------------------------------------------

// License families: permissive (use and share freely, keep the notice), copyleft (share changes under the same
// license), cc (Creative Commons), proprietary (the owner's terms), unknown (a license the table does not know),
// none (no license at all: personal use only, do not share)
export const LICENSE_FAMILY = Object.freeze({
  MIT: 'permissive',
  'Apache-2.0': 'permissive',
  'BSD-2-Clause': 'permissive',
  'BSD-3-Clause': 'permissive',
  ISC: 'permissive',
  '0BSD': 'permissive',
  Zlib: 'permissive',
  Unlicense: 'permissive',
  'CC0-1.0': 'permissive',
  'GPL-2.0': 'copyleft',
  'GPL-3.0': 'copyleft',
  'AGPL-3.0': 'copyleft',
  'LGPL-2.1': 'copyleft',
  'LGPL-3.0': 'copyleft',
  'MPL-2.0': 'copyleft',
  'EPL-2.0': 'copyleft',
  'CC-BY-4.0': 'cc',
  'CC-BY-SA-4.0': 'cc',
  'CC-BY-NC-4.0': 'cc',
  'CC-BY-NC-SA-4.0': 'cc',
  'CC-BY-ND-4.0': 'cc',
});

// SPDX ids as people write them (in a frontmatter line or a package field), longest first
/** @type {Array<[string, RegExp]>} */
const SPDX_WORDS = [
  ['Apache-2.0', /\bapache(?:[- ]license)?[- ,]*(?:version\s*)?2(?:\.0)?\b/i],
  ['BSD-3-Clause', /\bbsd[- ]3(?:[- ]clause)?\b/i],
  ['BSD-2-Clause', /\bbsd[- ]2(?:[- ]clause)?\b/i],
  ['AGPL-3.0', /\bagpl[- ]?(?:v)?3/i],
  ['LGPL-3.0', /\blgpl[- ]?(?:v)?3/i],
  ['LGPL-2.1', /\blgpl[- ]?(?:v)?2/i],
  ['GPL-3.0', /\bgpl[- ]?(?:v)?3/i],
  ['GPL-2.0', /\bgpl[- ]?(?:v)?2/i],
  ['MPL-2.0', /\bmpl[- ]?2/i],
  ['EPL-2.0', /\bepl[- ]?2/i],
  ['CC-BY-NC-SA-4.0', /\bcc[- ]by[- ]nc[- ]sa\b/i],
  ['CC-BY-NC-4.0', /\bcc[- ]by[- ]nc\b/i],
  ['CC-BY-ND-4.0', /\bcc[- ]by[- ]nd\b/i],
  ['CC-BY-SA-4.0', /\bcc[- ]by[- ]sa\b/i],
  ['CC-BY-4.0', /\bcc[- ]by\b/i],
  ['CC0-1.0', /\bcc0\b/i],
  ['Unlicense', /\bunlicen[cs]e\b/i],
  ['0BSD', /\b0bsd\b/i],
  ['ISC', /\bisc\b/i],
  ['Zlib', /\bzlib\b/i],
  ['MIT', /\bmit\b/i],
];

// The SPDX id of a license text (the file's words, not its name): MIT, Apache-2.0, ...; 'proprietary' for terms
// that grant no general permission ("All rights reserved", "Proprietary"); 'unknown' for any other text
export function licenseFromText(text) {
  const t = String(text || '').slice(0, 64 * 1024);
  if (!t.trim()) return 'unknown';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2\.1/i.test(t) ? 'LGPL-2.1' : 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2\b/i.test(t) && !/Version 3\b/i.test(t) ? 'GPL-2.0' : 'GPL-3.0';
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Mozilla Public License/i.test(t) && /2\.0/.test(t)) return 'MPL-2.0';
  if (/Eclipse Public License/i.test(t) && /2\.0/.test(t)) return 'EPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  // ISC asks to keep the notice ("provided that the above copyright notice ..."); the zero-clause BSD does not
  if (/Permission to use, copy, modify, and\/?or distribute this software for any purpose/i.test(t)) return /provided that the above copyright notice/i.test(t) ? 'ISC' : '0BSD';
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name|names of its\s+contributors/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/CC0 1\.0 Universal|Creative Commons Zero/i.test(t)) return 'CC0-1.0';
  if (/Attribution-NonCommercial-ShareAlike 4\.0/i.test(t)) return 'CC-BY-NC-SA-4.0';
  if (/Attribution-NonCommercial 4\.0/i.test(t)) return 'CC-BY-NC-4.0';
  if (/Attribution-NoDerivatives 4\.0/i.test(t)) return 'CC-BY-ND-4.0';
  if (/Attribution-ShareAlike 4\.0/i.test(t)) return 'CC-BY-SA-4.0';
  if (/Attribution 4\.0 International/i.test(t)) return 'CC-BY-4.0';
  if (/This software is provided 'as-is'[\s\S]*altered source versions must be plainly marked/i.test(t)) return 'Zlib';
  if (/\bproprietary\b|all rights reserved|may not (?:be )?(?:copied|distributed|redistribute)/i.test(t)) return 'proprietary';
  return 'unknown';
}

// The SPDX id named in a short line (a frontmatter `license:` value): an id or a well-known name; 'proprietary' for
// such terms; null when the line names none (it may point to a file instead: "Complete terms in LICENSE.txt")
export function licenseFromLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  if (/\bproprietary\b|all rights reserved/i.test(s)) return 'proprietary';
  for (const [id, re] of SPDX_WORDS) if (re.test(s)) return id;
  return null;
}

// License file names: LICENSE, LICENCE, COPYING, UNLICENSE (any case, with .md, .txt or no extension)
const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|unlicen[cs]e)(?:[-_.][a-z0-9-]+)?(?:\.(?:md|markdown|txt|rst))?$/i;

// The license file directly in a folder (real files only, byte order); null when none
function licenseFileIn(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
  } catch {
    return null;
  }
  const f = ents.find((d) => d.isFile() && LICENSE_FILE_RE.test(d.name));
  return f ? path.join(dir, f.name) : null;
}

function readLicenseFile(file) {
  const buf = head(file, 64 * 1024);
  return buf ? licenseFromText(buf.toString('utf8')) : 'unknown';
}

// A license as the page shows it: { spdx (an SPDX id, 'proprietary', 'unknown' or null), family, source ('item',
// 'repo' or null), file (the license file name, or null) }
function license(spdx, source, file = null) {
  const family = spdx === null ? 'none' : spdx === 'proprietary' ? 'proprietary' : LICENSE_FAMILY[spdx] || 'unknown';
  return { spdx, family, source, file: file ? path.basename(file) : null };
}

// The repository's license: the license file at its root; none: { spdx: null, family: 'none' }
export function repoLicense(repoDir) {
  const f = repoDir ? licenseFileIn(repoDir) : null;
  return f ? license(readLicenseFile(f), 'repo', f) : license(null, null);
}

// The license of an item: its frontmatter `license` (an id, or terms that point to a file in the item folder), a
// license file in its folder, else the repository's (repo: repoLicense of the repository)
export function itemLicense(p, repo = license(null, null)) {
  const st = lstat(p);
  const isDir = !!st && st.isDirectory();
  const meta = reviewFrontmatter(isDir ? path.join(p, 'SKILL.md') : p);
  const own = isDir ? licenseFileIn(p) : null;
  if (meta.license) {
    const id = licenseFromLine(meta.license);
    if (id && id !== 'proprietary') return license(id, 'item', own);
    if (own) {
      const fromFile = readLicenseFile(own);
      return license(fromFile === 'unknown' && id ? id : fromFile, 'item', own);
    }
    if (id) return license(id, 'item');
  }
  if (own) return license(readLicenseFile(own), 'item', own);
  return repo && repo.spdx !== undefined ? repo : license(null, null);
}
