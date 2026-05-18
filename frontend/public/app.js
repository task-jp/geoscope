let _busyCount = 0;
function busyStart() { _busyCount++; document.body.classList.add('busy'); }
function busyEnd() { _busyCount = Math.max(0, _busyCount - 1); if (!_busyCount) document.body.classList.remove('busy'); }
import { initMap, getMap, setLayerVisibility, setLayerOpacity, setTerrainExaggeration, applyUrlPosition, startUrlSync } from '/map.js?v=398';

// ── Shared state (window.__gs) ──
window.__gs = {
  currentUser: null,
  currentProject: null,
  annotations: [],
  projectLabels: [],
  projects: [],
  selectedAnnotationIdx: null,
  currentMode: 'view',
  savedPitch: null,
  savedBearing: null,
  _shiftHeld: false,
  filterConfig: { sets: [{ rows: [] }], spatials: [] },
  _filteredCache: null,
  _filterCacheKey: '',
  _filteredTotal: 0,
  galleryMode: false,
  addingMode: false,
  _geoJSONDirty: true,
  _cachedGeoJSON: null,
  // Utility functions for private module
  busyStart,
  busyEnd,
  loadPrefs,
  savePrefs,
  _getPhotoTileUrl,
  _updatePhotoSource,
};

// ── Sidebar toggle ──
function setupSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const mapEl = document.getElementById('map');
  const btn = document.getElementById('btn-menu');
  const isMobile = () => window.innerWidth <= 768;

  function updateMapLeft() {
    const hidden = sidebar.classList.contains('hidden');
    const left = (isMobile() || hidden) ? '0' : '';
    mapEl.style.left = left;
    const galleryBtn = document.getElementById('btn-gallery-toggle');
    const gallery = document.getElementById('tile-gallery');
    if (galleryBtn) galleryBtn.style.left = hidden ? '12px' : '';
    if (gallery) gallery.style.left = hidden ? '0' : '';
    getMap()?.resize();
  }

  btn.addEventListener('click', () => {
    if (isMobile()) {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('open', sidebar.classList.contains('open'));
    } else {
      sidebar.classList.toggle('hidden');
      updateMapLeft();
    }
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
}

// ── OAuth token from URL query parameter ──
function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    localStorage.setItem('token', token);
    // Remove token from URL without reloading (preserve path)
    const url = new URL(window.location);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  handleOAuthRedirect();
  initMap(() => {
    applyUrlPosition();
    applyPrefs();
    startUrlSync();
    setupCapture();
    // サイドバーのトグル
    document.querySelectorAll('.sidebar-toggle').forEach(h3 => {
      const target = h3.dataset.target;
      // 保存された状態を復元
      const saved = localStorage.getItem('section_' + target);
      if (saved === 'collapsed') {
        h3.classList.add('collapsed');
        if (target === 'layer-content') {
          const quick = document.getElementById('layer-quick');
          if (quick) quick.style.display = '';
        }
      }
      h3.addEventListener('click', (e) => {
        if (e.target.closest('#layer-quick')) return;
        h3.classList.toggle('collapsed');
        localStorage.setItem('section_' + target, h3.classList.contains('collapsed') ? 'collapsed' : 'open');
        // レイヤーのクイックアイコン表示切替（レイヤーセクションのみ）
        if (target === 'layer-content') {
          const quick = document.getElementById('layer-quick');
          if (quick) quick.style.display = h3.classList.contains('collapsed') ? '' : 'none';
        }
        // ML進捗クイック表示切替
        const mlQuick = document.getElementById('ml-quick');
        if (mlQuick && target === 'ml-content') mlQuick.style.display = h3.classList.contains('collapsed') && mlQuick.textContent ? '' : 'none';
      });
    });

    // レイヤークイックトグル
    function updateQuickIcons() {
      ['cs', 'photo', 'base'].forEach(layer => {
        const id = layer === 'cs' ? 'lq-cs' : layer === 'photo' ? 'lq-photo' : 'lq-base';
        const el = document.getElementById(id);
        if (el) el.style.opacity = document.getElementById(`cb-${layer}`).checked ? '1' : '0.3';
      });
      const exagEl = document.getElementById('lq-exag');
      if (exagEl) exagEl.style.opacity = document.getElementById('cb-exag').checked ? '1' : '0.3';
    }
    ['cs', 'photo', 'base'].forEach(layer => {
      const id = layer === 'cs' ? 'lq-cs' : layer === 'photo' ? 'lq-photo' : 'lq-base';
      document.getElementById(id)?.addEventListener('click', (e) => {
        e.stopPropagation();
        const cb = document.getElementById(`cb-${layer}`);
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
        updateQuickIcons();
      });
    });
    document.getElementById('lq-exag')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cb = document.getElementById('cb-exag');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
      updateQuickIcons();
    });
    updateQuickIcons();
  });
  await setupAuth();
  setupLayerControls();
  setupSidebarToggle();
  checkAuth();
});

