let map;
let baseLayerIds = [];
let onReadyCallback = null;
let currentMapMode = 'view';
let mapLocked = false;
let _onAnnotationDblClick = null;
let _onAnnotationRightClick = null;
let _onAnnotationClick = null;
let _onMapClickEmpty = null;

export function setCurrentMode(mode) {
  currentMapMode = mode;
}

export function setMapLocked(locked) {
  mapLocked = locked;
}

export function onAnnotationClick(callback) {
  _onAnnotationClick = callback;
}

export function onMapClickEmpty(callback) {
  _onMapClickEmpty = callback;
}

export function onAnnotationDblClick(callback) {
  _onAnnotationDblClick = callback;
}

export function onAnnotationRightClick(callback) {
  _onAnnotationRightClick = callback;
}

export function initMap(onReady) {
  onReadyCallback = onReady || null;
  map = new maplibregl.Map({
    container: 'map',
    preserveDrawingBuffer: true,
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [135.8, 34.55],
    zoom: 13,
    pitch: 60,
    bearing: -30
  });

  map.addControl(new maplibregl.NavigationControl());

  map.on('load', () => {
    map.setProjection({ type: 'globe' });
  });

  map.on('style.load', () => {
    // ベースマップのラテン文字ラベルを除去し日本語名のみ表示
    for (const layer of map.getStyle().layers) {
      if (layer.layout?.['text-field']) {
        map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:nonlatin'], ['get', 'name']]);
      }
    }

    // 白背景をベースマップの一番下に挿入
    const firstLayer = map.getStyle().layers[0]?.id;
    map.addLayer({
      id: 'white-bg', type: 'background',
      paint: { 'background-color': '#ffffff' }
    }, firstLayer);

    // ベースマップのレイヤーIDを記録（white-bgは除く）
    baseLayerIds = map.getStyle().layers.map(l => l.id).filter(id => id !== 'white-bg');

    // ラスターソース追加
    map.addSource('gsi-photo', {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '地理院タイル'
    });
    map.addSource('cs-map', {
      type: 'raster',
      tiles: ['/tiles/cs/{z}/{x}/{y}.webp'],
      tileSize: 512,
      maxzoom: 16,
      attribution: '赤色立体地図: <a href="https://geoscope.jp">GeoScope</a> | DEM: <a href="https://fgd.gsi.go.jp/">国土地理院</a>'
    });
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['/tiles/terrain/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 17,
      encoding: 'terrarium'
    });

    // ラスターレイヤー追加（保存済みprefsで初期visibility決定）
    const _prefs = JSON.parse(localStorage.getItem('geoscope_layer_prefs') || '{}');
    map.addLayer({
      id: 'photo', type: 'raster', source: 'gsi-photo',
      layout: { visibility: _prefs.photo_vis === false ? 'none' : 'visible' },
      paint: { 'raster-opacity': _prefs.photo_op ?? 1.0 }
    });
    map.addLayer({
      id: 'cs', type: 'raster', source: 'cs-map',
      layout: { visibility: _prefs.cs_vis ? 'visible' : 'none' },
      paint: { 'raster-opacity': _prefs.cs_op ?? 0.7 }
    });

    // 3Dテレイン
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1 });

    // 検出結果ソース
    map.addSource('detections', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'detections-circle', type: 'circle', source: 'detections',
      paint: {
        'circle-radius': 6,
        'circle-color': ['case',
          ['==', ['get', 'feedback'], 'yes'], '#2ea043',
          ['==', ['get', 'feedback'], 'no'], '#da3633',
          ['>', ['get', 'conf'], 0.4], '#e94560',
          ['>', ['get', 'conf'], 0.3], '#ff7f00',
          '#1f78b4'
        ],
        'circle-stroke-color': '#000',
        'circle-stroke-width': 1,
        'circle-opacity': 0.8
      }
    });

    // アノテーションソース
    map.addSource('annotations', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addSource('annotations-points', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'annotations-fill', type: 'fill', source: 'annotations',
      minzoom: 14,
      paint: {
        'fill-color': ['case', ['get', 'selected'], '#f59e0b', ['get', 'color']],
        'fill-opacity': ['case', ['get', 'selected'], 0.25, 0.15]
      }
    });
    map.addLayer({
      id: 'annotations-outline', type: 'line', source: 'annotations',
      minzoom: 14,
      paint: {
        'line-color': ['case', ['get', 'selected'], '#f59e0b', ['get', 'color']],
        'line-width': ['case', ['get', 'selected'], 3, 2]
      }
    });
    map.addLayer({
      id: 'annotations-circle', type: 'circle', source: 'annotations-points',
      maxzoom: 14,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 10, 8, 14, 12],
        'circle-color': ['case', ['get', 'selected'], '#f59e0b', ['get', 'color']],
        'circle-stroke-color': '#000',
        'circle-stroke-width': 1,
        'circle-opacity': 0.8
      }
    });

    // アノテーションのクリックで選択（fill + circle両方）
    map.on('click', 'annotations-fill', (e) => {
      const idx = e.features[0]?.properties?.index;
      if (idx !== undefined && _onAnnotationClick) {
        _onAnnotationClick(idx);
      }
    });
    // 低ズーム●クリック: 選択 + その場所にジャンプ
    map.on('click', 'annotations-circle', (e) => {
      const f = e.features[0];
      const idx = f?.properties?.index;
      if (idx !== undefined && _onAnnotationClick) {
        _onAnnotationClick(idx);
      }
      const coords = f.geometry.coordinates;
      map.flyTo({ center: coords, zoom: 16, duration: 1000 });
    });

    // アノテーションのダブルクリックで編集
    map.on('dblclick', 'annotations-fill', (e) => {
      if (mapLocked) return;
      e.preventDefault();
      const idx = e.features[0]?.properties?.index;
      if (idx !== undefined && _onAnnotationDblClick) {
        _onAnnotationDblClick(idx);
      }
    });

    // レイヤー設定復元コールバック
    if (onReadyCallback) onReadyCallback();

    // 検出結果クリック
    map.on('click', 'detections-circle', (e) => {
      const f = e.features[0];
      const coords = f.geometry.coordinates;
      const p = f.properties;
      new maplibregl.Popup({ offset: 8 })
        .setLngLat(coords)
        .setHTML(`
          <div style="font-size:13px;">
            <strong>conf: ${Number(p.conf).toFixed(3)}</strong><br>
            ${p.feedback ? `判定: <strong>${p.feedback}</strong><br>` : ''}
            <a href="https://qchizu.jp/maps/#18/${coords[1]}/${coords[0]}/&base=ort&ls=ort%7C03_dem_52_gsi_all_2026_1_01_dem2rrim&blend=0&disp=11&vs=c1g1j0h0k0l0u0t0z0r0s0m0f1" target="_blank" style="color:#e94560;">Q地図で開く</a>
          </div>
        `)
        .addTo(map);
    });

    map.on('mouseenter', 'detections-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'detections-circle', () => { map.getCanvas().style.cursor = ''; });

    // 空白クリックで選択解除
    map.on('click', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['annotations-fill', 'annotations-circle', 'detections-circle'] });
      if (features.length === 0 && _onMapClickEmpty) {
        _onMapClickEmpty();
      }
    });

    // PC: 右クリック
    map.on('contextmenu', (e) => {
      e.preventDefault();
      // アノテーション上で右クリック→削除（ロック時無効）
      if (!mapLocked) {
        const features = map.queryRenderedFeatures(e.point, { layers: ['annotations-fill', 'annotations-circle'] });
        if (features.length > 0 && _onAnnotationRightClick) {
          _onAnnotationRightClick(features[0].properties.index, e.lngLat);
          return;
        }
      }
      showSharePopup(e.lngLat);
    });

    // スマホ: 長押しで共有ポップアップ
    let holdTimer = null;
    let holdLngLat = null;
    let holdMoved = false;

    const mapEl = map.getContainer();
    mapEl.addEventListener('touchstart', (e) => {
      if (currentMapMode !== 'view' || e.touches.length !== 1) return;
      holdMoved = false;
      const rect = mapEl.getBoundingClientRect();
      const point = [e.touches[0].clientX - rect.left, e.touches[0].clientY - rect.top];
      holdLngLat = map.unproject(point);

      holdTimer = setTimeout(() => {
        if (!holdMoved) {
          e.preventDefault();
          map.dragPan.disable();
          if (navigator.vibrate) navigator.vibrate(30);
          showSharePopup(holdLngLat);
          setTimeout(() => map.dragPan.enable(), 500);
        }
        holdTimer = null;
      }, 500);
    }, { passive: false });

    mapEl.addEventListener('touchmove', (e) => {
      if (holdTimer) {
        const rect = mapEl.getBoundingClientRect();
        const dx = e.touches[0].clientX - rect.left;
        const dy = e.touches[0].clientY - rect.top;
        const startPt = map.project(holdLngLat);
        if (Math.abs(dx - startPt.x) > 8 || Math.abs(dy - startPt.y) > 8) {
          holdMoved = true;
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      }
    }, { passive: true });

    mapEl.addEventListener('touchend', () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    });
    mapEl.addEventListener('touchcancel', () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    });
  });

  return map;
}

