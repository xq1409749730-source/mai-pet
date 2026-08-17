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
  try {
    const history = Array.isArray(messages) ? messages.slice(-10) : [];
    const reply = await llmCall([{ role: 'system', content: PET_SYSTEM_PROMPT }, ...history], 220);
    logDebug('llm-chat OK len=' + reply.length);
    return { ok: true, reply };
  } catch (err) {
    logDebug('llm-chat ERR: ' + ((err && err.message) || String(err)));
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('llm-say', async (_e, prompt) => {
  try {
    const reply = await llmCall([
      { role: 'system', content: PET_SYSTEM_PROMPT },
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
    llmConfigured: !!(state && state.llmConfigured),
    llmModel: (state && state.llmModel) || '',
    chatOpen: !!(state && state.chatOpen),
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
        { label: s.llmConfigured ? ('AI 已连接（' + s.llmModel + '）') : 'AI 未配置', enabled: false },
      ],
    },
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
