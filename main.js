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
  win.setAlwaysOnTop(true, 'floating');
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
});

ipcMain.handle('reset-position', () => {
  if (win) {
    win.center();
    const [x, y] = win.getPosition();
    savePos(x, y);
  }
});

ipcMain.handle('set-ontop', (_e, flag) => {
  if (win) win.setAlwaysOnTop(!!flag, 'floating');
  return win ? win.isAlwaysOnTop() : false;
});

ipcMain.handle('get-ontop', () => (win ? win.isAlwaysOnTop() : true));

ipcMain.handle('quit', () => { app.quit(); });

// ---------- AI 对话（DeepSeek 大模型） ----------
const PET_SYSTEM_PROMPT = [
  '你是樱岛麻衣，一个高冷傲娇的学姐，也是后辈桌面上的可爱桌宠。',
  '规则：',
  '1. 称呼用户为「后辈」；',
  '2. 说话简短自然，一般不超过 40 个字，口语化；',
  '3. 语气高冷带点傲娇：嘴上嫌弃，心里其实关心后辈；',
  '4. 偶尔脸红、嘴硬、哼一声，但很可爱；',
  '5. 只输出说的话本身，不要加引号，不要加「她说：」之类的说明；',
  '6. 用简体中文。',
].join('\n');

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
    const reply = await llmCall([{ role: 'system', content: PET_SYSTEM_PROMPT + memoryContext() }, ...history], 220);
    logDebug('llm-chat OK len=' + reply.length);
    return { ok: true, reply };
  } catch (err) {
    logDebug('llm-chat ERR: ' + ((err && err.message) || String(err)));
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('llm-say', async (_e, prompt) => {
  if (!spendAi('say')) return { ok: false, error: '今日 AI 自动说话预算已用完（40 次）' };
  try {
    const reply = await llmCall([
      { role: 'system', content: PET_SYSTEM_PROMPT + memoryContext() },
      { role: 'user', content: String(prompt || '随便说点什么').slice(0, 300) },
    ], 120);
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
    const oldStage = stageOf(before).name;
    const result = { intimacy: before, stage: oldStage, consecutiveDays: r.consecutiveDays, changed: false, newStage: null, bonus: 0, events: [], already: false };
    if (r.lastSeenDate === today) { result.already = true; return { ok: true, ...result }; }

    const yesterday = new Date(Date.now() - 86400000);
    const yKey = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
    r.consecutiveDays = (r.lastSeenDate === yKey) ? (r.consecutiveDays || 0) + 1 : 1;

    r.intimacy += 1; result.bonus += 1; // 每日签到

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
      const m = readMemory('milestones') || { schemaVersion: 1, entries: [] };
      m.entries.push({ ts: Date.now(), title: '关系升级：' + newStage.name, note: '你和麻衣的关系更近了一步' });
      writeMemory('milestones', m);
    }
    const recent = getRecent();
    recent.entries.push({ ts: Date.now(), category: 'daily', summary: '每日首次见面：和麻衣打了招呼' + (result.bonus > 1 ? '（+' + result.bonus + ' 亲密）' : '') });
    writeMemory('recent', recent);

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

// ---------- AI 调用预算与记忆上下文 ----------
const AI_DAILY_LIMIT = { say: 40, chat: 100 };
function aiUsageFile() { return path.join(dataDir, 'memory', 'ai-usage.json'); }
function readAiUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(aiUsageFile(), 'utf8'));
    if (u && u.date === todayKey()) return u;
  } catch (e) { /* 首次使用 */ }
  return { date: todayKey(), say: 0, chat: 0 };
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
