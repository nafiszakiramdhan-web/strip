// ==========================================================================
// BINGKAI BISU — FIXLENS FESTIVAL 2026 DIGITAL PHOTOBOOTH APPLICATION
// Core Controller (ES Module)
// ==========================================================================

import { APP_CONFIG, firebaseConfig } from './config.js';

// Firebase v10 Modular SDK via CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { 
  getFirestore, 
  collection, 
  getDocs, 
  addDoc, 
  deleteDoc, 
  doc, 
  query, 
  orderBy 
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// --------------------------------------------------------------------------
// 1. APPLICATION STATE
// --------------------------------------------------------------------------
const state = {
  currentStage: 1, // 1: Select Frame, 2: Camera, 3: Preview, 4: QR Result
  frames: [],
  selectedFrame: null,

  // Camera & Capture State
  currentSlotIndex: 0,
  capturedPoses: [], // Array of { index, staticImg, videoBlob, videoUrl }
  livePhotoEnabled: true,
  currentFilter: 'normal',
  previewFilter: 'normal',
  facingMode: 'user',
  mediaStream: null,
  activeVideoRecorder: null,
  currentVideoChunks: [],
  isCountingDown: false,
  isRetakingSingle: false,
  retakeTargetIndex: null,

  // Final Output
  finalPngDataUrl: null,
  finalWebmBlob: null,
  gasResult: null,

  // Admin Mode
  adminSelectedFile: null,
  adminDetectedSlots: [],
  adminFrameImg: null,
  adminImageDataUrl: null
};

// Initialize Firebase Firestore safely with fallback
let db = null;
try {
  const firebaseApp = initializeApp(firebaseConfig);
  db = getFirestore(firebaseApp);
} catch (err) {
  console.warn("Firestore initialization notice (operating with fallback frame if offline):", err);
}

// --------------------------------------------------------------------------
// 2. AUDIO SYNTHESIS (Zero External Audio File Dependency)
// --------------------------------------------------------------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(frequency = 880, duration = 0.12) {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    // Audio context may require initial user click
  }
}

function playShutterSound() {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    // Noise buffer for mechanical shutter click
    const bufferSize = audioCtx.sampleRate * 0.08;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, now);
    filter.Q.setValueAtTime(3, now);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    noise.start(now);
  } catch (e) {}
}

// --------------------------------------------------------------------------
// 3. INDEXEDDB CACHE FOR FRAME IMAGES
// --------------------------------------------------------------------------
const DB_NAME = 'BingkaiBisuCache';
const STORE_NAME = 'frames_cache';

function openCacheDb() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fileId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function getCachedFrameDataUrl(fileId) {
  try {
    const idb = await openCacheDb();
    if (!idb) return null;
    return new Promise((resolve) => {
      const tx = idb.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fileId);
      req.onsuccess = () => resolve(req.result ? req.result.dataUrl : null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    return null;
  }
}

async function setCachedFrameDataUrl(fileId, dataUrl) {
  try {
    const idb = await openCacheDb();
    if (!idb) return;
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ fileId, dataUrl, cachedAt: Date.now() });
  } catch (err) {}
}

// --------------------------------------------------------------------------
// 4. GOOGLE APPS SCRIPT (GAS) BRIDGE & CLOUD SYNC
// --------------------------------------------------------------------------

/**
 * Uploads Base64 payload to Google Drive via GAS Web App.
 * Uses text/plain to avoid CORS preflight options check.
 */
