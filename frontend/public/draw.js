import { getMap, updateAnnotations, fitBoundsCompat } from '/map.js?v=398';

let drawing = false;
let startPoint = null;
let rectElement = null;
let enabled = false;
let onAnnotationCreated = null;
let longPressTimer = null;
let touchStartPos = null;

let crosshairEl = null;

function attachListeners() {
  const map = getMap();
  if (!map) return;
  const canvas = map.getCanvas();
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchCancel);
}

function detachListeners() {
  const map = getMap();
  if (!map) return;
  const canvas = map.getCanvas();
  canvas.removeEventListener('mousedown', onMouseDown);
  canvas.removeEventListener('mousemove', onMouseMove);
  canvas.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
  canvas.removeEventListener('touchstart', onTouchStart);
  canvas.removeEventListener('touchmove', onTouchMove);
  canvas.removeEventListener('touchend', onTouchEnd);
  canvas.removeEventListener('touchcancel', onTouchCancel);
}

let isSelectedFn = null;

export function enableDraw(callback, isSelectedCallback) {
  enabled = true;
  onAnnotationCreated = callback;
  isSelectedFn = isSelectedCallback || null;
  attachListeners();
}

export function disableDraw() {
  enabled = false;
  onAnnotationCreated = null;
  cancelLongPress();
  removeCrosshair();
  detachListeners();
  removeRect();
}

// ── クロスヘアガイド ──
function onKeyDown(e) {
  if (!enabled || e.key !== 'Shift' || e.ctrlKey || crosshairEl) return;
  if (isSelectedFn && isSelectedFn()) return;
  const map = getMap();
  if (!map) return;
  const container = map.getContainer();
  crosshairEl = document.createElement('div');
  crosshairEl.className = 'draw-crosshair';
  crosshairEl.innerHTML = `
    <div class="ch-h"></div>
    <div class="ch-v"></div>
  `;
  container.appendChild(crosshairEl);
  container.addEventListener('mousemove', moveCrosshair);
  map.getCanvas().style.cursor = 'crosshair';
}

function onKeyUp(e) {
  if (e.key !== 'Shift' && e.key !== 'Meta') return;
  if (!drawing) {
    removeCrosshair();
    const map = getMap();
    if (map) map.getCanvas().style.cursor = '';
  }
}

function moveCrosshair(e) {
  if (!crosshairEl) return;
  const rect = getMap().getContainer().getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const h = crosshairEl.querySelector('.ch-h');
  const v = crosshairEl.querySelector('.ch-v');
  h.style.top = y + 'px';
  v.style.left = x + 'px';
}

function removeCrosshair() {
  if (crosshairEl) {
    const map = getMap();
    if (map) {
      map.getContainer().removeEventListener('mousemove', moveCrosshair);
      map.getCanvas().style.cursor = '';
    }
    crosshairEl.remove();
    crosshairEl = null;
  }
}

// ── マウス (PC: Shift+ドラッグ) ──
function onMouseDown(e) {
  if (!enabled || !e.shiftKey || e.ctrlKey) return;
  if (isSelectedFn && isSelectedFn()) return;
  drawing = true;
  startPoint = { x: e.offsetX, y: e.offsetY };
  getMap().dragPan.disable();
  createRect();
}

// ── タッチ (スマホ: 長押し→ドラッグ) ──
function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  touchStartPos = null;
}

function onTouchStart(e) {
  if (!enabled || e.touches.length !== 1) return;
  const touch = e.touches[0];
  const rect = getMap().getCanvas().getBoundingClientRect();
  touchStartPos = { x: touch.clientX - rect.left, y: touch.clientY - rect.top };

  longPressTimer = setTimeout(() => {
    // 長押し成立 → 描画モード開始
    drawing = true;
    startPoint = { ...touchStartPos };
    getMap().dragPan.disable();
    getMap().dragRotate.disable();
    createRect();
    // 振動フィードバック（対応端末のみ）
    if (navigator.vibrate) navigator.vibrate(30);
  }, 500);
}

function onTouchMove(e) {
  if (!enabled) return;
  const touch = e.touches[0];
  const rect = getMap().getCanvas().getBoundingClientRect();
  const x = touch.clientX - rect.left;
  const y = touch.clientY - rect.top;

  // 長押し待機中に動いたらキャンセル
  if (longPressTimer && touchStartPos) {
    const dx = x - touchStartPos.x;
    const dy = y - touchStartPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      cancelLongPress();
      return;
    }
  }

  if (!drawing) return;
  e.preventDefault(); // スクロール防止
  updateRect(startPoint.x, startPoint.y, x, y);
}

function onTouchEnd(e) {
  cancelLongPress();
  if (!drawing) return;

  const touch = e.changedTouches[0];
  const rect = getMap().getCanvas().getBoundingClientRect();
  const endPoint = { x: touch.clientX - rect.left, y: touch.clientY - rect.top };

  finishDraw(endPoint);
}

