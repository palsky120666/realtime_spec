/**
 * spectrogram.js — ObieWebApp 2
 *
 * Real-time scrolling spectrogram (right channel) + binaural TVL loudness
 * display (Moore, Glasberg, Varathanathan & Schlittenlacher, 2016).
 *
 * All button wiring via addEventListener — no onclick= in HTML.
 */
'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════════════════ */
let _audioCtx     = null;
let _analyserL    = null;   // left channel  → loudness model
let _analyserR    = null;   // right channel → spectrogram + loudness model
let _sourceNode   = null;
let _splitter     = null;
let _scriptNode   = null;
let _stream       = null;
let _rafId        = null;
let _running      = false;
let _playbackSrc  = null;

let _fftSize        = 2048;
let _dbFloor        = -100;
let _dbCeil         = 0;
let _pixelsPerFrame = 2;
let _logScale       = true;
let _freqMin        = 20;
let _freqMax        = 20000;

const RING_SECS     = 10;
let _ringBuffer     = null;
let _ringWritePos   = 0;
let _ringFrames     = 0;
let _ringMaxFrames  = 0;

let _bands = [
  { name: 'A0', freq: 27.5,  color: '#ff6b6b' },
  { name: 'C4', freq: 261.6, color: '#ffd93d' },
  { name: 'A4', freq: 440,   color: '#6bcb77' },
  { name: 'C8', freq: 4186,  color: '#4d96ff' },
];

// Canvas
let _canvas = null, _ctx = null;
let _scaleCanvas = null, _scaleCtx = null;
let _colCtx = null, _colBuf = null;

// Loudness gauge canvas
let _gaugeCanvas = null, _gCtx = null;

// Loudness history for the mini-graph (last N frames)
const LOUD_HISTORY = 400;
const _stHistory   = new Float32Array(LOUD_HISTORY);   // short-term sones
const _ltHistory   = new Float32Array(LOUD_HISTORY);   // long-term  sones
let   _loudHistIdx = 0;

const _CMAP = buildColourMap();

/* ════════════════════════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const ov = document.getElementById('loading');
  if (ov) ov.style.display = 'none';

  _canvas      = document.getElementById('spec-canvas');
  _ctx         = _canvas.getContext('2d', { willReadFrequently: true });
  _scaleCanvas = document.getElementById('spec-scale');
  _scaleCtx    = _scaleCanvas.getContext('2d');
  _gaugeCanvas = document.getElementById('loud-canvas');
  _gCtx        = _gaugeCanvas ? _gaugeCanvas.getContext('2d') : null;

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    buildFreqAxis();
    buildTimeAxis();
    if (_gaugeCanvas) resizeGauge();
  });

  _canvas.addEventListener('mousemove', onMouseMove);
  _canvas.addEventListener('mouseleave', () => {
    const r = document.getElementById('spec-readout');
    if (r) r.style.display = 'none';
  });

  // Button wiring
  bind('spec-start-btn',   () => startSpectrogram());
  bind('spec-stop-btn',    () => stopSpectrogram());
  bind('spec-play-btn',    () => playback());
  bind('spec-log-btn',     () => toggleLog());
  bind('spec-apply-btn',   () => applyFreqRange());
  bind('spec-bands-btn',   () => openModal());
  bind('spec-modal-close', () => closeModal());
  bind('band-add-btn',     () => addBand());

  const modalBg = document.getElementById('spec-modal');
  if (modalBg) modalBg.addEventListener('click', e => { if (e.target === modalBg) closeModal(); });

  bindChange('spec-fft-size', v => {
    _fftSize = parseInt(v, 10);
    if (_analyserL) { _analyserL.fftSize = _fftSize; }
    if (_analyserR) { _analyserR.fftSize = _fftSize; buildFreqAxis(); }
  });
  bindChange('spec-floor', v => {
    _dbFloor = parseFloat(v);
    drawColourScale(); updateScaleLabels();
  });
  bindChange('spec-speed', v => {
    _pixelsPerFrame = parseInt(v, 10);
    buildTimeAxis();
  });

  drawColourScale();
  updateScaleLabels();
  buildFreqAxis();
  buildTimeAxis();
  renderBandList();
  syncFreqInputs();
  if (_gaugeCanvas) { resizeGauge(); drawGaugeIdle(); }

  console.log('Spectrogram + Loudness ready');
});

/* ════════════════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════════════════ */
function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
  else console.warn('bind: missing element —', id);
}
function bindChange(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => fn(el.value));
}

