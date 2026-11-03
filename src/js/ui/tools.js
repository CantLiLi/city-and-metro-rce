'use strict';
// 地图交互与建设工具：选择、建站、绘线、修改、拆除；平移缩放与快捷键
(function (CM) {
  const AX = CM.Accessibility;
  const U = CM.U, CFG = CM.CFG, M = CM.Metro;
  const sfx = function (n) { if (CM.Sound) CM.Sound.play(n); };

  function Tools(R, ui) {
    this.R = R; this.ui = ui;
    this.tool = 'select';
    this.buildType = 'underground'; this.stationSize = 'M';
    this.lineChoice = 'new';
    this.newLineColor = null;
    this.curveMode = CM.Settings.get('curveMode') === 'pass' ? 'pass' : 'smooth';   // 绘线线形（v2.1）
    this.chain = null; this.bends = [];
    this.cursor = null; this.hover = null; this.hint = null;
    this.ptr = null; this.drag = null;
    this.keys = new Set();
    this.bind();
  }
  CM.Tools = Tools;

  Tools.prototype.game = function () { return CM.game; };
  Tools.prototype.setTool = function (t) {
    if (this.tool === t) return;
    this.cancelDrag();
    if (this.ui.closeLinePicker) this.ui.closeLinePicker();
    this.tool = t;
    this.chain = null; this.bends = []; this.drag = null; this.hint = null; this.hover = null; this.lineLock = false; this.snapPt = null;
    this.ui.setTooltip(null);
    this.ui.onToolChange(t);
  };
  // 中断未完成的拖动：恢复拖动前草案，不留下阻塞保存的 liveSnap。
  Tools.prototype.cancelDrag = function () {
    const g = this.game(), active = !!this.drag || !!(g && g.draft && g.draft.liveSnap);
    this.drag = null; this.ptr = null;
    if (g && g.draft && g.draft.liveSnap) g.endLive(false);
    return active;
  };
  Tools.prototype.net = function () { const g = this.game(); return g.draft ? g.draft.net : g.net; };
  // 草案变化（编辑、撤销、重做、放弃、确认）后校正工具状态，避免引用已不存在的车站或线路
  Tools.prototype.syncDraft = function () {
    if (!this.game()) return;
    const net = this.net();
    if (this.chain && !net.stations[this.chain]) { this.chain = null; this.bends = []; }
    if (this.ui.linePicker && this.ui.linePicker.sid !== this.chain) this.ui.closeLinePicker();
    if (this.lineChoice !== 'new' && !net.lines[this.lineChoice]) this.lineChoice = 'new';
  };

  // ---------------- 事件绑定 ----------------
  Tools.prototype.bind = function () {
    const cv = this.R.cv, self = this;
    cv.addEventListener('pointerdown', function (e) { if (self.touchDown(e)) return; self.onDown(e); });
    window.addEventListener('pointermove', function (e) { if (self.touchMove(e)) return; self.onMove(e); });
    window.addEventListener('pointerup', function (e) { if (self.touchUp(e)) return; self.onUp(e); });
    window.addEventListener('pointercancel', function (e) { if (self.touchUp(e)) return; self.cancelDrag(); });
    cv.addEventListener('wheel', function (e) { e.preventDefault(); if (!self.game()) return; const k = e.deltaMode === 1 ? 40 : 1; self.R.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * 0.0016)); }, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('dblclick', function (e) { self.onDbl(e); });
    window.addEventListener('keydown', function (e) { self.onKey(e); });
    window.addEventListener('keyup', function (e) { self.keys.delete(e.code); self.keyMods = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey }; });
    window.addEventListener('blur', function () { self.keys.clear(); self.keyMods = {}; });
    window.addEventListener('blur', function () { self.keys.clear(); self.cancelDrag(); if (self.touches) self.touches.clear(); self.pinch = null; });
  };
  // ---------------- 触屏：双指缩放与平移 ----------------
  // 第二根手指按下时进入缩放：取消单指的点击 / 拖动，按两指距离缩放、按中点平移；返回 true 表示事件已处理
  Tools.prototype.touchDown = function (e) {
    if (e.pointerType !== 'touch') return false;
    const T = this.touches || (this.touches = new Map());
    T.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (T.size < 2) return false;
    this.cancelDrag();
    this.ptr = null; this.ui.setTooltip(null);
    const p = Array.from(T.values());
    this.pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 };
    if (CM.Follow && CM.Follow.active()) CM.Follow.stop();
    return true;
  };
  Tools.prototype.touchMove = function (e) {
    const T = this.touches;
    if (e.pointerType !== 'touch' || !T || !T.has(e.pointerId)) return false;
    T.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.pinch || T.size < 2 || !this.game()) return false;
    const p = Array.from(T.values()), d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
    this.R.panBy(mx - this.pinch.mx, my - this.pinch.my);
    this.R.zoomAt(mx, my, d / this.pinch.d);
    this.pinch.d = d; this.pinch.mx = mx; this.pinch.my = my;
    return true;
  };
  Tools.prototype.touchUp = function (e) {
    const T = this.touches;
    if (e.pointerType !== 'touch' || !T) return false;
    T.delete(e.pointerId);
    if (!this.pinch) return false;
    if (T.size < 2) this.pinch = null;   // 松开一指后不再把剩下的手指当作点击
    this.ptr = null;
    return true;
  };
  Tools.prototype.onDown = function (e) {
    const g = this.game(); if (!g || this.ui.blocking()) return;
    try { if (this.R.cv.setPointerCapture) this.R.cv.setPointerCapture(e.pointerId); } catch (err) { /* 指针已失效时忽略 */ }
    this.ptr = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false, shift: e.shiftKey, alt: e.altKey, t: performance.now() };
    if (e.button === 1) { this.ptr.pan = true; e.preventDefault(); return; }
    // 延长手柄：进入绘线，拖到目标位置松开即连线（只点击则从该端点开始逐站绘制）
    const ext = e.button === 0 ? this.pickExtend(e.clientX, e.clientY) : null;
    if (ext) { this.ui.startDraw(ext.station, ext.line, false); this.ptr.extend = true; return; }
    if (e.button === 0 && this.tool === 'edit' && !g.jumping) {
      const h = this.pickHandle(e.clientX, e.clientY);
      if (h) { this.drag = h; this.drag.changed = false; g.beginLive(); this.ptr.handle = true; }
    }
  };
  Tools.prototype.onMove = function (e) {
    const g = this.game(); if (!g) return;
    const R = this.R;
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.ptr) {
      const dx = e.clientX - this.ptr.x, dy = e.clientY - this.ptr.y;
      if (!this.ptr.moved && Math.hypot(e.clientX - this.ptr.sx, e.clientY - this.ptr.sy) > (e.pointerType === 'touch' ? 10 : 4)) this.ptr.moved = true;
      if (this.drag) { this.dragTo(e.clientX, e.clientY, e.shiftKey); }
      else if (this.ptr.extend) { /* 拖动延长手柄：只更新绘线预览 */ }
      else if (this.ptr.moved || this.ptr.pan) { if (CM.Follow && CM.Follow.active()) CM.Follow.stop(); R.panBy(dx, dy); this.ptr.pan = true; }
      this.ptr.x = e.clientX; this.ptr.y = e.clientY;
    }
    if (e.target !== R.cv && !this.ptr) { this.cursorOut = true; this.hover = null; this.ui.setTooltip(null); return; }
    this.updateHover(e.clientX, e.clientY, e.shiftKey || e.altKey);
    if (e.pointerType === 'touch') this.ui.setTooltip(null);   // 触屏没有悬停：拖动地图时不显示提示
  };
  Tools.prototype.onUp = function (e) {
    const g = this.game(); const p = this.ptr; this.ptr = null;
    if (!g || !p) return;
    if (this.drag) { const ch = this.drag.changed; this.drag = null; this.snapPt = null; g.endLive(ch); if (ch) sfx('place'); return; }
    if (p.extend) { if (p.moved && this.tool === 'line' && this.chain) this.onClick(e.clientX, e.clientY, false); return; }
    if (p.pan && p.moved) return;
    if (p.orbit && p.moved) return;   // 拖动旋转结束，不当作点击
    if (p.button === 2) { this.onRight(e); return; }
    // 选择工具下点击行驶中的列车：进入跟随模式（车站优先）
    if (p.button === 0 && !p.moved && this.tool === 'select' && CM.Follow && !this.R.pickStation(e.clientX, e.clientY)) { const tr = CM.Follow.pick(e.clientX, e.clientY); if (tr) { CM.Follow.start(tr); return; } }
    if (p.button === 0 && !p.moved) this.onClick(e.clientX, e.clientY, e.shiftKey || e.altKey, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  // ---------------- 悬停与提示 ----------------
  Tools.prototype.world = function (sx, sy) { return this.R.unproject(sx, sy); };
  // 经纬网格吸附：建站、绘线（含 Shift 转弯点）与修改工具拖动时，新落点取最近的网格交叉点；点击已有车站、在轨道上插站不吸附
  Tools.prototype.snapAt = function (w) {
    if (!CM.Grid || (this.tool !== 'station' && this.tool !== 'line' && this.tool !== 'edit')) return null;
    return CM.Grid.snap(this.R, w.x, w.y);
  };
  Tools.prototype.snapWanted = function (st, seg, mod) { return !st && (!seg || (mod && this.tool === 'line')) && (this.tool === 'station' || this.tool === 'line'); };
  // 吸附后的落点：交叉点上已有车站时改为选中 / 连接该站（转弯点除外），不在同一位置重复建站
  Tools.prototype.snapPick = function (w, mod) {
    const sp = this.snapAt(w);
    if (!sp) return null;
    if (!mod) {
      // 直接按当前（草案）网络判断，不依赖上一帧的车站屏幕位置缓存
      const R = this.R, q = R.P(sp.x, sp.y, 0), net = this.net();
      let best = null, bd = 10;
      for (const id in net.stations) { const s = net.stations[id], p = R.P(s.x, s.y, 0), d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; best = id; } }
      if (!best) best = R.pickStation(q.x, q.y);
      if (best) return { st: best };
    }
    return { sp: sp };
  };
  // 地图外设施的接驳口（v2.1）：建站 / 绘线工具靠近地图边缘线上的接驳口（地图外侧也可以），或指向地图外的提示卡时，
  // 落点自动吸附到接驳口；该处已有接驳口车站时改为选中 / 连接那座车站。返回 { f, x, y, sid }
  Tools.prototype.portalPick = function (sx, sy) {
    if (this.tool !== 'station' && this.tool !== 'line') return null;
    const R = this.R, list = R._portals || [], net = this.net();
    let best = null, bd = Math.max(30, Math.min(48, R.z * 1.2));
    for (const p of list) {
      let d = Math.hypot(sx - p.sx, sy - p.sy);
      const c = p.card;
      if (c) d = Math.min(d, Math.hypot(Math.max(c.x - sx, 0, sx - c.x - c.w), Math.max(c.y - sy, 0, sy - c.y - c.h)) + 2);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    const P = CM.Fac.portal(best.f);
    let sid = null;
    for (const id in net.stations) if (CM.Fac.isPortalStation(net.stations[id], best.f)) { sid = id; break; }
    return { f: best.f, x: P.x, y: P.y, sid: sid };
  };
  // 选址检查（接驳口不受限制）
  Tools.prototype.siteCheck = function (w) { return w.portal ? { ok: true } : M.checkSite(this.game().city, w.x, w.y, this.buildType); };
  Tools.prototype.stationOpts = function (w) { const o = { size: this.stationSize, type: this.buildType }; if (w.portal) o.portal = w.portal; return o; };
  Tools.prototype.updateHover = function (sx, sy, mod) {
    const g = this.game(), R = this.R;
    let w = this.world(sx, sy);
    this.cursor = { sx: sx, sy: sy, x: w.x, y: w.y, mod: mod }; this.cursorOut = false;
    this.snapPt = null;
    const pp = !mod && !R.pickStation(sx, sy) ? this.portalPick(sx, sy) : null;
    if (pp) {
      this.hover = pp.sid ? { kind: 'station', id: pp.sid } : null;
      this.portalHover = pp.f.id;
      if (!pp.sid) { this.cursor.x = pp.x; this.cursor.y = pp.y; }
      const nm = CM.Fac.shortName(pp.f), lk = CM.Fac.extLink(pp.f, g);
      const sname = pp.sid ? this.net().stations[pp.sid].name : '';
      const tip = pp.sid ? { title: this.tool === 'line' ? (this.chain ? '连接到「' + sname + '」' : '从「' + sname + '」开始') : '接驳口车站「' + sname + '」', lines: ['在地图边缘接通' + nm] }
        : { title: '在地图边缘接通「' + nm + '」', lines: [CM.Fac.extText(pp.f) + '，点击在接驳口' + (this.tool === 'line' && this.chain ? '建站并连线' : '建站'), '接驳口车站直接服务' + nm + '的全部接驳出行，不受区域开放限制', lk && !lk.portal ? '（附近的「' + lk.st.name + '」已在步行范围内接通）' : null].filter(Boolean) };
      this.hint = tip; this.ui.setTooltip(tip, sx, sy);
      R.cv.style.cursor = 'pointer';
      return;
    }
    this.portalHover = null;
    const ext = this.ptr ? null : this.pickExtend(sx, sy);
    if (ext) {
      const net0 = this.net();
      this.hover = null;
      this.hint = { title: '延长 ' + net0.lines[ext.line].name, lines: ['拖到目标位置松开：新建车站并连线', '点击：从「' + net0.stations[ext.station].name + '」开始逐站绘制'] };
      this.ui.setTooltip(this.hint, sx, sy);
      R.cv.style.cursor = 'grab';
      return;
    }
    // 修改工具：站台方向手柄的说明
    const ph = this.tool === 'edit' && !this.ptr ? this.pickHandle(sx, sy) : null;
    if (ph && ph.kind === 'plat') {
      const L = this.net().lines[ph.line];
      this.hover = null;
      this.hint = { title: '旋转' + (L ? ' ' + L.name + ' ' : '') + '站台方向', lines: ['拖动旋转（按 5° 吸附，按住 Shift 自由旋转）', ph.set ? '双击恢复自动方向' : '当前为自动方向：随相邻轨道取顺直方向', '确认建设前都可以调整，进入草案'] };
      this.ui.setTooltip(this.hint, sx, sy); R.cv.style.cursor = 'grab';
      return;
    }
    let st = R.pickStation(sx, sy);
    let seg = st ? null : R.pickSegment(sx, sy);
    if (this.snapWanted(st, seg, mod)) {
      const r = this.snapPick(w, mod);
      if (r && r.st) { st = r.st; seg = null; }
      else if (r) { this.snapPt = r.sp; w = { x: r.sp.x, y: r.sp.y }; this.cursor.x = r.sp.x; this.cursor.y = r.sp.y; }
    }
    this.hover = st ? { kind: 'station', id: st } : (seg ? { kind: 'seg', id: seg } : null);
    let tip = null;
    const net = this.net();
    if (this.tool === 'select' || this.tool === 'edit' || this.tool === 'demolish') {
      if (st && net.stations[st]) {
        const s = net.stations[st];
        tip = { title: s.name, lines: [CFG.metro.sizeName[s.size] + ' · ' + (s.lv ? M.levelsText(M.stationLevels(net, st)) + '（天地换乘）' : CFG.metro.typeName[s.type] + '车站')] };
        if (this.tool === 'select') tip.lines.push('双击可直接改站名');
        if (this.tool === 'demolish') this.demolishTip(tip, { kind: 'station', id: st });
      } else if (seg && net.segments[seg]) {
        const sg = net.segments[seg], ln = net.lines[sg.line];
        tip = { title: (ln && ln.name ? ln.name + ' · ' : '') + net.stations[sg.a].name + '—' + net.stations[sg.b].name, lines: [CFG.metro.typeName[sg.type] + '轨道'] };
        if (this.tool === 'demolish') this.demolishTip(tip, { kind: 'seg', id: seg });
        if (this.tool === 'edit') tip.lines.push('点击选中后可拖动控制点调整线形');
      } else if (this.tool === 'select' && CM.Follow && CM.Follow.pick(sx, sy)) {
        tip = CM.Follow.describe(CM.Follow.pick(sx, sy));
      } else if (this.tool === 'select' && R.tEase < 0.5) {
        const L = R.pickLink(w.x, w.y, 0.22);
        if (L && L.name) {
          const W = g.model.weights(g.clock.minute);
          const r0 = g.model.arcVolAt(2 * L.id, W) / g.model.cap(2 * L.id), r1 = g.model.arcVolAt(2 * L.id + 1, W) / g.model.cap(2 * L.id);
          tip = { title: g.city.roadNames[L.name] || ['', '支路', '次干道', '主干道', '快速路'][L.cls] || '道路', lines: ['当前饱和度（流量/通行能力）：' + U.fmtPct(Math.max(r0, r1), 0), '点击查看道路详情'] };
        }
      }
    } else if (this.tool === 'station') {
      if (seg) tip = { title: '在轨道上插入车站', lines: ['新车站将成为该线路的一站'] };
      else if (!st) { const chk = M.checkSite(g.city, w.x, w.y, this.buildType); tip = chk.ok ? null : (this.lockTip(w, true) || { title: '不能在此建站', lines: [chk.msg], bad: true }); }
    } else if (this.tool === 'line') {
      tip = this.linePreviewTip(w, st, seg, mod);
    }
    if (!tip && !st && !seg && this.tool === 'select') tip = this.lockTip(w);
    this.hint = tip;
    this.ui.setTooltip(tip, sx, sy);
    R.cv.style.cursor = this.ptr && this.ptr.pan ? 'grabbing' : (st || seg ? 'pointer' : (this.tool === 'select' ? 'default' : 'crosshair'));
  };
  // 悬停在未开放区域（v2.2）：区域名称、预计开放（或尚待连通）的年份、这部分的面积、人口提前开放的门槛与区域说明；
  // building 为建站工具（说明开放前不能建设）
  Tools.prototype.lockTip = function (w, building) {
    const g = this.game(), city = g && g.city, c = city ? city.cellAt(w.x, w.y) : -1;
    if (c < 0 || city.landFrac[c] < 0.5 || !city.cellLocked(c)) return null;
    const k = city.lockRegion(c), rg = city.regions[k], f = city.lockState().info[k], yr = city.lockState().year[c];
    const lines = [city.lockText(c) + ' · 未开放部分约 ' + U.fmtNum(f.n * CFG.CELL_M * CFG.CELL_M / 1e6, 0) + ' km²'];
    if (yr && rg.pop && !city.regionOpen[k]) lines.push('城市人口达到约 ' + U.fmtPeople(rg.pop) + '时可能提前开放');
    if (rg.note) lines.push(rg.note.length > 64 ? rg.note.slice(0, 62) + '…' : rg.note);
    lines.push(building ? '开放前不能建站或铺设轨道，可推进时间等待开放' : (yr ? '开放后可以建站与铺设轨道' : '该区域不开放建设'));
    return { title: '🔒 ' + rg.name, lines: lines, bad: !!building };
  };
  // 拆除预览说明：实际网络变化（地图上同步高亮）
  Tools.prototype.demolishTip = function (tip, t) {
    const imp = this.ui.demolishImpact(t);
    tip.title = '拆除 ' + tip.title;
    if (imp && imp.lines.length) { for (const l of imp.lines.slice(0, 6)) tip.lines.push('· ' + l); if (imp.lines.length > 6) tip.lines.push('· 另有 ' + (imp.lines.length - 6) + ' 项变化'); }
    else tip.lines.push('· 不影响其他线路与车站');
    tip.lines.push('点击：拆除（进入草案，可撤销；确认前不生效）');
    tip.bad = true;
  };
  // 选中线路时，在线路端点显示延长手柄（选择 / 修改工具）
  Tools.prototype.extendHandles = function () {
    const g = this.game(), R = this.R, lid = this.ui.highlightLine;
    if (!g || g.jumping || !lid || (this.tool !== 'select' && this.tool !== 'edit')) return [];
    const net = this.net(), line = net.lines[lid];
    if (!line) return [];
    const tp = M.lineTopo(net, lid);
    if (tp.topo !== 'path' && tp.topo !== 'branch') return [];
    const out = [];
    for (const sid of tp.leaves) {
      const s = net.stations[sid], e = tp.adj.get(sid)[0];
      const p = M.adjCtrl(net, e.seg, sid);
      let dx = s.x - p[0], dy = s.y - p[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const q = R.P(s.x, s.y, 0), q2 = R.P(s.x + dx, s.y + dy, 0);
      let ux = q2.x - q.x, uy = q2.y - q.y; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      out.push({ kind: 'extend', station: sid, line: lid, color: AX.line(line), ox: q.x, oy: q.y, sx: q.x + ux * 28, sy: q.y + uy * 28 });
    }
    return out;
  };
  Tools.prototype.pickExtend = function (sx, sy) {
    let best = null, bd = 13;
    for (const hd of this.extendHandles()) { const d = Math.hypot(hd.sx - sx, hd.sy - sy); if (d < bd) { bd = d; best = hd; } }
    return best;
  };
  // 起点决定线路：线路端点站 → 延长该线路；其余（空地、中间站、轨道上新建的换乘站）→ 新线路。
  // 返回将使用的线路 id（'new' 为新线路）；端点同时属于多条线路时优先保留当前所选
  // 以该站为端点、可以延长的线路（普通线与支线的叶端点）
  Tools.prototype.endLines = function (sid) {
    const net = this.net();
    if (!sid || !net.stations[sid]) return [];
    return M.stationLines(net, sid).filter(function (lid) {
      const tp = M.lineTopo(net, lid);
      return (tp.topo === 'path' || tp.topo === 'branch') && tp.adj && tp.adj.get(sid) && tp.adj.get(sid).length === 1;
    });
  };
  // 端点同时属于多条线路时：优先当前选中（高亮）的线路，其次上次绘制的线路；仍有歧义时由玩家在弹出的选择框中确认
  Tools.prototype.lineForStart = function (sid) {
    const ends = this.endLines(sid);
    if (!ends.length) return 'new';
    const hl = this.ui.highlightLine;
    if (hl && ends.indexOf(hl) >= 0) return hl;
    return ends.indexOf(this.lineChoice) >= 0 ? this.lineChoice : ends[0];
  };
  Tools.prototype.lineName = function (lid) {
    const net = this.net();
    if (lid !== 'new' && net.lines[lid]) return net.lines[lid].name;
    const used = new Set(Object.values(net.lines).map(function (l) { return l.num; }));
    let n = 1; while (used.has(n)) n++;
    return n + ' 号线（新）';
  };
  Tools.prototype.nextLineColor = function (raw) {
    const net = this.net(), used = new Set(Object.values(net.lines).map(function (l) { return l.num; }));
    let n = 1; while (used.has(n)) n++;
    const cols = CM.DATA.lineColorsNice, color = this.newLineColor || cols[(n - 1) % cols.length];
    return raw ? color : AX.line({ num: n, color: color });
  };
  Tools.prototype.linePreviewTip = function (w, st, seg, mod) {
    const g = this.game(), net = this.net();
    if (!this.chain) {
      if (st) {
        const ends = this.endLines(st);
        if (ends.length >= 2) return { title: '「' + net.stations[st].name + '」是 ' + ends.length + ' 条线路的端点', lines: [ends.map(function (l) { return net.lines[l].name; }).join('、'), '点击后选择要延长的线路（也可以改为新线路）'] };
        const lid = this.lineForStart(st);
        return { title: (lid === 'new' ? '从「' + net.stations[st].name + '」开始新线路' : '延长 ' + net.lines[lid].name), lines: [lid === 'new' ? (M.stationLines(net, st).length ? '与已有线路在此换乘' : '依次点击车站或空地连线') : '从端点「' + net.stations[st].name + '」继续绘制', 'Shift+点击添加转弯点；右键结束'] };
      }
      if (seg) return { title: '在轨道上新建换乘站并开始新线路', lines: [] };
      const chk = M.checkSite(g.city, w.x, w.y, this.buildType);
      if (!chk.ok) return { title: '不能在此建站', lines: [chk.msg], bad: true };
      const c0 = g.city.cellAt(w.x, w.y), first = ['点击线路端点车站则延长该线路'];
      if (c0 >= 0 && g.city.regions[g.city.region[c0]].scenic) first.push(this.envNote(0, M.envStationFee(this.buildType, this.stationSize, g.clock.y)));
      return { title: '点击放置第一座车站（新线路）', lines: first };
    }
    const A = net.stations[this.chain];
    if (!A) return null;
    let end = [w.x, w.y], newSt = true;
    if (st) { end = [net.stations[st].x, net.stations[st].y]; newSt = false; }
    const pv = this.previewGeom(end, !mod && st ? st : null);
    const geo = pv.geo;
    let cost = pv.host ? 0 : M.trackCost(geo, this.buildType, g.clock.y);
    if (newSt && !mod && !seg) cost += M.stationCost(this.buildType, this.stationSize, g.clock.y);
    // 风景区环境保护费（v2.2）：与施工方案同一算法计入预览造价，并单独列出
    const endC = g.city.cellAt(end[0], end[1]);
    const envT = pv.host ? 0 : M.envTrackFee(geo, this.buildType, g.clock.y);
    const envS = newSt && !mod && !seg && endC >= 0 && g.city.regions[g.city.region[endC]].scenic ? M.envStationFee(this.buildType, this.stationSize, g.clock.y) : 0;
    cost += envT + envS;
    const lines = pv.host ? ['沿用 ' + (net.lines[pv.host.line] ? net.lines[pv.host.line].name : '') + ' 的既有轨道（共线运营），不另收建设费', '需要单独建轨道时，先 Shift+点击加一个转弯点']
      : ['长度 ' + U.fmtKm(geo.lenM) + (geo.waterM > 1 ? '，' + (this.buildType === 'underground' ? '越江隧道 ' : '跨江桥梁 ') + U.fmtKm(geo.waterM) : '') + ' · 约 ' + U.fmtMoney(cost)];
    let bad = false;
    if (mod) lines.unshift('松开 Shift 点击 = 连接；当前为添加转弯点');
    const ty = pv.host ? pv.host.type : this.buildType;
    if (geo.hillM > 1 && ty !== 'underground') { lines.push('经过山地风景区：仅可地下穿越'); bad = true; }
    if (envT + envS > 0) lines.push(this.envNote(envT ? geo.hillM : 0, envT + envS, envS > 0));
    if (geo.protM > 1 && ty !== 'underground') { lines.push('穿越受保护建筑：' + geo.protNames.join('、')); bad = true; }
    const toPortal = CM.Fac.isPortalStation(A) || (st && CM.Fac.isPortalStation(net.stations[st]));   // 接驳口区段可穿过尚未开放的区域
    const lockedHit = geo.locked.filter(function (l) { return !toPortal || l.open == null; });
    if (lockedHit.length) { lines.push('经过未开放区域：' + lockedHit[0].name); bad = true; }
    if (!mod && isFinite(geo.minRadiusM) && geo.minRadiusM < CFG.metro.minRadiusM) { lines.push('弯道过急：半径约 ' + Math.round(geo.minRadiusM) + ' m（最小 ' + CFG.metro.minRadiusM + ' m），可 Shift+点击加转弯点'); bad = true; }
    if (!mod && pv.turn > CFG.metro.maxTurnAtStationDeg) { lines.push('在「' + A.name + '」处转向约 ' + Math.round(pv.turn) + '°（最大 ' + CFG.metro.maxTurnAtStationDeg + '°）'); bad = true; }
    if (newSt && !mod && !st && !seg) { const chk = M.checkSite(g.city, w.x, w.y, this.buildType); if (!chk.ok) { lines.push(chk.msg); bad = true; } }
    return { title: st ? '连接到「' + net.stations[st].name + '」' : (seg ? '连接并在该轨道上新建换乘站' : (mod ? '添加转弯点' : '新建车站并连接')), lines: lines, bad: bad };
  };
  // 预览：与正式建设相同的线形规则（站台直线段、与既有线路切线连续）
  // stId：目标为既有车站时，两站之间已有其他线路的轨道且未加转弯点，则沿用该轨道（共线运营）
  Tools.prototype.coHostFor = function (stId) {
    if (!stId || this.bends.length || !this.chain) return null;
    const net = this.net(), lid = this.lineChoice !== 'new' && net.lines[this.lineChoice] ? this.lineChoice : '__new';
    return M.coHost(net, this.chain, stId, lid);
  };
  // 风景区环境保护费的预览说明：hillM 为景区内轨道长度（米），withStation 为含景区站
  Tools.prototype.envNote = function (hillM, fee, withStation) {
    const C = CFG.cost, parts = [];
    if (hillM > 1) parts.push('景区内轨道 ' + U.fmtKm(hillM) + ' 按单价的 ' + U.fmtPct(C.envTrack || 0, 0));
    if (withStation || !(hillM > 1)) parts.push('景区站按车站造价的 ' + U.fmtPct(C.envStation || 0, 0));
    return '含风景区环境保护费约 ' + U.fmtMoney(fee) + '（' + parts.join('，') + '）';
  };
  Tools.prototype.previewGeom = function (end, stId) {
    const g = this.game(), net = this.net();
    const A = net.stations[this.chain];
    const lid = this.lineChoice !== 'new' && net.lines[this.lineChoice] ? this.lineChoice : '__new';
    const stations = Object.create(net.stations);
    stations.__end = { id: '__end', x: end[0], y: end[1], type: this.buildType, size: this.stationSize, name: '' };
    const proxy = { stations: stations, segments: net.segments, lines: net.lines };
    const host = this.coHostFor(stId);
    const hp = host ? (host.pts || []).map(function (p) { return [p[0], p[1]]; }) : null;
    const seg = { id: '__tmp', line: lid, a: this.chain, b: '__end', pts: host ? (host.a === this.chain ? hp : hp.reverse()) : this.bends, type: host ? host.type : this.buildType, curve: host ? host.curve : (this.curveMode === 'smooth' ? 'smooth' : undefined) };
    const ctrl = M.segControl(proxy, seg);
    const geo = M.geomFromControl(ctrl, seg.type, g.city);
    // 车站处转角
    let turn = 0;
    const own = M.adjCtrl(proxy, seg, this.chain);
    let dx = own[0] - A.x, dy = own[1] - A.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    let best = 180, any = false;
    for (const id in net.segments) {
      const o = net.segments[id];
      if (o.line !== lid || (o.a !== this.chain && o.b !== this.chain)) continue;
      const p = M.adjCtrl(net, o, this.chain);
      let ox = p[0] - A.x, oy = p[1] - A.y; const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
      best = Math.min(best, 180 - Math.acos(U.clamp(dx * ox + dy * oy, -1, 1)) * 180 / Math.PI); any = true;
    }
    if (any) turn = best;
    return { geo: geo, turn: turn, host: host };
  };

  // ---------------- 点击 ----------------
  Tools.prototype.onClick = function (sx, sy, mod, multiKey) {
    const g = this.game(), R = this.R;
    if (g.jumping) return;
    let w = this.world(sx, sy);
    let st = R.pickStation(sx, sy);
    let seg = st ? null : R.pickSegment(sx, sy);
    // 地图外设施的接驳口：吸附到接驳口（已有接驳口车站时连接该站）
    if (!st && !mod) { const pp = this.portalPick(sx, sy); if (pp) { seg = null; if (pp.sid) st = pp.sid; else w = { x: pp.x, y: pp.y, portal: pp.f.id }; } }
    if (!w.portal && this.snapWanted(st, seg, mod)) {
      const r = this.snapPick(w, mod);
      if (r && r.st) { st = r.st; seg = null; }
      else if (r) w = { x: r.sp.x, y: r.sp.y };
    }
    const ui = this.ui;
    // 多选：Ctrl / Shift + 点击车站或轨道（选择、修改工具）
    if (multiKey && (st || seg) && (this.tool === 'select' || this.tool === 'edit')) { ui.toggleMulti(st ? 'station' : 'seg', st || seg); this.updateHover(sx, sy, mod); return; }
    switch (this.tool) {
      case 'select': {
        // 设施图层中优先选中设施圆点；其余情况下道路优先，其次是重要设施的场地（v1.9），再次是片区
        const facLayer = this.ui.layer === 'fac' || this.ui.layer === 'gap';
        const fid0 = !st && !seg && facLayer ? R.pickFacility(sx, sy, w.x, w.y) : null;
        if (st) ui.select({ kind: 'station', id: st });
        else if (seg) ui.select({ kind: 'seg', id: seg });
        else if (fid0) ui.select({ kind: 'facility', id: fid0 });
        else {
          const L = R.tEase < 0.5 ? R.pickLink(w.x, w.y, 0.22) : null;
          const fid = L && L.cls >= 2 ? null : R.pickFacility(sx, sy, w.x, w.y);
          if (L && L.cls >= 2) ui.select({ kind: 'road', id: L.id });
          else if (fid) ui.select({ kind: 'facility', id: fid });
          else {
            const c = g.city.cellAt(w.x, w.y);
            if (c >= 0 && this.ui.layer !== 'none') ui.select({ kind: 'zone', id: g.city.zoneOf(c) });
            else ui.select(null);
          }
        }
        break;
      }
      case 'station': {
        if (st) { ui.select({ kind: 'station', id: st }); break; }
        if (seg) {
          const r = g.edit((net) => M.splitSegment(net, seg, w.x, w.y, { size: this.stationSize, type: this.buildType }, g.city));
          if (r.station) ui.select({ kind: 'station', id: r.station });
          break;
        }
        const chk = this.siteCheck(w);
        if (!chk.ok) { ui.toast('不能在此建站：' + chk.msg, 'bad'); break; }
        let id = null;
        g.edit((net) => { id = M.addStation(net, w.x, w.y, this.stationOpts(w), g.city); });
        sfx('place');
        this.R.addFx('ripple', w.x, w.y);
        ui.select({ kind: 'station', id: id });
        break;
      }
      case 'line': this.lineClick(w, st, seg, mod); break;
      case 'edit': {
        if (st) ui.select({ kind: 'station', id: st });
        else if (seg) ui.select({ kind: 'seg', id: seg });
        else ui.select(null);
        break;
      }
      case 'demolish': {
        const net = this.net();
        if (st) {
          const s = net.stations[st];
          this.R.addFx('dust', s.x, s.y);
          ui.demolish({ kind: 'station', id: st });
        } else if (seg) {
          const gp = M.segGeom(net, net.segments[seg], g.city).pts;
          for (let k = 0; k < gp.length; k += Math.max(1, Math.floor(gp.length / 5))) this.R.addFx('dust', gp[k][0], gp[k][1], { small: true });
          ui.demolish({ kind: 'seg', id: seg });
        }
        break;
      }
    }
    this.updateHover(sx, sy, mod);
  };
  Tools.prototype.lineClick = function (w, st, seg, mod) {
    const g = this.game(), ui = this.ui, self = this;
    const opts = this.stationOpts(w);
    this.syncDraft();
    // 线路选择框打开时直接在地图上继续点击：按当前（默认）选择继续绘制
    if (ui.linePicker && !mod) ui.closeLinePicker();
    if (mod) {
      if (this.chain) { this.bends.push([w.x, w.y]); sfx('soft'); }
      else ui.toast('请先选择或放置起点车站，再添加转弯点', 'info');
      return;
    }
    if (!this.chain) {
      if (st) {
        // 起点自动决定线路；在工具条上明确选过、且经过该站的线路（如绘制支线）则保留
        const keep = this.lineLock && (this.lineChoice === 'new' || M.stationLines(this.net(), st).indexOf(this.lineChoice) >= 0);
        if (!keep) this.lineChoice = this.lineForStart(st);
        this.chain = st; this.bends = []; sfx('soft');
        ui.renderToolOpts();
        // 两条及以上线路在此站结束：弹出选择框，让玩家确认延长哪一条（默认项已预选，可直接继续点击）
        const ends = this.endLines(st);
        if (!keep && ends.length >= 2) ui.showLinePicker(st, ends);
        return;
      }
      if (seg) {
        const r = g.edit(function (net) { return M.splitSegment(net, seg, w.x, w.y, opts, g.city); });
        if (r.station) { this.chain = r.station; this.bends = []; if (!this.lineLock) this.lineChoice = 'new'; ui.renderToolOpts(); }
        return;
      }
      const chk = this.siteCheck(w);
      if (!chk.ok) { ui.toast('不能在此建站：' + chk.msg, 'bad'); return; }
      let id = null;
      g.edit(function (net) { id = M.addStation(net, w.x, w.y, opts, g.city); });
      sfx('place');
      this.R.addFx('ripple', w.x, w.y);
      this.chain = id; this.bends = []; this.lineChoice = 'new';
      ui.renderToolOpts();
      return;
    }
    // 再次点击当前端点：结束本次绘线
    if (st && st === this.chain) { this.endChain(); return; }
    // 已有起点：连接
    const from = this.chain, bends = this.bends.slice();
    let target = st;
    if (!st && !seg) {
      const chk = this.siteCheck(w);
      if (!chk.ok) { ui.toast('不能在此建站：' + chk.msg, 'bad'); return; }
    }
    const r = g.edit(function (net) {
      let lid = self.lineChoice;
      const created = lid === 'new' || !net.lines[lid];
      if (created) { lid = M.newLine(net); if (self.newLineColor) net.lines[lid].color = self.newLineColor; }
      let to = st;
      if (!to && seg) { const sp = M.splitSegment(net, seg, w.x, w.y, opts, g.city); to = sp.station; }
      if (!to) to = M.addStation(net, w.x, w.y, opts, g.city);
      if (to === from) return { error: '不能连接到同一车站' };
      // 共线运营：两站之间已有其他线路的轨道且没有加转弯点时，沿用该轨道的线形与建设方式
      const host = st && !bends.length ? M.coHost(net, from, to, lid) : null;
      const hp = host ? (host.pts || []).map(function (p) { return [p[0], p[1]]; }) : null;
      const segType = host ? host.type : self.buildType;
      const served = [from, to].map(function (sid) { return M.stationLines(net, sid).indexOf(lid) >= 0; });
      const res = M.addSegment(net, lid, from, to, host ? (host.a === from ? hp : hp.reverse()) : bends, segType);
      if (res.error) return res;
      if (host ? host.curve === 'smooth' : self.curveMode === 'smooth') net.segments[res.id].curve = 'smooth';
      // 天地换乘：本线首次接入一座建设方式不同的既有车站时，为本线单独设站台层（如地下站增设高架站台）
      [from, to].forEach(function (sid, i) { const s0 = net.stations[sid]; if (!served[i] && s0 && s0.type !== segType) { s0.lv = Object.assign({}, s0.lv || {}); s0.lv[lid] = segType; } });
      M.normalizeLevels(net);
      const levels = [from, to].filter(function (sid) { const s0 = net.stations[sid]; return s0 && s0.lv && s0.lv[lid]; }).map(function (sid) { const s0 = net.stations[sid]; return '「' + s0.name + '」增设' + CFG.metro.typeName[s0.lv[lid]] + '站台，与' + CFG.metro.typeName[s0.type] + '站台天地换乘'; });
      return { lid: lid, to: to, created: created, host: host && net.lines[host.line] ? net.lines[host.line].name : null, levels: levels };
    });
    if (r.error) { ui.toast(r.error, 'bad'); return; }
    if (r.host) ui.toast('与 ' + r.host + ' 共线运营：沿用这两站之间的既有轨道，不另收建设费（需要单独建轨道时，先 Shift+点击加一个转弯点）', 'info');
    if (r.levels) for (const t of r.levels) ui.toast(t, 'info');   // 各线路站台层可在车站详情中调整
    if (r.created) this.newLineColor = null;
    sfx('lay');
    {
      const net0 = this.net(), sg0 = M.findSeg(net0, r.lid, from, r.to), ln0 = net0.lines[r.lid];
      if (sg0 && ln0) this.R.addFx('trace', 0, 0, { pts: M.segGeom(net0, sg0, g.city).pts, color: AX.line(ln0), dur: 0.7 });
      const ts = net0.stations[r.to]; if (ts && !st) this.R.addFx('ripple', ts.x, ts.y, { color: ln0 ? AX.line(ln0) : null });
    }
    this.lineChoice = r.lid; target = r.to;
    this.chain = target; this.bends = [];
    const net = this.net();
    const tp = M.lineTopo(net, r.lid);
    if (tp.topo === 'loop') { ui.toast(net.lines[r.lid].name + ' 已形成环线', 'good'); this.chain = null; this.lineLock = false; }
    ui.renderToolOpts();
  };
  // 结束本次绘线（草案保留）；下次起点重新自动选择线路
  Tools.prototype.endChain = function (silent) {
    if (this.ui.closeLinePicker) this.ui.closeLinePicker();
    if (!this.chain && !this.bends.length) return false;
    this.chain = null; this.bends = []; this.lineLock = false;
    if (!silent) this.ui.toast('已结束本次绘线，草案保留', 'info');
    this.ui.renderToolOpts();
    return true;
  };
  Tools.prototype.onRight = function (e) {
    if (this.tool === 'line') this.endChain();
    // 选择工具：右键车站或线路弹出快捷操作菜单（v2.1 第二轮）
    else if (this.tool === 'select' && e && CM.Quick) CM.Quick.context(e.clientX, e.clientY);
  };
  Tools.prototype.onDbl = function (e) {
    const g = this.game(); if (!g) return;
    // 选择工具下双击车站：打开车站详情并直接编辑站名
    if (this.tool === 'select') {
      const st = this.R.pickStation(e.clientX, e.clientY);
      if (!st) return;
      const ui = this.ui; ui.select({ kind: 'station', id: st });
      requestAnimationFrame(function () { if (ui.rTitle && ui.rTitle.onclick) ui.rTitle.onclick(); });
      return;
    }
    if (this.tool !== 'edit') return;
    const h = this.pickHandle(e.clientX, e.clientY);
    if (h && h.kind === 'plat') { g.edit(function (net) { M.setPlatformDir(net, h.id, h.line, null); }); this.ui.toast('已恢复自动站台方向（随相邻轨道取顺直方向）', 'info'); return; }
    if (h && h.kind === 'bend') {
      g.edit(function (net) { const s = net.segments[h.seg], co = M.coTrackSegs(net, s); s.pts.splice(h.k, 1); M.syncCoTrack(net, s, co); });
    }
  };

  // ---------------- 修改工具：控制点 ----------------
  Tools.prototype.handles = function () {
    const g = this.game(), sel = this.ui.selection, R = this.R;
    const out = [];
    if (!g || this.tool !== 'edit' || !sel) return out;
    const net = this.net();
    const addSeg = function (sid) {
      const s = net.segments[sid]; if (!s) return;
      const ctrl = M.userControl(net, s);
      for (let k = 0; k < (s.pts || []).length; k++) { const p = R.P(s.pts[k][0], s.pts[k][1], 0); out.push({ kind: 'bend', seg: sid, k: k, sx: p.x, sy: p.y }); }
      for (let k = 0; k + 1 < ctrl.length; k++) {
        const mx = (ctrl[k][0] + ctrl[k + 1][0]) / 2, my = (ctrl[k][1] + ctrl[k + 1][1]) / 2;
        const p = R.P(mx, my, 0); out.push({ kind: 'mid', seg: sid, k: k, sx: p.x, sy: p.y });
      }
    };
    if (sel.kind === 'seg') addSeg(sel.id);
    if (sel.kind === 'station' && net.stations[sel.id]) {
      const s = net.stations[sel.id], p = R.P(s.x, s.y, 0);
      out.push({ kind: 'station', id: sel.id, sx: p.x, sy: p.y });
      for (const id in net.segments) { const sg = net.segments[id]; if (sg.a === sel.id || sg.b === sel.id) addSeg(id); }
      // 站台方向手柄（v2.1）：每条经过本站的线路一个，位于站台方向上，拖动旋转（5° 吸附，Shift 自由），双击恢复自动
      for (const lid of M.stationLines(net, sel.id)) {
        const a = M.platformDir(net, sel.id, lid); if (a == null) continue;
        const q = R.P(s.x + Math.cos(a) * 0.2, s.y + Math.sin(a) * 0.2, 0);
        let ux = q.x - p.x, uy = q.y - p.y; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
        const L = net.lines[lid];
        out.push({ kind: 'plat', id: sel.id, line: lid, set: !!(s.pd && s.pd[lid] != null), color: L ? AX.line(L) : '#1e88e5', ox: p.x, oy: p.y, sx: p.x + ux * 38, sy: p.y + uy * 38 });
      }
    }
    return out;
  };
  Tools.prototype.pickHandle = function (sx, sy) {
    let best = null, bd = 9;
    for (const h of this.handles()) { const d = Math.hypot(h.sx - sx, h.sy - sy); if (d < bd) { bd = d; best = h; } }
    if (!best) { const st = this.R.pickStation(sx, sy); if (st && this.ui.selection && this.ui.selection.kind === 'station' && this.ui.selection.id === st) best = { kind: 'station', id: st }; }
    return best ? Object.assign({}, best) : null;
  };
  Tools.prototype.dragTo = function (sx, sy, shiftKey) {
    const g = this.game(), d = this.drag;
    let w = this.world(sx, sy);
    const sp = this.snapAt(w); this.snapPt = sp;
    if (sp) w = { x: sp.x, y: sp.y };
    const shift = !!shiftKey;
    g.liveEdit(function (net) {
      if (d.kind === 'station') { const s = net.stations[d.id]; if (s) { s.x = w.x; s.y = w.y; } return; }
      if (d.kind === 'plat') {
        const s = net.stations[d.id]; if (!s) return;
        let a = Math.atan2(w.y - s.y, w.x - s.x);
        if (!shift) a = Math.round(a / (Math.PI / 36)) * (Math.PI / 36);
        M.setPlatformDir(net, d.id, d.line, a);
        return;
      }
      const s = net.segments[d.seg]; if (!s) return;
      if (!d.co) d.co = M.coTrackSegs(net, s);   // 共线轨道：拖动前记下共用这段轨道的线路，随后一起调整
      if (d.kind === 'bend') { if (s.pts[d.k]) s.pts[d.k] = [w.x, w.y]; }
      else if (d.kind === 'mid') { s.pts = s.pts || []; s.pts.splice(d.k, 0, [w.x, w.y]); d.kind = 'bend'; }
      M.syncCoTrack(net, s, d.co);
    });
    d.changed = true;
  };

  // ---------------- 键盘 ----------------
  Tools.prototype.onKey = function (e) {
    if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
    if (e.key === 'Escape' && e.repeat) { e.preventDefault(); return; }
    const g = this.game();
    const t = e.target, tag = (t && t.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) {
      this.keys.clear(); this.keyMods = {};
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // 文本框内 Esc 只取消编辑（移出焦点）；滑块、复选框、下拉框等控件上的 Esc 按全局关闭处理
      const textual = tag === 'TEXTAREA' || t.isContentEditable || (tag === 'INPUT' && /^(text|search|number|email|password|url|tel)$/i.test(t.type || 'text'));
      t.blur();
      if (textual) return;
    }
    if (!g || this.ui.blocking()) { this.keys.clear(); this.keyMods = {}; if (e.key === 'Escape') this.ui.escape(); return; }
    const esc = e.key === 'Escape';
    if (esc) {
      e.preventDefault();
      this.keys.clear(); this.keyMods = {};
      this.escape();
      return;
    }
    if (this.ui.dropdown || this.ui.searchEl) { this.keys.clear(); this.keyMods = {}; return; }
    // 线路选择框打开时：数字键选择对应线路，Esc 关闭（保留当前选择）
    if (this.ui.linePicker && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const dm = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (dm && this.ui.linePicker.pick(+dm[1] - 1)) { e.preventDefault(); return; }
    }
    // 其余按键按「设置 → 键位」中的配置执行（keys.js）
    if (e.code) this.keys.add(e.code);
    this.keyMods = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey };
    const act = CM.Keys.match(e);
    if (!act) return;
    if (e.repeat && !/^cam\.(?:up|down|left|right|zoomIn|zoomOut)$/.test(act)) { e.preventDefault(); return; }
    const ui = this.ui, R = this.R;
    switch (act) {
      case 'pause': ui.togglePause(); break;
      case 'speed1': ui.setSpeed(1); break;
      case 'speed2': ui.setSpeed(2); break;
      case 'speed3': ui.setSpeed(3); break;
      case 'speed4': ui.setSpeed(4); break;
      case 'time.peakSlow': ui.togglePeakSlow(); break;
      case 'jumpMonth': ui.jump(1); break;
      case 'jumpQuarter': ui.jump(3); break;
      case 'jumpYear': ui.jump(12); break;
      case 'tool.select': this.setTool('select'); break;
      case 'tool.station': this.setTool('station'); break;
      case 'tool.line': this.setTool('line'); break;
      case 'tool.edit': this.setTool('edit'); break;
      case 'tool.demolish': this.setTool('demolish'); break;
      case 'build.finish': if (this.tool === 'line') this.endChain(); else return; break;
      case 'build.back': if (this.tool === 'line' && this.bends.length) this.bends.pop(); else if (g.draft) ui.undo(); else return; break;
      case 'build.undo': ui.undo(); break;
      case 'build.redo': ui.redo(); break;
      case 'build.confirm': if (g.draft) ui.confirmDraft(); break;
      case 'cam.zoomIn': R.zoomAt(R.w / 2, R.h / 2, 1.3); break;
      case 'cam.zoomOut': R.zoomAt(R.w / 2, R.h / 2, 1 / 1.3); break;
      case 'cam.fit': ui.resetView(); break;
      case 'view.toggle': ui.toggleView(); break;
      case 'view.under': ui.toggleUnder(); break;
      case 'view.netmap': ui.openNetMap(); break;
      case 'view.layer': ui.cycleLayer(e.shiftKey ? -1 : 1); break;
      case 'ui.help': ui.openPage('help', null, { root: true }); break;
      case 'ui.settings': this.keys.clear(); ui.showSettings(); break;
      case 'view.grid': ui.toggleGrid(); break;
      case 'view.gridSnap': ui.toggleGridSnap(); break;
      case 'ui.search': ui.openSearch(); break;
      case 'ui.tasks': ui.openTop('tasks'); break;
      case 'ui.stats': ui.openStats(); break;
      case 'ui.save': ui.quickSave(); break;
      case 'ui.theme': ui.toggleTheme(); break;
      case 'ui.sound': ui.toggleSound(); break;
      case 'ui.hideUI': if (CM.Follow && CM.Follow.active()) CM.Follow.toggleUI(); else return; break;
      case 'cam.up': case 'cam.down': case 'cam.left': case 'cam.right': e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
  };
  Tools.prototype.escape = function () {
    const ui = this.ui;
    // 快捷操作的气泡或右键菜单打开时，Esc 只关闭它们
    if (CM.Quick && CM.Quick.busy()) { CM.Quick.close(); return; }
    // 依次收起：图层面板、搜索、右侧面板（指标、任务等；指标自带的图层随之恢复）、仍开着的图层——都不暂停；
    // 正在建设（非选择工具）时按原规则处理
    if (ui.layerPanelOpen()) { ui.toggleLayerPanel(false); return; }
    if (ui.searchEl) { ui.closeSearch(); return; }
    if (this.tool === 'select' && !ui.dropdown) {
      if (ui.stack.length && !ui.right.classList.contains('closed')) { ui.closePanel(); return; }
      if (ui.layer !== 'none') { ui.setLayer('none'); return; }
    }
    ui.setSpeed(0);
    this.keys.clear(); this.keyMods = {};
    // 再次按 Esc 只收起菜单，保持暂停；绘线和拖动退出时保留已形成的草案。
    if (ui.dropdown) { ui.closeMenu(); return; }
    this.cancelDrag();
    if (this.tool === 'line') this.endChain(true);
    if (this.tool !== 'select') this.setTool('select');
    if (CM.Follow && CM.Follow.active()) CM.Follow.stop();
    ui.closeLinePicker(); ui.closeSearch(); ui.setTooltip(null);
    ui.showMenu(ui.hbtns.menu);
  };
  // 每帧：键盘平移
  Tools.prototype.tick = function (dt) {
    const K = this.keys; if (!K.size || !this.game()) return;
    const focus = document.activeElement;
    if (this.ui.blocking() || this.ui.dropdown || this.ui.searchEl || this.ui._keyCap || (focus && (/^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName) || focus.isContentEditable))) { this.keys.clear(); this.keyMods = {}; return; }
    const sp = 600 * dt, KS = CM.Keys;
    let dx = 0, dy = 0;
    if (KS.held('cam.left', K, this.keyMods)) dx += sp;
    if (KS.held('cam.right', K, this.keyMods)) dx -= sp;
    if (KS.held('cam.up', K, this.keyMods)) dy += sp;
    if (KS.held('cam.down', K, this.keyMods)) dy -= sp;
    if (dx || dy) { if (CM.Follow && CM.Follow.active()) CM.Follow.stop(); this.R.panBy(dx, dy); }
  };

  // ---------------- 覆盖层绘制 ----------------
  // 悬停在未开放区域上（v2.2）：沿区域边界画缓慢流动的虚线与淡淡的光晕，指示这片区域的范围
  Tools.prototype.drawLockHover = function (ctx, R, now) {
    const cur = this.cursor, g = this.game();
    if (!cur || this.cursorOut || this.ptr || this.drag || !g || !g.city.scenicHost) return;
    const city = g.city, c = city.cellAt(cur.x, cur.y);
    if (c < 0 || city.waterAt(cur.x, cur.y)) return;
    const k = city.cellLocked(c) ? city.lockRegion(c) : -1;
    if (k < 0) return;
    const lines = R.lockOutline(k); if (!lines) return;
    const path = new Path2D();
    for (const p of lines) for (let i = 0; i < p.length; i++) { const q = R.P(p[i][0], p[i][1], 0); if (i) path.lineTo(q.x, q.y); else path.moveTo(q.x, q.y); }
    const ink = R.th.lockInk || '#7a889e', t = now / 1000, a = 0.75 + 0.25 * Math.sin(t * 2.4);
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.globalAlpha = 0.22 * a; ctx.strokeStyle = ink; ctx.lineWidth = 7; ctx.stroke(path);
    ctx.globalAlpha = 0.9 * a; ctx.lineWidth = 2; ctx.setLineDash([9, 7]); ctx.lineDashOffset = -(t * 28) % 16; ctx.stroke(path);
    ctx.restore();
  };
  Tools.prototype.drawOverlay = function (ctx, R) {
    const g = this.game(); if (!g) return;
    const net = this.net();
    const cur = this.cursor;
    this.drawLockHover(ctx, R, performance.now());
    // 网格吸附：缩放后间隔会变，按当前鼠标位置重新取交叉点，并画出淡色十字
    if (cur && !this.drag && !this.portalHover && this.snapWanted(this.hover && this.hover.kind === 'station', this.hover && this.hover.kind === 'seg', cur.mod)) {
      const r = this.snapPick(this.world(cur.sx, cur.sy), cur.mod), sp = r && r.sp;
      this.snapPt = sp || null; if (sp) { cur.x = sp.x; cur.y = sp.y; }
    }
    if (this.snapPt && CM.Grid && CM.Grid.snapOn() && (this.drag || this.tool === 'station' || this.tool === 'line')) CM.Grid.drawSnapMark(ctx, R, this.snapPt);
    // 绘线预览
    if (this.tool === 'line' && this.chain && net.stations[this.chain] && cur) {
      const st = this.hover && this.hover.kind === 'station' ? net.stations[this.hover.id] : null;
      const end = st ? [st.x, st.y] : [cur.x, cur.y];
      const geo = this.previewGeom(end, st && !cur.mod ? st.id : null).geo;
      const lid = this.lineChoice;
      const col = net.lines[lid] ? AX.line(net.lines[lid]) : this.nextLineColor();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = R.lineWidthPx() + 3;
      ctx.beginPath(); geo.pts.forEach(function (p, i) { const q = R.P(p[0], p[1], 0); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.stroke();
      ctx.strokeStyle = this.hint && this.hint.bad ? AX.color('#d63031') : col; ctx.lineWidth = R.lineWidthPx(); ctx.setLineDash([8, 6]); ctx.lineDashOffset = -R.time * 20;
      ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      for (const b of this.bends) { const q = R.P(b[0], b[1], 0); ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      if (!st) { const q = R.P(end[0], end[1], 0); ctx.strokeStyle = this.hint && this.hint.bad ? AX.color('#d63031') : col; ctx.lineWidth = 2.5; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    // 建站预览
    if (this.tool === 'station' && cur && !this.hover) {
      const q = R.P(cur.x, cur.y, 0);
      const ok = this.portalHover ? true : M.checkSite(g.city, cur.x, cur.y, this.buildType).ok;
      ctx.strokeStyle = ok ? '#1e88e5' : '#d63031'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(q.x, q.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (!ok) { ctx.beginPath(); ctx.moveTo(q.x - 4, q.y - 4); ctx.lineTo(q.x + 4, q.y + 4); ctx.moveTo(q.x + 4, q.y - 4); ctx.lineTo(q.x - 4, q.y + 4); ctx.stroke(); }
      // 步行覆盖半径示意（直线 15 分钟）
      const r = CFG.walk.maxAccessM / CFG.CELL_M;
      ctx.strokeStyle = 'rgba(30,136,229,0.35)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; const p = R.P(cur.x + Math.cos(a) * r, cur.y + Math.sin(a) * r, 0); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // 拆除预览：红色 = 将拆除；绿色虚线 = 轨道直连保留；灰色 = 失去服务的车站；橙色 = 不再换乘
    if (this.tool === 'demolish' && this.hover) {
      const imp = this.ui.demolishImpact(this.hover);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (imp) for (const id of imp.removed) if (R.segPx && R.segPx.get(id)) { ctx.strokeStyle = 'rgba(214,48,49,0.7)'; ctx.lineWidth = R.lineWidthPx() + 6; R.strokeArr(ctx, R.segPx.get(id)); }
      if (this.hover.kind === 'station') { const s = net.stations[this.hover.id]; if (s) { const q = R.P(s.x, s.y, 0); ctx.strokeStyle = 'rgba(214,48,49,0.9)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(q.x - 6, q.y - 6); ctx.lineTo(q.x + 6, q.y + 6); ctx.moveTo(q.x + 6, q.y - 6); ctx.lineTo(q.x - 6, q.y + 6); ctx.stroke(); } }
      if (imp) {
        for (const id of imp.added) {
          const sg = imp.after.segments[id], ln = imp.after.lines[sg.line];
          const pts = M.segGeom(imp.after, sg, g.city).pts;
          ctx.beginPath(); pts.forEach(function (p, i) { const q = R.P(p[0], p[1], 0); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
          ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = R.lineWidthPx() + 3; ctx.stroke();
          ctx.strokeStyle = ln ? AX.line(ln) : AX.color('#2e9d57'); ctx.lineWidth = R.lineWidthPx(); ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
        }
        const ring = function (sid, col) { const s = imp.after.stations[sid]; if (!s) return; const q = R.P(s.x, s.y, 0); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); };
        for (const sid of imp.lost) ring(sid, 'rgba(110,118,130,0.95)');
        for (const sid of imp.lostXfer) ring(sid, 'rgba(232,130,30,0.95)');
      }
    }
    // 多选高亮
    const mu = this.ui.multi;
    if (mu) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      mu.segs.forEach(function (id) { if (R.segPx && R.segPx.get(id)) { ctx.strokeStyle = 'rgba(30,136,229,0.45)'; ctx.lineWidth = R.lineWidthPx() + 9; R.strokeArr(ctx, R.segPx.get(id)); } });
      mu.stations.forEach(function (sid) {
        const s = net.stations[sid]; if (!s) return;
        const q = R.P(s.x, s.y, 0);
        ctx.fillStyle = 'rgba(30,136,229,0.18)'; ctx.strokeStyle = '#1e88e5'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
    }
    // 延长手柄
    for (const hd of this.extendHandles()) {
      ctx.strokeStyle = hd.color; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hd.ox, hd.oy); ctx.lineTo(hd.sx, hd.sy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hd.sx, hd.sy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hd.color; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hd.sx - 4.5, hd.sy); ctx.lineTo(hd.sx + 4.5, hd.sy); ctx.moveTo(hd.sx, hd.sy - 4.5); ctx.lineTo(hd.sx, hd.sy + 4.5); ctx.lineWidth = 2.2; ctx.stroke();
    }
    // 修改工具控制点
    if (this.tool === 'edit') {
      for (const h of this.handles()) {
        if (h.kind === 'plat') {
          // 站台方向手柄：虚线连到车站，圆形手柄内画旋转箭头；已手动设定的方向为实心
          ctx.strokeStyle = h.color; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(h.ox, h.oy); ctx.lineTo(h.sx, h.sy); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = h.set ? h.color : '#fff'; ctx.beginPath(); ctx.arc(h.sx, h.sy, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.strokeStyle = h.set ? '#fff' : h.color; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(h.sx, h.sy, 3.6, -Math.PI * 0.9, Math.PI * 0.4); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(h.sx + 3.6 * Math.cos(Math.PI * 0.4) - 2.2, h.sy + 3.6 * Math.sin(Math.PI * 0.4)); ctx.lineTo(h.sx + 3.6 * Math.cos(Math.PI * 0.4), h.sy + 3.6 * Math.sin(Math.PI * 0.4)); ctx.lineTo(h.sx + 3.6 * Math.cos(Math.PI * 0.4), h.sy + 3.6 * Math.sin(Math.PI * 0.4) - 2.2); ctx.stroke();
          continue;
        }
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1e88e5'; ctx.lineWidth = 2;
        ctx.beginPath();
        if (h.kind === 'mid') { ctx.moveTo(h.sx, h.sy - 5); ctx.lineTo(h.sx + 5, h.sy); ctx.lineTo(h.sx, h.sy + 5); ctx.lineTo(h.sx - 5, h.sy); ctx.closePath(); }
        else if (h.kind === 'bend') ctx.arc(h.sx, h.sy, 5, 0, Math.PI * 2);
        else continue;
        ctx.fill(); ctx.stroke();
      }
    }
    // 冲突：高亮涉及的轨道/车站，并在准确位置放置编号图钉（与面板列表编号一致）
    if (g.draft) {
      const ev = g.draftEval();
      if (ev && ev.conflicts.length) {
        const hov = this.ui.hoverConflict;
        const pulse = 0.5 + 0.5 * Math.sin(R.time * 5);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const c of ev.conflicts) {
          const on = hov === c.n;
          if (c.kind === 'seg' && R.segPx && R.segPx.get(c.ref)) {
            ctx.strokeStyle = 'rgba(214,48,49,' + (on ? 0.55 : 0.28 + 0.12 * pulse) + ')';
            ctx.lineWidth = R.lineWidthPx() + (on ? 12 : 8);
            R.strokeArr(ctx, R.segPx.get(c.ref));
          }
          if (c.kind === 'station' && net.stations[c.ref]) {
            const s = net.stations[c.ref], q = R.P(s.x, s.y, 0);
            ctx.strokeStyle = 'rgba(214,48,49,0.85)'; ctx.lineWidth = on ? 4 : 2.5;
            ctx.beginPath(); ctx.arc(q.x, q.y, 11 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
          }
        }
        for (const c of ev.conflicts) {
          const q = R.P(c.x, c.y, 0), on = hov === c.n;
          const s = on ? 1.25 : 1, r = 10 * s;
          const tipY = q.y, cy = tipY - 16 * s;
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
          ctx.fillStyle = '#e03131';
          ctx.beginPath(); ctx.moveTo(q.x, tipY); ctx.lineTo(q.x - r * 0.62, cy + r * 0.5); ctx.arc(q.x, cy, r, Math.PI * 0.82, Math.PI * 0.18, false); ctx.closePath(); ctx.fill();
          ctx.restore();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, cy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(11 * s) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(c.n), q.x, cy + 0.5);
          ctx.fillStyle = 'rgba(224,49,49,' + (0.25 + 0.25 * pulse) + ')'; ctx.beginPath(); ctx.ellipse(q.x, tipY, 6 + pulse * 4, 3 + pulse * 2, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  };
})(window.CM);