function onTouchCancel() {
  cancelLongPress();
  if (drawing) {
    drawing = false;
    getMap().dragPan.enable();
    getMap().dragRotate.enable();
    removeRect();
  }
}

function onMouseMove(e) {
  if (!drawing) return;
  updateRect(startPoint.x, startPoint.y, e.offsetX, e.offsetY);
}

function onMouseUp(e) {
  if (!drawing) return;
  finishDraw({ x: e.offsetX, y: e.offsetY });
}

function updateRect(sx, sy, ex, ey) {
  if (!rectElement) return;
  rectElement.style.left = Math.min(sx, ex) + 'px';
  rectElement.style.top = Math.min(sy, ey) + 'px';
  rectElement.style.width = Math.abs(ex - sx) + 'px';
  rectElement.style.height = Math.abs(ey - sy) + 'px';
}

function finishDraw(endPoint) {
  drawing = false;
  removeCrosshair();
  const map = getMap();
  map.dragPan.enable();
  map.dragRotate.enable();

  if (Math.abs(endPoint.x - startPoint.x) < 20 || Math.abs(endPoint.y - startPoint.y) < 20) {
    removeRect();
    return;
  }

  const screenshot = captureScreenshot(startPoint, endPoint);

  const sw = map.unproject([
    Math.min(startPoint.x, endPoint.x),
    Math.max(startPoint.y, endPoint.y)
  ]);
  const ne = map.unproject([
    Math.max(startPoint.x, endPoint.x),
    Math.min(startPoint.y, endPoint.y)
  ]);

  removeRect();

  const bbox = [sw.lng, sw.lat, ne.lng, ne.lat];
  const tiles = bboxToTiles(bbox, 16);
  showLabelDialog(bbox, tiles, screenshot);
}

// ── スクリーンショット取得 ──
function captureScreenshot(startPx, endPx) {
  const map = getMap();
  const canvas = map.getCanvas();
  const x = Math.min(startPx.x, endPx.x);
  const y = Math.min(startPx.y, endPx.y);
  const w = Math.abs(endPx.x - startPx.x);
  const h = Math.abs(endPx.y - startPx.y);
  if (w < 10 || h < 10) return null;

  const ratio = window.devicePixelRatio || 1;
  const maxDim = 300;
  const scale = Math.min(maxDim / w, maxDim / h, 1);
  const tmp = document.createElement('canvas');
  tmp.width = Math.round(w * scale);
  tmp.height = Math.round(h * scale);
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, x * ratio, y * ratio, w * ratio, h * ratio, 0, 0, tmp.width, tmp.height);
  return tmp.toDataURL('image/png');
}

