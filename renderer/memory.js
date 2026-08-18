// 记忆管理窗口：基础记忆 / 近期记忆 / 长期经历（纪念册）
(function () {
  'use strict';
  const api = window.petApi;
  const $ = (id) => document.getElementById(id);

  let current = null;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function load() {
    try {
      const m = await api.getMemory();
      current = m || { profile: { schemaVersion: 1, name: '', preferences: {}, importantDates: [] }, recent: { entries: [] }, milestones: { entries: [] } };
      renderProfile();
      renderRecent();
      renderMilestones();
      renderRelationship();
      loadSleepSettings();
    } catch (e) { /* ignore */ }
  }

  // ---------- 困倦设置（state-config.json 的 sleep 部分） ----------
  async function loadSleepSettings() {
    try {
      const r = await api.getStateConfig();
      const sl = (r && r.ok && r.config && r.config.sleep) || {};
      $('mem-sleep-nap').checked = !!(sl.nap && sl.nap.enabled);
      $('mem-sleep-late').checked = !!(sl.lateNight && sl.lateNight.enabled);
      $('mem-sleep-idle').checked = !!(sl.idle && sl.idle.enabled);
      $('mem-nap-start').value = (sl.nap && sl.nap.start) || '12:30';
      $('mem-nap-end').value = (sl.nap && sl.nap.end) || '14:00';
      $('mem-late-start').value = (sl.lateNight && sl.lateNight.start) || '23:30';
      $('mem-late-end').value = (sl.lateNight && sl.lateNight.end) || '06:30';
    } catch (e) { /* ignore */ }
  }

  async function saveSleepSettings() {
    const val = id => String($(id).value || '').trim();
    const sleep = {
      nap:       { enabled: $('mem-sleep-nap').checked, start: val('mem-nap-start'), end: val('mem-nap-end') },
      lateNight: { enabled: $('mem-sleep-late').checked, start: val('mem-late-start'), end: val('mem-late-end') },
      idle:      { enabled: $('mem-sleep-idle').checked, idleSeconds: 300 },
    };
    const res = await api.saveStateConfig({ sleep });
    // 通知主进程状态窗口实时应用（通过 reload 事件）
    if (res && res.ok) api.reloadStateConfig().catch(() => {});
    loadSleepSettings();
  }

  function renderRelationship() {
    api.getRelationship().then(r => {
      const box = $('mem-relationship');
      if (!box) return;
      if (!r || !r.ok) { box.textContent = '关系数据未就绪'; return; }
      const hideNum = !(window.petSettings && window.petSettings.showIntimacy);
      const curMin = r.stageMin || 0;
      const nextMin = r.nextStageMin;
      const bar = nextMin ? Math.min(100, Math.round(((r.intimacy - curMin) / (nextMin - curMin)) * 100)) : 100;
      const emo = (window.petSettings && window.petSettings.emotion) || '平静';
      const emoReason = (window.petSettings && window.petSettings.emotionReason) || '';
      box.innerHTML =
        '<div class="rel-line"><b>' + escapeHtml(r.stage || '初识后辈') + '</b>' +
        (hideNum ? '' : '（亲密 ' + r.intimacy + '）') +
        ' · 连续陪伴 ' + (r.consecutiveDays || 0) + ' 天 · 此刻心情：' + escapeHtml(emo) +
        (emoReason ? '（' + escapeHtml(emoReason) + '）' : '') + '</div>' +
        '<div class="rel-bar"><div class="rel-fill" style="width:' + bar + '%"></div></div>' +
        '<div class="rel-hint">亲密规则：每日见面+1 · 用心聊天（满2轮+1，每天最多3次）· 重要日期+5（每年一次）· 连续陪伴 7/30/100/365 天各领一次(+3/+5/+10/+20)</div>';
    }).catch(() => {});
  }

  function renderProfile() {
    const p = current.profile || {};
    $('mem-name').value = p.name || '';
    const prefs = p.preferences || {};
    $('mem-preferences').value = Object.entries(prefs).map(([k, v]) => v === true ? k : (k + ':' + v)).join(',');
    const dates = Array.isArray(p.importantDates) ? p.importantDates : [];
    $('mem-dates').value = dates.map(d => (d.label || '') + (d.date ? ',' + d.date : '')).join('\n');
  }

  function renderRecent() {
    const list = $('mem-recent-list');
    const entries = (current.recent && current.recent.entries) || [];
    list.innerHTML = '';
    if (entries.length === 0) { list.innerHTML = '<p class="mem-empty">暂无近期记忆</p>'; return; }
    entries.forEach((e, i) => {
      const d = new Date(e.ts);
      const ts = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
      const row = document.createElement('div');
      row.className = 'mem-row';
      row.innerHTML = '<span class="mem-ts">' + ts + '</span><span class="mem-text">' + escapeHtml(e.summary || '') + '</span>';
      const del = document.createElement('button');
      del.textContent = '删';
      del.className = 'mem-del';
      del.title = '删除这条';
      del.onclick = async () => { await api.deleteRecent(i); load(); };
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function renderMilestones() {
    const list = $('mem-milestone-list');
    const entries = (current.milestones && current.milestones.entries) || [];
    list.innerHTML = '';
    if (entries.length === 0) { list.innerHTML = '<p class="mem-empty">暂无纪念册条目</p>'; return; }
    entries.forEach((e, i) => {
      const d = new Date(e.ts);
      const ts = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      const row = document.createElement('div');
      row.className = 'mem-row';
      row.innerHTML = '<span class="mem-ts">' + ts + '</span><span class="mem-text"><b>' + escapeHtml(e.title || '') + '</b>' + (e.note ? ' — ' + escapeHtml(e.note) : '') + '</span>';
      const del = document.createElement('button');
      del.textContent = '删';
      del.className = 'mem-del';
      del.title = '删除这条';
      del.onclick = async () => { await api.deleteMilestone(i); load(); };
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  async function saveProfile() {
    const p = { schemaVersion: 1, name: $('mem-name').value.trim(), preferences: {}, importantDates: [] };
    $('mem-preferences').value.split(/[,，]/).map(s => s.trim()).filter(Boolean).forEach(s => {
      const i = s.indexOf(':');
      if (i > 0) p.preferences[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      else p.preferences[s] = true;
    });
    $('mem-dates').value.split('\n').map(s => s.trim()).filter(Boolean).forEach(s => {
      const i = s.lastIndexOf(',');
      p.importantDates.push(i > 0 ? { label: s.slice(0, i).trim(), date: s.slice(i + 1).trim() } : { label: s, date: '' });
    });
    const res = await api.saveMemory('profile', p);
    if (res && res.ok) load();
  }

  async function addMilestone() {
    const title = $('mem-milestone-title').value.trim();
    if (!title) return;
    await api.addMilestone({ title, note: $('mem-milestone-note').value.trim() });
    $('mem-milestone-title').value = '';
    $('mem-milestone-note').value = '';
    load();
  }

  $('memory-close').onclick = () => { $('memory-window').classList.add('hidden'); };
  $('mem-save-profile').onclick = saveProfile;
  $('mem-clear-recent').onclick = async () => { await api.clearMemory('recent'); load(); };
  $('mem-clear-milestones').onclick = async () => { await api.clearMemory('milestones'); load(); };
  $('mem-add-milestone').onclick = addMilestone;
  $('mem-save-sleep').onclick = saveSleepSettings;

  window.Memory = {
    open: (section) => {
      $('memory-window').classList.remove('hidden');
      load();
      if (section === 'sleep') {
        const panel = $('mem-sleep-nap');
        if (panel && panel.scrollIntoView) panel.closest('h4').scrollIntoView({ block: 'center' });
      }
    },
    close: () => { $('memory-window').classList.add('hidden'); },
    load,
  };
})();
