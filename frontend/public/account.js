// GeoScope private module — loaded dynamically after login
import { getMap, setCurrentMode, setMapLocked, onAnnotationClick, onMapClickEmpty, onAnnotationDblClick, onAnnotationRightClick, onAnnotationResized, showResizeHandles, clearResizeHandles, updateAnnotations, fitBoundsCompat } from '/map.js?v=398';
import { enableDraw, disableDraw, renderAnnotationList, annotationsToGeoJSON } from '/draw.js?v=398';
import { initGallery, loadDetections, showGallery, hideGallery } from '/gallery.js?v=398';

const S = window.__gs;

// ── Local state (private module only) ──
let _authUIInjected = false;
let jobsPollTimer = null;
let jobsPollInterval = 5000;
let jobsPollPrevFingerprint = '';
const JOBS_POLL_MIN = 5000;
const JOBS_POLL_MAX = 60000;
const JOBS_POLL_GROWTH = 1.618;
let detectionsVisible = false;
let detectionsPollTimer = null;
const _scanRegionLayers = new Map(); // jobId -> sourceId

// ── Review state ──
let reviewItems = [];
let reviewIdx = 0;
let reviewLabelName = null;
let reviewBbox = null;
let reviewDragging = false;
let reviewDragStart = null;
let reviewZoom = 1;
let reviewPanX = 0;
let reviewPanY = 0;

let customFilterFn = null;
let customFilterLabel = '';

const ANNOTATION_LABEL = '\u30a2\u30ce\u30c6\u30fc\u30b7\u30e7\u30f3';

