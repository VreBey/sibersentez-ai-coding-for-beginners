// @ts-check
// Tag dictionary of the automatic skill fit (docs/auto-skills.md §2.2). One dictionary gives tags to projects (from
// manifest signals, file extensions and folder names) and to items (from name, description and category).
//
// A tag is a stack tag or a topic tag:
//   - stack tags name what the code is built with. kind 'framework' covers frameworks and engines (unity, nextjs,
//     react-native, django, ...), kind 'language' covers languages (csharp, python, typescript, ...). Where an item or a
//     project has framework tags, those are its primary stack; its language tags only count when it has no framework
//     tag (see primaryStacks): an ASP.NET skill is a dotnet skill, not "any C# project" skill.
//   - topic tags name what the work is about (testing, security, docs, design, devops, database, ...).
//
// Synonyms (English and Turkish) are matched as whole words on normalized text:
//   'shader graph'  a word or a phrase, any letter case
//   'React'         a proper noun: in a description only with a capital first letter ("react to input" is not React);
//                   in an item name any case (names are written in lower case)
//   'güvenli*'      a stem: any word that starts with it (Turkish suffixes: güvenlik, güvenliği, güvenliğe)
// At every position the longest phrase wins, so 'react native' is React Native and not React too; a phrase listed
// under several tags ('shader graph': unity and graphics) gives all of them.
//
// The same dictionary reads a project idea that a person typed ("Unity ile 2D platform oyunu", "Next.js ile online
// mağaza", "Python ile Telegram botu"): see ideaTags. That is why the topics also carry the words people use to say
// what they want to build (a game, a website, an online store, a bot, an API, a presentation, ...), with the Turkish
// suffixed forms as stems or listed words.
//
// Pure module: no file system, no imports.

const stack = (id, kind, words, implies = []) => Object.freeze({ id, type: 'stack', kind, words: Object.freeze(words), implies: Object.freeze(implies) });
const topic = (id, words, implies = []) => Object.freeze({ id, type: 'topic', kind: 'topic', words: Object.freeze(words), implies: Object.freeze(implies) });

