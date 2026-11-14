# Bingkai Bisu — Fixlens Festival 2026
### Digital Photobooth Web Application

A lightweight, zero-dependency, static photobooth web application built with pure HTML5, CSS3, and Vanilla JavaScript (ES Modules). Ready to be deployed directly to GitHub Pages at **[https://github.com/nafiszakiramdhan-web/strip](https://github.com/nafiszakiramdhan-web/strip)**.

---

## 🎨 Visual Identity & Aesthetic

- **Theme**: Vintage Photography Exhibition & Royal Cinema.
- **Palette**:
  - Deep Royal Purple (`#120822` to `#2E1152` and `#431A75`) with subtle dark grain/noise texture overlay.
  - Warm Gold accents (`#F4D35E`, `#D4AF37`, `#AA8010`).
  - Crisp Off-White typography (`#F8F6F0`).
- **Typography**: Classic Roman display serif (`Cinzel`) paired with modern, crisp UI sans-serif (`Plus Jakarta Sans`).
- **Flow**: 4 clear fullscreen booth-friendly stages:
  1. **Select Frame** (`#stage-select`)
  2. **Camera & Capture** (`#stage-camera`)
  3. **Preview & Filter** (`#stage-preview`)
  4. **QR Code Result** (`#stage-result`)

---

## 🚀 Key Features

1. **Live Camera & Real-Time Filters**:
   - WebRTC mirrored camera preview (`navigator.mediaDevices.getUserMedia`).
   - Filters: **Normal**, **Classic B&W**, **Warm Vintage**.
   - 3-second animated circular visual countdown with Web Audio synthesizer beeps.
   - White mechanical shutter flash effect with synthesized camera shutter click.
   - Pose counter (e.g., `Pose 1 dari 4`) with progress dots.

2. **Live Photo Mode (Toggleable)**:
   - Records a 1.5-second video clip leading up to each shutter snap using the `MediaRecorder` API.
   - Composites both:
     - High-resolution static `.png` photo strip (with center-crop `object-fit: cover` math so webcam feeds never stretch).
     - Animated `.webm` video photo strip (playing all recorded clips simultaneously inside their respective frame slots on an offscreen `<canvas>` recorded via `captureStream()` + `MediaRecorder`).

3. **Individual Retake & Live Editing**:
   - Review each captured pose in the Preview stage.
   - Retake any individual shot without losing the other poses.
   - Switch color filters globally on the preview screen before finalization.

4. **Cloud Frame Sync & Drive Bridge**:
   - Firebase Firestore (`v10` Modular SDK via CDN) stores frame metadata (`name`, `fileId`, `slots`, `width`, `height`, `createdAt`).
   - Google Apps Script (GAS) Web App handles:
     - `POST`: Direct Base64 upload to Google Drive without CORS preflight issues (`Content-Type: text/plain;charset=utf-8`).
     - `GET ?id={fileId}`: Returns Base64 `dataUrl` to load custom frames without HTML5 Canvas CORS tainting.
   - **Local IndexedDB Cache**: Caches frame base64 data locally so subsequent loads are instant.
   - **Built-in Fallback Template**: 600x1800px 4-cut vertical strip in royal purple & gold, ensuring 100% functionality out of the box even before any frame is uploaded.

5. **Admin Mode — No-Code Auto-Detect Transparent & Chroma-Key Slots**:
   - Discreet Admin button protected by PIN modal (`APP_CONFIG.adminPin = "2026"`).
   - Upload transparent `.png` frame designs or Canva designs with bright chroma-key green boxes (`r < 90 && g > 190 && b < 90`).
   - **Auto-Convert Green to Transparent**: Automatically converts green box pixels to transparent (`alpha = 0`) on an offscreen canvas with zero manual background removal needed.
   - **Pixel-Scanning Auto-Slot Detector**: Uses offscreen canvas and `ctx.getImageData()` to scan for connected transparent regions (`alpha < 10`), filters noise, refines bounds with 1px precision, sorts top-to-bottom/left-to-right, and highlights slots visually on the canvas.
   - "Unggah & Terbitkan": Automatically uploads cleaned transparent PNG to Google Drive, saves slot coordinates to Firestore, and makes the frame live across all devices instantly.
   - Delete existing custom frames from Firestore directly from the dashboard.

---

## 📁 File Structure

```text
photostrip/
├── index.html        # Semantic HTML5 single-page application
├── style.css         # Theme stylesheet (Royal Purple, Gold, Responsive)
├── app.js            # Main controller (Camera, Canvas, Live Photo, Admin)
├── config.js         # Configuration & pre-filled credentials
└── README.md         # Documentation & deployment guide
```

---

## ⚙️ Configuration (`config.js`)

```javascript
export const APP_CONFIG = {
  eventName: "Bingkai Bisu — Fixlens Festival 2026",
  adminPin: "2026",
  countdownSeconds: 3,
  livePhotoDurationMs: 1500,
  gasWebAppUrl: "https://script.google.com/macros/s/AKfycbxxJ6DprMUeVxJ0SY2nT_0Dc8XkpnAQZ9qSD-_1sgKL3BaMPFSdGhzamJXAt855EVnn/exec"
};

export const firebaseConfig = {
  apiKey: "AIzaSyADkvT6p8kdjm_05ltM7lLJJCHlxFf8sn8",
  authDomain: "bingkai-bisu-photobooth.firebaseapp.com",
  projectId: "bingkai-bisu-photobooth",
  storageBucket: "bingkai-bisu-photobooth.firebasestorage.app",
  messagingSenderId: "443933848889",
  appId: "1:443933848889:web:6ef72b18c161d0489d64e8",
  measurementId: "G-R15G007RMC"
};
```

---

## 🚢 Deploying to GitHub Pages

1. Initialize git and commit:
   ```bash
   git init
   git add .
   git commit -m "feat: complete Bingkai Bisu Fixlens Festival 2026 photobooth"
   ```

2. Link to your GitHub repository and push to main:
   ```bash
   git branch -M main
   git remote add origin https://github.com/nafiszakiramdhan-web/strip.git
   git push -u origin main
   ```

3. Enable GitHub Pages:
   - Go to your repository settings on GitHub: **Settings > Pages**.
   - Under **Build and deployment > Source**, select **Deploy from a branch**.
   - Select branch `main` and folder `/ (root)`.
   - Click **Save**.
   - Your photobooth is now live on GitHub Pages!