/* ════════════════════════════════════════════════════════════════════════════
   CANVAS RESIZE
════════════════════════════════════════════════════════════════════════════ */
function resizeCanvas() {
  if (!_canvas) return;
  const W = _canvas.parentElement.clientWidth;
  const H = _canvas.parentElement.clientHeight;
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
function resizeGauge() {
  if (!_gaugeCanvas) return;
  _gaugeCanvas.width  = _gaugeCanvas.parentElement.clientWidth  || 300;
  _gaugeCanvas.height = _gaugeCanvas.parentElement.clientHeight || 80;
}

/* ════════════════════════════════════════════════════════════════════════════
   TRANSPORT
════════════════════════════════════════════════════════════════════════════ */
async function startSpectrogram() {
  if (_running) return;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 2, echoCancellation: false,
               noiseSuppression: false, autoGainControl: false },
      video: false
    });

    const sr  = _stream.getAudioTracks()[0].getSettings().sampleRate || 48000;
    _audioCtx = new AudioContext({ sampleRate: sr });

    // Two analysers — left and right channels
    const makeAnalyser = () => {
      const a = _audioCtx.createAnalyser();
      a.fftSize               = _fftSize;
      a.smoothingTimeConstant = 0;
      a.minDecibels           = -140;
      a.maxDecibels           = 0;
      return a;
    };
    _analyserL = makeAnalyser();
    _analyserR = makeAnalyser();

    _sourceNode = _audioCtx.createMediaStreamSource(_stream);
    _splitter   = _audioCtx.createChannelSplitter(2);
    _sourceNode.connect(_splitter);
    _splitter.connect(_analyserL, 0, 0);   // left  → loudness
    _splitter.connect(_analyserR, 1, 0);   // right → spectrogram + loudness

    // Ring buffer (stereo, 10 s)
    _ringMaxFrames = Math.ceil(sr * RING_SECS);
    _ringBuffer    = new Float32Array(_ringMaxFrames * 2);
    _ringWritePos  = 0;
    _ringFrames    = 0;

    _scriptNode = _audioCtx.createScriptProcessor(4096, 2, 2);
    _scriptNode.onaudioprocess = onAudioProcess;
    _sourceNode.connect(_scriptNode);
    _scriptNode.connect(_audioCtx.destination);

    _freqMax = Math.min(_freqMax, sr / 2);
    syncFreqInputs();

    if (typeof resetLoudnessModel === 'function') resetLoudnessModel();
    _stHistory.fill(0); _ltHistory.fill(0); _loudHistIdx = 0;

    _running = true;
    setElDisabled('spec-start-btn', true);
    setElDisabled('spec-stop-btn',  false);
    setElDisabled('spec-play-btn',  false);
    setStatus('Running — L+R  |  ' + (sr/1000).toFixed(0) + ' kHz  |  FFT ' + _fftSize);

    buildFreqAxis(); buildTimeAxis();
    loop();
  } catch (err) {
    setStatus('Mic error: ' + err.message);
    console.error(err);
  }
}

function stopSpectrogram() {
  if (!_running) return;
  _running = false;
  if (_rafId)     { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_stream)    { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_audioCtx)  { _audioCtx.close(); _audioCtx = null; }
  _analyserL = _analyserR = _sourceNode = _splitter = _scriptNode = null;
  setElDisabled('spec-start-btn', false);
  setElDisabled('spec-stop-btn',  true);
  setStatus('Stopped');
  if (_gCtx) drawGaugeIdle();
}

function playback() {
  if (!_audioCtx || !_ringBuffer || _ringFrames === 0) {
    setStatus('No audio buffered yet — start first'); return;
  }
  if (_playbackSrc) { try { _playbackSrc.stop(); } catch(e){} _playbackSrc = null; }

  const sr     = _audioCtx.sampleRate;
  const frames = Math.min(_ringFrames, _ringMaxFrames);
  const abuf   = _audioCtx.createBuffer(2, frames, sr);
  const ch0    = abuf.getChannelData(0);
  const ch1    = abuf.getChannelData(1);
  const startF = _ringFrames >= _ringMaxFrames ? (_ringWritePos / 2) % _ringMaxFrames : 0;

  for (let f = 0; f < frames; f++) {
    const ri = ((startF + f) % _ringMaxFrames) * 2;
    ch0[f] = _ringBuffer[ri];
    ch1[f] = _ringBuffer[ri + 1];
  }

  _playbackSrc = _audioCtx.createBufferSource();
  _playbackSrc.buffer = abuf;
  _playbackSrc.connect(_audioCtx.destination);
  _playbackSrc.start();
  _playbackSrc.onended = () => { _playbackSrc = null; setStatus('Playback done'); };
  setStatus('Playing last ' + Math.min(_ringFrames / sr, RING_SECS).toFixed(1) + ' s…');
}