async function uploadToGas(base64Data, mimeType, filename) {
  const cleanBase64 = base64Data.includes('base64,') ? base64Data.split('base64,')[1] : base64Data;
  const payload = JSON.stringify({
    base64: cleanBase64,
    mimeType: mimeType,
    filename: filename
  });

  const response = await fetch(APP_CONFIG.gasWebAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: payload
  });

  if (!response.ok) {
    throw new Error(`Gagal mengunggah ke GAS: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetches Frame Data URL from GAS GET endpoint to avoid canvas tainting.
 */
async function fetchFrameFromGas(fileId) {
  // 1. Check local IndexedDB cache first
  const cached = await getCachedFrameDataUrl(fileId);
  if (cached) return cached;

  // 2. Fetch from GAS endpoint
  const url = `${APP_CONFIG.gasWebAppUrl}?id=${encodeURIComponent(fileId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Gagal memuat bingkai dari Drive: ${response.statusText}`);
  }
  const result = await response.json();
  if (result.dataUrl) {
    await setCachedFrameDataUrl(fileId, result.dataUrl);
    return result.dataUrl;
  }
  throw new Error("Respon dataUrl bingkai kosong.");
}

// --------------------------------------------------------------------------
// 5. BUILT-IN FALLBACK FRAME TEMPLATE (600x1800 px, 4 Slots)
// --------------------------------------------------------------------------
function generateFallbackFrame() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 1800;
  const ctx = canvas.getContext('2d');

  // Background Royal Purple Gradient
  const grad = ctx.createLinearGradient(0, 0, 600, 1800);
  grad.addColorStop(0, '#1E0B3B');
  grad.addColorStop(0.5, '#2A0E4E');
  grad.addColorStop(1, '#120524');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 600, 1800);

  // Outer Gold Border & Corner Accents
  ctx.strokeStyle = '#D4AF37';
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, 560, 1760);

  ctx.strokeStyle = '#F4D35E';
  ctx.lineWidth = 1;
  ctx.strokeRect(26, 26, 548, 1748);

  // 4 Slot Dimensions
  const slots = [
    { x: 50, y: 80, width: 500, height: 325 },
    { x: 50, y: 435, width: 500, height: 325 },
    { x: 50, y: 790, width: 500, height: 325 },
    { x: 50, y: 1145, width: 500, height: 325 }
  ];

  // Draw borders around slots and clear transparent apertures
  slots.forEach((s, idx) => {
    // Cut transparent window for photo
    ctx.clearRect(s.x, s.y, s.width, s.height);

    // Decorative inner gold stroke around slot
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 2;
    ctx.strokeRect(s.x - 2, s.y - 2, s.width + 4, s.height + 4);

    // Subtle corner ornaments
    const cSize = 10;
    ctx.fillStyle = '#F4D35E';
    ctx.fillRect(s.x - 4, s.y - 4, cSize, 2);
    ctx.fillRect(s.x - 4, s.y - 4, 2, cSize);
    ctx.fillRect(s.x + s.width - cSize + 4, s.y - 4, cSize, 2);
    ctx.fillRect(s.x + s.width + 2, s.y - 4, 2, cSize);
    ctx.fillRect(s.x - 4, s.y + s.height + 2, cSize, 2);
    ctx.fillRect(s.x - 4, s.y + s.height - cSize + 4, 2, cSize);
    ctx.fillRect(s.x + s.width - cSize + 4, s.y + s.height + 2, cSize, 2);
    ctx.fillRect(s.x + s.width + 2, s.y + s.height - cSize + 4, 2, cSize);
  });

  // Footer Branding: "BINGKAI BISU — FIXLENS FESTIVAL 2026"
  ctx.textAlign = 'center';
  
  // Ornamental divider
  ctx.fillStyle = '#D4AF37';
  ctx.font = '16px serif';
  ctx.fillText('✦  ———————————————  ✦', 300, 1530);

  // Main Festival Heading
  ctx.fillStyle = '#F4D35E';
  ctx.font = 'bold 34px Cinzel, Georgia, serif';
  ctx.fillText('BINGKAI BISU', 300, 1585);

  // Subtitle
  ctx.fillStyle = '#F8F6F0';
  ctx.font = '600 16px "Plus Jakarta Sans", sans-serif';
  ctx.letterSpacing = '0.2em';
  ctx.fillText('FIXLENS FESTIVAL 2026', 300, 1625);

  // Small Date / Location Tag
  ctx.fillStyle = '#D4AF37';
  ctx.font = 'italic 14px "Plus Jakarta Sans", serif';
  ctx.fillText('Abadikan Cerita Tanpa Kata', 300, 1665);

  const dataUrl = canvas.toDataURL('image/png');
  return {
    id: 'default-fallback',
    name: 'Royal Purple & Gold Classic (Festival 2026)',
    fileId: 'built-in-fallback',
    slots: slots,
    width: 600,
    height: 1800,
    dataUrl: dataUrl
  };
}

// --------------------------------------------------------------------------
// 6. FRAME INITIALIZATION & CLOUD SYNC
// --------------------------------------------------------------------------
async function loadAllFrames() {
  const loadingEl = document.getElementById('frames-loading');
  const gridEl = document.getElementById('frames-grid');
  loadingEl.classList.remove('hidden');
  gridEl.innerHTML = '';

  const framesList = [];

  // 1. Always add built-in template as guaranteed option
  const fallback = generateFallbackFrame();
  framesList.push(fallback);

  // 2. Fetch custom frames from Firestore if available
  if (db) {
    try {
      const q = query(collection(db, 'frames'), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      
      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        try {
          // Fetch base64 dataUrl from GAS drive bridge
          const dataUrl = await fetchFrameFromGas(data.fileId);
          framesList.push({
            id: docSnap.id,
            name: data.name,
            fileId: data.fileId,
            slots: data.slots || [],
            width: data.width || 600,
            height: data.height || 1800,
            dataUrl: dataUrl
          });
        } catch (fetchErr) {
          console.warn(`Gagal memuat asset bingkai ${data.name}:`, fetchErr);
        }
      }
    } catch (dbErr) {
      console.warn("Pemberitahuan koneksi Firestore:", dbErr);
    }
  }

  state.frames = framesList;
  loadingEl.classList.add('hidden');
  renderFrameCards();
  renderAdminExistingFrames();
}

function renderFrameCards() {
  const gridEl = document.getElementById('frames-grid');
  gridEl.innerHTML = '';

  state.frames.forEach((frame) => {
    const card = document.createElement('div');
    card.className = `frame-card ${state.selectedFrame?.id === frame.id ? 'selected' : ''}`;
    card.onclick = () => selectFrame(frame);

    card.innerHTML = `
      <div class="frame-card-preview">
        <img src="${frame.dataUrl}" alt="${frame.name}">
      </div>
      <h3 class="frame-card-name">${frame.name}</h3>
      <span class="frame-card-slots">${frame.slots.length} Pose Foto</span>
    `;

    gridEl.appendChild(card);
  });

  // Auto-select first frame if none selected
  if (!state.selectedFrame && state.frames.length > 0) {
    selectFrame(state.frames[0]);
  }
}

function selectFrame(frame) {
  state.selectedFrame = frame;
  document.querySelectorAll('.frame-card').forEach((c, idx) => {
    if (state.frames[idx]?.id === frame.id) {
      c.classList.add('selected');
    } else {
      c.classList.remove('selected');
    }
  });

  const confirmBtn = document.getElementById('btn-confirm-frame');
  confirmBtn.disabled = false;
}

// --------------------------------------------------------------------------
// 7. STAGE NAVIGATION CONTROLLER
// --------------------------------------------------------------------------
function goToStage(stageNum) {
  state.currentStage = stageNum;

  // Update Stepper Nav
  document.querySelectorAll('.step-item').forEach((item) => {
    const step = parseInt(item.getAttribute('data-step'), 10);
    item.classList.remove('active', 'done');
    if (step === stageNum) {
      item.classList.add('active');
    } else if (step < stageNum) {
      item.classList.add('done');
    }
  });

  // Update View Sections
  document.querySelectorAll('.stage-section').forEach((sec) => {
    sec.classList.remove('active');
  });

  if (stageNum === 1) {
    document.getElementById('stage-select').classList.add('active');
    stopCameraStream();
  } else if (stageNum === 2) {
    document.getElementById('stage-camera').classList.add('active');
    startCameraFlow();
  } else if (stageNum === 3) {
    document.getElementById('stage-preview').classList.add('active');
    stopCameraStream();
    renderPreviewStage();
  } else if (stageNum === 4) {
    document.getElementById('stage-result').classList.add('active');
    stopCameraStream();
    startResultFlow();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --------------------------------------------------------------------------
// 8. CAMERA & CAPTURE LOGIC
// --------------------------------------------------------------------------
const videoEl = document.getElementById('camera-video');

async function startCameraFlow() {
  try {
    if (!state.mediaStream) {
      const constraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: state.facingMode
        },
        audio: false
      };
      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      videoEl.srcObject = state.mediaStream;
      await videoEl.play();
    }
  } catch (err) {
    alert("Izin akses kamera diperlukan untuk photobooth. Harap izinkan kamera pada browser Anda.");
    console.error("Camera access error:", err);
  }

  // Update pose indicators
  updatePoseProgressUI();
  updateGuideOverlay();
}

function stopCameraStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    videoEl.srcObject = null;
  }
}

function updatePoseProgressUI() {
  const totalSlots = state.selectedFrame ? state.selectedFrame.slots.length : 4;
  const targetIndex = state.isRetakingSingle ? state.retakeTargetIndex : state.currentSlotIndex;
  
  const textEl = document.getElementById('pose-indicator');
  textEl.textContent = `Pose ${targetIndex + 1} dari ${totalSlots}`;

  const dotsBar = document.getElementById('pose-dots-bar');
  dotsBar.innerHTML = '';
  for (let i = 0; i < totalSlots; i++) {
    const dot = document.createElement('div');
    dot.className = 'pose-dot';
    if (i < state.capturedPoses.length && !state.isRetakingSingle) {
      dot.classList.add('completed');
    }
    if (i === targetIndex) {
      dot.classList.add('current');
    }
    dotsBar.appendChild(dot);
  }

  renderPoseThumbnailRail();
}

function updateGuideOverlay() {
  if (!state.selectedFrame) return;
  const currentSlot = state.selectedFrame.slots[state.currentSlotIndex] || state.selectedFrame.slots[0];
  const guideBox = document.getElementById('slot-guide-box');
  
  // Calculate aspect ratio of current slot
  const slotRatio = currentSlot.width / currentSlot.height;
  
  // Adjust guide box aspect ratio
  if (slotRatio > 1.2) {
    guideBox.style.top = '14%';
    guideBox.style.bottom = '14%';
    guideBox.style.left = '12%';
    guideBox.style.right = '12%';
  } else {
    guideBox.style.top = '8%';
    guideBox.style.bottom = '8%';
    guideBox.style.left = '22%';
    guideBox.style.right = '22%';
  }
}

function renderPoseThumbnailRail() {
  const rail = document.getElementById('captured-thumbnails-rail');
  rail.innerHTML = '';
  const totalSlots = state.selectedFrame ? state.selectedFrame.slots.length : 4;

  for (let i = 0; i < totalSlots; i++) {
    const box = document.createElement('div');
    box.className = 'rail-thumb-box';
    
    if (state.capturedPoses[i]) {
      const img = document.createElement('img');
      img.src = state.capturedPoses[i].staticDataUrl;
      box.appendChild(img);
    }

    const numBadge = document.createElement('span');
    numBadge.className = 'rail-thumb-num';
    numBadge.textContent = `#${i + 1}`;
    box.appendChild(numBadge);

    rail.appendChild(box);
  }
}

// --------------------------------------------------------------------------
// 9. COUNTDOWN, SHUTTER & LIVE PHOTO RECORDING
// --------------------------------------------------------------------------
async function triggerPhotoCountdown() {
  if (state.isCountingDown) return;
  state.isCountingDown = true;

  const overlay = document.getElementById('countdown-overlay');
  const countNum = document.getElementById('countdown-number');
  const shutterFlash = document.getElementById('shutter-flash');
  overlay.classList.add('active');

  let remaining = APP_CONFIG.countdownSeconds;
  countNum.textContent = remaining;
  playBeep(660, 0.1);

  // Setup Live Photo MediaRecorder if enabled
  state.currentVideoChunks = [];
  let liveRecorder = null;
  const liveDurationMs = APP_CONFIG.livePhotoDurationMs;

  const timer = setInterval(() => {
    remaining--;

    // Start Live Photo Recording 1.5 seconds before snap
    if (remaining === 1 && state.livePhotoEnabled && state.mediaStream) {
      try {
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
        liveRecorder = new MediaRecorder(state.mediaStream, { mimeType: mime });
        liveRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) state.currentVideoChunks.push(e.data);
        };
        liveRecorder.start(100);
      } catch (recErr) {
        console.warn("Live Photo MediaRecorder not supported on this browser:", recErr);
      }
    }

    if (remaining > 0) {
      countNum.textContent = remaining;
      playBeep(660, 0.1);
    } else {
      clearInterval(timer);
      overlay.classList.remove('active');

      // Shutter snap moment
      playShutterSound();
      shutterFlash.classList.add('flashing');
      setTimeout(() => shutterFlash.classList.remove('flashing'), 350);

      // 1. Capture High-Res Static Photo
      const staticDataUrl = captureStillFromVideo();

      // 2. Stop Live Photo Recorder if active
      if (liveRecorder && liveRecorder.state !== 'inactive') {
        liveRecorder.onstop = () => {
          const videoBlob = new Blob(state.currentVideoChunks, { type: 'video/webm' });
          const videoUrl = URL.createObjectURL(videoBlob);
          handlePoseCaptured(staticDataUrl, videoBlob, videoUrl);
        };
        liveRecorder.stop();
      } else {
        handlePoseCaptured(staticDataUrl, null, null);
      }
    }
  }, 1000);
}

