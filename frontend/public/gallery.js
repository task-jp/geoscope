import { getMap, flyTo, updateDetections } from '/map.js?v=398';

let detections = [];
let currentFilter = 'all';
let currentProjectId = null;
let onFeedbackSent = null;

export function initGallery({ projectId, feedbackCallback }) {
  currentProjectId = projectId;
  onFeedbackSent = feedbackCallback;
  setupFilterListener();
  setupModalListeners();
}

export async function loadDetections(projectId) {
  currentProjectId = projectId;
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/projects/${projectId}/detections`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    if (!res.ok) return;
    detections = await res.json();
    renderGallery();
    updateMapDetections();
  } catch (e) {
    console.error('Failed to load detections:', e);
  }
}

export function showGallery() {
  document.getElementById('gallery').classList.add('open');
  // Adjust map bottom
  document.getElementById('map').style.bottom = '40vh';
  const m = getMap(); if (m) m.resize();
}

export function hideGallery() {
  document.getElementById('gallery').classList.remove('open');
  document.getElementById('map').style.bottom = '0';
  const m = getMap(); if (m) m.resize();
}

function getFilteredDetections() {
  if (currentFilter === 'all') return detections;
  if (currentFilter === 'unreviewed') return detections.filter(d => !d.feedback);
  return detections.filter(d => d.feedback === currentFilter);
}

function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const filtered = getFilteredDetections();
  document.getElementById('gallery-count').textContent = filtered.length;

  grid.innerHTML = '';
  filtered.forEach((det) => {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    if (det.feedback) card.classList.add(`feedback-${det.feedback}`);

    const thumbUrl = `/tiles/crop/16/${det.tile_x}/${det.tile_y}/${det.cx}/${det.cy}/160.png`;
    card.innerHTML = `
      <img src="${thumbUrl}" alt="detection" loading="lazy">
      <div class="card-info">
        <span class="conf">conf: ${Number(det.conf).toFixed(3)}</span>
        ${det.feedback ? ` <span style="color:${det.feedback === 'yes' ? '#2ea043' : '#da3633'}">${det.feedback}</span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => openDetectionModal(det));
    grid.appendChild(card);
  });

  updateReviewStats();
}

function updateReviewStats() {
  const stats = document.getElementById('review-stats');
  const total = detections.length;
  const yes = detections.filter(d => d.feedback === 'yes').length;
  const no = detections.filter(d => d.feedback === 'no').length;
  const unreviewed = total - yes - no;
  stats.textContent = `全${total}件: Yes ${yes} / No ${no} / 未レビュー ${unreviewed}`;
}

function updateMapDetections() {
  const geojson = {
    type: 'FeatureCollection',
    features: detections.map(d => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      properties: {
        id: d.id,
        conf: d.conf,
        feedback: d.feedback || null,
        tile_x: d.tile_x,
        tile_y: d.tile_y
      }
    }))
  };
  updateDetections(geojson);
}

function openDetectionModal(det) {
  const modal = document.getElementById('detection-modal');
  const thumbUrl = `/tiles/crop/16/${det.tile_x}/${det.tile_y}/${det.cx}/${det.cy}/320.png`;
  document.getElementById('det-modal-img').src = thumbUrl;
  document.getElementById('det-modal-conf').textContent = Number(det.conf).toFixed(4);
  document.getElementById('det-modal-coords').textContent = `${det.lat.toFixed(6)}, ${det.lon.toFixed(6)}`;
  document.getElementById('det-modal-tile').textContent = `z16/${det.tile_x}/${det.tile_y}`;
  modal.classList.add('open');
  modal.dataset.detectionId = det.id;

  // Fly to detection on map
  flyTo(det.lon, det.lat);
}

function closeDetectionModal() {
  document.getElementById('detection-modal').classList.remove('open');
}

async function sendFeedback(feedback) {
  const modal = document.getElementById('detection-modal');
  const detId = modal.dataset.detectionId;
  if (!detId) return;

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/detections/${detId}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ feedback })
    });
    if (!res.ok) throw new Error('Feedback failed');

    // Update local state
    const det = detections.find(d => String(d.id) === String(detId));
    if (det) det.feedback = feedback;

    renderGallery();
    updateMapDetections();
    if (onFeedbackSent) onFeedbackSent(detId, feedback);
  } catch (e) {
    console.error('Failed to send feedback:', e);
  }

  closeDetectionModal();
}

function setupFilterListener() {
  const select = document.getElementById('review-filter');
  if (select) {
    select.addEventListener('change', (e) => {
      currentFilter = e.target.value;
      renderGallery();
    });
  }
}

function setupModalListeners() {
  document.getElementById('det-modal-yes')?.addEventListener('click', () => sendFeedback('yes'));
  document.getElementById('det-modal-no')?.addEventListener('click', () => sendFeedback('no'));
  document.getElementById('det-modal-skip')?.addEventListener('click', closeDetectionModal);
  document.getElementById('det-modal-close')?.addEventListener('click', closeDetectionModal);
  document.getElementById('detection-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDetectionModal();
  });
}

export function setDetections(data) {
  detections = data;
  renderGallery();
  updateMapDetections();
}
