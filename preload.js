// 预加载脚本：向渲染进程暴露安全的 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  sysStats: () => ipcRenderer.invoke('sys-stats'),
  foregroundApp: () => ipcRenderer.invoke('foreground-app'),
  moveTo: (x, y) => ipcRenderer.invoke('move-to', x, y),
  resizeTo: (w, h) => ipcRenderer.invoke('resize-to', w, h),
  resetPosition: () => ipcRenderer.invoke('reset-position'),
  setOnTop: (flag) => ipcRenderer.invoke('set-ontop', flag),
  getOnTop: () => ipcRenderer.invoke('get-ontop'),
  quit: () => ipcRenderer.invoke('quit'),
  // 形象图片：读取「形象」文件夹里的图片
  getCharacterImage: () => ipcRenderer.invoke('character-image'),
  getCharacterImages: () => ipcRenderer.invoke('character-images'),
  onCharacterUpdated: (cb) => { ipcRenderer.on('character-updated', () => cb()); },
  // 右键菜单（原生）
  showContextMenu: (state) => ipcRenderer.invoke('show-context-menu', state),
  onMenuAction: (cb) => { ipcRenderer.on('menu-action', (_e, data) => cb(data)); },
  // AI 对话（大模型）
  llmChat: (messages) => ipcRenderer.invoke('llm-chat', messages),
  llmSay: (prompt) => ipcRenderer.invoke('llm-say', prompt),
  getLlmConfig: () => ipcRenderer.invoke('get-llm-config'),
  // 桌面快捷方式 & 开机自启
  toggleAutoStart: () => ipcRenderer.invoke('toggle-autostart'),
  createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),
  // 记忆系统
  getMemory: () => ipcRenderer.invoke('get-memory'),
  saveMemory: (section, value) => ipcRenderer.invoke('save-memory', section, value),
  addRecent: (entry) => ipcRenderer.invoke('add-recent', entry),
  deleteRecent: (index) => ipcRenderer.invoke('delete-recent', index),
  addMilestone: (m) => ipcRenderer.invoke('add-milestone', m),
  deleteMilestone: (index) => ipcRenderer.invoke('delete-milestone', index),
  clearMemory: (section) => ipcRenderer.invoke('clear-memory', section),
  // 亲密度与关系
  dailyRitual: () => ipcRenderer.invoke('daily-ritual'),
  addIntimacy: (category, amount) => ipcRenderer.invoke('add-intimacy', category, amount),
  getRelationship: () => ipcRenderer.invoke('get-relationship'),
  // 情感引擎
  getEmotion: () => ipcRenderer.invoke('get-emotion'),
  emotionEvent: (type, detail) => ipcRenderer.invoke('emotion-event', type, detail),
  // 约定与回访
  addFollowup: (text) => ipcRenderer.invoke('add-followup', text)
});