// ── Authentication ──
let authProviders = [];

async function setupAuth() {
  const loginBtn = document.getElementById('btn-login');

  // プロバイダー一覧を取得し、未設定なら非表示
  try {
    const res = await fetch('/api/auth/providers');
    if (res.ok) authProviders = await res.json();
  } catch {}

  const hasGoogle = authProviders.some(p => p.id === 'google');
  if (!hasGoogle) {
    loginBtn.style.display = 'none';
    return;
  }

  // 未ログインなら「Google でログイン」表記、ログイン中なら「ログアウト」
  if (!window.__gs.currentUser) loginBtn.textContent = 'Google でログイン';

  loginBtn.addEventListener('click', () => {
    if (window.__gs.currentUser) {
      logout();
    } else {
      // モーダル経由せず即 OAuth へ
      location.href = '/api/auth/google/login';
    }
  });
}

async function checkAuth() {
  const token = localStorage.getItem('token');
  if (!token) {
    await setUser(null);
    return;
  }
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error();
    const user = await res.json();
    await setUser(user);
  } catch {
    localStorage.removeItem('token');
    await setUser(null);
  }
}

async function setUser(user) {
  window.__gs.currentUser = user;
  const info = document.getElementById('user-info');
  const btn = document.getElementById('btn-login');
  if (info) {
    info.textContent = '';
    info.hidden = !user;
  }
  if (user) {
    if (info) {
      if (user.avatar_url) {
        const img = document.createElement('img');
        img.src = user.avatar_url;
        img.alt = '';
        img.className = 'user-avatar';
        info.appendChild(img);
      }
      const label = user.display_name || user.email || '';
      if (label) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'user-name';
        nameSpan.textContent = label;
        nameSpan.style.cursor = 'pointer';
        nameSpan.onclick = () => {
          const modal = document.getElementById('account-modal');
          if (!modal) return;
          modal.classList.remove('hidden');
          const av = document.getElementById('account-avatar');
          const nm = document.getElementById('account-name');
          const em = document.getElementById('account-email');
          if (av && window.__gs.currentUser?.avatar_url) { av.src = window.__gs.currentUser.avatar_url; av.style.display = ''; }
          if (nm) nm.textContent = window.__gs.currentUser?.display_name || '';
          if (em) em.textContent = window.__gs.currentUser?.email || '';
        };
        info.appendChild(nameSpan);
      }
    }
    btn.textContent = 'ログアウト';
    // Lazily load account settings module
    try {
      const mod = await import('/account.js?v=398');
      window.__gsPrivate = mod;
      await mod.init();
    } catch (e) {
      console.error('Failed to load auth module:', e);
    }
    // Show auth-only elements after UI injection
    document.querySelectorAll('.auth-only').forEach(el => {
      el.style.display = '';
    });
  } else {
    btn.textContent = 'ログイン';
    // Hide auth-only elements
    document.querySelectorAll('.auth-only').forEach(el => {
      el.style.display = 'none';
    });
  }
}

function logout() {
  localStorage.removeItem('token');
  window.__gsPrivate?.onLogout();
  window.__gs.currentUser = null;
  // ログアウトしたことを視覚的にはっきりさせるためランディングへ遷移。
  // 地図 URL (/@...) で見ていた場合も同様に飛ばす。
  location.replace('/landing.html');
}

// ── Layer Preferences (localStorage) ──
const PREFS_KEY = 'geoscope_layer_prefs';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

