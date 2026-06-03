/**
 * spectrogram.js — ObieWebApp 2
 * Real-time scrolling spectrogram, right channel only.
 *
 * Features:
 *   • Plasma colour map, scrolling canvas
 *   • Log / linear Y-axis toggle
 *   • User-defined freq min/max limits
 *   • Custom named frequency band overlays
 *   • 10-second audio ring-buffer + playback
 */
'use strict';

/* ── State ───────────────────────────────────────────────────────────────── */
let _audioCtx  = null, _analyser = null, _sourceNode = null;
let _splitter  = null, _scriptNode = null, _stream = null;
let _rafId     = null, _running = false;

let _fftSize        = 2048;
let _dbFloor        = -100;
let _dbCeil         = 0;
let _pixelsPerFrame = 2;
let _logScale       = true;
let _freqMin        = 20;
let _freqMax        = 20000;

// Frequency band overlays  [{name, freq, color}]
let _bands = [
  { name:'A0',  freq:27.5,  color:'#ff6b6b' },
  { name:'C4',  freq:261.6, color:'#ffd93d' },
  { name:'A4',  freq:440,   color:'#6bcb77' },
  { name:'C8',  freq:4186,  color:'#4d96ff' },
];

// Ring buffer — 10 s stereo interleaved float32
const RING_SECS   = 10;
let _ringBuffer   = null;   // Float32Array
let _ringWritePos = 0;      // index into interleaved array
let _ringFrames   = 0;      // total frames written (not capped)
let _ringMaxFrames = 0;     // capacity in frames

let _playbackSrc = null;

// Canvas
let _canvas = null, _ctx = null;
let _scaleCanvas = null, _scaleCtx = null;
let _colCtx = null, _colBuf = null;

const _CMAP = buildColourMap();

/* ═══════════════════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Hide loading overlay immediately — no PyScript needed
  const ov = document.getElementById('loading');
  if (ov) ov.style.display = 'none';

  _canvas      = document.getElementById('spec-canvas');
  _ctx         = _canvas.getContext('2d', { willReadFrequently: true });
  _scaleCanvas = document.getElementById('spec-scale');
  _scaleCtx    = _scaleCanvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', () => { resizeCanvas(); buildFreqAxis(); buildTimeAxis(); });

  _canvas.addEventListener('mousemove', onMouseMove);
  _canvas.addEventListener('mouseleave', () => {
    document.getElementById('spec-readout').style.display = 'none';
  });

  drawColourScale();
  updateScaleLabels();
  buildFreqAxis();
  buildTimeAxis();
  renderBandList();
  syncFreqInputs();
});

/* ═══════════════════════════════════════════════════════════════════════════
   CANVAS HELPERS
═══════════════════════════════════════════════════════════════════════════ */
function resizeCanvas() {
  if (!_canvas) return;
  const wrap = _canvas.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (_canvas.width === W && _canvas.height === H) return;
  if (_canvas.width > 0 && _canvas.height > 0) {
    const tmp = document.createElement('canvas');
    tmp.width = _canvas.width; tmp.height = _canvas.height;
    tmp.getContext('2d').drawImage(_canvas, 0, 0);
    _canvas.width = W; _canvas.height = H;
    _ctx.drawImage(tmp, 0, 0);
  } else {
    _canvas.width = W; _canvas.height = H;
  }
  buildColBuf();
}

function buildColBuf() {
  const H = _canvas.height || 1;
  const oc = document.createElement('canvas');
  oc.width = 1; oc.height = H;
  _colCtx = oc.getContext('2d');
  _colBuf = _colCtx.createImageData(1, H);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PUBLIC API  (onclick targets)
═══════════════════════════════════════════════════════════════════════════ */

window.spectrogramStart = async function () {
  if (_running) return;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount:2, echoCancellation:false,
               noiseSuppression:false, autoGainControl:false },
      video: false
    });

    const sr = _stream.getAudioTracks()[0].getSettings().sampleRate || 48000;
    _audioCtx = new AudioContext({ sampleRate: sr });

    // Analyser
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = _fftSize;
    _analyser.smoothingTimeConstant = 0.0;
    _analyser.minDecibels = -140;
    _analyser.maxDecibels = 0;

    _sourceNode = _audioCtx.createMediaStreamSource(_stream);
    _splitter   = _audioCtx.createChannelSplitter(2);
    _sourceNode.connect(_splitter);
    _splitter.connect(_analyser, 1, 0);   // right channel → analyser

    // Ring buffer
    _ringMaxFrames = Math.ceil(sr * RING_SECS);
    _ringBuffer    = new Float32Array(_ringMaxFrames * 2);
    _ringWritePos  = 0;
    _ringFrames    = 0;

    // ScriptProcessor for capture (deprecated but universally supported)
    _scriptNode = _audioCtx.createScriptProcessor(4096, 2, 2);
    _scriptNode.onaudioprocess = onAudioProcess;
    _sourceNode.connect(_scriptNode);
    _scriptNode.connect(_audioCtx.destination);

    // Clamp freqMax to Nyquist
    _freqMax = Math.min(_freqMax, sr / 2);
    syncFreqInputs();

    _running = true;
    setStatus('Running — right ch  |  ' + (sr/1000).toFixed(0) + ' kHz  |  FFT ' + _fftSize);
    document.getElementById('spec-start-btn').disabled = true;
    document.getElementById('spec-stop-btn').disabled  = false;
    document.getElementById('spec-play-btn').disabled  = false;

    buildFreqAxis();
    buildTimeAxis();
    loop();
  } catch (err) {
    setStatus('Mic error: ' + err.message);
    console.error(err);
  }
};

