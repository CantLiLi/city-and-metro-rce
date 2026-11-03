'use strict';
// Web v2.2 presentation; browser chrome, shortcuts and small-screen layout stay in ui.js.
(function (CM) {
  const UI = CM.UI, U = CM.U, CFG = CM.CFG, D = CM.DATA, h = U.h, ic = CM.icon;
  UI.ERA_COLORS = ['#2f9e8f', '#3a7bd5', '#c2410c', '#7c4dff', '#d6336c', '#0f8a5f', '#b7791f', '#5b6b8c'];
  const snd = name => { if (CM.Sound) CM.Sound.play(name); };
  UI.prototype.updateEraChip = function (g) {
    const E = CM.Eras, chip = this.eraChip;
    if (!E || !E.enabled()) { chip.classList.add('gone'); return; }
    const t = g.year(), k = E.index(t), e = E.list()[k];
    const to = E.endOf(k) || e.from + 15, frac = U.clamp((t - e.from) / Math.max(0.5, to - e.from), 0, 1);
    if (chip._k !== k) {
      chip._k = k;
      chip.classList.remove('gone');
      chip.style.setProperty('--ec', UI.ERA_COLORS[k % UI.ERA_COLORS.length]);
      chip.querySelector('.v').textContent = e.name;
      chip.querySelector('.k').textContent = e.from + (E.endOf(k) ? '–' + E.endOf(k) : ' 年起');
      chip.setAttribute('data-tip', '发展阶段：' + e.name + ' · 点击查看本阶段的城市变化');
      if (CM.I18n) CM.I18n.localize(chip);
    }
    const w = Math.round(frac * 1000) / 10;
    if (chip._w !== w) { chip._w = w; chip.querySelector('.ec-prog i').style.width = w + '%'; }
    chip.classList.toggle('on', !!this.topIs(['era']) && !this.right.classList.contains('closed'));
  };

  UI.prototype.clearHist = function () {
    this._histQ = []; this._phaseQ = [];
    if (this.histHost) this.histHost.innerHTML = '';
  };

  UI.prototype.flushHist = function () {
    const g = this.g(); if (!g || g.jumping || this.blocking() || this.celebrationBlocked() || !this._histQ) return;
    if (this._phaseQ.length) { const er = this._phaseQ[this._phaseQ.length - 1]; this._phaseQ.length = 0; this.showPhaseBanner(er); }
    if (!this._histQ.length) return;
    // 跳月 / 跳年后一次到来的多条事件合成一张摘要卡片
    if (this._histQ.length > 2) { this.showHistDigest(this._histQ.splice(0)); return; }
    while (this._histQ.length && this.histHost.querySelectorAll('.hist-card').length < (this.compact() ? 1 : 2)) this.showHistCard(this._histQ.shift());
  };

  UI.prototype.histLife = function (box, ms) {
    const self = this; let left = ms, t0 = performance.now(), timer = null;
    const close = function () { if (box.classList.contains('out')) return; clearTimeout(timer); box.classList.add('out'); setTimeout(function () { box.remove(); self.flushHist(); }, CM.Settings.reducedMotion() ? 0 : 380); };
    const run = function () { t0 = performance.now(); timer = setTimeout(close, left); box.style.setProperty('--life-play', 'running'); };
    box.addEventListener('pointerenter', function () { clearTimeout(timer); left -= performance.now() - t0; box.style.setProperty('--life-play', 'paused'); });
    box.addEventListener('pointerleave', run);
    box.style.setProperty('--life', ms + 'ms');
    run();
    return close;
  };

  UI.prototype.showPhaseBanner = function (er) {
    const self = this, E = CM.Eras; if (!E || !er || !er.era) return;
    const L = E.list(), k = L.indexOf(er.era), e = er.era, to = E.endOf(k);
    for (const old of this.histHost.querySelectorAll('.phase-banner')) old.remove();
    // 展望：背景中「估算 / 模拟」的第一句；上一阶段的结果：人口、岗位、新开发用地与地铁
    const en = CM.I18n && CM.I18n.get() === 'en';
    const outlook = en ? (CM.I18n.text(String(e.summary || '')).split(/Estimated: |Simulated: |Fictional: /)[1] || '').split(/\.\s/)[0].replace(/\.$/, '')
      : (String(e.summary || '').split(/估算：|模拟：|虚构：/)[1] || '').split('。')[0];
    let prev = null;
    if (er.prev && er.prev.start && er.prev.end) {
      const a = er.prev.start, b = er.prev.end, pe = E.byId(er.prev.id), pc = function (x, y) { return x > 0 ? U.fmtSigned(Math.round((y / x - 1) * 100), 0) + '%' : '—'; };
      const bits = ['人口 ' + pc(a.pop, b.pop), '岗位 ' + pc(a.jobs, b.jobs)];
      if (a.dev != null && b.dev != null) bits.push('新开发用地 ' + U.fmtSigned(Math.round((b.dev - a.dev) * CFG.CELL_M * CFG.CELL_M / 1e5) / 10, 1) + ' km²');
      bits.push(b.km > 0 ? '地铁 ' + U.fmtNum(b.km, 0) + ' km' : '尚无地铁');
      prev = '「' + (pe ? pe.name : '上一阶段') + '」' + bits.join(' · ');
    }
    let close = null;
    const box = h('div', { class: 'phase-banner', style: { '--ec': UI.ERA_COLORS[k % UI.ERA_COLORS.length] }, role: 'status' },
      h('span', { class: 'pb-line' }),
      h('div', { class: 'pb-num' }, h('b', null, String(k + 1)), h('small', null, '/ ' + L.length)),
      h('div', { class: 'pb-body' },
        h('div', { class: 'pb-kick' }, h('span', null, '新的发展阶段 · ' + e.from + (to ? '–' + to : ' 年起')), h('span', { class: 'pb-tag' }, e.tag)),
        h('div', { class: 'pb-title' }, e.name),
        outlook ? h('div', { class: 'pb-sub' }, en ? outlook.charAt(0).toUpperCase() + outlook.slice(1) + '.' : outlook + '。') : null,
        prev ? h('div', { class: 'pb-prev' }, ic('chart', 13), h('span', null, prev)) : null,
        h('div', { class: 'pb-dots' }, L.map(function (x, i) { return h('i', { class: i < k ? 'past' : (i === k ? 'cur' : '') }); }))),
      h('div', { class: 'pb-acts' },
        h('button', { class: 'btn sm', onclick: function () { if (close) close(); self.openPage('era', null, { root: true }); } }, '查看变化'),
        h('button', { class: 'iconbtn', 'aria-label': '关闭', onclick: function () { if (close) close(); } }, ic('close'))),
      h('i', { class: 'pb-life' }));
    this.histHost.prepend(box);
    snd('chime');
    close = this.histLife(box, 11000);
  };

  UI.prototype.histTarget = function (ev, chips) {
    const g = this.g(); if (!g) return null;
    const rid = chips.length && chips[0].region;
    if (rid) { const k = g.city.regions.findIndex(function (r) { return r.id === rid; }); if (k >= 0) return { region: k }; }
    const lm = (CM.DATA.landmarks || []).filter(function (x) { return x.name && x.name.length >= 3 && String(ev.title).indexOf(String(x.name).replace(/（.*）/, '')) >= 0; })[0];
    return lm ? { x: lm.x, y: lm.y, name: lm.name } : null;
  };

  UI.prototype.showHistCard = function (ev) {
    const self = this, chips = CM.Eras ? CM.Eras.fxChips(ev.fx) : [], tgt = ev.econ ? null : this.histTarget(ev, chips);
    const tagCls = { '史实': 'hist', '模拟': 'sim' }[ev.tag] || 'info';
    let close = null;
    const box = h('div', { class: 'hist-card' + (ev.econ ? ' econ' + (ev.neg ? ' neg' : '') : '') },
      h('div', { class: 'hc-date' }, h('b', null, String(ev.y)), h('small', null, (ev.m || 1) + ' 月')),
      h('div', { class: 'hc-body' },
        h('div', { class: 'hc-kick' }, h('span', { class: 'tag ' + tagCls }, ev.tag || '史实'), h('span', null, ev.econ ? '城市经济 · 对本城影响' + (ev.lvl || '') : '历史时刻')),
        h('div', { class: 'hc-title' }, ev.title),
        ev.desc ? h('div', { class: 'hc-desc' }, ev.desc) : null,
        chips.length ? h('div', { class: 'hc-chips' }, chips.map(function (c) { return h('span', { class: 'hc-chip ' + (c.up ? 'up' : 'down') }, ic(c.icon, 12), c.text); })) : null),
      h('div', { class: 'hc-acts' },
        tgt ? h('button', { class: 'iconbtn', 'data-tip': '在地图上查看', onclick: function () { if (tgt.region != null) self.locateRegion(tgt.region); else self.locatePoint(tgt.x, tgt.y, tgt.name, 2.5); } }, ic('locate')) : null,
        h('button', { class: 'iconbtn', 'aria-label': '关闭', onclick: function () { if (close) close(); } }, ic('close'))),
      h('i', { class: 'hc-life' }));
    this.histHost.appendChild(box);
    snd('notify');
    close = this.histLife(box, 9000 + Math.min(4000, String(ev.desc || '').length * 40));
  };
  // 载入页：全屏纯色背景（覆盖整个窗口）+ LOGO + 线路式进度条。它是独立于界面层 #screen 的整屏浮层（#loadpageRoot），
  // 不再做成浮在模糊地图上的卡片。进度由开局、读档与推演过程报告（CM.loadProgress），两次报告之间缓慢前移
  UI.prototype.loadingEsc = function (on) {
    const self = this;
    if (this._ldEsc) { document.removeEventListener('keydown', this._ldEsc, true); this._ldEsc = null; }
    if (!on) return;
    this._ldEsc = function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      e.preventDefault(); e.stopPropagation();
      self.cancelLoading();
    };
    document.addEventListener('keydown', this._ldEsc, true);
  };
  UI.prototype.showLoading = function (text, kind, mapId) {
    // 上一段载入的整屏退场可能还没结束：当场撤销，载入页继续用，不留在淡出的空白页上
    if (CM.LoadPage && CM.LoadPage.revive && CM.LoadPage.revive()) { this._loading = true; this.loadingEsc(true); return; }
    this.closeScreen();
    this._loading = true;
    if (this.stageBg) this.stageBg(null);
    if (CM.LoadPage) CM.LoadPage.show(text, kind);
    this.loadingEsc(true);
  };
  UI.prototype.loadProgress = function (p, label) {
    if (!this._loading || !CM.LoadPage) return;
    CM.LoadPage.set(p, label);
  };
  // 载入的活干完了：进度条不再受 50% 上限限制，立刻补满后淡出。
  UI.prototype.loadDone = function (label) {
    if (!this._loading || !CM.LoadPage) return;
    if (CM.LoadPage.finish) CM.LoadPage.finish(label);
  };
  UI.prototype.finishLoading = function (cb) {
    this.loadingEsc(false);
    if (!this._loading || CM.Settings.reducedMotion()) { this._loading = false; if (CM.LoadPage) CM.LoadPage.hide(cb); else cb(); return; }
    this.loadProgress(1, '准备就绪');
    this._loading = false;
    if (CM.LoadPage) CM.LoadPage.hide(cb); else cb();
  };
  // 放弃载入：收起载入页、恢复主菜单，再中断正在跑的开局 / 读档（顺序不能反，否则被中断的载入
  // 会接着走它自己的收尾，把界面交还给一张半透明的地图）
  UI.prototype.cancelLoading = function () {
    if (!this._loading) return;
    this._loading = false;
    this.loadingEsc(false);
    if (CM.LoadPage) CM.LoadPage.hide();
    if (CM.LoadPage && CM.LoadPage.reset) CM.LoadPage.reset();
    this.showStart();
    if (CM.cancelLoad) CM.cancelLoad();
  };


  UI.prototype.showJump = function () {
    const g = this.g(), j = g.jumping, self = this, from = j.from, to = j.target;
    const n = Math.max(1, (to[0] - from[0]) * 12 + (to[1] - from[1]));
    const yv = h('span', { class: 'jp-y' }, ''), mv = h('span', { class: 'jp-m' }, '');
    const fill = h('i', { class: 'jp-fill' }), train = h('span', { class: 'jp-train' }, h('i'));
    const stops = [];
    for (let k = 1; k <= n; k++) {
      const ym = from[0] * 12 + (from[1] - 1) + k, y = Math.floor(ym / 12), m = ym % 12 + 1;
      stops.push(h('span', { class: 'jp-stop', style: { left: (k / n * 100) + '%' } }, h('i'), h('em', null, m === 1 || n <= 3 ? y + '.' + m : String(m))));
    }
    const pct = h('b', { class: 'jp-pct' }, '0%'), ev = h('div', { class: 'jp-ev' }), pop = h('b', null, '—'), share = h('b', null, '—');
    this.openScreen(h('div', { class: 'card jp-card' },
      h('div', { class: 'jp-kick' }, ic('calYear', 15), h('span', null, '时间推进 · ' + (n === 12 ? '1 年' : n + ' 个月'))),
      h('div', { class: 'jp-date' }, yv, mv),
      h('div', { class: 'jp-line' }, h('span', { class: 'jp-origin' }), h('i', { class: 'jp-rail' }), fill, stops, train),
      h('div', { class: 'jp-stats' }, h('span', null, '人口 ', pop), h('span', null, '地铁分担率 ', share), pct),
      ev,
      h('div', { class: 'jp-foot' }, '逐日结算票款与运营费用，按月处理拨款、城市发展、区域开放与任务')), null);
    const J = this._jp = { p: 0, disp: 0, t: performance.now(), ym: -1, evN: g.events.length };
    const tick = function (now) {
      if (self._jp !== J || !fill.isConnected) return;
      const dt = Math.min(0.1, (now - J.t) / 1000); J.t = now;
      J.disp += (J.p - J.disp) * (1 - Math.exp(-dt * 7));
      const p = J.disp;
      fill.style.transform = 'scaleX(' + p.toFixed(4) + ')'; train.style.left = (p * 100).toFixed(2) + '%';
      pct.textContent = Math.floor(p * 100) + '%';
      for (let i = 0; i < n; i++) stops[i].classList.toggle('on', p >= (i + 1) / n - 0.004);
      const c = g.clock, ym = c.y * 12 + c.m;
      if (ym !== J.ym) {
        const first = J.ym < 0; J.ym = ym;
        const en = CM.I18n && CM.I18n.get() === 'en';
        yv.textContent = en ? String(c.y) : c.y + ' 年'; mv.textContent = en ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][c.m - 1] : c.m + ' 月';
        if (!first) { mv.classList.remove('flip'); void mv.offsetWidth; mv.classList.add('flip'); }
        pop.textContent = U.fmtPeople(g.city.totals().pop); share.textContent = U.fmtPct((g.model.daily && g.model.daily.metroShare) || 0);
        if (g.events.length > J.evN) {
          const e = g.events[g.events.length - 1]; J.evN = g.events.length;
          ev.textContent = e.y + '.' + e.m + ' · ' + e.title; if (CM.I18n) CM.I18n.localize(ev);
          ev.classList.remove('flash'); void ev.offsetWidth; ev.classList.add('flash');
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  UI.prototype.updateJump = function (p) { if (this._jp) this._jp.p = U.clamp(p, 0, 1); };



  UI.LAYERS.push({ id: 'dev', group: 'city', name: '城市发展', icon: 'chart', color: '#0f8a5f', desc: '本阶段以来人口、岗位与新开发用地的变化' });
  const chrome = UI.prototype.buildChrome;
  UI.prototype.buildChrome = function () {
    chrome.apply(this, arguments);
    const self = this;
    this.eraChip = h('button', { class: 'pill erachip gone', 'data-tip': '发展阶段', onclick: () => self.openTop('era') },
      h('span', { class: 'ec-dot' }), h('span', { class: 'tx' }, h('span', { class: 'k' }, '发展阶段'), h('span', { class: 'v' }, '')), h('span', { class: 'ec-prog' }, h('i')));
    this.pills.date.el.insertAdjacentElement('afterend', this.eraChip);
    this.histHost = h('div', { id: 'histHost' }); this.feed.appendChild(this.histHost); this.clearHist();
    // 阶段背景先整段翻译再分行；切语言时重新构造，避免逐行翻译遗留混排。
    if (CM.I18n) CM.I18n.on(() => { if (this.topIs(['era'])) this.rerenderPage(); });
  };
  const attach = UI.prototype.attachGame;
  UI.prototype.attachGame = function (g) {
    this.clearHist(); attach.call(this, g); this.eraChip._k = null;
    g.on('era', er => { this._phaseQ.push(er); this.flushHist(); });
    g.on('histEvent', ev => { this._histQ.push(ev); this.flushHist(); });
    this.updateEraChip(g);
  };
  const clear = UI.prototype.clearCelebrations;
  UI.prototype.clearCelebrations = function () { clear.call(this); this.clearHist(); };
  const tick = UI.prototype.tick;
  UI.prototype.tick = function () { tick.apply(this, arguments); if (this.g()) { this.updateEraChip(this.g()); this.flushHist(); } };
  const openTop = UI.prototype.openTop;
  UI.prototype.openTop = function (key) {
    if (key !== 'era') return openTop.apply(this, arguments);
    if (this.topIs(['era']) && !this.right.classList.contains('closed')) this.closePanel(true);
    else this.openPage('era', null, { root: true });
  };
  const legend = UI.prototype.legend;
  UI.prototype.legend = function (id) {
    if (id !== 'dev') return legend.call(this, id);
    const self = this, R = this.R;
    const options = (key, items) => h('div', { class: 'seg-ctl sm', style: { marginBottom: '8px' } }, items.map(o => h('button', { class: R.layerOpt[key] === o[0] ? 'on' : '', onclick: () => { R.layerOpt[key] = o[0]; R.heatKey = ''; self.renderDock(); } }, o[1])));
    return h('div', { class: 'legend' }, options('devK', [['pop', '人口'], ['jobs', '岗位'], ['land', '用地']]), options('devB', [['era', '本阶段以来'], ['start', '本局以来']]),
      h('div', { class: 'note' }, '绿色、蓝色或金色表示增加，红色表示减少；每块约 1 km。旧进度从载入时开始比较。'));
  };
  const datePage = UI.prototype.page_date;
  UI.prototype.page_date = function () {
    const page = datePage.call(this), self = this, e = CM.Eras.current(this.g().year());
    page.el.prepend(h('button', { class: 'btn', onclick: () => self.openPage('era', null, { root: true }) }, '发展阶段 · ' + (e ? e.name : '')));
    return page;
  };
  UI.settingsExtra.display.push(function () {
    const S=CM.Settings, b=h('button',{class:'switch'+(S.get('lighting')?' on':''),role:'switch','aria-label':'统一光照','aria-checked':String(S.get('lighting')!==false),onclick:function(){const on=S.get('lighting')===false;S.set('lighting',on);b.classList.toggle('on',on);b.setAttribute('aria-checked',String(on));}},h('i'));
    return h('div',{class:'set-row'},h('span',{class:'set-ico'},ic('sun')),h('div',{class:'grow'},h('div',{class:'set-t'},'统一光照'),h('div',{class:'set-d'},'山体与建筑使用同一光向，白天与夜晚随主题切换')),b);
  });
})(window.CM);
