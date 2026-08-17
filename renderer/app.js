// 樱岛麻衣 Q 版桌宠 —— 渲染进程逻辑
(function () {
  'use strict';

  const api = window.petApi;

  // ---------- 状态 ----------
  const SETTINGS_KEY = 'mai-pet-settings';
  const settings = Object.assign({
    outfit: 'bunny',        // bunny | school
    reminders: { sit: true, water: true, rest: true },
    onTop: true,
    imageSize: 'm',         // s | m | l 形象图片大小
    imageName: '',          // 选中的形象文件名；空 = 自动取文件名最前的
    aiEnabled: true,        // AI 自动说话
  }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  // ---------- 元素 ----------
  const el = {
    root: document.getElementById('pet'),
    layer: document.getElementById('character-layer'),
    svg: document.getElementById('char'),
    userImage: document.getElementById('user-image'),
    bubble: document.getElementById('bubble'),
    bubbleText: document.getElementById('bubble-text'),
    menu: document.getElementById('menu'),
    chatbar: document.getElementById('chatbar'),
    chatInput: document.getElementById('chat-input'),
  };

  // ---------- 表达式 ----------
  const EXPRESSIONS = {
    normal:    { eyes: 'eyesNormal',   brow: 'browNormal',  mouth: 'mouthNeutral', blush: false },
    happy:     { eyes: 'eyesHappy',    brow: 'browNormal',  mouth: 'mouthSmile',   blush: false },
    blush:     { eyes: 'eyesNormal',   brow: 'browNormal',  mouth: 'mouthSmile',   blush: true  },
    worried:   { eyes: 'eyesNormal',   brow: 'browWorried', mouth: 'mouthFrown',   blush: false },
    sleepy:    { eyes: 'eyesSleepy',   brow: 'browNormal',  mouth: 'mouthNeutral', blush: false },
    pout:      { eyes: 'eyesNormal',   brow: 'browAngry',   mouth: 'mouthPout',    blush: true  },
    surprised: { eyes: 'eyesNormal',   brow: 'browNormal',  mouth: 'mouthOpen',    blush: false },
  };

  let currentExpr = 'normal';
  let blinkTimer = null;

  const eyesGroups = {};
  const browGroups = {};
  const mouthGroups = {};
  const blushGroup = document.getElementById('blush');

  ['eyesNormal', 'eyesHappy', 'eyesSleepy', 'eyesAway', 'eyesBlink'].forEach(id => {
    eyesGroups[id] = document.getElementById(id);
  });
  ['browNormal', 'browWorried', 'browAngry'].forEach(id => {
    browGroups[id] = document.getElementById(id);
  });
  ['mouthNeutral', 'mouthSmile', 'mouthOpen', 'mouthPout', 'mouthFrown'].forEach(id => {
    mouthGroups[id] = document.getElementById(id);
  });

  function setExpression(name) {
    const ex = EXPRESSIONS[name] || EXPRESSIONS.normal;
    currentExpr = name;
    Object.values(eyesGroups).forEach(g => { if (g) g.classList.add('hidden'); });
    Object.values(browGroups).forEach(g => { if (g) g.classList.add('hidden'); });
    Object.values(mouthGroups).forEach(g => { if (g) g.classList.add('hidden'); });
    if (eyesGroups[ex.eyes]) eyesGroups[ex.eyes].classList.remove('hidden');
    if (browGroups[ex.brow]) browGroups[ex.brow].classList.remove('hidden');
    if (mouthGroups[ex.mouth]) mouthGroups[ex.mouth].classList.remove('hidden');
    if (blushGroup) blushGroup.classList.toggle('hidden', !ex.blush);
  }

  function blinkOnce() {
    Object.values(eyesGroups).forEach(g => { if (g) g.classList.add('hidden'); });
    if (eyesGroups.eyesBlink) eyesGroups.eyesBlink.classList.remove('hidden');
    setTimeout(() => setExpression(currentExpr), 130);
  }

  function scheduleBlink() {
    if (blinkTimer) clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      blinkOnce();
      scheduleBlink();
    }, 2200 + Math.random() * 3000);
  }

  // ---------- 服装 ----------
  const outfitBunny = document.getElementById('outfitBunny');
  const outfitSchool = document.getElementById('outfitSchool');
  const bunnyEars = document.getElementById('bunnyEars');

  function applyOutfit(name) {
    settings.outfit = name;
    saveSettings();
    if (outfitBunny) outfitBunny.classList.toggle('hidden', name !== 'bunny');
    if (outfitSchool) outfitSchool.classList.toggle('hidden', name !== 'school');
    // 兔耳是她的标志性发饰，两种服装都保留
  }

  // ---------- 气泡 ----------
  let bubbleTimer = null;
  function say(text, duration) {
    el.bubbleText.textContent = text;
    el.bubble.classList.add('visible');
    applyCharState('speak'); // 说话时切换到「递便签」
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      el.bubble.classList.remove('visible');
      if (sleepyMode) applyCharState('sleepy');
      else applyBaseImage();
    }, duration || 5200);
  }

  // ---------- 用户自带的形象图片（放在「形象」文件夹） ----------
  let imgRetry = 0;
  let imageListCache = [];
  let llmConfigured = false;
  let llmModel = '';
  let aiPending = false;
  let lastAiSay = 0;
  const chatHistory = [];
  async function applyUserImage() {
    try {
      const list = await api.getCharacterImages();
      imageListCache = list || [];
      if (imageListCache.length === 0) {
        el.userImage.style.display = 'none';
        el.svg.style.display = 'block';
        return;
      }
      buildStateImages();
      // 基础形象：用户选的 → 「抱着书」→ 第一张
      baseImageUrl = imageListCache.find(f => f.name === settings.imageName)?.url
        || stateImageUrls.book
        || imageListCache[0].url;
      currentCharState = 'base';
      setCharImage(baseImageUrl, true);
      applyImageSize();
    } catch (e) { /* 保留默认 SVG 形象 */ }
  }

  function applyImageSize() {
    el.userImage.classList.toggle('size-s', settings.imageSize === 's');
    el.userImage.classList.toggle('size-l', settings.imageSize === 'l');
    // 尺寸是瞬时的（无过渡），稍后重新贴合窗口
    setTimeout(fitWindowToImage, 120);
    setTimeout(fitWindowToImage, 600);
  }

  // 让窗口贴合图片大小（右侧放人物，左侧留出气泡区）
  function fitWindowToImage() {
    if (el.userImage.style.display !== 'block') return;
    const r = el.userImage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      api.resizeTo(Math.ceil(r.width) + 170, Math.ceil(r.height) + 30);
    }
  }

  // ---------- 互动图片自动切换（「形象」文件夹多张图按状态切换） ----------
  const STATE_KEYWORDS = [
    ['speak', '递便签'], ['think', '思考'], ['click', '害羞'], ['drag', '盯着'],
    ['sleepy', '困倦'], ['wave', '挥手'], ['cup', '捧杯子'], ['happy', '庆祝'], ['book', '抱着书'],
  ];
  const stateImageUrls = {};
  let baseImageUrl = null;
  let currentCharState = 'base';
  let sleepyMode = false;
  let flashTimer = null;

  function buildStateImages() {
    Object.keys(stateImageUrls).forEach(k => delete stateImageUrls[k]);
    if (!imageListCache.length) return;
    imageListCache.forEach(f => {
      for (const [state, kw] of STATE_KEYWORDS) {
        if (stateImageUrls[state] === undefined && f.name.includes(kw)) stateImageUrls[state] = f.url;
      }
    });
  }

  function setCharImage(url, withRetry) {
    if (!url) return;
    el.userImage.onload = () => { imgRetry = 0; fitWindowToImage(); };
    if (withRetry) {
      el.userImage.onerror = () => {
        if (imgRetry < 6) {
          imgRetry++;
          setTimeout(() => {
            const bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'r=' + Date.now();
            el.userImage.src = bust;
          }, 500 * imgRetry);
        }
      };
    }
    el.userImage.src = url;
    el.userImage.style.display = 'block';
    el.svg.style.display = 'none';
  }

  // 用户操作唤醒（从困倦回到基础形象）
  function wake() {
    if (sleepyMode) {
      sleepyMode = false;
      applyBaseImage();
    }
  }

  function applyCharState(state) {
    if (state === currentCharState) return;
    const url = stateImageUrls[state];
    if (url === undefined) return;
    currentCharState = state;
    setCharImage(url);
  }

  function applyBaseImage() {
    if (baseImageUrl) {
      currentCharState = 'base';
      setCharImage(baseImageUrl);
    }
  }

  // 临时切换到某个状态图，ms 后回到基础形象（若期间被其他状态接管则不打断）
  function flashState(state, ms) {
    applyCharState(state);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (currentCharState === state) {
        if (sleepyMode) applyCharState('sleepy');
        else applyBaseImage();
      }
    }, ms || 2600);
  }

  // ---------- 随机台词 ----------
  function randomOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function speakRandom(category, expr) {
    const arr = PHRASES[category];
    if (!arr || !arr.length) return;
    if (expr) setExpression(expr);
    say(randomOf(arr));
  }

  // 防重复：同一类台词的最小间隔
  const lastSpoke = {};
  function speakThrottled(category, expr, minIntervalMs) {
    const now = Date.now();
    if (lastSpoke[category] && now - lastSpoke[category] < (minIntervalMs || 60000)) return;
    lastSpoke[category] = now;
    speakRandom(category, expr);
  }

  // ---------- AI 生成的话（失败/限流时回退到台词库） ----------
  function showThinking() {
    el.bubbleText.textContent = '……';
    el.bubble.classList.add('visible');
    applyCharState('think'); // 思考中切换到「思考」
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      el.bubble.classList.remove('visible');
      if (sleepyMode) applyCharState('sleepy');
      else applyBaseImage();
    }, 15000);
  }

  async function aiSay(contextPrompt, fallbackCategory, expr, imageState) {
    if (aiPending) return;
    if (!settings.aiEnabled || !llmConfigured) { speakRandom(fallbackCategory, expr); if (imageState) flashState(imageState, 6000); return; }
    const now = Date.now();
    if (now - lastAiSay < 45000) { speakRandom(fallbackCategory, expr); if (imageState) flashState(imageState, 6000); return; }
    lastAiSay = now;
    aiPending = true;
    showThinking();
    try {
      const res = await api.llmSay(contextPrompt);
      if (res && res.ok && res.reply) {
        if (expr) setExpression(expr);
        say(res.reply);
        if (imageState) flashState(imageState, 6000); // 特殊状态图（如喝水→捧杯子）
      } else {
        speakRandom(fallbackCategory, expr);
        if (imageState) flashState(imageState, 6000);
      }
    } catch (e) {
      speakRandom(fallbackCategory, expr);
      if (imageState) flashState(imageState, 6000);
    } finally {
      aiPending = false;
    }
  }

  // ---------- 打字聊天 ----------
  function openChat() {
    el.chatbar.classList.remove('hidden');
    el.chatInput.focus();
  }
  function closeChat() {
    el.chatbar.classList.add('hidden');
  }
  async function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = '';
    chatHistory.push({ role: 'user', content: text });
    showThinking();
    const res = await api.llmChat(chatHistory);
    if (res && res.ok && res.reply) {
      chatHistory.push({ role: 'assistant', content: res.reply });
      say(res.reply);
    } else {
      chatHistory.pop();
      say((res && res.error) ? '（AI 出错：' + res.error + '）' : '（AI 没理我…）');
    }
  }
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    else if (e.key === 'Escape') { closeChat(); }
  });

  // ---------- 点击 / 拖拽 ----------
  let dragging = false;
  let moved = 0;
  let dragStart = null;

  function onPointerDown(e) {
    wake(); // 用户操作把她唤醒（退出困倦状态）
    dragging = true;
    moved = 0;
    dragStart = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY };
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.screenX - dragStart.sx;
    const dy = e.screenY - dragStart.sy;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    if (moved > 6) {
      el.root.classList.add('dragged');
      setExpression('surprised');
      applyCharState('drag'); // 被拎起来 →「盯着」
      api.moveTo(dragStart.wx + dx, dragStart.wy + dy);
    }
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    el.root.classList.remove('dragged');
    if (moved > 6) {
      speakRandom('drop', 'pout');
      applyBaseImage(); // 放下后回到基础形象
    } else {
      clickReact();
    }
  }

  function clickReact() {
    const r = Math.random();
    let expr;
    if (r < 0.45) { expr = 'happy'; flashState('happy', 2600); }   // 开心→庆祝
    else { expr = r < 0.7 ? 'blush' : (r < 0.9 ? 'pout' : 'normal'); flashState('click', 2600); } // 害羞
    setExpression(expr);
    aiSay('后辈用手指戳了你一下，请用傲娇又可爱的语气回应他。', 'click');
    // 随机动作：轻轻跳一下
    el.root.classList.remove('hop');
    void el.root.offsetWidth;
    el.root.classList.add('hop');
  }

  // 点击/拖拽/右键只响应在人物本体上（气泡区空白处不响应、不占位置）
  async function onContextMenu(e) {
    e.preventDefault();
    try {
      // 每次打开菜单都实时刷新 AI 配置状态
      const c = await api.getLlmConfig();
      llmConfigured = !!(c && c.configured);
      llmModel = (c && c.model) || '';
    } catch (err) { /* 保持原状态 */ }
    api.showContextMenu({
      reminders: settings.reminders,
      imageSize: settings.imageSize,
      imageName: settings.imageName,
      onTop: settings.onTop,
      aiEnabled: settings.aiEnabled,
      llmConfigured: llmConfigured,
      llmModel: llmModel,
      chatOpen: !el.chatbar.classList.contains('hidden'),
      images: imageListCache,
    });
  }

  // 同一时刻只有可见的那个（svg 或用户图片）能收到事件
  el.svg.addEventListener('pointerdown', onPointerDown);
  el.userImage.addEventListener('pointerdown', onPointerDown);
  el.svg.addEventListener('contextmenu', onContextMenu);
  el.userImage.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  api.onMenuAction(({ action, payload }) => {
    switch (action) {
      case 'toggle-reminder':
        settings.reminders[payload] = !settings.reminders[payload];
        saveSettings();
        break;
      case 'set-image-size':
        settings.imageSize = payload;
        saveSettings();
        applyImageSize();
        break;
      case 'set-image-name':
        settings.imageName = payload;
        saveSettings();
        applyUserImage();
        break;
      case 'toggle-ontop':
        settings.onTop = !settings.onTop;
        saveSettings();
        api.setOnTop(settings.onTop);
        break;
      case 'refresh-image':
        applyUserImage();
        break;
      case 'reset-position':
        api.resetPosition();
        break;
      case 'toggle-chat':
        if (el.chatbar.classList.contains('hidden')) {
          openChat();
          say('说吧，后辈。');
        } else {
          closeChat();
        }
        break;
      case 'toggle-ai-enabled':
        settings.aiEnabled = !settings.aiEnabled;
        saveSettings();
        say(settings.aiEnabled ? '（AI 自动说话已开启）' : '（AI 自动说话已关闭）');
        break;
      case 'toggle-autostart':
        api.toggleAutoStart().then(res => {
          say(res && res.ok ? (res.enabled ? '已设置开机自启。' : '已取消开机自启。') : ('（开机自启失败：' + ((res && res.error) || '未知错误') + '）'));
        });
        break;
      case 'create-desktop-shortcut':
        api.createDesktopShortcut().then(res => {
          say(res && res.ok ? '已在桌面创建快捷方式。' : ('（创建失败：' + ((res && res.error) || '未知错误') + '）'));
        });
        break;
    }
  });

  // ---------- 时间问候 ----------
  function hourOf() { return new Date().getHours(); }
  function timeGreeting() {
    const h = hourOf();
    flashState('wave', 4000); // 问候时→挥手
    if (h >= 5 && h < 11) speakRandom('morning', 'happy');
    else if (h >= 11 && h < 14) speakRandom('noon', 'normal');
    else if (h >= 14 && h < 18) speakRandom('evening', 'normal');
    else speakRandom('night', 'sleepy');
  }

  let lastHour = -1;
  function timeLoop() {
    const h = hourOf();
    if (lastHour >= 0 && h !== lastHour) {
      speakThrottled('hourly', 'normal', 3600000);
    }
    lastHour = h;
  }

  // ---------- 系统状态监测 ----------
  let cpuHighNotified = false;
  let memHighNotified = false;
  async function sysLoop() {
    try {
      const s = await api.sysStats();
      if (s.cpu >= 80 && !cpuHighNotified) { cpuHighNotified = true; aiSay('检测到电脑 CPU 占用高达 ' + s.cpu + '%，你担心地对后辈说点什么。', 'cpuHigh', 'worried'); }
      else if (s.cpu < 50) cpuHighNotified = false;
      if (s.mem >= 85 && !memHighNotified) { memHighNotified = true; aiSay('检测到电脑内存占用高达 ' + s.mem + '%，你提醒一下后辈。', 'memHigh', 'worried'); }
      else if (s.mem < 60) memHighNotified = false;
    } catch (e) { /* ignore */ }
  }

  // ---------- 前台任务识别 ----------
  const CATEGORIES = [
    { cat: 'coding',  match: ['code', 'visual studio', 'vscode', 'idea', 'pycharm', 'webstorm', 'sublime', 'notepad++', 'cursor', 'vim', 'xcode', 'android studio', 'cmd', 'powershell', 'terminal', 'git'], },
    { cat: 'game',    match: ['steam', 'game', 'league', '原神', '崩坏', 'valorant', 'minecraft', 'wegame', 'epic', 'unity', 'roblox'] },
    { cat: 'video',   match: ['bilibili', 'youtube', 'netflix', '腾讯视频', '爱奇艺', '优酷', 'potplayer', 'vlc', 'douyin', '抖音', 'twitch', '斗鱼'] },
    { cat: 'music',   match: ['spotify', '网易云', 'qq音乐', '酷狗', 'foobar', 'itunes', 'music'] },
    { cat: 'chat',    match: ['wechat', '微信', 'qq', '钉钉', 'dingtalk', 'discord', 'telegram', 'slack', '飞书', 'teams'] },
    { cat: 'office',  match: ['word', 'excel', 'powerpoint', 'wps', 'ppt', 'outlook', 'pdf', 'onenote'] },
    { cat: 'browser', match: ['chrome', 'firefox', 'edge', 'msedge', '浏览器'] },
  ];

  function categorize(fg) {
    if (!fg) return null;
    const s = (fg.process + ' ' + fg.title).toLowerCase();
    for (const c of CATEGORIES) {
      if (c.match.some(m => s.includes(m.toLowerCase()))) return c.cat;
    }
    return null;
  }

  let lastCat = null;
  async function fgLoop() {
    try {
      const fg = await api.foregroundApp();
      if (!fg) return;

      // 空闲检测
      if (fg.idleSeconds >= 300) { // 5 分钟无操作
        sleepyMode = true;
        applyCharState('sleepy'); // 困倦→困倦图
        aiSay('后辈已经很久没动电脑了，你困倦地打了个哈欠，对他说点什么。', 'idle', 'sleepy');
        return;
      }

      const cat = categorize(fg);
      if (cat && cat !== lastCat) {
        lastCat = cat;
        const expr = (cat === 'video' || cat === 'music') ? 'normal' : (cat === 'game' ? 'happy' : 'normal');
        const catText = { coding: '写代码', game: '打游戏', video: '看视频', music: '听歌', chat: '聊天', office: '办公', browser: '刷网页' }[cat] || cat;
        aiSay('后辈正在' + catText + '，你随口对他说一句相关的话。', cat, expr);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- 健康提醒 ----------
  let sitSince = Date.now();
  let waterSince = Date.now();
  let restSince = Date.now();
  function healthLoop() {
    const now = Date.now();
    if (settings.reminders.sit && now - sitSince > 45 * 60000) { sitSince = now; aiSay('后辈已经久坐 45 分钟了，你提醒他起来活动一下。', 'healthSit', 'worried'); }
    if (settings.reminders.water && now - waterSince > 60 * 60000) { waterSince = now; aiSay('该喝水了，你提醒后辈去喝口水。', 'healthWater', 'normal', 'cup'); } // 捧杯子
    if (settings.reminders.rest && now - restSince > 90 * 60000) { restSince = now; aiSay('后辈该休息一下了，你关心地提醒他。', 'healthRest', 'sleepy'); }
  }

  // ---------- 启动 ----------
  function init() {
    applyOutfit(settings.outfit);
    setExpression('pout');
    scheduleBlink();
    applyUserImage();
    api.onCharacterUpdated(() => applyUserImage());
    api.getLlmConfig().then(c => {
      llmConfigured = !!(c && c.configured);
      llmModel = (c && c.model) || '';
    }).catch(() => {});
    timeGreeting();
    setTimeout(() => timeLoop(), 30000);
    setInterval(timeLoop, 60000);
    setInterval(sysLoop, 10000);
    setInterval(fgLoop, 20000);
    setInterval(healthLoop, 30000);
    api.setOnTop(settings.onTop);
    sysLoop();
  }

  init();
})();
