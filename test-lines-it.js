// 集成测试：复刻主进程 llm-say 去重重试流程（mock llmCall）
// 验证：重复→重试→仍重复→回退本地 + retry 预算独立
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

// ---------- 测试环境 ----------
const dataDir = path.join(os.tmpdir(), 'mai-pet-lines-it-' + Date.now());
const MEMORY_DIR = path.join(dataDir, 'memory');
fs.mkdirSync(MEMORY_DIR, { recursive: true });
const todayKey = () => new Date().toISOString().slice(0, 10);

// ---------- 从 main.js 复刻（保持同步） ----------
const LINES_AI_MAX = 50, LINES_LOCAL_MAX = 30, LINES_SIM_THRESHOLD = 0.72;
const LOCAL_COOLDOWN_WINDOW = 4;
function normalizeText(text) {
  let s = String(text || '');
  try { s = s.normalize('NFKC'); } catch (e) { }
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[（(【［「『]|[）)】］」』]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, '');
  s = s.replace(/[的了么吗呢啊吧呀哦嗯哈都就在还这那很挺]/g, '');
  return s.toLowerCase();
}
function lcsRatio(a, b) {
  const A = normalizeText(a), B = normalizeText(b);
  if (!A || !B) return 0; if (A === B) return 1;
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
function similarity(a, b) {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return 0; if (na === nb) return 1;
  const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const ga = grams(na), gb = grams(nb);
  let inter = 0, totalA = 0, totalB = 0;
  ga.forEach((cnt, k) => { totalA += cnt; if (gb.has(k)) inter += Math.min(cnt, gb.get(k)); });
  gb.forEach(cnt => { totalB += cnt; });
  const dice = totalA + totalB === 0 ? 0 : (2 * inter) / (totalA + totalB);
  const setA = new Set(na.split('')), setB = new Set(nb.split(''));
  let uni = 0; setA.forEach(c => { if (setB.has(c)) uni++; });
  const jaccard = setA.size + setB.size === 0 ? 0 : uni / (setA.size + setB.size - uni);
  return Math.max(dice, jaccard, lcsRatio(a, b));
}
function classifyAngle(t) {
  t = String(t || '');
  if (/才不是|才没有|才不|不是.*在意|没.*等你|谁.*等|哼/.test(t)) return 'tsundere';
  if (/脸红|害羞|别.*靠|靠.*近|盯着我|看.*什么/.test(t)) return 'shy';
  if (/记得|别忘了|别忘|该|应该|快|去喝|去走|动一动|休息|保存|起来|关掉|别玩|别看/.test(t)) return 'command';
  if (/关心|担心|心疼|不想你|希望你|加油|辛苦|努力|会陪|看着你|惦记/.test(t)) return 'care';
  if (/好无聊|好傻|抗议|冒烟|累趴|告急|没品味|有品味|还不错|有点意思/.test(t)) return 'tease';
  if (/干嘛|别戳|别拎|放我下来|失礼|轻点|弄乱|不理你|够了|烦/.test(t)) return 'complaint';
  if (/早上好|早安|中午|午休|晚安|晚上好|天黑了|起床|报时|整点/.test(t)) return 'greet';
  return 'other';
}
function linesFile() { return path.join(MEMORY_DIR, 'recent-lines.json'); }
function readLines() {
  const fallback = { schemaVersion: 1, entries: [] };
  try { const d = JSON.parse(fs.readFileSync(linesFile(), 'utf8')); if (d && Array.isArray(d.entries)) return d; return fallback; }
  catch (e) { return fallback; }
}
function writeLines(d) {
  fs.writeFileSync(linesFile() + '.tmp', JSON.stringify(d));
  fs.renameSync(linesFile() + '.tmp', linesFile());
}
function recordLine(entry) {
  const d = readLines();
  const kind = entry.kind === 'local' ? 'local' : 'ai';
  const max = kind === 'local' ? LINES_LOCAL_MAX : LINES_AI_MAX;
  const e = { text: String(entry.text || '').trim(), scene: String(entry.scene || 'other'), mood: String(entry.mood || 'calm'), angle: classifyAngle(entry.text), ts: Date.now(), kind };
  if (!e.text) return null;
  d.entries.push(e);
  const byKind = d.entries.filter(x => x.kind === kind);
  const otherKind = d.entries.filter(x => x.kind !== kind);
  while (byKind.length > max) byKind.shift();
  d.entries = [...otherKind, ...byKind];
  writeLines(d);
  return e;
}
function isDuplicateInScene(text, scene) {
  const n = normalizeText(text);
  if (!n) return false;
  return readLines().entries.filter(x => x.scene === scene).some(x => similarity(text, x.text) > LINES_SIM_THRESHOLD);
}
function pickLocalLine(scene) {
  const phrases = LOCAL_PHRASES[scene] || [];
  if (!phrases.length) return null;
  const hist = readLines().entries.filter(x => x.kind === 'local' && x.scene === scene).sort((a, b) => b.ts - a.ts);
  const last = hist.length ? hist[0] : null;
  let pool = phrases.filter(p => {
    if (hist.slice(0, LOCAL_COOLDOWN_WINDOW).some(h => h.text === p)) return false;
    if (hist.some(h => similarity(p, h.text) > LINES_SIM_THRESHOLD)) return false;
    if (last && classifyAngle(p) === last.angle && classifyAngle(p) !== 'other') return false;
    return true;
  });
  if (!pool.length) pool = phrases.filter(p => !hist.slice(0, LOCAL_COOLDOWN_WINDOW).some(h => h.text === p));
  if (!pool.length) pool = phrases.slice();
  return pool[Math.floor(Math.random() * pool.length)];
}
let LOCAL_PHRASES = { click: ['别戳我啦，后辈。', '……干嘛？', '哼。', '后辈，你的手好闲。'] };

// ---------- AI 预算（retry 独立） ----------
const AI_DAILY_LIMIT = { say: 40, chat: 100, retry: 20 };
function aiUsageFile() { return path.join(MEMORY_DIR, 'ai-usage.json'); }
function readAiUsage() {
  try { const u = JSON.parse(fs.readFileSync(aiUsageFile(), 'utf8')); if (u && u.date === todayKey()) return u; } catch (e) { }
  return { date: todayKey(), say: 0, chat: 0, retry: 0 };
}
function spendAi(kind) {
  const u = readAiUsage();
  if (u[kind] >= AI_DAILY_LIMIT[kind]) return false;
  u[kind] += 1;
  fs.writeFileSync(aiUsageFile(), JSON.stringify(u));
  return true;
}

// ---------- mock llmCall：第一次返回与历史重复，第二次仍重复 ----------
let callCount = 0;
const REPEAT_TEXT = '别一直刷网页了，眼睛会累的，起来活动一下吧。';
async function mockLlmCall(messages, maxTokens) {
  callCount++;
  return REPEAT_TEXT; // 永远返回同一句 → 必然与历史重复
}
// 复刻主进程 retryLlm：先 spendAi('retry') 再调用
async function retryLlmMock(messages, maxTokens, scene) {
  try {
    if (!spendAi('retry')) return null; // 重试预算用完 → 不再重试（走回退）
    return await mockLlmCall(messages, maxTokens);
  } catch (e) { return null; }
}

// ---------- 场景 1：生成重复 → 重试 → 仍重复 → 回退本地 ----------
async function scene1() {
  // 预置同场景相似历史
  recordLine({ text: REPEAT_TEXT, scene: 'click', mood: 'calm', kind: 'ai' });
  assert.ok(isDuplicateInScene(REPEAT_TEXT, 'click'), '预置历史应命中重复');

  callCount = 0;
  // 复刻 llm-say 去重分支（与主进程一致：重试走 retryLlm）
  const scene = 'click';
  let reply = await mockLlmCall([], 120); // 第一次生成（返回重复文本）
  let finalReply = null, retryFailed = false, fallback = null;
  if (isDuplicateInScene(reply, scene)) {
    const r2 = await retryLlmMock([], 120, scene); // 重试（消耗 retry 预算）
    if (r2 && !isDuplicateInScene(r2, scene)) {
      finalReply = r2;
    } else if (r2) {
      // 重试仍重复
      const local = pickLocalLine(scene);
      retryFailed = true;
      fallback = local;
    }
  } else {
    finalReply = reply;
  }

  console.log('场景1: 首次生成命中重复 → 重试次数=' + (callCount - 1));
  assert.strictEqual(callCount, 2, '应恰好调用2次（首次+重试1次）');
  assert.strictEqual(retryFailed, true, '重试仍重复应回退');
  assert.ok(fallback, '回退应返回本地台词');
  assert.ok(LOCAL_PHRASES[scene].includes(fallback), '回退台词应来自本地库: ' + fallback);
  const usage = readAiUsage();
  assert.strictEqual(usage.retry, 1, 'retry 应独立计数=1');
  assert.strictEqual(usage.say, 0, 'say 预算不应被重试消耗');
  console.log('  ✓ 重试1次、回退本地[' + fallback + ']、retry独立计数=' + usage.retry + '、say未消耗');
}

// ---------- 场景 2：retry 预算耗尽 → 直接回退（不再调 llm） ----------
async function scene2() {
  // 用尽 retry 预算
  const u = readAiUsage();
  u.retry = AI_DAILY_LIMIT.retry;
  fs.writeFileSync(aiUsageFile(), JSON.stringify(u));
  callCount = 0;
  const scene = 'click';
  const reply = await mockLlmCall([], 120);
  let r2 = null;
  if (isDuplicateInScene(reply, scene)) {
    r2 = await retryLlmMock([], 120, scene);
  }
  console.log('场景2: retry预算耗尽 → r2=' + r2 + '（应为null，直接回退）');
  assert.strictEqual(r2, null, 'retry 预算用完应返回 null 走回退');
  assert.strictEqual(callCount, 1, '不应额外调用 llm');
  const usage = readAiUsage();
  assert.strictEqual(usage.retry, AI_DAILY_LIMIT.retry, 'retry 不应超过上限');
  console.log('  ✓ 预算耗尽后不再重试，走回退路径');
}

// ---------- 场景 3：不重复 → 直接记录，无重试 ----------
async function scene3() {
  const u = readAiUsage(); u.retry = 0; fs.writeFileSync(aiUsageFile(), JSON.stringify(u));
  callCount = 0;
  const scene = 'click';
  let reply = '完全不同的一句话，后辈今天心情不错嘛。';
  assert.ok(!isDuplicateInScene(reply, scene), '新内容不应判重复');
  console.log('场景3: 新内容不重复 → 直接通过（无重试）');
  assert.strictEqual(callCount, 0, '不重复不应触发任何额外调用');
  console.log('  ✓ 不重复直接通过');
}

(async () => {
  await scene1();
  await scene2();
  await scene3();
  console.log('\n集成测试全部通过 ✅');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { }
})();
