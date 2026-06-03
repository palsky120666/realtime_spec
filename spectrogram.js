/**
 * spectrogram.js — ObieWebApp 2
 *
 * Real-time horizontal scrolling spectrogram using the Web Audio API.
 * Right channel only (violin measurement convention in ObieApp).
 *
 * Layout orientation: matches Spectroid rotated 90° CCW —
 *   X axis = TIME  (new data enters at the RIGHT, scrolls LEFT)
 *   Y axis = FREQUENCY  (bottom = low freq, top = high freq)
 *
 * All signal processing is Web Audio native (AnalyserNode FFT).
 * PyScript / Python not used for DSP here; main.py just hides the
 * loading overlay once the page is live.
 */

'use strict';

/* ── Module-level state ─────────────────────────────────────────────────── */
let _audioCtx   = null;
let _analyser   = null;
let _sourceNode = null;
let _splitter   = null;
let _stream     = null;
let _rafId      = null;
let _running    = false;

let _fftSize  = 2048;
let _dbFloor  = -100;          // dB display floor (bottom of colour scale)
let _dbCeil   =  0;            // dB display ceiling (top of colour scale)
let _pixelsPerFrame = 2;       // scrolling speed (pixels per animation frame)

/* Canvas handles */
let _canvas   = null;
let _ctx      = null;
let _scaleCanvas = null;
let _scaleCtx    = null;

/* Off-screen column buffer for one new FFT slice */
let _colBuf  = null;   // ImageData width=1
let _colCtx  = null;

/* Colour map (pre-computed LUT, 256 entries, same plasma-ish palette as Spectroid) */
const _CMAP = buildColourMap();

/* ── Initialization ──────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  _canvas      = document.getElementById('spec-canvas');
  _ctx         = _canvas.getContext('2d', { willReadFrequently: true });
  _scaleCanvas = document.getElementById('spec-scale');
  _scaleCtx    = _scaleCanvas.getContext('2d');

  // Resize canvas to fill its CSS box
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Crosshair readout on mouse move
  _canvas.addEventListener('mousemove', onCanvasMouseMove);
  _canvas.addEventListener('mouseleave', () => {
    document.getElementById('spec-readout').style.display = 'none';
  });

  drawColourScale();
  updateScaleLabels();
  buildFreqAxis();
  buildTimeAxis();

  // Hide the PyScript loading overlay — we don't actually wait for Python here
  // but we expose hideLoading so main.py can also call it when it's ready.
  window._spectrogramReady = true;
});

function resizeCanvas() {
  if (!_canvas) return;
  const wrap = _canvas.parentElement;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (_canvas.width !== W || _canvas.height !== H) {
    // Preserve existing content: copy → resize → paste
    if (_canvas.width > 0 && _canvas.height > 0) {
      const tmp = document.createElement('canvas');
      tmp.width  = _canvas.width;
      tmp.height = _canvas.height;
      tmp.getContext('2d').drawImage(_canvas, 0, 0);
      _canvas.width  = W;
      _canvas.height = H;
      _ctx.drawImage(tmp, 0, 0);
    } else {
      _canvas.width  = W;
      _canvas.height = H;
    }
    buildColBuf();
    buildFreqAxis();
  }
}

function buildColBuf() {
  // Off-screen 1×H canvas for one column slice
  const H = _canvas.height || 1;
  const oc = document.createElement('canvas');
  oc.width  = 1;
  oc.height = H;
  _colCtx  = oc.getContext('2d');
  _colBuf  = _colCtx.createImageData(1, H);
}

/* ── Public API (called from HTML onclick / select onchange) ─────────────── */
window.spectrogramStart = async function() {
  if (_running) return;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000
    }, video: false });

    _audioCtx  = new AudioContext({ sampleRate: _stream.getAudioTracks()[0]
                                        .getSettings().sampleRate || 48000 });
    _analyser  = _audioCtx.createAnalyser();
    _analyser.fftSize              = _fftSize;
    _analyser.smoothingTimeConstant = 0.0;   // no smoothing — raw spectrogram
    _analyser.minDecibels          = -140;
    _analyser.maxDecibels          =  0;

    _sourceNode = _audioCtx.createMediaStreamSource(_stream);
    _splitter   = _audioCtx.createChannelSplitter(2);
    _sourceNode.connect(_splitter);
    // Right channel = index 1
    _splitter.connect(_analyser, 1, 0);

    _running = true;
    setStatus('Running — right channel  |  ' +
              (_audioCtx.sampleRate / 1000).toFixed(0) + ' kHz  |  ' +
              'FFT ' + _fftSize);
    document.getElementById('spec-start-btn').disabled = true;
    document.getElementById('spec-stop-btn').disabled  = false;

    buildFreqAxis();   // recalculate with actual sample rate
    loop();
  } catch (err) {
    setStatus('Mic error: ' + err.message);
    console.error(err);
  }
};

