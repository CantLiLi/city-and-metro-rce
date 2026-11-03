// 载入页：全屏纯色背景 + LOGO + 进度条 + 一条小提示
// 用法：CM.LoadPage.show(text, kind) / CM.LoadPage.set(进度, 阶段) / CM.LoadPage.hide(回调)
(function () {
  'use strict';
  const CM = window.CM = window.CM || {};
  const U = CM.U || {};
  const LP = CM.LoadPage = {};
  const TIPS = [
    '客流高峰时，换乘站最容易堆积，宜拉开几条并行线路',
    '线路加密后，市区地面公交的负荷会下降',
    '把车站设在住宅区与办公区之间，分担率涨得最快',
  ];

  // RCE 社区版信息行：版本 + 作者
  const VERSION = function () {
    const v = CM.CFG && CM.CFG.GAME_VERSION ? ' v' + CM.CFG.GAME_VERSION : '';
    return 'RCE 社区版' + v + ' · © 2026 VinsonFung';
  };
  let box = null, goal = 0, shown = 0, raf = 0, alive = false, bootRaf = 0, pop = false, pend = null, resend = [], tipAt = 0;
  // 加载页只表达「还在忙 / 忙完了」：进度条自己匀速爬到 CAP，收到完成信号才冲到 100%。
  // 阶段进度来自求解轮次，只会让进度条走走停停地卡在几个固定档位，看不出是在推进还是在等。
  const CAP = 0.5, CRAWL = 0.06;
  let bar = null, pctEl = null, tipEl = null, tipI = 0, reached = false;

  // 页面首帧就有的载入页（index.html 里的 #loadpageRoot）：不再新建，直接接管其中的元素
  function adopt() {
    let root = document.getElementById('loadpageRoot');
    if (!root) {   // 启动那一次退场时已被移除：按同样的结构重建
      root = document.createElement('div');
      root.id = 'loadpageRoot';
      root.dataset.built = '1';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.innerHTML = '<div class="ldp-stage"><img class="ldp-logo" alt=""><div class="ldp-title">城市与地铁</div>'
        + '<div class="ldp-edition">RCE 社区版</div>'
        + '<div class="ldp-prog"><div class="ldp-bar"><i></i></div><span class="ldp-pct">0%</span></div>'
        + '<div class="ldp-tip"></div><div class="ldp-meta"></div></div>';
      document.body.appendChild(root);
    }
    box = root;
    box.classList.remove('is-out');
    const logo = root.querySelector('.ldp-logo');
    if (logo) logo.src = document.documentElement.dataset.theme === 'dark' ? 'img/logo-white.png' : 'img/logo-navy.png';
    bar = root.querySelector('.ldp-bar > i');
    pctEl = root.querySelector('.ldp-pct');
    tipEl = root.querySelector('.ldp-tip');
    const meta = root.querySelector('.ldp-meta');
    if (meta) meta.textContent = VERSION();
    return true;
  }

  function tip(text, kind) {
    if (!tipEl) return;
    const line = document.createElement('div');
    line.className = 'ldp-tips';
    const a = document.createElement('div');
    a.className = 'ldp-tip-i';
    a.textContent = text || '正在准备城市…';
    line.appendChild(a);
    const t = TIPS[(kind === 'pre' ? 1 : tipI++) % TIPS.length];
    if (t && kind !== 'quiet') {
      const b = document.createElement('div');
      b.className = 'ldp-tip-i';
      b.textContent = '提示 · ' + t;
      line.appendChild(b);
    }
    tipEl.textContent = '';
    tipEl.appendChild(line);
    tipAt = Date.now();
  }

  function paint() {
    if (bar) bar.style.width = (shown * 100).toFixed(2) + '%';
    if (pctEl) pctEl.textContent = Math.floor(shown * 100 + (shown > 0.995 ? 0.5 : 0)) + '%';
  }

  function tick(now) {
    if (!alive) return;
    const dt = Math.min(0.2, Math.max(0, (now - (tick.t || now)) / 1000));
    tick.t = now;
    if (shown < goal) {
      // 指数逼近只用来抹平相邻两档的跳变：差距大时直接吃掉大部分，
      // 否则每跳一档都要六百毫秒才追到 95%，算得快的时候进度条自己成了瓶颈。
      const gap = goal - shown;
      const rate = gap > 0.12 ? 1 - Math.exp(-dt * 40) : (1 - Math.exp(-dt * 5));
      shown += gap * rate + dt * 0.01;
      shown = Math.min(shown, goal);
    } else if (!reached) {
      // 还没收到完成信号：匀速爬向 CAP，越接近越慢，停在那里等结束
      shown = Math.min(CAP, shown + dt * CRAWL * (1 - shown / CAP));
    }
    paint();
    raf = requestAnimationFrame(tick);
  }

  LP.show = function (text, kind) {
    clearTimeout(pend); pend = null;   // 上一次退场的收尾尚未执行就被重新唤起
    if (!box) {   // 退场后已销毁：重建一份，之后每次载入都用它
      if (!adopt()) return;
      if (box.dataset.built) pop = true;
    }
    if (!alive) {
      alive = true;
      raf = requestAnimationFrame(tick);
    }
    tick.t = performance.now();
    // 整屏从页面首帧就是纯色、不透明：再次载入时先去掉退场用的过渡，回到不透明之后再启用淡出过渡，
    // 否则同一帧里从退场态转回来会被过渡拖成一张半透明的底，界面与地图会透上来
    box.classList.remove('go', 'is-out');
    void box.offsetWidth;
    box.classList.add('go');
    goal = shown = 0;
    reached = false;
    paint();
    tip(text, kind);
    // 启动载入：开始界面的背景城市画好之前没有进度可报，让进度条自己缓慢前移，准备完成时再补满
    if (kind === 'boot') {
      goal = 0.14;
      const creep = function (now) {
        if (!alive || kind !== 'boot' || reached) return;
        goal = Math.min(CAP, goal + Math.min(0.2, (now - (creep.t || now)) / 1000) * 0.1);
        creep.t = now;
        bootRaf = requestAnimationFrame(creep);
      };
      bootRaf = requestAnimationFrame(creep);
    }
  };

  // 完成信号：载入的活干完了，进度条从此不再受 CAP 限制，直接补满。
  LP.finish = function (label) {
    reached = true;
    goal = 1;
    if (label && box && box.isConnected) tip(label, 'quiet');
  };
  LP.set = function (p, label) {
    if (!box) return;
    if (reached) return;   // 已收到完成信号：进度只往 100% 走，不再被阶段进度拉回档位
    goal = Math.max(goal, U.clamp ? U.clamp(p, 0, CAP) : Math.min(CAP, Math.max(0, p || 0)));
    if (label && box.isConnected && Date.now() - tipAt > 700) tip(label, 'quiet');
  };

  LP.hide = function (cb) {
    if (resend.length) {   // 被撤销的那次退场留下的结束回调：这一次真正退场时一并执行
      const back = resend.splice(0);
      if (cb) back.push(cb);
      cb = function () { for (const f of back) f(); };
    }
    if (pend) {   // 收尾还没执行就又退场一次：并到同一次收尾上
      if (cb) pend.push(cb);
      return;
    }
    if (!box) { if (cb) cb(); return; }
    if (!box.isConnected) {   // 页面里那一份已不在文档中（被重建或移除）：直接收尾
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (bootRaf) cancelAnimationFrame(bootRaf);
      raf = bootRaf = 0;
      box = null;
      if (cb) cb();
      return;
    }
    const cbs = pend = cb ? [cb] : [];
    const done = function () {
      if (!cbs.length) return;   // 已被 LP.revive 撤销：这次退场作废
      const list = cbs.slice();   // 先把要执行的回调取出来，再清空 pend（清空之后 cbs 里已经没有元素了）
      cbs.length = 0;
      pend = null;
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      // 载入页每次都在退场后销毁（启动那一次是页面自带的 #loadpageRoot）：它的淡出与界面层的入场、地图淡入
      // 是两套叠在一起的时间轴，留着这张淡到透明的纯色层只会给后面的界面再加一层合成与时间轴
      if (box) { box.remove(); box = null; bar = pctEl = tipEl = null; }
      pop = false;
      for (const f of list) f();
    };
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    if (bootRaf) cancelAnimationFrame(bootRaf);
    raf = bootRaf = 0;
    goal = shown = 1;
    reached = true;
    paint();
    box.classList.add('is-out');
    setTimeout(done, 420);
  };
  LP.visible = function () { return !!box && box.isConnected && box.classList.contains('is-out') === false; };
  // 载入页可能还停在整屏淡出的尾段（is-out 已经加上、420ms 后才真正销毁）：此时又要开始新的载入，
  // 必须当场撤销退场并把真结束的回调接过来，否则整屏只剩一张淡出的纯色页，载入过程看不见，最后再走一遍退场
  LP.revive = function () {
    if (!box || !pend || !box.isConnected) return false;
    const cbs = pend; pend = null;
    if (raf) cancelAnimationFrame(raf);
    if (bootRaf) cancelAnimationFrame(bootRaf);
    raf = bootRaf = 0;
    alive = true;
    tick.t = performance.now();
    // 上一次退场把进度钉在了 100%：新的载入要从头自己爬
    goal = shown = 0;
    reached = false;
    paint();
    box.classList.remove('go', 'is-out');
    void box.offsetWidth;
    box.classList.add('go');
    raf = requestAnimationFrame(tick);
    resend = resend.concat(cbs);
    return true;
  };
  LP.reset = function () {
    if (box && box.classList.contains('is-out')) { box.classList.remove('go', 'is-out'); void box.offsetWidth; box.classList.add('go'); }
    goal = shown = 0;
    reached = false;
    if (bar) bar.style.width = '0%';
    if (pctEl) pctEl.textContent = '0%';
    tipAt = 0;
  };
})();