/**
 * Mathematically exact center-crop object-fit: cover onto canvas
 */
function drawCoverToCanvas(ctx, source, dx, dy, dw, dh, isMirrored = false) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const sourceRatio = sw / sh;
  const targetRatio = dw / dh;

  let sx = 0, sy = 0, sWidth = sw, sHeight = sh;

  if (sourceRatio > targetRatio) {
    sWidth = sh * targetRatio;
    sx = (sw - sWidth) / 2;
  } else {
    sHeight = sw / targetRatio;
    sy = (sh - sHeight) / 2;
  }

  ctx.save();
  if (isMirrored) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, dw, dh);
  } else {
    ctx.drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
  }
  ctx.restore();
}

function captureStillFromVideo() {
  const offscreen = document.createElement('canvas');
  offscreen.width = videoEl.videoWidth || 1280;
  offscreen.height = videoEl.videoHeight || 720;
  const ctx = offscreen.getContext('2d');

  // Apply user filter to captured still
  applyFilterToContext(ctx, state.currentFilter);

  // Mirrored drawing matching user preview
  ctx.save();
  ctx.translate(offscreen.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, offscreen.width, offscreen.height);
  ctx.restore();

  return offscreen.toDataURL('image/png', 0.95);
}

function applyFilterToContext(ctx, filterType) {
  if (filterType === 'bw') {
    ctx.filter = 'grayscale(100%) contrast(120%) brightness(95%)';
  } else if (filterType === 'vintage') {
    ctx.filter = 'sepia(38%) contrast(110%) brightness(105%) saturate(125%) hue-rotate(-8deg)';
  } else {
    ctx.filter = 'none';
  }
}