export const TAGS = Object.freeze([
  // ---- engines and frameworks ----
  stack('unity', 'framework', ['unity', 'unity3d', 'unity 3d', 'unity editor', 'monobehaviour', 'monobehaviours', 'monobehavior', 'prefab', 'prefabs', 'scriptableobject', 'scriptableobjects', 'scriptable object', 'scriptable objects', 'urp', 'hdrp', 'shader graph', 'shadergraph', 'netcode', 'netcode for gameobjects', 'ugui', 'ui toolkit', 'uitoolkit', 'uxml', 'addressables', 'cinemachine', 'fishnet', 'asmdef'], ['gamedev', 'csharp']),
  stack('unreal', 'framework', ['unreal', 'unreal engine', 'ue', 'ue4', 'ue5', 'uproject', 'uobject', 'uclass', 'ustruct', 'uproperty', 'ufunction', 'umg', 'niagara', 'gameplay ability system', 'metahuman'], ['gamedev', 'cpp']),
  stack('godot', 'framework', ['godot', 'godot 4', 'gdextension', 'gdshader'], ['gamedev', 'gdscript']),
  stack('nextjs', 'framework', ['nextjs', 'next js', 'app router', 'pages router'], ['web']),
  stack('react', 'framework', ['React', 'reactjs', 'react js', 'react hook', 'react hooks', 'react component', 'react components', 'react router', 'react query', 'tanstack query'], ['web']),
  stack('react-native', 'framework', ['react native', 'reactnative', 'react navigation', 'metro bundler'], ['mobile']),
  stack('expo', 'framework', ['Expo', 'expo router', 'expo go', 'eas build', 'eas update'], ['react-native', 'mobile']),
  stack('electron', 'framework', ['Electron', 'electronjs', 'electron builder', 'electron forge'], ['desktop']),
  stack('tauri', 'framework', ['tauri'], ['desktop']),
  stack('vue', 'framework', ['vue', 'vuejs', 'vue js', 'nuxt', 'nuxtjs', 'pinia', 'vuex'], ['web']),
  stack('svelte', 'framework', ['svelte', 'sveltekit'], ['web']),
  stack('angular', 'framework', ['Angular', 'angularjs'], ['web']),
  stack('node-server', 'framework', ['Express', 'expressjs', 'fastify', 'nestjs', 'koa', 'hono'], ['web']),
  stack('django', 'framework', ['django', 'django rest framework', 'drf'], ['web']),
  stack('flask', 'framework', ['Flask'], ['web']),
  stack('fastapi', 'framework', ['fastapi'], ['web']),
  stack('rails', 'framework', ['Rails', 'ruby on rails', 'activerecord'], ['web']),
  stack('laravel', 'framework', ['laravel'], ['web']),
  stack('spring', 'framework', ['spring boot', 'springboot', 'spring framework'], ['web']),
  stack('dotnet', 'framework', ['aspnet', 'asp net', 'asp net core', 'aspnetcore', 'blazor', 'entity framework', 'ef core', 'wpf', 'winforms', 'windows forms', 'maui', 'xamarin', 'razor pages']),
  stack('flutter', 'framework', ['flutter'], ['mobile', 'dart']),
  stack('tailwind', 'framework', ['tailwind', 'tailwindcss', 'tailwind css'], ['web']),
  stack('threejs', 'framework', ['threejs', 'three js', 'react three fiber', 'r3f'], ['web', 'graphics']),
  stack('wordpress', 'framework', ['wordpress'], ['web']),
  // ---- languages ----
  stack('csharp', 'language', ['csharp', 'c sharp', 'dotnet', 'nuget', 'roslyn', 'linq']),
  stack('typescript', 'language', ['typescript', 'tsconfig'], ['javascript']),
  stack('javascript', 'language', ['javascript', 'nodejs', 'node js', 'npm', 'ecmascript']),
  stack('python', 'language', ['python', 'pip', 'pytest', 'numpy', 'virtualenv', 'pyproject']),
  stack('go', 'language', ['golang', 'go module', 'go modules', 'go mod', 'goroutine', 'goroutines', 'gofmt']),
  stack('rust', 'language', ['Rust', 'rustc', 'cargo']),
  stack('java', 'language', ['Java', 'jvm', 'maven']),
  stack('kotlin', 'language', ['kotlin', 'jetpack compose']),
  stack('swift', 'language', ['Swift', 'swiftui', 'uikit', 'xcode'], ['mobile']),
  stack('dart', 'language', ['Dart']),
  stack('php', 'language', ['php']),
  stack('ruby', 'language', ['Ruby', 'rubygems']),
  stack('cpp', 'language', ['cpp', 'c plus plus', 'cmake']),
  stack('lua', 'language', ['lua']),
  // GDScript is a language: an item that lists it among others (C#, C++, GDScript) is not a Godot-only item
  stack('gdscript', 'language', ['gdscript']),
  // ---- topics ----
  topic('gamedev', ['game', 'games', 'gameplay', 'game design', 'game designer', 'game dev', 'gamedev', 'game development', 'game engine', 'game engines', 'level design', 'level designer', 'gdd', 'playtest', 'playtesting', 'npc', 'npcs', 'game jam', 'video game', 'video games', 'platformer', 'platformers', 'rpg', 'roguelike', 'oyun*']),
  topic('multiplayer', ['multiplayer', 'netcode', 'netcode for gameobjects', 'replication', 'matchmaking', 'lobby', 'lobbies', 'dedicated server', 'dedicated servers', 'game server', 'game servers', 'rollback netcode', 'client prediction', 'lag compensation', 'fishnet', 'photon', 'mirror networking', 'çok oyunculu', 'cok oyunculu', 'çevrimiçi*', 'cevrimici*', 'oyun sunucu*']),
  topic('graphics', ['shader', 'shaders', 'hlsl', 'glsl', 'shader graph', 'shadergraph', 'vfx', 'particle', 'particles', 'particle system', 'particle systems', 'rendering', 'renderer', 'lighting', 'post processing', 'postprocessing', 'render pipeline', 'technical art', 'technical artist', 'gdshader', 'gölgelendirici*', 'görsel efekt*']),
  topic('ui', ['ui', 'ui ux', 'user interface', 'user interfaces', 'hud', 'ugui', 'ui toolkit', 'uitoolkit', 'uxml', 'umg', 'menu system', 'arayüz*', 'arayuz*']),
  topic('audio', ['audio', 'sound', 'sounds', 'sound design', 'sound designer', 'music', 'sfx', 'fmod', 'wwise', 'audio mixer', 'ses', 'sesi', 'sesler', 'sesleri', 'ses efekti', 'müzik*', 'muzik*']),
  topic('testing', ['test*', 'unit test', 'unit tests', 'integration test', 'integration tests', 'e2e', 'end to end', 'qa', 'jest', 'vitest', 'pytest', 'playwright', 'cypress', 'regression', 'smoke check', 'flaky', 'tdd', 'nunit', 'birim test*']),
  topic('security', ['security', 'secure', 'vulnerability', 'vulnerabilities', 'owasp', 'pentest', 'penetration testing', 'threat model', 'threat modeling', 'xss', 'csrf', 'sql injection', 'cve', 'anti cheat', 'güvenli*', 'guvenli*', 'zafiyet*']),
  topic('docs', ['docs', 'documentation', 'readme', 'changelog', 'technical writing', 'release notes', 'patch notes', 'api docs', 'docstring', 'docstrings', 'belge*', 'dokümantasyon', 'dokumantasyon']),
  topic('design', ['design', 'designer', 'design system', 'ux', 'ui ux', 'figma', 'typography', 'wireframe', 'wireframes', 'mockup', 'mockups', 'visual design', 'art direction', 'art bible', 'accessibility', 'a11y', 'tasarım*', 'tasarim*']),
  topic('devops', ['devops', 'docker', 'dockerfile', 'docker compose', 'kubernetes', 'k8s', 'helm', 'terraform', 'ci', 'ci cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment', 'deploy', 'deployment', 'deployments', 'github actions', 'gitlab ci', 'jenkins', 'infrastructure', 'monitoring', 'observability', 'build pipeline', 'site reliability', 'dağıtım*', 'dagitim*', 'altyapı*', 'altyapi*', 'konteyner*']),
  topic('database', ['database', 'databases', 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'prisma', 'drizzle', 'orm', 'migrations', 'supabase', 'veritaban*', 'veri taban*']),
  topic('ai', ['ai', 'llm', 'llms', 'large language model', 'large language models', 'machine learning', 'deep learning', 'prompt engineering', 'rag', 'embeddings', 'openai', 'anthropic', 'claude api', 'langchain', 'pytorch', 'tensorflow', 'chatgpt', 'gpt', 'ollama', 'ai agent', 'ai agents', 'ai assistant', 'ai assistants', 'chatbot*', 'chat bot', 'chat bots', 'computer vision', 'nlp', 'yapay zek*', 'makine öğren*', 'makine ogren*', 'derin öğren*', 'derin ogren*', 'sohbet bot*', 'görüntü işleme', 'goruntu isleme']),
  topic('web', ['web', 'website', 'websites', 'web app', 'web apps', 'frontend', 'front end', 'html', 'css', 'seo', 'browser', 'rest api', 'graphql', 'landing page', 'landing pages', 'portfolio site', 'portfolio website', 'personal website', 'web site*', 'site*', 'portfolyo*', 'açılış sayfa*', 'acilis sayfa*']),
  topic('mobile', ['mobile', 'ios', 'android', 'app store', 'play store', 'iphone', 'ipad', 'mobil*', 'telefon*']),
  topic('desktop', ['desktop app', 'desktop apps', 'desktop application', 'desktop applications', 'windows app', 'windows apps', 'mac app', 'macos app', 'masaüstü*', 'masaustu*', 'windows uygulama*']),
  topic('data', ['data analysis', 'data science', 'dataframe', 'dataframes', 'pandas', 'etl', 'csv', 'analytics', 'data visualization', 'jupyter', 'dataset', 'datasets', 'statistics', 'spreadsheet', 'spreadsheets', 'excel', 'dashboard', 'dashboards', 'veri', 'veri analiz*', 'veri bilim*', 'veri set*', 'istatistik*', 'görselleştir*', 'gorsellestir*']),
  topic('localization', ['localization', 'localisation', 'localize', 'localise', 'i18n', 'l10n', 'translation', 'translations', 'internationalization', 'yerelleştir*', 'yerellestir*', 'çeviri*', 'ceviri*']),
  topic('performance', ['performance', 'profiling', 'profiler', 'optimization', 'optimisation', 'optimize', 'perf', 'memory leak', 'memory leaks', 'benchmark', 'benchmarks', 'frame rate', 'fps', 'performans*', 'optimizasyon*']),
  topic('planning', ['sprint', 'sprints', 'milestone', 'milestones', 'roadmap', 'retrospective', 'backlog', 'user story', 'user stories', 'epic', 'epics', 'scrum', 'kanban', 'estimate', 'estimation', 'release checklist', 'launch checklist', 'producer', 'yol haritası', 'yol haritasi']),
  // Topics that ideas name more often than code does (docs/start-flow.md). A phrase names its most specific topic
  // only ("online store" is ecommerce, which implies web): a broad topic named by the same words would put every
  // web skill level with the store skills.
  topic('ecommerce', ['ecommerce', 'e commerce', 'eshop', 'e shop', 'online store', 'online stores', 'online shop', 'online shops', 'web shop', 'webshop', 'storefront', 'shopping cart', 'shopify', 'woocommerce', 'payment gateway', 'payments', 'stripe', 'e ticaret', 'eticaret', 'online mağaza*', 'online magaza*', 'mağaza*', 'magaza*', 'online satış', 'online satis', 'alışveriş*', 'alisveris*', 'ödeme*', 'odeme*', 'sipariş*', 'siparis*', 'restoran*', 'online order', 'online orders', 'food ordering', 'order form'], ['web']),
  topic('bot', ['bot', 'bots', 'botu', 'botun', 'botum', 'botumu', 'botunu', 'botuna', 'botlar*', 'chatbot*', 'chat bot', 'chat bots', 'telegram*', 'discord*', 'slack bot', 'slack bots', 'whatsapp bot', 'twitch bot', 'sohbet bot*']),
  topic('backend', ['backend', 'backends', 'back end', 'api', 'apis', 'rest api', 'rest apis', 'restful', 'graphql', 'web api', 'api server', 'microservice', 'microservices', 'server side', 'endpoint', 'endpoints', 'arka uç', 'arka uc', 'sunucu*']),
  topic('content', ['blog*', 'cms', 'headless cms', 'content management', 'article', 'articles', 'newsletter', 'newsletters', 'copywriting', 'makale*', 'içerik*', 'icerik*']),
  topic('slides', ['presentation', 'presentations', 'slides', 'slide deck', 'slide decks', 'pitch deck', 'pitch decks', 'pptx', 'powerpoint', 'keynote', 'google slides', 'sunum*']),
  topic('automation', ['automation', 'automations', 'automate', 'automating', 'workflow automation', 'cron', 'cron job', 'cron jobs', 'scheduled task', 'scheduled tasks', 'rpa', 'zapier', 'n8n', 'ifttt', 'otomasyon*', 'otomatik*', 'otomatikleştir*', 'otomatiklestir*', 'zamanlanmış görev*', 'zamanlanmis gorev*']),
  topic('scraping', ['scraping', 'scrape', 'scraper', 'scrapers', 'web scraping', 'crawler', 'crawlers', 'crawling', 'web crawler', 'scrapy', 'beautifulsoup', 'beautiful soup', 'selenium', 'puppeteer', 'veri çek*', 'veri cek*', 'veri kazı*', 'veri kazi*', 'web kazı*', 'web kazi*']),
  // Topics of the SiberSentez kit's quality and release items (docs/kit.md §4.1): reviewing changes, finding bugs,
  // shipping a version
  topic('code-review', ['code review', 'code reviews', 'code reviewer', 'reviewing code', 'pull request', 'pull requests', 'review changes', 'kod incele*', 'kod gözden geçir*', 'kod gozden gecir*']),
  topic('debugging', ['debug', 'debugging', 'debugger', 'bug', 'bugs', 'bug fix', 'bug fixes', 'stack trace', 'stack traces', 'crash', 'crashes', 'hata ayıkla*', 'hata ayikla*', 'çöküyor', 'cokuyor', 'çöktü', 'coktu']),
  topic('release', ['release', 'releases', 'releasing', 'versioning', 'semver', 'semantic versioning', 'version bump', 'release notes', 'sürüm*', 'surum*']),
  // Topics of kit v2's first wave (docs/kit-v2.md §6): version control, clean-ups that keep behaviour, and the
  // orchestration team (plan, hand-off, several roles on one job)
  topic('git', ['git', 'github', 'gitlab', 'commit', 'commits', 'branch', 'branches', 'merge', 'pull request branch', 'version control', 'undo a commit', 'push to github', 'sürüm kontrol*', 'surum kontrol*', 'geri al*', 'dal aç*', 'dal ac*']),
  topic('refactoring', ['refactor', 'refactors', 'refactoring', 'clean up code', 'cleanup code', 'code cleanup', 'messy code', 'technical debt', 'tech debt', 'restructure code', 'yeniden düzenle*', 'yeniden duzenle*', 'kodu temizle*', 'dağınık kod', 'daginik kod']),
  topic('workflow', ['orchestrate', 'orchestration', 'orchestrator', 'subagent', 'subagents', 'multi agent', 'multi-agent', 'agent team', 'hand off', 'handoff', 'hand-off', 'session notes', 'project memory', 'alt ajan*', 'ajan ekib*', 'devir notu', 'kaldığım yer*', 'kaldigim yer*']),
  // Topics of the kit's command line and browser extension starters (docs/kit-v2.md, wave 2)
  topic('cli', ['cli', 'clis', 'command line', 'command line tool', 'command line tools', 'command line program', 'command line programs', 'terminal tool', 'terminal tools', 'komut satırı*', 'komut satiri*', 'terminal aracı', 'terminal araci']),
  topic('extension', ['browser extension', 'browser extensions', 'chrome extension', 'chrome extensions', 'web extension', 'web extensions', 'browser add on', 'browser add ons', 'tarayıcı eklenti*', 'tarayici eklenti*', 'tarayıcı uzantı*', 'tarayici uzanti*', 'chrome eklenti*', 'chrome uzantı*', 'chrome uzanti*']),
]);

