(function (CM) {
  'use strict';
  var api = null, boot = null, bootWaiters = [], prefs = {}, closing = false, closeHook = null;
  var stats = { page: '', title: '', map: '', gameId: '', unsaved: false };
  var beatTimer = 0, pushTimer = 0, readyTimer = 0;
  var READY_TIMEOUT = 4000;

  function call(name, payload) {
    if (!api || typeof api[name] !== 'function') return Promise.reject(new Error('desktop api unavailable'));
    return Promise.resolve(api[name](JSON.stringify(payload === undefined ? {} : payload))).then(function (res) {
      if (typeof res === 'string') { try { return JSON.parse(res); } catch (e) { return res; } }
      return res;
    });
  }

  var store = {
    // 页面里只留一个同步接口：旧版宿主的窗口还没加载时写过 localStorage，读到时顺手搬进宿主。
    get: function (key) {
      try { var v = localStorage.getItem(key); if (v !== null) { localStorage.removeItem(key); prefs[key] = v; } } catch (e) {}
      return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null;
    },
    getItem: function (key) { return store.get(key); },
    set: function (key, value) {
      prefs[key] = String(value);
      try { localStorage.removeItem(key); } catch (e) {}
      schedulePush();
      return true;
    },
    setItem: function (key, value) { store.set(key, value); },
    remove: function (key) {
      delete prefs[key];
      try { localStorage.removeItem(key); } catch (e) {}
      schedulePush();
    },
    removeItem: function (key) { store.remove(key); }
  };

  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(pushPrefs, 260);
  }

  function pushPrefs() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = 0; }
    var sets = {};
    for (var k in prefs) if (Object.prototype.hasOwnProperty.call(prefs, k)) sets[k] = prefs[k];
    return call('prefs', { set: sets }).catch(function () {});
  }

  var desk = {
    status: 'pending',
    dataDir: '',
    localStorage: store,
    prefs: function () { return prefs; },
    isDesktop: deskOn,
    call: call,
    ready: ready,
    closing: function () { return closing; },
    onClose: function (fn) { closeHook = fn; },
    state: updateState,
    beat: beat,
    flush: pushPrefs,
    exportFile: exportFile,
    importFile: importFile,
    recoverRead: recoverRead,
    recoverDrop: recoverDrop,
    snapshot: function (body) { return call('snapshot', body); },
    quit: function () { return call('quit', {}); },
    store: function (body) { return call('store', body); },
    window: windowAction
  };

  function ready(fn) {
    if (typeof fn === 'function') bootWaiters.push(fn);
    // 宿主接口迟迟不来（被安全软件拦截、加载失败）时不能一直悬着：
    // 超时后按「宿主可用但没就绪」放行，存档会走文件接口，读失败有明确报错。
    return new Promise(function (resolve) {
      if (boot) { resolve(boot); return; }
      bootWaiters.push(resolve);
      if (!readyTimer) readyTimer = setTimeout(function () { if (!boot) apply({}); }, READY_TIMEOUT);
    });
  }

  function apply(next) {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
    boot = next || {};
    desk.dataDir = boot.dataDir || '';
    if (boot.prefs) {
      for (var k in boot.prefs) {
        if (Object.prototype.hasOwnProperty.call(boot.prefs, k) && !Object.prototype.hasOwnProperty.call(prefs, k)) prefs[k] = boot.prefs[k];
      }
    }
    desk.status = 'ready';
    window.__CM_DESKTOP_READY__ = true;
    var waiting = bootWaiters;
    bootWaiters = [];
    for (var i = 0; i < waiting.length; i++) { try { waiting[i](boot); } catch (e) {} }
  }

  // 同步判断「是不是桌面版」：宿主对象注入的时刻不固定，所以只要看见任一标志就算。
  function deskOn() { return !!(api || (window.__CM_DESKTOP_ && window.pywebview)); }

  function updateState(next) {
    if (!next) return;
    if (next.page !== undefined) stats.page = String(next.page);
    if (next.title !== undefined) stats.title = String(next.title);
    if (next.map !== undefined) stats.map = String(next.map);
    if (next.gameId !== undefined) stats.gameId = String(next.gameId);
    if (next.unsaved !== undefined) stats.unsaved = !!next.unsaved;
    if (!beatTimer) beatTimer = setTimeout(function () { beat(); }, 400);
  }

  function beat(extra) {
    if (beatTimer) { clearTimeout(beatTimer); beatTimer = 0; }
    var body = { page: stats.page, title: stats.title, map: stats.map, gameId: stats.gameId, unsaved: !!stats.unsaved };
    if (extra) for (var k in extra) body[k] = extra[k];
    return call('heartbeat', body).catch(function () { return { ok: false }; });
  }

  function exportFile(text, name) {
    return call('export', { text: String(text), name: String(name || '存档.json') });
  }

  function importFile() {
    return call('importFile');
  }

  function recoverRead(name) {
    return call('recover', { action: 'read', name: String(name) });
  }

  function recoverDrop(name) {
    return call('recover', { action: 'drop', name: String(name) });
  }

  function windowAction(action, extra) {
    var body = { action: action };
    if (extra) for (var k in extra) body[k] = extra[k];
    return call('window', body).catch(function () { return null; });
  }

  function handleClose() {
    if (closing) return;
    closing = true;
    var done = function () {
      var pending = [];
      if (typeof closeHook === 'function') {
        try { pending.push(Promise.resolve(closeHook())); } catch (e) {}
      }
      var wait = pending.length ? Promise.all(pending.map(function (p) { return p.catch(function () {}); })) : Promise.resolve();
      // 宿主在关窗回调里等这个心跳，但存档不能无限拖住窗口：到点先放行，
      // 剩下的写盘跟着进程一起收尾（桌面版有强制退出兜底，不会丢在写一半）
      var sent = false;
      var ack = function (ok) { if (sent) return; sent = true; desk.beat({ quit: true, ok: ok }); };
      setTimeout(function () { ack(false); }, 1500);
      wait.then(function () { ack(true); }, function () { ack(false); });
    };
    done();
  }

  function attach(next) {
    if (api || !next) return;
    api = next;
    if (typeof api.desktopInfo === 'function') {
      Promise.resolve(api.desktopInfo()).then(function (raw) {
        var info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        apply(info || {});
      }, function () { desk.status = 'failed'; apply({}); });
    } else {
      apply({});
    }
  }

  // api 可能比这些脚本还晚（宿主注入在页面加载之后）：没等到就轮询，别让存档接口永远空着。
  var apiTries = 0, apiTimer = 0;
  function pollApi() {
    if (api) { if (apiTimer) { clearInterval(apiTimer); apiTimer = 0; } return; }
    if (++apiTries > 200) { if (apiTimer) { clearInterval(apiTimer); apiTimer = 0; } return; }
    attach(window.pywebview && window.pywebview.api);
  }

  window.CM = CM;
  CM.DESKTOP = desk;
  // 浏览器里没有宿主 API：desk 保持 pending，页面走原有的网页存储与下载逻辑。
  // 宿主注入 window.pywebview 的时刻不固定（常晚于 defer 脚本），所以这里不能同步判断后就 return，
  // 必须无条件挂上 ready 监听，否则桌面版会永远退化成浏览器分支。
  CM.desktop = deskOn;
  if (window.pywebview && window.pywebview.api) attach(window.pywebview.api);
  // 无条件监听：宿主注入 window.pywebview 的时刻常晚于 defer 脚本，
  // 已经错过事件时（页面重新加载）靠轮询补上。
  window.addEventListener('pywebviewready', function () {
    window.__CM_DESKTOP_ = true;
    document.documentElement.classList.add('desktop');
    attach(window.pywebview && window.pywebview.api);
    if (!api && !apiTimer) apiTimer = setInterval(pollApi, 80);
  });
  if (!api) apiTimer = setInterval(pollApi, 80);
  CM.onCloseRequest = handleClose;
})(window.CM || (window.CM = {}));