export function getMap() {
  return map;
}

// レイヤー表示切替
export function setLayerVisibility(layerId, visible) {
  if (layerId === 'base') {
    // ベクタータイルベースマップの全レイヤー
    baseLayerIds.forEach(id => {
      try { map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); } catch(e) {}
    });
    return;
  }
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

// レイヤー不透明度
export function setLayerOpacity(layerId, opacity) {
  if (layerId === 'base') {
    // ベクタータイルの各レイヤータイプに応じた不透明度設定
    baseLayerIds.forEach(id => {
      const layer = map.getLayer(id);
      if (!layer) return;
      try {
        switch (layer.type) {
          case 'fill': map.setPaintProperty(id, 'fill-opacity', opacity); break;
          case 'line': map.setPaintProperty(id, 'line-opacity', opacity); break;
          case 'symbol':
            map.setPaintProperty(id, 'text-opacity', opacity);
            map.setPaintProperty(id, 'icon-opacity', opacity);
            break;
          case 'background': map.setPaintProperty(id, 'background-opacity', opacity); break;
          case 'fill-extrusion': map.setPaintProperty(id, 'fill-extrusion-opacity', opacity); break;
        }
      } catch(e) {}
    });
    return;
  }
  map.setPaintProperty(layerId, 'raster-opacity', opacity);
}

