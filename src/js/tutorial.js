'use strict';
// 新手教程（青湾地图）：左上角的引导卡片按步骤给出目标与操作说明，自动检测完成情况；
// 相关按钮闪烁提示，地图上高亮目标位置。进度随存档保存，可跳过任意一步。
(function (CM) {
  const U = CM.U, h = U.h, M = CM.Metro;
  const ic = function (n, s) { return CM.icon(n, s); };
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };
  let ui = null, g = null, el = null, idx = -1, ctx = {}, doneAt = 0, target = null, mini = false, lastCheck = 0;
  // 指示气泡（v2.1 第二轮）：当前小动作的一句话，带箭头指向要点的按钮或地图位置；按钮外另加闪动的圈
  let tip = null, ring = null, subIdx = 0;
  // 回看（v2.1 玩家反馈）：返回上一步或打开已完成的步骤时不自动跳走；新完成的步骤约 2.6 秒后继续，
  // 鼠标停在卡片上时暂停倒计时，也可关闭「自动下一步」（随进度保存）
  let review = false, hover = false, listOpen = false;
  const AUTO_MS = 2600;
  const autoOn = function () { return !!g.tutorial && g.tutorial.auto === true; };

  const place = function (name) { const p = CM.DATA.places.find(function (q) { return q[0] === name; }); return p ? { x: p[1], y: p[2] } : { x: 0, y: 0 }; };
  const absMin = function (c) { return (U.ymIndex(c.y, c.m) * 31 + c.d) * 1440 + c.minute; };
  const nets = function () { return g.draft ? [g.draft.net, g.net] : [g.net]; };
  const near = function (net, p, r) { for (const id in net.stations) { const s = net.stations[id]; if (U.dist(s.x, s.y, p.x, p.y) <= r) return id; } return null; };
  const lineStations = function (net, lid) { const tp = M.lineTopo(net, lid); return (tp.stations || []).map(function (sid) { return net.stations[sid]; }).filter(Boolean); };
  const NORTH = ['oldtown', 'xiguan', 'dongguan', 'beizhan', 'eastind'], SOUTH = ['nanan', 'tech'];
  const regionId = function (s) { const rg = g.city.regionAt(s.x, s.y); return rg ? rg.id : ''; };
  // 说明中的 {操作} 换成当前键位（设置中可自定义；未设置时写「对应按键」）
  const keyText = function (s) { return String(s).replace(/\{([\w.]+)\}/g, function (m, id) { return (CM.Keys && CM.Keys.hint(id)) || '对应按键'; }); };

  // 步骤：title 目标、body 一句话说明、hint 小提示、hl 地图高亮、check 完成条件、manual 需点击按钮继续。
  // sub（v2.1 第二轮重新设计：新手不知道在哪里操作）：把一步拆成几个小动作，每个一句话；
  // el 返回要点的按钮（气泡指向它并闪动外圈），at 返回要点的地图位置（气泡指向地图），done 判断该动作是否已完成。
  // 当前动作 = 第一个未完成的动作，随玩家的实际操作前进或退回
  const T = function () { return ui.tools; };
  const chainOn = function () { return !!T().chain; };
  const stationAt = function (name) { const p = place(name); for (const n of nets()) { const id = near(n, p, 2.4); if (id) { const s = n.stations[id]; return { x: s.x, y: s.y }; } } return p; };
  const midStation = function () { for (const lid in g.net.lines) { const ss = lineStations(g.net, lid); if (ss.length) { const s = ss[Math.floor(ss.length / 2)]; return { x: s.x, y: s.y }; } } return null; };
  const confirmBtn = function () { return g.draft ? ui.draftbar.querySelector('.btn.primary') : null; };
  const regionCenter = function (id) { const rg = g.city.regions.find(function (r) { return r.id === id; }); return rg ? { x: rg.cx, y: rg.cy } : null; };
  const draftHas = function (fn) { if (!g.draft) return false; const n = g.draft.net; for (const id in n.stations) if (!g.net.stations[id] && fn(n.stations[id], id, n)) return true; return false; };
  const lineDone = function () {
    const a = place('钟楼'), b = place('青湾站');
    return nets().some(function (n) {
      for (const lid in n.lines) { const ss = lineStations(n, lid); if (ss.length >= 4 && ss.some(function (s) { return U.dist(s.x, s.y, a.x, a.y) <= 2.4; }) && ss.some(function (s) { return U.dist(s.x, s.y, b.x, b.y) <= 2.4; })) return true; }
      return false;
    });
  };
  const riverDone = function () {
    for (const lid in g.net.lines) {
      const ids = lineStations(g.net, lid).map(regionId);
      if (ids.some(function (r) { return NORTH.indexOf(r) >= 0; }) && ids.some(function (r) { return SOUTH.indexOf(r) >= 0; })) return true;
    }
    return false;
  };
  const xferDone = function () { for (const id in g.net.stations) if (M.stationLines(g.net, id).length >= 2) return true; return false; };
  const STEPS = [
    { id: 'intro', title: '欢迎来到青湾', manual: '开始教程',
      body: '12 个小任务教你修地铁，每次只做一两个动作。',
      hint: '跟着发光的气泡点就行；右上角目录可以回看。' },
    { id: 'move', title: '移动地图',
      body: '先学会看地图。',
      hint: '按 {view.toggle} 切换 2D / 2.5D。',
      enter: function () { const c = ui.R.cam; ctx.cam0 = { x: c.cx, y: c.cy, z: c.zoom }; },
      sub: [
        { t: '按住左键拖动地图', at: function () { const c = ui.R.cam; return { x: c.cx, y: c.cy }; }, done: function () { const c = ui.R.cam, c0 = ctx.cam0; return ctx.moved || (ctx.moved = U.dist(c.cx, c.cy, c0.x, c0.y) > 3); } },
        { t: '滚动鼠标滚轮缩放', at: function () { const c = ui.R.cam; return { x: c.cx, y: c.cy }; }, done: function () { const c = ui.R.cam, c0 = ctx.cam0; return ctx.zoomed || (ctx.zoomed = Math.abs(Math.log(c.zoom / c0.z)) > 0.25); } },
      ] },
    { id: 'pop', title: '看人口在哪',
      body: '人多的地方最需要地铁。',
      hint: '颜色越深，人越多。',
      sub: [{ t: '点顶栏「人口」，查看人口密度', el: function () { return ui.metricEl('pop'); }, done: function () { return ui.layer === 'pop'; } }] },
    { id: 'station', title: '建第一座车站',
      body: '在人最多的老城建站。',
      hint: '新车站自动用附近的地名。',
      hl: function () { const p = place('钟楼'); return { kind: 'circle', x: p.x, y: p.y, r: 2.2 }; },
      enter: function () { const p = place('钟楼'); ui.R.flyTo(p.x, p.y + 1, Math.max(ui.R.cam.zoom, 22)); },
      check: function () { const p = place('钟楼'); return nets().some(function (n) { return !!near(n, p, 2.4); }); },
      sub: [
        { t: '点底部的「建站」', el: function () { return ui.tbtns.station; }, done: function () { return T().tool === 'station'; } },
        { t: '在亮圈里点一下', at: function () { return place('钟楼'); } },
      ] },
    { id: 'line', title: '画第一条线路',
      body: '从钟楼站画到北面的青湾站。',
      hint: '站距 2–4 格最合适；右键结束绘线。',
      hl: function () { const a = place('钟楼'), b = place('青湾站'); return { kind: 'multi', items: [{ kind: 'circle', x: a.x, y: a.y, r: 2.2 }, { kind: 'circle', x: b.x, y: b.y, r: 2.2 }] }; },
      enter: function () { const a = place('钟楼'), b = place('青湾站'); ui.fitBox(Math.min(a.x, b.x) - 3, Math.min(a.y, b.y) - 3, Math.max(a.x, b.x) + 3, Math.max(a.y, b.y) + 3, 24); },
      check: lineDone,
      sub: [
        { t: '点底部的「绘线」', el: function () { return ui.tbtns.line; }, done: function () { return T().tool === 'line'; } },
        { t: '先点钟楼站', at: function () { return stationAt('钟楼'); }, done: function () { const a = place('钟楼'); return chainOn() || nets().some(function (n) { for (const lid in n.lines) if (lineStations(n, lid).some(function (s) { return U.dist(s.x, s.y, a.x, a.y) <= 2.4; })) return true; return false; }); } },
        { t: '一路点空地放车站，最后点青湾站', at: function () { return place('青湾站'); } },
      ] },
    { id: 'confirm', title: '确认建设',
      body: '草案确认后线路才会开通。',
      hint: '确认前可以撤销或放弃，不花钱。',
      check: function () { for (const lid in g.net.lines) if (lineStations(g.net, lid).length >= 4) return g.compiled.routes.length > 0; return false; },
      sub: [{ t: '点「确认建设」', el: confirmBtn }] },
    { id: 'run', title: '让时间走起来',
      body: '开动时间，看列车运行。',
      hint: '早高峰 7–9 点乘客最多。',
      enter: function () { if (g.tutorial.runT0 == null) g.tutorial.runT0 = absMin(g.clock); ctx.t0 = g.tutorial.runT0; },   // 计时起点随进度保存，读档后不重新计时
      check: function () { return absMin(g.clock) - ctx.t0 >= 180; },
      sub: [
        { t: '点 ▶ 开始', el: function () { return ui.tbtns.pause; }, done: function () { return g.speed > 0; } },
        { t: '再点 3× 加速', el: function () { return ui.tbtns.s2; }, done: function () { return g.speed >= 2 || ctx.fast || (ctx.fast = absMin(g.clock) - ctx.t0 >= 60); } },
        { t: '等时间走过 3 小时' },
      ] },
    { id: 'inspect', title: '查看车站客流',
      body: '车站和线路都能点开看客流。',
      check: function () { return ui.topIs(['station', 'line']); },
      sub: [{ t: '点一座车站', at: midStation }] },
    { id: 'river', title: '跨过青江',
      body: '南岸新区在发展，把地铁修过江。',
      hint: '跨江段建高架就是桥，建地下就是隧道。',
      hl: function () { const k = g.city.regions.findIndex(function (r) { return r.id === 'nanan'; }); const rg = g.city.regions[k]; return k >= 0 ? { kind: 'region', region: k, lx: rg.cx, ly: rg.cy, label: '南岸新区' } : null; },
      enter: function () { ui.fitBox(10, 12, 30, 30, 18); },
      check: riverDone,
      sub: [
        { t: '点底部的「绘线」', el: function () { return ui.tbtns.line; }, done: function () { return T().tool === 'line' || chainOn(); } },
        { t: '从北岸车站出发，点到南岸亮区', at: function () { return regionCenter('nanan'); }, done: function () { return draftHas(function (s) { return SOUTH.indexOf(regionId(s)) >= 0; }); } },
        { t: '右键结束，再点「确认建设」', el: confirmBtn },
      ] },
    { id: 'xfer', title: '建一座换乘站',
      body: '两条线共用一座车站，就是换乘站。',
      hint: '换乘站会显示 ⇄ 标志。',
      check: xferDone,
      sub: [
        { t: '点底部的「绘线」', el: function () { return ui.tbtns.line; }, done: function () { return T().tool === 'line' || chainOn(); } },
        { t: '从空地开始，中途点这座已有车站', at: midStation, done: function () { if (!g.draft) return false; const n = g.draft.net; for (const id in n.stations) if (M.stationLines(n, id).length >= 2) return true; return false; } },
        { t: '右键结束，再点「确认建设」', el: confirmBtn },
      ] },
    { id: 'layers', title: '看地铁的效果',
      body: '地铁开通后，沿线道路会变畅通。',
      hint: '颜色越红越堵。',
      sub: [{ t: '点顶栏「拥堵指数」，查看道路拥堵', el: function () { return ui.metricEl('cong'); }, done: function () { return ui.layer === 'cong' || ui.layer === 'flow'; } }] },
    { id: 'follow', title: '跟随一列列车',
      body: '跟着列车逛逛青湾。',
      hint: '按 Esc 退出跟随；列车 06:00–24:00 运行。',
      enter: function () { if (ui.layer !== 'none') ui.setLayer('none'); },
      check: function () { return !!g.tutorial.followed; },   // 按本进度判定，不受其他进度的跟随影响
      sub: [{ t: '点一列行驶中的列车', at: midStation }] },
    { id: 'netmap', title: '线路示意图',
      body: '像地铁站里挂的线路图。',
      hint: '可以缩放，也能导出图片。',
      check: function () { return !!(CM.NetMap && CM.NetMap.isOpen()); },
      sub: [{ t: '点左下「线路示意图」', el: function () { return CM.Follow && CM.Follow.active() ? null : ui.tbtns.netmap; } }] },
    // 进阶小课（v2.1 玩家反馈：治堵、接驳比例与票价以前只能靠玩家互相教）：可跳过，不计入 12 个任务
    { id: 'adv-cong', adv: true, title: '进阶：找出拥堵片区',
      body: '在最堵的地方修地铁，效果最好。',
      hint: '更多做法：菜单 → 新手指南。',
      enter: function () { ui.R.layerOpt.cong = 'am'; },
      check: function () { return ui.layer === 'cong' && ui.topIs(['zone']); },
      sub: [
        { t: '点顶栏「拥堵指数」，查看道路拥堵', el: function () { return ui.metricEl('cong'); }, done: function () { return ui.layer === 'cong'; } },
        { t: '点红色道路旁的片区' },
      ] },
    { id: 'adv-fac', adv: true, title: '进阶：设施接驳',
      body: '火车站、医院等设施坐地铁去的人越多越好。',
      hint: '详情里会告诉你怎么提高。',
      check: function () { return ui.topIs(['facility']); },
      sub: [
        { t: '点左下「图层」', el: function () { return ui.layerBtn; }, done: function () { return ui.layerPanelOpen() || ui.layer === 'fac'; } },
        { t: '点「设施出行需求」', el: function () { return ui.dockBtns.fac; }, done: function () { return ui.layer === 'fac'; } },
        { t: '点火车站或医院的圆点' },
      ] },
    { id: 'adv-fare', adv: true, title: '进阶：票价',
      body: '票价越高收入越多，乘客越少。',
      hint: '在「票价」里调好后点「应用新票价」。',
      check: function () { return ui.topIs(['finance']); },
      sub: [{ t: '点顶栏的「资金」', el: function () { return ui.pills && ui.pills.money ? ui.pills.money.el : null; } }] },
    // 经济小知识（可跳过、可回看，不计入 12 个任务；青湾为自由建造，不实际发行债券）
    { id: 'money', title: '小知识：经营挑战的财政', info: true,
      body: '正式城市要自己管钱：拨款和票款进账，建设和运营花钱，缺钱可以发债。',
      hint: '点「图文说明」看详情。' },
    { id: 'done', title: '教程完成！', final: true,
      body: '基本操作都学会了，去广州开始正式游戏吧。',
      hint: '不会时打开「菜单 → 新手指南」。' },
  ];
  const TASKS = STEPS.filter(function (s) { return !s.manual && !s.final && !s.info && !s.adv; }).length;   // 不含欢迎、进阶、小知识与完成
  const ADV = STEPS.filter(function (s) { return s.adv; });
  // 加入进阶小课之前的步骤顺序：旧进度只记了序号，按此换算成步骤 id（新进度同时保存 stepId）
  const OLD_ORDER = ['intro', 'move', 'pop', 'station', 'line', 'confirm', 'run', 'inspect', 'river', 'xfer', 'layers', 'follow', 'netmap', 'money', 'done'];

  function setTarget(t) {
    if (target === t) return;
    if (target) target.classList.remove('coach-target');
    target = t || null;
    if (target) target.classList.add('coach-target');
  }
  function applyHL(st) {
    const R = ui.R;
    if (R.hl && R.hl.tutorial) R.setHighlight(null);
    const spec = st.hl ? st.hl() : null;
    if (spec) R.setHighlight(Object.assign({ dur: 1e9, tutorial: true }, spec));
  }
  function go(i) {
    const back = idx >= 0 && i < idx;
    idx = U.clamp(i, 0, STEPS.length - 1);
    g.tutorial.step = idx; g.tutorial.stepId = STEPS[idx].id;
    doneAt = 0; ctx = {}; listOpen = false; subIdx = 0;
    review = back || g.tutorial.done.indexOf(STEPS[idx].id) >= 0;
    const st = STEPS[idx];
    if (st.enter) st.enter();
    applyHL(st);
    if (st.final) { g.tutorial.complete = true; snd('fanfare'); }
    ui.markUnsaved(); ui.scheduleAutosave();
    render();
  }
  function complete() {
    if (doneAt) return;
    const st = STEPS[idx];
    doneAt = performance.now();
    if (g.tutorial.done.indexOf(st.id) < 0) g.tutorial.done.push(st.id);
    if (!review) snd('good');
    render();
  }
  // 步骤目录：已完成的任务打勾，点击即可回看（回看时不自动跳走）
  function stepList() {
    const box = h('div', { class: 'co-list' });
    STEPS.forEach(function (s, i) {
      if (s.manual) return;
      const done = g.tutorial.done.indexOf(s.id) >= 0;
      box.appendChild(h('button', { class: 'co-li' + (i === idx ? ' on' : '') + (done ? ' done' : ''), onclick: function () { go(i); } },
        h('span', { class: 'co-li-n' }, done ? ic('check', 12) : (s.info ? 'i' : s.final ? '★' : s.adv ? '+' : String(i))), h('span', null, s.title)));
    });
    return box;
  }
  function render() {
    if (!el) return;
    const st = STEPS[idx], n = idx, ok = !!doneAt;
    el.className = 'hud glass' + (mini ? ' mini' : '') + (ok ? ' ok' : '');
    el.innerHTML = '';
    const pct = Math.round(Math.min(n, TASKS + 1) / (TASKS + 1) * 100);
    const head = h('div', { class: 'co-head' },
      h('span', { class: 'co-badge' }, ic('help', 14), '新手教程'),
      h('span', { class: 'co-step' }, st.final ? '全部完成' : (st.info ? '小知识 · 可跳过' : (st.adv ? '进阶 ' + (ADV.indexOf(st) + 1) + ' / ' + ADV.length + ' · 可跳过' : (n === 0 ? '共 ' + TASKS + ' 个任务' : '任务 ' + n + ' / ' + TASKS)))),
      h('span', { class: 'grow' }),
      mini ? null : h('button', { class: 'co-auto' + (autoOn() ? ' on' : ''), 'aria-pressed': autoOn() ? 'true' : 'false', 'data-tip': autoOn() ? '完成后约 3 秒自动下一步，点击改为手动' : '手动：完成后点「下一步」，点击恢复自动', onclick: function () { g.tutorial.auto = !autoOn(); ui.markUnsaved(); render(); } }, autoOn() ? '自动' : '手动'),
      mini ? null : h('button', { class: 'iconbtn' + (listOpen ? ' on' : ''), 'data-tip': '教程目录：回看任意一步', onclick: function () { listOpen = !listOpen; render(); } }, ic('tasks')),
      h('button', { class: 'iconbtn', 'data-tip': mini ? '展开' : '收起', onclick: function () { mini = !mini; render(); } }, ic(mini ? 'expand' : 'minus')));
    el.append(head, h('div', { class: 'co-bar' }, h('i', { style: { width: pct + '%' } })));
    if (mini) { el.appendChild(h('div', { class: 'co-mini' }, ok ? '✓ ' : '', st.title)); syncLayout(); return; }
    if (listOpen) { el.appendChild(stepList()); syncLayout(); return; }
    el.appendChild(h('div', { class: 'co-title' }, ok ? h('span', { class: 'co-check' }, ic('check', 16)) : null, st.title, review && !st.manual && !st.final ? h('span', { class: 'co-review' }, '回看') : null));
    el.appendChild(h('div', { class: 'co-body' }, keyText(st.body)));
    // 小动作清单：已完成的打勾，当前动作高亮（气泡同时指向要点的位置）
    if (st.sub && !st.final) {
      const cur = ok ? st.sub.length : subIdx;
      el.appendChild(h('ol', { class: 'co-subs' }, st.sub.map(function (s, k) {
        return h('li', { class: k < cur ? 'done' : (k === cur ? 'on' : '') }, h('span', { class: 'co-sub-n' }, k < cur ? ic('check', 12) : String(k + 1)), h('span', null, keyText(s.t)));
      })));
    }
    if (st.hint && !ok) el.appendChild(h('div', { class: 'co-hint' }, ic('info', 14), h('span', null, keyText(st.hint))));
    const acts = h('div', { class: 'co-acts' });
    if (st.final) {
      acts.append(
        h('button', { class: 'btn sm ghost', onclick: function () { ui.showEconGuide(); } }, '回看财政知识'),
        h('button', { class: 'btn sm', onclick: function () { Tutorial.detach(); ui.toast('教程已完成，可以继续在青湾自由建设', 'good'); } }, '继续在青湾建设'),
        h('button', { class: 'btn sm primary', onclick: function () { ui.backToMenu(function () { ui.showMapSelect('gz'); }); } }, '去广州开始游戏', ic('chev', 14)));
    } else if (st.info) {
      acts.append(h('button', { class: 'btn sm ghost', onclick: function () { go(idx - 1); } }, '上一步'), h('span', { class: 'grow' }), h('button', { class: 'btn sm ghost', onclick: function () { go(idx + 1); } }, '跳过'),
        h('button', { class: 'btn sm primary', onclick: function () { ui.showEconGuide(function () { if (STEPS[idx] === st) go(idx + 1); }); } }, '图文说明', ic('chev', 14)));
    } else if (st.manual) {
      acts.append(h('button', { class: 'btn sm ghost', onclick: function () { Tutorial.detach(true); } }, '退出教程'), h('span', { class: 'grow' }), h('button', { class: 'btn sm primary', onclick: function () { go(idx + 1); } }, st.manual, ic('chev', 14)));
    } else {
      // 新完成的步骤：「下一步」按钮上显示自动继续的倒计时条；回看或手动模式只显示按钮
      const counting = ok && !review && autoOn();
      acts.append.apply(acts, [
        h('button', { class: 'btn sm ghost', disabled: idx <= 1 ? true : null, onclick: function () { go(idx - 1); } }, '上一步'),
        h('span', { class: 'grow' }),
        ok ? h('span', { class: 'co-done' }, review ? '已完成' : '完成！') : h('button', { class: 'btn sm ghost', onclick: function () { go(idx + 1); } }, review ? '下一步' : '跳过'),
        ok ? h('button', { class: 'btn sm primary co-next' + (counting ? ' counting' : ''), style: counting ? { '--co-auto': AUTO_MS + 'ms' } : null, onclick: function () { go(idx + 1); } }, '下一步', ic('chev', 14), counting ? h('i', { class: 'co-countdown' }) : null) : null].filter(Boolean));
    }
    el.appendChild(acts);
    syncLayout();
  }
  // 指示气泡：按钮在左侧栏时放在按钮右边，在画面下半部时放在上方，否则放在下方；地图位置放在其上方
  function placeTip(sub) {
    const hide = !sub || ui.blocking() || (CM.NetMap && CM.NetMap.isOpen()) || (CM.Follow && CM.Follow.active());
    let rect = null, pt = null;
    if (!hide) {
      const e = sub.el ? sub.el() : null;
      if (e && e.isConnected) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) rect = r; }
      if (!rect && sub.at) { const p = sub.at(); if (p) pt = ui.R.P(p.x, p.y, 0, {}); }
    }
    if (hide || (!rect && !pt)) { if (tip) { tip.classList.add('off'); ring.classList.add('off'); } return; }
    if (!tip) { ring = h('div', { id: 'coachRing', class: 'off' }); tip = h('div', { id: 'coachTip', class: 'off' }); document.body.append(ring, tip); }
    const txt = keyText(sub.t);
    if (tip._t !== txt) { tip._t = txt; tip.innerHTML = ''; tip.append(ic('cursor', 15), h('span', null, txt)); if (CM.I18n) CM.I18n.localize(tip); }
    tip.classList.remove('off');
    const W = window.innerWidth, H = window.innerHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let x, y, side, ax, ay;
    if (rect) {
      ring.classList.remove('off');
      Object.assign(ring.style, { left: (rect.left - 5) + 'px', top: (rect.top - 5) + 'px', width: (rect.width + 10) + 'px', height: (rect.height + 10) + 'px' });
      ax = rect.left + rect.width / 2; ay = rect.top + rect.height / 2;
      if (rect.left < 100 && rect.width < 90) { side = 'right'; x = rect.right + 16; y = ay - th / 2; }
      else if (ay > H * 0.55) { side = 'above'; x = ax - tw / 2; y = rect.top - th - 16; }
      else { side = 'below'; x = ax - tw / 2; y = rect.bottom + 16; }
    } else {
      ring.classList.add('off');
      ax = pt.x; ay = pt.y; side = 'above'; x = ax - tw / 2; y = ay - th - 22;
      if (y < 80) { side = 'below'; y = ay + 22; }
    }
    const l = U.clamp(x, 8, W - tw - 8), t = U.clamp(y, 8, H - th - 8);
    tip.className = side;
    tip.style.left = l + 'px'; tip.style.top = t + 'px';
    tip.style.setProperty('--ax', U.clamp(ax - l, 14, tw - 14) + 'px'); tip.style.setProperty('--ay', U.clamp(ay - t, 12, th - 12) + 'px');
  }
  // 引导卡片与图层图例共用左上角：图例排在卡片下方
  function syncLayout() {
    if (!el) return;
    requestAnimationFrame(function () { if (el) document.documentElement.style.setProperty('--coach-h', el.offsetHeight + 'px'); });
  }

  const Tutorial = {
    refreshKeys: function () { if (el) { render(); if (ui && ui.queueLayout) ui.queueLayout(); } },
    attach: function (u, game) {
      ui = u; g = game;
      if (!g.tutorial) return;
      Tutorial.detach();
      ui = u; g = game;
      // 已完成或主动退出的教程不再显示（complete 只在到达完成页或退出时设置；1.7 前完成的存档序号较小，同样适用）
      if (g.tutorial.complete) {
        ui.toast('教程已完成，可以继续在青湾自由建设', 'info');
        return;
      }
      el = h('aside', { id: 'coach' });
      el.addEventListener('pointerenter', function () { hover = true; el.classList.add('hold'); });
      el.addEventListener('pointerleave', function () { hover = false; el.classList.remove('hold'); });
      document.getElementById('app').appendChild(el);
      document.body.classList.add('has-coach');
      if (ui.placeFeed) ui.placeFeed();
      mini = false;
      const sid = g.tutorial.stepId || OLD_ORDER[g.tutorial.step || 0];
      const at = STEPS.findIndex(function (s) { return s.id === sid; });
      idx = -1; go(at >= 0 ? at : (g.tutorial.step || 0));
    },
    // quit：玩家主动退出教程（保留城市，可继续自由建设）
    detach: function (quit) {
      if (quit && g && g.tutorial) { g.tutorial.complete = true; g.tutorial.step = STEPS.length - 1; if (ui) { ui.markUnsaved(); ui.toast('已退出教程，可以继续在青湾自由建设', 'info'); } }
      setTarget(null);
      if (ui && ui.R.hl && ui.R.hl.tutorial) ui.R.setHighlight(null);
      if (el) { el.remove(); el = null; }
      if (tip) { tip.remove(); ring.remove(); tip = ring = null; }
      document.body.classList.remove('has-coach');
      if (ui && ui.placeFeed) ui.placeFeed();
      idx = -1;
    },
    active: function () { return !!el; },
    tick: function (dt) {
      if (!el || !g || CM.game !== g || idx < 0) return;
      const st = STEPS[idx];
      const now = performance.now();
      // 当前小动作：要点的按钮闪烁并加外圈，气泡指向按钮或地图位置（打开全屏界面时隐藏）
      const sub = !doneAt && st.sub ? st.sub[subIdx] : null;
      setTarget(sub && sub.el && !ui.blocking() ? sub.el() : null);
      placeTip(sub);
      if (doneAt) {
        // 鼠标停在卡片上、打开目录或全屏界面时暂停倒计时；回看与手动模式不自动跳走
        if (hover || listOpen || ui.blocking()) doneAt += (dt || 0) * 1000;
        else if (!review && autoOn() && now - doneAt > AUTO_MS) go(idx + 1);
        return;
      }
      if (now - lastCheck < 250) return;
      lastCheck = now;
      const safe = function (f) { try { return !!f(); } catch (e) { return false; } };
      if (st.sub) {
        // 进度取已完成的最后一个小动作之后（玩家切回别的工具时不退回已做过的动作）
        let k = 0; for (let i = st.sub.length - 1; i >= 0; i--) if (st.sub[i].done && safe(st.sub[i].done)) { k = i + 1; break; }
        if (k > 0 && k === st.sub.length && !st.check && !st.sub.every(function (s) { return safe(s.done); })) k = st.sub.findIndex(function (s) { return !safe(s.done); });
        if (k !== subIdx) { subIdx = k; render(); }
      }
      // 没有单独完成条件的步骤：全部小动作完成即完成
      const check = st.check || (st.sub && st.sub.every(function (s) { return s.done; }) ? function () { return st.sub.every(function (s) { return safe(s.done); }); } : null);
      if (check && safe(check)) complete();
    },
  };
  CM.Tutorial = Tutorial;
})(window.CM);
