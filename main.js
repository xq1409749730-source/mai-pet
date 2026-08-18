// 樱岛麻衣 Q 版桌宠 —— 主进程
const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

// ---------- 形象图片文件夹：把图片放进去，桌宠直接用它当形象 ----------
const CHARACTER_DIR_NAME = '形象';
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

function characterDir() {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), CHARACTER_DIR_NAME)
    : path.join(__dirname, 'character');
}

function listCharacterImages() {
  try {
    const dir = characterDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
      .sort()
      .map(name => ({ name, url: pathToFileURL(path.join(dir, name)).href }));
  } catch (e) { return []; }
}

function findCharacterImage() {
  const list = listCharacterImages();
  if (list.length === 0) return null;
  const preferred = list.find(f => f.name.toLowerCase() === 'character.png') || list[0];
  return preferred.url;
}

function watchCharacterDir(win) {
  try {
    const dir = characterDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let timer = null;
    fs.watch(dir, () => {
      // 防抖：等文件写完（400ms 无新事件）再通知刷新
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('character-updated');
      }, 400);
    });
  } catch (e) { /* 忽略监视失败 */ }
}

// ---------- 可移植数据目录：全部限制在 E 盘，绝不写 C 盘 ----------
const dataDir = app.isPackaged
  ? path.join(path.dirname(process.execPath), '麻衣桌宠-数据')
  : path.join(__dirname, 'data');
app.setPath('userData', dataDir);
app.setPath('sessionData', dataDir);
app.setPath('cache', path.join(dataDir, 'Cache'));

let win = null;
let prevCpu = null;

function logDebug(msg) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, 'debug.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* 忽略日志失败 */ }
}

function posFile() { return path.join(dataDir, 'position.json'); }

function loadPos() {
  try {
    const p = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    if (Number.isInteger(p.x) && Number.isInteger(p.y)) return p;
  } catch (e) { /* 首次运行没有位置文件 */ }
  return null;
}

function savePos(x, y) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(posFile(), JSON.stringify({ x, y }));
  } catch (e) { /* 忽略写入失败 */ }
}

// 判断坐标是否落在某个显示器内（防止窗口跑到屏幕外）
function positionVisible(x, y) {
  try {
    return screen.getAllDisplays().some(d => {
      const b = d.workArea;
      return x >= b.x - 120 && x < b.x + b.width + 60 && y >= b.y - 60 && y < b.y + b.height;
    });
  } catch (e) { return true; }
}

// 把窗口位置夹回最近的显示器可见区域
function clampToScreen(x, y, w, h) {
  try {
    const areas = screen.getAllDisplays().map(d => d.workArea);
    let best = screen.getPrimaryDisplay().workArea;
    let bestDist = Infinity;
    const cx = x + w / 2, cy = y + h / 2;
    for (const a of areas) {
      const dx = Math.max(a.x - cx, cx - (a.x + a.width), 0);
      const dy = Math.max(a.y - cy, cy - (a.y + a.height), 0);
      const dist = dx + dy;
      if (dist < bestDist) { bestDist = dist; best = a; }
    }
    return [
      Math.round(Math.min(Math.max(x, best.x), best.x + best.width - w)),
      Math.round(Math.min(Math.max(y, best.y), best.y + best.height - h))
    ];
  } catch (e) { return [x, y]; }
}

// ---------- 系统状态 ----------
function cpuUsage() {
  const cpus = os.cpus();
  if (!prevCpu) {
    prevCpu = cpus.map(c => {
      const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      return { idle: c.times.idle, total };
    });
    return 0;
  }
  let idleDiff = 0, totalDiff = 0;
  for (let i = 0; i < cpus.length; i++) {
    const t = cpus[i].times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    idleDiff += idle - prevCpu[i].idle;
    totalDiff += total - prevCpu[i].total;
    prevCpu[i] = { idle, total };
  }
  if (totalDiff <= 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 100);
}

function memUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

// ---------- 前台窗口检测（识别当前任务） ----------
function foregroundApp() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'scripts', 'foreground.ps1');
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 9000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const o = JSON.parse(stdout.trim());
          resolve({
            title: o.title || '',
            process: String(o.process || '').toLowerCase(),
            path: o.path || ''
          });
        } catch (e) { resolve(null); }
      });
  });
}