// 3Dテレイン誇張
export function setTerrainExaggeration(value) {
  if (value === 0) {
    map.setTerrain(null);
  } else {
    map.setTerrain({ source: 'terrain-dem', exaggeration: value });
  }
}

// テレイン対応fitBounds
export function fitBoundsCompat(bounds, options = {}) {
  if (!map) return;
  // テレイン有効時はpitch=0にしてからfitBounds（地面標高による位置ズレ回避）
  if (map.getTerrain()) {
    map.fitBounds(bounds, { ...options, pitch: 0 });
  } else {
    map.fitBounds(bounds, options);
  }
}

// 検出結果GeoJSON更新
export function updateDetections(geojson) {
  const src = map.getSource('detections');
  if (src) src.setData(geojson);
}

// アノテーションGeoJSON更新
let _lastAnnotationsData = null;
export function updateAnnotations(geojson) {
  _lastAnnotationsData = geojson;
  const src = map.getSource('annotations');
  if (src) src.setData(geojson);
  // ポイント版（低ズーム用）: bboxの中心点
  const ptSrc = map.getSource('annotations-points');
  if (ptSrc) {
    ptSrc.setData({
      type: 'FeatureCollection',
      features: geojson.features.map(f => {
        const coords = f.geometry.coordinates[0];
        const lons = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        return {
          type: 'Feature',
          properties: f.properties,
          geometry: { type: 'Point', coordinates: [(Math.min(...lons)+Math.max(...lons))/2, (Math.min(...lats)+Math.max(...lats))/2] }
        };
      })
    });
  }
}