// ── Exported lifecycle ──
export async function init() {
  // Expose gallery re-render for app.js layer controls
  S._renderGalleryView = renderGalleryView;

  // Inject auth UI first (creates DOM elements needed by other setup)
  _injectAuthUI();

  setupProjectControls();
  setupModeButtons();
  setupGalleryToggle();

  // Map callbacks
  onMapClickEmpty(() => {
    S.selectedAnnotationIdx = null;
    updateSelectionOnly();
    hideDetailPanel();
    clearResizeHandles();
  });

  document.getElementById('detail-close')?.addEventListener('click', () => {
    S.selectedAnnotationIdx = null;
    updateSelectionOnly();
    hideDetailPanel();
    clearResizeHandles();
  });

  onAnnotationClick((idx) => {
    S.selectedAnnotationIdx = idx;
    updateSelectionOnly();
    const filtered = filterAnnotations(S.annotations);
    if (filtered[idx]) showDetailPanel(filtered[idx]);
    const listEl = document.getElementById('annotation-list');
    const selected = listEl?.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  });

  onAnnotationDblClick((idx) => {
    const filtered = filterAnnotations(S.annotations);
    if (idx >= 0 && idx < filtered.length) {
      const realIdx = S.annotations.findIndex(a => a.id === filtered[idx].id);
      if (realIdx >= 0) handleEditAnnotation(realIdx);
    }
  });

  // Shift key handlers for annotation resize
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') S._shiftHeld = true;
    if (e.key !== 'Shift' || e.ctrlKey || S.selectedAnnotationIdx === null) return;
    if (e.target.closest('input,textarea,select,button,.modal-overlay,#detail-panel')) return;
    const map = getMap();
    if (!map) return;
    if (S.savedPitch === null) {
      S.savedPitch = map.getPitch();
      S.savedBearing = map.getBearing();
    }
    map.easeTo({ pitch: 0, bearing: 0, duration: 300 });
    map.dragRotate.disable();
    map.boxZoom.disable();
    const filtered = filterAnnotations(S.annotations);
    if (filtered[S.selectedAnnotationIdx]) {
      showResizeHandles([filtered[S.selectedAnnotationIdx]]);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') S._shiftHeld = false;
    if (e.key !== 'Shift') return;
    if (!S.addingMode) {
      clearResizeHandles();
      const map = getMap();
      if (map) {
        map.dragRotate.enable();
        map.boxZoom.enable();
        if (S.savedPitch !== null) {
          map.easeTo({ pitch: S.savedPitch, bearing: S.savedBearing, duration: 300 });
          S.savedPitch = null;
          S.savedBearing = null;
        }
      }
    }
  });

  onAnnotationRightClick((filteredIdx, lngLat) => {
    const filtered = filterAnnotations(S.annotations);
    if (filteredIdx >= 0 && filteredIdx < filtered.length) {
      const a = filtered[filteredIdx];
      const title = a.title || `#${filteredIdx + 1}`;
      if (confirm(`\u300c${title}\u300d\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f`)) {
        handleDeleteAnnotation(filteredIdx);
      }
    }
  });

  onAnnotationResized(async (annotationId, newBbox) => {
    const realIdx = S.annotations.findIndex(x => x.id === annotationId);
    if (realIdx < 0) return;
    const a = S.annotations[realIdx];

    const [west, south, east, north] = newBbox;
    const lat = (south + north) / 2;
    const lon = (west + east) / 2;
    const z = 16, TILE_PX = 512, n = Math.pow(2, z);
    const tx = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    const px = ((lon + 180) / 360 * n - tx) * TILE_PX;
    const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
    const lonPerPx = 360 / n / TILE_PX;
    const widthPx = Math.abs(east - west) / lonPerPx;
    const northRad = north * Math.PI / 180;
    const southRad = south * Math.PI / 180;
    const northPy = ((1 - Math.log(Math.tan(northRad) + 1 / Math.cos(northRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
    const southPy = ((1 - Math.log(Math.tan(southRad) + 1 / Math.cos(southRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
    const heightPx = Math.abs(southPy - northPy);

    S.annotations[realIdx].bbox = newBbox;
    S.annotations[realIdx].geometry = {
      type: 'Polygon',
      coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]]
    };

    // UI即更新（DB保存は非同期）
    updateSelectionOnly();
    if (S._shiftHeld && S.selectedAnnotationIdx !== null) {
      const filt = filterAnnotations(S.annotations);
      if (filt[S.selectedAnnotationIdx]) showResizeHandles([filt[S.selectedAnnotationIdx]]);
    } else {
      clearResizeHandles();
    }

    // DB保存（fire-and-forget）
    const token = localStorage.getItem('token');
    fetch(`/api/annotations/${a.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        lat, lon,
        bbox_px_cx: px / TILE_PX,
        bbox_px_cy: py / TILE_PX,
        bbox_px_w: widthPx / TILE_PX,
        bbox_px_h: heightPx / TILE_PX,
        tile_x: tx, tile_y: ty, tile_z: z,
      })
    }).catch(e => console.error('Failed to update bbox:', e));
  });

  // Enable draw (Shift+drag to add, disabled when annotation selected)
  enableDraw(handleAnnotationCreated, () => S.selectedAnnotationIdx !== null);

  // Keyboard shortcuts
  document.addEventListener('keydown', _keydownHandler);

  initGallery({ projectId: null, feedbackCallback: null });

  // Load projects and data
  await loadProjects();
}

export function onLogout() {
  if (_authUIInjected) _removeAuthUI();
  disableDraw();
  S.currentProject = null;
  S.projects = [];
  S.annotations = [];
  S._filteredCache = null;
  if (S.galleryMode) toggleGallery(false);
  const gallery = document.getElementById('tile-gallery');
  if (gallery) gallery.style.display = 'none';
  const bulkBar = document.getElementById('gallery-actions');
  if (bulkBar) bulkBar.style.display = 'none';
  markGeoJSONDirty();
  refreshAnnotationList();
  renderProjectSelect();
  if (jobsPollTimer) { clearTimeout(jobsPollTimer); jobsPollTimer = null; }
  if (detectionsPollTimer) { clearInterval(detectionsPollTimer); detectionsPollTimer = null; }
  document.removeEventListener('keydown', _keydownHandler);
}

// ── Keyboard handler ──
function _keydownHandler(e) {
  // Tab: next/prev annotation
  if (e.key === 'Tab' && !e.target.closest('input,textarea,select,.modal-overlay,.label-manager-overlay')) {
    e.preventDefault();
    const filtered = filterAnnotations(S.annotations);
    if (!filtered.length) return;
    let nextIdx;
    if (S.selectedAnnotationIdx === null) {
      nextIdx = 0;
    } else {
      nextIdx = e.shiftKey ? S.selectedAnnotationIdx - 1 : S.selectedAnnotationIdx + 1;
      if (nextIdx < 0) nextIdx = filtered.length - 1;
      if (nextIdx >= filtered.length) nextIdx = 0;
    }
    S.selectedAnnotationIdx = nextIdx;
    const a = filtered[nextIdx];
    if (a?.bbox) {
      const [w, s, ee, n] = a.bbox;
      const map = getMap();
      fitBoundsCompat([[w, s], [ee, n]], { padding: 80, maxZoom: 18, animate: false });
    }
    showDetailPanel(a);
    updateSelectionOnly();
    const selected = document.getElementById('annotation-list')?.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
    return;
  }

  // Capture panel: Esc to close
  if (e.key === 'Escape') {
    const captureEl = document.getElementById('capture-overlay');
    if (captureEl && captureEl.style.display !== 'none') {
      captureEl.style.display = 'none';
      return;
    }
  }

  // Review shortcuts
  const reviewEl = document.getElementById('review-overlay');
  if (!reviewEl || reviewEl.style.display === 'none') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === ' ' || e.key === 'y' || e.key === 'o') {
    e.preventDefault();
    if (!document.getElementById('review-yes').disabled) reviewVote('yes');
  } else if (e.key === 'x' || e.key === 'n') {
    reviewVote('no');
  } else if (e.key === 's') {
    reviewVote('pass');
  } else if (e.key === 'ArrowRight') {
    reviewIdx++;
    if (reviewIdx >= reviewItems.length) reviewIdx = reviewItems.length - 1;
    reviewBbox = null;
    loadReviewTile();
  } else if (e.key === 'ArrowLeft' || e.key === 'z') {
    reviewIdx = Math.max(0, reviewIdx - 1);
    reviewBbox = null;
    loadReviewTile();
  } else if (e.key === 'Escape') {
    closeReview();
  }
}

// ── Auth UI injection ──
function _injectAuthUI() {
  if (_authUIInjected) return;
  _authUIInjected = true;

  // Sidebar auth content
  const authSlot = document.getElementById('auth-content-slot');
  if (authSlot) authSlot.innerHTML = `
  <div class="auth-only">
    <hr style="border:none;border-top:1px solid #2a2a4a;margin:8px 0;">
    <h3 class="sidebar-toggle" data-target="filter-content">\u30d5\u30a3\u30eb\u30bf\u30fc</h3>
    <div id="filter-content"><div id="filter-builder" style="margin-bottom:6px;"></div></div>
    <h3 class="sidebar-toggle" data-target="favorites-content">\u304a\u6c17\u306b\u5165\u308a</h3>
    <div id="favorites-content">
      <div id="draw-info" style="display:none;"><p style="font-size:12px;color:#888;"><kbd>Shift</kbd>+\u30c9\u30e9\u30c3\u30b0\u3067\u7bc4\u56f2\u3092\u9078\u629e / \u30b9\u30de\u30db\u306f\u9577\u62bc\u3057+\u30c9\u30e9\u30c3\u30b0</p></div>
      <div id="annotation-list"></div><div id="annotation-list-placeholder"></div>
    </div>
    <h3 class="sidebar-toggle" data-target="ml-content">\u63a2\u7d22<span id="ml-quick" style="display:none;margin-left:8px;font-size:11px;font-weight:normal;color:#6bcfff;"></span></h3>
    <div id="ml-content">
      <div style="display:flex;gap:4px;margin-bottom:6px;align-items:center;">
        <select id="scan-region" style="font-size:11px;background:#16213e;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:1px 4px;">
          <option value="">\u5168\u56fd</option>
          <option value="\u5317\u6d77\u9053">\u5317\u6d77\u9053</option><option value="\u9752\u68ee\u770c">\u9752\u68ee</option><option value="\u5ca9\u624b\u770c">\u5ca9\u624b</option><option value="\u5bae\u57ce\u770c">\u5bae\u57ce</option>
          <option value="\u79cb\u7530\u770c">\u79cb\u7530</option><option value="\u5c71\u5f62\u770c">\u5c71\u5f62</option><option value="\u798f\u5cf6\u770c">\u798f\u5cf6</option><option value="\u8328\u57ce\u770c">\u8328\u57ce</option>
          <option value="\u6803\u6728\u770c">\u6803\u6728</option><option value="\u7fa4\u99ac\u770c">\u7fa4\u99ac</option><option value="\u57fc\u7389\u770c">\u57fc\u7389</option><option value="\u5343\u8449\u770c">\u5343\u8449</option>
          <option value="\u6771\u4eac\u90fd">\u6771\u4eac</option><option value="\u795e\u5948\u5ddd\u770c">\u795e\u5948\u5ddd</option><option value="\u65b0\u6f5f\u770c">\u65b0\u6f5f</option><option value="\u5bcc\u5c71\u770c">\u5bcc\u5c71</option>
          <option value="\u77f3\u5ddd\u770c">\u77f3\u5ddd</option><option value="\u798f\u4e95\u770c">\u798f\u4e95</option><option value="\u5c71\u68a8\u770c">\u5c71\u68a8</option><option value="\u9577\u91ce\u770c">\u9577\u91ce</option>
          <option value="\u5c90\u961c\u770c">\u5c90\u961c</option><option value="\u9759\u5ca1\u770c">\u9759\u5ca1</option><option value="\u611b\u77e5\u770c">\u611b\u77e5</option><option value="\u4e09\u91cd\u770c">\u4e09\u91cd</option>
          <option value="\u6ecb\u8cc0\u770c">\u6ecb\u8cc0</option><option value="\u4eac\u90fd\u5e9c">\u4eac\u90fd</option><option value="\u5927\u962a\u5e9c">\u5927\u962a</option><option value="\u5175\u5eab\u770c">\u5175\u5eab</option>
          <option value="\u5948\u826f\u770c">\u5948\u826f</option><option value="\u548c\u6b4c\u5c71\u770c">\u548c\u6b4c\u5c71</option><option value="\u9ce5\u53d6\u770c">\u9ce5\u53d6</option><option value="\u5cf6\u6839\u770c">\u5cf6\u6839</option>
          <option value="\u5ca1\u5c71\u770c">\u5ca1\u5c71</option><option value="\u5e83\u5cf6\u770c">\u5e83\u5cf6</option><option value="\u5c71\u53e3\u770c">\u5c71\u53e3</option><option value="\u5fb3\u5cf6\u770c">\u5fb3\u5cf6</option>
          <option value="\u9999\u5ddd\u770c">\u9999\u5ddd</option><option value="\u611b\u5a9b\u770c">\u611b\u5a9b</option><option value="\u9ad8\u77e5\u770c">\u9ad8\u77e5</option><option value="\u798f\u5ca1\u770c">\u798f\u5ca1</option>
          <option value="\u4f50\u8cc0\u770c">\u4f50\u8cc0</option><option value="\u9577\u5d0e\u770c">\u9577\u5d0e</option><option value="\u718a\u672c\u770c">\u718a\u672c</option><option value="\u5927\u5206\u770c">\u5927\u5206</option>
          <option value="\u5bae\u5d0e\u770c">\u5bae\u5d0e</option><option value="\u9e7f\u5150\u5cf6\u770c">\u9e7f\u5150\u5cf6</option><option value="\u6c96\u7e04\u770c">\u6c96\u7e04</option>
        </select>
        <select id="scan-precision" style="font-size:11px;background:#16213e;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:1px 4px;">
          <option value="0.5">\u53b3\u9078</option><option value="0.3" selected>\u63a8\u5968</option><option value="0.2">\u7db2\u7f85</option>
        </select>
        <button class="btn btn-sm btn-outline" id="btn-scan" title="\u30b9\u30ad\u30e3\u30f3\u958b\u59cb">\u63a2\u7d22</button>
      </div>
      <div id="job-toast-inline" style="display:none;margin-bottom:4px;padding:6px;background:#16213e;border-radius:4px;font-size:12px;">
        <div id="job-msg"></div>
        <div style="height:4px;background:#2a2a4a;border-radius:2px;margin-top:4px;overflow:hidden;">
          <div id="job-bar" style="height:100%;background:#3b82f6;width:0%;transition:width 0.3s;"></div>
        </div>
      </div>
      <div id="jobs-dashboard"></div>
    </div>
  </div>`;

  // Gallery
  const gallerySlot = document.getElementById('gallery-slot');
  if (gallerySlot) gallerySlot.innerHTML = `
  <button id="btn-gallery-toggle" class="auth-only" title="\u5730\u56f3/\u30bf\u30a4\u30eb\u5207\u66ff">\ud83d\uddbc</button>
  <div id="tile-gallery" style="display:none;">
    <div id="gallery-actions" style="display:flex;gap:4px;flex-wrap:wrap;padding:4px 8px;font-size:11px;align-items:center;background:#1a1a2e;margin:0;">
      <a class="btn btn-sm btn-outline" id="btn-export-geojson" title="GeoJSON\u30a8\u30af\u30b9\u30dd\u30fc\u30c8(bbox)">\ud83d\udce5 GeoJSON</a>
      <a class="btn btn-sm btn-outline" id="btn-export-geojson-points" title="GeoJSON\u30a8\u30af\u30b9\u30dd\u30fc\u30c8(\u30dd\u30a4\u30f3\u30c8)">\ud83d\udccd Points</a>
      <a class="btn btn-sm btn-outline" id="btn-export-csv" title="CSV\u30a8\u30af\u30b9\u30dd\u30fc\u30c8">\ud83d\udce5 CSV</a>
      <a class="btn btn-sm btn-outline" id="btn-export-sheets" title="Google Sheets\u7528CSV\uff08\u30b5\u30e0\u30cd\u30a4\u30eb\u4ed8\u304d\uff09">\ud83d\udcca Sheets</a>
      <a class="btn btn-sm btn-outline" id="btn-export-umap" title="uMap\u7528GeoJSON\uff08\u540d\u524d\u30fb\u30e9\u30d9\u30eb\u30fbGeoScope\u30ea\u30f3\u30af\u4ed8\u304d\uff09">\ud83d\udccd uMap</a>
      <label class="btn btn-sm btn-outline" style="cursor:pointer;" title="\u30a4\u30f3\u30dd\u30fc\u30c8">\ud83d\udce4 \u30a4\u30f3\u30dd\u30fc\u30c8<input type="file" id="btn-import" accept=".geojson,.csv" style="display:none;"></label>
      <span id="bulk-edit-actions">
        <button class="btn btn-sm btn-outline" id="btn-bulk-label">\ud83c\udff7 \u30e9\u30d9\u30eb\u8ffd\u52a0</button>
        <button class="btn btn-sm btn-outline" id="btn-bulk-vote-yes">\u2b55</button>
        <button class="btn btn-sm btn-outline" id="btn-bulk-vote-no">\u274c</button>
        <button class="btn btn-sm btn-outline" id="btn-bulk-vote-pass">\u2753</button>
        <button class="btn btn-sm btn-outline" id="btn-bulk-vote-clear">🈚</button>
        <button class="btn btn-sm btn-outline" id="btn-enrich-google" title="Google Places API\u3067\u540d\u524d\u3092\u4ed8\u4e0e">\ud83d\udccd Google</button>
        <button class="btn btn-sm btn-outline" id="btn-rescore" title="\u6700\u65b0\u30e2\u30c7\u30eb\u3067\u518d\u5b66\u7fd2+\u30d5\u30a3\u30eb\u30bf\u7d50\u679c\u3092\u518d\u30b9\u30b3\u30a2\u30ea\u30f3\u30b0">\ud83c\udfaf \u518d\u30b9\u30b3\u30a2</button>
        <button class="btn btn-sm btn-outline" id="btn-dedup" title="\u91cd\u306a\u308bbbox\u306e\u3046\u3061\u30b9\u30b3\u30a2\u4f4e\u3044\u65b9\u3092\u524a\u9664">\ud83d\udd04 \u91cd\u8907\u9664\u53bb</button>
        <button class="btn btn-sm btn-outline" id="btn-delete-notile" style="color:#ff6b6b;" title="DEM\u30bf\u30a4\u30eb\u304c\u306a\u3044\u304a\u6c17\u306b\u5165\u308a\u3092\u524a\u9664">\ud83d\uddd1 \u5730\u56f3\u306a\u3057</button>
        <button class="btn btn-sm btn-outline" id="btn-bulk-delete" style="color:#ff6b6b;">\ud83d\uddd1 \u4e00\u62ec\u524a\u9664</button>
      </span>
    </div>
    <div id="tile-gallery-grid"></div>
  </div>`;

  // Detection modal
  const detSlot = document.getElementById('detection-modal-slot');
  if (detSlot) detSlot.innerHTML = `
  <div id="detection-modal">
    <div class="modal-content">
      <img id="det-modal-img" src="" alt="">
      <div class="modal-body">
        <p><strong>\u4fe1\u983c\u5ea6:</strong> <span id="det-modal-conf"></span></p>
        <p><strong>\u5ea7\u6a19:</strong> <span id="det-modal-coords"></span></p>
        <p><strong>\u30bf\u30a4\u30eb:</strong> <span id="det-modal-tile"></span></p>
        <div class="modal-actions">
          <button class="btn btn-success" id="det-modal-yes">Yes</button>
          <button class="btn btn-danger" id="det-modal-no">No</button>
          <button class="btn btn-outline" id="det-modal-skip">\u30b9\u30ad\u30c3\u30d7</button>
          <div class="spacer" style="flex:1;"></div>
          <button class="btn btn-outline" id="det-modal-close">\u9589\u3058\u308b</button>
        </div>
      </div>
    </div>
  </div>`;

  // Account modal
  const accSlot = document.getElementById('account-modal-slot');
  if (accSlot) accSlot.innerHTML = `
  <div id="account-modal" class="modal-overlay hidden">
    <div class="modal" style="position:relative;">
      <button aria-label="\u9589\u3058\u308b" onclick="document.getElementById('account-modal').classList.add('hidden')" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;padding:4px 8px;">\u2715</button>
      <h2>\u30a2\u30ab\u30a6\u30f3\u30c8\u8a2d\u5b9a</h2>
      <div style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <img id="account-avatar" src="" alt="" style="width:40px;height:40px;border-radius:50%;display:none;">
          <div><div id="account-name" style="font-size:14px;font-weight:bold;"></div><div id="account-email" style="font-size:12px;color:#888;"></div></div>
        </div>
      </div>

      <!-- タブ -->
      <div id="account-tabs" style="display:flex;gap:0;border-bottom:1px solid #2a2a4a;margin-bottom:16px;">
        <button class="acc-tab acc-tab-active" data-tab="gpu" style="flex:1;padding:8px 12px;background:none;border:none;border-bottom:2px solid #6bcfff;color:#6bcfff;cursor:pointer;font-size:13px;">🚀 探索GPU</button>
        <button class="acc-tab" data-tab="other" style="flex:1;padding:8px 12px;background:none;border:none;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">⚙️ その他</button>
      </div>

      <!-- GPU タブ -->
      <div data-tab-pane="gpu">

      <!-- 探索の実行環境 -->
      <div style="margin-bottom:16px;padding:12px;background:#1a1f2e;border:1px solid #2a3a5a;border-radius:6px;">
        <div style="font-size:13px;color:#6bcfff;margin-bottom:8px;font-weight:bold;">🚀 探索の実行環境</div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;margin-bottom:4px;cursor:pointer;">
          <input type="radio" name="worker-mode" value="cloud" id="wm-cloud"> ☁️ RunPod クラウド GPU (推奨、手元のマシン不要)
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;cursor:pointer;">
          <input type="radio" name="worker-mode" value="local" id="wm-local"> 💻 ローカル GPU (上級者向け)
        </label>
      </div>

      <!-- クラウドモード設定 -->
      <div id="cloud-config" style="margin-bottom:20px;">
        <div style="margin-bottom:12px;padding:10px;background:#131825;border:1px solid #2a2a4a;border-radius:6px;">
          <div style="font-size:12px;color:#aaa;margin-bottom:6px;">探索モード</div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;margin:3px 0;cursor:pointer;">
            <input type="radio" name="scan-mode" value="cheap" id="sm-cheap"> 🐌 節約 — Community 4090、500〜700円/scan、在庫切れ時は待ち
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;margin:3px 0;cursor:pointer;">
            <input type="radio" name="scan-mode" value="balanced" id="sm-balanced"> ⚖️ 標準 — Secure 4090、約800円/scan (推奨)
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;margin:3px 0;cursor:pointer;">
            <input type="radio" name="scan-mode" value="fast" id="sm-fast"> ⚡ 急ぎ — Secure + 高性能 GPU、800〜1500円/scan
          </label>
        </div>

        <div style="padding:12px;background:#1a1f2e;border:1px solid #2a3a5a;border-radius:6px;">
          <div style="font-size:13px;color:#6bcfff;margin-bottom:4px;font-weight:bold;">🔑 RunPod API Key <span style="color:#f88;font-weight:normal;margin-left:4px;">クラウドモード必須</span></div>
          <div style="font-size:11px;color:#aaa;margin-bottom:8px;line-height:1.5;">
            探索はあなた自身の RunPod アカウントの GPU Pod 上で実行されます。<a href="https://www.runpod.io/console/user/settings" target="_blank" rel="noopener noreferrer" style="color:#6bcfff;">RunPod 設定画面</a> で API key を発行 → 下の欄に貼り付けて「検証」。
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="password" id="runpod-api-key" placeholder="rpa_..." autocomplete="off" style="flex:1;font-size:12px;padding:6px 8px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#6bcfff;box-sizing:border-box;">
            <button class="btn btn-sm btn-outline" id="btn-verify-runpod">検証</button>
          </div>
          <div id="runpod-key-status" style="font-size:11px;margin-top:4px;min-height:14px;color:#888;"></div>
          <div style="font-size:11px;color:#888;margin-top:8px;line-height:1.5;">
            ・キーはブラウザの localStorage のみに保存。探索時のみサーバーに送信され、Job 完了時に削除<br>
            ・RunPod 未登録の方は招待リンク <a href="https://runpod.io?ref=ok9s0q0q" target="_blank" rel="noopener noreferrer" style="color:#6bcfff;">https://runpod.io?ref=ok9s0q0q</a> から登録 (運営にリワード)。非欧州ユーザーは登録ボーナス ($0〜$10、多くは $5)
          </div>
        </div>
      </div>

      <!-- ローカルモード設定 -->
      <div id="local-config" style="display:none;margin-bottom:20px;padding:12px;background:#1a1f2e;border:1px solid #2a3a5a;border-radius:6px;">
        <div style="font-size:13px;color:#6bcfff;margin-bottom:6px;font-weight:bold;">💻 ローカル GPU セットアップ</div>
        <div style="font-size:11px;color:#aaa;margin-bottom:8px;line-height:1.6;">
          自分の RTX 搭載マシン (NVIDIA GPU + Docker + nvidia-container-toolkit) で以下を実行すれば、そのマシンが探索を処理します。
        </div>
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">あなたのワーカー API キー (秘密):</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">
          <code id="local-api-key" style="flex:1;font-size:11px;padding:6px 8px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#6bcfff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">読み込み中...</code>
          <button class="btn btn-sm btn-outline" id="btn-copy-local-key">📋</button>
          <button class="btn btn-sm btn-outline" id="btn-regen-local-key" title="再生成 (旧キーは無効化)">↻</button>
        </div>
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">オプション:</div>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ccc;margin:3px 0;cursor:pointer;">
          <input type="checkbox" id="local-opt-restart"> 自動再起動 (PC 再起動・コンテナクラッシュ時に復活)
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ccc;margin:3px 0 8px;cursor:pointer;">
          <input type="checkbox" id="local-opt-cache"> DEM キャッシュ保存 (~/geoscope-cache、次回スキャンを高速化、最大 168GB)
        </label>
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Docker 起動コマンド:</div>
        <pre id="local-docker-cmd" style="font-size:10px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#ddd;padding:8px;overflow-x:auto;white-space:pre;line-height:1.5;margin:0 0 8px;"></pre>
        <button class="btn btn-sm btn-outline" id="btn-copy-docker-cmd" style="font-size:11px;">📋 コマンドをコピー</button>
        <div style="font-size:11px;color:#888;margin-top:8px;line-height:1.5;">
          ・初回起動時に YOLO26n model (~10MB) を取得、scan 中は DEM tiles を <code>geoscope.jp</code> から都度 fetch<br>
          ・ワーカーが起動していないと「探索」ボタンを押してもジョブが queued のまま (動き出さない)<br>
          ・複数台で動かせば並列処理されます (同じ WORKER_API_KEY を全台に設定)
        </div>
      </div>

      </div><!-- /tab-pane gpu -->

      <!-- その他タブ -->
      <div data-tab-pane="other" style="display:none;">
      <div style="margin-bottom:16px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:4px;">Mapbox Token <span style="color:#666;font-weight:normal;">(任意)</span></div>
        <input type="text" id="mapbox-token" placeholder="pk.ey..." style="width:100%;font-size:12px;padding:6px 8px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#6bcfff;box-sizing:border-box;">
        <div style="font-size:11px;color:#888;margin-top:4px;line-height:1.4;">航空写真レイヤーを Mapbox の高解像度衛星画像に切り替えます。未設定なら国土地理院の航空写真を使用 (通常はこれで十分)。<a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noopener noreferrer" style="color:#6bcfff;">トークン取得</a></div>
      </div>
      <div style="margin-bottom:16px;">
        <div style="font-size:13px;color:#aaa;margin-bottom:4px;">Google API Key <span style="color:#666;font-weight:normal;">(任意)</span></div>
        <input type="text" id="google-api-key" placeholder="AIza..." style="width:100%;font-size:12px;padding:6px 8px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#6bcfff;box-sizing:border-box;">
        <div style="font-size:11px;color:#888;margin-top:4px;line-height:1.4;">検出結果のアノテーション近くにある場所名を Google Places API から自動付与する機能で使用 (「Google で名前付与」ボタン)。<a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener noreferrer" style="color:#6bcfff;">キー取得</a></div>
      </div>
      ${S.currentUser && S.currentUser.is_admin ? `
      <div style="margin-top:16px;padding:10px;background:#1a1f2e;border:1px solid #6bcfff33;border-radius:6px;">
        <a href="/admin.html" style="color:#6bcfff;text-decoration:none;font-size:13px;display:flex;align-items:center;gap:6px;">
          \ud83d\udee0\ufe0f \u7ba1\u7406\u30da\u30fc\u30b8\u3092\u958b\u304f
        </a>
      </div>
      ` : ''}
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #2a2a4a;">
        <button class="btn btn-outline" id="btn-delete-account" style="width:100%;color:#f88;border-color:#a44;">\u30a2\u30ab\u30a6\u30f3\u30c8\u524a\u9664</button>
        <div style="font-size:11px;color:#888;margin-top:6px;">
          \u81ea\u5206\u306e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u30fb\u30a2\u30ce\u30c6\u30fc\u30b7\u30e7\u30f3\u30fb\u30b8\u30e7\u30d6\u5c65\u6b74\u3092\u5b8c\u5168\u306b\u524a\u9664\u3057\u307e\u3059\u3002\u5fa9\u65e7\u4e0d\u53ef\u3002<br>
          RunPod \u4e0a\u306e Pod \u306f\u5225\u9014 RunPod \u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9\u3067\u505c\u6b62\u3057\u3066\u304f\u3060\u3055\u3044\u3002
        </div>
      </div>
      </div><!-- /tab-pane other -->
      <div style="margin-top:12px;font-size:11px;color:#888;text-align:center;">
        <a href="/help.html" target="_blank" style="color:#888;">\u306f\u3058\u3081\u3066\u30ac\u30a4\u30c9</a> \u00b7
        <a href="/terms.html" target="_blank" style="color:#888;">\u5229\u7528\u898f\u7d04</a> \u00b7
        <a href="/privacy.html" target="_blank" style="color:#888;">\u30d7\u30e9\u30a4\u30d0\u30b7\u30fc\u30dd\u30ea\u30b7\u30fc</a>
      </div>
    </div>
  </div>

  <div id="tos-modal" class="modal-overlay${S.currentUser && S.currentUser.tos_accepted_at ? ' hidden' : ''}" style="z-index:10000;">
    <div class="modal" style="max-width:520px;">
      <h2 style="margin-top:0;">\u5229\u7528\u898f\u7d04\u3078\u306e\u540c\u610f</h2>
      <p style="font-size:13px;line-height:1.6;">
        GeoScope \u3092\u3054\u5229\u7528\u3044\u305f\u3060\u304f\u306b\u306f\u3001\u4ee5\u4e0b\u306e\u540c\u610f\u304c\u5fc5\u8981\u3067\u3059:
      </p>
      <ul style="font-size:13px;line-height:1.7;">
        <li><a href="/terms.html" target="_blank" style="color:#6bcfff;">\u5229\u7528\u898f\u7d04</a></li>
        <li><a href="/privacy.html" target="_blank" style="color:#6bcfff;">\u30d7\u30e9\u30a4\u30d0\u30b7\u30fc\u30dd\u30ea\u30b7\u30fc</a></li>
      </ul>
      <p style="font-size:12px;color:#888;line-height:1.5;">
        \u7279\u306b\u91cd\u8981: \u63a2\u7d22\u30b8\u30e7\u30d6\u306f\u5229\u7528\u8005\u306e RunPod \u30a2\u30ab\u30a6\u30f3\u30c8\u4e0a\u3067\u5b9f\u884c\u3055\u308c\u3001\u6599\u91d1\u306f\u5229\u7528\u8005\u8ca0\u62c5\u3068\u306a\u308a\u307e\u3059\u3002
        RunPod API key \u306f\u30d6\u30e9\u30a6\u30b6\u306b\u4fdd\u5b58\u3055\u308c\u3001\u63a2\u7d22\u30ea\u30af\u30a8\u30b9\u30c8\u6642\u306b\u4e00\u6642\u7684\u306b\u30b5\u30fc\u30d0\u30fc\u3078\u9001\u4fe1\u3055\u308c Job \u5b8c\u4e86\u6642\u306b\u524a\u9664\u3055\u308c\u307e\u3059\u3002
      </p>
      <button class="btn" id="btn-accept-tos" style="width:100%;margin-top:16px;">\u540c\u610f\u3057\u3066\u7d9a\u884c</button>
    </div>
  </div>`;

  // Re-bind sidebar toggles for auth content
  document.querySelectorAll('#auth-content-slot .sidebar-toggle').forEach(h3 => {
    const targetId = h3.dataset.target;
    const content = document.getElementById(targetId);
    if (content) {
      h3.style.cursor = 'pointer';
      const saved = localStorage.getItem('section_' + targetId);
      if (saved === 'collapsed') {
        h3.classList.add('collapsed');
      }
      h3.addEventListener('click', () => {
        h3.classList.toggle('collapsed');
        localStorage.setItem('section_' + targetId, h3.classList.contains('collapsed') ? 'collapsed' : 'open');
      });
    }
  });

  _bindDynamicControls();

  // Show auth-only elements
  document.querySelectorAll('.auth-only').forEach(el => {
    el.style.display = '';
  });

}

// 探索リクエストに付与する BYO ヘッダを組み立てる
function _byoHeaders() {
  const h = {};
  const workerMode = localStorage.getItem('worker_mode') || 'cloud';
  h['X-Worker-Mode'] = workerMode;
  if (workerMode === 'cloud') {
    const runpodKey = localStorage.getItem('runpod_api_key') || '';
    if (runpodKey) h['X-RunPod-Api-Key'] = runpodKey;
    const scanMode = localStorage.getItem('scan_mode') || 'balanced';
    h['X-Scan-Mode'] = scanMode;
  }
  return h;
}

// RunPod キーの「検証済みロック」UI 状態を反映
function _setRunpodLocked(locked) {
  const input = document.getElementById('runpod-api-key');
  const button = document.getElementById('btn-verify-runpod');
  if (input) {
    input.readOnly = !!locked;
    input.style.background = locked ? '#0a1525' : '#0d1117';
    input.style.color = locked ? '#888' : '#6bcfff';
  }
  if (button) {
    button.textContent = locked ? '変更' : '検証';
  }
}

// 「探索」ボタンの活性/非活性を worker_mode + verified に応じて切替
function _updateScanButton() {
  const workerMode = localStorage.getItem('worker_mode') || 'cloud';
  const verified = localStorage.getItem('runpod_verified') === '1';
  // local モードはいつでも有効 (worker 起動状況は backend で polling される)
  // cloud モードは runpod_verified が必須
  const ok = workerMode === 'local' || verified;
  const btn = document.getElementById('btn-scan');
  if (!btn) return;
  btn.disabled = !ok;
  btn.style.opacity = ok ? '' : '0.5';
  btn.style.cursor = ok ? 'pointer' : 'not-allowed';
  if (ok) {
    btn.title = workerMode === 'local'
      ? 'スキャン開始 (ローカルワーカーが処理)'
      : 'スキャン開始';
  } else {
    btn.title = 'アカウント設定で RunPod API Key を検証してください';
  }
}

// worker_mode (cloud/local) の切替に伴う UI 更新
function _applyWorkerMode(mode) {
  const cloud = document.getElementById('cloud-config');
  const local = document.getElementById('local-config');
  if (cloud) cloud.style.display = mode === 'local' ? 'none' : '';
  if (local) local.style.display = mode === 'local' ? '' : 'none';
  // ローカルモード初期化: ワーカー API キー + docker コマンドを描画
  if (mode === 'local') _renderLocalConfig();
  _updateScanButton();
}

function _renderLocalConfig() {
  const keyEl = document.getElementById('local-api-key');
  const cmdEl = document.getElementById('local-docker-cmd');
  const restartCb = document.getElementById('local-opt-restart');
  const cacheCb = document.getElementById('local-opt-cache');
  if (!keyEl || !cmdEl) return;
  // checkbox 初期状態を localStorage から復元 (デフォルト: restart=true, cache=false)
  if (restartCb && restartCb.dataset.bound !== '1') {
    restartCb.checked = (localStorage.getItem('local_opt_restart') ?? '1') === '1';
    restartCb.addEventListener('change', () => {
      localStorage.setItem('local_opt_restart', restartCb.checked ? '1' : '0');
      _renderLocalConfig();
    });
    restartCb.dataset.bound = '1';
  }
  if (cacheCb && cacheCb.dataset.bound !== '1') {
    cacheCb.checked = localStorage.getItem('local_opt_cache') === '1';
    cacheCb.addEventListener('change', () => {
      localStorage.setItem('local_opt_cache', cacheCb.checked ? '1' : '0');
      _renderLocalConfig();
    });
    cacheCb.dataset.bound = '1';
  }
  const key = S.currentUser?.api_key;
  if (!key) {
    keyEl.textContent = '(発行されていません — 一度「探索」を押すと自動発行されます)';
    cmdEl.textContent = '# ワーカー API キーがまだ発行されていません。\n# 一度「探索」ボタンを押してから戻ってきてください。';
    return;
  }
  keyEl.textContent = key;
  const lines = [
    'docker run -d --gpus all --name geoscope-worker',
  ];
  if (restartCb?.checked) lines.push('  --restart unless-stopped');
  lines.push(`  -e GEOSCOPE_SERVER=${location.origin}`);
  lines.push(`  -e WORKER_API_KEY=${key}`);
  lines.push('  -e SKIP_DEM_EXTRACT=true');
  lines.push(`  -e DEM_TILE_BASE_URL=${location.origin}/tiles/dem`);
  if (cacheCb?.checked) lines.push('  -v ~/geoscope-cache:/workspace/tiles');
  lines.push('  ghcr.io/task-jp/geoscope-worker:latest');
  cmdEl.textContent = lines.join(' \\\n');
}

function _bindDynamicControls() {
  // Bulk actions
  document.getElementById('btn-bulk-label')?.addEventListener('click', bulkLabelDisplayed);
  document.getElementById('btn-bulk-delete')?.addEventListener('click', bulkDeleteDisplayed);
  document.getElementById('btn-bulk-vote-yes')?.addEventListener('click', () => bulkVoteDisplayed('yes'));
  document.getElementById('btn-bulk-vote-no')?.addEventListener('click', () => bulkVoteDisplayed('no'));
  document.getElementById('btn-bulk-vote-pass')?.addEventListener('click', () => bulkVoteDisplayed('pass'));
  document.getElementById('btn-bulk-vote-clear')?.addEventListener('click', () => bulkVoteDisplayed(null));
  // Mapbox token
  const mbInput = document.getElementById('mapbox-token');
  if (mbInput) {
    mbInput.value = S.loadPrefs().mapbox_token || '';
    mbInput.addEventListener('change', () => {
      const token = mbInput.value.trim();
      S.savePrefs({ mapbox_token: token });
      S._updatePhotoSource(token);
      if (S.galleryMode) renderGalleryView();
    });
  }
  // Google API key
  const gkInput = document.getElementById('google-api-key');
  if (gkInput) {
    gkInput.value = S.loadPrefs().google_api_key || '';
    gkInput.addEventListener('change', () => {
      S.savePrefs({ google_api_key: gkInput.value.trim() });
    });
  }
  // アカウント設定モーダルのタブ切替
  document.querySelectorAll('#account-tabs .acc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('#account-tabs .acc-tab').forEach(b => {
        const active = b.dataset.tab === target;
        b.style.color = active ? '#6bcfff' : '#888';
        b.style.borderBottomColor = active ? '#6bcfff' : 'transparent';
      });
      document.querySelectorAll('[data-tab-pane]').forEach(p => {
        p.style.display = p.dataset.tabPane === target ? '' : 'none';
      });
    });
  });

  // 探索の実行環境 + 探索モード (radio)
  const workerMode = localStorage.getItem('worker_mode') || 'cloud';
  const wmCloud = document.getElementById('wm-cloud');
  const wmLocal = document.getElementById('wm-local');
  if (wmCloud && wmLocal) {
    if (workerMode === 'local') wmLocal.checked = true; else wmCloud.checked = true;
    [wmCloud, wmLocal].forEach(r => r.addEventListener('change', () => {
      const mode = document.querySelector('input[name="worker-mode"]:checked')?.value || 'cloud';
      localStorage.setItem('worker_mode', mode);
      _applyWorkerMode(mode);
    }));
    _applyWorkerMode(workerMode);
  }
  const scanMode = localStorage.getItem('scan_mode') || 'balanced';
  const smRadios = document.querySelectorAll('input[name="scan-mode"]');
  smRadios.forEach(r => {
    if (r.value === scanMode) r.checked = true;
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="scan-mode"]:checked')?.value || 'balanced';
      localStorage.setItem('scan_mode', v);
    });
  });
  // local mode: copy / regenerate API key
  document.getElementById('btn-copy-local-key')?.addEventListener('click', () => {
    const k = S.currentUser?.api_key;
    if (k) navigator.clipboard.writeText(k);
  });
  document.getElementById('btn-copy-docker-cmd')?.addEventListener('click', () => {
    const t = document.getElementById('local-docker-cmd')?.textContent || '';
    if (t) navigator.clipboard.writeText(t);
  });
  document.getElementById('btn-regen-local-key')?.addEventListener('click', async () => {
    if (!confirm('ワーカー API キーを再生成します。古いキーは無効化され、起動中のローカルワーカーは停止して再起動が必要です。続行しますか?')) return;
    const token = localStorage.getItem('token');
    const res = await fetch('/api/auth/api-key', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      if (S.currentUser) S.currentUser.api_key = data.api_key;
      _renderLocalConfig();
    }
  });

  // RunPod API key (BYO クラウドGPU)
  const rpInput = document.getElementById('runpod-api-key');
  const rpStatus = document.getElementById('runpod-key-status');
  const rpButton = document.getElementById('btn-verify-runpod');
  if (rpInput) {
    rpInput.value = localStorage.getItem('runpod_api_key') || '';
    rpInput.addEventListener('change', () => {
      const v = rpInput.value.trim();
      if (v) localStorage.setItem('runpod_api_key', v);
      else localStorage.removeItem('runpod_api_key');
      // 編集されたら verified を取り消し
      localStorage.removeItem('runpod_verified');
      _setRunpodLocked(false);
      _updateScanButton();
      if (rpStatus) rpStatus.textContent = v ? '「検証」を押してください' : '';
    });
    // 起動時の状態反映
    _setRunpodLocked(localStorage.getItem('runpod_verified') === '1');
  }
  rpButton?.addEventListener('click', async () => {
    // verified 状態なら「変更」として振る舞う
    if (localStorage.getItem('runpod_verified') === '1') {
      localStorage.removeItem('runpod_verified');
      _setRunpodLocked(false);
      _updateScanButton();
      if (rpStatus) { rpStatus.textContent = 'キーを編集できます'; rpStatus.style.color = '#888'; }
      rpInput?.focus();
      return;
    }
    const key = (rpInput?.value || '').trim();
    if (!key) { if (rpStatus) { rpStatus.textContent = 'キーを入力してください'; rpStatus.style.color = '#f88'; } return; }
    if (rpStatus) { rpStatus.textContent = '検証中...'; rpStatus.style.color = '#888'; }
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/byo/runpod/init', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-RunPod-Api-Key': key,
        },
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('runpod_api_key', key);
        localStorage.setItem('runpod_verified', '1');
        _setRunpodLocked(true);
        _updateScanButton();
        if (rpStatus) {
          rpStatus.textContent = `✓ 有効 (稼働中Pods: ${data.pod_count})`;
          rpStatus.style.color = '#6f6';
        }
      } else {
        const err = await res.text();
        localStorage.removeItem('runpod_verified');
        _setRunpodLocked(false);
        _updateScanButton();
        if (rpStatus) { rpStatus.textContent = `× ${err || res.status}`; rpStatus.style.color = '#f88'; }
      }
    } catch (e) {
      localStorage.removeItem('runpod_verified');
      _setRunpodLocked(false);
      _updateScanButton();
      if (rpStatus) { rpStatus.textContent = '× 通信エラー: ' + (e.message || e); rpStatus.style.color = '#f88'; }
    }
  });
  // ToS 同意ボタン
  document.getElementById('btn-accept-tos')?.addEventListener('click', async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch('/api/auth/tos-accept', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (S.currentUser) S.currentUser.tos_accepted_at = data.tos_accepted_at;
        document.getElementById('tos-modal')?.classList.add('hidden');
      } else {
        alert('利用規約への同意に失敗しました');
      }
    } catch (e) {
      alert('通信エラー: ' + (e.message || e));
    }
  });
  // アカウント削除ボタン
  document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
    if (!confirm('本当にアカウントを削除しますか?\n自分のプロジェクト・アノテーション・ジョブ履歴がすべて削除されます (復旧不可)。\n\nRunPod 上の Pod は別途 RunPod ダッシュボードで停止してください。')) return;
    if (!confirm('最終確認: 削除を実行します。よろしいですか?')) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch('/api/auth/me', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        // localStorage を全部 clean してリロード
        localStorage.removeItem('token');
        localStorage.removeItem('runpod_api_key');
        alert('アカウントを削除しました。');
        location.href = '/';
      } else {
        alert('削除に失敗しました: ' + await res.text());
      }
    } catch (e) {
      alert('通信エラー: ' + (e.message || e));
    }
  });
  // Enrichment
  document.getElementById('btn-enrich-google')?.addEventListener('click', () => bulkEnrichGoogle());
  document.getElementById('btn-rescore')?.addEventListener('click', () => startRescore());
  document.getElementById('btn-dedup')?.addEventListener('click', () => bulkDedup());
  document.getElementById('btn-delete-notile')?.addEventListener('click', () => bulkDeleteNoTile());
  // Scan
  const scanRegionEl = document.getElementById('scan-region');
  const scanPrecisionEl = document.getElementById('scan-precision');
  if (scanRegionEl) { scanRegionEl.value = localStorage.getItem('geoscope_scan_region') || ''; scanRegionEl.onchange = () => localStorage.setItem('geoscope_scan_region', scanRegionEl.value); }
  if (scanPrecisionEl) { scanPrecisionEl.value = localStorage.getItem('geoscope_scan_precision') || '0.3'; scanPrecisionEl.onchange = () => localStorage.setItem('geoscope_scan_precision', scanPrecisionEl.value); }
  document.getElementById('btn-scan')?.addEventListener('click', startScan);
  _updateScanButton();
}

function _removeAuthUI() {
  if (!_authUIInjected) return;
  _authUIInjected = false;
  for (const id of ['auth-content-slot', 'gallery-slot', 'detection-modal-slot', 'account-modal-slot']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
}

// ── Projects ──
function setupProjectControls() {
  document.getElementById('project-select').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) {
      S.currentProject = null;
      localStorage.removeItem('geoscope_project');
      return;
    }
    S.currentProject = S.projects.find(p => String(p.id) === id);
    localStorage.setItem('geoscope_project', id);
    S.projectLabels = [];
    S.annotations = [];
    S.selectedAnnotationIdx = null;
    loadFilters();
    invalidateFilterCache();
    markGeoJSONDirty();
    refreshAnnotationList();
    await loadProjectData();
  });

  document.getElementById('btn-new-project').addEventListener('click', async () => {
    const name = prompt('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u540d:');
    if (!name) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch('/api/projects/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name })
      });
      if (!res.ok) throw new Error();
      const newProject = await res.json();
      await loadProjects();
      const sel = document.getElementById('project-select');
      if (sel) { sel.value = newProject.id; sel.dispatchEvent(new Event('change')); }
    } catch (e) {
      console.error('Failed to create project:', e);
    }
  });

  document.getElementById('btn-del-project')?.addEventListener('click', async () => {
    if (!S.currentProject) return;
    if (!confirm(`\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u300c${S.currentProject.name}\u300d\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f\n\u3059\u3079\u3066\u306e\u304a\u6c17\u306b\u5165\u308a\u30fb\u30e9\u30d9\u30eb\u30fb\u30b8\u30e7\u30d6\u304c\u524a\u9664\u3055\u308c\u307e\u3059\u3002`)) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/projects/${S.currentProject.id}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { alert('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ' + res.status); return; }
    } catch (e) { alert('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ' + e.message); return; }
    try {
      S.currentProject = null;
      S.annotations = [];
      S._filteredCache = null;
      S._filterCacheKey = '';
      S._filteredTotal = 0;
      S.selectedAnnotationIdx = null;
      markGeoJSONDirty();
      refreshAnnotationList();
      localStorage.removeItem('geoscope_project');
      await loadProjects();
    } catch (e) { console.error('Post-delete cleanup error:', e); }
  });

  // Label filter change
  const filterSel = document.getElementById('filter-label');
  if (filterSel) {
    const savedFilter = S.loadPrefs().label_filter;
    if (savedFilter) filterSel.value = savedFilter;
    filterSel.addEventListener('change', () => {
      S.savePrefs({ label_filter: filterSel.value });
      refreshAnnotationList();
      markGeoJSONDirty();
    });
  }

  // Export
  async function exportDisplayed(ext) {
    if (!S.currentProject) return;
    S.busyStart();
    try {
      const token = localStorage.getItem('token');
      const endpoint = ext === 'geojson' ? 'export.geojson' : 'export.csv';
      const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ filter: S.filterConfig })
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `annotations_${S.currentProject.id}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
  }

  function exportSheets() {
    const displayed = filterAnnotations(S.annotations);
    if (!displayed.length) { alert('\u8868\u793a\u4e2d\u306e\u304a\u6c17\u306b\u5165\u308a\u304c\u3042\u308a\u307e\u305b\u3093'); return; }
    const base = location.origin;
    const esc = v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [['\u30b5\u30e0\u30cd\u30a4\u30ebURL', '\u30bf\u30a4\u30c8\u30eb', '\u90fd\u9053\u5e9c\u770c', '\u7def\u5ea6', '\u7d4c\u5ea6', '\u30e9\u30d9\u30eb', '\u30b3\u30e1\u30f3\u30c8', 'GeoScope', '\u6587\u5316\u8ca1']];
    displayed.forEach(a => {
      const ncx = a.bbox_px_cx > 2 ? a.bbox_px_cx / 512 : a.bbox_px_cx;
      const ncy = a.bbox_px_cy > 2 ? a.bbox_px_cy / 512 : a.bbox_px_cy;
      const nw = a.bbox_px_w > 2 ? a.bbox_px_w / 512 : a.bbox_px_w;
      const nh = a.bbox_px_h > 2 ? a.bbox_px_h / 512 : a.bbox_px_h;
      const thumbUrl = `${base}/tiles/crop/${a.tile_z||16}/${a.tile_x}/${a.tile_y}/clip.webp?cx=${ncx}&cy=${ncy}&w=${nw}&h=${nh}`;
      const lat = a.bbox ? ((a.bbox[1]+a.bbox[3])/2).toFixed(6) : '';
      const lon = a.bbox ? ((a.bbox[0]+a.bbox[2])/2).toFixed(6) : '';
      const labels = (a.labels || []).map(l => l.name).filter(Boolean).join(', ');
      const gsUrl = `${base}/@17/${lat}/${lon}/0/60`;
      const nbUrl = `https://heritagemap.nabunken.go.jp/?lat=${lat}&lng=${lon}&zoom=17&bearing=0&pitch=0&bm=pale&bl=heritage_db_point_idx%3A1%2Cheritage_abstract_idx%3A1%2Cheritage_db_shape_idx%3A1&cl=hakkututyousaku_idx%3A0.5%3A1%2Cjyobofukugen_idx%3A0.5%3A1%2Cslope%3A0.5%3A1%2Crelief%3A0.25%3A1`;
      rows.push([
        thumbUrl,
        esc(a.title || ''),
        esc(a.prefecture || ''),
        lat, lon,
        esc(labels),
        esc(a.comment || ''),
        gsUrl,
        nbUrl,
      ]);
    });
    const content = '\ufeff' + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([content], { type: 'text/csv; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `geoscope_sheets_${S.currentProject?.id || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportUmap() {
    const displayed = filterAnnotations(S.annotations);
    if (!displayed.length) { alert('\u8868\u793a\u4e2d\u306e\u304a\u6c17\u306b\u5165\u308a\u304c\u3042\u308a\u307e\u305b\u3093'); return; }
    const base = location.origin;
    const features = displayed.map(a => {
      const lat = a.bbox ? ((a.bbox[1]+a.bbox[3])/2) : a.lat || 0;
      const lon = a.bbox ? ((a.bbox[0]+a.bbox[2])/2) : a.lon || 0;
      const labels = (a.labels || []).map(l => `${l.emoji||''} ${l.name}`).filter(Boolean).join(', ');
      const vote = a.annotation_vote === 'yes' ? '\u2b55' : a.annotation_vote === 'no' ? '\u274c' : a.annotation_vote === 'pass' ? '\u2753' : '';
      const gsUrl = `${base}/@17/${lat.toFixed(6)}/${lon.toFixed(6)}/0/60`;
      const desc = [
        labels && `\u30e9\u30d9\u30eb: ${labels}`,
        vote && `\u8a55\u4fa1: ${vote}`,
        a.comment && `\u30b3\u30e1\u30f3\u30c8: ${a.comment}`,
        `[[${gsUrl}|GeoScope\u3067\u958b\u304f]]`,
      ].filter(Boolean).join('\n');
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name: a.title || `#${a.id?.slice(0,8) || ''}`, description: desc }
      };
    });
    const geojson = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    const blob = new Blob([geojson], { type: 'application/geo+json; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `umap_${S.currentProject?.name || 'export'}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('btn-export-geojson')?.addEventListener('click', () => exportDisplayed('geojson'));
  document.getElementById('btn-export-geojson-points')?.addEventListener('click', async () => {
    if (!S.currentProject) return;
    S.busyStart();
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/export-points.geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ filter: S.filterConfig })
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `points_${S.currentProject.id}.geojson`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
  });
  document.getElementById('btn-export-csv')?.addEventListener('click', () => exportDisplayed('csv'));
  document.getElementById('btn-export-sheets')?.addEventListener('click', () => exportSheets());
  document.getElementById('btn-export-umap')?.addEventListener('click', () => exportUmap());
  document.getElementById('btn-import')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !S.currentProject) return;
    S.busyStart();
    const token = localStorage.getItem('token');
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/import`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: form
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      alert(`${data.inserted}\u4ef6\u3092\u30a4\u30f3\u30dd\u30fc\u30c8\u3057\u307e\u3057\u305f`);
      await loadProjectData();
    } catch (err) { alert('\u30a4\u30f3\u30dd\u30fc\u30c8\u5931\u6557: ' + err.message); } finally { S.busyEnd(); }
    e.target.value = '';
  });
}

// ── ML Jobs ──
async function startScan() {
  if (!S.currentProject) { alert('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044'); return; }
  const workerMode = localStorage.getItem('worker_mode') || 'cloud';
  if (workerMode === 'cloud' && localStorage.getItem('runpod_verified') !== '1') {
    alert('\u30a2\u30ab\u30a6\u30f3\u30c8\u8a2d\u5b9a\u3067 RunPod API Key \u3092\u300c\u691c\u8a3c\u300d\u3057\u3066\u304b\u3089\u63a2\u7d22\u3092\u958b\u59cb\u3067\u304d\u307e\u3059');
    return;
  }
  const prefName = document.getElementById('scan-region')?.value || '';
  let region = null;
  let prefecture = null;
  let confirmMsg = '\u5168\u56fd\u63a2\u7d22\u3092\u958b\u59cb\u3057\u307e\u3059\u304b\uff1f\uff08\u6570\u6642\u9593\u304b\u304b\u308a\u307e\u3059\uff09';
  if (prefName) {
    try {
      const res = await fetch(`/api/prefectures/${encodeURIComponent(prefName)}/tiles`);
      if (res.ok) {
        const tiles = await res.json();
        const bres = await fetch(`/api/prefectures/${encodeURIComponent(prefName)}/bbox`);
        if (bres.ok) region = await bres.json();
        prefecture = prefName;
        confirmMsg = `${prefName}\u3092\u63a2\u7d22\u3057\u307e\u3059\u304b\uff1f\uff08${tiles.length.toLocaleString()}\u30bf\u30a4\u30eb\uff09`;
      }
    } catch {}
  }
  if (!confirm(confirmMsg)) return;

  const token = localStorage.getItem('token');
  const byoHeaders = _byoHeaders();
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...byoHeaders },
      body: JSON.stringify({
        region,
        prefecture,
        conf_threshold: parseFloat(document.getElementById('scan-precision')?.value || '0.3'),
        scan_label: `${new Date().toLocaleString('ja-JP', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Tokyo'})} ${prefName || '\u5168\u56fd'}`
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const job = await res.json();
    watchJob(job.id);
    loadJobs();
    // \u65b0\u3057\u3044 scan_label \u304c\u30d5\u30a3\u30eb\u30bf UI \u7b49\u306b\u5373\u53cd\u6620\u3055\u308c\u308b\u3088\u3046\u30e9\u30d9\u30eb\u4e00\u89a7\u3092\u518d\u53d6\u5f97
    try {
      const lr = await fetch(`/api/projects/${S.currentProject.id}/labels`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (lr.ok) {
        S.projectLabels = await lr.json();
        window._projectLabels = S.projectLabels;
        updateLabelFilter();
      }
    } catch {}
  } catch (e) {
    alert('\u30b9\u30ad\u30e3\u30f3\u30b8\u30e7\u30d6\u306e\u4f5c\u6210\u306b\u5931\u6557: ' + e.message);
  }
}

// ── Tile Gallery View ──
function setupGalleryToggle() {
  document.getElementById('btn-gallery-toggle')?.addEventListener('click', () => toggleGallery());
  if (localStorage.getItem('geoscope_gallery_mode') === '1') toggleGallery(true);
}

function toggleGallery(force) {
  S.galleryMode = force !== undefined ? force : !S.galleryMode;
  localStorage.setItem('geoscope_gallery_mode', S.galleryMode ? '1' : '0');
  const btn = document.getElementById('btn-gallery-toggle');
  const gallery = document.getElementById('tile-gallery');
  const mapEl = document.getElementById('map');
  if (btn) btn.classList.toggle('active', S.galleryMode);
  if (!S.galleryMode && gallery) gallery._savedScroll = gallery.scrollTop;
  if (gallery) gallery.style.display = S.galleryMode ? '' : 'none';
  if (mapEl) mapEl.style.display = S.galleryMode ? 'none' : '';
  if (S.galleryMode) {
    hideDetailPanel();
  }
  refreshAnnotationList();
}

let galleryTileSize = parseInt(localStorage.getItem('geoscope_tile_size') || '150');

function renderGalleryView() {
  const gridId = 'tile-gallery-grid';
  const grid = document.getElementById(gridId);
  if (!grid) return;

  let slider = document.getElementById('tile-size-slider');
  if (!slider) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;color:#888;';
    wrap.innerHTML = '<span>\u30b5\u30a4\u30ba</span>';
    slider = document.createElement('input');
    slider.type = 'range'; slider.id = 'tile-size-slider';
    slider.min = '40'; slider.max = '300'; slider.value = galleryTileSize;
    slider.style.cssText = 'flex:1;accent-color:#3b82f6;';
    slider.oninput = () => {
      galleryTileSize = parseInt(slider.value);
      localStorage.setItem('geoscope_tile_size', galleryTileSize);
      const cols = `repeat(auto-fill, minmax(${galleryTileSize}px, 1fr))`;
      document.getElementById('tile-gallery-grid').style.gridTemplateColumns = cols;
    };
    wrap.appendChild(slider);
    // Insert before the first grid
    const firstGrid = document.getElementById('tile-gallery-grid');
    if (firstGrid) firstGrid.parentNode.insertBefore(wrap, firstGrid);
  }
  const cols = `repeat(auto-fill, minmax(${galleryTileSize}px, 1fr))`;
  document.getElementById('tile-gallery-grid').style.gridTemplateColumns = cols;

  const filtered = filterAnnotations(S.annotations);
  console.log('renderGalleryView: filtered=' + filtered.length + ', _filteredCache=' + (S._filteredCache?.length ?? 'null'));
  const gallery = document.getElementById('tile-gallery');

  grid.innerHTML = '';
  grid._rendered = 0;
  grid._clickBound = false;
  grid._filtered = filtered;
  _renderGalleryChunk(grid, Math.max(100, filtered.length));
  renderGalleryView_clicks();

  if (gallery && gallery._savedScroll > 0) {
    requestAnimationFrame(() => { gallery.scrollTop = gallery._savedScroll; });
  }

  if (gallery && !gallery._scrollHandler) {
    gallery._scrollHandler = () => {
      if (gallery.scrollTop + gallery.clientHeight >= gallery.scrollHeight - 200) {
        _renderGalleryChunk(grid, 100);
      }
    };
    gallery.addEventListener('scroll', gallery._scrollHandler);
  }
}

function _renderGalleryChunk(grid, count) {
  const filtered = grid._filtered;
  if (!filtered) return;
  const start = grid._rendered || 0;
  const end = Math.min(start + count, filtered.length);
  if (start >= end) return;

  filtered.slice(start, end).forEach((a, idx) => {
    const i = start + idx;
    if (i > 0 && i % 100 === 0) {
      const marker = document.createElement('div');
      marker.style.cssText = 'grid-column:1/-1;padding:2px 8px;font-size:11px;color:#888;background:#1a1a2e;text-align:center;border-radius:4px;';
      marker.textContent = `\u2500\u2500 ${i}\u4ef6\u76ee \u2500\u2500`;
      grid.appendChild(marker);
    }
    const card = document.createElement('div');
    card.className = 'tile-card' + (i === S.selectedAnnotationIdx ? ' selected' : '');
    card.dataset.idx = i;

    const raw_cx = a.bbox_px_cx || 0;
    const raw_cy = a.bbox_px_cy || 0;
    const raw_bw = a.bbox_px_w || 0;
    const raw_bh = a.bbox_px_h || 0;
    const ncx = raw_cx > 2 ? raw_cx / 512 : raw_cx;
    const ncy = raw_cy > 2 ? raw_cy / 512 : raw_cy;
    const nbw = raw_bw > 2 ? raw_bw / 512 : raw_bw;
    const nbh = raw_bh > 2 ? raw_bh / 512 : raw_bh;

    const vis = Math.max(nbw, nbh, 0.05) * 1.5;
    const cs = galleryTileSize;
    const bgPx = cs / vis;
    const tz = a.tile_z || 16;

    const gLeft = ncx - vis / 2, gTop = ncy - vis / 2;
    const txMin = Math.floor(a.tile_x + gLeft);
    const txMax = Math.floor(a.tile_x + ncx + vis / 2 - 1e-9);
    const tyMin = Math.floor(a.tile_y + gTop);
    const tyMax = Math.floor(a.tile_y + ncy + vis / 2 - 1e-9);

    const prefs = S.loadPrefs();
    const baseVis = prefs.base_vis !== undefined ? prefs.base_vis : true;
    const photoVis = prefs.photo_vis !== undefined ? prefs.photo_vis : true;
    const csVis = prefs.cs_vis !== undefined ? prefs.cs_vis : false;
    const baseOp = prefs.base_op !== undefined ? prefs.base_op : 1.0;
    const photoOp = prefs.photo_op !== undefined ? prefs.photo_op : 1.0;
    const csOp = prefs.cs_op !== undefined ? prefs.cs_op : 0.7;
    const hasLayer = baseVis || photoVis || csVis;

    for (let tx = txMin; tx <= txMax; tx++) {
      for (let ty = tyMin; ty <= tyMax; ty++) {
        const dx = tx - a.tile_x, dy = ty - a.tile_y;
        const tL = ((dx - gLeft) * bgPx).toFixed(0);
        const tT = ((dy - gTop) * bgPx).toFixed(0);
        const szStr = `${bgPx.toFixed(0)}px ${bgPx.toFixed(0)}px`;
        const posStr = `${tL}px ${tT}px`;
        if (baseVis) {
          const bl = document.createElement('div');
          bl.style.cssText = `position:absolute;inset:0;opacity:${baseOp};background:url('https://cyberjapandata.gsi.go.jp/xyz/pale/${tz}/${tx}/${ty}.png') ${posStr} / ${szStr} no-repeat;`;
          card.appendChild(bl);
        }
        if (photoVis) {
          const pl = document.createElement('div');
          pl.style.cssText = `position:absolute;inset:0;opacity:${photoOp};background:url('${S._getPhotoTileUrl(tz, tx, ty)}') ${posStr} / ${szStr} no-repeat;`;
          card.appendChild(pl);
        }
        if (csVis) {
          const cl = document.createElement('div');
          cl.style.cssText = `position:absolute;inset:0;opacity:${csOp};background:url('/tiles/cs/${tz}/${tx}/${ty}.webp') ${posStr} / ${szStr} no-repeat;`;
          card.appendChild(cl);
        }
      }
    }
    if (!hasLayer) {
      const fb = document.createElement('div');
      fb.style.cssText = 'position:absolute;inset:0;background:#222;';
      card.appendChild(fb);
    }

    const bw = nbw / vis * cs, bh = nbh / vis * cs;
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${((cs-bw)/2).toFixed(0)}px;top:${((cs-bh)/2).toFixed(0)}px;width:${bw.toFixed(0)}px;height:${bh.toFixed(0)}px;border:2px solid #f5be00;box-sizing:border-box;pointer-events:none;`;
    card.appendChild(box);

    if (!isEditable()) { card.appendChild(document.createTextNode('')); }
    const voteBar = document.createElement('div');
    voteBar.style.cssText = `position:absolute;bottom:0;right:0;display:${isEditable() ? 'flex' : 'none'};gap:2px;z-index:2;padding:3px;`;
    [{v:'yes',icon:'\u2b55'},{v:'no',icon:'\u274c'},{v:'pass',icon:'\u2753'}].forEach(({v,icon}) => {
      const btn = document.createElement('button');
      btn.textContent = icon;
      const selected = a.annotation_vote === v;
      btn.style.cssText = `cursor:pointer;font-size:14px;line-height:1;padding:4px 6px;border:1px solid ${selected ? '#fff' : '#666'};border-radius:4px;background:${selected ? '#fff' : 'rgba(0,0,0,0.6)'};`;
      btn.onclick = async (e) => {
        e.stopPropagation();
        const newVote = a.annotation_vote === v ? null : v;
        const token = localStorage.getItem('token');
        a.annotation_vote = newVote;
        voteBar.querySelectorAll('button').forEach(b => {
          const bv = b.textContent === '\u2b55' ? 'yes' : b.textContent === '\u274c' ? 'no' : 'pass';
          const sel = a.annotation_vote === bv;
          b.style.borderColor = sel ? '#fff' : '#666';
          b.style.background = sel ? '#fff' : 'rgba(0,0,0,0.6)';
        });
        fetch(`/api/annotations/${a.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ annotation_vote: newVote || '' })
        }).catch(err => console.error(err));
      };
      voteBar.appendChild(btn);
    });
    card.appendChild(voteBar);

    const label = document.createElement('div');
    label.className = 'tile-label';
    const labels = (a.labels || []).map(l => `${l.emoji || ''}`).join('');
    label.textContent = `${a.title || `#${i+1}`} ${labels}`;
    card.appendChild(label);
    grid.appendChild(card);
  });
  grid._rendered = end;
}

function renderGalleryView_clicks() {
  const gridId = 'tile-gallery-grid';
  const grid = document.getElementById(gridId);
  if (!grid || grid._clickBound) return;
  grid._clickBound = true;

  grid.onclick = (e) => {
    const card = e.target.closest('.tile-card');
    if (!card) return;
    const i = parseInt(card.dataset.idx);
    S.selectedAnnotationIdx = i;
    toggleGallery();
    markGeoJSONDirty();
    refreshAnnotationList();
    const filt = filterAnnotations(S.annotations);
    if (filt[i]) {
      showDetailPanel(filt[i]);
      if (filt[i].bbox) {
        const [w, s, e, n] = filt[i].bbox;
        fitBoundsCompat([[w, s], [e, n]], { padding: 80, maxZoom: 18, animate: false });
      }
      const selected = document.getElementById('annotation-list')?.querySelector('.selected');
      if (selected) selected.scrollIntoView({ block: 'nearest' });
    }
  };
}

// ── Tile Review Mode ──
function openReview() {
  const filtered = filterAnnotations(S.annotations);
  if (!filtered.length) { alert('\u30ec\u30d3\u30e5\u30fc\u5bfe\u8c61\u304c\u3042\u308a\u307e\u305b\u3093'); return; }

  const unvoted = [...activeFilters].filter(f => f.startsWith('__unvoted_'));
  if (unvoted.length === 1) {
    reviewLabelName = unvoted[0].slice(10);
  } else {
    const existingLabels = new Set();
    S.annotations.forEach(a => (a.labels || []).forEach(l => { if (l.name) existingLabels.add(l.name); }));
    const hint = existingLabels.size > 0 ? `\n\u65e2\u5b58: ${[...existingLabels].join(', ')}` : '';
    const input = prompt(`\u30ec\u30d3\u30e5\u30fc\u3059\u308b\u30e9\u30d9\u30eb\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044${hint}`);
    if (!input || !input.trim()) return;
    reviewLabelName = input.trim();
  }

  reviewItems = filtered;
  reviewIdx = 0;
  reviewBbox = null;

  const overlay = document.getElementById('review-overlay');
  overlay.style.display = '';
  document.getElementById('review-label-name').textContent = `\u30e9\u30d9\u30eb: ${reviewLabelName}`;

  setupReviewCanvas();
  loadReviewTile();
}

function closeReview() {
  document.getElementById('review-overlay').style.display = 'none';
  reviewItems = [];
  markGeoJSONDirty();
  refreshAnnotationList();
}

function setupReviewCanvas() {
  const canvas = document.getElementById('review-canvas');
  let startX, startY;
  let isPanning = false;
  let panStartX, panStartY, panStartOX, panStartOY;

  function canvasToSrc(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * 512;
    const cy = (e.clientY - rect.top) / rect.height * 512;
    const sx = (cx - 256) / reviewZoom + 256 - reviewPanX;
    const sy = (cy - 256) / reviewZoom + 256 - reviewPanY;
    return [sx, sy];
  }

  canvas.onmousedown = (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && reviewZoom > 1 && !e.shiftKey)) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartOX = reviewPanX;
      panStartOY = reviewPanY;
      e.preventDefault();
      return;
    }
    const [sx, sy] = canvasToSrc(e);
    startX = sx;
    startY = sy;
    reviewDragging = true;
    reviewBbox = null;
  };

  canvas.onmousemove = (e) => {
    if (isPanning) {
      const rect = canvas.getBoundingClientRect();
      const dx = (e.clientX - panStartX) / rect.width * 512 / reviewZoom;
      const dy = (e.clientY - panStartY) / rect.height * 512 / reviewZoom;
      reviewPanX = panStartOX + dx;
      reviewPanY = panStartOY + dy;
      drawReviewOverlay();
      return;
    }
    if (!reviewDragging) return;
    const [sx, sy] = canvasToSrc(e);
    reviewBbox = {
      x: Math.min(startX, sx), y: Math.min(startY, sy),
      w: Math.abs(sx - startX), h: Math.abs(sy - startY)
    };
    drawReviewOverlay();
  };

  canvas.onmouseup = () => {
    if (isPanning) { isPanning = false; return; }
    reviewDragging = false;
    if (reviewBbox && reviewBbox.w > 5 && reviewBbox.h > 5) {
      document.getElementById('review-yes').disabled = false;
    }
  };

  canvas.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    reviewZoom = Math.max(1, Math.min(8, reviewZoom * factor));
    if (reviewZoom === 1) { reviewPanX = 0; reviewPanY = 0; }
    drawReviewOverlay();
  };

  canvas.ontouchstart = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    const [sx, sy] = canvasToSrc(t);
    startX = sx; startY = sy;
    reviewDragging = true;
    reviewBbox = null;
  };
  canvas.ontouchmove = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    const [sx, sy] = canvasToSrc(t);
    reviewBbox = {
      x: Math.min(startX, sx), y: Math.min(startY, sy),
      w: Math.abs(sx - startX), h: Math.abs(sy - startY)
    };
    drawReviewOverlay();
  };
  canvas.ontouchend = () => {
    reviewDragging = false;
    if (reviewBbox && reviewBbox.w > 5 && reviewBbox.h > 5) {
      document.getElementById('review-yes').disabled = false;
    }
  };

  document.getElementById('review-close').onclick = closeReview;
  document.getElementById('review-yes').onclick = () => reviewVote('yes');
  document.getElementById('review-no').onclick = () => reviewVote('no');
  document.getElementById('review-skip').onclick = () => reviewVote('pass');
}

function loadReviewTile() {
  if (reviewIdx < 0 || reviewIdx >= reviewItems.length) { closeReview(); return; }
  reviewZoom = 1; reviewPanX = 0; reviewPanY = 0;
  const a = reviewItems[reviewIdx];
  const canvas = document.getElementById('review-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = '#555';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('\u8aad\u307f\u8fbc\u307f\u4e2d...', 256, 256);

  reviewBbox = (a.bbox_px_w > 0 && a.bbox_px_h > 0)
    ? { x: a.bbox_px_cx - a.bbox_px_w / 2, y: a.bbox_px_cy - a.bbox_px_h / 2, w: a.bbox_px_w, h: a.bbox_px_h }
    : null;
  document.getElementById('review-yes').disabled = !reviewBbox;

  const img = new Image();
  img.onload = () => {
    canvas._tileImg = img;
    drawReviewOverlay();
  };
  img.onerror = () => {
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#888';
    ctx.fillText('\u30bf\u30a4\u30eb\u306a\u3057', 256, 256);
    canvas._tileImg = null;
  };
  img.src = `/tiles/cs/${a.tile_z}/${a.tile_x}/${a.tile_y}.webp`;

  document.getElementById('review-progress').textContent = `${reviewIdx + 1}/${reviewItems.length}`;
  const comment = a.comment || '';
  document.getElementById('review-info').textContent = `${a.title || ''} ${comment}`.trim();
}

function drawReviewOverlay() {
  const canvas = document.getElementById('review-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);
  ctx.save();
  ctx.translate(256, 256);
  ctx.scale(reviewZoom, reviewZoom);
  ctx.translate(-256 + reviewPanX, -256 + reviewPanY);
  if (canvas._tileImg) {
    ctx.drawImage(canvas._tileImg, 0, 0, 512, 512);
  }
  if (reviewBbox && reviewBbox.w > 2 && reviewBbox.h > 2) {
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2 / reviewZoom;
    ctx.strokeRect(reviewBbox.x, reviewBbox.y, reviewBbox.w, reviewBbox.h);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
    ctx.fillRect(reviewBbox.x, reviewBbox.y, reviewBbox.w, reviewBbox.h);
  }
  ctx.restore();
  if (reviewZoom > 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(4, 4, 50, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`\u00d7${reviewZoom.toFixed(1)}`, 8, 17);
  }
}

async function reviewVote(vote) {
  const a = reviewItems[reviewIdx];
  if (!a) return;
  const token = localStorage.getItem('token');

  let labels = [...(a.labels || [])];
  if (reviewLabelName) {
    const idx = labels.findIndex(l => l.name === reviewLabelName);
    if (idx >= 0) {
      labels[idx] = { ...labels[idx], vote };
    } else {
      let emoji = '\ud83d\udccd';
      for (const ann of S.annotations) {
        const found = (ann.labels || []).find(l => l.name === reviewLabelName);
        if (found && found.emoji) { emoji = found.emoji; break; }
      }
      labels.push({ name: reviewLabelName, emoji, vote });
    }
  }

  const body = { labels };
  if (vote === 'yes' && reviewBbox) {
    body.bbox_px_cx = reviewBbox.x + reviewBbox.w / 2;
    body.bbox_px_cy = reviewBbox.y + reviewBbox.h / 2;
    body.bbox_px_w = reviewBbox.w;
    body.bbox_px_h = reviewBbox.h;
  }

  try {
    const res = await fetch(`/api/annotations/${a.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      a.labels = labels;
      if (body.bbox_px_cx !== undefined) {
        a.bbox_px_cx = body.bbox_px_cx;
        a.bbox_px_cy = body.bbox_px_cy;
        a.bbox_px_w = body.bbox_px_w;
        a.bbox_px_h = body.bbox_px_h;
      }
    }
  } catch (e) { console.error(e); }

  reviewIdx++;
  reviewBbox = null;
  if (reviewIdx >= reviewItems.length) {
    closeReview();
  } else {
    loadReviewTile();
  }
}

// ── Jobs Dashboard ──
async function toggleDetections() {
  detectionsVisible = !detectionsVisible;
  const btn = document.getElementById('btn-show-detections');
  if (btn) btn.classList.toggle('active', detectionsVisible);
  if (detectionsVisible) {
    await loadDetectionsOverlay();
    detectionsPollTimer = setInterval(loadDetectionsOverlay, 10000);
  } else {
    if (detectionsPollTimer) { clearInterval(detectionsPollTimer); detectionsPollTimer = null; }
    const map = getMap();
    if (map) map.getSource('detections')?.setData({ type: 'FeatureCollection', features: [] });
  }
}

async function loadDetectionsOverlay() {
  if (!S.currentProject || !detectionsVisible) return;
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/detections/geojson`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const geojson = await res.json();
    const map = getMap();
    if (map) map.getSource('detections')?.setData(geojson);
    const btn = document.getElementById('btn-show-detections');
    if (btn) btn.textContent = `\ud83d\udccd \u691c\u51fa ${geojson.features.length}\u4ef6`;
  } catch (e) { /* ignore */ }
}

async function loadJobs() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    let jobs = [];
    const activeRes = await fetch('/api/jobs/active', { headers: { 'Authorization': `Bearer ${token}` } });
    if (activeRes.ok) {
      const active = await activeRes.json();
      active.forEach(j => { j._showProject = true; });
      jobs = active;
    }
    if (S.currentProject) {
      const res = await fetch(`/api/projects/${S.currentProject.id}/jobs`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        const projJobs = await res.json();
        const activeIds = new Set(jobs.map(j => j.id));
        projJobs.forEach(j => { if (!activeIds.has(j.id)) jobs.push(j); });
      }
    }
    renderJobs(jobs);

    const fingerprint = jobs.map(j => `${j.id}:${j.status}:${(j.progress||0).toFixed(3)}:${j.message||''}`).join('|');
    if (fingerprint === jobsPollPrevFingerprint) {
      jobsPollInterval = Math.min(Math.round(jobsPollInterval * JOBS_POLL_GROWTH), JOBS_POLL_MAX);
    } else {
      jobsPollInterval = JOBS_POLL_MIN;
      jobsPollPrevFingerprint = fingerprint;
    }

    const hasActive = jobs.some(j => j.status === 'running' || j.status === 'queued');
    if (jobsPollTimer) { clearTimeout(jobsPollTimer); jobsPollTimer = null; }
    if (hasActive) {
      jobsPollTimer = setTimeout(loadJobs, jobsPollInterval);
    } else {
      jobsPollInterval = JOBS_POLL_MIN;
    }
  } catch (e) { /* ignore */ }
}

function updateMLQuick(jobs) {
  const el = document.getElementById('ml-quick');
  if (!el) return;
  const active = jobs.filter(j => j.status === 'running' || j.status === 'queued');
  if (!active.length) { el.style.display = 'none'; el.textContent = ''; return; }
  const parts = active.map(j => {
    const pct = j.status === 'running' ? Math.round((j.progress || 0) * 100) + '%' : '\u5f85\u6a5f';
    return pct;
  });
  el.textContent = parts.join(' / ');
  const h3 = document.querySelector('[data-target="ml-content"]');
  el.style.display = h3?.classList.contains('collapsed') ? '' : 'none';
}

function renderJobs(jobs) {
  updateMLQuick(jobs);
  const container = document.getElementById('jobs-dashboard');
  if (!container) return;
  if (!jobs.length) { container.innerHTML = ''; return; }

  const frag = document.createDocumentFragment();

  jobs.slice(0, 10).forEach(j => {
    const div = document.createElement('div');
    div.className = 'job-item';

    const statusLabels = { queued: '\u5f85\u6a5f', running: '\u5b9f\u884c\u4e2d', completed: '\u5b8c\u4e86', failed: '\u5931\u6557' };
    const statusText = statusLabels[j.status] || j.status;
    const projectTag = j._showProject && j.project_name ? `[${j.project_name}] ` : '';
    let label = '';
    if (j.config?.scan_label) label = j.config.scan_label;
    else if (j.config?.train_label) label = j.config.train_label;
    else if (j.result?.scan_label) label = j.result.scan_label;

    const created = new Date(j.created_at);
    const timeStr = `${created.getMonth()+1}/${created.getDate()} ${created.getHours()}:${String(created.getMinutes()).padStart(2,'0')}`;
    let durationStr = '';
    if (j.started_at && j.completed_at) {
      const sec = Math.round((new Date(j.completed_at) - new Date(j.started_at)) / 1000);
      durationStr = sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m${sec%60}s`;
    }

    let resultHtml = '';
    if (j.result) {
      const r = j.result;
      if (j.job_type === 'train') {
        const pos = r.positive ?? r.dataset?.positive ?? '';
        const neg = r.negative ?? r.dataset?.negative ?? '';
        const ep = r.best_epoch ? `best:${r.best_epoch}` : '';
        resultHtml = `<div class="job-result">\u2b55${pos} \u274c${neg} ${ep}</div>`;
      } else if (j.job_type === 'scan') {
        const det = r.detection_count ?? '';
        resultHtml = `<div class="job-result">\u691c\u51fa: ${det}\u4ef6</div>`;
      }
    }

    let regionHtml = '';
    if (j.job_type === 'scan' && j.config?.region) {
      regionHtml = `<button class="btn btn-sm btn-outline" data-scan-region="${j.id}" style="font-size:9px;padding:1px 6px;">\ud83d\udccd\u7bc4\u56f2</button>`;
    }

    div.innerHTML = `
      <div class="job-header">
        <span>${projectTag}${label}</span>
        <span class="job-status ${j.status}">${statusText}</span>
      </div>
      ${j.status === 'running' || j.status === 'queued' ? `
        <div class="job-bar-wrap"><div class="job-bar-fill" style="width:${(j.progress||0)*100}%"></div></div>
      ` : ''}
      ${j.message ? `<div class="job-msg">${j.message}</div>` : ''}
      ${resultHtml}
      <div class="job-header" style="margin-top:2px;">
        <span class="job-time">${timeStr}</span>
        ${regionHtml}
        ${(j.status === 'running' || j.status === 'queued') ? `<button class="btn btn-sm btn-outline" data-cancel-job="${j.id}" style="font-size:9px;padding:1px 6px;">\u30ad\u30e3\u30f3\u30bb\u30eb</button>` : ''}
        ${j.status === 'failed' ? `<button class="btn btn-sm btn-outline" data-retry-job="${j.id}" style="font-size:9px;padding:1px 6px;">\u30ea\u30c8\u30e9\u30a4</button>` : ''}
        ${durationStr ? `<span class="job-time">${durationStr}</span>` : ''}
      </div>
    `;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.onclick = async (e) => {
    const cancelBtn = e.target.closest('[data-cancel-job]');
    if (cancelBtn) {
      const jobId = cancelBtn.dataset.cancelJob;
      if (!confirm('\u3053\u306e\u30b8\u30e7\u30d6\u3092\u30ad\u30e3\u30f3\u30bb\u30eb\u3057\u307e\u3059\u304b\uff1f')) return;
      const token = localStorage.getItem('token');
      try {
        await fetch(`/api/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        loadJobs();
      } catch (e) { console.error(e); }
      return;
    }
    const retryBtn = e.target.closest('[data-retry-job]');
    if (retryBtn) {
      const jobId = retryBtn.dataset.retryJob;
      const token = localStorage.getItem('token');
      const retryHeaders = { 'Authorization': `Bearer ${token}`, ..._byoHeaders() };
      try {
        const res = await fetch(`/api/jobs/${jobId}/retry`, {
          method: 'POST',
          headers: retryHeaders,
        });
        if (!res.ok) throw new Error(await res.text());
        const job = await res.json();
        watchJob(job.id);
        loadJobs();
      } catch (e) { alert('\u30ea\u30c8\u30e9\u30a4\u5931\u6557: ' + e.message); }
      return;
    }
    const regionBtn = e.target.closest('[data-scan-region]');
    if (regionBtn) {
      const jobId = regionBtn.dataset.scanRegion;
      toggleScanRegion(jobId, jobs, regionBtn);
    }
  };
  container.appendChild(frag);
}

function toggleScanRegion(jobId, jobs, btn) {
  const m = getMap();
  if (!m) return;
  if (_scanRegionLayers.has(jobId)) {
    const srcId = _scanRegionLayers.get(jobId);
    if (m.getLayer(srcId + '-line')) m.removeLayer(srcId + '-line');
    if (m.getSource(srcId)) m.removeSource(srcId);
    _scanRegionLayers.delete(jobId);
    btn.classList.remove('active');
    return;
  }
  const job = jobs.find(j => j.id === jobId);
  if (!job?.config?.region) return;
  const r = job.config.region;
  const srcId = 'scan-region-' + jobId.slice(0, 8);
  m.addSource(srcId, {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[r.west, r.south], [r.east, r.south], [r.east, r.north], [r.west, r.north], [r.west, r.south]]]
      }
    }
  });
  m.addLayer({
    id: srcId + '-line',
    type: 'line',
    source: srcId,
    paint: { 'line-color': '#c084fc', 'line-width': 2, 'line-dasharray': [4, 3] }
  });
  _scanRegionLayers.set(jobId, srcId);
  btn.classList.add('active');
  fitBoundsCompat([[r.west, r.south], [r.east, r.north]], { padding: 40, animate: false });
}

function watchJob(jobId) {
  const toast = document.getElementById('job-toast-inline');
  const msg = document.getElementById('job-msg');
  const bar = document.getElementById('job-bar');
  toast.style.display = '';
  msg.textContent = '\u30b8\u30e7\u30d6\u958b\u59cb\u5f85\u3061...';
  bar.style.width = '0%';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/jobs/${jobId}`);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    msg.textContent = data.message || '';
    bar.style.width = `${(data.progress || 0) * 100}%`;
    if (data.status === 'completed') {
      msg.textContent = '\u5b8c\u4e86!';
      bar.style.width = '100%';
      bar.style.background = '#2ea043';
      ws.close();
      setTimeout(() => { toast.style.display = 'none'; }, 5000);
    }
    if (data.status === 'failed') {
      msg.textContent = '\u5931\u6557: ' + (data.error || '');
      bar.style.background = '#da3633';
      ws.close();
    }
  };
  ws.onerror = () => { msg.textContent = '\u63a5\u7d9a\u30a8\u30e9\u30fc'; };
}

async function loadProjects() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const res = await fetch('/api/projects/', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    S.projects = await res.json();
    const savedId = localStorage.getItem('geoscope_project');
    if (savedId && S.projects.some(p => String(p.id) === savedId)) {
      S.currentProject = S.projects.find(p => String(p.id) === savedId);
    }
    renderProjectSelect();
    if (S.currentProject) { loadFilters(); await loadProjectData(); }
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
}

function renderProjectSelect() {
  const select = document.getElementById('project-select');
  select.innerHTML = '';
  if (S.projects.length === 0) {
    select.disabled = true;
    select.innerHTML = '<option value="">\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306a\u3057</option>';
  } else {
    select.disabled = false;
    S.projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (S.currentProject && S.currentProject.id === p.id) opt.selected = true;
      select.appendChild(opt);
    });
    if (!S.currentProject && S.projects.length > 0) {
      S.currentProject = S.projects[0];
      localStorage.setItem('geoscope_project', String(S.currentProject.id));
    }
  }
}

async function loadProjectData() { S.busyStart(); try {
  if (!S.currentProject) return;
  const token = localStorage.getItem('token');
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

  try {
    const lr = await fetch(`/api/projects/${S.currentProject.id}/labels`, { headers });
    if (lr.ok) S.projectLabels = await lr.json();
  } catch { S.projectLabels = []; }
  window._projectLabels = S.projectLabels;
  updateLabelFilter();
  loadJobs();

  let countEl = document.getElementById('annotation-count');
  if (!countEl) {
    countEl = document.createElement('span');
    countEl.id = 'annotation-count';
    countEl.style.cssText = 'font-size:11px;color:#888;font-weight:normal;margin-left:6px;';
    const h3 = document.querySelector('[data-target="favorites-content"]');
    if (h3) h3.appendChild(countEl);
  }
  const hasFilter = S.filterConfig.sets.some(s => s.enabled !== false && s.rows.some(r => r.label || r.type));
  if (hasFilter) {
    countEl.textContent = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
    S.annotations = [];
    invalidateFilterCache();
    await applyFilterAsync();
  } else {
    countEl.textContent = '\u30d5\u30a3\u30eb\u30bf\u672a\u8a2d\u5b9a';
    S.annotations = [];
    S._filteredCache = [];
    refreshAnnotationList();
  }

  if (S.currentMode === 'review') {
    await loadDetections(S.currentProject.id);
  }
} finally { S.busyEnd(); } }

// ── Mode buttons ──
function isEditable() { return true; }

function setupModeButtons() {
  document.getElementById('btn-labels')?.addEventListener('click', showLabelManager);
  document.getElementById('btn-gallery-close')?.addEventListener('click', () => hideGallery());
}

function toggleAdding() {
  S.addingMode = !S.addingMode;
  const btn = document.getElementById('btn-draw-toggle');
  if (btn) btn.classList.toggle('active', S.addingMode);

  S.currentMode = S.addingMode ? 'draw' : 'view';
  setCurrentMode(S.currentMode);

  const drawInfo = document.getElementById('draw-info');
  if (drawInfo) drawInfo.style.display = S.addingMode ? '' : 'none';

  if (S.addingMode) {
    const map = getMap();
    if (map) {
      S.savedPitch = map.getPitch();
      S.savedBearing = map.getBearing();
      map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.boxZoom.disable();
    }
    enableDraw(handleAnnotationCreated);
  } else {
    disableDraw();
    const map = getMap();
    if (map) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.keyboard.enableRotation();
      map.boxZoom.enable();
      if (S.savedPitch !== null) {
        map.easeTo({ pitch: S.savedPitch, bearing: S.savedBearing, duration: 500 });
        S.savedPitch = null;
        S.savedBearing = null;
      }
    }
  }
  refreshAnnotationList();

  if (false) {
    if (S.currentProject) {
      loadDetections(S.currentProject.id);
    }
    showGallery();
  } else {
    hideGallery();
  }
}

// ── GeoJSON + Annotation list ──
function markGeoJSONDirty() { S._geoJSONDirty = true; }

function showDetailPanel(annotation) {
  const panel = document.getElementById('detail-panel');
  if (!panel || !annotation) { hideDetailPanel(); return; }

  document.getElementById('detail-title').textContent = annotation.title || '(\u7121\u984c)';

  const labelsEl = document.getElementById('detail-labels');
  const quickEl = document.getElementById('detail-quick-labels');
  const currentLabels = annotation.labels || [];
  const editable = isEditable();

  async function updateLabels(newLabels) {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/annotations/${annotation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ labels: newLabels })
      });
      if (res.ok) {
        annotation.labels = newLabels;
        updateLabelFilter();
        markGeoJSONDirty();
        refreshAnnotationList();
        showDetailPanel(annotation);
      }
    } catch (e) { console.error(e); }
  }

  labelsEl.innerHTML = '';
  currentLabels.forEach((l, li) => {
    const span = document.createElement('span');
    span.style.cssText = `display:inline-flex;align-items:center;gap:2px;padding:2px 6px;border-radius:12px;font-size:11px;margin:1px;
      background:#16213e;color:#ccc;border:1px solid #2a2a4a;`;
    span.innerHTML = `<span>${l.emoji || '\u{1F4CD}'}</span><span>${l.name}</span>`;
    if (editable && !l.system) {
      const rm = document.createElement('span');
      rm.textContent = '\u2715';
      rm.style.cssText = 'cursor:pointer;font-size:9px;margin-left:2px;opacity:0.6;';
      rm.onclick = () => updateLabels(currentLabels.filter((_, xi) => xi !== li));
      span.appendChild(rm);
    }
    labelsEl.appendChild(span);
  });

  document.getElementById('detail-comment').textContent = annotation.comment || '';

  if (editable && quickEl) {
    const currentNames = new Set(currentLabels.map(l => l.name));
    const available = S.projectLabels.filter(l => !l.system && !currentNames.has(l.name));
    quickEl.innerHTML = '';
    if (available.length > 0) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;';
      available.forEach(lbl => {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-block;border-radius:12px;padding:1px 6px;font-size:11px;cursor:pointer;background:#16213e;color:#888;border:1px solid #2a2a4a;';
        chip.textContent = `+ ${lbl.emoji || '\ud83d\udccd'}${lbl.name}`;
        chip.onclick = () => updateLabels([...currentLabels, { name: lbl.name, emoji: lbl.emoji || '\ud83d\udccd' }]);
        wrap.appendChild(chip);
      });
      quickEl.appendChild(wrap);
    }
  } else if (quickEl) {
    quickEl.innerHTML = '';
  }

  if (annotation.bbox) {
    const [w, s, e, n] = annotation.bbox;
    const lat = ((s+n)/2).toFixed(6);
    const lon = ((w+e)/2).toFixed(6);
    const z = getMap()?.getZoom()?.toFixed(1) || 16;
    const shareUrl = `${location.origin}/@${z}/${lat}/${lon}/0/60`;
    const coordsEl = document.getElementById('detail-coords');
    const linkStyle = 'display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;text-decoration:none;border:1px solid #444;color:#6cf;background:#16213e;';
    coordsEl.innerHTML = `${lat}, ${lon}
      <span style="display:inline-flex;gap:3px;margin-left:6px;align-items:center;">
        <a href="${shareUrl}" onclick="event.preventDefault();navigator.clipboard.writeText('${shareUrl}').then(()=>{this.textContent='\\u2713';setTimeout(()=>{this.textContent='\\ud83d\\udccb'},1000)})" style="cursor:pointer;text-decoration:none;" title="URL\u3092\u30b3\u30d4\u30fc">\ud83d\udccb</a>
        <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" style="${linkStyle}" title="Google Maps">Google</a>
        <a href="https://qchizu.jp/maps/#18/${lat}/${lon}/&base=ort&ls=ort%7C03_dem_52_gsi_all_2026_1_01_dem2rrim&blend=0&disp=11&vs=c1g1j0h0k0l0u0t0z0r0s0m0f1" target="_blank" style="${linkStyle}" title="Q\u5730\u56f3">Q\u5730\u56f3</a>
        <a href="https://heritagemap.nabunken.go.jp/?lat=${lat}&lng=${lon}&zoom=17&bearing=0&pitch=0&bm=pale&bl=heritage_db_point_idx%3A1%2Cheritage_abstract_idx%3A1%2Cheritage_db_shape_idx%3A1&cl=hakkututyousaku_idx%3A0.5%3A1%2Cjyobofukugen_idx%3A0.5%3A1%2Cslope%3A0.5%3A1%2Crelief%3A0.25%3A1" target="_blank" style="${linkStyle}" title="\u6587\u5316\u8ca1\u7dcf\u89a7">\u6587\u5316\u8ca1</a>
      </span>`;
  }

  const actions = document.getElementById('detail-actions');
  actions.innerHTML = '';
  actions.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:4px;';

  if (isEditable()) {
    // Row 1: STL
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:6px;align-items:center;';
    if (annotation.bbox) {
      const stl = document.createElement('a');
      stl.href = `/tiles/stl/${annotation.bbox[1].toFixed(6)}/${annotation.bbox[3].toFixed(6)}/${annotation.bbox[0].toFixed(6)}/${annotation.bbox[2].toFixed(6)}.stl?exaggeration=2`;
      stl.className = 'btn btn-sm';
      stl.style.cssText = 'font-size:14px;padding:2px 6px;';
      stl.title = '3D\u30d7\u30ea\u30f3\u30c8\u7528STL\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9';
      stl.textContent = '\ud83c\udfd4\ufe0f';
      row1.appendChild(stl);
    }
    actions.appendChild(row1);

    // Row 2: ⭕❌❓ ... 編集 🗑️
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:4px;align-items:center;';
    [{v:'yes',icon:'\u2b55'},{v:'no',icon:'\u274c'},{v:'pass',icon:'\u2753'}].forEach(({v,icon}) => {
      const btn = document.createElement('span');
      btn.textContent = icon;
      btn.style.cssText = `cursor:pointer;font-size:16px;padding:2px 4px;border-radius:4px;${annotation.annotation_vote === v ? 'background:#204060;' : ''}`;
      btn.onclick = async () => {
        const newVote = annotation.annotation_vote === v ? null : v;
        const token = localStorage.getItem('token');
        try {
          const res = await fetch(`/api/annotations/${annotation.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ annotation_vote: newVote || '' })
          });
          if (res.ok) {
            annotation.annotation_vote = newVote;
            if (newVote && !annotation._voted && S.selectedAnnotationIdx !== null) {
              annotation._voted = true;
              const filtered = filterAnnotations(S.annotations);
              const nextIdx = S.selectedAnnotationIdx + 1;
              if (nextIdx < filtered.length) {
                S.selectedAnnotationIdx = nextIdx;
                const next = filtered[nextIdx];
                showDetailPanel(next);
                if (next.bbox) {
                  const [w,s,e,n] = next.bbox;
                  fitBoundsCompat([[w,s],[e,n]], {padding:80, maxZoom:18, animate:false});
                }
              } else {
                showDetailPanel(annotation);
              }
            } else {
              showDetailPanel(annotation);
            }
            updateSelectionOnly();
          }
        } catch (e) { console.error(e); }
      };
      row2.appendChild(btn);
    });
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    row2.appendChild(spacer);
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm';
    editBtn.textContent = '\u7de8\u96c6';
    editBtn.onclick = () => {
      const realIdx = S.annotations.findIndex(a => a.id === annotation.id);
      if (realIdx >= 0) handleEditAnnotation(realIdx);
    };
    row2.appendChild(editBtn);
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.title = '\u524a\u9664';
    delBtn.textContent = '\ud83d\uddd1\ufe0f';
    delBtn.onclick = async () => {
      const filtered = filterAnnotations(S.annotations);
      const filtIdx = filtered.findIndex(a => a.id === annotation.id);
      if (filtIdx >= 0) await handleDeleteAnnotation(filtIdx);
    };
    row2.appendChild(delBtn);
    actions.appendChild(row2);
  }

  panel.style.display = '';
}

function hideDetailPanel() {
  const panel = document.getElementById('detail-panel');
  if (panel) panel.style.display = 'none';
}

function selectNextFilteredOrClear(previousIdx) {
  const map = getMap();
  if (map) { map.dragPan.enable(); map.dragRotate.enable(); map.boxZoom.enable(); }

  S.selectedAnnotationIdx = null;
  hideDetailPanel();
  clearResizeHandles();
  markGeoJSONDirty();
  refreshAnnotationList();
  const selected = document.getElementById('annotation-list')?.querySelector('.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// 選択変更のみ（GeoJSON全再生成なし、selectedプロパティだけ差分更新）
function updateSelectionOnly() {
  if (S._cachedGeoJSON?.features) {
    S._cachedGeoJSON.features.forEach((f, i) => {
      f.properties.selected = (i === S.selectedAnnotationIdx);
    });
    updateAnnotations(S._cachedGeoJSON);
  } else {
    markGeoJSONDirty();
    updateGeoJSONIfNeeded();
  }
  // サイドバーリストのselectedクラス更新
  const listContainer = document.getElementById('annotation-list');
  if (listContainer) {
    listContainer.querySelectorAll('.annotation-item').forEach((el, i) => {
      el.classList.toggle('selected', i === S.selectedAnnotationIdx);
    });
  }
}

function updateGeoJSONIfNeeded() {
  if (!S._geoJSONDirty) return;
  S._cachedGeoJSON = annotationsToGeoJSON(filterAnnotations(S.annotations), S.selectedAnnotationIdx);
  updateAnnotations(S._cachedGeoJSON);
  S._geoJSONDirty = false;
}

function refreshAnnotationList() {
  const filtered = filterAnnotations(S.annotations);
  const listContainer = document.getElementById('annotation-list');
  if (!listContainer) return;  // ログアウト後など、認証後コンテンツが破棄されているとき

  let countEl = document.getElementById('annotation-count');
  if (!countEl) {
    countEl = document.createElement('span');
    countEl.id = 'annotation-count';
    countEl.style.cssText = 'font-size:11px;color:#888;font-weight:normal;margin-left:6px;';
    const h3 = document.querySelector('[data-target="favorites-content"]');
    if (h3) h3.appendChild(countEl);
  }
  const hasFilter = S.filterConfig.sets.some(s => s.enabled !== false && s.rows.some(r => r.label || r.type));
  if (hasFilter && S._filteredTotal > filtered.length) {
    countEl.textContent = `${filtered.length}/${S._filteredTotal}\u4ef6`;
  } else {
    countEl.textContent = `${filtered.length}\u4ef6`;
  }

  renderAnnotationList(
    filtered,
    listContainer,
    isEditable() ? handleDeleteAnnotation : null,
    isEditable() ? handleEditAnnotation : null,
    (i) => {
      S.selectedAnnotationIdx = i;
      updateSelectionOnly();
      const filt = filterAnnotations(S.annotations);
      if (filt[i]) showDetailPanel(filt[i]);
      clearResizeHandles();
    },
    S.selectedAnnotationIdx
  );
  updateGeoJSONIfNeeded();
  if (S.galleryMode) renderGalleryView();

  const bulkBar = document.getElementById('gallery-actions');
  if (bulkBar) {
    bulkBar.style.display = S.galleryMode ? 'flex' : 'none';
    const countSpan = document.getElementById('bulk-count');
    if (countSpan) countSpan.textContent = `\u8868\u793a\u4e2d ${filtered.length}\u4ef6\u306b\u5bfe\u3057\u3066:`;
    const editActions = document.getElementById('bulk-edit-actions');
    if (editActions) editActions.style.display = isEditable() ? 'inline' : 'none';
  }
}

// ── Bulk actions ──
function _getDisplayedAnnotations() {
  return filterAnnotations(S.annotations);
}

async function bulkLabelDisplayed() {
  const displayed = _getDisplayedAnnotations();
  if (!displayed.length) return;
  const existing = (S.projectLabels || []).map(l => l.name);

  const name = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:320px;">
      <h2 style="font-size:15px;margin:0 0 12px;">${displayed.length}\u4ef6\u306b\u30e9\u30d9\u30eb\u3092\u8ffd\u52a0</h2>
      ${existing.length ? `<div style="margin-bottom:8px;font-size:12px;color:#aaa;">\u65e2\u5b58\u30e9\u30d9\u30eb:</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">
        ${existing.map(n => `<button class="btn btn-sm btn-outline pick-label" data-name="${n}" style="font-size:12px;">${n}</button>`).join('')}
      </div>` : ''}
      <div style="font-size:12px;color:#aaa;margin-bottom:4px;">\u65b0\u3057\u3044\u30e9\u30d9\u30eb:</div>
      <div style="display:flex;gap:4px;">
        <input type="text" id="bulk-label-input" placeholder="\u30e9\u30d9\u30eb\u540d" style="flex:1;padding:6px 8px;background:#0d1117;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:13px;">
        <button class="btn btn-sm" id="bulk-label-ok">\u8ffd\u52a0</button>
      </div>
      <button class="btn btn-outline" style="width:100%;margin-top:10px;" id="bulk-label-cancel">\u30ad\u30e3\u30f3\u30bb\u30eb</button>
    </div>`;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#bulk-label-cancel').onclick = () => close(null);
    overlay.querySelector('#bulk-label-ok').onclick = () => {
      const v = overlay.querySelector('#bulk-label-input').value.trim();
      if (v) close(v);
    };
    overlay.querySelector('#bulk-label-input').onkeydown = (e) => {
      if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) close(v); }
    };
    overlay.querySelectorAll('.pick-label').forEach(btn => {
      btn.onclick = () => close(btn.dataset.name);
    });
    overlay.querySelector('#bulk-label-input').focus();
  });
  if (!name) return;
  S.busyStart();
  const token = localStorage.getItem('token');
  try {
    const res = await fetch('/api/annotations/bulk-add-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ids: displayed.map(a => a.id), label_name: name })
    });
    if (!res.ok) throw new Error(await res.text());
    invalidateFilterCache();
    await applyFilterAsync();
  } catch (e) { alert('\u4e00\u62ec\u30e9\u30d9\u30eb\u8ffd\u52a0\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function bulkVoteDisplayed(vote) {
  if (!S.currentProject) return;
  const total = S._filteredTotal ?? _getDisplayedAnnotations().length;
  if (!total) return;
  const voteLabel = vote === 'yes' ? '\u2b55' : vote === 'no' ? '\u274c' : vote === 'pass' ? '\u2753' : '🈚\u672a\u8a55\u4fa1';
  if (!confirm(`\u30d5\u30a3\u30eb\u30bf\u306b\u4e00\u81f4\u3059\u308b${total}\u4ef6\u3092${voteLabel}\u306b\u3057\u307e\u3059\u304b\uff1f`)) return;
  S.busyStart();
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/bulk-vote-filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ vote, filter: S.filterConfig })
    });
    if (!res.ok) throw new Error(await res.text());
    invalidateFilterCache();
    await applyFilterAsync();
  } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function bulkDeleteDisplayed() {
  const displayed = _getDisplayedAnnotations();
  if (!displayed.length) return;
  if (!confirm(`\u8868\u793a\u4e2d\u306e${displayed.length}\u4ef6\u3092\u3059\u3079\u3066\u524a\u9664\u3057\u307e\u3059\u304b\uff1f`)) return;
  const deleted = await _bulkDelete(displayed.map(a => a.id));
  alert(`${deleted}\u4ef6\u3092\u524a\u9664\u3057\u307e\u3057\u305f`);
}

// ── Filter ──
function _filterKey() { return `geoscope_filter_config_${S.currentProject?.id || 'default'}`; }

function filterAnnotations(list) {
  if (S._filteredCache !== null) return S._filteredCache;
  return [];
}

async function applyFilterAsync() { S.busyStart(); try {
  if (!S.currentProject) return;
  const token = localStorage.getItem('token');
  if (!token) return;

  const configJson = JSON.stringify(S.filterConfig);
  const cacheKey = configJson + ':' + S.annotations.length;
  if (cacheKey === S._filterCacheKey && S._filteredCache !== null) return;

  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: configJson
    });
    if (!res.ok) return;
    const resp = await res.json();
    const data = resp.items || resp;
    S._filteredTotal = resp.total ?? data.length;
    const localMap = new Map(S.annotations.map(a => [a.id, a]));
    S._filteredCache = data.map(a => {
      if (localMap.has(a.id)) return localMap.get(a.id);
      const z = a.tile_z || 16;
      const n = Math.pow(2, z);
      const lonPerTile = 360 / n;
      const tileLonMin = a.tile_x / n * 360 - 180;
      const west = tileLonMin + (a.bbox_px_cx - a.bbox_px_w/2) * lonPerTile;
      const east = tileLonMin + (a.bbox_px_cx + a.bbox_px_w/2) * lonPerTile;
      const mercTop = (a.tile_y + a.bbox_px_cy - a.bbox_px_h/2) / n;
      const mercBot = (a.tile_y + a.bbox_px_cy + a.bbox_px_h/2) / n;
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercTop))) * 180 / Math.PI;
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercBot))) * 180 / Math.PI;
      return {
        id: a.id, bbox: [west, south, east, north],
        tile_x: a.tile_x, tile_y: a.tile_y, tile_z: z,
        bbox_px_cx: a.bbox_px_cx, bbox_px_cy: a.bbox_px_cy,
        bbox_px_w: a.bbox_px_w, bbox_px_h: a.bbox_px_h,
        title: a.title, labels: a.labels || [], annotation_vote: a.annotation_vote,
        comment: a.comment, score: a.score || 0, prefecture: a.prefecture || '', tiles: [],
        geometry: { type: 'Polygon', coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]] }
      };
    });
    S._filterCacheKey = cacheKey;
    S.annotations = S._filteredCache;
  } catch (e) {
    console.error('Filter API error:', e);
    S._filteredCache = S.annotations;
  }
  S.selectedAnnotationIdx = null;
  markGeoJSONDirty();
  refreshAnnotationList();
} finally { S.busyEnd(); } }