export const TAG_BY_ID = new Map(TAGS.map((t) => [t.id, t]));
export const STACK_TAGS = Object.freeze(TAGS.filter((t) => t.type === 'stack').map((t) => t.id));
export const TOPIC_TAGS = Object.freeze(TAGS.filter((t) => t.type === 'topic').map((t) => t.id));
export const isStack = (id) => TAG_BY_ID.get(id)?.type === 'stack';
export const isFramework = (id) => TAG_BY_ID.get(id)?.kind === 'framework';

// Library categories (docs/skills-flow.md §2.2) as topic tags; 'general' says nothing
export const CATEGORY_TAGS = Object.freeze({ web: 'web', mobile: 'mobile', desktop: 'desktop', game: 'gamedev', data: 'data', ai: 'ai', devops: 'devops', testing: 'testing', security: 'security', design: 'design', docs: 'docs' });

// Manifest signals (server/suggest.mjs) as tags
export const SIGNAL_TAGS = Object.freeze({
  react: ['react'],
  next: ['nextjs'],
  vue: ['vue'],
  svelte: ['svelte'],
  angular: ['angular'],
  expo: ['expo'],
  'react-native': ['react-native'],
  electron: ['electron'],
  tauri: ['tauri'],
  express: ['node-server'],
  prisma: ['database'],
  tailwind: ['tailwind'],
  tests: ['testing'],
  llm: ['ai'],
  typescript: ['typescript'],
  // Any package.json (a Node.js project) and Vite (a web front end)
  node: ['javascript'],
  vite: ['web'],
  python: ['python'],
  django: ['django'],
  flask: ['flask'],
  fastapi: ['fastapi'],
  pandas: ['data'],
  ml: ['ai'],
  'llm-py': ['ai'],
  pytest: ['testing'],
  go: ['go'],
  rust: ['rust'],
  // .csproj/.sln: C#; Unity writes them too, so they never make a project an ASP.NET one
  dotnet: ['csharp'],
  unity: ['unity', 'csharp'],
  unreal: ['unreal', 'cpp'],
  godot: ['godot', 'gdscript'],
  flutter: ['flutter', 'dart'],
  docker: ['devops'],
  ci: ['devops'],
  'unity-multiplayer': ['multiplayer'],
  'unity-rendering': ['graphics'],
  'unity-localization': ['localization'],
});