// ── ラベル入力ダイアログ ──
function showLabelDialog(bbox, tiles, screenshotUrl) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:400px;max-width:95vw;">
      <h2 style="font-size:16px;margin-bottom:12px;">お気に入り</h2>
      ${screenshotUrl ? `<img src="${screenshotUrl}" style="width:100%;border-radius:4px;margin-bottom:12px;border:1px solid #2a2a4a;">` : ''}
      <input type="text" id="annotation-title" placeholder="タイトル（任意）"
        style="width:100%;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:14px;margin-bottom:8px;box-sizing:border-box;">
      <div style="font-size:12px;color:#888;margin-bottom:8px;">
        既知ラベルをクリックで追加、または新規入力（名前 絵文字）
      </div>
      <div id="known-labels" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"></div>
      <div id="label-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;min-height:24px;"></div>
      <div style="display:flex;gap:4px;margin-bottom:4px;">
        <input type="text" id="label-input" placeholder="新しいラベル名"
          style="flex:1;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:14px;box-sizing:border-box;">
        <input type="text" id="label-emoji-input" placeholder="\u{1F4CD}" maxlength="2"
          style="width:50px;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:14px;text-align:center;box-sizing:border-box;">
        <button class="btn btn-sm" id="label-add-btn" style="font-size:12px;">追加</button>
      </div>
      <div id="label-suggestions" style="display:none;margin-bottom:8px;"></div>
      <textarea id="annotation-comment" placeholder="コメント（任意）" rows="2"
        style="width:100%;padding:8px;background:#16213e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:13px;resize:vertical;margin-bottom:12px;box-sizing:border-box;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-outline" id="label-cancel">キャンセル</button>
        <button class="btn" id="label-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const labels = []; // [{name, emoji, vote}, ...]
  const input = overlay.querySelector('#label-input');
  const emojiInput = overlay.querySelector('#label-emoji-input');
  const chips = overlay.querySelector('#label-chips');
  const knownDiv = overlay.querySelector('#known-labels');

  function addLabel(name, emoji, vote) {
    if (!name) return;
    const existing = labels.findIndex(l => l.name === name);
    if (existing >= 0) {
      labels[existing] = { name, emoji: emoji || labels[existing].emoji, vote };
    } else {
      labels.push({ name, emoji: emoji || '\u{1F4CD}', vote });
    }
    renderChips();
  }

  // 既知ラベルを取得して表示（window._projectLabelsはapp.jsから公開）
  let knownLabels = (window._projectLabels || []).filter(l => !l.system);
  renderKnownLabels();

  function renderKnownLabels() {
    knownDiv.innerHTML = '';
    knownLabels.forEach(kl => {
      const existing = labels.find(l => l.name === kl.name);
      const chip = document.createElement('span');
      chip.style.cssText = `display:inline-block;padding:3px 8px;border-radius:12px;font-size:12px;cursor:pointer;margin:2px;
        background:${existing ? '#204060' : '#16213e'};color:${existing ? '#6bcfff' : '#888'};
        border:1px solid ${existing ? '#6bcfff' : '#2a2a4a'};`;
      chip.textContent = `${existing ? '✓ ' : ''}${kl.emoji || '📍'}${kl.name}`;
      chip.addEventListener('click', () => {
        if (existing) {
          labels.splice(labels.indexOf(existing), 1);
        } else {
          addLabel(kl.name, kl.emoji);
        }
        renderChips();
        renderKnownLabels();
      });
      knownDiv.appendChild(chip);
    });
  }

  function renderChips() {
    chips.innerHTML = '';
    labels.forEach((l, i) => {
      const bgColor = '#1c2d3a';
      const textColor = '#6bcfff';
      const borderColor = '#204060';
      const chip = document.createElement('span');
      chip.style.cssText = `
        display:inline-flex;align-items:center;gap:2px;padding:2px 8px;border-radius:12px;font-size:12px;cursor:default;
        background:${bgColor};color:${textColor};border:1px solid ${borderColor};
      `;
      chip.innerHTML = `${l.emoji || '\u{1F4CD}'}${l.name} <span style="cursor:pointer;margin-left:2px;" data-i="${i}">&times;</span>`;
      chip.querySelector('span[data-i]').addEventListener('click', () => {
        labels.splice(i, 1);
        renderChips();
        renderKnownLabels();
      });
      chips.appendChild(chip);
    });
  }

  // ⭕/❌ ボタンで新規ラベル追加
  function addFromInput() {
    const name = input.value.trim();
    if (!name) return;
    const emoji = emojiInput.value.trim() || '\u{1F4CD}';
    addLabel(name, emoji);
    input.value = '';
    emojiInput.value = '';
    renderKnownLabels();
  }

  overlay.querySelector('#label-add-btn').addEventListener('click', () => addFromInput());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  });

  // オートコンプリート
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    const sugDiv = overlay.querySelector('#label-suggestions');
    if (knownLabels.length > 0 && q.length > 0) {
      const matches = knownLabels.filter(kl => kl.name.toLowerCase().includes(q) && !labels.some(l => l.name === kl.name));
      if (matches.length > 0) {
        sugDiv.style.display = '';
        sugDiv.innerHTML = matches.slice(0, 5).map(m =>
          `<span class="suggest-chip" data-name="${m.name}" data-emoji="${m.emoji}" style="cursor:pointer;display:inline-block;padding:2px 8px;margin:2px;border-radius:12px;font-size:12px;background:#16213e;border:1px solid #2a2a4a;color:#ccc;">${m.emoji}${m.name}</span>`
        ).join('');
        sugDiv.querySelectorAll('.suggest-chip').forEach(c => {
          c.addEventListener('click', () => {
            addLabel(c.dataset.name, c.dataset.emoji, 'yes');
            input.value = '';
            sugDiv.style.display = 'none';
            renderKnownLabels();
          });
        });
        return;
      }
    }
    sugDiv.style.display = 'none';
  });

  // 保存
  overlay.querySelector('#label-save').addEventListener('click', () => {
    // 入力中のラベルがあれば追加
    if (input.value.trim()) addFromInput('yes');
    const title = overlay.querySelector('#annotation-title').value.trim() || null;
    const comment = overlay.querySelector('#annotation-comment').value.trim() || null;
    const annotation = { bbox, tiles, title, labels, comment, geometry: bboxToPolygon(bbox) };
    overlay.remove();
    if (onAnnotationCreated) onAnnotationCreated(annotation);
  });

  overlay.querySelector('#label-cancel').addEventListener('click', () => overlay.remove());
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && mouseDownOnOverlay) overlay.remove(); });
  overlay.querySelector('#annotation-title').focus();
}