function invalidateFilterCache() {
  S._filteredCache = null;
  S._filterCacheKey = '';
}

function saveFilters() {
  localStorage.setItem(_filterKey(), JSON.stringify(S.filterConfig));
}
function loadFilters() {
  S.filterConfig = JSON.parse(localStorage.getItem(_filterKey()) || '{"sets":[{"rows":[]}],"spatials":[]}');
  if (!S.filterConfig.sets) S.filterConfig = { sets: [{ rows: [] }], spatials: [] };
}

// ── Label colors ──
function labelHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}
function labelColor(name, s = 70, l = 55) { return `hsl(${labelHue(name)}, ${s}%, ${l}%)`; }
function labelBg(name) { return `hsl(${labelHue(name)}, 30%, 15%)`; }
function labelBorder(name) { return `hsl(${labelHue(name)}, 40%, 30%)`; }

function showLabelActionMenu(e, labelName, emoji) {
  document.querySelectorAll('.label-action-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'label-action-menu';
  menu.style.cssText = `position:fixed;z-index:2000;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;padding:4px 0;font-size:12px;min-width:220px;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const otherLabels = new Set();
  S.annotations.forEach(a => (a.labels || []).forEach(l => { if (l.name && l.name !== labelName) otherLabels.add(l.name); }));

  const actions = [
    { label: `\ud83d\uddd1\ufe0f \u300c${labelName}\u300d\u3092\u9664\u53bb`, action: () => bulkDeleteByLabel(labelName) },
    { label: `\ud83d\uddd1\ufe0f \u5730\u56f3\u306a\u3057\u3092\u5168\u524a\u9664`, action: () => bulkDeleteNoTile() },
    { label: `\ud83c\udff7\ufe0f \u5225\u306e\u30e9\u30d9\u30eb\u3092\u4e00\u62ec\u8ffd\u52a0...`, action: () => bulkAddLabel(labelName) },
  ];

  if (otherLabels.size > 0) {
    actions.push({ label: '\u2500\u2500\u2500 \u7a7a\u9593\u30d5\u30a3\u30eb\u30bf \u2500\u2500\u2500', action: null });
    for (const other of otherLabels) {
      actions.push({
        label: `\ud83d\udd0d \u300c${labelName}\u300d\u2229\u300c${other}\u300d\uff08\u91cd\u306a\u308b\u3082\u306e\uff09`,
        action: () => setSpatialFilter(labelName, other, 'intersect')
      });
      actions.push({
        label: `\ud83d\udd0d \u300c${labelName}\u300d\u306e\u307f\uff08\u300c${other}\u300d\u3068\u91cd\u306a\u3089\u306a\u3044\uff09`,
        action: () => setSpatialFilter(labelName, other, 'disjoint')
      });
    }
  }

  actions.forEach(({ label, action }) => {
    const item = document.createElement('div');
    item.textContent = label;
    if (action) {
      item.style.cssText = 'padding:6px 12px;cursor:pointer;color:#ccc;';
      item.onmouseenter = () => item.style.background = '#2a2a4a';
      item.onmouseleave = () => item.style.background = '';
      item.onclick = () => { menu.remove(); action(); };
    } else {
      item.style.cssText = 'padding:3px 12px;color:#555;font-size:10px;';
    }
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function _bulkDelete(ids) { S.busyStart(); try {
  const token = localStorage.getItem('token');
  const res = await fetch('/api/annotations/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ids })
  });
  if (!res.ok) throw new Error('Bulk delete failed');
  const data = await res.json();
  S.selectedAnnotationIdx = null;
  invalidateFilterCache();
  await applyFilterAsync();
  return data.deleted;
} finally { S.busyEnd(); } }

async function bulkDeleteByLabel(labelName) {
  const matching = S.annotations.filter(a => (a.labels || []).some(l => l.name === labelName));
  if (!confirm(`\u300c${labelName}\u300d\u30e9\u30d9\u30eb\u3092${matching.length}\u4ef6\u304b\u3089\u9664\u53bb\u3057\u307e\u3059\u304b\uff1f\n\uff08\u4ed6\u306b\u30e9\u30d9\u30eb\u304c\u306a\u3044\u304a\u6c17\u306b\u5165\u308a\u306f\u524a\u9664\u3055\u308c\u307e\u3059\uff09`)) return;
  const token = localStorage.getItem('token');
  try {
    const res = await fetch('/api/annotations/bulk-remove-label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ids: matching.map(a => a.id), label_name: labelName })
    });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    matching.forEach(a => { a.labels = (a.labels || []).filter(l => l.name !== labelName); });
    S.annotations = S.annotations.filter(a => (a.labels || []).length > 0 || !matching.some(m => m.id === a.id) || data.deleted === 0);
    await loadProjectData();
    alert(`${data.unlinked}\u4ef6\u304b\u3089\u30e9\u30d9\u30eb\u9664\u53bb\u3001${data.deleted}\u4ef6\u524a\u9664`);
  } catch (e) { alert('\u5931\u6557: ' + e.message); }
}

async function bulkEnrichGoogle() {
  if (!S.currentProject) return;
  let googleKey = S.loadPrefs().google_api_key;
  if (!googleKey) googleKey = prompt('Google Places API\u30ad\u30fc\u3092\u5165\u529b:', '');
  if (!googleKey) return;
  S.savePrefs({ google_api_key: googleKey });

  const keyword = prompt('\u691c\u7d22\u30ad\u30fc\u30ef\u30fc\u30c9\uff08\u7a7a\u6b04\u3067\u5168POI\uff09:', '');
  if (keyword === null) return;

  const untitled = S.annotations.filter(a => !a.title || a.title === '').length;
  if (!untitled) { alert('\u540d\u524d\u672a\u8a2d\u5b9a\u306e\u304a\u6c17\u306b\u5165\u308a\u304c\u3042\u308a\u307e\u305b\u3093'); return; }
  const MAX_GOOGLE = 100;
  const count = Math.min(untitled, MAX_GOOGLE);
  const cost = (count / 1000 * 32).toFixed(1);
  const limitMsg = untitled > MAX_GOOGLE ? `\n\uff08\u4e0a\u9650${MAX_GOOGLE}\u4ef6\u307e\u3067\u51e6\u7406\u3055\u308c\u307e\u3059\uff09` : '';
  const kwMsg = keyword ? `\n\u30ad\u30fc\u30ef\u30fc\u30c9: \u300c${keyword}\u300d` : '';
  if (!confirm(`\u540d\u524d\u672a\u8a2d\u5b9a\u306e${untitled}\u4ef6\u3092Google Places API\u3067\u691c\u7d22\u3057\u307e\u3059\u304b\uff1f${kwMsg}${limitMsg}\n\uff08\u63a8\u5b9a\u30b3\u30b9\u30c8: $${cost}\uff09`)) return;

  S.busyStart();
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/enrich-google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filter: S.filterConfig, google_api_key: googleKey, max_distance_m: 100, keyword })
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    alert(`Google Places: ${result.matched}\u4ef6\u306b\u540d\u524d\u3092\u4ed8\u4e0e\u3057\u307e\u3057\u305f`);
    if (result.matched > 0) { invalidateFilterCache(); await applyFilterAsync(); }
  } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function startRescore() {
  if (!S.currentProject) return;
  const count = S._filteredTotal || S.annotations.length;
  if (!confirm(`\u30d5\u30a3\u30eb\u30bf\u7d50\u679c\u306e${count}\u4ef6\u3092\u6700\u65b0\u30e2\u30c7\u30eb\u3067\u518d\u30b9\u30b3\u30a2\u30ea\u30f3\u30b0\u3057\u307e\u3059\u304b\uff1f\n\uff08\u518d\u5b66\u7fd2 + \u5bfe\u8c61\u30bf\u30a4\u30eb\u306e\u307f\u518d\u63a8\u8ad6\uff09`)) return;
  S.busyStart();
  const token = localStorage.getItem('token');
  const rsHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ..._byoHeaders() };
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/rescore`, {
      method: 'POST',
      headers: rsHeaders,
      body: JSON.stringify({ filter: S.filterConfig })
    });
    if (!res.ok) throw new Error(await res.text());
    alert('\u518d\u30b9\u30b3\u30a2\u30b8\u30e7\u30d6\u3092\u958b\u59cb\u3057\u307e\u3057\u305f');
    loadJobs();
  } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function bulkDedup() {
  if (!S.currentProject) return;
  if (!confirm('\u30d5\u30a3\u30eb\u30bf\u7d50\u679c\u306e\u3046\u3061\u3001\u91cd\u306a\u308bbbox\u306e\u30b9\u30b3\u30a2\u304c\u4f4e\u3044\u65b9\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f')) return;
  S.busyStart();
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/dedup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filter: S.filterConfig })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    alert(`${data.checked}\u4ef6\u4e2d\u3001${data.deleted}\u4ef6\u306e\u91cd\u8907\u3092\u524a\u9664\u3057\u307e\u3057\u305f`);
    if (data.deleted > 0) { invalidateFilterCache(); await applyFilterAsync(); }
  } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function bulkDeleteNoTile() {
  if (!S.currentProject) return;
  if (!confirm('\u30d5\u30a3\u30eb\u30bf\u7d50\u679c\u306e\u3046\u3061\u3001\u5730\u56f3(DEM)\u306a\u3057\u306e\u304a\u6c17\u306b\u5165\u308a\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f')) return;
  S.busyStart();
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations/delete-no-dem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filter: S.filterConfig })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    alert(`${data.checked}\u4ef6\u4e2d\u3001\u5730\u56f3\u306a\u3057\u306e${data.deleted}\u4ef6\u3092\u524a\u9664\u3057\u307e\u3057\u305f`);
    if (data.deleted > 0) { invalidateFilterCache(); await applyFilterAsync(); }
  } catch (e) { alert('\u5931\u6557: ' + e.message); } finally { S.busyEnd(); }
}

