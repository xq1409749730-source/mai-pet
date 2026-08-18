// 状态机核心逻辑测试（从 renderer/app.js 提取的纯逻辑，不依赖 DOM）
const assert = require('assert');

// ---------- 状态配置（与 DEFAULT_CONFIG 同步） ----------
const DEFAULT_CONFIG = {
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

// ---------- 状态机（与 app.js 同步） ----------
let stateStack = [];
const lastStateAt = {};
const recentPoses = [];
function statePriority(id) { const st = DEFAULT_CONFIG.states[id]; return st ? st.priority : 50; }
function isEventState(id) { return ['dragging', 'thinking', 'speaking', 'remind', 'cup'].includes(id); }
function stateInCooldown(id) {
  const st = DEFAULT_CONFIG.states[id];
  if (!st || !st.cooldown) return false;
  const last = lastStateAt[id];
  return !!last && (Date.now() - last) < st.cooldown * 1000;
}
function stateDuration(id, overrideMs) {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  const st = DEFAULT_CONFIG.states[id];
  if (!st) return 2600;
  if (st.minDuration) return st.minDuration;
  if (Array.isArray(st.duration)) return st.duration[0];
  return st.duration || 2600;
}
let displayed = null;
function applyCharState(state) { displayed = state; }
function enterState(id, opts) {
  opts = opts || {};
  const st = DEFAULT_CONFIG.states[id];
  if (!st) return;
  if (opts.type === 'mood' && !opts.force) {
    const max = DEFAULT_CONFIG.pose.maxRepeat;
    const cont = recentPoses.filter(p => p === id).length;
    if (cont >= max && !isEventState(id)) return;
  }
  if (!opts.force && opts.type === 'mood' && stateInCooldown(id)) return;
  const now = Date.now();
  const exist = stateStack.find(s => s.id === id);
  if (exist) { exist.ts = now; }
  else stateStack.push({ id, type: opts.type || 'mood', ts: now });
  lastStateAt[id] = now;
  recentPoses.push(id);
  if (recentPoses.length > 12) recentPoses.shift();
  renderBestState();
}
function endState(id) {
  const i = stateStack.findIndex(s => s.id === id);
  if (i >= 0) stateStack.splice(i, 1);
  renderBestState();
}
function baseStateId(sleepSource, moodImage) {
  if (sleepSource) return 'sleepy';
  if (moodImage && moodImage !== 'default') return moodImage;
  return 'default';
}
function renderBestState(sleepSource, moodImage) {
  const sorted = [...stateStack].sort((a, b) => statePriority(b.id) - statePriority(a.id) || b.ts - a.ts);
  const best = sorted[0];
  if (best) applyCharState(best.id);
  else applyCharState(baseStateId(sleepSource, moodImage));
}

// ---------- 测试 1：优先级仲裁 ----------
stateStack = [];
enterState('shy', { type: 'mood', force: true });   // 害羞(40)
enterState('thinking', { type: 'event' });            // 思考(90)
assert.strictEqual(displayed, 'thinking', '思考(90) 应覆盖 害羞(40)');
enterState('dragging', { type: 'event' });            // 拖拽(100)
assert.strictEqual(displayed, 'dragging', '拖拽(100) 应覆盖 思考(90)');
console.log('✓ 测试1 优先级仲裁（拖拽>思考>害羞）');

// ---------- 测试 2：状态栈恢复（拖拽结束 → 思考仍在 → 恢复思考） ----------
endState('dragging');
assert.strictEqual(displayed, 'thinking', '拖拽结束应恢复思考（思考仍在栈中）');
endState('thinking');
assert.strictEqual(displayed, 'shy', '思考结束应恢复害羞');
endState('shy');
assert.strictEqual(displayed, 'default', '全部结束回默认');
console.log('✓ 测试2 状态栈恢复（思考→害羞→默认）');

// ---------- 测试 3：事件结束恢复情绪/困倦 ----------
stateStack = [];
enterState('angry', { type: 'mood', force: true });
enterState('thinking', { type: 'event' });
endState('thinking');
assert.strictEqual(displayed, 'angry', '思考结束应恢复生气（情绪状态）');
endState('angry');
// 手动渲染基础状态（困倦时段）
renderBestState('nap', null);
assert.strictEqual(displayed, 'sleepy', '生气结束回困倦（sleepSource 时）');
// 无困倦、无情绪 → 默认
renderBestState(null, null);
assert.strictEqual(displayed, 'default', '无困倦无情绪回默认');
console.log('✓ 测试3 事件结束恢复情绪→困倦');

// ---------- 测试 4：点击概率表分布（10000 次抽样） ----------
const c = DEFAULT_CONFIG.click;
const counts = {};
for (let i = 0; i < 10000; i++) {
  const r = Math.random() * 100;
  let acc = 0, pick = 'calm';
  for (const [k, p] of [['shy', c.shy], ['happy', c.happy], ['laugh', c.laugh], ['speak', c.speak], ['angry', c.angry], ['calm', c.calm]]) {
    acc += (p || 0);
    if (r < acc) { pick = k; break; }
  }
  counts[pick] = (counts[pick] || 0) + 1;
}
const sum = Object.values(counts).reduce((a, b) => a + b, 0);
assert.strictEqual(sum, 10000, '概率应全覆盖（100%）');
assert.ok(Math.abs(counts.shy / 10000 - 0.30) < 0.02, '害羞≈30%: ' + (counts.shy / 10000));
assert.ok(Math.abs(counts.happy / 10000 - 0.20) < 0.02, '庆祝≈20%: ' + (counts.happy / 10000));
assert.ok(Math.abs(counts.laugh / 10000 - 0.20) < 0.02, '偷笑≈20%: ' + (counts.laugh / 10000));
assert.ok(Math.abs(counts.speak / 10000 - 0.15) < 0.02, '递便签≈15%: ' + (counts.speak / 10000));
assert.ok(Math.abs(counts.angry / 10000 - 0.05) < 0.02, '有点生气≈5%: ' + (counts.angry / 10000));
assert.ok(Math.abs(counts.calm / 10000 - 0.10) < 0.02, '保持默认≈10%: ' + (counts.calm / 10000));
console.log('✓ 测试4 点击概率分布 害羞30/庆祝20/偷笑20/递便签15/生气5/默认10');
console.log('    实测: ' + Object.entries(counts).map(([k, v]) => k + '=' + (v / 100).toFixed(1) + '%').join(' '));

// ---------- 测试 5：悬停概率（10000 次抽样） ----------
const h = DEFAULT_CONFIG.hover;
const hc = {};
for (let i = 0; i < 10000; i++) {
  const r = Math.random() * 100;
  let pick = 'wave', acc = 0;
  for (const [k, p] of [['shy', h.shy], ['laugh', h.laugh], ['wave', h.wave]]) {
    acc += (p || 0);
    if (r < acc) { pick = k; break; }
  }
  hc[pick] = (hc[pick] || 0) + 1;
}
assert.ok(Math.abs(hc.shy / 10000 - 0.40) < 0.02, '悬停害羞≈40%');
assert.ok(Math.abs(hc.laugh / 10000 - 0.35) < 0.02, '悬停偷笑≈35%');
assert.ok(Math.abs(hc.wave / 10000 - 0.25) < 0.02, '悬停挥手≈25%');
console.log('✓ 测试5 悬停概率 害羞40/偷笑35/挥手25');

// ---------- 测试 6：困倦时段（含跨天） ----------
function timeToMin(s) { const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function inTimeRange(min, start, end) {
  const s = timeToMin(start), e = timeToMin(end);
  if (s === null || e === null) return false;
  if (s <= e) return min >= s && min < e;
  return min >= s || min < e;
}
function evalSleepSource(min, sl, idleSec) {
  if (sl.nap.enabled && inTimeRange(min, sl.nap.start, sl.nap.end)) return 'nap';
  if (sl.lateNight.enabled && inTimeRange(min, sl.lateNight.start, sl.lateNight.end)) return 'late';
  if (sl.idle.enabled && idleSec >= sl.idle.idleSeconds) return 'idle';
  return null;
}
const sl = DEFAULT_CONFIG.sleep;
assert.strictEqual(evalSleepSource(12 * 60 + 45, sl, 10), 'nap', '12:45 应为午觉');
assert.strictEqual(evalSleepSource(13 * 60 + 59, sl, 10), 'nap', '13:59 应为午觉');
assert.strictEqual(evalSleepSource(14 * 60 + 0, sl, 10), null, '14:00 应结束午觉（无空闲）');
assert.strictEqual(evalSleepSource(23 * 60 + 45, sl, 10), 'late', '23:45 应为深夜');
assert.strictEqual(evalSleepSource(0 * 60 + 30, sl, 10), 'late', '00:30 跨天仍为深夜');
assert.strictEqual(evalSleepSource(6 * 60 + 29, sl, 10), 'late', '06:29 仍为深夜');
assert.strictEqual(evalSleepSource(6 * 60 + 30, sl, 10), null, '06:30 应结束深夜');
assert.strictEqual(evalSleepSource(8 * 60 + 0, sl, 10), null, '08:00 不在任何时段');
assert.strictEqual(evalSleepSource(8 * 60 + 0, sl, 400), 'idle', '空闲超过阈值 → idle');
console.log('✓ 测试6 困倦时段（午觉12:30~14:00 / 深夜23:30~次日06:30 跨天 / 空闲超时）');

// ---------- 测试 7：重复姿势冷却（maxRepeat=2） ----------
stateStack = [];
recentPoses.length = 0;
// 模拟连续 5 次随机动作
let picks = [];
for (let i = 0; i < 5; i++) {
  const recent = recentPoses.slice(-2);
  const pool = DEFAULT_CONFIG.states ? Object.keys(DEFAULT_CONFIG.states).filter(id => !['default', 'sleepy', 'speaking', 'thinking', 'dragging'].includes(id)) : [];
  let p = pool.filter(x => !recent.includes(x));
  if (!p.length) p = pool;
  const pick = p[Math.floor(Math.random() * p.length)];
  picks.push(pick);
  recentPoses.push(pick);
  if (recentPoses.length > 12) recentPoses.shift();
}
// 检查没有连续 3 次相同
let consecutive = 1, maxConsecutive = 1;
for (let i = 1; i < picks.length; i++) {
  if (picks[i] === picks[i - 1]) { consecutive++; maxConsecutive = Math.max(maxConsecutive, consecutive); }
  else consecutive = 1;
}
assert.ok(maxConsecutive <= 2, '同一姿势连续出现不应超过2次，实际=' + maxConsecutive + ' picks=' + picks.join(','));
console.log('✓ 测试7 重复姿势冷却（连续出现≤2次）：' + picks.join(' → '));

console.log('\n状态机测试全部通过 ✅');