// ---------- 窗口 ----------
function createWindow() {
  const saved = loadPos();
  const opts = {
    width: 320,
    height: 400,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  if (saved && positionVisible(saved.x, saved.y)) { opts.x = saved.x; opts.y = saved.y; }

  win = new BrowserWindow(opts);
  applyAlwaysOnTop();
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('move', () => {
    const [x, y] = win.getPosition();
    // 只在窗口可见时保存位置，避免存下屏幕外的坏坐标
    if (positionVisible(x, y)) savePos(x, y);
  });

  win.on('closed', () => { win = null; });

  // 渲染进程崩溃自动恢复
  win.webContents.on('render-process-gone', () => {
    logDebug('render-process-gone, reloading');
    try { win.reload(); } catch (e) { /* 忽略 */ }
  });

  watchCharacterDir(win);
}

// ---------- IPC ----------
ipcMain.handle('sys-stats', () => ({ cpu: cpuUsage(), mem: memUsage() }));
ipcMain.handle('foreground-app', () => foregroundApp());
ipcMain.handle('character-image', () => findCharacterImage());
ipcMain.handle('character-images', () => listCharacterImages());

ipcMain.handle('move-to', (_e, x, y) => {
  if (win && Number.isInteger(x) && Number.isInteger(y)) win.setPosition(x, y);
});

// 让窗口贴合形象图片大小（底部中心保持不动，且不出屏幕）
ipcMain.handle('resize-to', (_e, w, h) => {
  if (!win) return;
  const minW = 110, minH = 150;
  w = Math.max(minW, Math.round(w));
  h = Math.max(minH, Math.round(h));
  const [x, y] = win.getPosition();
  const [cw, ch] = win.getSize();
  let newX = x + (cw - w) / 2;
  let newY = y + ch - h; // 底部保持不动，脚脚不飘
  [newX, newY] = clampToScreen(newX, newY, w, h);
  win.setBounds({ x: newX, y: newY, width: w, height: h });
  applyAlwaysOnTop(); // 调整大小后重新置顶，防止 Windows 丢掉置顶标志
});

ipcMain.handle('reset-position', () => {
  if (win) {
    win.center();
    const [x, y] = win.getPosition();
    savePos(x, y);
    applyAlwaysOnTop();
  }
});

let currentOnTop = true;
// 用最高层级并定期重新置顶，避免「有时没置顶」（Windows 会偶尔丢弃置顶标志）
function applyAlwaysOnTop() {
  if (!win) return;
  try { win.setAlwaysOnTop(currentOnTop, 'screen-saver'); } catch (e) { /* 忽略 */ }
}

ipcMain.handle('set-ontop', (_e, flag) => {
  currentOnTop = !!flag;
  applyAlwaysOnTop();
  return win ? win.isAlwaysOnTop() : false;
});

ipcMain.handle('get-ontop', () => (win ? win.isAlwaysOnTop() : true));

ipcMain.handle('quit', () => { app.quit(); });

// ---------- AI 对话（DeepSeek 大模型） ----------
// 结构化情感上下文（角色/关系/状态/记忆/表达要求），DeepSeek 只负责自然表达
function buildSystemPrompt() {
  const r = readRelationship();
  const e = decayEmotion(readEmotion());
  const followups = dueFollowups();
  const mem = memoryContext();
  const fu = followups.length
    ? '【相关记忆】' + followups.map(f => '后辈今天（' + f.date.slice(5) + '）有一件' + f.event + (f.importance === 'high' ? '，很重要' : '')).join('；')
    : '';
  return [
    '【角色】你是麻衣风格的高冷学姐型桌宠，称呼用户为「后辈」。冷静、敏锐、偶尔傲娇，但关心必须自然，不使用夸张网络语。',
    '【当前关系】阶段：' + stageOf(r.intimacy).name + '；亲密度：' + r.intimacy + '；相处天数：' + (r.consecutiveDays || 0) + ' 天',
    '【当前状态】情绪：' + MOOD_INFO[e.mood].name + '；强度：' + (e.happiness >= 75 ? '高' : e.happiness >= 45 ? '中' : '低') + '；原因：' + (e.reason || '无特别事件') + '；精力：' + (e.energy >= 65 ? '充沛' : e.energy >= 40 ? '一般' : '偏低') + '；信任：' + e.trust,
    mem,
    fu,
    '【表达要求】1. 回复 1~3 句话，简短自然；2. 延续当前情绪，不要突然转换；3. 可以含蓄关心，不要说教；4. 不要每次都使用「哼」「笨蛋」；5. 不虚构未提供的共同经历；6. 不自行修改亲密度或写入记忆；7. 结尾尽量自然，不要总以问题结束；8. 用简体中文。',
  ].filter(l => l && l.trim()).join('\n');
}

function llmConfigFile() { return path.join(dataDir, 'llm-config.json'); }

function readLlmConfig() {
  try { return JSON.parse(fs.readFileSync(llmConfigFile(), 'utf8')); } catch (e) { return null; }
}

async function llmCall(messages, maxTokens) {
  const cfg = readLlmConfig();
  if (!cfg || !cfg.apiKey || !cfg.baseURL || !cfg.model) {
    throw new Error('AI 未配置（缺少 API 信息），请检查 llm-config.json');
  }
  const url = String(cfg.baseURL).replace(/\/+$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: maxTokens || 120,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('AI 接口返回 ' + resp.status + (text ? '：' + text.slice(0, 160) : ''));
  }
  const data = await resp.json();
  const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!reply || !reply.trim()) throw new Error('AI 返回为空');
  return reply.trim();
}

ipcMain.handle('llm-chat', async (_e, messages) => {
  if (!spendAi('chat')) return { ok: false, error: '今日 AI 聊天预算已用完（100 次），明天再聊吧' };
  try {
    const history = Array.isArray(messages) ? messages.slice(-10) : [];
    const dedupe = antiRepeatContext('chat');
    const reply = await llmCall([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: dedupe }, ...history], 220);
    // 生成后相似度检测：同场景重复 → 重试一次（独立预算 retry）
    if (isDuplicateInScene(reply, 'chat')) {
      const r2 = await retryLlm([{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: dedupe + '\n【重试】上一条生成的内容与历史重复了，请用完全不同的说法重新回答。' }, ...history], 220, 'chat');
      if (r2) {
        recordLine({ text: r2, scene: 'chat', mood: (readEmotion() || {}).mood || 'calm', kind: 'ai' });
        logDebug('llm-chat OK len=' + r2.length + ' (retried)');
        return { ok: true, reply: r2 };
      }
      // 重试仍重复 → 回退本地台词
      const local = pickLocalLine('chat');
      logDebug('llm-chat DEDUP-FALLBACK');
      return { ok: false, retryFailed: true, fallback: local || null, error: '与历史台词重复，已回退本地台词' };
    }
    recordLine({ text: reply, scene: 'chat', mood: (readEmotion() || {}).mood || 'calm', kind: 'ai' });
    logDebug('llm-chat OK len=' + reply.length);
    return { ok: true, reply };
  } catch (err) {
    logDebug('llm-chat ERR: ' + ((err && err.message) || String(err)));
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// 去重重试：独立每日上限，与 say/chat 预算互不影响
async function retryLlm(messages, maxTokens, scene) {
  try {
    if (!spendAi('retry')) return null; // 重试预算用完 → 不再重试（走回退）
    return await llmCall(messages, maxTokens);
  } catch (e) {
    logDebug('llm retry ERR: ' + ((e && e.message) || String(e)));
    return null;
  }
}

ipcMain.handle('llm-say', async (_e, prompt, scene) => {
  if (!spendAi('say')) return { ok: false, error: '今日 AI 自动说话预算已用完（40 次）' };
  const s = String(scene || 'other');
  try {
    const dedupe = antiRepeatContext(s);
    const reply = await llmCall([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: String(prompt || '随便说点什么').slice(0, 300) + '\n' + dedupe },
    ], 120);
    // 生成后相似度检测：同场景重复 → 重试一次
    if (isDuplicateInScene(reply, s)) {
      const r2 = await retryLlm([
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: String(prompt || '随便说点什么').slice(0, 300) + '\n' + dedupe + '\n【重试】上一条生成的内容与历史重复了，请用完全不同的说法。' },
      ], 120, s);
      if (r2) {
        recordLine({ text: r2, scene: s, mood: (readEmotion() || {}).mood || 'calm', kind: 'ai' });
        logDebug('llm-say OK len=' + r2.length + ' (retried)');
        return { ok: true, reply: r2 };
      }
      // 重试仍重复（或重试预算用完）→ 回退本地台词
      const local = pickLocalLine(s);
      logDebug('llm-say DEDUP-FALLBACK scene=' + s);
      return { ok: false, retryFailed: true, fallback: local || null, error: '与历史台词重复，已回退本地台词' };
    }
    recordLine({ text: reply, scene: s, mood: (readEmotion() || {}).mood || 'calm', kind: 'ai' });
    logDebug('llm-say OK len=' + reply.length);
    return { ok: true, reply };
  } catch (err) {
    logDebug('llm-say ERR: ' + ((err && err.message) || String(err)));
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('get-llm-config', () => {
  const c = readLlmConfig();
  if (!c) return { configured: false, model: '', provider: '', error: '未找到 llm-config.json' };
  const missing = [];
  if (!c.apiKey) missing.push('apiKey');
  if (!c.baseURL) missing.push('baseURL');
  if (!c.model) missing.push('model');
  return {
    configured: missing.length === 0,
    model: c.model || '',
    provider: c.provider || '',
    error: missing.length ? ('缺少: ' + missing.join(', ')) : ''
  };
});

// ---------- 桌面快捷方式 & 开机自启 ----------
function startupLnk() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '麻衣桌宠.lnk');
}
function desktopLnk() {
  return path.join(app.getPath('desktop'), '麻衣桌宠.lnk');
}
function autostartOn() {
  try { return fs.existsSync(startupLnk()); } catch (e) { return false; }
}
// 用 PowerShell COM 创建 .lnk（Electron shell.writeShortcutLink 在本机静默失败，改用更可靠的方式）
function writeShortcutPwsh(lnkPath, targetPath, workDir) {
  return new Promise((resolve) => {
    const esc = (p) => String(p).replace(/'/g, "''");
    const script =
      "$ws = New-Object -ComObject WScript.Shell;" +
      "$sc = $ws.CreateShortcut('" + esc(lnkPath) + "');" +
      "$sc.TargetPath = '" + esc(targetPath) + "';" +
      "$sc.WorkingDirectory = '" + esc(workDir) + "';" +
      "$sc.Description = '樱岛麻衣 Q 版桌宠';" +
      "$sc.Save()";
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true },
      (err) => resolve(!err));
  });
}