async function bulkAddLabel(existingLabelName) {
  const newLabel = prompt('\u8ffd\u52a0\u3059\u308b\u30e9\u30d9\u30eb\u540d\u3092\u5165\u529b:', '');
  if (!newLabel) return;
  const matching = S.annotations.filter(a => (a.labels || []).some(l => l.name === existingLabelName));
  if (!confirm(`\u300c${existingLabelName}\u300d\u30e9\u30d9\u30eb\u306e${matching.length}\u4ef6\u306b\u300c${newLabel}\u300d\u30e9\u30d9\u30eb\u3092\u8ffd\u52a0\u3057\u307e\u3059\u304b\uff1f`)) return;

  const token = localStorage.getItem('token');
  let updated = 0;
  for (const a of matching) {
    if ((a.labels || []).some(l => l.name === newLabel)) continue;
    const labels = [...(a.labels || []), { name: newLabel, emoji: '\ud83d\udccd', vote: 'yes' }];
    try {
      const res = await fetch(`/api/annotations/${a.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ labels })
      });
      if (res.ok) { a.labels = labels; updated++; }
    } catch {}
  }
  updateLabelFilter();
  markGeoJSONDirty();
  refreshAnnotationList();
  alert(`${updated}\u4ef6\u306b\u30e9\u30d9\u30eb\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f`);
}

function setSpatialFilter(labelA, labelB, mode) {
  const bBoxes = S.annotations
    .filter(a => (a.labels || []).some(l => l.name === labelB))
    .map(a => a.bbox)
    .filter(Boolean);

  const filterLabel = mode === 'intersect'
    ? `${labelA} \u2229 ${labelB}`
    : `${labelA} \\ ${labelB}`;

  setCustomFilter((a) => {
    if (!(a.labels || []).some(l => l.name === labelA)) return false;
    if (!a.bbox) return mode === 'disjoint';
    const hasOverlap = bBoxes.some(bb => _bboxIntersects(a.bbox, bb));
    return mode === 'intersect' ? hasOverlap : !hasOverlap;
  }, filterLabel);
}

function setCustomFilter(fn, label) {
  customFilterFn = fn;
  customFilterLabel = label;
  S.selectedAnnotationIdx = null;
  markGeoJSONDirty();
  refreshAnnotationList();
}

function clearCustomFilter() {
  customFilterFn = null;
  customFilterLabel = '';
  S.selectedAnnotationIdx = null;
  markGeoJSONDirty();
  refreshAnnotationList();
}

// ── Label Manager ──
async function showLabelManager() {
  if (!S.currentProject) return;
  const existingOverlay = document.querySelector('.label-manager-overlay');
  const existingPanel = existingOverlay?.querySelector('.label-manager-panel');

  const token = localStorage.getItem('token');
  const headers = { 'Authorization': `Bearer ${token}` };

  let dbLabels = [];
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/labels`, { headers });
    if (res.ok) dbLabels = await res.json();
  } catch {}

  const countMap = new Map();
  S.annotations.forEach(a => (a.labels || []).forEach(l => {
    if (!l.name) return;
    countMap.set(l.name, (countMap.get(l.name) || 0) + 1);
  }));

  const btnStyle = 'background:none;border:1px solid #2a2a4a;border-radius:4px;padding:2px 4px;cursor:pointer;font-size:12px;';

  const overlay = existingOverlay || document.createElement('div');
  if (!existingOverlay) {
    overlay.className = 'label-manager-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  }

  const panel = existingPanel || document.createElement('div');
  panel.className = 'label-manager-panel';
  panel.style.cssText = 'background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:16px;min-width:300px;max-width:90vw;max-height:80vh;overflow-y:auto;color:#e0e0e0;font-size:13px;';
  panel.innerHTML = '';

  const title = document.createElement('h3');
  title.textContent = '\ud83c\udff7\ufe0f \u30e9\u30d9\u30eb\u7ba1\u7406';
  title.style.cssText = 'margin:0 0 12px;font-size:15px;';
  panel.appendChild(title);

  if (!dbLabels.length) {
    const empty = document.createElement('p');
    empty.textContent = '\u30e9\u30d9\u30eb\u304c\u3042\u308a\u307e\u305b\u3093';
    empty.style.color = '#888';
    panel.appendChild(empty);
  }

  dbLabels.forEach(lbl => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #2a2a4a;';

    const emojiBtn = document.createElement('button');
    emojiBtn.textContent = lbl.emoji;
    emojiBtn.title = '\u7d75\u6587\u5b57\u3092\u5909\u66f4';
    emojiBtn.style.cssText = 'font-size:18px;' + btnStyle;
    emojiBtn.onclick = async () => {
      const v = prompt(`\u300c${lbl.name}\u300d\u306e\u7d75\u6587\u5b57:`, lbl.emoji);
      if (!v || v === lbl.emoji) return;
      await patchLabel(lbl.id, { emoji: v });
      showLabelManager();
    };
    row.appendChild(emojiBtn);

    if (!lbl.system) {
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = lbl.color || '#888888';
      colorInput.title = '\u8272\u3092\u5909\u66f4\uff08\u30c0\u30d6\u30eb\u30af\u30ea\u30c3\u30af\u3067\u30ea\u30bb\u30c3\u30c8\uff09';
      colorInput.style.cssText = 'width:24px;height:24px;padding:0;border:1px solid #2a2a4a;border-radius:4px;cursor:pointer;background:none;' + (lbl.color ? '' : 'opacity:0.3;');
      colorInput.onchange = async () => {
        await patchLabel(lbl.id, { color: colorInput.value });
        colorInput.style.opacity = '';
        showLabelManager();
      };
      colorInput.ondblclick = async (e) => {
        e.preventDefault();
        await patchLabel(lbl.id, { color: '' });
        showLabelManager();
      };
      row.appendChild(colorInput);
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = lbl.name;
    nameSpan.style.cssText = 'flex:1;';
    row.appendChild(nameSpan);

    const cnt = countMap.get(lbl.name) || 0;
    const countSpan = document.createElement('span');
    countSpan.textContent = `${cnt}\u4ef6`;
    countSpan.style.cssText = 'color:#888;font-size:11px;';
    row.appendChild(countSpan);

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '\u270f\ufe0f'; renameBtn.title = '\u540d\u524d\u5909\u66f4'; renameBtn.style.cssText = btnStyle;
    renameBtn.onclick = async () => {
      const v = prompt(`\u300c${lbl.name}\u300d\u306e\u65b0\u3057\u3044\u540d\u524d:`, lbl.name);
      if (!v || v === lbl.name) return;
      await patchLabel(lbl.id, { name: v });
      showLabelManager();
    };
    row.appendChild(renameBtn);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '\ud83d\udccb'; copyBtn.title = '\u30e9\u30d9\u30eb\u3092\u8907\u88fd\uff08\u304a\u6c17\u306b\u5165\u308a\u3054\u3068\uff09'; copyBtn.style.cssText = btnStyle;
    copyBtn.onclick = async () => {
      const newName = prompt(`\u300c${lbl.name}\u300d\u306e\u8907\u88fd\u5148\u30e9\u30d9\u30eb\u540d:`, lbl.name + '_copy');
      if (!newName || newName === lbl.name) return;
      const res = await fetch(`/api/labels/${lbl.id}/duplicate`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName })
      });
      if (!res.ok) { alert('\u8907\u88fd\u306b\u5931\u6557\u3057\u307e\u3057\u305f\uff08\u540c\u540d\u306e\u30e9\u30d9\u30eb\u304c\u5b58\u5728\uff1f\uff09'); return; }
      const data = await res.json();
      alert(`${data.annotations_copied}\u4ef6\u306e\u304a\u6c17\u306b\u5165\u308a\u3092\u8907\u88fd\u3057\u307e\u3057\u305f`);
      overlay.remove();
      await loadProjectData();
      showLabelManager();
    };
    row.appendChild(copyBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '\ud83d\uddd1\ufe0f'; delBtn.title = '\u30e9\u30d9\u30eb\u3092\u524a\u9664'; delBtn.style.cssText = btnStyle;
    delBtn.onclick = async () => {
      if (!confirm(`\u300c${lbl.name}\u300d\u30e9\u30d9\u30eb\u3092${cnt}\u4ef6\u304b\u3089\u9664\u53bb\u3057\u307e\u3059\u304b\uff1f\n\uff08\u4ed6\u306b\u30e9\u30d9\u30eb\u304c\u306a\u3044\u304a\u6c17\u306b\u5165\u308a\u306f\u524a\u9664\u3055\u308c\u307e\u3059\uff09`)) return;
      const res = await fetch(`/api/labels/${lbl.id}`, { method: 'DELETE', headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.detail || '\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f');
        return;
      }
      await loadProjectData();
      showLabelManager();
    };
    row.appendChild(delBtn);

    panel.appendChild(row);
  });

  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:4px;margin-top:8px;';
  const addInput = document.createElement('input');
  addInput.type = 'text'; addInput.placeholder = '\u65b0\u3057\u3044\u30e9\u30d9\u30eb\u540d';
  addInput.style.cssText = 'flex:1;background:#16213e;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px 8px;font-size:12px;';
  addRow.appendChild(addInput);
  const addEmojiInput = document.createElement('input');
  addEmojiInput.type = 'text'; addEmojiInput.value = '\ud83d\udccd';
  addEmojiInput.style.cssText = 'width:40px;background:#16213e;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;padding:4px;font-size:14px;text-align:center;';
  addRow.appendChild(addEmojiInput);
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm'; addBtn.textContent = '\u8ffd\u52a0';
  addBtn.onclick = async () => {
    const name = addInput.value.trim();
    if (!name) return;
    const emoji = addEmojiInput.value.trim() || '\ud83d\udccd';
    const res = await fetch(`/api/projects/${S.currentProject.id}/labels`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji })
    });
    if (!res.ok) { alert('\u8ffd\u52a0\u306b\u5931\u6557\u3057\u307e\u3057\u305f\uff08\u65e2\u306b\u5b58\u5728\uff1f\uff09'); return; }
    showLabelManager();
    updateLabelFilter();
  };
  addRow.appendChild(addBtn);
  panel.appendChild(addRow);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-outline'; closeBtn.textContent = '\u9589\u3058\u308b';
  closeBtn.style.cssText = 'margin-top:8px;width:100%;';
  closeBtn.onclick = () => overlay.remove();
  panel.appendChild(closeBtn);

  if (!existingPanel) overlay.appendChild(panel);
  if (!existingOverlay) document.body.appendChild(overlay);
}