function createRect() {
  removeRect();
  rectElement = document.createElement('div');
  rectElement.style.cssText = `
    position: absolute; border: 2px dashed #3b82f6; background: rgba(59,130,246,0.12);
    pointer-events: none; z-index: 100;
  `;
  getMap().getContainer().appendChild(rectElement);
}

function removeRect() {
  if (rectElement) {
    rectElement.remove();
    rectElement = null;
  }
}

function bboxToTiles(bbox, z) {
  const [west, south, east, north] = bbox;
  const minTx = lngToTileX(west, z);
  const maxTx = lngToTileX(east, z);
  const minTy = latToTileY(north, z);
  const maxTy = latToTileY(south, z);
  const tiles = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      tiles.push({ z, x: tx, y: ty });
    }
  }
  return tiles;
}

function lngToTileX(lng, z) {
  return Math.floor((lng + 180) / 360 * (1 << z));
}

function latToTileY(lat, z) {
  const r = Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r)) / Math.PI) / 2 * (1 << z));
}

function bboxToPolygon(bbox) {
  const [w, s, e, n] = bbox;
  return {
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
  };
}

function _labelHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function _labelColor(label) {
  if (label.color) return label.color;
  if (label.system) return null;
  return `hsl(${_labelHue(label.name)}, 70%, 55%)`;
}

function _brightest(colors) {
  let best = colors[0], bestL = 0;
  for (const c of colors) {
    // HSL文字列から輝度を直接計算（canvas/getImageData不要）
    const m = c.match(/hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%/);
    if (m) {
      const l = parseFloat(m[3]);
      if (l > bestL) { bestL = l; best = c; }
    } else {
      // hex or other format - 固定輝度50として扱う
      if (50 > bestL) { bestL = 50; best = c; }
    }
  }
  return best;
}

export function renderAnnotationList(annotations, container, onDelete, onEdit, onSelect, selectedIdx) {
  const frag = document.createDocumentFragment();
  const MAX_LIST = 1000;
  const display = annotations.length > MAX_LIST && (selectedIdx === null || selectedIdx < MAX_LIST)
    ? annotations.slice(0, MAX_LIST) : annotations.length > MAX_LIST
    ? annotations.slice(0, MAX_LIST) : annotations;
  display.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'annotation-item' + (i === selectedIdx ? ' selected' : '');
    div.style.cursor = 'pointer';
    div.style.fontSize = '12px';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '4px';
    // サムネイル（CDNタイルのCSSクロップ）
    const textSpan = document.createElement('span');
    textSpan.textContent = a.title || `#${i + 1}`;
    textSpan.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;';
    div.appendChild(textSpan);
    // ラベル色で左ボーダー（複数ラベルはストライプ）
    const labels = (a.labels || []).filter(l => l.name);
    const colors = labels.map(l => _labelColor(l)).filter(Boolean);
    if (colors.length === 1) {
      div.style.borderLeft = `3px solid ${colors[0]}`;
    } else if (colors.length > 1) {
      const step = 100 / colors.length;
      const stops = colors.map((c, ci) => `${c} ${ci * step}%, ${c} ${(ci + 1) * step}%`).join(', ');
      div.style.borderLeft = '3px solid transparent';
      div.style.borderImage = `linear-gradient(to bottom, ${stops}) 1`;
    }
    div.dataset.idx = i;
    frag.appendChild(div);
  });
  container.innerHTML = '';
  container.appendChild(frag);

  // イベントは親要素で委譲（各アイテムにリスナーを付けない）
  container.onclick = (e) => {
    const div = e.target.closest('.annotation-item');
    if (!div) return;
    const i = parseInt(div.dataset.idx);
    const a = annotations[i];
    if (!a || !a.bbox) return;
    const [w, s, ee, n] = a.bbox;
    const map = getMap();
    fitBoundsCompat([[w, s], [ee, n]], { padding: 80, maxZoom: 18, animate: false });
    if (onSelect) onSelect(i);
  };
  container.ondblclick = (e) => {
    if (!onEdit) return;
    const div = e.target.closest('.annotation-item');
    if (!div) return;
    onEdit(parseInt(div.dataset.idx));
  };
}

export function annotationsToGeoJSON(annotations, selectedIdx) {
  return {
    type: 'FeatureCollection',
    features: annotations.map((a, i) => {
      const labels = (a.labels || []).filter(l => l.name);
      // ユーザーラベルから輝度が最も高い色を選択、なければ薄いグレー
      const userColors = labels.filter(l => !l.system).map(l => _labelColor(l)).filter(Boolean);
      const color = userColors.length > 0 ? _brightest(userColors) : '#888888';
      return {
        type: 'Feature',
        properties: { index: i, id: a.id, labels: a.labels || [], selected: i === selectedIdx, hue: 0, color },
        geometry: a.geometry
      };
    })
  };
}