ipcMain.handle('toggle-autostart', async () => {
  try {
    const lnk = startupLnk();
    if (fs.existsSync(lnk)) {
      fs.unlinkSync(lnk);
      logDebug('autostart off');
      return { ok: true, enabled: false };
    }
    const ok = await writeShortcutPwsh(lnk, process.execPath, path.dirname(process.execPath));
    logDebug('autostart on ok=' + ok);
    return ok ? { ok: true, enabled: true } : { ok: false, error: '创建启动快捷方式失败' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('create-desktop-shortcut', async () => {
  try {
    const ok = await writeShortcutPwsh(desktopLnk(), process.execPath, path.dirname(process.execPath));
    logDebug('desktop shortcut ok=' + ok);
    return ok ? { ok: true, path: desktopLnk() } : { ok: false, error: '创建桌面快捷方式失败' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ---------- 记忆系统（memory/ 目录，三层记忆：基础/近期/长期） ----------
const MEMORY_DIR = path.join(dataDir, 'memory');
const RECENT_TTL_MS = 30 * 24 * 3600 * 1000; // 近期记忆 30 天过期
const RECENT_MAX = 50;

function memoryFile(name) { return path.join(MEMORY_DIR, name + '.json'); }

function readMemory(name) {
  try { return JSON.parse(fs.readFileSync(memoryFile(name), 'utf8')) || null; }
  catch (e) { return null; }
}

function writeMemory(name, data) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const file = memoryFile(name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // 原子写，避免半写损坏
  logDebug('memory write: ' + name);
  return true;
}

function getRecent() {
  const data = readMemory('recent') || { schemaVersion: 1, entries: [] };
  const cutoff = Date.now() - RECENT_TTL_MS;
  const entries = (data.entries || []).filter(e => e && e.ts && e.ts >= cutoff).slice(-RECENT_MAX);
  return { schemaVersion: 1, entries };
}

ipcMain.handle('get-memory', () => ({
  profile: readMemory('profile') || { schemaVersion: 1, name: '', preferences: {}, importantDates: [] },
  recent: getRecent(),
  milestones: readMemory('milestones') || { schemaVersion: 1, entries: [] },
}));

ipcMain.handle('save-memory', (_e, section, value) => {
  try {
    if (section === 'profile') writeMemory('profile', Object.assign({ schemaVersion: 1 }, value || {}));
    else if (section === 'milestones') writeMemory('milestones', Object.assign({ schemaVersion: 1 }, value || {}));
    else return { ok: false, error: 'unsupported section' };
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('add-recent', (_e, entry) => {
  try {
    const recent = getRecent();
    recent.entries.push({ ts: Date.now(), category: String((entry && entry.category) || 'note'), summary: String((entry && entry.summary) || '') });
    writeMemory('recent', recent);
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('delete-recent', (_e, index) => {
  try {
    const recent = getRecent();
    if (typeof index === 'number' && index >= 0 && index < recent.entries.length) {
      recent.entries.splice(index, 1);
      writeMemory('recent', recent);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('add-milestone', (_e, m) => {
  try {
    const data = readMemory('milestones') || { schemaVersion: 1, entries: [] };
    data.entries.push({ ts: Date.now(), title: String((m && m.title) || ''), note: String((m && m.note) || '') });
    writeMemory('milestones', data);
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('delete-milestone', (_e, index) => {
  try {
    const data = readMemory('milestones') || { schemaVersion: 1, entries: [] };
    if (typeof index === 'number' && index >= 0 && index < data.entries.length) {
      data.entries.splice(index, 1);
      writeMemory('milestones', data);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('clear-memory', (_e, section) => {
  try {
    if (section === 'recent') writeMemory('recent', { schemaVersion: 1, entries: [] });
    else if (section === 'milestones') writeMemory('milestones', { schemaVersion: 1, entries: [] });
    else if (section === 'profile') writeMemory('profile', { schemaVersion: 1, name: '', preferences: {}, importantDates: [] });
    else return { ok: false, error: 'unsupported section' };
    return { ok: true };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// ---------- 亲密度与关系阶段（本地规则，AI 无权修改） ----------
const INTIMACY_STAGES = [
  { min: 0, name: '初识后辈' },
  { min: 15, name: '熟悉的后辈' },
  { min: 50, name: '值得关心的后辈' },
  { min: 120, name: '特别的后辈' },
  { min: 250, name: '重要之人' },
];
const INTIMACY_DAILY_CAPS = { chat: 3, response: 2 }; // 每类每日亲密度上限（防刷）
const CONSECUTIVE_MILESTONES = { 7: 3, 30: 5, 100: 10, 365: 20 }; // 天: 奖励，每个里程碑仅一次
const intimacyToday = {}; // category -> 今日已加次数（进程内，重启重置；阶段8加固为持久化）

function defaultRelationship() {
  return {
    schemaVersion: 1, intimacy: 0, consecutiveDays: 0, lastSeenDate: '', updatedAt: 0,
    claimedMilestones: [],       // 已领取的连续陪伴里程碑（仅一次）
    importantDateClaims: {},     // 重要日期 -> 最近领取年份（每年一次）
  };
}
function readRelationship() {
  return Object.assign(defaultRelationship(), readMemory('relationship') || {});
}
function stageOf(intimacy) {
  let stage = INTIMACY_STAGES[0];
  for (const s of INTIMACY_STAGES) if (intimacy >= s.min) stage = s;
  return stage;
}
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayIsImportantDate() {
  const profile = readMemory('profile') || {};
  const dates = Array.isArray(profile.importantDates) ? profile.importantDates : [];
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  for (const item of dates) {
    const dt = String((item && item.date) || '').trim();
    if (!dt) continue;
    const m = dt.match(/(\d{1,2})[-/月](\d{1,2})/);
    if (m && String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0') === mmdd) return item.label || dt;
    if (dt === mmdd) return item.label || dt;
  }
  return null;
}

// 每日仪式：签到(+1)、重要日期(+5 每年一次)、连续陪伴里程碑(每个仅一次)、阶段变化 → 写记忆
ipcMain.handle('daily-ritual', () => {
  try {
    const r = readRelationship();
    const today = todayKey();
    const before = r.intimacy;
    const oldConsecutive = r.consecutiveDays || 0;
    const oldStage = stageOf(before).name;
    const result = { intimacy: before, stage: oldStage, consecutiveDays: r.consecutiveDays, changed: false, newStage: null, bonus: 0, events: [], already: false };
    if (r.lastSeenDate === today) { result.already = true; return { ok: true, ...result }; }

    const yesterday = new Date(Date.now() - 86400000);
    const yKey = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
    r.consecutiveDays = (r.lastSeenDate === yKey) ? (r.consecutiveDays || 0) + 1 : 1;

    r.intimacy += 1; result.bonus += 1; // 每日签到
    applyEmotionEvent('daily-visit'); // 每日见面：情绪归平静

    // 久别重逢：连续天数重置 → 失落
    if (oldConsecutive > 1 && r.consecutiveDays === 1) applyEmotionEvent('long-absence');

    // 重要日期：每个日期每年只奖励一次
    const imp = todayIsImportantDate();
    if (imp) {
      const claims = r.importantDateClaims || {};
      const year = new Date().getFullYear();
      if (claims[imp] !== year) {
        claims[imp] = year;
        r.importantDateClaims = claims;
        r.intimacy += 5; result.bonus += 5; result.events.push('重要日子：' + imp);
        const m = readMemory('milestones') || { schemaVersion: 1, entries: [] };
        if (!m.entries.some(e => e.title === imp)) {
          m.entries.push({ ts: Date.now(), title: imp, note: '和麻衣一起度过的特别日子' });
          writeMemory('milestones', m);
        }
      }
    }

    // 连续陪伴里程碑：每个里程碑仅领取一次（7:+3 30:+5 100:+10 365:+20）
    const claimed = r.claimedMilestones || [];
    for (const [days, bonus] of Object.entries(CONSECUTIVE_MILESTONES)) {
      if (r.consecutiveDays === +days && !claimed.includes(+days)) {
        claimed.push(+days);
        r.claimedMilestones = claimed;
        r.intimacy += bonus; result.bonus += bonus; result.events.push('连续陪伴 ' + days + ' 天');
        const m = readMemory('milestones') || { schemaVersion: 1, entries: [] };
        m.entries.push({ ts: Date.now(), title: '连续陪伴 ' + days + ' 天', note: '风雨无阻，麻衣都记着' });
        writeMemory('milestones', m);
      }
    }

    r.lastSeenDate = today;
    r.updatedAt = Date.now();
    writeMemory('relationship', r);

    const newStage = stageOf(r.intimacy);
    result.intimacy = r.intimacy;
    result.consecutiveDays = r.consecutiveDays;
    if (newStage.name !== oldStage) {
      result.newStage = newStage.name;
      result.changed = true;
      applyEmotionEvent('praise'); // 关系升级：开心/害羞
      const m = readMemory('milestones') || { schemaVersion: 1, entries: [] };
      m.entries.push({ ts: Date.now(), title: '关系升级：' + newStage.name, note: '你和麻衣的关系更近了一步' });
      writeMemory('milestones', m);
    }
    const recent = getRecent();
    recent.entries.push({ ts: Date.now(), category: 'daily', summary: '每日首次见面：和麻衣打了招呼' + (result.bonus > 1 ? '（+' + result.bonus + ' 亲密）' : '') });
    writeMemory('recent', recent);

    result.followups = dueFollowups(); // 到期的约定（每日一次，会标记已提醒）

    return { ok: true, ...result };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// 有意义的互动加亲密度（本地规则 + 每日上限）
ipcMain.handle('add-intimacy', (_e, category, amount) => {
  try {
    const key = todayKey();
    if (intimacyToday[key] === undefined) intimacyToday[key] = {};
    const cap = INTIMACY_DAILY_CAPS[category];
    if (cap === undefined) return { ok: false, error: 'unsupported category' };
    const used = intimacyToday[key][category] || 0;
    if (used >= cap) { const r = readRelationship(); return { ok: true, intimacy: r.intimacy, stage: stageOf(r.intimacy).name, capped: true }; }
    intimacyToday[key][category] = used + 1;
    const r = readRelationship();
    r.intimacy += (amount || 1);
    r.updatedAt = Date.now();
    writeMemory('relationship', r);
    return { ok: true, intimacy: r.intimacy, stage: stageOf(r.intimacy).name };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('get-relationship', () => {
  const r = readRelationship();
  const cur = stageOf(r.intimacy);
  const idx = INTIMACY_STAGES.indexOf(cur);
  const next = INTIMACY_STAGES[idx + 1] || null;
  return {
    ok: true, intimacy: r.intimacy, stage: cur.name, consecutiveDays: r.consecutiveDays,
    lastSeenDate: r.lastSeenDate, stageMin: cur.min, nextStageMin: next ? next.min : null,
  };
});

// ---------- 情感引擎（连续情绪状态，本地规则计算，AI 只负责表达） ----------
const MOOD_INFO = {
  calm:      { name: '平静', image: 'book' },
  happy:     { name: '开心', image: 'happy' },
  shy:       { name: '害羞', image: 'click' },
  concerned: { name: '担心', image: 'remind' },
  upset:     { name: '小生气', image: 'angry' },
  lonely:    { name: '失落', image: 'book' },
  tired:     { name: '困倦', image: 'sleepy' },
  expectant: { name: '期待', image: 'wave' },
  relieved:  { name: '安心', image: 'book' },
};
const MOOD_EXPIRE_MS = 30 * 60000; // 情绪持续约 30 分钟后缓慢回平静
const TRUST_BY_STAGE = [40, 55, 70, 85, 95]; // 按关系阶段（0~4）

function defaultEmotion() {
  return { schemaVersion: 1, mood: 'calm', happiness: 55, energy: 60, trust: 40, reason: '', since: 0, updatedAt: 0 };
}
function readEmotion() {
  return Object.assign(defaultEmotion(), readMemory('emotion') || {});
}
function stageIndex() {
  const r = readRelationship();
  const cur = stageOf(r.intimacy);
  return INTIMACY_STAGES.indexOf(cur);
}
// 情绪衰减：mood 超时回平静；happiness/energy 缓慢趋向基线
function decayEmotion(e) {
  const now = Date.now();
  if (e.mood !== 'calm' && now - (e.since || now) > MOOD_EXPIRE_MS) {
    e.mood = 'calm';
    e.reason = '';
  }
  const base = defaultEmotion();
  if (e.happiness > base.happiness) e.happiness = Math.max(base.happiness, e.happiness - 1);
  if (e.happiness < base.happiness) e.happiness = Math.min(base.happiness, e.happiness + 1);
  if (e.energy > base.energy) e.energy = Math.max(base.energy, e.energy - 1);
  if (e.energy < base.energy) e.energy = Math.min(base.energy, e.energy + 1);
  // trust 不低于当前阶段基线
  const trustFloor = TRUST_BY_STAGE[Math.min(stageIndex(), TRUST_BY_STAGE.length - 1)] || 40;
  if (e.trust < trustFloor) e.trust = trustFloor;
  return e;
}
// 情绪事件规则：用户事件 → 本地规则改变情绪 + 保存原因
function applyEmotionEvent(eventType, detail) {
  const e = decayEmotion(readEmotion());
  const now = Date.now();
  const hour = new Date().getHours();
  switch (eventType) {
    case 'daily-visit':
      e.mood = 'calm'; e.happiness = Math.min(100, e.happiness + 2); e.energy = Math.min(100, e.energy + 5);
      e.reason = '和麻衣打了招呼'; break;
    case 'long-activity':
      e.mood = 'concerned'; e.reason = (detail && detail.text) || '后辈连续使用电脑很久了';
      e.energy = Math.max(0, e.energy - 3); break;
    case 'high-load':
      e.mood = 'concerned'; e.reason = '后辈的电脑负载很高，有点担心'; e.energy = Math.max(0, e.energy - 2); break;
    case 'late-night':
      if (e.mood === 'calm' || e.mood === 'happy') { e.mood = hour >= 23 ? 'concerned' : 'calm'; }
      e.reason = '已经很晚了，后辈'; break;
    case 'idle':
      e.mood = 'tired'; e.reason = '后辈好久没动静了'; e.energy = Math.max(0, e.energy - 2); break;
    case 'user-ok':
      e.mood = 'relieved'; e.reason = '后辈听进去了，放心多了'; e.happiness = Math.min(100, e.happiness + 3); break;
    case 'praise':
      e.mood = Math.random() < 0.5 ? 'shy' : 'happy'; e.reason = '和麻衣的关系更进一步';
      e.happiness = Math.min(100, e.happiness + 8); break;
    case 'ignored-reminder':
      e.mood = 'upset'; e.reason = '后辈又没理我的提醒'; e.happiness = Math.max(0, e.happiness - 4); break;
    case 'long-absence':
      e.mood = 'lonely'; e.reason = '好久没见到后辈了'; break;
    case 'chat':
      e.happiness = Math.min(100, e.happiness + 2); e.trust = Math.min(100, e.trust + 1);
      if (e.mood !== 'concerned' && e.mood !== 'upset' && e.mood !== 'lonely') e.mood = Math.random() < 0.4 ? 'happy' : e.mood;
      e.reason = '和后辈聊得很开心'; break;
    case 'drag':
      e.mood = 'upset'; e.reason = '被后辈拎起来了'; break;
  }
  e.since = now;
  e.updatedAt = now;
  writeMemory('emotion', e);
  return e;
}

ipcMain.handle('get-emotion', () => {
  const e = decayEmotion(readEmotion());
  return { ok: true, mood: e.mood, moodName: MOOD_INFO[e.mood].name, image: MOOD_INFO[e.mood].image, happiness: e.happiness, energy: e.energy, trust: e.trust, reason: e.reason };
});

ipcMain.handle('emotion-event', (_e, eventType, detail) => {
  try {
    const e = applyEmotionEvent(String(eventType || ''), detail);
    return { ok: true, mood: e.mood, moodName: MOOD_INFO[e.mood].name, image: MOOD_INFO[e.mood].image, happiness: e.happiness, energy: e.energy, trust: e.trust, reason: e.reason };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// ---------- 约定与回访 ----------
function followupFile() { return path.join(dataDir, 'memory', 'followups.json'); }
function readFollowups() {
  try { const f = JSON.parse(fs.readFileSync(followupFile(), 'utf8')); return Array.isArray(f.entries) ? f : { schemaVersion: 1, entries: [] }; }
  catch (e) { return { schemaVersion: 1, entries: [] }; }
}
function writeFollowups(f) {
  try { fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true }); fs.writeFileSync(followupFile(), JSON.stringify(f, null, 2)); } catch (e) { /* 忽略 */ }
}
// 解析"明天/后天/星期X + 事件"
function parseFollowup(text) {
  const t = String(text || '');
  let date = null;
  let m = t.match(/明天(?:早上|上午|中午|下午|晚上|一早)?[，,、 ]*(.+)/);
  let daysAhead = 1;
  if (!m) { m = t.match(/后天[，,、 ]*(.+)/); daysAhead = 2; }
  if (!m) return null;
  const subject = (m[1] || '').trim().slice(0, 14);
  if (subject.length < 1) return null;
  const d = new Date(Date.now() + daysAhead * 86400000);
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return { event: subject, date: dateStr, importance: 'high', followUp: true, createdTs: Date.now(), reminded: false };
}
ipcMain.handle('add-followup', (_e, text) => {
  try {
    const fu = parseFollowup(text);
    if (!fu) return { ok: false, found: false };
    const f = readFollowups();
    f.entries.push(fu);
    writeFollowups(f);
    return { ok: true, found: true, event: fu.event, date: fu.date };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});
// 到期的约定（今天或昨天未提醒的），并标记已提醒（每日一次）
function dueFollowups() {
  const f = readFollowups();
  const today = todayKey();
  const yesterday = new Date(Date.now() - 86400000);
  const yKey = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
  const due = f.entries.filter(e => !e.reminded && (e.date === today || e.date === yKey));
  if (due.length) {
    f.entries.forEach(e => { if (due.includes(e)) e.reminded = true; });
    writeFollowups(f);
  }
  return due.map(e => ({ event: e.event, date: e.date, importance: e.importance }));
}

// ---------- AI 调用预算与记忆上下文 ----------
const AI_DAILY_LIMIT = { say: 40, chat: 100, retry: 20 }; // retry: 去重重试独立计数
function aiUsageFile() { return path.join(dataDir, 'memory', 'ai-usage.json'); }
function readAiUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(aiUsageFile(), 'utf8'));
    if (u && u.date === todayKey()) return u;
  } catch (e) { /* 首次使用 */ }
  return { date: todayKey(), say: 0, chat: 0, retry: 0 };
}
function spendAi(kind) {
  const u = readAiUsage();
  if (u[kind] >= AI_DAILY_LIMIT[kind]) return false;
  u[kind] += 1;
  try { fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true }); fs.writeFileSync(aiUsageFile(), JSON.stringify(u)); } catch (e) { /* 忽略 */ }
  return true;
}
// AI 上下文：关系阶段 + 近期记忆摘要（不发送完整历史）
function memoryContext() {
  const r = readRelationship();
  const relLine = '（当前关系：' + stageOf(r.intimacy).name + '，连续陪伴 ' + (r.consecutiveDays || 0) + ' 天）';
  const recent = getRecent();
  const entries = recent.entries.slice(-5);
  if (!entries.length) return relLine;
  const lines = entries.map(e => {
    const d = new Date(e.ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(e.summary || '').slice(0, 40);
  });
  return relLine + '\n【近期记忆摘要】\n' + lines.join('\n');
}

// ---------- 台词去重与多样性系统（recent-lines.json 原子写 + 损坏自愈） ----------
const LINES_AI_MAX = 50;      // AI 台词历史上限
const LINES_LOCAL_MAX = 30;   // 本地台词历史上限
const LINES_SIM_THRESHOLD = 0.72; // 同场景相似度阈值，超过视为重复
const LINES_ANGLES = ['tsundere', 'care', 'tease', 'command', 'complaint', 'shy', 'greet', 'other'];

function linesFile() { return path.join(dataDir, 'memory', 'recent-lines.json'); }

// 中文文本标准化：NFKC + 全角转半角 + 去标点/空白/颜文字 + 去常用虚词 + 小写
function normalizeText(text) {
  let s = String(text || '');
  try { s = s.normalize('NFKC'); } catch (e) { /* 忽略 */ }
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角→半角
  s = s.replace(/[（(【［「『]|[）)】］」』]/g, ''); // 括号（保留内容）
  s = s.replace(/[^\p{L}\p{N}]+/gu, ''); // 只留文字和数字
  s = s.replace(/[的了么吗呢啊吧呀哦嗯哈都就在还这那很挺]/g, ''); // 常用虚词/衬字（提升同义改写检测）
  return s.toLowerCase();
}

// 最长公共子序列比例（对插入/删减型改写敏感）
function lcsRatio(a, b) {
  const A = normalizeText(a), B = normalizeText(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const m = A.length, n = B.length;
  let prev = new Array(n + 1).fill(0), cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t; cur.fill(0);
  }
  return prev[n] / Math.min(m, n);
}

// 相似度：bigram Dice、字符 Jaccard、LCS 比例 三者取最大（覆盖换词/乱序/删减三类改写）
function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // bigram Dice
  const grams = s => {
    const g = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      g.set(k, (g.get(k) || 0) + 1);
    }
    return g;
  };
  const ga = grams(na), gb = grams(nb);
  let inter = 0, totalA = 0, totalB = 0;
  ga.forEach((cnt, k) => { totalA += cnt; if (gb.has(k)) inter += Math.min(cnt, gb.get(k)); });
  gb.forEach(cnt => { totalB += cnt; });
  const dice = totalA + totalB === 0 ? 0 : (2 * inter) / (totalA + totalB);
  // 字符 Jaccard（对语序调整更敏感）
  const setA = new Set(na.split(''));
  const setB = new Set(nb.split(''));
  let uni = 0;
  setA.forEach(c => { if (setB.has(c)) uni++; });
  const jaccard = setA.size + setB.size === 0 ? 0 : uni / (setA.size + setB.size - uni);
  return Math.max(dice, jaccard, lcsRatio(a, b));
}

// 表达角度分类：规则判定（不依赖调用方）
function classifyAngle(text) {
  const t = String(text || '');
  if (/才不是|才没有|才不|不是.*在意|没.*等你|谁.*等|哼/.test(t)) return 'tsundere';
  if (/脸红|害羞|别.*靠|靠.*近|盯着我|看.*什么/.test(t)) return 'shy';
  if (/记得|别忘了|别忘|该|应该|快|去喝|去走|动一动|休息|保存|起来|关掉|别玩|别看/.test(t)) return 'command';
  if (/关心|担心|心疼|不想你|希望你|加油|辛苦|努力|会陪|看着你|惦记/.test(t)) return 'care';
  if (/好无聊|好傻|抗议|冒烟|累趴|告急|没品味|有品味|还不错|有点意思/.test(t)) return 'tease';
  if (/干嘛|别戳|别拎|放我下来|失礼|轻点|弄乱|不理你|够了|烦/.test(t)) return 'complaint';
  if (/早上好|早安|中午|午休|晚安|晚上好|天黑了|起床|报时|整点/.test(t)) return 'greet';
  return 'other';
}

// 读台词历史（损坏时自动恢复：坏文件改名备份 → 重建空结构）
function readLines() {
  const fallback = { schemaVersion: 1, entries: [] };
  try {
    const raw = fs.readFileSync(linesFile(), 'utf8');
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.entries)) return fallback;
    return d;
  } catch (e) {
    // 损坏：改名备份后重建
    try {
      if (fs.existsSync(linesFile())) {
        fs.renameSync(linesFile(), linesFile() + '.bak-' + Date.now());
        logDebug('recent-lines 损坏已备份重建');
      }
    } catch (e2) { /* 忽略 */ }
    return fallback;
  }
}

// 原子写入：tmp + rename
function writeLines(d) {
  fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
  const file = linesFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file);
}

// 记录一条台词（kind: 'ai' 或 'local'，各自独立上限裁剪）
function recordLine(entry) {
  try {
    const d = readLines();
    const kind = entry.kind === 'local' ? 'local' : 'ai';
    const max = kind === 'local' ? LINES_LOCAL_MAX : LINES_AI_MAX;
    const e = {
      text: String(entry.text || '').trim(),
      scene: String(entry.scene || 'other').trim(),
      mood: String(entry.mood || 'calm').trim(),
      angle: classifyAngle(entry.text),
      ts: Date.now(),
      kind,
    };
    if (!e.text) return null;
    d.entries.push(e);
    // 各自裁剪：保留 kind 的前 max 条（时间升序，丢最旧）
    const byKind = d.entries.filter(x => x.kind === kind);
    const otherKind = d.entries.filter(x => x.kind !== kind);
    while (byKind.length > max) byKind.shift();
    d.entries = [...otherKind, ...byKind].sort((a, b) => a.ts - b.ts);
    writeLines(d);
    logDebug('line record: ' + kind + ' scene=' + e.scene + ' angle=' + e.angle);
    return e;
  } catch (e) { return null; }
}

// 同场景最近台词（时间倒序，最多 12 条、至少返回已有全部）
function recentForScene(scene, max) {
  const d = readLines();
  return d.entries
    .filter(x => x.scene === scene)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, max || 12);
}

// 同场景最近一条（用于角度轮换）
function lastLineForScene(scene) {
  const list = recentForScene(scene, 1);
  return list.length ? list[0] : null;
}

// 检测某文本与同场景历史是否重复（相似度 > 阈值 或 完全相同）
function isDuplicateInScene(text, scene, excludeTs) {
  const n = normalizeText(text);
  if (!n) return false;
  const hist = readLines().entries.filter(x => x.scene === scene && x.ts !== excludeTs);
  return hist.some(x => {
    const s = similarity(text, x.text);
    return s > LINES_SIM_THRESHOLD;
  });
}

// 高频用语统计：历史中「后辈/哼/才不是/笨蛋」等出现次数（近 24 小时）
function highFreqWords() {
  const cut = Date.now() - 24 * 3600 * 1000;
  const texts = readLines().entries.filter(x => x.ts >= cut).map(x => x.text).join('\n');
  const words = [
    { w: '后辈', limit: 5 }, { w: '哼', limit: 2 }, { w: '才不是', limit: 1 },
    { w: '才没有', limit: 1 }, { w: '笨蛋', limit: 1 }, { w: '嘛', limit: 2 },
  ];
  const hits = [];
  for (const { w, limit } of words) {
    const n = (texts.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (n > limit) hits.push(w);
  }
  return hits;
}

// 生成前注入：同场景最近台词 + 角度轮换 + 高频词限制
function antiRepeatContext(scene) {
  const hist = recentForScene(scene, 12);
  const lines = [];
  if (hist.length) {
    lines.push('【本场景最近出现过的台词（' + scene + '）——禁止复述或近义改写】：');
    hist.slice(0, 12).forEach((h, i) => { lines.push((i + 1) + '. ' + h.text); });
  }
  const last = lastLineForScene(scene);
  if (last && last.angle !== 'other') {
    lines.push('【表达角度】上一次这个场景用了「' + last.angle + '」角度，这次请换一种完全不同的表达角度。');
  }
  const hf = highFreqWords();
  if (hf.length) {
    lines.push('【高频词限制】近期已频繁使用：' + hf.join('、') + '。本条请尽量避免这些词（「后辈」可用「你」代替）。');
  }
  lines.push('【要求】内容不要与上面任何一条历史台词相似（包括近义改写）。');
  return lines.join('\n');
}

// 选择本地台词：滑动窗口冷却(最近4条) + 历史相似过滤 + 角度轮换
const LOCAL_COOLDOWN_WINDOW = 4; // 同一场景最近 N 条进入冷却（不重复）
function pickLocalLine(scene) {
  try {
    const phrases = LOCAL_PHRASES[scene] || [];
    if (!phrases.length) return null;
    const hist = readLines().entries
      .filter(x => x.kind === 'local' && x.scene === scene)
      .sort((a, b) => b.ts - a.ts); // 新→旧
    const last = hist.length ? hist[0] : null;
    // 候选：不在冷却窗口内、与历史不相似、且与上一条角度不同
    let pool = phrases.filter(p => {
      const inCooldown = hist.slice(0, LOCAL_COOLDOWN_WINDOW).some(h => h.text === p);
      if (inCooldown) return false;
      if (hist.some(h => similarity(p, h.text) > LINES_SIM_THRESHOLD)) return false;
      if (last && classifyAngle(p) === last.angle && classifyAngle(p) !== 'other') return false;
      return true;
    });
    if (!pool.length) {
      // 全冷却 → 放宽：只排除冷却窗口内的（保证有话说，且优先换新台词）
      pool = phrases.filter(p => !hist.slice(0, LOCAL_COOLDOWN_WINDOW).some(h => h.text === p));
    }
    if (!pool.length) pool = phrases.slice();
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (e) { return null; }
}

// 本地台词库（渲染端启动时注册）
let LOCAL_PHRASES = {};
ipcMain.handle('register-phrases', (_e, phrases) => {
  try {
    LOCAL_PHRASES = (phrases && typeof phrases === 'object') ? phrases : {};
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle('pick-local', (_e, scene) => {
  const line = pickLocalLine(String(scene || 'other'));
  return { ok: !!line, line };
});
ipcMain.handle('record-line', (_e, entry) => {
  const e = recordLine(entry);
  return { ok: !!e, line: e };
});
ipcMain.handle('get-recent-lines', () => {
  try { return { ok: true, data: readLines() }; } catch (e) { return { ok: false, error: String(e) }; }
});

// ---------- 右键菜单（系统原生菜单，小窗口也不会被裁剪） ----------
function sendAction(action, payload) {
  logDebug('menu-action: ' + action + (payload === undefined ? '' : ' ' + JSON.stringify(payload)));
  if (win && !win.isDestroyed()) win.webContents.send('menu-action', { action, payload });
}

ipcMain.handle('show-context-menu', (_e, state) => {
  if (!win) return;
  const s = {
    reminders: (state && state.reminders) || {},
    imageSize: (state && state.imageSize) || 'm',
    imageName: (state && state.imageName) || '',
    onTop: !!(state && state.onTop),
    aiEnabled: !!(state && state.aiEnabled),
    aiManualOnly: !!(state && state.aiManualOnly),
    llmConfigured: !!(state && state.llmConfigured),
    llmModel: (state && state.llmModel) || '',
    chatOpen: !!(state && state.chatOpen),
    activityMode: (state && state.activityMode) || 'daily',
    dndActive: !!(state && state.dndActive),
    relStage: (state && state.relStage) || '初识后辈',
    relIntimacy: (state && typeof state.relIntimacy === 'number') ? state.relIntimacy : 0,
    showIntimacy: !!(state && state.showIntimacy),
    images: Array.isArray(state && state.images) ? state.images : [],
  };
  const template = [
    {
      label: '健康提醒',
      submenu: [
        { label: '久坐提醒', type: 'checkbox', checked: !!s.reminders.sit, click: () => sendAction('toggle-reminder', 'sit') },
        { label: '喝水提醒', type: 'checkbox', checked: !!s.reminders.water, click: () => sendAction('toggle-reminder', 'water') },
        { label: '休息提醒', type: 'checkbox', checked: !!s.reminders.rest, click: () => sendAction('toggle-reminder', 'rest') },
      ],
    },
    {
      label: '形象大小',
      submenu: [
        { label: '小', type: 'radio', checked: s.imageSize === 's', click: () => sendAction('set-image-size', 's') },
        { label: '中', type: 'radio', checked: s.imageSize === 'm', click: () => sendAction('set-image-size', 'm') },
        { label: '大', type: 'radio', checked: s.imageSize === 'l', click: () => sendAction('set-image-size', 'l') },
      ],
    },
    {
      label: 'AI 对话',
      submenu: [
        { label: s.chatOpen ? '关闭聊天输入框' : '打开聊天输入框', click: () => sendAction('toggle-chat') },
        { label: s.aiEnabled ? '关闭 AI 自动说话' : '开启 AI 自动说话', click: () => sendAction('toggle-ai-enabled') },
        { label: '仅手动聊天时使用 AI', type: 'checkbox', checked: !!s.aiManualOnly, click: () => sendAction('toggle-ai-manual') },
        { label: s.llmConfigured ? ('AI 已连接（' + s.llmModel + '）') : 'AI 未配置', enabled: false },
      ],
    },
    {
      label: '主动程度',
      submenu: [
        { label: '安静', type: 'radio', checked: s.activityMode === 'quiet', click: () => sendAction('set-activity-mode', 'quiet') },
        { label: '日常', type: 'radio', checked: s.activityMode === 'daily', click: () => sendAction('set-activity-mode', 'daily') },
        { label: '活跃', type: 'radio', checked: s.activityMode === 'active', click: () => sendAction('set-activity-mode', 'active') },
        { type: 'separator' },
        { label: '当前：' + ({ quiet: '安静', daily: '日常', active: '活跃' }[s.activityMode] || '日常'), enabled: false },
      ],
    },
    {
      label: '勿扰',
      submenu: [
        { label: '30 分钟', click: () => sendAction('set-dnd', 30 * 60000) },
        { label: '1 小时', click: () => sendAction('set-dnd', 60 * 60000) },
        { label: '到明天早上', click: () => sendAction('set-dnd', 'day') },
        { type: 'separator' },
        { label: '退出勿扰', enabled: !!s.dndActive, click: () => sendAction('set-dnd', 0) },
        { label: s.dndActive ? '勿扰进行中' : '未在勿扰', enabled: false },
      ],
    },
    { label: '记忆管理', click: () => sendAction('open-memory') },
    { label: '关系：' + s.relStage + (s.showIntimacy ? '（亲密 ' + s.relIntimacy + '）' : ''), enabled: false },
    { label: '显示亲密度数值', type: 'checkbox', checked: s.showIntimacy, click: () => sendAction('toggle-show-intimacy') },
    { type: 'separator' },
    { label: autostartOn() ? '取消开机自启' : '开机自启', click: () => sendAction('toggle-autostart') },
    { label: '创建桌面快捷方式', click: () => sendAction('create-desktop-shortcut') },
    { type: 'separator' },
    { label: '置顶显示', type: 'checkbox', checked: s.onTop, click: () => sendAction('toggle-ontop') },
    { label: '刷新形象', click: () => sendAction('refresh-image') },
    { label: '回到屏幕中央', click: () => sendAction('reset-position') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
});

app.whenReady().then(() => {
  createWindow();
  // 每 15 秒重新置顶一次，对抗 Windows 偶尔丢失置顶状态
  setInterval(() => { if (currentOnTop) applyAlwaysOnTop(); }, 15000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });

// ---------- 异常恢复兜底 ----------
process.on('uncaughtException', (err) => {
  try { logDebug('uncaughtException: ' + ((err && err.stack) || String(err))); } catch (e) { /* 忽略 */ }
});
process.on('unhandledRejection', (reason) => {
  try { logDebug('unhandledRejection: ' + String(reason)); } catch (e) { /* 忽略 */ }
});