async function patchLabel(labelId, body) {
  const token = localStorage.getItem('token');
  const res = await fetch(`/api/labels/${labelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) { alert('\u30e9\u30d9\u30eb\u306e\u66f4\u65b0\u306b\u5931\u6557\u3057\u307e\u3057\u305f'); return; }
  const data = await res.json();
  S.annotations.forEach(a => (a.labels || []).forEach(l => {
    if (body.name !== undefined && l.name === (data.name !== body.name ? body.name : l.name)) {
    }
  }));
  await loadProjectData();
}

function updateLabelFilter() {
  const container = document.getElementById('filter-builder');
  if (!container) return;

  const labelMap = new Map();
  S.projectLabels.forEach(l => { if (l.name) labelMap.set(l.name, l.emoji || '\u{1F4CD}'); });
  S.annotations.forEach(a => (a.labels || []).forEach(l => {
    if (!l.name) return;
    if (!labelMap.has(l.name)) labelMap.set(l.name, l.emoji || '\u{1F4CD}');
  }));
  const labelNames = [...labelMap.keys()].sort();

  function render() {
    container.innerHTML = '';

    S.filterConfig.sets.forEach((set, si) => {
      if (si > 0) {
        const spatialRow = document.createElement('div');
        spatialRow.className = 'filter-row';
        const spatialSel = document.createElement('select');
        const sp = S.filterConfig.spatials[si-1] || 'intersects';
        spatialSel.innerHTML = '<option value="intersects"' + (sp === 'intersects' ? ' selected' : '') + '>\u2195 \u91cd\u306a\u308b</option>' +
          '<option value="disjoint"' + (sp === 'disjoint' ? ' selected' : '') + '>\u2195 \u91cd\u306a\u3089\u306a\u3044</option>' +
          '<option value="union"' + (sp === 'union' ? ' selected' : '') + '>\u2195 \u4e21\u65b9</option>';
        spatialSel.style.cssText = 'background:#2a1a3a;color:#c084fc;border-color:#7c3aed;margin-left:auto;flex:0 0 auto;';
        spatialSel.onchange = () => { S.filterConfig.spatials[si-1] = spatialSel.value; render(); };
        spatialRow.appendChild(spatialSel);
        container.appendChild(spatialRow);
      }

      const setWrap = document.createElement('div');
      setWrap.style.cssText = 'display:flex;align-items:stretch;margin-left:4px;';

      if (S.filterConfig.sets.length > 1 || set.rows.length > 0) {
        if (set.visible === undefined) set.visible = true;
        if (set.enabled === undefined) set.enabled = true;
        const btnCol = document.createElement('div');
        btnCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;';
        const enBtn = document.createElement('button');
        enBtn.className = 'eye-toggle' + (set.enabled ? '' : ' closed');
        enBtn.innerHTML = '<span class="eye-icon">\u26a1</span>';
        enBtn.title = set.enabled ? '\u3053\u306e\u30bb\u30c3\u30c8\u306e\u6761\u4ef6\u306f\u6709\u52b9' : '\u3053\u306e\u30bb\u30c3\u30c8\u306e\u6761\u4ef6\u306f\u7121\u52b9\uff08\u5168\u4ef6\u901a\u904e\uff09';
        enBtn.onclick = () => { set.enabled = !set.enabled; render(); };
        btnCol.appendChild(enBtn);
        const eyeBtn = document.createElement('button');
        eyeBtn.className = 'eye-toggle' + (set.visible ? '' : ' closed');
        eyeBtn.innerHTML = '<span class="eye-icon">\ud83d\udc41\ufe0f</span>';
        eyeBtn.title = set.visible ? '\u3053\u306e\u30bb\u30c3\u30c8\u3092\u8868\u793a' : '\u3053\u306e\u30bb\u30c3\u30c8\u3092\u975e\u8868\u793a';
        if (!set.enabled) { eyeBtn.style.opacity = '0.2'; eyeBtn.style.pointerEvents = 'none'; }
        else { eyeBtn.onclick = () => { set.visible = !set.visible; render(); }; }
        btnCol.appendChild(eyeBtn);
        const delSetBtn = document.createElement('button');
        delSetBtn.className = 'eye-toggle';
        delSetBtn.innerHTML = '<span class="eye-icon" style="font-size:10px;">\ud83d\uddd1\ufe0f</span>';
        delSetBtn.title = '\u3053\u306e\u30bb\u30c3\u30c8\u3092\u524a\u9664';
        delSetBtn.onclick = () => {
          S.filterConfig.sets.splice(si, 1);
          if (si > 0) S.filterConfig.spatials.splice(si - 1, 1);
          else if (S.filterConfig.spatials.length) S.filterConfig.spatials.splice(0, 1);
          render();        };
        btnCol.appendChild(delSetBtn);
        setWrap.appendChild(btnCol);
      }

      const setDiv = document.createElement('div');
      const disabled = set.enabled === false;
      setDiv.style.cssText = 'border-left:2px solid #7c3aed;padding-left:6px;flex:1;' + (disabled ? 'opacity:0.35;pointer-events:none;' : '');

      set.rows.forEach((frow, ri) => {
        const row = document.createElement('div');
        row.className = 'filter-row';

        if (!frow.label && !frow.type) {
          const _scanL = (S.projectLabels || []).filter(l => l.system).map(l => l.name).sort().reverse();
          frow.label = _scanL.length > 0 ? _scanL[0] : (labelNames.length > 0 ? labelNames[0] : '');
        }
        const annoOpts = [
          {value: 'yes', text: '\u2b55 \u30dd\u30b8\u30c6\u30a3\u30d6'},
          {value: 'no', text: '\u274c \u30cd\u30ac\u30c6\u30a3\u30d6'},
          {value: 'pass', text: '\u2753 \u4fdd\u7559'},
          {value: 'any', text: '🈶 \u8a55\u4fa1\u6e08\u307f'},
          {value: 'none', text: '🈚 \u672a\u8a55\u4fa1'},
        ];
        const _prefs = ['\u5317\u6d77\u9053','\u9752\u68ee\u770c','\u5ca9\u624b\u770c','\u5bae\u57ce\u770c','\u79cb\u7530\u770c','\u5c71\u5f62\u770c','\u798f\u5cf6\u770c','\u8328\u57ce\u770c','\u6803\u6728\u770c','\u7fa4\u99ac\u770c','\u57fc\u7389\u770c','\u5343\u8449\u770c','\u6771\u4eac\u90fd','\u795e\u5948\u5ddd\u770c','\u65b0\u6f5f\u770c','\u5bcc\u5c71\u770c','\u77f3\u5ddd\u770c','\u798f\u4e95\u770c','\u5c71\u68a8\u770c','\u9577\u91ce\u770c','\u5c90\u961c\u770c','\u9759\u5ca1\u770c','\u611b\u77e5\u770c','\u4e09\u91cd\u770c','\u6ecb\u8cc0\u770c','\u4eac\u90fd\u5e9c','\u5927\u962a\u5e9c','\u5175\u5eab\u770c','\u5948\u826f\u770c','\u548c\u6b4c\u5c71\u770c','\u9ce5\u53d6\u770c','\u5cf6\u6839\u770c','\u5ca1\u5c71\u770c','\u5e83\u5cf6\u770c','\u5c71\u53e3\u770c','\u5fb3\u5cf6\u770c','\u9999\u5ddd\u770c','\u611b\u5a9b\u770c','\u9ad8\u77e5\u770c','\u798f\u5ca1\u770c','\u4f50\u8cc0\u770c','\u9577\u5d0e\u770c','\u718a\u672c\u770c','\u5927\u5206\u770c','\u5bae\u5d0e\u770c','\u9e7f\u5150\u5cf6\u770c','\u6c96\u7e04\u770c'];

        const scanLabels = (S.projectLabels || []).filter(l => l.system).map(l => l.name).sort().reverse();
        const userLabels = labelNames.filter(n => !scanLabels.includes(n));
        const currentCat = frow.type === 'overlap' ? 'overlap'
          : frow.type === 'title' ? 'title'
          : frow.type === 'annotation' ? 'annotation'
          : frow.type === 'prefecture' ? 'prefecture'
          : scanLabels.includes(frow.label) ? 'scan'
          : 'label';

        const catSel = document.createElement('select');
        catSel.style.cssText = 'flex:0 0 auto;';
        const cats = [
          { value: 'annotation', text: '\u8a55\u4fa1' },
          { value: 'title', text: '\u540d\u524d' },
          ...(scanLabels.length ? [{ value: 'scan', text: '\u63a2\u7d22\u7d50\u679c' }] : []),
          ...(userLabels.length ? [{ value: 'label', text: '\u30e9\u30d9\u30eb' }] : []),
          { value: 'prefecture', text: '\u90fd\u9053\u5e9c\u770c' },
          { value: 'overlap', text: '\u91cd\u306a\u308a\u3042\u308a' },
        ];
        catSel.innerHTML = cats.map(c =>
          `<option value="${c.value}"${c.value === currentCat ? ' selected' : ''}>${c.text}</option>`
        ).join('');

        const detSel = document.createElement('select');
        const detInput = document.createElement('input');
        detInput.type = 'text';
        detInput.placeholder = '\u540d\u524d\u3067\u691c\u7d22...';
        detInput.style.cssText = 'flex:1 1 0;padding:2px 4px;font-size:11px;background:#16213e;color:#e0e0e0;border:1px solid #2a2a4a;border-radius:4px;display:none;';
        detInput.value = frow.type === 'title' ? (frow.value || '') : '';
        let _titleTimer = null;
        detInput.oninput = () => {
          clearTimeout(_titleTimer);
          _titleTimer = setTimeout(() => {
            frow.type = 'title'; frow.value = detInput.value.trim(); frow.label = '';
          }, 500);
        };
        function updateDetail() {
          const cat = catSel.value;
          if (cat === 'title') {
            detSel.style.display = 'none';
            detInput.style.display = '';
          } else if (cat === 'overlap') {
            detSel.style.display = 'none';
            detInput.style.display = 'none';
          } else {
            detSel.style.display = '';
            detInput.style.display = 'none';
          }
          if (cat === 'annotation') {
            detSel.innerHTML = annoOpts.map(o =>
              `<option value="${o.value}"${frow.type === 'annotation' && frow.value === o.value ? ' selected' : ''}>${o.text}</option>`
            ).join('');
          } else if (cat === 'prefecture') {
            detSel.innerHTML = _prefs.map(p =>
              `<option value="${p}"${frow.type === 'prefecture' && frow.value === p ? ' selected' : ''}>${p}</option>`
            ).join('');
          } else if (cat === 'scan') {
            detSel.innerHTML = scanLabels.map(n =>
              `<option value="${n}"${frow.label === n ? ' selected' : ''}>${n}</option>`
            ).join('');
          } else if (cat === 'label') {
            detSel.innerHTML = userLabels.map(n =>
              `<option value="${n}"${frow.label === n ? ' selected' : ''}>${(labelMap.get(n)||'') + n}</option>`
            ).join('');
          }
        }
        updateDetail();

        function applySelection() {
          const cat = catSel.value;
          const val = detSel.value;
          if (cat === 'overlap') { frow.type = 'overlap'; frow.value = null; frow.label = ''; }
          else if (cat === 'title') { frow.type = 'title'; frow.value = detInput.value.trim(); frow.label = ''; }
          else if (cat === 'annotation') { frow.type = 'annotation'; frow.value = val; frow.label = ''; }
          else if (cat === 'prefecture') { frow.type = 'prefecture'; frow.value = val; frow.label = ''; }
          else { frow.type = null; frow.value = null; frow.label = val; }
          render();        }

        catSel.onchange = () => {
          updateDetail();
          if (catSel.value === 'title') {
            frow.type = 'title'; frow.value = detInput.value.trim(); frow.label = '';
            render();
          } else {
            applySelection();
          }
        };
        detSel.onchange = applySelection;
        const rm = document.createElement('button'); rm.className = 'filter-remove'; rm.textContent = '\u2715';
        rm.onclick = () => {
          set.rows.splice(ri, 1);
          if (set.rows.length === 0 && S.filterConfig.sets.length > 1) { S.filterConfig.sets.splice(si, 1); if (si > 0) S.filterConfig.spatials.splice(si-1, 1); }
          render();        };
        row.appendChild(rm);

        row.appendChild(catSel);
        row.appendChild(detSel);
        row.appendChild(detInput);

        setDiv.appendChild(row);
        if (set.rows.length > 1 && ri < set.rows.length - 1) {
          const conn = document.createElement('div');
          conn.style.cssText = 'font-size:10px;color:#64748b;padding:1px 0;';
          conn.textContent = (set.logic || 'and') === 'or' ? '\u307e\u305f\u306f' : '\u304b\u3064';
          setDiv.appendChild(conn);
        }
      });

      const addR = document.createElement('div'); addR.className = 'filter-row';
      const logic = set.logic || 'and';
      if (set.rows.length === 0) {
        const addBtn = document.createElement('button'); addBtn.className = 'filter-add';
        addBtn.textContent = '+ \u6761\u4ef6';
        addBtn.onclick = () => {
          const defaultLabel = labelNames.length > 0 ? labelNames[0] : '';
          set.rows.push({label: defaultLabel, vote: null});
          render();        };
        addR.appendChild(addBtn);
      } else if (set.rows.length === 1) {
        const addAndBtn = document.createElement('button'); addAndBtn.className = 'filter-add';
        addAndBtn.textContent = '+ \u304b\u3064';
        addAndBtn.onclick = () => {
          const prev = set.rows[set.rows.length - 1];
          set.rows.push({label: prev.label, type: prev.type, value: prev.value, vote: null});
          set.logic = 'and';
          render();        };
        addR.appendChild(addAndBtn);
        const addOrBtn = document.createElement('button'); addOrBtn.className = 'filter-add';
        addOrBtn.textContent = '+ \u307e\u305f\u306f';
        addOrBtn.onclick = () => {
          const prev = set.rows[set.rows.length - 1];
          set.rows.push({label: prev.label, type: prev.type, value: prev.value, vote: null});
          set.logic = 'or';
          render();        };
        addR.appendChild(addOrBtn);
      } else {
        const addBtn = document.createElement('button'); addBtn.className = 'filter-add';
        addBtn.textContent = logic === 'or' ? '+ \u307e\u305f\u306f' : '+ \u304b\u3064';
        addBtn.onclick = () => {
          const prev = set.rows[set.rows.length - 1];
          set.rows.push({label: prev.label, type: prev.type, value: prev.value, vote: null});
          render();        };
        addR.appendChild(addBtn);
      }
      setDiv.appendChild(addR);
      setWrap.appendChild(setDiv);
      container.appendChild(setWrap);
    });

    const btm = document.createElement('div'); btm.className = 'filter-row';
    if (S.filterConfig.sets.length < 2 && S.filterConfig.sets[0].rows.length > 0) {
      const addS = document.createElement('button'); addS.className = 'filter-add';
      addS.textContent = '+ \u7a7a\u9593\u6bd4\u8f03';
      addS.style.cssText = 'color:#c084fc;border-color:#7c3aed;margin-left:auto;';
      addS.onclick = () => { S.filterConfig.sets.push({rows:[{label:'',vote:null}]}); S.filterConfig.spatials.push('intersects'); render(); };
      btm.appendChild(addS);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '\u9069\u7528';
    applyBtn.style.cssText = 'flex:1;padding:6px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;white-space:nowrap;';
    applyBtn.onclick = () => applyFilter();
    btnRow.appendChild(applyBtn);
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '\u30ea\u30bb\u30c3\u30c8';
    resetBtn.style.cssText = 'flex:1;padding:6px;background:#444;color:#ccc;border:1px solid #666;border-radius:4px;cursor:pointer;white-space:nowrap;';
    resetBtn.onclick = () => {
      loadFilters(); render();
    };
    btnRow.appendChild(resetBtn);
    btm.appendChild(btnRow);

    container.appendChild(btm);
  }

  function applyFilter() {
    saveFilters();
    S.annotations = [];
    S._filteredCache = null;
    S._filterCacheKey = '';
    S._filteredTotal = 0;
    S.selectedAnnotationIdx = null;
    markGeoJSONDirty();
    refreshAnnotationList();
    const countEl = document.getElementById('annotation-count');
    if (countEl) countEl.textContent = '\u8aad\u307f\u8fbc\u307f\u4e2d...';
    invalidateFilterCache();
    applyFilterAsync();
  }
  render();
}

// ── Annotation Helpers ──
function bboxToAnnotationPayload(annotation) {
  const [west, south, east, north] = annotation.bbox;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  const z = 16;
  const TILE_PX = 512;
  const n = Math.pow(2, z);
  const tx = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const px = ((lon + 180) / 360 * n - tx) * TILE_PX;
  const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
  const westPx = ((west + 180) / 360 * n - tx) * TILE_PX;
  const eastPx = ((east + 180) / 360 * n - tx) * TILE_PX;
  const widthPx = Math.abs(eastPx - westPx);
  const northRad = north * Math.PI / 180;
  const southRad = south * Math.PI / 180;
  const northPy = ((1 - Math.log(Math.tan(northRad) + 1 / Math.cos(northRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
  const southPy = ((1 - Math.log(Math.tan(southRad) + 1 / Math.cos(southRad)) / Math.PI) / 2 * n - ty) * TILE_PX;
  const heightPx = Math.abs(southPy - northPy);

  return {
    lat, lon,
    bbox_px_cx: px / TILE_PX,
    bbox_px_cy: py / TILE_PX,
    bbox_px_w: widthPx / TILE_PX,
    bbox_px_h: heightPx / TILE_PX,
    tile_x: tx,
    tile_y: ty,
    tile_z: z,
    title: annotation.title || null,
    labels: annotation.labels || [],
    comment: annotation.comment || null,
  };
}

// ── Annotation Handlers ──
async function handleAnnotationCreated(annotation) {
  if (!S.currentProject) {
    alert('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002');
    return;
  }
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`/api/projects/${S.currentProject.id}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(bboxToAnnotationPayload(annotation))
    });
    if (!res.ok) throw new Error();
    const saved = await res.json();
    annotation.id = saved.id;
    S.annotations.push(annotation);
    invalidateFilterCache();
    await applyFilterAsync();
  } catch (e) {
    console.error('Failed to save annotation:', e);
  }
}