// ── リサイズハンドル (Drawモード) ──
let _resizeHandles = [];
let _resizeState = null;
let _onAnnotationResized = null;

export function onAnnotationResized(callback) {
  _onAnnotationResized = callback;
}

export function showResizeHandles(annotations) {
  clearResizeHandles();
  if (mapLocked || !annotations || !annotations.length) return;

  annotations.forEach((a, i) => {
    if (!a.bbox || a.bbox.length < 4) return;
    const [w, s, e, n] = a.bbox;

    // posごとにマーカーを辞書管理
    const markers = {};
    const cornerDefs = [
      { pos: 'nw', lngLat: [w, n], cursor: 'nwse-resize' },
      { pos: 'ne', lngLat: [e, n], cursor: 'nesw-resize' },
      { pos: 'sw', lngLat: [w, s], cursor: 'nesw-resize' },
      { pos: 'se', lngLat: [e, s], cursor: 'nwse-resize' },
    ];

    function computeBbox(draggedPos, ll) {
      const bbox = [...a.bbox];
      if (draggedPos.includes('w')) bbox[0] = ll.lng;
      if (draggedPos.includes('e')) bbox[2] = ll.lng;
      if (draggedPos.includes('s')) bbox[1] = ll.lat;
      if (draggedPos.includes('n')) bbox[3] = ll.lat;
      return bbox;
    }

    function updateSiblings(draggedPos, bbox) {
      const [bw, bs, be, bn] = bbox;
      // 隣接ハンドルを追従（対角線は固定）
      if (markers.nw && draggedPos !== 'nw') markers.nw.setLngLat([bw, bn]);
      if (markers.ne && draggedPos !== 'ne') markers.ne.setLngLat([be, bn]);
      if (markers.sw && draggedPos !== 'sw') markers.sw.setLngLat([bw, bs]);
      if (markers.se && draggedPos !== 'se') markers.se.setLngLat([be, bs]);
    }

    function updatePreview(bbox) {
      const [bw, bs, be, bn] = bbox;
      const src = map.getSource('annotations');
      if (src && _lastAnnotationsData?.features) {
        const feat = _lastAnnotationsData.features.find(f => f.properties?.id === a.id);
        if (feat) {
          feat.geometry = {
            type: 'Polygon',
            coordinates: [[[bw,bs],[be,bs],[be,bn],[bw,bn],[bw,bs]]]
          };
          src.setData(_lastAnnotationsData);
        }
      }
    }

    cornerDefs.forEach(c => {
      const el = document.createElement('div');
      el.style.cssText = `width:10px;height:10px;background:#f59e0b;border:2px solid #fff;border-radius:2px;cursor:${c.cursor};`;

      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat(c.lngLat)
        .addTo(map);
      markers[c.pos] = marker;

      marker.on('dragstart', () => {
        _resizeState = { id: a.id, corner: c.pos, bbox: [...a.bbox] };
        map.dragPan.disable();
      });

      marker.on('drag', () => {
        if (!_resizeState) return;
        const bbox = computeBbox(c.pos, marker.getLngLat());
        updateSiblings(c.pos, bbox);
        updatePreview(bbox);
      });

      marker.on('dragend', () => {
        map.dragPan.enable();
        if (!_resizeState) return;
        const bbox = computeBbox(c.pos, marker.getLngLat());
        const sorted = [Math.min(bbox[0],bbox[2]), Math.min(bbox[1],bbox[3]),
                        Math.max(bbox[0],bbox[2]), Math.max(bbox[1],bbox[3])];
        if (_onAnnotationResized) _onAnnotationResized(_resizeState.id, sorted);
        _resizeState = null;
      });

      _resizeHandles.push(marker);
    });
  });
}

export function clearResizeHandles() {
  _resizeHandles.forEach(m => m.remove());
  _resizeHandles = [];
}

// 座標にフライ
export function flyTo(lng, lat, zoom = 16) {
  map.flyTo({ center: [lng, lat], zoom, pitch: 60 });
}