function handlePoseCaptured(staticDataUrl, videoBlob, videoUrl) {
  state.isCountingDown = false;
  const targetSlot = state.isRetakingSingle ? state.retakeTargetIndex : state.currentSlotIndex;

  const poseRecord = {
    index: targetSlot,
    staticDataUrl: staticDataUrl,
    videoBlob: videoBlob,
    videoUrl: videoUrl
  };

  if (state.isRetakingSingle) {
    state.capturedPoses[targetSlot] = poseRecord;
    state.isRetakingSingle = false;
    state.retakeTargetIndex = null;
    goToStage(3); // Return directly to preview after single retake!
    return;
  }

  state.capturedPoses.push(poseRecord);
  renderPoseThumbnailRail();

  const totalSlots = state.selectedFrame.slots.length;
  if (state.currentSlotIndex < totalSlots - 1) {
    // Proceed to next pose
    state.currentSlotIndex++;
    updatePoseProgressUI();
    updateGuideOverlay();

    // Auto prompt countdown after 1.8s pause for repositioning
    setTimeout(() => {
      if (state.currentStage === 2 && !state.isCountingDown) {
        triggerPhotoCountdown();
      }
    }, 1800);
  } else {
    // All poses completed!
    setTimeout(() => {
      goToStage(3);
    }, 600);
  }
}

// --------------------------------------------------------------------------
// 10. STAGE 3: PREVIEW, FILTER & RETAKE
// --------------------------------------------------------------------------
async function renderPreviewStage() {
  const canvas = document.getElementById('preview-strip-canvas');
  const frame = state.selectedFrame;
  if (!frame) return;

  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');

  // Clear Canvas
  ctx.clearRect(0, 0, frame.width, frame.height);

  // Load Frame Image
  const frameImg = await loadImage(frame.dataUrl);

  // 1. Draw Each Slot Photo
  for (let i = 0; i < frame.slots.length; i++) {
    const slot = frame.slots[i];
    const pose = state.capturedPoses[i];
    if (pose) {
      const poseImg = await loadImage(pose.staticDataUrl);
      applyFilterToContext(ctx, state.previewFilter);
      drawCoverToCanvas(ctx, poseImg, slot.x, slot.y, slot.width, slot.height, false);
    }
  }

  // 2. Draw Transparent Frame PNG on Top
  ctx.filter = 'none';
  ctx.drawImage(frameImg, 0, 0, frame.width, frame.height);

  // Store final rendered PNG data URL
  state.finalPngDataUrl = canvas.toDataURL('image/png', 0.95);

  // Render individual retake list
  renderRetakeList();
}

function renderRetakeList() {
  const listEl = document.getElementById('retake-slots-list');
  listEl.innerHTML = '';
  const totalSlots = state.selectedFrame.slots.length;

  for (let i = 0; i < totalSlots; i++) {
    const row = document.createElement('div');
    row.className = 'retake-slot-row';
    const pose = state.capturedPoses[i];

    row.innerHTML = `
      <div class="slot-info-wrap">
        <img class="slot-thumb" src="${pose ? pose.staticDataUrl : ''}" alt="Pose ${i + 1}">
        <span class="slot-title">Pose ${i + 1}</span>
      </div>
      <button class="btn-retake-single" data-index="${i}">
        Foto Ulang
      </button>
    `;

    row.querySelector('.btn-retake-single').onclick = () => {
      retakeSpecificPose(i);
    };

    listEl.appendChild(row);
  }
}

