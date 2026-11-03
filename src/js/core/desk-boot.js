(function () {
  'use strict';
  // 桌面宿主注入 pywebview 的时刻晚于本脚本：先记下在不在桌面版，
  // 真正可用与否由 desk.js 的 pywebviewready 事件补上。
  if (window.pywebview && window.pywebview.api) {
    document.documentElement.classList.add('desktop');
    window.__CM_DESKTOP_ = true;
    return;
  }
  window.addEventListener('pywebviewready', function () {
    document.documentElement.classList.add('desktop');
    window.__CM_DESKTOP_ = true;
  });
})();