async function handleEditAnnotation(index) {
  const a = S.annotations[index];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:400px;max-width:95vw;">
      <h2 style="font-size:16px;margin-bottom:12px;">\u304a\u6c17\u306b\u5165\u308a\u3092\u7de8\u96c6</h2>
      <input type="text" id="edit-title" value="${a.title || ''}" placeholder="\u30bf\u30a4\u30c8\u30eb\uff08\u4efb\u610f\uff09"
        style="width:100%;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:14px;margin-bottom:8px;box-sizing:border-box;">
      <div id="edit-known-labels" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"></div>
      <textarea id="edit-comment" placeholder="\u30b3\u30e1\u30f3\u30c8\uff08\u4efb\u610f\uff09" rows="2"
        style="width:100%;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:13px;resize:vertical;margin-bottom:12px;box-sizing:border-box;">${a.comment || ''}</textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-outline" id="edit-cancel">\u30ad\u30e3\u30f3\u30bb\u30eb</button>
        <button class="btn" id="edit-save">\u4fdd\u5b58</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#edit-cancel').addEventListener('click', () => overlay.remove());
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && mouseDownOnOverlay) overlay.remove(); });

  const editLabels = [...(a.labels || [])];
  const knownDiv = overlay.querySelector('#edit-known-labels');

  function renderEditKnown() {
    knownDiv.innerHTML = '';
    S.projectLabels.filter(kl => !kl.system).forEach(kl => {
      const existing = editLabels.find(el => el.name === kl.name);
      const chip = document.createElement('span');
      chip.style.cssText = `display:inline-block;padding:3px 8px;border-radius:12px;font-size:12px;cursor:pointer;margin:2px;
        background:${existing ? labelBg(kl.name) : '#16213e'};
        color:${existing ? labelColor(kl.name) : '#555'};
        border:1px solid ${existing ? labelBorder(kl.name) : '#2a2a4a'};`;
      chip.textContent = `${existing ? '\u2705 ' : ''}${kl.emoji || '\ud83d\udccd'}${kl.name}`;
      chip.addEventListener('click', () => {
        const idx = editLabels.findIndex(el => el.name === kl.name);
        if (idx >= 0) {
          editLabels.splice(idx, 1);
        } else {
          editLabels.push({ name: kl.name, emoji: kl.emoji || '\ud83d\udccd' });
        }
        renderEditKnown();
      });
      knownDiv.appendChild(chip);
    });
  }

  renderEditKnown();

  overlay.querySelector('#edit-save').addEventListener('click', async () => {
    const title = overlay.querySelector('#edit-title').value.trim();
    const labels = editLabels;
    const comment = overlay.querySelector('#edit-comment').value.trim();

    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/annotations/${a.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ title, labels, comment })
      });
      if (!res.ok) throw new Error();
      a.title = title;
      a.labels = labels;
      a.comment = comment;
      updateLabelFilter();
      const filtered = filterAnnotations(S.annotations);
      if (filtered.some(x => x.id === a.id)) {
        markGeoJSONDirty();
        refreshAnnotationList();
        showDetailPanel(a);
      } else {
        selectNextFilteredOrClear(S.selectedAnnotationIdx !== null ? S.selectedAnnotationIdx : 0);
      }
    } catch (e) {
      console.error('Failed to update annotation:', e);
    }
    overlay.remove();
  });

  overlay.querySelector('#edit-title').focus();
}

async function handleDeleteAnnotation(filteredIndex) {
  if (!confirm('\u3053\u306e\u304a\u6c17\u306b\u5165\u308a\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f')) return;
  const filtered = filterAnnotations(S.annotations);
  const a = filtered[filteredIndex];
  if (!a) return;
  if (a.id) {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/annotations/${a.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok && res.status !== 204 && res.status !== 404) {
        console.error('Delete failed:', res.status);
        return;
      }
    } catch (e) {
      console.error('Failed to delete annotation:', e);
      return;
    }
  }
  const realIdx = S.annotations.findIndex(x => x.id === a.id);
  if (realIdx >= 0) S.annotations.splice(realIdx, 1);
  if (S._filteredCache) {
    const cacheIdx = S._filteredCache.findIndex(x => x.id === a.id);
    if (cacheIdx >= 0) S._filteredCache.splice(cacheIdx, 1);
    S._filteredTotal = Math.max(0, S._filteredTotal - 1);
  }
  selectNextFilteredOrClear(filteredIndex);
  clearResizeHandles();
}