function savePrefs(partial) {
  const prefs = { ...loadPrefs(), ...partial };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function applyPrefs() {
  const p = loadPrefs();
  ['cs', 'photo', 'base'].forEach(layer => {
    if (p[`${layer}_vis`] !== undefined) {
      const vis = p[`${layer}_vis`];
      document.getElementById(`cb-${layer}`).checked = vis;
      document.getElementById(`op-${layer}`).disabled = !vis;
      setLayerVisibility(layer, vis);
    }
    if (p[`${layer}_op`] !== undefined) {
      const op = p[`${layer}_op`];
      document.getElementById(`op-${layer}`).value = op * 100;
      setLayerOpacity(layer, op);
    }
  });
  if (p.exag !== undefined) {
    document.getElementById('exag').value = p.exag;
  }
  if (p.exagEnabled !== undefined) {
    document.getElementById('cb-exag').checked = p.exagEnabled;
  }
  {
    const cb = document.getElementById('cb-exag');
    const slider = document.getElementById('exag');
    const val = cb.checked ? parseFloat(slider.value) : 0;
    slider.disabled = !cb.checked;
    setTerrainExaggeration(val);
  }
  if (p.mapbox_token) {
    _updatePhotoSource(p.mapbox_token);
  }
}

// ── Layer Controls ──
function setupLayerControls() {
  ['cs', 'photo', 'base'].forEach(layer => {
    const cb = document.getElementById(`cb-${layer}`);
    const slider = document.getElementById(`op-${layer}`);
    slider.disabled = !cb.checked;
    cb.addEventListener('change', (e) => {
      setLayerVisibility(layer, e.target.checked);
      slider.disabled = !e.target.checked;
      savePrefs({ [`${layer}_vis`]: e.target.checked });
      const qid = layer === 'cs' ? 'lq-cs' : layer === 'photo' ? 'lq-photo' : 'lq-base';
      const qel = document.getElementById(qid);
      if (qel) qel.style.opacity = e.target.checked ? '1' : '0.3';
      if (window.__gs.galleryMode && window.__gs._renderGalleryView) {
        window.__gs._renderGalleryView();
      }
    });
    slider.addEventListener('input', (e) => {
      const op = e.target.value / 100;
      setLayerOpacity(layer, op);
      savePrefs({ [`${layer}_op`]: op });
    });
  });

  const exagSlider = document.getElementById('exag');
  const cbExag = document.getElementById('cb-exag');
  function applyExag() {
    const val = cbExag.checked ? parseFloat(exagSlider.value) : 0;
    setTerrainExaggeration(val);
    exagSlider.disabled = !cbExag.checked;
  }
  exagSlider.addEventListener('input', () => {
    const val = parseFloat(exagSlider.value);
    setTerrainExaggeration(val);
    savePrefs({ exag: val, exagEnabled: cbExag.checked });
  });
  cbExag.addEventListener('change', () => {
    applyExag();
    savePrefs({ exagEnabled: cbExag.checked });
  });

}

function _getPhotoTileUrl(z, x, y) {
  const token = loadPrefs().mapbox_token;
  if (token) return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${token}`;
  return `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`;
}

function _updatePhotoSource(token) {
  const map = getMap();
  if (!map) return;
  const url = token
    ? `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${token}`
    : 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
  const source = map.getSource('gsi-photo');
  if (source) {
    source.setUrl?.(url);
    // raster source doesn't have setUrl, need to update tiles
    map.removeLayer('photo');
    map.removeSource('gsi-photo');
    map.addSource('gsi-photo', { type: 'raster', tiles: [url], tileSize: token ? 512 : 256, maxzoom: token ? 22 : 18, attribution: token ? '© Mapbox' : '地理院タイル' });
    const p = loadPrefs();
    map.addLayer({ id: 'photo', type: 'raster', source: 'gsi-photo', layout: { visibility: p.photo_vis === false ? 'none' : 'visible' }, paint: { 'raster-opacity': p.photo_op ?? 1.0 } }, 'cs');
  }
}

// ── Map Capture (Shift+Drag for non-logged-in users) ──
let captureStart = null;
let captureBlob = null;

function setupCapture() {
  const map = getMap();
  const mapCanvas = map.getCanvas();
  const selBox = document.getElementById('capture-selection');
  let capturing = false;

  // Shift押下でカーソルを十字に
  const mapEl = document.getElementById('map');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !e.ctrlKey && !window.__gs.currentUser) {
      mapEl.classList.add('capture-ready');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') mapEl.classList.remove('capture-ready');
  });

  // MapLibreのcanvasで直接キャッチし、boxZoomより先に横取りする
  mapCanvas.addEventListener('mousedown', (e) => {
    if (!e.shiftKey || e.ctrlKey || window.__gs.currentUser) return;

    // MapLibreのboxZoomにイベントを渡さない
    e.stopImmediatePropagation();
    e.preventDefault();
    map.dragPan.disable();

    capturing = true;
    captureStart = { x: e.clientX, y: e.clientY };
    selBox.style.display = 'block';
    selBox.style.left = e.clientX + 'px';
    selBox.style.top = e.clientY + 'px';
    selBox.style.width = '0';
    selBox.style.height = '0';

    const onMove = (ev) => {
      if (!capturing) return;
      const x = Math.min(captureStart.x, ev.clientX);
      const y = Math.min(captureStart.y, ev.clientY);
      const w = Math.abs(ev.clientX - captureStart.x);
      const h = Math.abs(ev.clientY - captureStart.y);
      selBox.style.left = x + 'px';
      selBox.style.top = y + 'px';
      selBox.style.width = w + 'px';
      selBox.style.height = h + 'px';
    };

    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      if (!capturing) return;
      capturing = false;
      map.dragPan.enable();

      selBox.style.display = 'none';
      const x = Math.min(captureStart.x, ev.clientX);
      const y = Math.min(captureStart.y, ev.clientY);
      const w = Math.abs(ev.clientX - captureStart.x);
      const h = Math.abs(ev.clientY - captureStart.y);
      captureStart = null;

      if (w < 20 || h < 20) return;
      captureRegion(x, y, w, h);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }, { capture: true });

  // Escape key to close capture overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const captureEl = document.getElementById('capture-overlay');
      if (captureEl && captureEl.style.display !== 'none') {
        captureEl.style.display = 'none';
      }
    }
  });

  // ボタンはイベント委譲で処理
  document.getElementById('capture-overlay')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();
    if (btn.id === 'capture-x') { shareToX(); return; }
    else if (btn.id === 'capture-copy') { copyCapture(); return; }
    else if (btn.id === 'capture-dl') { downloadCapture(); return; }
    else if (btn.id === 'capture-close') {
      document.getElementById('capture-overlay').style.display = 'none';
    }
  });
}

function captureRegion(screenX, screenY, w, h) {
  const map = getMap();
  if (!map) return;
  const mapCanvas = map.getCanvas();
  const ratio = window.devicePixelRatio || 1;

  // 地図キャンバスの位置を取得
  const mapRect = mapCanvas.getBoundingClientRect();
  const sx = (screenX - mapRect.left) * ratio;
  const sy = (screenY - mapRect.top) * ratio;
  const sw = w * ratio;
  const sh = h * ratio;

  // キャプチャ用キャンバス作成
  const canvas = document.getElementById('capture-canvas');
  const attrH = 24;
  canvas.width = sw;
  canvas.height = sh + attrH * ratio;
  const ctx = canvas.getContext('2d');

  // 地図領域をコピー
  ctx.drawImage(mapCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // アトリビューション合成
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, sh, sw, attrH * ratio);
  ctx.fillStyle = '#fff';
  ctx.font = `${11 * ratio}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  // 地図の中心座標を取得
  const center = map.getCenter();
  const zoom = map.getZoom().toFixed(1);
  const lat = center.lat.toFixed(5);
  const lon = center.lng.toFixed(5);
  const attrText = `GeoScope (geoscope.jp) | 赤色立体地図: DEM 国土地理院 | ${lat}, ${lon} z${zoom}`;
  ctx.fillText(attrText, sw - 4 * ratio, sh + attrH * ratio / 2);

  // blob を事前生成
  canvas.toBlob((blob) => { captureBlob = blob; }, 'image/png');

  // URL表示
  const shareUrl = `${location.origin}/@${zoom}/${lat}/${lon}/0/60`;
  const urlEl = document.getElementById('capture-url');
  urlEl.textContent = shareUrl;
  const urlIcon = document.getElementById('capture-url-icon');
  urlEl.parentElement.onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      urlIcon.textContent = '✓';
      setTimeout(() => { urlIcon.textContent = '📋'; }, 2000);
    } catch (e) { /* ignore */ }
  };

  // プレビュー表示
  document.getElementById('capture-overlay').style.display = '';
}