window.spectrogramStop = function () {
  if (!_running) return;
  _running = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_stream)     { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_audioCtx)   { _audioCtx.close(); _audioCtx = null; }
  _analyser = _sourceNode = _splitter = _scriptNode = null;
  document.getElementById('spec-start-btn').disabled = false;
  document.getElementById('spec-stop-btn').disabled  = true;
  setStatus('Stopped');
};

window.spectrogramSetFFT = function (val) {
  _fftSize = parseInt(val, 10);
  if (_analyser) { _analyser.fftSize = _fftSize; buildFreqAxis(); }
};

window.spectrogramSetFloor = function (val) {
  _dbFloor = parseFloat(val);
  drawColourScale(); updateScaleLabels();
};

window.spectrogramSetSpeed = function (val) {
  _pixelsPerFrame = parseInt(val, 10);
  buildTimeAxis();
};

window.spectrogramToggleLog = function () {
  _logScale = !_logScale;
  const btn = document.getElementById('spec-log-btn');
  btn.textContent = _logScale ? 'Log' : 'Lin';
  btn.classList.toggle('tb-active', _logScale);
  buildFreqAxis();
};

window.spectrogramApplyFreqRange = function () {
  const nyq = _audioCtx ? _audioCtx.sampleRate / 2 : 24000;
  const rawMin = parseFloat(document.getElementById('spec-freq-min').value) || 20;
  const rawMax = parseFloat(document.getElementById('spec-freq-max').value) || 20000;
  _freqMin = Math.max(1, Math.min(rawMin, nyq - 1));
  _freqMax = Math.max(_freqMin + 1, Math.min(rawMax, nyq));
  syncFreqInputs();
  buildFreqAxis();
};

window.spectrogramPlay = function () {
  if (!_audioCtx || !_ringBuffer || _ringFrames === 0) {
    setStatus('No audio buffered yet — start first');
    return;
  }
  if (_playbackSrc) { try { _playbackSrc.stop(); } catch(e){} _playbackSrc = null; }

  const sr     = _audioCtx.sampleRate;
  const frames = Math.min(_ringFrames, _ringMaxFrames);
  const abuf   = _audioCtx.createBuffer(2, frames, sr);
  const ch0    = abuf.getChannelData(0);
  const ch1    = abuf.getChannelData(1);

  // Read from ring — oldest first
  const startFrame = _ringFrames >= _ringMaxFrames
    ? (_ringWritePos / 2) % _ringMaxFrames   // full ring: start just after write head
    : 0;

  for (let f = 0; f < frames; f++) {
    const ri = ((startFrame + f) % _ringMaxFrames) * 2;
    ch0[f] = _ringBuffer[ri];
    ch1[f] = _ringBuffer[ri + 1];
  }

  _playbackSrc = _audioCtx.createBufferSource();
  _playbackSrc.buffer = abuf;
  _playbackSrc.connect(_audioCtx.destination);
  _playbackSrc.start();
  _playbackSrc.onended = () => { _playbackSrc = null; setStatus('Playback done'); };
  setStatus('Playing last ' + Math.min(_ringFrames / sr, RING_SECS).toFixed(1) + ' s…');
};

/* ── Settings modal ──────────────────────────────────────────────────────── */
window.spectrogramOpenSettings  = () => document.getElementById('spec-modal').style.display = 'flex';
window.spectrogramCloseSettings = () => document.getElementById('spec-modal').style.display = 'none';

/* ── Band management ─────────────────────────────────────────────────────── */
window.spectrogramAddBand = function () {
  const name  = document.getElementById('band-name').value.trim() || ('Band ' + (_bands.length + 1));
  const freq  = parseFloat(document.getElementById('band-freq').value);
  const color = document.getElementById('band-color').value || '#ffffff';
  if (!freq || freq <= 0) return;
  _bands.push({ name, freq, color });
  document.getElementById('band-name').value = '';
  document.getElementById('band-freq').value = '';
  renderBandList();
};

