'use strict';
// 设置：主题、界面大小、色盲辅助、地图标注、交通动画、声音与三路音量、自动保存；本地保存并即时生效。
(function (CM) {
  const KEY = 'cm1.settings';
  const DEF = {
    language: 'zh-CN',    // 仅切换显示语言，不改地图、模拟与存档中的原文
    lighting: true, // Directional light for Canvas ground and buildings.
    theme: 'auto',        // light | dark | auto（跟随系统）
    uiScale: 1,           // 界面大小
    labels: 'all',        // 地图标注：all 全部 | stations 仅车站 | none 关闭
  fps: 'vsync',         // 帧率上限：'vsync' 跟随显示器刷新率 | 30 | 60 | 90 | 120
    colorBlind: false,    // 色盲辅助配色及非颜色识别提示，只影响显示
    agents: true,         // 车辆、行人与列车动画
    sound: true, volume: 0.6,   // 总开关与总音量
    trainVol: 0.7, ambVol: 0.6, // 列车音效、城市环境音（v2.0）
    autosave: true,
    nightFast: true, peakSlow: false, curveMode: 'smooth',
    grid: false, gridSnap: true,  // 视图工具及设置「游戏」页中的网格吸附
    keys: {},             // 自定义物理键位
    recentColors: [],      // 最近使用的自定义线路颜色
  };
  let cur = Object.assign({}, DEF);
  // 桌面版的偏好设置由宿主保存为本地文件，页面仍通过同一个同步接口读写
  const LS = (window.CM && CM.DESKTOP) ? CM.DESKTOP.localStorage : {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  try {
    const s = JSON.parse(LS.get(KEY) || 'null');
    if (s) {
      for (const k in DEF) if (s[k] !== undefined) cur[k] = s[k];
      // 旧版的两个标注开关合并为一项
      if (s.labels === undefined && (s.stationLabels === false || s.mapLabels === false)) cur.labels = s.stationLabels === false ? 'none' : 'stations';
    } else {
      const t = LS.get('cm1.theme'); if (t === 'light' || t === 'dark') cur.theme = t;
      const so = JSON.parse(LS.get('cm1.sound') || 'null'); if (so) { cur.sound = so.enabled !== false; if (isFinite(so.volume)) cur.volume = so.volume; }
    }
  } catch (e) { /* 存储不可用时使用默认值 */ }
  cur.colorBlind = cur.colorBlind === true;
  if (!['zh-CN', 'zh-TW', 'en'].includes(cur.language)) cur.language = 'zh-CN';
  cur.fps = normFps(cur.fps);
  const recent = function (v) { return Array.isArray(v) ? v.filter(function (c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }).map(function (c) { return c.toLowerCase(); }).filter(function (c, i, a) { return a.indexOf(c) === i; }).slice(0, 8) : []; };
  cur.recentColors = recent(cur.recentColors);
  if (!cur.keys || typeof cur.keys !== 'object' || Array.isArray(cur.keys)) cur.keys = {};
  const subs = [];
  // 帧率上限：'vsync' 跟随显示器刷新率，其余存整数字符串
  function normFps(v) {
    if (v === 'vsync') return v;
    const n = Math.round(Number(v));
    return n >= 24 && n <= 1000 ? String(n) : 'vsync';
  }
  const FPS_PRESETS = [30, 60, 90, 120, 144, 165, 240];
  // 档位候选：rAF 超不过刷新率，高于刷新率的档位没有意义；60 的整数倍之外再补刷新率的整数分频，
  // 那些档位每帧间隔一致，不会长短帧交替（144Hz 上选 120 就会交替，选 72/48 则不会）
  function fpsChoices(hz, cur) {
    const out = ['vsync'], seen = { vsync: 1 };
    const add = function (v) {
      v = Math.round(v);
      if (v >= 24 && v <= 1000 && !seen[v]) { seen[v] = 1; out.push(String(v)); }
    };
    FPS_PRESETS.forEach(function (v) { if (!hz || v <= hz + 1) add(v); });
    if (hz && hz % 24 === 0 && hz % 60 !== 0) for (let d = 2; d <= 4; d++) if (hz % d === 0) add(hz / d);
    add(Number(cur));
    return out.sort(function (a, b) { return a === 'vsync' ? -1 : b === 'vsync' ? 1 : Number(a) - Number(b); });
  }
  function save() { try { LS.set(KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ } }
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const mqRM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  const Settings = {
    DEF: DEF,
    get: function (k) { return cur[k]; },
    all: function () { return Object.assign({}, cur); },
    set: function (k, v) {
      if (k === 'language' && !['zh-CN', 'zh-TW', 'en'].includes(v)) v = 'zh-CN';
      if (k === 'colorBlind') v = v === true;
      if (k === 'fps') v = normFps(v);
      if (k === 'recentColors') v = recent(v);
      if (cur[k] === v) return;
      cur[k] = v; save();
      Settings.apply(k);
      for (const f of subs) { try { f(k, v); } catch (e) { console.error(e); } }
    },
    reset: function () {
      cur = Object.assign({}, DEF); save();
      Settings.apply();
      for (const k of Object.keys(DEF)) for (const f of subs) { try { f(k, cur[k]); } catch (e) { console.error(e); } }
    },
    on: function (fn) { subs.push(fn); },
    fpsChoices: fpsChoices,
    // 系统“减少动态效果”偏好（不再单独设置）
    reducedMotion: function () { return !!(mqRM && mqRM.matches); },
    resolvedTheme: function () { return cur.theme === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : cur.theme; },
    apply: function (k) {
      const root = document.documentElement;
      if (CM.I18n && (!k || k === 'language')) CM.I18n.apply(cur.language);
      if (!k || k === 'theme') { if (CM.setTheme) CM.setTheme(Settings.resolvedTheme()); else root.dataset.theme = Settings.resolvedTheme(); }
      if (CM.R && (!k || k === 'lighting')) { CM.R.clearImages(); CM.R.dropThemeStash(); CM.R.clearFacilitySprites(); CM.R.overviewStale = true; }
      if (!k || k === 'uiScale') root.style.setProperty('--uiz', String(cur.uiScale));
      if (!k || k === 'colorBlind') {
        root.dataset.colorBlind = String(cur.colorBlind);
        if (CM.R) { CM.R.heatKey = ''; CM.R.heatLayers.clear(); CM.R._cgBmp = null; CM.R.labelImage = null; }
        if (CM.Stats) CM.Stats.redraw();
        if (CM.NetMap) CM.NetMap.refresh(true);
      }
      if (k === 'theme' && cur.colorBlind && CM.NetMap) CM.NetMap.refresh(true);
      if (!k || k === 'sound' || k === 'volume') { if (CM.Sound) { CM.Sound.setEnabled(cur.sound); CM.Sound.setVolume(cur.volume); } }
      if (CM.Sound && (!k || k === 'trainVol')) CM.Sound.setTrainVolume(cur.trainVol);
      if (CM.Sound && (!k || k === 'ambVol')) CM.Sound.setAmbVolume(cur.ambVol);
      if (CM.R && (!k || k === 'labels' || k === 'agents')) { CM.R.labelsOn = cur.labels !== 'none'; CM.R.mapLabelsOn = cur.labels === 'all'; CM.R.agentsOn = cur.agents; }
    },
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (cur.theme === 'auto') Settings.apply('theme'); });
  CM.Settings = Settings;
})(window.CM);