window.spectrogramStop = function() {
  if (!_running) return;
  _running = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_stream)    { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_audioCtx)  { _audioCtx.close(); _audioCtx = null; }
  _analyser   = null;
  _sourceNode = null;
  _splitter   = null;
  document.getElementById('spec-start-btn').disabled = false;
  document.getElementById('spec-stop-btn').disabled  = true;
  setStatus('Stopped');
};

window.spectrogramSetFFT = function(val) {
  _fftSize = parseInt(val, 10);
  if (_analyser) {
    _analyser.fftSize = _fftSize;
    buildFreqAxis();
    setStatus('FFT size → ' + _fftSize);
  }
};

window.spectrogramSetFloor = function(val) {
  _dbFloor = parseFloat(val);
  drawColourScale();
  updateScaleLabels();
};

window.spectrogramSetSpeed = function(val) {
  _pixelsPerFrame = parseInt(val, 10);
};

window.spectrogramHelp = function() {
  window.open('../../Docs/index.html', '_blank');
};

/* ── Animation loop ──────────────────────────────────────────────────────── */
function loop() {
  if (!_running) return;
  _rafId = requestAnimationFrame(loop);
  drawFrame();
}

function drawFrame() {
  if (!_analyser || !_canvas || _canvas.width === 0) return;

  const binCount = _analyser.frequencyBinCount;
  const data     = new Float32Array(binCount);
  _analyser.getFloatFrequencyData(data);

  const W = _canvas.width;
  const H = _canvas.height;
  const px = _pixelsPerFrame;

  // Scroll canvas left by px pixels
  _ctx.drawImage(_canvas, -px, 0);

  // Draw px new columns at the right edge
  if (!_colBuf || _colBuf.height !== H) buildColBuf();

  // Map frequency bins → pixels  (bottom = DC, top = Nyquist)
  // Spectroid orientation: low freq at bottom, high freq at top
  const buf = _colBuf.data;
  for (let y = 0; y < H; y++) {
    // y=0 is top of canvas (high freq), y=H-1 is bottom (low freq)
    const binFrac = (H - 1 - y) / (H - 1);   // 0 = DC, 1 = Nyquist
    const binIdx  = Math.round(binFrac * (binCount - 1));
    const db      = data[binIdx];

    // Map dB → 0..255
    const t = Math.max(0, Math.min(1, (db - _dbFloor) / (_dbCeil - _dbFloor)));
    const ci = Math.round(t * 255);
    const [r, g, b] = _CMAP[ci];

    const i = y * 4;
    buf[i]   = r;
    buf[i+1] = g;
    buf[i+2] = b;
    buf[i+3] = 255;
  }
  _colCtx.putImageData(_colBuf, 0, 0);

  for (let col = 0; col < px; col++) {
    _ctx.drawImage(_colCtx.canvas, W - px + col, 0);
  }
}

/* ── Colour map ──────────────────────────────────────────────────────────── */
/**
 * Plasma-like colour map (Spectroid uses a similar one).
 * 0 = cold (dark blue/teal), 255 = hot (yellow/white).
 */
function buildColourMap() {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Plasma-style: dark blue → purple → magenta → orange → yellow
    let r, g, b;
    if (t < 0.25) {
      const s = t / 0.25;
      r = Math.round(13  + s * (87  - 13));
      g = Math.round(8   + s * (15  - 8));
      b = Math.round(135 + s * (166 - 135));
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      r = Math.round(87  + s * (190 - 87));
      g = Math.round(15  + s * (55  - 15));
      b = Math.round(166 + s * (111 - 166));
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      r = Math.round(190 + s * (253 - 190));
      g = Math.round(55  + s * (155 - 55));
      b = Math.round(111 + s * (37  - 111));
    } else {
      const s = (t - 0.75) / 0.25;
      r = Math.round(253 + s * (240 - 253));
      g = Math.round(155 + s * (249 - 155));
      b = Math.round(37  + s * (33  - 37));
    }
    lut[i] = [
      Math.max(0, Math.min(255, r)),
      Math.max(0, Math.min(255, g)),
      Math.max(0, Math.min(255, b))
    ];
  }
  return lut;
}

