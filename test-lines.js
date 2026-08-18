// 台词去重系统核心算法测试（从 main.js 提取的纯逻辑，不依赖 electron）
const assert = require('assert');

// ---------- 从 main.js 复制的算法（保持同步） ----------
const LINES_SIM_THRESHOLD = 0.72;
function normalizeText(text) {
  let s = String(text || '');
  try { s = s.normalize('NFKC'); } catch (e) { /* 忽略 */ }
  s = s.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[（(【［「『]|[）)】］」』]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, '');
  s = s.replace(/[的了么吗呢啊吧呀哦嗯哈都就在还这那很挺]/g, '');
  return s.toLowerCase();
}
function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
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
  const setA = new Set(na.split(''));
  const setB = new Set(nb.split(''));
  let uni = 0;
  setA.forEach(c => { if (setB.has(c)) uni++; });
  const jaccard = setA.size + setB.size === 0 ? 0 : uni / (setA.size + setB.size - uni);
  return Math.max(dice, jaccard, lcsRatio(a, b));
}
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

// ---------- 测试 1：标准化 ----------
assert.strictEqual(normalizeText('后辈，别戳了！Ｈｅｌｌｏ'), '后辈别戳hello');
assert.strictEqual(normalizeText('（脸红）别、别靠这么近啦，后辈。'), '脸红别别靠近啦后辈');
console.log('✓ 测试1 文本标准化');

// ---------- 测试 2：相似度 ----------
const sSame = similarity('后辈，你的电脑在抗议了，好吵。', '后辈，你的电脑在抗议了，好吵。');
const sPara = similarity('后辈，你的电脑在抗议了，好吵。', '电脑都在抗议了，后辈，好吵啊。');
const sDiff = similarity('后辈，去喝口水。我可不想你倒下。', '打游戏？后辈，输了可别怪我没提醒你。');
console.log('  完全相同:', sSame.toFixed(3), '| 近义改写:', sPara.toFixed(3), '| 无关:', sDiff.toFixed(3));
assert.ok(sSame >= 1, '完全相同应=1');
assert.ok(sPara > LINES_SIM_THRESHOLD, '近义改写应 > 0.72 视为重复');
assert.ok(sDiff < LINES_SIM_THRESHOLD, '无关应 < 0.72');
// LCS 场景：删减型改写（截取原句前半）也应判重复
const sCut = similarity('网页刷了这么久，眼睛不累吗...那边有杯茶，凉了的话就别喝了。', '网页刷了这么久，眼睛不累吗？');
const sTpl = similarity('后辈，记得保存。别等出错了才后悔。', '后辈，记得随时保存。');
console.log('  删减改写:', sCut.toFixed(3), '| 模板共享:', sTpl.toFixed(3));
assert.ok(sCut > LINES_SIM_THRESHOLD, '删减改写应 > 0.72');
assert.ok(sTpl > LINES_SIM_THRESHOLD, '共享模板+近义应 > 0.72');
assert.ok(similarity('早', '晚安') === 0);
console.log('✓ 测试2 相似度阈值(0.72)');

// ---------- 测试 3：角度分类 ----------
assert.strictEqual(classifyAngle('……我才没有在等你，后辈。'), 'tsundere');
assert.strictEqual(classifyAngle('记得保存，后辈。'), 'command');
assert.strictEqual(classifyAngle('后辈，工作加油。'), 'care');
assert.strictEqual(classifyAngle('别戳我啦，后辈。'), 'complaint');
assert.strictEqual(classifyAngle('早上好，后辈。'), 'greet');
assert.strictEqual(classifyAngle('（脸红）别、别靠这么近啦，后辈。'), 'shy');
assert.strictEqual(classifyAngle('后辈，这歌还不错。……算你有点品味。'), 'tease');
console.log('✓ 测试3 角度分类');

// ---------- 测试 4：角度轮换（同场景上一条角度 != 本次；other 不参与约束） ----------
const clickPhrases = ['别戳我啦，后辈。', '……干嘛？', '哼。', '我、我才没有在等你，后辈。', '后辈，你的手好闲。'];
function pickAngle(hist) {
  const last = hist.length ? hist[hist.length - 1] : null;
  let pool = clickPhrases.filter(p => {
    if (last && classifyAngle(p) === last.angle && classifyAngle(p) !== 'other') return false;
    return true;
  });
  if (!pool.length) pool = clickPhrases.slice();
  return pool[Math.floor(Math.random() * pool.length)];
}
let hist = [{ text: '……我才没有在等你，后辈。', angle: 'tsundere' }];
for (let i = 0; i < 30; i++) {
  const pick = pickAngle(hist);
  const a = classifyAngle(pick);
  const prev = hist[hist.length - 1].angle;
  if (a !== 'other' && prev !== 'other') {
    assert.notStrictEqual(a, prev, '同场景连续两次非other角度必须不同');
  }
  hist.push({ text: pick, angle: a });
}
console.log('✓ 测试4 角度轮换(30次无同角度相邻, other豁免)');

// ---------- 测试 5：裁剪（AI 50 / 本地 30） ----------
function simulateTrim(entries, kind, max) {
  const byKind = entries.filter(x => x.kind === kind);
  const otherKind = entries.filter(x => x.kind !== kind);
  while (byKind.length > max) byKind.shift();
  return [...otherKind, ...byKind];
}
const aiEntries = Array.from({ length: 60 }, (_, i) => ({ kind: 'ai', ts: i, text: 'a' + i }));
const localEntries = Array.from({ length: 40 }, (_, i) => ({ kind: 'local', ts: i, text: 'l' + i }));
const trimmed = simulateTrim([...aiEntries, ...localEntries], 'ai', 50);
assert.strictEqual(trimmed.filter(x => x.kind === 'ai').length, 50);
assert.strictEqual(trimmed.filter(x => x.kind === 'local').length, 40); // 本地不受 AI 裁剪影响
const t2 = simulateTrim(trimmed, 'local', 30);
assert.strictEqual(t2.filter(x => x.kind === 'local').length, 30);
assert.strictEqual(t2.filter(x => x.kind === 'ai').length, 50);
console.log('✓ 测试5 独立裁剪 AI=50/本地=30');

// ---------- 测试 6：损坏自愈 ----------
const fs = require('fs'), path = require('path'), os = require('os');
const tmpFile = path.join(os.tmpdir(), 'recent-lines-test-' + Date.now() + '.json');
fs.writeFileSync(tmpFile, '{{{ 坏 JSON');
let recovered = null;
try {
  const d = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  recovered = d;
} catch (e) {
  fs.renameSync(tmpFile, tmpFile + '.bak');
  recovered = { schemaVersion: 1, entries: [] };
}
assert.strictEqual(recovered.entries.length, 0);
assert.ok(fs.existsSync(tmpFile + '.bak'), '坏文件应备份');
fs.unlinkSync(tmpFile + '.bak');
console.log('✓ 测试6 损坏自动恢复+备份');

// ---------- 测试 7：高频词统计 ----------
function highFreqWords(texts) {
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
assert.deepStrictEqual(highFreqWords('后辈后辈后辈后辈后辈后辈哼哼哼'), ['后辈', '哼']);
assert.deepStrictEqual(highFreqWords('后辈后辈后辈'), []);
console.log('✓ 测试7 高频词限制');

console.log('\n全部测试通过 ✅');