// ---------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------

// Spellings folded before words are split: c# -> csharp, c++ -> cpp, .NET -> dotnet, Next.js -> nextjs
function fold(s) {
  return String(s || '')
    .replace(/İ/g, 'i')
    .replace(/(^|[^A-Za-z0-9])([cC])#/g, '$1$2sharp')
    .replace(/(^|[^A-Za-z0-9])([cC])\+\+/g, '$1$2pp')
    .replace(/(^|[^A-Za-z0-9])\.(net|NET|Net)\b/g, '$1dotnet')
    .replace(/([A-Za-z0-9])\.js\b/gi, '$1js');
}

const WORD_RE = /[A-Za-z0-9çğıöşüâîûÇĞÖŞÜÂÎÛ]+/g;

// Words of a text in order: [{ w: lower case, cap: first letter is a capital, raw: as written (after folding) }]
export function words(text) {
  const out = [];
  for (const m of fold(text).matchAll(WORD_RE)) {
    const raw = m[0];
    out.push({ w: raw.toLowerCase(), cap: raw[0] !== raw[0].toLowerCase(), raw });
  }
  return out;
}

// Entries: { key, parts, stem (the last part is a word start), tags, proper }. Index: entries whose first part is a
// whole word, by that word; single-word stems apart (their first part is a word start).
function buildIndex() {
  const byFirst = new Map();
  const stems = [];
  const all = new Map();
  for (const t of TAGS) {
    for (const raw of t.words) {
      const stem = raw.endsWith('*');
      const parts = words(stem ? raw.slice(0, -1) : raw).map((x) => x.w);
      if (!parts.length) continue;
      const key = `${parts.join(' ')}${stem ? '*' : ''}`;
      let e = all.get(key);
      if (!e) {
        e = { key, parts, stem, tags: new Set(), proper: false };
        all.set(key, e);
        if (stem && parts.length === 1) stems.push(e);
        else {
          if (!byFirst.has(parts[0])) byFirst.set(parts[0], []);
          byFirst.get(parts[0]).push(e);
        }
      }
      e.tags.add(t.id);
      // A proper-noun spelling makes the whole phrase proper (the same phrase is never listed both ways)
      if (raw[0] !== raw[0].toLowerCase()) e.proper = true;
    }
  }
  return { byFirst, stems };
}
const INDEX = buildIndex();

// Does entry e match the words at position i
function matchAt(ws, i, e, strictCase) {
  if (i + e.parts.length > ws.length) return false;
  const last = e.parts.length - 1;
  for (let k = 0; k < e.parts.length; k++) {
    const w = ws[i + k].w;
    if (k === last && e.stem ? !w.startsWith(e.parts[k]) : w !== e.parts[k]) return false;
  }
  return !(e.proper && strictCase && !ws[i].cap);
}

// Longest first; a whole word before a word start; then the entry text (byte order)
const better = (a, b) => b.parts.length - a.parts.length || (a.stem === b.stem ? 0 : a.stem ? 1 : -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The dictionary entries found in a list of words, left to right: onHit(entry, i) for each, where i is the position of
// its first word (the longest phrase at a position wins and takes its words)
function scan(ws, strictCase, onHit) {
  for (let i = 0; i < ws.length; ) {
    let hit = null;
    for (const e of [...(INDEX.byFirst.get(ws[i].w) || []), ...INDEX.stems.filter((s) => ws[i].w.startsWith(s.parts[0]))]) {
      if (matchAt(ws, i, e, strictCase) && (!hit || better(e, hit) < 0)) hit = e;
    }
    if (hit) {
      onHit(hit, i);
      i += hit.parts.length;
    } else i++;
  }
}

// Tag ids found in a text. strictCase: proper nouns need a capital first letter (descriptions); otherwise any case
// (names). Returns a Set.
export function tagsInText(text, { strictCase = false } = {}) {
  const out = new Set();
  scan(words(text), strictCase, (hit) => {
    for (const t of hit.tags) out.add(t);
  });
  return out;
}

// At most this many characters of the words that named a tag are returned (ideaTags)
export const IDEA_WORD_MAX = 40;

// Tags of a project idea that a person typed ("Unity ile 2D platform oyunu"). Any letter case counts (people type
// names in lower case), Turkish suffixes through the stems. Returns, in sortTags order, [{ id, type, word }] for the
// tags the text names (word: the words that named it, as written, at most IDEA_WORD_MAX characters) and
// [{ id, type, via }] for the tags those imply (via: the named tag that implies it, the first in sortTags order).
export function ideaTags(text) {
  const ws = words(text);
  const named = new Map();
  scan(ws, false, (hit, i) => {
    const word = ws
      .slice(i, i + hit.parts.length)
      .map((x) => x.raw)
      .join(' ')
      .slice(0, IDEA_WORD_MAX);
    for (const t of hit.tags) if (!named.has(t)) named.set(t, word);
  });
  const out = new Map();
  for (const [id, word] of named) out.set(id, { id, type: TAG_BY_ID.get(id).type, word });
  for (const id of sortTags(named.keys())) {
    for (const x of withImplied([id])) if (!out.has(x)) out.set(x, { id: x, type: TAG_BY_ID.get(x).type, via: id });
  }
  return sortTags(out.keys()).map((id) => out.get(id));
}

// Words of an idea that say nothing about what fits: Turkish and English glue words and generic nouns and verbs
// ("app", "proje", "yapmak istiyorum"). Compared in lower case.
export const IDEA_STOPWORDS = Object.freeze(
  new Set(
    (
      'ile ve veya ya da de ki bir bu şu o için icin gibi olan olarak üzerine uzerine üzerinde uzerinde kendi yeni basit küçük kucuk büyük buyuk ' +
      'çok cok daha en her mi mı mu mü ne nasıl nasil ben benim bana biz bizim sen senin şey sey tabanlı tabanli destekli tane olsun ' +
      'yapmak yapan yapacak yapıyorum yapiyorum yap istiyorum isterim istiyoruz lazım lazim gerek yazmak yazan oluşturmak olusturmak ' +
      'geliştirmek gelistirmek geliştirme gelistirme development develop developing hazırlamak hazirlamak kurmak tasarlamak uygulama uygulaması uygulamasi uygulamayı uygulamayi ' +
      'proje projesi projem program programı programi sistem sistemi araç arac aracı araci ' +
      'a an the and or with without in on for to of my our your i we me it its is are be using use based that which this ' +
      'like some from by into want wants build building make making create creating simple small new app apps application ' +
      'applications project tool thing things'
    ).split(' '),
  ),
);
// At most this many other words of an idea are kept (ideaKeywords)
export const IDEA_KEYWORDS_MAX = 8;

// The other words of an idea: those no dictionary entry took and no stop word, at least two characters, once each
// (the first spelling), at most IDEA_KEYWORDS_MAX. They only order candidates that fit anyway ("2D" puts a 2D skill
// first among the Unity skills). Returns [{ w: lower case, raw: as written }].
export function ideaKeywords(text) {
  const ws = words(text);
  const taken = new Set();
  scan(ws, false, (hit, i) => {
    for (let k = 0; k < hit.parts.length; k++) taken.add(i + k);
  });
  const out = [];
  const seen = new Set();
  for (let i = 0; i < ws.length && out.length < IDEA_KEYWORDS_MAX; i++) {
    const { w, raw } = ws[i];
    if (taken.has(i) || w.length < 2 || /^\d+$/.test(w) || IDEA_STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push({ w, raw: raw.slice(0, IDEA_WORD_MAX) });
  }
  return out;
}

// Does an idea keyword occur in a set of lower-case words: the same word, or one starts with the other and the
// shorter has at least 5 letters (Turkish suffixes: platform / platformu)
export function keywordIn(k, set) {
  if (set.has(k)) return true;
  if (k.length < 5) return false;
  for (const w of set) if (w.length >= 5 && (w.startsWith(k) || k.startsWith(w))) return true;
  return false;
}

// Adds the tags a tag implies (expo -> react-native, mobile; unity -> gamedev), once
export function withImplied(tags) {
  const out = new Set(tags);
  const queue = [...out];
  while (queue.length) {
    const t = TAG_BY_ID.get(queue.shift());
    for (const x of t?.implies || []) {
      if (!out.has(x)) {
        out.add(x);
        queue.push(x);
      }
    }
  }
  return out;
}

// Tags of an item: its name (any case; a plugin item's "plugin:skill" name counts whole), its description (proper
// nouns need a capital) and its library category. Returns a sorted array of tag ids.
export function itemTags({ name = '', description = '', category = '' } = {}) {
  const out = new Set([...tagsInText(String(name).replace(/[-_.:/]+/g, ' ')), ...tagsInText(description, { strictCase: true })]);
  const c = CATEGORY_TAGS[String(category || '').toLowerCase()];
  if (c) out.add(c);
  return sortTags(withImplied(out));
}

// Stack tags first (frameworks, then languages), then topics; each group in dictionary order
const ORDER = new Map(TAGS.map((t, i) => [t.id, (t.kind === 'framework' ? 0 : t.kind === 'language' ? 1000 : 2000) + i]));
export function sortTags(tags) {
  return [...new Set(tags)].filter((t) => TAG_BY_ID.has(t)).sort((a, b) => ORDER.get(a) - ORDER.get(b));
}

// Primary stack of a tag set: its framework tags, or its language tags when it has no framework tag
export function primaryStacks(tags) {
  const list = [...tags].filter(isStack);
  const fw = list.filter(isFramework);
  return new Set(fw.length ? fw : list);
}

export const stacksOf = (tags) => new Set([...tags].filter(isStack));
export const topicsOf = (tags) => new Set([...tags].filter((t) => TAG_BY_ID.get(t)?.type === 'topic'));