// 共有ポップアップ
function showSharePopup(lngLat) {
  const z = Math.round(map.getZoom() * 100) / 100;
  const b = Math.round(map.getBearing() * 10) / 10;
  const p = Math.round(map.getPitch() * 10) / 10;
  const lat = lngLat.lat.toFixed(5);
  const lon = lngLat.lng.toFixed(5);
  const url = `${location.origin}/@${z}/${lat}/${lon}/${b}/${p}`;

  const html = `
    <div style="font-size:13px;min-width:200px;">
      <div style="margin-bottom:6px;color:#666;">${lat}, ${lon}</div>
      <button id="popup-copy" style="width:100%;padding:6px 12px;background:#e94560;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-bottom:4px;">URLをコピー</button>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank"
          style="flex:1;text-align:center;padding:4px;background:#eee;border-radius:4px;color:#333;text-decoration:none;font-size:11px;">Google</a>
        <a href="https://qchizu.jp/maps/#18/${lat}/${lon}/&base=ort&ls=ort%7C03_dem_52_gsi_all_2026_1_01_dem2rrim&blend=0&disp=11&vs=c1g1j0h0k0l0u0t0z0r0s0m0f1" target="_blank"
          style="flex:1;text-align:center;padding:4px;background:#eee;border-radius:4px;color:#333;text-decoration:none;font-size:11px;">Q地図</a>
        <a href="https://heritagemap.nabunken.go.jp/?lat=${lat}&lng=${lon}&zoom=17&bearing=0&pitch=0&bm=pale&bl=heritage_db_point_idx%3A1%2Cheritage_abstract_idx%3A1%2Cheritage_db_shape_idx%3A1&cl=hakkututyousaku_idx%3A0.5%3A1%2Cjyobofukugen_idx%3A0.5%3A1%2Cslope%3A0.5%3A1%2Crelief%3A0.25%3A1" target="_blank"
          style="flex:1;text-align:center;padding:4px;background:#eee;border-radius:4px;color:#333;text-decoration:none;font-size:11px;">文化財</a>
      </div>
    </div>`;

  const popup = new maplibregl.Popup({ offset: 10, maxWidth: '260px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  // コピーボタンのイベントはDOMに追加後に設定
  setTimeout(() => {
    const btn = document.getElementById('popup-copy');
    if (btn) {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(url).then(() => {
          btn.textContent = 'コピーしました';
          btn.style.background = '#2ea043';
          setTimeout(() => popup.remove(), 1000);
        }).catch(() => {
          prompt('URLをコピー:', url);
        });
      });
    }
  }, 0);
}

// URL ↔ 地図位置の同期
function updateUrl() {
  const c = map.getCenter();
  const z = Math.round(map.getZoom() * 100) / 100;
  const b = Math.round(map.getBearing() * 10) / 10;
  const p = Math.round(map.getPitch() * 10) / 10;
  const path = `/@${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}/${b}/${p}`;
  history.replaceState(null, '', path);
}

export function applyUrlPosition() {
  const m = location.pathname.match(/^\/@([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?/);
  if (m) {
    const [, z, lat, lon, bearing, pitch] = m;
    map.jumpTo({
      center: [parseFloat(lon), parseFloat(lat)],
      zoom: parseFloat(z),
      bearing: bearing ? parseFloat(bearing) : 0,
      pitch: pitch ? parseFloat(pitch) : 60,
    });
  }
  // 旧ハッシュ形式もサポート
  const h = location.hash.match(/^#([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?/);
  if (h) {
    const [, z, lat, lon, bearing, pitch] = h;
    map.jumpTo({
      center: [parseFloat(lon), parseFloat(lat)],
      zoom: parseFloat(z),
      bearing: bearing ? parseFloat(bearing) : 0,
      pitch: pitch ? parseFloat(pitch) : 60,
    });
    // ハッシュを/@形式に書き換え
    history.replaceState(null, '', location.pathname === '/' ?
      `/@${z}/${lat}/${lon}/${bearing || 0}/${pitch || 60}` :
      location.pathname);
  }
}

export function startUrlSync() {
  map.on('moveend', updateUrl);
  // 初回URL更新（/@パスでなければ）
  if (!location.pathname.startsWith('/@')) {
    updateUrl();
  }
}