async function shareToX() {
  const map = getMap();
  const center = map?.getCenter();
  const zoom = map?.getZoom()?.toFixed(1) || '15';
  const lat = center?.lat?.toFixed(5) || '35';
  const lon = center?.lng?.toFixed(5) || '135';
  const url = `${location.origin}/@${zoom}/${lat}/${lon}/0/60`;
  const text = `${url}`;

  if (captureBlob) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': captureBlob })
      ]);
    } catch (e) {
      console.warn('Clipboard copy failed:', e);
    }
  }

  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');

  const btn = document.getElementById('capture-x');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ コピー済み！Xで Ctrl+V で貼り付け';
    setTimeout(() => { btn.textContent = orig; }, 5000);
  }
}

async function copyCapture() {
  if (!captureBlob) return;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': captureBlob })
    ]);
    const btn = document.getElementById('capture-copy');
    btn.textContent = '✓ コピー済み';
    setTimeout(() => { btn.textContent = '📋 コピー'; }, 2000);
  } catch (e) {
    alert('クリップボードへのコピーに失敗しました');
  }
}

function downloadCapture() {
  const canvas = document.getElementById('capture-canvas');
  const a = document.createElement('a');
  a.download = 'geoscope_capture.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}

// Migration: 古い形式を削除
(function migrate() {
  localStorage.removeItem('geoscope_filters');
  localStorage.removeItem('geoscope_filter_rows');
})();