/* ── Colour scale bar ────────────────────────────────────────────────────── */
function drawColourScale() {
  if (!_scaleCanvas) return;
  const H = _scaleCanvas.height;
  const id = _scaleCtx.createImageData(1, H);
  for (let y = 0; y < H; y++) {
    const t  = 1 - y / (H - 1);   // top=hot, bottom=cold
    const ci = Math.round(t * 255);
    const [r, g, b] = _CMAP[ci];
    const i = y * 4;
    id.data[i]   = r;
    id.data[i+1] = g;
    id.data[i+2] = b;
    id.data[i+3] = 255;
  }
  _scaleCtx.putImageData(id, 0, 0);
  // Scale canvas is 20px wide — stretch the 1px column
  const tmp = document.createElement('canvas');
  tmp.width  = 1;
  tmp.height = H;
  tmp.getContext('2d').putImageData(id, 0, 0);
  _scaleCtx.clearRect(0, 0, 20, H);
  _scaleCtx.drawImage(tmp, 0, 0, 20, H);
}

function updateScaleLabels() {
  const top = document.getElementById('spec-scale-top');
  const bot = document.getElementById('spec-scale-bot');
  if (top) top.textContent = _dbCeil  + ' dB';
  if (bot) bot.textContent = _dbFloor + ' dB';
}

/* ── Frequency axis ticks ────────────────────────────────────────────────── */
function buildFreqAxis() {
  const container = document.getElementById('spec-freq-axis');
  if (!container) return;
  container.innerHTML = '';

  const sampleRate = _audioCtx ? _audioCtx.sampleRate : 48000;
  const nyquist    = sampleRate / 2;
  const H          = _canvas ? _canvas.height : container.clientHeight;
  if (H === 0) return;

  // Frequency ticks to show
  const ticks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000];
  for (const freq of ticks) {
    if (freq > nyquist) continue;
    // Position: bottom = 0 Hz, top = Nyquist
    // canvas y=0 is top (Nyquist), canvas y=H is bottom (0 Hz)
    const frac = freq / nyquist;              // 0 = DC, 1 = Nyquist
    const yPx  = H * (1 - frac);             // flip: high freq at top

    const span = document.createElement('span');
    span.className = 'freq-tick';
    span.textContent = freq >= 1000 ? (freq / 1000) + 'k' : freq;
    span.style.bottom = (H - yPx - 1) + 'px';
    span.style.top    = 'auto';
    // Use bottom positioning for clarity
    span.style.bottom = '';
    span.style.top    = (yPx - 8) + 'px';
    container.appendChild(span);
  }
}

/* ── Time axis ticks ─────────────────────────────────────────────────────── */
function buildTimeAxis() {
  const container = document.getElementById('spec-time-axis');
  if (!container) return;
  container.innerHTML = '';

  // Time axis: right edge = now (0 s), left edge = oldest
  // We don't track absolute time — label relative seconds
  const W          = _canvas ? _canvas.width : container.clientWidth;
  const frameRate  = 60;  // approx
  const secsPerPx  = _pixelsPerFrame / frameRate;
  const totalSecs  = W * secsPerPx;

  const step = pickTimeStep(totalSecs);
  for (let t = 0; t <= totalSecs; t += step) {
    const xFrac = 1 - t / totalSecs;
    const xPx   = xFrac * W;
    const span  = document.createElement('span');
    span.className   = 'time-tick';
    span.style.left  = xPx + 'px';
    span.textContent = '-' + (t < 1 ? t.toFixed(1) : Math.round(t)) + 's';
    container.appendChild(span);
  }
}

function pickTimeStep(totalSecs) {
  const targets = [0.5, 1, 2, 5, 10, 20, 30, 60];
  for (const s of targets) {
    if (totalSecs / s < 12) return s;
  }
  return 60;
}

/* ── Crosshair readout ───────────────────────────────────────────────────── */
function onCanvasMouseMove(e) {
  const readout = document.getElementById('spec-readout');
  if (!readout || !_canvas) return;

  const rect = _canvas.getBoundingClientRect();
  const yPx  = e.clientY - rect.top;
  const H    = _canvas.height;

  if (H === 0) return;

  const sampleRate = _audioCtx ? _audioCtx.sampleRate : 48000;
  const nyquist    = sampleRate / 2;

  // y=0 → Nyquist, y=H → 0 Hz
  const freq = nyquist * (1 - yPx / H);
  const label = freq >= 1000
    ? (freq / 1000).toFixed(2) + ' kHz'
    : Math.round(freq) + ' Hz';

  readout.textContent = label;
  readout.style.display = 'block';
  readout.style.top     = (yPx - 20) + 'px';
  readout.style.left    = '8px';
}

/* ── Utility ─────────────────────────────────────────────────────────────── */
function setStatus(msg) {
  const el = document.getElementById('spec-status');
  if (el) el.textContent = msg;
}

/* Expose so main.py can hide the loading overlay once PyScript boots */
window.hideSpectrogramLoading = function() {
  const ov = document.getElementById('loading');
  if (ov) ov.style.display = 'none';
};
