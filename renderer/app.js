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
    activityMode: 'daily',  // quiet | daily | active 三档主动模式
    dndUntil: 0,            // 勿扰截止时间戳(ms)；0 = 未开启
    dndReason: '',          // 勿扰原因（展示用）
    showIntimacy: true,     // 是否显示亲密度数值（false 只显示关系阶段）
    aiManualOnly: false,    // 仅手动聊天时使用 AI（关闭自动 AI 说话）
  }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

  // 恢复健康提醒（此前误将其默认关闭）；顺带重置旧的关闭标记
  if (localStorage.getItem('mai-pet-reminders-v2')) {
    settings.reminders = { sit: true, water: true, rest: true };
    localStorage.removeItem('mai-pet-reminders-v2');
    saveSettings();
  }

  // ---------- 情绪状态机（程序算情绪，AI 只负责组织台词） ----------
  const EMOTION_STATES = {
    calm:   { name: '平静', image: 'book' },
    happy:  { name: '开心', image: 'happy' },
    shy:    { name: '害羞', image: 'click' },
    worried:{ name: '担心', image: 'think' },
    upset:  { name: '不满', image: 'angry' },
    tired:  { name: '疲倦', image: 'sleepy' },
  };
  let emotion = { state: 'calm', setAt: 0 };
  let emotionTimer = null;
  function setEmotion(state, durationMs) {
    if (!EMOTION_STATES[state]) return emotion;
    emotion = { state, setAt: Date.now() };
    if (emotionTimer) clearTimeout(emotionTimer);
    if (durationMs) {
      emotionTimer = setTimeout(() => { if (emotion.state === state) setEmotion('calm', 0); }, durationMs);
    }
    return emotion;
  }
  function emotionName() { return EMOTION_STATES[emotion.state].name; }
  function emotionImage() { return EMOTION_STATES[emotion.state].image; }

  // 把当前时间/模式注入 AI 上下文（情绪与关系已由主进程注入系统提示词）
  function aiContext() {
    return '（当前时间 ' + new Date().getHours() + ':' + String(new Date().getMinutes()).padStart(2, '0') +
      '，主动模式：' + ({ quiet: '安静', daily: '日常', active: '活跃' }[settings.activityMode] || '日常') + '）';
  }

  // ---------- 持久情感引擎（主进程 emotion.json；情绪对应形象与动作） ----------
  // 情绪 → 状态图（状态名与 state-config 一致：default/happy/shy/remind/angry/sleepy/wave）
  const MOOD_IMAGE = { calm: 'default', happy: 'happy', shy: 'shy', concerned: 'remind', upset: 'angry', lonely: 'default', tired: 'sleepy', expectant: 'wave', relieved: 'default' };
  const MOOD_NAME = { calm: '平静', happy: '开心', shy: '害羞', concerned: '担心', upset: '小生气', lonely: '失落', tired: '困倦', expectant: '期待', relieved: '安心' };
  let persistentEmotion = { mood: 'calm', happiness: 55, energy: 60, trust: 40, reason: '' };
  async function refreshEmotion() {
    try {
      const r = await api.getEmotion();
      if (r && r.ok) persistentEmotion = { mood: r.mood, happiness: r.happiness, energy: r.energy, trust: r.trust, reason: r.reason };
    } catch (e) { /* 忽略 */ }
  }
  // 用户事件 → 本地规则改变情绪 → 记录原因 → 切换对应形象
  async function applyEmotionEvent(type, detail) {
    try {
      const r = await api.emotionEvent(type, detail);
      if (r && r.ok) {
        const prev = persistentEmotion.mood;
        persistentEmotion = { mood: r.mood, happiness: r.happiness, energy: r.energy, trust: r.trust, reason: r.reason };
        if (r.mood !== 'calm' && r.mood !== prev) {
          const img = MOOD_IMAGE[r.mood];
          if (img && img !== 'default') flashState(img, 6000); // 情绪对应形象（担心→提醒 等）
        }
      }
      return r;
    } catch (e) { return null; }
  }

  // ---------- 三档主动模式 + 勿扰 ----------
  function dndActive() {
    return settings.dndUntil > 0 && Date.now() < settings.dndUntil;
  }
  function activity() {
    const m = settings.activityMode;
    if (m === 'quiet') return { aiCooldown: 0, idleMin: 0, idleMax: 0, speakChance: 0, proactive: false };
    if (m === 'active') return { aiCooldown: 15000, idleMin: 20000, idleMax: 35000, speakChance: 0.4, proactive: true };
    return { aiCooldown: 45000, idleMin: 40000, idleMax: 80000, speakChance: 0.2, proactive: false }; // daily
  }

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
  let aiPending = false;   // 提前声明（say/aiSay 均引用）
  let dragging = false;    // 提前声明（say 里判断拖拽中不切说话状态）
  function say(text, duration) {
    el.bubbleText.textContent = text;
    el.bubble.classList.add('visible');
    setWindowExpanded(true); // 气泡出现 → 窗口展开
    // 说话：进入「递便签」状态（事件状态，跟随气泡）；若当前有更高优先级状态（拖拽/思考）则不打断
    if (!dragging && !aiPending) {
      const cur = stateStack.find(s => s.id === 'dragging' || s.id === 'thinking');
      if (!cur) enterState('speaking', { type: 'event' });
    }
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      el.bubble.classList.remove('visible');
      setWindowExpanded(false); // 气泡消失 → 窗口收缩回人物
      endState('speaking'); // 气泡消失 → 结束说话状态，自然恢复前一状态/基础状态
    }, duration || 5200);
  }

  // ---------- 用户自带的形象图片（放在「形象」文件夹） ----------
  let imgRetry = 0;
  let imageListCache = [];
  let llmConfigured = false;
  let llmModel = '';
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
      // 基础形象：用户选的 → 「抱着书(default)」→ 第一张
      baseImageUrl = imageListCache.find(f => f.name === settings.imageName)?.url
        || stateImageUrls.default
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

  // 窗口贴合图片：无气泡时紧凑（只包住人物），有气泡时展开（左侧留气泡区）
  let lastImgW = 0, lastImgH = 0;
  let windowExpanded = false; // 气泡/聊天框是否可见 → 窗口展开
  function fitWindowToImage() {
    if (el.userImage.style.display !== 'block') return;
    const r = el.userImage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      lastImgW = Math.ceil(r.width);
      lastImgH = Math.ceil(r.height);
      applyWindowFit();
    }
  }
  // 无气泡：图片 + 少量呼吸/阴影边距（约 16px 右、8px 下，参考 #character-layer padding）
  function compactWindowSize() {
    return { w: Math.max(110, lastImgW + 20), h: Math.max(150, lastImgH + 12) };
  }
  // 有气泡：人物 + 左侧气泡区（气泡 max-width 140 + 箭头 + 边距 ≈ 170 宽；上方高度 30）
  function expandedWindowSize() {
    return { w: Math.max(110, lastImgW + 170), h: Math.max(150, lastImgH + 30) };
  }
  let windowFitTimer = null;
  function applyWindowFit() {
    if (!lastImgW || !lastImgH) return;
    const s = windowExpanded ? expandedWindowSize() : compactWindowSize();
    if (windowFitTimer) clearTimeout(windowFitTimer);
    windowFitTimer = setTimeout(() => api.resizeTo(s.w, s.h), 40); // 等气泡淡入/淡出后再贴合
  }
  // 综合判断是否需要展开窗口（气泡或聊天框可见）
  function updateWindowExpanded() {
    const bubbleVisible = el.bubble.classList.contains('visible');
    const chatVisible = !el.chatbar.classList.contains('hidden');
    const flag = bubbleVisible || chatVisible;
    if (windowExpanded === flag) return;
    windowExpanded = flag;
    applyWindowFit();
  }
  // 气泡/聊天框显示 → 展开窗口；消失 → 收缩回人物
  function setWindowExpanded(flag) {
    // 只标记气泡状态，实际展开与否由 updateWindowExpanded 综合判断（聊天框仍开时不收缩）
    void flag;
    updateWindowExpanded();
  }

  // ---------- 状态机配置（主进程 state-config.json；概率/时长/优先级/冷却可手改+菜单重载） ----------
  let stateConfig = null; // 未加载时用内置默认（下方 DEFAULT_CONFIG）
  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    states: {
      default:   { keyword: '抱着书',    duration: 0,     priority: 10 },
      speaking:  { keyword: '递便签',    duration: 10000, priority: 20 },
      sleepy:    { keyword: '困倦',      duration: 0,     priority: 30 },
      wave:      { keyword: '挥手',      duration: [2000, 3000], cooldown: 30, priority: 35 },
      shy:       { keyword: '害羞',      duration: [2500, 4000], cooldown: 30, priority: 40 },
      laugh:     { keyword: '偷笑',      duration: [2000, 3000], cooldown: 20, priority: 45 },
      cup:       { keyword: '捧杯子',    duration: [4000, 6000], priority: 55 },
      remind:    { keyword: '提醒',      duration: 4000,  priority: 60 },
      happy:     { keyword: '庆祝',      duration: [3000, 5000], cooldown: 20, priority: 70 },
      angry:     { keyword: '有点生气',  duration: [4000, 7000], cooldown: 60, priority: 75 },
      thinking:  { keyword: '思考',      minDuration: 1200, priority: 90 },
      dragging:  { keyword: '盯着',      duration: 0,     priority: 100 },
    },
    click: { shy: 30, happy: 20, laugh: 20, speak: 15, angry: 5, calm: 10 },
    hover: { shy: 40, laugh: 35, wave: 25, holdMs: 1200, cooldownSec: 60 },
    drag:  { dropAngryChance: 0.35, angryAfterDrags: 3 },
    sleep: {
      nap:       { enabled: true, start: '12:30', end: '14:00' },
      lateNight: { enabled: true, start: '23:30', end: '06:30' },
      idle:      { enabled: true, idleSeconds: 300 },
    },
    pose: { maxRepeat: 2, preferGap: 2, wavePerHour: 1, happyClickRate: 20 },
  };
  function cfg() { return stateConfig || DEFAULT_CONFIG; }
  async function loadStateConfig() {
    try {
      const r = await api.getStateConfig();
      if (r && r.ok && r.config) {
        stateConfig = Object.assign({}, DEFAULT_CONFIG, r.config);
        stateConfig.states = Object.assign({}, DEFAULT_CONFIG.states, (r.config.states || {}));
        stateConfig.click = Object.assign({}, DEFAULT_CONFIG.click, (r.config.click || {}));
        stateConfig.hover = Object.assign({}, DEFAULT_CONFIG.hover, (r.config.hover || {}));
        stateConfig.drag = Object.assign({}, DEFAULT_CONFIG.drag, (r.config.drag || {}));
        stateConfig.sleep = Object.assign({}, DEFAULT_CONFIG.sleep, (r.config.sleep || {}));
        stateConfig.pose = Object.assign({}, DEFAULT_CONFIG.pose, (r.config.pose || {}));
        buildStateImages(); // 关键词可能变了 → 重建映射
      }
    } catch (e) { /* 用默认 */ }
  }
  api.onStateConfigReloaded((c) => {
    if (c) { stateConfig = Object.assign({}, DEFAULT_CONFIG, c); buildStateImages(); }
  });

  // ---------- 互动图片自动切换（「形象」文件夹多张图按状态切换） ----------
  // 状态关键词来自配置（states.*.keyword），可改文件名匹配规则
  const stateImageUrls = {};
  let baseImageUrl = null;
  let currentCharState = 'base';
  let flashTimer = null;
  let idleActionTimer = null;

  function buildStateImages() {
    Object.keys(stateImageUrls).forEach(k => delete stateImageUrls[k]);
    if (!imageListCache.length) return;
    const st = cfg().states;
    imageListCache.forEach(f => {
      for (const state of Object.keys(st)) {
        const kw = st[state] && st[state].keyword;
        if (kw && stateImageUrls[state] === undefined && f.name.includes(kw)) stateImageUrls[state] = f.url;
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

  // ---------- 状态栈（事件 vs 情绪分离 + 优先级仲裁 + 结束恢复前一状态） ----------
  // 事件状态：dragging/thinking/speaking/remind/cup（高优先级、临时）
  // 情绪状态：shy/laugh/wave/happy/angry（中优先级，来自点击/悬停/情绪事件）
  // 基础状态：困倦(时段/空闲) → 情绪对应图 → 默认
  let stateStack = []; // [{ id, type:'event'|'mood', endAt, ts }]
  const stateTimers = {}; // id → timeout

  function stateDuration(id, overrideMs) {
    if (overrideMs != null && overrideMs > 0) return overrideMs;
    const st = cfg().states[id];
    if (!st) return 2600;
    if (st.minDuration) return st.minDuration; // 思考：至少1.2s，直到AI返回
    if (Array.isArray(st.duration) && st.duration.length === 2) {
      return st.duration[0] + Math.random() * (st.duration[1] - st.duration[0]);
    }
    return st.duration || 2600;
  }
  function statePriority(id) {
    const st = cfg().states[id];
    return st ? st.priority : 50;
  }
  function isEventState(id) {
    return ['dragging', 'thinking', 'speaking', 'remind', 'cup'].includes(id);
  }
  function stateInCooldown(id) {
    const st = cfg().states[id];
    if (!st || !st.cooldown) return false;
    const last = lastStateAt[id];
    return !!last && (Date.now() - last) < st.cooldown * 1000;
  }

  const lastStateAt = {}; // id → ts（冷却用）
  const recentPoses = []; // 最近出现过的非默认状态（重复姿势冷却）
  let lastWaveHour = -1;

  // 进入状态：推入栈 → 渲染最高优先级 → 设定时器
  function enterState(id, opts) {
    opts = opts || {};
    const st = cfg().states[id];
    if (!st) return;
    // 重复姿势冷却：同一非默认状态连续出现超过 maxRepeat 次 → 忽略（高优先级事件除外）
    if (opts.type === 'mood' && !opts.force) {
      const max = cfg().pose.maxRepeat;
      const cont = recentPoses.filter(p => p === id).length;
      if (cont >= max && !isEventState(id)) return;
    }
    // 冷却检查（强制事件除外；连点生气走 force）
    if (!opts.force && opts.type === 'mood' && stateInCooldown(id)) return;
    const now = Date.now();
    // 同 id 已在栈 → 续期并置顶
    const exist = stateStack.find(s => s.id === id);
    if (exist) {
      exist.endAt = stateDuration(id, opts.duration) > 0 ? now + stateDuration(id, opts.duration) : 0;
      exist.ts = now;
    } else {
      stateStack.push({ id, type: opts.type || 'mood', endAt: stateDuration(id, opts.duration) > 0 ? now + stateDuration(id, opts.duration) : 0, ts: now });
    }
    lastStateAt[id] = now;
    recentPoses.push(id);
    if (recentPoses.length > 12) recentPoses.shift();
    renderBestState();
    // 定时结束（duration 有限时）
    if (stateTimers[id]) clearTimeout(stateTimers[id]);
    const dur = stateDuration(id, opts.duration);
    if (dur > 0) {
      stateTimers[id] = setTimeout(() => { endState(id); }, dur);
    }
  }

  // 结束状态：从栈移除 → 重新渲染（自然恢复栈中前一个仍有效的状态）
  function endState(id) {
    const i = stateStack.findIndex(s => s.id === id);
    if (i >= 0) stateStack.splice(i, 1);
    if (stateTimers[id]) { clearTimeout(stateTimers[id]); delete stateTimers[id]; }
    renderBestState();
  }

  // 基础状态：困倦 → 情绪对应图 → 默认（抱住书）
  function baseStateId() {
    if (sleepSource) return 'sleepy';
    const m = MOOD_IMAGE[persistentEmotion.mood];
    if (m && m !== 'book') return m; // 情绪对应形象（开心→庆祝 等）
    return 'default';
  }

  // 渲染栈中优先级最高且未过期的状态；无 → 基础状态
  function renderBestState() {
    const now = Date.now();
    stateStack = stateStack.filter(s => s.endAt === 0 || s.endAt > now);
    const sorted = [...stateStack].sort((a, b) => statePriority(b.id) - statePriority(a.id) || b.ts - a.ts);
    const best = sorted[0];
    if (best) applyCharState(best.id);
    else applyCharState(baseStateId());
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

  // 旧状态名 → 新状态名（兼容历史代码传参）
  const LEGACY_STATE_MAP = { click: 'shy', drag: 'dragging', think: 'thinking', speak: 'speaking', book: 'default', worried: 'remind', sleep: 'sleepy' };
  // 临时闪一个状态（兼容旧调用；type 自动按状态名判定）
  function flashState(state, ms) {
    state = LEGACY_STATE_MAP[state] || state;
    const type = isEventState(state) ? 'event' : 'mood';
    enterState(state, { duration: ms, type });
  }

  // ---------- 困倦（三源：午觉/深夜/空闲；可独立开关+改时间） ----------
  let sleepSource = null; // 'nap' | 'late' | 'idle' | null
  function timeToMin(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }
  function inTimeRange(min, start, end) {
    const s = timeToMin(start), e = timeToMin(end);
    if (s === null || e === null) return false;
    if (s <= e) return min >= s && min < e;   // 不跨天
    return min >= s || min < e;               // 跨天（如 23:30~06:30）
  }
  function evalSleepSource() {
    const sl = cfg().sleep;
    const d = new Date();
    const min = d.getHours() * 60 + d.getMinutes();
    if (sl.nap.enabled && inTimeRange(min, sl.nap.start, sl.nap.end)) return 'nap';
    if (sl.lateNight.enabled && inTimeRange(min, sl.lateNight.start, sl.lateNight.end)) return 'late';
    if (sl.idle.enabled && lastIdleSeconds >= sl.idle.idleSeconds) return 'idle';
    return null;
  }
  // 时段变化检查（每分钟）
  function checkSleepSchedule() {
    const next = evalSleepSource();
    if (next !== sleepSource) {
      sleepSource = next;
      renderBestState(); // 进入/离开困倦 → 刷新基础状态
    }
  }

  // 用户操作唤醒：只解除「空闲困倦」，午觉/深夜时段困倦保持
  function wake() {
    if (sleepSource === 'idle') {
      sleepSource = null;
      applyBaseImage();
    }
  }

  // 定期随机小动作：让形象经常切换（间隔按三档模式；安静/勿扰时不做）
  // 随机小动作池（情绪型小动作；重复姿势冷却：最近出现的 2 个优先避开）
  const IDLE_ACTION_POOL = ['wave', 'laugh', 'happy', 'shy', 'remind', 'cup', 'angry'];
  function pickIdleAction() {
    const gap = cfg().pose.preferGap;
    const recent = recentPoses.slice(-gap); // 最近 gap 个出现过的
    let pool = IDLE_ACTION_POOL.filter(p => !recent.includes(p) && !stateInCooldown(p));
    if (!pool.length) pool = IDLE_ACTION_POOL.filter(p => !stateInCooldown(p));
    if (!pool.length) pool = IDLE_ACTION_POOL;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function scheduleIdleAction() {
    if (idleActionTimer) clearTimeout(idleActionTimer);
    const act = activity();
    if (act.idleMax === 0) { // 安静：不随机动作，只保留循环
      idleActionTimer = setTimeout(scheduleIdleAction, 60000);
      return;
    }
    const gap = act.idleMin + Math.random() * (act.idleMax - act.idleMin);
    idleActionTimer = setTimeout(() => {
      if (!dragging && !aiPending && !sleepSource && !dndActive() && stateStack.length === 0 && currentCharState === baseStateId()) {
        const pick = pickIdleAction();
        if (pick !== 'default') flashState(pick, 3200);
      }
      scheduleIdleAction();
    }, gap);
  }

  // ---------- 随机台词（本地库 + 去重历史：主进程 pickLocal 过滤相似/角度） ----------
  function randomOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function speakRandom(category, expr) {
    const scene = String(category || 'other');
    const sayLocal = (text) => {
      if (!text) return;
      if (expr) setExpression(expr);
      say(text);
      api.recordLine({ text, scene, kind: 'local' }).catch(() => {});
    };
    // 本地台词去重：主进程根据最近 30 条本地历史过滤（相似/同角度），冷启动返回 null 时随机取
    api.pickLocal(scene).then(res => {
      if (res && res.ok && res.line) sayLocal(res.line);
      else {
        const arr = PHRASES[scene];
        if (arr && arr.length) sayLocal(randomOf(arr));
      }
    }).catch(() => {
      const arr = PHRASES[scene];
      if (arr && arr.length) sayLocal(randomOf(arr));
    });
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
  let thinkAt = 0;
  function showThinking() {
    el.bubbleText.textContent = '……';
    el.bubble.classList.add('visible');
    setWindowExpanded(true); // 思考气泡出现 → 窗口展开
    thinkAt = Date.now();
    enterState('thinking', { type: 'event' }); // 思考中切换到「思考」（事件状态，优先级高于情绪）
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      el.bubble.classList.remove('visible');
      setWindowExpanded(false); // 思考超时 → 收缩
      endState('thinking');
    }, 15000);
  }

  async function aiSay(contextPrompt, fallbackCategory, expr, imageState) {
    if (aiPending) return;
    // 勿扰：完全静默（只保留状态图，如喝水→捧杯子）
    if (dndActive()) { if (imageState) flashState(imageState, 6000); return; }
    const act = activity();
    // 仅手动聊天时使用 AI / AI 关闭 → 回退本地台词
    if (settings.aiManualOnly || !settings.aiEnabled || !llmConfigured) { speakRandom(fallbackCategory, expr); if (imageState) flashState(imageState, 6000); return; }
    // 安静模式：不主动调 AI，回退本地台词
    if (act.aiCooldown === 0) { speakRandom(fallbackCategory, expr); if (imageState) flashState(imageState, 6000); return; }
    const now = Date.now();
    if (now - lastAiSay < act.aiCooldown) { speakRandom(fallbackCategory, expr); if (imageState) flashState(imageState, 6000); return; }
    lastAiSay = now;
    aiPending = true;
    showThinking();
    try {
      const res = await api.llmSay(contextPrompt + aiContext(), fallbackCategory || 'other');
      if (res && res.ok && res.reply) {
        // 思考图至少展示 1.2 秒（思考状态在 showThinking 时进入），再切换为说话
        const wait = Math.max(0, 1200 - (Date.now() - thinkAt));
        setTimeout(() => {
          endState('thinking'); // AI 返回 → 思考结束（恢复前一状态或基础状态）
          if (expr) setExpression(expr);
          say(res.reply);
          // 注意：AI 台词已由主进程 llm-say 统一记录（避免双重记录）
          if (imageState) {
            flashState(imageState, 6000); // 特殊状态图（如喝水→捧杯子）
          } else if (Math.random() < 0.4) {
            // 说完后偶尔来个可爱的小表情：偷笑 / 庆祝
            flashState(Math.random() < 0.6 ? 'laugh' : 'happy', 2600);
          }
        }, wait);
      } else if (res && res.retryFailed) {
        // 与历史重复且重试仍重复 → 回退本地台词（未进入冷却的）
        endState('thinking');
        speakRandom(fallbackCategory, expr);
        if (imageState) flashState(imageState, 6000);
      } else {
        endState('thinking');
        speakRandom(fallbackCategory, expr);
        if (imageState) flashState(imageState, 6000);
      }
    } catch (e) {
      endState('thinking');
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
    setWindowExpanded(true); // 聊天框出现 → 窗口展开
  }
  function closeChat() {
    el.chatbar.classList.add('hidden');
    setWindowExpanded(false); // 聊天框关闭 → 收缩回人物
  }
  // 有效聊天计数：至少 2 轮有效对话 +1 亲密度；重复内容/空白/1.5秒内连发不计入
  let chatRounds = 0;
  let lastChatMsg = '';
  let lastChatTs = 0;
  async function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = '';
    chatHistory.push({ role: 'user', content: text });
    const now = Date.now();
    const isDup = text === lastChatMsg;
    const isSpam = now - lastChatTs < 1500;
    if (!isDup && !isSpam) {
      chatRounds++;
      lastChatMsg = text;
      lastChatTs = now;
    }
    // 用户回应：若之前正担心/困倦/生气（如提醒后），转为安心
    if (reminderPendingAt) { reminderPendingAt = 0; applyEmotionEvent('user-ok'); }
    else if (['concerned', 'tired', 'upset'].includes(persistentEmotion.mood)) applyEmotionEvent('user-ok');
    // 约定提取：如"明天面试" → 记录回访
    api.addFollowup(text).then(res => {
      if (res && res.ok && res.found) say('（记住了：明天' + res.event + '，我会记着的。）');
    }).catch(() => {});
    showThinking();
    const res = await api.llmChat(chatHistory);
    if (res && res.ok && res.reply) {
      chatHistory.push({ role: 'assistant', content: res.reply });
      // 思考图至少展示 1.2 秒再说话
      setTimeout(() => {
        say(res.reply);
        // 注意：AI 台词已由主进程 llm-chat 统一记录（避免双重记录）
        applyEmotionEvent('chat'); // 用心聊天 → 开心/信任
        if (chatRounds >= 2) { // 满 2 轮有效对话 → +1（每日上限 3 由主进程控制）
          chatRounds = 0;
          api.addIntimacy('chat', 1).catch(() => {});
        }
      }, Math.max(0, 1200 - (Date.now() - thinkAt)));
    } else if (res && res.retryFailed) {
      // 与历史重复且重试仍重复 → 回退本地台词
      chatHistory.pop();
      say(res.fallback || '（……）');
      if (res.fallback) api.recordLine({ text: res.fallback, scene: 'chat', kind: 'local' }).catch(() => {});
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
  let dragVisualized = false; // 拖拽视觉只设置一次，避免 move 高频闪烁
  let moved = 0;
  let dragStart = null;

  function onPointerDown(e) {
    wake(); // 用户操作把她唤醒（退出困倦状态）
    if (reminderPendingAt) { reminderPendingAt = 0; applyEmotionEvent('user-ok'); } // 回应提醒 → 安心
    dragging = true;
    dragVisualized = false;
    moved = 0;
    dragStart = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY };
  }

  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.screenX - dragStart.sx;
    const dy = e.screenY - dragStart.sy;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    if (moved > 6) {
      if (!dragVisualized) {
        dragVisualized = true;
        el.root.classList.add('dragged');
        setExpression('surprised');
        enterState('dragging', { type: 'event' }); // 拖拽中始终「盯着」（最高优先级，覆盖思考/情绪）
      }
      api.moveTo(dragStart.wx + dx, dragStart.wy + dy);
    }
  }

  // ---------- 拖拽（拖拽中始终「盯着」；放下时按概率/连拖次数生气） ----------
  let dragCount = 0; // 连续拖拽计数（频繁拖拽 → 必定生气）
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    el.root.classList.remove('dragged');
    if (moved > 6) {
      endState('dragging'); // 拖拽结束 → 结束「盯着」（恢复前一状态：如 AI 思考还在则回思考）
      applyEmotionEvent('drag'); // 拖拽结束触发一次（避免 move 高频写盘）
      const dcfg = cfg().drag;
      dragCount++;
      const angryChance = (dragCount >= (dcfg.angryAfterDrags || 3)) ? 1 : (dcfg.dropAngryChance || 0.35);
      if (Math.random() < angryChance) {
        // 放下时生气（情绪状态，force 绕过冷却：连拖规则优先）
        setExpression('pout');
        enterState('angry', { type: 'mood', force: true, duration: null });
        setEmotion('upset', 6000);
      } else {
        dragCount = 0; // 没生气 → 重置连拖计数
      }
      speakRandom('drop', 'pout');
    } else {
      clickReact();
    }
  }

  // 连点检测：1.2 秒内连点 3 次 → 必定「有点生气」（不随机）
  let clickStamp = 0;
  let clickBurst = 0;
  function clickReact() {
    const now = Date.now();
    if (now - clickStamp < 1200) clickBurst += 1;
    else clickBurst = 1;
    clickStamp = now;
    if (clickBurst >= 3) {
      clickBurst = 0;
      setExpression('pout');
      enterState('angry', { type: 'mood', force: true, duration: null }); // 连点必生气（绕过冷却）
      setEmotion('upset', 6000);
      speakRandom('angry');
      el.root.classList.remove('hop');
      void el.root.offsetWidth;
      el.root.classList.add('hop');
      return;
    }
    // 点击概率表（来自配置 cfg().click）：害羞/庆祝/偷笑/递便签说话/有点生气/保持默认说短句
    const c = cfg().click;
    const r = Math.random() * 100;
    let acc = 0, pick = 'calm';
    const order = [['shy', c.shy], ['happy', c.happy], ['laugh', c.laugh], ['speak', c.speak], ['angry', c.angry], ['calm', c.calm]];
    for (const [k, p] of order) {
      acc += (p || 0);
      if (r < acc) { pick = k; break; }
    }
    let expr;
    switch (pick) {
      case 'shy':   expr = 'blush'; enterState('shy', { type: 'mood', force: true }); setEmotion('shy', 8000); break;
      case 'happy': expr = 'happy'; enterState('happy', { type: 'mood', force: true }); setEmotion('happy', 8000); break;
      case 'laugh': expr = 'normal'; enterState('laugh', { type: 'mood', force: true }); setEmotion('happy', 6000); break;
      case 'speak': expr = 'normal'; speakRandom('click'); break; // 递便签并说话（say 内部进入 speaking 状态）
      case 'angry': expr = 'pout'; enterState('angry', { type: 'mood', force: true }); setEmotion('upset', 5000); break;
      default:      expr = 'normal'; speakRandom('click'); break; // 保持默认并播放本地短句
    }
    setExpression(expr);
    // 先让点击反应图展示约 1 秒，再进入 AI 思考/说话（否则点击图一闪而过）
    setTimeout(() => aiSay('后辈用手指戳了你一下，请用傲娇又可爱的语气回应他。', 'click'), 1000);
    // 随机动作：轻轻跳一下
    el.root.classList.remove('hop');
    void el.root.offsetWidth;
    el.root.classList.add('hop');
  }

  // ---------- 鼠标悬停（停留满 holdMs 才触发；60s 冷却；移出重进才再次触发） ----------
  let hoverInside = false;   // 鼠标是否在窗口内
  let hoverEnteredAt = 0;    // 进入时间
  let hoverTimer = null;     // 停留判定计时器
  let lastHoverAt = 0;       // 上次触发时间（冷却）
  function hoverEnter() {
    if (dragging) return;
    hoverInside = true;
    hoverEnteredAt = Date.now();
    const hold = (cfg().hover.holdMs) || 1200;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!hoverInside) return; // 已移出 → 不触发
      const now = Date.now();
      const cd = ((cfg().hover.cooldownSec) || 60) * 1000;
      if (now - lastHoverAt < cd) return; // 冷却中
      lastHoverAt = now;
      hoverReact(now - hoverEnteredAt >= hold);
    }, hold);
  }
  function hoverLeave() {
    hoverInside = false;
    if (hoverTimer) clearTimeout(hoverTimer);
  }
  function hoverReact(heldLongEnough) {
    if (dragging || aiPending) return;
    wake(); // 鼠标靠近也把她唤醒（只解除空闲困倦）
    // 概率表（来自配置 cfg().hover）：害羞40/偷笑35/挥手25
    const h = cfg().hover;
    const r = Math.random() * 100;
    let state = 'wave';
    let acc = 0;
    const order = [['shy', h.shy], ['laugh', h.laugh], ['wave', h.wave]];
    for (const [k, p] of order) {
      acc += (p || 0);
      if (r < acc) { state = k; break; }
    }
    enterState(state, { type: 'mood' });
    // 说话概率按三档模式；勿扰时不说话（延迟 0.7s，先让悬停反应图展示）
    if (!dndActive() && Math.random() < activity().speakChance) {
      setTimeout(() => speakRandom('hover'), 700);
    }
  }

  // 点击/拖拽/右键只响应在人物本体上（气泡区空白处不响应、不占位置）
  async function onContextMenu(e) {
    e.preventDefault();
    try {
      // 每次打开菜单都实时刷新 AI 配置与关系状态
      const [c, rel] = await Promise.all([api.getLlmConfig(), api.getRelationship().catch(() => null)]);
      llmConfigured = !!(c && c.configured);
      llmModel = (c && c.model) || '';
      if (rel && rel.ok) relState = { intimacy: rel.intimacy, stage: rel.stage, consecutiveDays: rel.consecutiveDays };
    } catch (err) { /* 保持原状态 */ }
    api.showContextMenu({
      reminders: settings.reminders,
      imageSize: settings.imageSize,
      imageName: settings.imageName,
      onTop: settings.onTop,
      aiEnabled: settings.aiEnabled,
      aiManualOnly: settings.aiManualOnly,
      llmConfigured: llmConfigured,
      llmModel: llmModel,
      chatOpen: !el.chatbar.classList.contains('hidden'),
      activityMode: settings.activityMode,
      dndActive: dndActive(),
      relStage: relState.stage,
      relIntimacy: relState.intimacy,
      showIntimacy: settings.showIntimacy,
      images: imageListCache,
      sleepCfg: stateConfig ? stateConfig.sleep : null,
    });
  }

  // 同一时刻只有可见的那个（svg 或用户图片）能收到事件
  el.svg.addEventListener('pointerdown', onPointerDown);
  el.userImage.addEventListener('pointerdown', onPointerDown);
  el.svg.addEventListener('contextmenu', onContextMenu);
  el.userImage.addEventListener('contextmenu', onContextMenu);
  // 悬停交互：监听整个窗口区域（停留满 1.2s 触发一次；移出后重新进入可再次触发）
  el.layer.addEventListener('mouseenter', hoverEnter);
  el.layer.addEventListener('mouseleave', hoverLeave);
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
      case 'toggle-ai-manual':
        settings.aiManualOnly = !settings.aiManualOnly;
        saveSettings();
        say(settings.aiManualOnly ? '（仅手动聊天时使用 AI）' : '（AI 自动说话已恢复）');
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
      case 'set-activity-mode':
        settings.activityMode = payload;
        saveSettings();
        say({ quiet: '（已切换为安静模式）', daily: '（已切换为日常模式）', active: '（已切换为活跃模式）' }[payload] || '（模式已切换）');
        break;
      case 'set-dnd':
        if (payload === 'day') {
          const now = new Date();
          settings.dndUntil = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 6, 0, 0).getTime(); // 到明天早上6点
          settings.dndReason = '到明天';
        } else if (typeof payload === 'number' && payload > 0) {
          settings.dndUntil = Date.now() + payload;
          settings.dndReason = payload === 30 * 60000 ? '30分钟' : '1小时';
        } else {
          settings.dndUntil = 0;
          settings.dndReason = '';
        }
        saveSettings();
        if (settings.dndUntil) {
          const d = new Date(settings.dndUntil);
          say('（勿扰至 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') + '）');
        } else {
          say('（勿扰已解除）');
        }
        break;
      case 'open-memory':
        if (window.Memory) window.Memory.open(payload === 'sleep' ? 'sleep' : undefined);
        break;
      case 'toggle-sleep':
        // 困倦三源开关（nap/late/idle）→ 更新配置并立即生效
        if (stateConfig) {
          const key = payload === 'nap' ? 'nap' : payload === 'late' ? 'lateNight' : 'idle';
          stateConfig.sleep[key].enabled = !stateConfig.sleep[key].enabled;
          api.saveStateConfig({ sleep: { [key]: stateConfig.sleep[key] } }).then(() => {
            checkSleepSchedule(); // 立即重算（如关闭午觉 → 退出困倦）
            renderBestState();
            say({ nap: '（午觉时段困倦已' + (stateConfig.sleep.nap.enabled ? '开启' : '关闭') + '）', late: '（深夜时段困倦已' + (stateConfig.sleep.lateNight.enabled ? '开启' : '关闭') + '）', idle: '（空闲困倦已' + (stateConfig.sleep.idle.enabled ? '开启' : '关闭') + '）' }[key]);
          }).catch(() => {});
        }
        break;
      case 'reload-state-config':
        api.reloadStateConfig().then(res => {
          if (res && res.ok && res.config) {
            stateConfig = Object.assign({}, DEFAULT_CONFIG, res.config);
            buildStateImages();
            checkSleepSchedule();
            renderBestState();
            say('（状态配置已重新加载）');
          }
        }).catch(() => {});
        break;
      case 'toggle-show-intimacy':
        settings.showIntimacy = !settings.showIntimacy;
        saveSettings();
        break;
    }
  });

  // ---------- 时间问候 ----------
  function hourOf() { return new Date().getHours(); }
  function timeGreeting() {
    if (dndActive()) return; // 勿扰：跳过问候
    const h = hourOf();
    // 挥手：每个时段（小时）主动最多 1 次（pose.wavePerHour）
    if (lastWaveHour !== h && (cfg().pose.wavePerHour || 1) > 0) {
      lastWaveHour = h;
      enterState('wave', { type: 'mood', force: true }); // 问候时→挥手
    }
    if (h >= 5 && h < 11) speakRandom('morning', 'happy');
    else if (h >= 11 && h < 14) speakRandom('noon', 'normal');
    else if (h >= 14 && h < 18) speakRandom('evening', 'normal');
    else speakRandom('night', 'sleepy');
  }

  let lastHour = -1;
  function timeLoop() {
    // 困倦时段检查（午觉/深夜；跨天正确处理）
    checkSleepSchedule();
    // 勿扰刚到期：提醒一下（用「提醒」形象）
    if (settings.dndUntil > 0 && !dndActive()) {
      settings.dndUntil = 0;
      settings.dndReason = '';
      saveSettings();
      flashState('remind', 4000);
      say('（勿扰时间到了，后辈）');
    }
    if (dndActive()) { lastHour = hourOf(); return; } // 勿扰：跳过整点报时
    const h = hourOf();
    if (lastHour >= 0 && h !== lastHour) {
      speakThrottled('hourly', 'normal', 3600000);
      if (h >= 23) applyEmotionEvent('late-night'); // 深夜 → 担心
    }
    lastHour = h;
  }

  // ---------- 系统状态监测 ----------
  let cpuHighNotified = false;
  let memHighNotified = false;
  async function sysLoop() {
    try {
      const s = await api.sysStats();
      if (s.cpu >= 80 && !cpuHighNotified) { cpuHighNotified = true; setEmotion('worried', 120000); applyEmotionEvent('high-load'); aiSay('检测到电脑 CPU 占用高达 ' + s.cpu + '%，你担心地对后辈说点什么。', 'cpuHigh', 'worried'); }
      else if (s.cpu < 50) cpuHighNotified = false;
      if (s.mem >= 85 && !memHighNotified) { memHighNotified = true; setEmotion('worried', 120000); aiSay('检测到电脑内存占用高达 ' + s.mem + '%，你提醒一下后辈。', 'memHigh', 'worried'); }
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
  let lastIdleSeconds = 0; // 最近一次空闲秒数（困倦评估用）
  async function fgLoop() {
    try {
      const fg = await api.foregroundApp();
      if (!fg) return;
      lastIdleSeconds = fg.idleSeconds || 0;

      // 空闲困倦：达到阈值进入（可开关；时间段困倦由 checkSleepSchedule 独立管理）
      if (lastIdleSeconds >= (cfg().sleep.idle.idleSeconds || 300)) {
        if (cfg().sleep.idle.enabled && sleepSource !== 'idle') {
          sleepSource = 'idle';
          renderBestState(); // 困倦图
          setEmotion('tired', 600000);
          applyEmotionEvent('idle');
          aiSay('后辈已经很久没动电脑了，你困倦地打了个哈欠，对他说点什么。', 'idle', 'sleepy');
        }
        return;
      }
      if (sleepSource === 'idle') {
        sleepSource = null; // 恢复操作 → 解除空闲困倦（时段困倦不受影响）
        renderBestState();
      }

      // 连续活动累计：60 分钟 → 担心
      if (fg.idleSeconds < 60) activeMinutes += 20 / 60;
      else activeMinutes = 0;
      if (activeMinutes >= 60) {
        activeMinutes = 0;
        applyEmotionEvent('long-activity', { text: '后辈连续使用电脑已经一小时了' });
      }

      const cat = categorize(fg);
      if (cat && cat !== lastCat) {
        lastCat = cat;
        const expr = (cat === 'video' || cat === 'music') ? 'normal' : (cat === 'game' ? 'happy' : 'normal');
        if (cat === 'game') setEmotion('happy', 30000);
        else if (cat === 'coding') setEmotion('calm', 30000);
        const catText = { coding: '写代码', game: '打游戏', video: '看视频', music: '听歌', chat: '聊天', office: '办公', browser: '刷网页' }[cat] || cat;
        aiSay('后辈正在' + catText + '，你随口对他说一句相关的话。', cat, expr);
      }
    } catch (e) { /* ignore */ }
  }

  let activeMinutes = 0; // 连续活动累计（分钟）

  // ---------- 健康提醒 ----------
  let sitSince = Date.now();
  let waterSince = Date.now();
  let restSince = Date.now();
  let reminderPendingAt = 0; // 提醒后用户是否回应（未回应 → 小生气）
  function healthLoop() {
    const now = Date.now();
    if (settings.reminders.sit && now - sitSince > 15 * 60000) { sitSince = now; reminderPendingAt = now; applyEmotionEvent('concerned', { text: '后辈久坐 15 分钟了' }); aiSay('后辈已经久坐 15 分钟了，你提醒他起来活动一下。', 'healthSit', 'worried', 'remind'); } // 提醒
    if (settings.reminders.water && now - waterSince > 20 * 60000) { waterSince = now; reminderPendingAt = now; applyEmotionEvent('concerned', { text: '后辈该喝水了' }); aiSay('该喝水了，你提醒后辈去喝口水。', 'healthWater', 'normal', 'cup'); } // 捧杯子
    if (settings.reminders.rest && now - restSince > 30 * 60000) { restSince = now; reminderPendingAt = now; applyEmotionEvent('concerned', { text: '后辈该休息了' }); aiSay('后辈该休息一下了，你关心地提醒他。', 'healthRest', 'sleepy', 'remind'); } // 提醒
    // 提醒 8 分钟后用户仍无回应 → 小生气（被忽略）
    if (reminderPendingAt && now - reminderPendingAt > 8 * 60000) {
      reminderPendingAt = 0;
      applyEmotionEvent('ignored-reminder');
    }
  }

  // ---------- 启动 ----------
  function init() {
    applyOutfit(settings.outfit);
    setExpression('pout');
    scheduleBlink();
    loadStateConfig().then(() => {
      checkSleepSchedule(); // 配置加载后立即评估困倦时段
      renderBestState();
    });
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
    scheduleIdleAction(); // 定期随机小动作，让形象经常切换

    // 台词去重：把本地台词库注册给主进程（pickLocal 过滤相似/角度）
    api.registerPhrases(PHRASES).catch(() => {});

    // 记忆：首次见面纪念册（仅一次）
    api.getMemory().then(m => {
      const milestones = (m && m.milestones && m.milestones.entries) || [];
      if (milestones.length === 0) {
        api.addMilestone({ title: '和麻衣的第一次见面', note: '后辈的桌宠正式上线' }).catch(() => {});
      }
    }).catch(() => {});
    // 亲密度：每日仪式（签到/连续陪伴/重要日期/阶段升级）
    const todayKeyLocal = new Date().toDateString();
    if (localStorage.getItem('mem-last-day') !== todayKeyLocal) {
      localStorage.setItem('mem-last-day', todayKeyLocal);
      api.dailyRitual().then(res => {
        if (res && res.ok) {
          refreshRelationship();
          refreshEmotion();
          if (res.newStage) {
            say('（关系升级：' + res.newStage + '）');
            flashState('happy', 3200);
          }
          // 到期的约定：主动回访（每日一次）
          if (res.followups && res.followups.length) {
            const fu = res.followups[0];
            flashState('remind', 4000);
            say('（今天就是' + fu.event + '的日子了……后辈，准备好了吗？）');
          }
        }
      }).catch(() => {});
    } else {
      refreshRelationship();
      refreshEmotion();
    }
  }

  let relState = { intimacy: 0, stage: '初识后辈', consecutiveDays: 0 };
  // 供记忆窗口读取设置（隐藏亲密度数值时）与持久情绪
  window.petSettings = {
    get showIntimacy() { return settings.showIntimacy; },
    get emotion() { return MOOD_NAME[persistentEmotion.mood] || '平静'; },
    get emotionReason() { return persistentEmotion.reason || ''; },
  };
  function refreshRelationship() {
    api.getRelationship().then(r => {
      if (r && r.ok) relState = { intimacy: r.intimacy, stage: r.stage, consecutiveDays: r.consecutiveDays };
    }).catch(() => {});
  }

  init();
})();