window.spectrogramRemoveBand = function (idx) {
  _bands.splice(idx, 1);
  renderBandList();
};

function renderBandList() {
  const list = document.getElementById('band-list');
  if (!list) return;
  list.innerHTML = '';
  if (_bands.length === 0) {
    list.innerHTML = '<div class="band-empty">No bands defined</div>';
    return;
  }
  _bands.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'band-row';
    const fLabel = b.freq >= 1000 ? (b.freq/1000).toFixed(3).replace(/\.?0+$/, '') + ' kHz' : b.freq + ' Hz';
    row.innerHTML =
      `<span class="band-swatch" style="background:${b.color}"></span>` +
      `<span class="band-label">${b.name} — ${fLabel}</span>` +
      `<button class="band-del" onclick="spectrogramRemoveBand(${i})">✕</button>`;
    list.appendChild(row);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUDIO CAPTURE
═══════════════════════════════════════════════════════════════════════════ */
function onAudioProcess(e) {
  if (!_running || !_ringBuffer) return;
  const L = e.inputBuffer.getChannelData(0);
  const R = e.inputBuffer.getChannelData(1);
  for (let i = 0; i < L.length; i++) {
    const pos = (_ringWritePos) % (_ringMaxFrames * 2);
    _ringBuffer[pos]   = L[i];
    _ringBuffer[pos+1] = R[i];
    _ringWritePos = (pos + 2) % (_ringMaxFrames * 2);
    _ringFrames++;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ANIMATION LOOP
═══════════════════════════════════════════════════════════════════════════ */
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

  const nyquist = _audioCtx.sampleRate / 2;
  const W = _canvas.width, H = _canvas.height;
  const px = _pixelsPerFrame;

  // Scroll left
  _ctx.drawImage(_canvas, -px, 0);

  // Paint new column(s) at right edge
  if (!_colBuf || _colBuf.height !== H) buildColBuf();
  const buf = _colBuf.data;

  for (let y = 0; y < H; y++) {
    const freq   = yToFreq(y, H, nyquist);
    const binIdx = Math.max(0, Math.min(binCount - 1,
                    Math.round((freq / nyquist) * (binCount - 1))));
    const db  = data[binIdx];
    const t   = Math.max(0, Math.min(1, (db - _dbFloor) / (_dbCeil - _dbFloor)));
    const ci  = Math.round(t * 255);
    const [r, g, b] = _CMAP[ci];
    const i = y * 4;
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  }

  _colCtx.putImageData(_colBuf, 0, 0);
  for (let col = 0; col < px; col++) {
    _ctx.drawImage(_colCtx.canvas, W - px + col, 0);
  }

  // Band overlay lines
  drawBandLines(H, nyquist);
}

/* ═══════════════════════════════════════════════════════════════════════════
   FREQ ↔ Y MAPPING
═══════════════════════════════════════════════════════════════════════════ */
// y=0 → _freqMax (top), y=H-1 → _freqMin (bottom)
function yToFreq(y, H, nyquist) {
  const fMin = Math.max(1, _freqMin);
  const fMax = Math.min(nyquist, _freqMax);
  const t = 1 - y / (H - 1);   // 0=bottom(fMin), 1=top(fMax)
  return _logScale
    ? fMin * Math.pow(fMax / fMin, t)
    : fMin + t * (fMax - fMin);
}

function freqToY(freq, H, nyquist) {
  const fMin = Math.max(1, _freqMin);
  const fMax = Math.min(nyquist, _freqMax);
  const t = _logScale
    ? Math.log(freq / fMin) / Math.log(fMax / fMin)
    : (freq - fMin) / (fMax - fMin);
  return Math.round((1 - t) * (H - 1));
}

/* ═══════════════════════════════════════════════════════════════════════════
   BAND OVERLAY
═══════════════════════════════════════════════════════════════════════════ */
function drawBandLines(H, nyquist) {
  if (!_ctx || !_canvas || _bands.length === 0) return;
  const W = _canvas.width;
  _ctx.save();
  _ctx.font = 'bold 10px monospace';
  _ctx.setLineDash([5, 4]);
  _ctx.lineWidth = 1;
  for (const b of _bands) {
    if (b.freq < _freqMin || b.freq > _freqMax || b.freq > nyquist) continue;
    const y = freqToY(b.freq, H, nyquist);
    if (y < 0 || y > H) continue;
    _ctx.strokeStyle = b.color;
    _ctx.beginPath();
    _ctx.moveTo(0, y); _ctx.lineTo(W, y);
    _ctx.stroke();
    _ctx.fillStyle = b.color;
    _ctx.fillText(b.name, 6, Math.max(12, y - 3));
  }
  _ctx.restore();
}

/* ═══════════════════════════════════════════════════════════════════════════
   COLOUR MAP  (plasma)
═══════════════════════════════════════════════════════════════════════════ */
function buildColourMap() {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r, g, b;
    if (t < 0.25) {
      const s = t / 0.25;
      r = Math.round(13  + s*(87 -13));  g = Math.round(8  + s*(15-8));   b = Math.round(135+s*(166-135));
    } else if (t < 0.5) {
      const s = (t-0.25)/0.25;
      r = Math.round(87  + s*(190-87));  g = Math.round(15 + s*(55-15));  b = Math.round(166+s*(111-166));
    } else if (t < 0.75) {
      const s = (t-0.5)/0.25;
      r = Math.round(190 + s*(253-190)); g = Math.round(55 + s*(155-55)); b = Math.round(111+s*(37-111));
    } else {
      const s = (t-0.75)/0.25;
      r = Math.round(253 + s*(240-253)); g = Math.round(155+s*(249-155)); b = Math.round(37 +s*(33-37));
    }
    lut[i] = [clamp(r), clamp(g), clamp(b)];
  }
  return lut;
}
function clamp(v) { return Math.max(0, Math.min(255, v)); }

/* ═══════════════════════════════════════════════════════════════════════════
   COLOUR SCALE BAR
═══════════════════════════════════════════════════════════════════════════ */
function drawColourScale() {
  if (!_scaleCanvas) return;
  const H  = _scaleCanvas.height;
  const id = _scaleCtx.createImageData(1, H);
  for (let y = 0; y < H; y++) {
    const t  = 1 - y / (H - 1);
    const ci = Math.round(t * 255);
    const [r,g,b] = _CMAP[ci];
    const i = y*4;
    id.data[i]=r; id.data[i+1]=g; id.data[i+2]=b; id.data[i+3]=255;
  }
  const tmp = document.createElement('canvas');
  tmp.width=1; tmp.height=H;
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

/* ═══════════════════════════════════════════════════════════════════════════
   AXES
═══════════════════════════════════════════════════════════════════════════ */
function buildFreqAxis() {
  const el = document.getElementById('spec-freq-axis');
  if (!el) return;
  el.innerHTML = '';
  const nyquist = _audioCtx ? _audioCtx.sampleRate / 2 : 24000;
  const H = _canvas ? _canvas.height : el.clientHeight;
  if (H === 0) return;

  const ticks = [20,30,50,100,200,300,500,1000,2000,3000,5000,10000,15000,20000];
  for (const f of ticks) {
    if (f < _freqMin || f > _freqMax || f > nyquist) continue;
    const y = freqToY(f, H, nyquist);
    if (y < 0 || y > H) continue;
    const span = document.createElement('span');
    span.className   = 'freq-tick';
    span.textContent = f >= 1000 ? (f/1000)+'k' : f;
    span.style.top   = (y - 8) + 'px';
    el.appendChild(span);
  }
}

function buildTimeAxis() {
  const el = document.getElementById('spec-time-axis');
  if (!el) return;
  el.innerHTML = '';
  const W = _canvas ? _canvas.width : el.clientWidth;
  const totalSecs = W * (_pixelsPerFrame / 60);
  const step = pickTimeStep(totalSecs);
  for (let t = 0; t <= totalSecs; t += step) {
    const span = document.createElement('span');
    span.className   = 'time-tick';
    span.style.left  = ((1 - t/totalSecs) * W) + 'px';
    span.textContent = '-' + (t < 1 ? t.toFixed(1) : Math.round(t)) + 's';
    el.appendChild(span);
  }
}

function pickTimeStep(s) {
  for (const n of [0.5,1,2,5,10,20,30,60]) { if (s/n < 12) return n; }
  return 60;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOUSE READOUT
═══════════════════════════════════════════════════════════════════════════ */
function onMouseMove(e) {
  const readout = document.getElementById('spec-readout');
  if (!readout || !_canvas) return;
  const rect    = _canvas.getBoundingClientRect();
  const yPx     = e.clientY - rect.top;
  const nyquist = _audioCtx ? _audioCtx.sampleRate / 2 : 24000;
  const freq    = yToFreq(yPx, _canvas.height, nyquist);
  readout.textContent = freq >= 1000
    ? (freq/1000).toFixed(2)+' kHz'
    : Math.round(freq)+' Hz';
  readout.style.display = 'block';
  readout.style.top  = Math.max(0, yPx - 20) + 'px';
  readout.style.left = '8px';
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════════════════════════ */
function setStatus(msg) {
  const el = document.getElementById('spec-status');
  if (el) el.textContent = msg;
}

function syncFreqInputs() {
  const mn = document.getElementById('spec-freq-min');
  const mx = document.getElementById('spec-freq-max');
  if (mn) mn.value = _freqMin;
  if (mx) mx.value = _freqMax;
}