/* ════════════════════════════════════════════════════════════════════════════
   CONTROLS
════════════════════════════════════════════════════════════════════════════ */
function toggleLog() {
  _logScale = !_logScale;
  const btn = document.getElementById('spec-log-btn');
  if (btn) { btn.textContent = _logScale ? 'Log' : 'Lin'; btn.classList.toggle('tb-active', _logScale); }
  buildFreqAxis();
}

function applyFreqRange() {
  const nyq    = _audioCtx ? _audioCtx.sampleRate / 2 : 24000;
  const rawMin = parseFloat(document.getElementById('spec-freq-min').value) || 20;
  const rawMax = parseFloat(document.getElementById('spec-freq-max').value) || 20000;
  _freqMin = Math.max(1,           Math.min(rawMin, nyq - 1));
  _freqMax = Math.max(_freqMin+1,  Math.min(rawMax, nyq));
  syncFreqInputs(); buildFreqAxis();
  setStatus('Freq range: ' + fmtHz(_freqMin) + ' – ' + fmtHz(_freqMax));
}

function openModal()  { const m = document.getElementById('spec-modal'); if (m) m.style.display = 'flex'; }
function closeModal() { const m = document.getElementById('spec-modal'); if (m) m.style.display = 'none'; }

/* ════════════════════════════════════════════════════════════════════════════
   BANDS
════════════════════════════════════════════════════════════════════════════ */
function addBand() {
  const nameEl  = document.getElementById('band-name');
  const freqEl  = document.getElementById('band-freq');
  const colorEl = document.getElementById('band-color');
  const freq    = parseFloat(freqEl ? freqEl.value : '');
  if (!freq || freq <= 0) { setStatus('Enter a valid frequency'); return; }
  const name  = (nameEl && nameEl.value.trim()) || ('Band ' + (_bands.length + 1));
  const color = (colorEl && colorEl.value) || '#ffffff';
  _bands.push({ name, freq, color });
  if (nameEl) nameEl.value = '';
  if (freqEl) freqEl.value = '';
  renderBandList();
}
function removeBand(idx) { _bands.splice(idx, 1); renderBandList(); }
window.removeBand = removeBand;

