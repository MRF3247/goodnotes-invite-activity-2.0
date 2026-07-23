'use strict';
// 公共小工具：请求封装 + 验证码组件
async function api(path, opts) {
  const res = await fetch(path, opts ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts)
  } : undefined);
  let data;
  try { data = await res.json(); }
  catch { data = { ok: false, msg: '网络异常，请稍后再试' }; }
  return data;
}

function $(sel, root) { return (root || document).querySelector(sel); }

function showAlert(el, type, msg) {
  el.className = 'alert ' + type;
  el.textContent = msg;
  el.style.display = 'block';
}
function hideAlert(el) { el.style.display = 'none'; }

// 验证码组件：绑定到一个容器（含 .captcha-img 和 input）
function initCaptcha(container) {
  const img = $('.captcha-img', container);
  const input = $('input', container);
  let token = null;
  async function refresh() {
    img.innerHTML = '<span class="muted" style="padding:0 12px">加载中…</span>';
    input.value = '';
    const d = await api('/api/captcha');
    if (d.ok) { img.innerHTML = d.svg; token = d.token; }
    else { img.innerHTML = '<span class="muted" style="padding:0 8px">点击重试</span>'; token = null; }
  }
  img.addEventListener('click', refresh);
  img.setAttribute('role', 'button');
  img.setAttribute('aria-label', '点击刷新验证码');
  refresh();
  return {
    refresh,
    get token() { return token; },
    get answer() { return input.value.trim(); }
  };
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
}