function retakeSpecificPose(index) {
  state.isRetakingSingle = true;
  state.retakeTargetIndex = index;
  state.currentSlotIndex = index;
  goToStage(2);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// --------------------------------------------------------------------------
// 11. LIVE PHOTO COMPOSITE GENERATOR (.WEBM)
// --------------------------------------------------------------------------
async function generateCompositeLivePhotoWebm() {
  const frame = state.selectedFrame;
  const offscreen = document.getElementById('offscreen-video-canvas');
  offscreen.width = frame.width;
  offscreen.height = frame.height;
  const ctx = offscreen.getContext('2d');

  // Verify that all poses have valid video blobs
  const hasVideos = state.capturedPoses.every((p) => p && p.videoBlob);
  if (!hasVideos) return null;

  // Create and play all video elements simultaneously
  const videoElements = [];
  for (let i = 0; i < frame.slots.length; i++) {
    const p = state.capturedPoses[i];
    const v = document.createElement('video');
    v.src = p.videoUrl;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    await v.play().catch(() => {});
    videoElements.push(v);
  }

  const frameImg = await loadImage(frame.dataUrl);

  return new Promise((resolve) => {
    const stream = offscreen.captureStream(30);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      videoElements.forEach((v) => v.pause());
      const compositeBlob = new Blob(chunks, { type: 'video/webm' });
      resolve(compositeBlob);
    };

    recorder.start(100);

    let isDrawing = true;
    const drawLoop = () => {
      if (!isDrawing) return;
      ctx.clearRect(0, 0, frame.width, frame.height);

      // Draw all animated video slots (mirrored to match user preview)
      for (let i = 0; i < frame.slots.length; i++) {
        const slot = frame.slots[i];
        const v = videoElements[i];
        applyFilterToContext(ctx, state.previewFilter);
        drawCoverToCanvas(ctx, v, slot.x, slot.y, slot.width, slot.height, true);
      }

      // Draw frame on top
      ctx.filter = 'none';
      ctx.drawImage(frameImg, 0, 0, frame.width, frame.height);

      requestAnimationFrame(drawLoop);
    };

    drawLoop();

    // Record composite animation loop for 3.2 seconds
    setTimeout(() => {
      isDrawing = false;
      recorder.stop();
    }, 3200);
  });
}

// --------------------------------------------------------------------------
// 12. STAGE 4: RESULT, QR CODE & DRIVE UPLOAD
// --------------------------------------------------------------------------
async function startResultFlow() {
  const uploadingCard = document.getElementById('result-uploading-card');
  const successCard = document.getElementById('result-success-card');
  const statusTitle = document.getElementById('upload-status-title');
  const statusDesc = document.getElementById('upload-status-desc');
  const finalImg = document.getElementById('final-strip-img');
  const btnWebm = document.getElementById('btn-download-webm');

  uploadingCard.classList.remove('hidden');
  successCard.classList.add('hidden');
  finalImg.src = state.finalPngDataUrl;

  try {
    // 1. Generate Live Photo if enabled
    let webmBlob = null;
    if (state.livePhotoEnabled && state.capturedPoses.some((p) => p?.videoBlob)) {
      statusTitle.textContent = "Mengomposisikan Live Photo...";
      statusDesc.textContent = "Menggabungkan video pendek menjadi strip animasi...";
      try {
        webmBlob = await generateCompositeLivePhotoWebm();
        state.finalWebmBlob = webmBlob;
        if (webmBlob) btnWebm.classList.remove('hidden');
      } catch (webmErr) {
        console.warn("Live Photo compilation warning:", webmErr);
      }
    }

    // 2. Upload PNG Photo Strip to Google Drive via GAS
    statusTitle.textContent = "Mengunggah ke Google Drive...";
    statusDesc.textContent = "Menyimpan foto strip resolusi tinggi ke cloud...";
    
    const timestamp = Date.now();
    const pngFilename = `bingkai-bisu-${timestamp}.png`;
    const uploadRes = await uploadToGas(state.finalPngDataUrl, 'image/png', pngFilename);
    state.gasResult = uploadRes;

    // 3. Upload Live Photo WebM if available
    if (webmBlob) {
      try {
        const webmBase64 = await blobToBase64(webmBlob);
        const webmFilename = `bingkai-bisu-live-${timestamp}.webm`;
        await uploadToGas(webmBase64, 'video/webm', webmFilename);
      } catch (e) {
        console.warn("Live Photo cloud upload warning:", e);
      }
    }

    // 4. Generate QR Code pointing to viewUrl
    const targetUrl = uploadRes.viewUrl || uploadRes.downloadUrl || window.location.href;
    renderQrCode(targetUrl);

    document.getElementById('drive-link-input').value = targetUrl;

    // Show Success State
    uploadingCard.classList.add('hidden');
    successCard.classList.remove('hidden');

  } catch (err) {
    console.error("Gagal mengunggah ke Cloud:", err);
    // Even if cloud upload fails, show result with local download!
    statusTitle.textContent = "Penyimpanan Lokal Siap!";
    statusDesc.textContent = "Tidak dapat terhubung ke cloud. Anda tetap dapat mengunduh foto strip langsung di perangkat ini.";
    uploadingCard.classList.add('hidden');
    successCard.classList.remove('hidden');

    // Generate fallback QR for current page URL
    renderQrCode(window.location.href);
    document.getElementById('drive-link-input').value = window.location.href;
  }
}