function renderBandList() {
  const list = document.getElementById('band-list');
  if (!list) return;
  if (_bands.length === 0) { list.innerHTML = '<div class="band-empty">No bands — add one above</div>'; return; }
  list.innerHTML = '';
  _bands.forEach((b, i) => {
    const fLabel = b.freq >= 1000
      ? (b.freq/1000).toFixed(3).replace(/\.?0+$/,'') + ' kHz' : b.freq + ' Hz';
    const row = document.createElement('div');
    row.className = 'band-row';
    row.innerHTML =
      `<span class="band-swatch" style="background:${b.color}"></span>` +
      `<span class="band-label">${b.name} — ${fLabel}</span>` +
      `<button class="band-del" onclick="removeBand(${i})">✕</button>`;
    list.appendChild(row);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   RING BUFFER CAPTURE
════════════════════════════════════════════════════════════════════════════ */
function onAudioProcess(e) {
  if (!_running || !_ringBuffer) return;
  const L = e.inputBuffer.getChannelData(0);
  const R = e.inputBuffer.getChannelData(1);
  for (let i = 0; i < L.length; i++) {
    _ringBuffer[_ringWritePos]     = L[i];
    _ringBuffer[_ringWritePos + 1] = R[i];
    _ringWritePos = (_ringWritePos + 2) % (_ringMaxFrames * 2);
    _ringFrames++;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ANIMATION LOOP
════════════════════════════════════════════════════════════════════════════ */
function loop() {
  if (!_running) return;
  _rafId = requestAnimationFrame(loop);
  drawFrame();
  updateLoudness();
}

/* ════════════════════════════════════════════════════════════════════════════
   SPECTROGRAM FRAME
════════════════════════════════════════════════════════════════════════════ */
function drawFrame() {
  if (!_analyserR || !_canvas || _canvas.width === 0) return;

  const binCount = _analyserR.frequencyBinCount;
  const data     = new Float32Array(binCount);
  _analyserR.getFloatFrequencyData(data);

  const nyquist = _audioCtx.sampleRate / 2;
  const W = _canvas.width, H = _canvas.height;
  const px = _pixelsPerFrame;

  _ctx.drawImage(_canvas, -px, 0);

  if (!_colBuf || _colBuf.height !== H) buildColBuf();
  const buf = _colBuf.data;

  for (let y = 0; y < H; y++) {
    const freq   = yToFreq(y, H, nyquist);
    const binIdx = Math.max(0, Math.min(binCount-1, Math.round((freq/nyquist)*(binCount-1))));
    const db = data[binIdx];
    const t  = Math.max(0, Math.min(1, (db - _dbFloor) / (_dbCeil - _dbFloor)));
    const [r, g, b] = _CMAP[Math.round(t * 255)];
    const i = y * 4;
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  }

  _colCtx.putImageData(_colBuf, 0, 0);
  for (let col = 0; col < px; col++) _ctx.drawImage(_colCtx.canvas, W - px + col, 0);
  drawBandLines(H, nyquist);
}

/* ════════════════════════════════════════════════════════════════════════════
   LOUDNESS UPDATE  (calls loudness.js model)
════════════════════════════════════════════════════════════════════════════ */
function updateLoudness() {
  if (!_analyserL || !_analyserR || typeof processBinauralLoudness !== 'function') return;

  const binCount = _analyserL.frequencyBinCount;
  const dataL    = new Float32Array(binCount);
  const dataR    = new Float32Array(binCount);
  _analyserL.getFloatFrequencyData(dataL);
  _analyserR.getFloatFrequencyData(dataR);

  const result = processBinauralLoudness(dataL, dataR, _audioCtx.sampleRate);

  // Store in history ring
  _stHistory[_loudHistIdx] = result.shortTermSones;
  _ltHistory[_loudHistIdx] = result.longTermSones;
  _loudHistIdx = (_loudHistIdx + 1) % LOUD_HISTORY;

  // Update numeric readouts
  const elST_s  = document.getElementById('loud-st-sones');
  const elLT_s  = document.getElementById('loud-lt-sones');
  const elST_p  = document.getElementById('loud-st-phons');
  const elLT_p  = document.getElementById('loud-lt-phons');
  if (elST_s) elST_s.textContent = result.shortTermSones.toFixed(2);
  if (elLT_s) elLT_s.textContent = result.longTermSones.toFixed(2);
  if (elST_p) elST_p.textContent = result.shortTermPhons.toFixed(1);
  if (elLT_p) elLT_p.textContent = result.longTermPhons.toFixed(1);

  // Gauge bar
  const elBar = document.getElementById('loud-bar-st');
  if (elBar) {
    // Map 0–100 phons to 0–100%
    const pct = Math.max(0, Math.min(100, result.shortTermPhons));
    elBar.style.width = pct + '%';
    // Colour: green < 70, amber 70–85, red > 85
    elBar.style.background =
      result.shortTermPhons < 70 ? '#6bcb77' :
      result.shortTermPhons < 85 ? '#ffd93d' : '#ff6b6b';
  }
  const elBarLT = document.getElementById('loud-bar-lt');
  if (elBarLT) {
    const pct = Math.max(0, Math.min(100, result.longTermPhons));
    elBarLT.style.width = pct + '%';
    elBarLT.style.background = '#4d96ff';
  }

  // Mini graph
  if (_gCtx && _gaugeCanvas.width > 0) drawLoudnessGraph(result.shortTermPhons, result.longTermPhons);
}

/* ════════════════════════════════════════════════════════════════════════════
   LOUDNESS GRAPH  (scrolling line graph on loud-canvas)
════════════════════════════════════════════════════════════════════════════ */
function drawLoudnessGraph(stPhons, ltPhons) {
  const W = _gaugeCanvas.width, H = _gaugeCanvas.height;
  const g = _gCtx;

  g.clearRect(0, 0, W, H);

  // Background
  g.fillStyle = '#0d0d0d';
  g.fillRect(0, 0, W, H);

  // Grid lines at 20, 40, 60, 80 phon
  g.strokeStyle = '#222';
  g.lineWidth   = 1;
  for (const p of [20, 40, 60, 80]) {
    const y = H - (p / 100) * H;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = '#555'; g.font = '9px monospace';
    g.fillText(p + ' ph', 2, y - 2);
  }

  // Draw history — short-term (bright) and long-term (blue)
  const drawHistLine = (history, color) => {
    g.beginPath();
    g.strokeStyle = color;
    g.lineWidth   = 1.5;
    for (let i = 0; i < LOUD_HISTORY; i++) {
      // read in order from oldest to newest
      const idx = (_loudHistIdx + i) % LOUD_HISTORY;
      const s   = history[idx];
      const ph  = s >= 1
        ? 40 + (10 / Math.log10(2)) * Math.log10(s)
        : 40 * Math.pow(s + 0.0005, 0.35);
      const x = (i / (LOUD_HISTORY - 1)) * W;
      const y = H - Math.max(0, Math.min(1, ph / 100)) * H;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  };

  drawHistLine(_ltHistory, '#4d96ff');
  drawHistLine(_stHistory, '#6bcb77');

  // Cursor readout at right edge
  g.fillStyle = '#e0e0e0'; g.font = 'bold 10px monospace';
  g.fillText('ST: ' + stPhons.toFixed(1) + ' ph', W - 85, 14);
  g.fillStyle = '#4d96ff';
  g.fillText('LT: ' + ltPhons.toFixed(1) + ' ph', W - 85, 26);
}

function drawGaugeIdle() {
  if (!_gCtx || !_gaugeCanvas) return;
  const W = _gaugeCanvas.width, H = _gaugeCanvas.height;
  _gCtx.fillStyle = '#0d0d0d';
  _gCtx.fillRect(0, 0, W, H);
  _gCtx.fillStyle = '#555';
  _gCtx.font = '11px monospace';
  _gCtx.textAlign = 'center';
  _gCtx.fillText('Loudness graph — start recording', W/2, H/2);
  _gCtx.textAlign = 'left';
}

/* ════════════════════════════════════════════════════════════════════════════
   BAND OVERLAY
════════════════════════════════════════════════════════════════════════════ */
function drawBandLines(H, nyquist) {
  if (!_ctx || !_canvas || !_bands.length) return;
  const W = _canvas.width;
  _ctx.save();
  _ctx.font = 'bold 10px monospace';
  _ctx.lineWidth = 1;
  _ctx.setLineDash([5, 4]);
  for (const b of _bands) {
    const f = b.freq;
    if (f < _freqMin || f > _freqMax || f > nyquist) continue;
    const y = freqToY(f, H, nyquist);
    if (y < 0 || y > H) continue;
    _ctx.strokeStyle = b.color;
    _ctx.beginPath(); _ctx.moveTo(0, y); _ctx.lineTo(W, y); _ctx.stroke();
    _ctx.fillStyle = b.color;
    _ctx.fillText(b.name, 6, Math.max(12, y - 3));
  }
  _ctx.restore();
}

/* ════════════════════════════════════════════════════════════════════════════
   FREQ ↔ Y
════════════════════════════════════════════════════════════════════════════ */
function yToFreq(y, H, nyquist) {
  const fMin = Math.max(1, _freqMin), fMax = Math.min(nyquist, _freqMax);
  const t = 1 - y / (H - 1);
  return _logScale ? fMin * Math.pow(fMax/fMin, t) : fMin + t*(fMax-fMin);
}
function freqToY(freq, H, nyquist) {
  const fMin = Math.max(1, _freqMin), fMax = Math.min(nyquist, _freqMax);
  const t = _logScale
    ? Math.log(freq/fMin) / Math.log(fMax/fMin)
    : (freq-fMin)/(fMax-fMin);
  return Math.round((1-t)*(H-1));
}

/* ════════════════════════════════════════════════════════════════════════════
   COLOUR MAP  (plasma)
════════════════════════════════════════════════════════════════════════════ */
function buildColourMap() {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i/255;
    let r,g,b;
    if (t < 0.25)      { const s=t/0.25;         r=lerp(13,87,s);  g=lerp(8,15,s);   b=lerp(135,166,s); }
    else if (t < 0.5)  { const s=(t-0.25)/0.25;  r=lerp(87,190,s); g=lerp(15,55,s);  b=lerp(166,111,s); }
    else if (t < 0.75) { const s=(t-0.5)/0.25;   r=lerp(190,253,s);g=lerp(55,155,s); b=lerp(111,37,s);  }
    else               { const s=(t-0.75)/0.25;  r=lerp(253,240,s);g=lerp(155,249,s);b=lerp(37,33,s);   }
    lut[i] = [clamp(r), clamp(g), clamp(b)];
  }
  return lut;
}
function lerp(a,b,t) { return Math.round(a+(b-a)*t); }
function clamp(v)    { return Math.max(0,Math.min(255,v)); }

/* ════════════════════════════════════════════════════════════════════════════
   COLOUR SCALE
════════════════════════════════════════════════════════════════════════════ */
function drawColourScale() {
  if (!_scaleCanvas) return;
  const H  = _scaleCanvas.height;
  const id = _scaleCtx.createImageData(1, H);
  for (let y = 0; y < H; y++) {
    const t = 1 - y/(H-1);
    const [r,g,b] = _CMAP[Math.round(t*255)];
    const i = y*4;
    id.data[i]=r; id.data[i+1]=g; id.data[i+2]=b; id.data[i+3]=255;
  }
  const tmp = document.createElement('canvas');
  tmp.width=1; tmp.height=H;
  tmp.getContext('2d').putImageData(id,0,0);
  _scaleCtx.clearRect(0,0,20,H);
  _scaleCtx.drawImage(tmp,0,0,20,H);
}
function updateScaleLabels() {
  const t=document.getElementById('spec-scale-top'), b=document.getElementById('spec-scale-bot');
  if(t) t.textContent=_dbCeil+' dB';
  if(b) b.textContent=_dbFloor+' dB';
}

/* ════════════════════════════════════════════════════════════════════════════
   AXES
════════════════════════════════════════════════════════════════════════════ */
function buildFreqAxis() {
  const el = document.getElementById('spec-freq-axis');
  if (!el) return;
  el.innerHTML = '';
  const nyquist = _audioCtx ? _audioCtx.sampleRate/2 : 24000;
  const H = _canvas ? _canvas.height : el.clientHeight;
  if (H===0) return;
  for (const f of [20,30,50,100,200,300,500,1000,2000,3000,5000,10000,15000,20000]) {
    if (f < _freqMin || f > _freqMax || f > nyquist) continue;
    const y = freqToY(f, H, nyquist);
    if (y<0||y>H) continue;
    const span = document.createElement('span');
    span.className='freq-tick'; span.textContent=f>=1000?(f/1000)+'k':f; span.style.top=(y-8)+'px';
    el.appendChild(span);
  }
}
function buildTimeAxis() {
  const el = document.getElementById('spec-time-axis');
  if (!el) return;
  el.innerHTML='';
  const W = _canvas ? _canvas.width : el.clientWidth;
  const total = W*(_pixelsPerFrame/60);
  const step = pickStep(total);
  for (let t=0; t<=total; t+=step) {
    const span=document.createElement('span');
    span.className='time-tick'; span.style.left=((1-t/total)*W)+'px';
    span.textContent='-'+(t<1?t.toFixed(1):Math.round(t))+'s';
    el.appendChild(span);
  }
}
function pickStep(s) { for(const n of [0.5,1,2,5,10,20,30,60]){if(s/n<12)return n;} return 60; }

/* ════════════════════════════════════════════════════════════════════════════
   MOUSE
════════════════════════════════════════════════════════════════════════════ */
function onMouseMove(e) {
  const r=document.getElementById('spec-readout');
  if(!r||!_canvas) return;
  const rect=_canvas.getBoundingClientRect(), yPx=e.clientY-rect.top;
  const nyquist=_audioCtx?_audioCtx.sampleRate/2:24000;
  r.textContent=fmtHz(yToFreq(yPx,_canvas.height,nyquist));
  r.style.display='block'; r.style.top=Math.max(0,yPx-20)+'px'; r.style.left='8px';
}

/* ════════════════════════════════════════════════════════════════════════════
   UTILS
════════════════════════════════════════════════════════════════════════════ */
function setStatus(msg) { const el=document.getElementById('spec-status'); if(el) el.textContent=msg; }
function setElDisabled(id,v) { const el=document.getElementById(id); if(el) el.disabled=v; }
function syncFreqInputs() {
  const mn=document.getElementById('spec-freq-min'), mx=document.getElementById('spec-freq-max');
  if(mn) mn.value=_freqMin; if(mx) mx.value=_freqMax;
}
function fmtHz(f) { return f>=1000?(f/1000).toFixed(2)+' kHz':Math.round(f)+' Hz'; }