function renderQrCode(url) {
  const qrBox = document.getElementById('qrcode-box');
  qrBox.innerHTML = '';
  
  if (window.QRCode) {
    new QRCode(qrBox, {
      text: url,
      width: 190,
      height: 190,
      colorDark: "#120822",
      colorLight: "#FFFFFF",
      correctLevel: QRCode.CorrectLevel.M
    });
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function downloadFile(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// --------------------------------------------------------------------------
// 13. ADMIN MODE & PIXEL-SCANNING AUTO-SLOT DETECTOR
// --------------------------------------------------------------------------

/**
 * Scans uploaded PNG image pixels for transparent apertures (alpha < 10)
 * using Connected-Component Labeling / Flood Fill to auto-detect photo slots.
 * Supports both natively transparent PNGs and chroma-key green converted frames.
 */
function detectTransparentSlots(sourceImgOrCanvas, existingImgData = null) {
  const W = sourceImgOrCanvas.naturalWidth || sourceImgOrCanvas.width;
  const H = sourceImgOrCanvas.naturalHeight || sourceImgOrCanvas.height;

  let imgData;
  if (existingImgData && existingImgData.data) {
    imgData = existingImgData.data;
  } else {
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx = off.getContext('2d');
    ctx.drawImage(sourceImgOrCanvas, 0, 0, W, H);
    imgData = ctx.getImageData(0, 0, W, H).data;
  }

  const step = Math.max(3, Math.floor(Math.min(W, H) / 300));
  const visited = new Uint8Array(W * H);
  const slotsFound = [];

  const minSlotW = W * 0.15;
  const minSlotH = H * 0.05;

  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const idx = y * W + x;
      if (visited[idx]) continue;

      const alpha = imgData[idx * 4 + 3];
      if (alpha < 10) {
        // Transparent (or chroma-key converted) seed found! Execute BFS flood fill
        let minX = x, maxX = x, minY = y, maxY = y;
        let pixelCount = 0;

        const queue = [x, y];
        visited[idx] = 1;

        while (queue.length > 0) {
          const cy = queue.pop();
          const cx = queue.pop();
          pixelCount++;

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          // Check 4-connected neighbors with step
          const neighbors = [
            [cx + step, cy],
            [cx - step, cy],
            [cx, cy + step],
            [cx, cy - step]
          ];

          for (let n = 0; n < 4; n++) {
            const nx = neighbors[n][0];
            const ny = neighbors[n][1];
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              const nIdx = ny * W + nx;
              if (!visited[nIdx]) {
                visited[nIdx] = 1;
                if (imgData[nIdx * 4 + 3] < 10) {
                  queue.push(nx, ny);
                }
              }
            }
          }
        }

        // Refine bounding box to exact 1-pixel precision
        while (minX > 0) {
          let hasTrans = false;
          for (let py = minY; py <= maxY; py += step) {
            if (imgData[(py * W + (minX - 1)) * 4 + 3] < 10) { hasTrans = true; break; }
          }
          if (hasTrans) minX--; else break;
        }
        while (maxX < W - 1) {
          let hasTrans = false;
          for (let py = minY; py <= maxY; py += step) {
            if (imgData[(py * W + (maxX + 1)) * 4 + 3] < 10) { hasTrans = true; break; }
          }
          if (hasTrans) maxX++; else break;
        }
        while (minY > 0) {
          let hasTrans = false;
          for (let px = minX; px <= maxX; px += step) {
            if (imgData[((minY - 1) * W + px) * 4 + 3] < 10) { hasTrans = true; break; }
          }
          if (hasTrans) minY--; else break;
        }
        while (maxY < H - 1) {
          let hasTrans = false;
          for (let px = minX; px <= maxX; px += step) {
            if (imgData[((maxY + 1) * W + px) * 4 + 3] < 10) { hasTrans = true; break; }
          }
          if (hasTrans) maxY++; else break;
        }

        const slotW = maxX - minX + 1;
        const slotH = maxY - minY + 1;

        // Filter out small transparent artifacts or text cutouts
        if (slotW >= minSlotW && slotH >= minSlotH && pixelCount > 40) {
          slotsFound.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: Math.min(W - minX, slotW),
            height: Math.min(H - minY, slotH)
          });
        }
      }
    }
  }

  // Sort slots top-to-bottom, and left-to-right for multi-column frames
  slotsFound.sort((a, b) => {
    if (Math.abs(a.y - b.y) > H * 0.04) {
      return a.y - b.y;
    }
    return a.x - b.x;
  });

  return slotsFound;
}

function renderAdminDetectionVisualizer(img, slots) {
  const canvas = document.getElementById('admin-detect-canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');

  // Checkerboard/dark background behind image to visualize transparency
  ctx.fillStyle = '#0f051d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw cleaned frame image
  ctx.drawImage(img, 0, 0);

  // Overlay detected slot bounding boxes
  slots.forEach((s, idx) => {
    // Fill transparent area with gold highlight
    ctx.fillStyle = 'rgba(244, 211, 94, 0.28)';
    ctx.fillRect(s.x, s.y, s.width, s.height);

    // Dashed border
    ctx.strokeStyle = '#F4D35E';
    ctx.lineWidth = Math.max(3, Math.floor(canvas.width / 200));
    ctx.setLineDash([12, 8]);
    ctx.strokeRect(s.x, s.y, s.width, s.height);
    ctx.setLineDash([]);

    // Badge label
    const badgeW = Math.max(90, Math.floor(s.width * 0.3));
    const badgeH = Math.max(32, Math.floor(s.height * 0.12));
    ctx.fillStyle = '#120822';
    ctx.fillRect(s.x + 8, s.y + 8, badgeW, badgeH);

    ctx.fillStyle = '#F4D35E';
    ctx.font = `bold ${Math.max(16, Math.floor(badgeH * 0.6))}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`Pose ${idx + 1}`, s.x + 8 + badgeW / 2, s.y + 8 + badgeH * 0.7);
  });
}

function renderAdminExistingFrames() {
  const listEl = document.getElementById('admin-frames-list');
  const countEl = document.getElementById('admin-frames-count');
  countEl.textContent = state.frames.length;
  listEl.innerHTML = '';

  state.frames.forEach((f) => {
    const item = document.createElement('div');
    item.className = 'admin-frame-item';
    item.innerHTML = `
      <img src="${f.dataUrl}" alt="${f.name}" class="admin-frame-thumb">
      <h5 class="admin-frame-title">${f.name}</h5>
      <p class="admin-frame-meta">${f.slots.length} Slot &bull; ${f.width}x${f.height}px</p>
      ${f.fileId !== 'built-in-fallback' ? `<button class="btn-delete-frame" data-id="${f.id}">Hapus Bingkai</button>` : `<span class="badge-default">Bawaan</span>`}
    `;

    const deleteBtn = item.querySelector('.btn-delete-frame');
    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (confirm(`Yakin ingin menghapus desain bingkai "${f.name}" dari festival?`)) {
          if (db) {
            await deleteDoc(doc(db, 'frames', f.id));
            alert("Bingkai berhasil dihapus.");
            await loadAllFrames();
          }
        }
      };
    }

    listEl.appendChild(item);
  });
}

// --------------------------------------------------------------------------
// 14. EVENT LISTENERS & INITIALIZATION
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {

  // Load Frames on Startup
  loadAllFrames();

  // Fullscreen Toggle
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Stage 1 -> 2: Confirm Frame Selection
  document.getElementById('btn-confirm-frame').addEventListener('click', () => {
    state.currentSlotIndex = 0;
    state.capturedPoses = [];
    goToStage(2);
  });

  // Stage 2: Back to Frame Selection
  document.getElementById('btn-back-to-frames').addEventListener('click', () => {
    goToStage(1);
  });

  // Camera Switch
  document.getElementById('btn-switch-camera').addEventListener('click', async () => {
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
    stopCameraStream();
    await startCameraFlow();
  });

  // Live Photo Toggle
  const liveToggle = document.getElementById('toggle-live-photo');
  liveToggle.addEventListener('change', (e) => {
    state.livePhotoEnabled = e.target.checked;
  });

  // Shutter Countdown Trigger
  document.getElementById('btn-start-countdown').addEventListener('click', () => {
    triggerPhotoCountdown();
  });

  // Stage 2 Real-time Filters
  document.querySelectorAll('.filter-pill[data-filter]').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-pill[data-filter]').forEach((p) => p.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');

      const filterType = target.getAttribute('data-filter');
      state.currentFilter = filterType;
      state.previewFilter = filterType;

      videoEl.className = '';
      if (filterType === 'bw') videoEl.classList.add('filter-bw');
      else if (filterType === 'vintage') videoEl.classList.add('filter-vintage');
      else videoEl.classList.add('filter-normal');
    });
  });

  // Stage 3 Preview Filters
  document.querySelectorAll('.filter-pill[data-preview-filter]').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-pill[data-preview-filter]').forEach((p) => p.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');

      state.previewFilter = target.getAttribute('data-preview-filter');
      renderPreviewStage();
    });
  });

  // Stage 3: Retake All
  document.getElementById('btn-retake-all').addEventListener('click', () => {
    if (confirm("Mulai ulang semua foto pose?")) {
      state.capturedPoses = [];
      state.currentSlotIndex = 0;
      state.isRetakingSingle = false;
      goToStage(2);
    }
  });

  // Stage 3 -> 4: Finalize & Generate QR
  document.getElementById('btn-finalize-strip').addEventListener('click', () => {
    goToStage(4);
  });

  // Stage 4: Download Buttons
  document.getElementById('btn-download-png').addEventListener('click', () => {
    if (state.finalPngDataUrl) {
      downloadFile(state.finalPngDataUrl, `bingkai-bisu-${Date.now()}.png`);
    }
  });

  document.getElementById('btn-download-webm').addEventListener('click', () => {
    if (state.finalWebmBlob) {
      const url = URL.createObjectURL(state.finalWebmBlob);
      downloadFile(url, `bingkai-bisu-live-${Date.now()}.webm`);
    }
  });

  // Stage 4: Copy Drive Link
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const input = document.getElementById('drive-link-input');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.getElementById('btn-copy-link');
      btn.textContent = 'Tersalin!';
      setTimeout(() => { btn.textContent = 'Salin'; }, 2000);
    });
  });

  // Stage 4: New Session
  document.getElementById('btn-new-session').addEventListener('click', () => {
    state.capturedPoses = [];
    state.currentSlotIndex = 0;
    state.finalPngDataUrl = null;
    state.finalWebmBlob = null;
    state.gasResult = null;
    goToStage(1);
  });

  // ------------------------------------------------------------------------
  // ADMIN PIN MODAL & PANEL
  // ------------------------------------------------------------------------
  const adminPinDialog = document.getElementById('admin-pin-dialog');
  const adminDashDialog = document.getElementById('admin-dashboard-dialog');
  const pinInput = document.getElementById('input-admin-pin');
  const pinError = document.getElementById('pin-error-msg');

  const openAdminPin = () => {
    pinInput.value = '';
    pinError.classList.add('hidden');
    adminPinDialog.showModal();
    pinInput.focus();
  };

  document.getElementById('btn-open-admin-pin').addEventListener('click', openAdminPin);
  document.getElementById('btn-footer-admin').addEventListener('click', openAdminPin);

  document.getElementById('btn-close-pin-dialog').addEventListener('click', () => {
    adminPinDialog.close();
  });

  document.getElementById('form-admin-pin').addEventListener('submit', (e) => {
    e.preventDefault();
    if (pinInput.value.trim() === APP_CONFIG.adminPin) {
      adminPinDialog.close();
      adminDashDialog.showModal();
      renderAdminExistingFrames();
    } else {
      pinError.classList.remove('hidden');
      pinInput.value = '';
    }
  });

  document.getElementById('btn-close-admin-dash').addEventListener('click', () => {
    adminDashDialog.close();
  });

  // Admin Tab Switcher
  document.querySelectorAll('.admin-tabs .tab-btn').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.admin-tabs .tab-btn').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.admin-tab-content').forEach((c) => c.classList.remove('active'));
      
      const target = e.currentTarget;
      target.classList.add('active');
      const tabId = target.getAttribute('data-tab');
      document.getElementById(`tab-content-${tabId}`).classList.add('active');
    });
  });

  // Admin File Dropzone & Slot Auto-Detection
  const dropzone = document.getElementById('frame-dropzone');
  const fileInput = document.getElementById('admin-frame-file');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAdminFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleAdminFile(e.target.files[0]);
    }
  });

  function handleAdminFile(file) {
    if (file.type !== 'image/png') {
      alert("Harap pilih berkas PNG (transparan atau dengan kotak hijau Canva).");
      return;
    }

    state.adminSelectedFile = file;
    const nameInput = document.getElementById('admin-frame-name');
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.[^/.]+$/, "");
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const rawDataUrl = ev.target.result;
      const rawImg = await loadImage(rawDataUrl);
      const W = rawImg.naturalWidth;
      const H = rawImg.naturalHeight;

      // 1. Draw onto offscreen canvas for Chroma-Key Green to Transparent conversion
      const cleanCanvas = document.createElement('canvas');
      cleanCanvas.width = W;
      cleanCanvas.height = H;
      const cleanCtx = cleanCanvas.getContext('2d');
      cleanCtx.drawImage(rawImg, 0, 0, W, H);

      const imgDataObj = cleanCtx.getImageData(0, 0, W, H);
      const data = imgDataObj.data;
      let greenPixelsFound = 0;

      // Loop through every pixel in ImageData:
      // Whenever a pixel matches bright green (r < 90 && g > 190 && b < 90),
      // set its alpha channel to 0 (data[i + 3] = 0) so it becomes genuinely transparent.
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a > 0 && r < 90 && g > 190 && b < 90) {
          data[i + 3] = 0;
          greenPixelsFound++;
        }
      }

      // Put processed ImageData back onto canvas
      cleanCtx.putImageData(imgDataObj, 0, 0);

      // Export processed transparent canvas so published frame works cleanly
      const cleanedDataUrl = cleanCanvas.toDataURL('image/png');
      state.adminImageDataUrl = cleanedDataUrl;

      // Load cleaned image for visualization & rendering
      const cleanedImg = await loadImage(cleanedDataUrl);
      state.adminFrameImg = cleanedImg;

      // 2. Run Slot Detection on the Cleaned Canvas / ImageData (where alpha < 10)
      const detectedSlots = detectTransparentSlots(cleanCanvas, imgDataObj);
      state.adminDetectedSlots = detectedSlots;

      // Update metrics UI
      const metricsText = document.getElementById('metrics-status-text');
      const chipsList = document.getElementById('detected-slots-details');
      const publishBtn = document.getElementById('btn-publish-frame');

      const greenNote = greenPixelsFound > 0 ? ` (Dikonversi dari ${greenPixelsFound.toLocaleString()} piksel hijau chroma-key Canva)` : '';
      metricsText.textContent = `Berhasil mendeteksi ${detectedSlots.length} slot foto${greenNote} (${W} x ${H} px).`;
      chipsList.innerHTML = '';

      detectedSlots.forEach((s, idx) => {
        const chip = document.createElement('span');
        chip.className = 'slot-chip';
        chip.textContent = `Pose ${idx + 1}: ${s.width}x${s.height}px`;
        chipsList.appendChild(chip);
      });

      // Visual slot overlay on the cleaned image
      renderAdminDetectionVisualizer(cleanedImg, detectedSlots);

      publishBtn.disabled = detectedSlots.length === 0;
    };
    reader.readAsDataURL(file);
  }

  // Publish Frame to GAS Drive & Firestore
  document.getElementById('btn-publish-frame').addEventListener('click', async () => {
    const nameInput = document.getElementById('admin-frame-name');
    const frameName = nameInput.value.trim() || 'Frame Tanpa Nama';
    const progressBox = document.getElementById('admin-publish-progress');
    const publishMsg = document.getElementById('admin-publish-msg');
    const publishBtn = document.getElementById('btn-publish-frame');

    if (!state.adminSelectedFile || state.adminDetectedSlots.length === 0) return;

    publishBtn.disabled = true;
    progressBox.classList.remove('hidden');

    try {
      publishMsg.textContent = "Mengunggah file PNG ke Google Drive...";
      const uploadRes = await uploadToGas(
        state.adminImageDataUrl,
        'image/png',
        `${frameName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.png`
      );

      const fileId = uploadRes.fileId;
      if (!fileId) throw new Error("Gagal menerima fileId dari Google Apps Script.");

      publishMsg.textContent = "Menyimpan metadata bingkai ke Firestore Cloud...";
      if (db) {
        await addDoc(collection(db, 'frames'), {
          name: frameName,
          fileId: fileId,
          slots: state.adminDetectedSlots,
          width: state.adminFrameImg.naturalWidth,
          height: state.adminFrameImg.naturalHeight,
          createdAt: Date.now()
        });
      }

      publishMsg.textContent = "Selesai! Bingkai langsung aktif.";
      setTimeout(async () => {
        progressBox.classList.add('hidden');
        adminDashDialog.close();
        await loadAllFrames();
        alert(`Bingkai "${frameName}" berhasil diterbitkan dan langsung aktif!`);
      }, 1000);

    } catch (err) {
      console.error("Gagal menerbitkan bingkai:", err);
      alert(`Terjadi kesalahan saat menerbitkan: ${err.message}`);
      progressBox.classList.add('hidden');
      publishBtn.disabled = false;
    }
  });

});
