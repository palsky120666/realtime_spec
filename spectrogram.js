/**
 * spectrogram.js — ObieWebApp 2
 * Right-channel real-time spectrogram + binaural TVL loudness overlay.
 * All buttons wired via addEventListener — no onclick= in HTML.
 */
'use strict';

/* ════════════════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════════════ */
let _audioCtx    = null;
let _analyserL   = null;
let _analyserR   = null;
let _sourceNode  = null;
let _splitter    = null;
let _scriptNode  = null;
let _stream      = null;
let _rafId       = null;
let _running     = false;
let _playbackSrc = null;

let _fftSize        = 2048;
let _dbFloor        = -100;
let _dbCeil         = 0;
let _pixelsPerFrame = 2;
let _logScale       = true;
let _freqMin        = 20;
let _freqMax        = 20000;

const RING_SECS    = 10;
let _ringBuffer    = null;
let _ringWritePos  = 0;
let _ringFrames    = 0;
let _ringMaxFrames = 0;

let _bands = [
  { name:'A0', freq:27.5,  color:'#ff6b6b' },
  { name:'C4', freq:261.6, color:'#ffd93d' },
  { name:'A4', freq:440,   color:'#6bcb77' },
  { name:'C8', freq:4186,  color:'#4d96ff' },
];

// Canvases
let _canvas = null, _ctx = null;
let _scaleCanvas = null, _scaleCtx = null;
let _colCtx = null, _colBuf = null;
let _graphCanvas = null, _gCtx = null;  // small graph inside the HTML loudness panel

// Loudness history ring (for the mini graph)
const HIST_LEN  = 300;
const _stHist   = new Float32Array(HIST_LEN);
const _ltHist   = new Float32Array(HIST_LEN);
let   _histIdx  = 0;

const _CMAP = buildColourMap();

/* ════════════════════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Hide loading overlay immediately
  const ov = document.getElementById('loading');
  if (ov) ov.style.display = 'none';

  _canvas      = document.getElementById('spec-canvas');
  _ctx         = _canvas.getContext('2d', { willReadFrequently: true });
  _scaleCanvas = document.getElementById('spec-scale');
  _scaleCtx    = _scaleCanvas.getContext('2d');
  _graphCanvas = document.getElementById('loud-graph');
  _gCtx        = _graphCanvas ? _graphCanvas.getContext('2d') : null;

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    buildFreqAxis();
    buildTimeAxis();
  });

  _canvas.addEventListener('mousemove', onMouseMove);
  _canvas.addEventListener('mouseleave', () => {
    const r = document.getElementById('spec-readout');
    if (r) r.style.display = 'none';
  });

  // Button wiring
  bind('spec-start-btn',   startSpectrogram);
  bind('spec-stop-btn',    stopSpectrogram);
  bind('spec-play-btn',    playback);
  bind('spec-log-btn',     toggleLog);
  bind('spec-apply-btn',   applyFreqRange);
  bind('spec-bands-btn',   openModal);
  bind('spec-modal-close', closeModal);
  bind('spec-modal-close2',closeModal);
  bind('band-add-btn',     addBand);

  const modalBg = document.getElementById('spec-modal');
  if (modalBg) modalBg.addEventListener('click', e => { if (e.target===modalBg) closeModal(); });

  bindChange('spec-fft-size', v => {
    _fftSize = parseInt(v,10);
    if (_analyserL) _analyserL.fftSize = _fftSize;
    if (_analyserR) { _analyserR.fftSize = _fftSize; buildFreqAxis(); }
  });
  bindChange('spec-floor', v => { _dbFloor=parseFloat(v); drawColourScale(); updateScaleLabels(); });
  bindChange('spec-speed', v => { _pixelsPerFrame=parseInt(v,10); buildTimeAxis(); });

  drawColourScale();
  updateScaleLabels();
  buildFreqAxis();
  buildTimeAxis();
  renderBandList();
  syncFreqInputs();
});

/* ════════════════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════════════ */
function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
  else console.warn('bind: missing —', id);
}
function bindChange(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => fn(el.value));
}

/* ════════════════════════════════════════════════════════════════════════
   CANVAS RESIZE
════════════════════════════════════════════════════════════════════════ */
function resizeCanvas() {
  if (!_canvas) return;
  const wrap = _canvas.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (_canvas.width===W && _canvas.height===H) return;
  if (_canvas.width>0 && _canvas.height>0) {
    const tmp = document.createElement('canvas');
    tmp.width=_canvas.width; tmp.height=_canvas.height;
    tmp.getContext('2d').drawImage(_canvas,0,0);
    _canvas.width=W; _canvas.height=H;
    _ctx.drawImage(tmp,0,0);
  } else { _canvas.width=W; _canvas.height=H; }
  buildColBuf();
}
function buildColBuf() {
  const H = _canvas.height||1;
  const oc = document.createElement('canvas');
  oc.width=1; oc.height=H;
  _colCtx=oc.getContext('2d');
  _colBuf=_colCtx.createImageData(1,H);
}

/* ════════════════════════════════════════════════════════════════════════
   TRANSPORT
════════════════════════════════════════════════════════════════════════ */
async function startSpectrogram() {
  if (_running) return;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio:{ channelCount:2, echoCancellation:false,
              noiseSuppression:false, autoGainControl:false },
      video:false
    });

    const sr = _stream.getAudioTracks()[0].getSettings().sampleRate || 48000;
    _audioCtx = new AudioContext({ sampleRate:sr });

    const makeAn = () => {
      const a = _audioCtx.createAnalyser();
      a.fftSize=_fftSize; a.smoothingTimeConstant=0;
      a.minDecibels=-140; a.maxDecibels=0;
      return a;
    };
    _analyserL = makeAn();
    _analyserR = makeAn();

    _sourceNode = _audioCtx.createMediaStreamSource(_stream);
    _splitter   = _audioCtx.createChannelSplitter(2);
    _sourceNode.connect(_splitter);
    _splitter.connect(_analyserL, 0, 0);   // left  → loudness
    _splitter.connect(_analyserR, 1, 0);   // right → spectrogram + loudness

    // Ring buffer
    _ringMaxFrames = Math.ceil(sr*RING_SECS);
    _ringBuffer    = new Float32Array(_ringMaxFrames*2);
    _ringWritePos  = 0; _ringFrames = 0;

    _scriptNode = _audioCtx.createScriptProcessor(4096,2,2);
    _scriptNode.onaudioprocess = onAudioProcess;
    _sourceNode.connect(_scriptNode);
    _scriptNode.connect(_audioCtx.destination);

    _freqMax = Math.min(_freqMax, sr/2);
    syncFreqInputs();

    if (typeof resetLoudnessModel==='function') resetLoudnessModel();
    _stHist.fill(0); _ltHist.fill(0); _histIdx=0;

    _running=true;
    setElDisabled('spec-start-btn',true);
    setElDisabled('spec-stop-btn',false);
    setElDisabled('spec-play-btn',false);
    setStatus('Running — L+R  |  '+(sr/1000).toFixed(0)+' kHz  |  FFT '+_fftSize);
    buildFreqAxis(); buildTimeAxis();
    loop();
  } catch(err) { setStatus('Mic error: '+err.message); console.error(err); }
}

function stopSpectrogram() {
  if (!_running) return;
  _running=false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId=null; }
  if (_stream) { _stream.getTracks().forEach(t=>t.stop()); _stream=null; }
  if (_audioCtx) { _audioCtx.close(); _audioCtx=null; }
  _analyserL=_analyserR=_sourceNode=_splitter=_scriptNode=null;
  setElDisabled('spec-start-btn',false);
  setElDisabled('spec-stop-btn',true);
  setStatus('Stopped');
}

function playback() {
  if (!_audioCtx||!_ringBuffer||_ringFrames===0) { setStatus('No audio buffered'); return; }
  if (_playbackSrc) { try{_playbackSrc.stop();}catch(e){} _playbackSrc=null; }
  const sr=_audioCtx.sampleRate, frames=Math.min(_ringFrames,_ringMaxFrames);
  const abuf=_audioCtx.createBuffer(2,frames,sr);
  const ch0=abuf.getChannelData(0), ch1=abuf.getChannelData(1);
  const startF=_ringFrames>=_ringMaxFrames?(_ringWritePos/2)%_ringMaxFrames:0;
  for (let f=0;f<frames;f++) {
    const ri=((startF+f)%_ringMaxFrames)*2;
    ch0[f]=_ringBuffer[ri]; ch1[f]=_ringBuffer[ri+1];
  }
  _playbackSrc=_audioCtx.createBufferSource();
  _playbackSrc.buffer=abuf;
  _playbackSrc.connect(_audioCtx.destination);
  _playbackSrc.start();
  _playbackSrc.onended=()=>{ _playbackSrc=null; setStatus('Playback done'); };
  setStatus('Playing last '+Math.min(_ringFrames/sr,RING_SECS).toFixed(1)+' s…');
}

/* ════════════════════════════════════════════════════════════════════════
   CONTROLS
════════════════════════════════════════════════════════════════════════ */
function toggleLog() {
  _logScale=!_logScale;
  const btn=document.getElementById('spec-log-btn');
  if (btn) { btn.textContent=_logScale?'Log':'Lin'; btn.classList.toggle('tb-active',_logScale); }
  buildFreqAxis();
}
function applyFreqRange() {
  const nyq=_audioCtx?_audioCtx.sampleRate/2:24000;
  const mn=parseFloat(document.getElementById('spec-freq-min').value)||20;
  const mx=parseFloat(document.getElementById('spec-freq-max').value)||20000;
  _freqMin=Math.max(1,Math.min(mn,nyq-1));
  _freqMax=Math.max(_freqMin+1,Math.min(mx,nyq));
  syncFreqInputs(); buildFreqAxis();
  setStatus('Freq: '+fmtHz(_freqMin)+' – '+fmtHz(_freqMax));
}
function openModal()  { const m=document.getElementById('spec-modal'); if(m) m.style.display='flex'; }
function closeModal() { const m=document.getElementById('spec-modal'); if(m) m.style.display='none'; }

/* ════════════════════════════════════════════════════════════════════════
   BANDS
════════════════════════════════════════════════════════════════════════ */
function addBand() {
  const ne=document.getElementById('band-name');
  const fe=document.getElementById('band-freq');
  const ce=document.getElementById('band-color');
  const freq=parseFloat(fe?fe.value:'');
  if (!freq||freq<=0) { setStatus('Enter a valid Hz value'); return; }
  _bands.push({ name:(ne&&ne.value.trim())||('Band '+(_bands.length+1)), freq, color:(ce&&ce.value)||'#fff' });
  if(ne) ne.value=''; if(fe) fe.value='';
  renderBandList();
}
function removeBand(i) { _bands.splice(i,1); renderBandList(); }
window.removeBand=removeBand;

function renderBandList() {
  const list=document.getElementById('band-list');
  if (!list) return;
  if (!_bands.length) { list.innerHTML='<div class="band-empty">No bands</div>'; return; }
  list.innerHTML='';
  _bands.forEach((b,i)=>{
    const fl=b.freq>=1000?(b.freq/1000).toFixed(3).replace(/\.?0+$/,'')+' kHz':b.freq+' Hz';
    const row=document.createElement('div');
    row.className='band-row';
    row.innerHTML=`<span class="band-swatch" style="background:${b.color}"></span>`+
      `<span class="band-label">${b.name} — ${fl}</span>`+
      `<button class="band-del" onclick="removeBand(${i})">✕</button>`;
    list.appendChild(row);
  });
}

/* ════════════════════════════════════════════════════════════════════════
   RING BUFFER CAPTURE
════════════════════════════════════════════════════════════════════════ */
function onAudioProcess(e) {
  if (!_running||!_ringBuffer) return;
  const L=e.inputBuffer.getChannelData(0), R=e.inputBuffer.getChannelData(1);
  for (let i=0;i<L.length;i++) {
    _ringBuffer[_ringWritePos]=L[i]; _ringBuffer[_ringWritePos+1]=R[i];
    _ringWritePos=(_ringWritePos+2)%(_ringMaxFrames*2);
    _ringFrames++;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   ANIMATION LOOP
════════════════════════════════════════════════════════════════════════ */
function loop() {
  if (!_running) return;
  _rafId=requestAnimationFrame(loop);
  drawFrame();
  updateLoudness();
}

/* ════════════════════════════════════════════════════════════════════════
   SPECTROGRAM FRAME
════════════════════════════════════════════════════════════════════════ */
function drawFrame() {
  if (!_analyserR||!_canvas||_canvas.width===0) return;
  const bins=_analyserR.frequencyBinCount;
  const data=new Float32Array(bins);
  _analyserR.getFloatFrequencyData(data);
  const nyquist=_audioCtx.sampleRate/2;
  const W=_canvas.width, H=_canvas.height, px=_pixelsPerFrame;

  _ctx.drawImage(_canvas,-px,0);
  if (!_colBuf||_colBuf.height!==H) buildColBuf();
  const buf=_colBuf.data;
  for (let y=0;y<H;y++) {
    const f=yToFreq(y,H,nyquist);
    const bi=Math.max(0,Math.min(bins-1,Math.round(f/nyquist*(bins-1))));
    const db=data[bi];
    const t=Math.max(0,Math.min(1,(db-_dbFloor)/(_dbCeil-_dbFloor)));
    const [r,g,b]=_CMAP[Math.round(t*255)];
    const i=y*4; buf[i]=r; buf[i+1]=g; buf[i+2]=b; buf[i+3]=255;
  }
  _colCtx.putImageData(_colBuf,0,0);
  for (let c=0;c<px;c++) _ctx.drawImage(_colCtx.canvas,W-px+c,0);
  drawBandLines(H,nyquist);
}

/* ════════════════════════════════════════════════════════════════════════
   LOUDNESS UPDATE + OVERLAY
════════════════════════════════════════════════════════════════════════ */
function updateLoudness() {
  if (!_analyserL||!_analyserR||typeof processBinauralLoudness!=='function') return;

  const bins=_analyserL.frequencyBinCount;
  const dL=new Float32Array(bins), dR=new Float32Array(bins);
  _analyserL.getFloatFrequencyData(dL);
  _analyserR.getFloatFrequencyData(dR);

  const res=processBinauralLoudness(dL,dR,_audioCtx.sampleRate);

  // store history
  _stHist[_histIdx]=res.shortTermSones;
  _ltHist[_histIdx]=res.longTermSones;
  _histIdx=(_histIdx+1)%HIST_LEN;

  updateLoudnessDom(res.shortTermPhons, res.longTermPhons);
  drawLoudnessGraph();
}

/* ── Update the HTML loudness panel (bars + values) — no canvas drawing ── */
function updateLoudnessDom(stPh, ltPh) {
  const stPct = Math.max(0, Math.min(100, stPh)) + '%';
  const ltPct = Math.max(0, Math.min(100, ltPh)) + '%';

  const stBar = document.getElementById('loud-bar-st');
  const ltBar = document.getElementById('loud-bar-lt');
  const stVal = document.getElementById('loud-val-st');
  const ltVal = document.getElementById('loud-val-lt');

  if (stBar) {
    stBar.style.width = stPct;
    stBar.style.background = stPh < 70 ? '#6bcb77' : stPh < 85 ? '#ffd93d' : '#ff6b6b';
  }
  if (ltBar) ltBar.style.width = ltPct;
  if (stVal) stVal.textContent = stPh.toFixed(1) + ' ph';
  if (ltVal) ltVal.textContent = ltPh.toFixed(1) + ' ph';
}

/* ── Draw history graph on the small <canvas id="loud-graph"> ────────── */
function drawLoudnessGraph() {
  if (!_gCtx || !_graphCanvas) return;

  // Match canvas pixel size to its CSS size to avoid blurring
  const W = _graphCanvas.clientWidth  || 180;
  const H = _graphCanvas.clientHeight || 60;
  if (_graphCanvas.width !== W || _graphCanvas.height !== H) {
    _graphCanvas.width  = W;
    _graphCanvas.height = H;
  }

  const g = _gCtx;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0a0a0a';
  g.fillRect(0, 0, W, H);

  // Grid lines at 40, 60, 80 phon
  g.strokeStyle = '#222'; g.lineWidth = 1;
  g.fillStyle   = '#444'; g.font = '7px monospace';
  for (const p of [40, 60, 80]) {
    const y = H * (1 - p/100);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillText(p, 2, y - 1);
  }

  // History lines
  const drawLine = (hist, color) => {
    g.beginPath(); g.strokeStyle = color; g.lineWidth = 1.5;
    for (let i = 0; i < HIST_LEN; i++) {
      const s  = hist[(_histIdx + i) % HIST_LEN];
      const ph = s >= 1 ? 40 + (10/Math.log10(2)) * Math.log10(s) : 40 * Math.pow(s + 0.0005, 0.35);
      const x  = W * (i / (HIST_LEN - 1));
      const y  = H * (1 - Math.max(0, Math.min(1, ph / 100)));
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  };
  drawLine(_ltHist, '#4d96ff');
  drawLine(_stHist, '#6bcb77');
}

/* ════════════════════════════════════════════════════════════════════════
   BAND OVERLAY
════════════════════════════════════════════════════════════════════════ */
function drawBandLines(H,nyquist) {
  if (!_ctx||!_canvas||!_bands.length) return;
  const W=_canvas.width;
  _ctx.save();
  _ctx.font='bold 10px monospace'; _ctx.lineWidth=1; _ctx.setLineDash([5,4]);
  for (const b of _bands) {
    const f=b.freq;
    if (f<_freqMin||f>_freqMax||f>nyquist) continue;
    const y=freqToY(f,H,nyquist);
    if (y<0||y>H) continue;
    _ctx.strokeStyle=b.color;
    _ctx.beginPath(); _ctx.moveTo(0,y); _ctx.lineTo(W,y); _ctx.stroke();
    _ctx.fillStyle=b.color;
    _ctx.fillText(b.name,6,Math.max(12,y-3));
  }
  _ctx.restore();
}

/* ════════════════════════════════════════════════════════════════════════
   FREQ ↔ Y
════════════════════════════════════════════════════════════════════════ */
function yToFreq(y,H,nyquist) {
  const mn=Math.max(1,_freqMin), mx=Math.min(nyquist,_freqMax), t=1-y/(H-1);
  return _logScale ? mn*Math.pow(mx/mn,t) : mn+t*(mx-mn);
}
function freqToY(freq,H,nyquist) {
  const mn=Math.max(1,_freqMin), mx=Math.min(nyquist,_freqMax);
  const t=_logScale?Math.log(freq/mn)/Math.log(mx/mn):(freq-mn)/(mx-mn);
  return Math.round((1-t)*(H-1));
}

/* ════════════════════════════════════════════════════════════════════════
   COLOUR MAP (plasma)
════════════════════════════════════════════════════════════════════════ */
function buildColourMap() {
  const lut=new Array(256);
  for (let i=0;i<256;i++) {
    const t=i/255; let r,g,b;
    if      (t<0.25) { const s=t/0.25;        r=lerp(13,87,s);  g=lerp(8,15,s);   b=lerp(135,166,s); }
    else if (t<0.5)  { const s=(t-0.25)/0.25; r=lerp(87,190,s); g=lerp(15,55,s);  b=lerp(166,111,s); }
    else if (t<0.75) { const s=(t-0.5)/0.25;  r=lerp(190,253,s);g=lerp(55,155,s); b=lerp(111,37,s);  }
    else             { const s=(t-0.75)/0.25; r=lerp(253,240,s);g=lerp(155,249,s);b=lerp(37,33,s);   }
    lut[i]=[clamp(r),clamp(g),clamp(b)];
  }
  return lut;
}
function lerp(a,b,t){return Math.round(a+(b-a)*t);}
function clamp(v){return Math.max(0,Math.min(255,v));}

/* ════════════════════════════════════════════════════════════════════════
   COLOUR SCALE
════════════════════════════════════════════════════════════════════════ */
function drawColourScale() {
  if (!_scaleCanvas) return;
  const H=_scaleCanvas.height, id=_scaleCtx.createImageData(1,H);
  for (let y=0;y<H;y++) {
    const [r,g,b]=_CMAP[Math.round((1-y/(H-1))*255)];
    const i=y*4; id.data[i]=r; id.data[i+1]=g; id.data[i+2]=b; id.data[i+3]=255;
  }
  const tmp=document.createElement('canvas'); tmp.width=1; tmp.height=H;
  tmp.getContext('2d').putImageData(id,0,0);
  _scaleCtx.clearRect(0,0,20,H); _scaleCtx.drawImage(tmp,0,0,20,H);
}
function updateScaleLabels() {
  const t=document.getElementById('spec-scale-top'), b=document.getElementById('spec-scale-bot');
  if(t) t.textContent=_dbCeil+' dB'; if(b) b.textContent=_dbFloor+' dB';
}

/* ════════════════════════════════════════════════════════════════════════
   AXES
════════════════════════════════════════════════════════════════════════ */
function buildFreqAxis() {
  const el=document.getElementById('spec-freq-axis'); if(!el) return;
  el.innerHTML='';
  const nyquist=_audioCtx?_audioCtx.sampleRate/2:24000;
  const H=_canvas?_canvas.height:el.clientHeight; if(!H) return;
  for (const f of [20,30,50,100,200,300,500,1000,2000,3000,5000,10000,15000,20000]) {
    if (f<_freqMin||f>_freqMax||f>nyquist) continue;
    const y=freqToY(f,H,nyquist); if(y<0||y>H) continue;
    const s=document.createElement('span');
    s.className='freq-tick'; s.textContent=f>=1000?(f/1000)+'k':f; s.style.top=(y-8)+'px';
    el.appendChild(s);
  }
}
function buildTimeAxis() {
  const el=document.getElementById('spec-time-axis'); if(!el) return;
  el.innerHTML='';
  const W=_canvas?_canvas.width:el.clientWidth;
  const total=W*(_pixelsPerFrame/60), step=pickStep(total);
  for (let t=0;t<=total;t+=step) {
    const s=document.createElement('span');
    s.className='time-tick'; s.style.left=((1-t/total)*W)+'px';
    s.textContent='-'+(t<1?t.toFixed(1):Math.round(t))+'s';
    el.appendChild(s);
  }
}
function pickStep(s){for(const n of[0.5,1,2,5,10,20,30,60]){if(s/n<12)return n;}return 60;}

/* ════════════════════════════════════════════════════════════════════════
   MOUSE
════════════════════════════════════════════════════════════════════════ */
function onMouseMove(e) {
  const r=document.getElementById('spec-readout'); if(!r||!_canvas) return;
  const rect=_canvas.getBoundingClientRect(), yPx=e.clientY-rect.top;
  const nyquist=_audioCtx?_audioCtx.sampleRate/2:24000;
  r.textContent=fmtHz(yToFreq(yPx,_canvas.height,nyquist));
  r.style.display='block'; r.style.top=Math.max(0,yPx-20)+'px'; r.style.left='8px';
}

/* ════════════════════════════════════════════════════════════════════════
   UTILS
════════════════════════════════════════════════════════════════════════ */
function setStatus(m){const e=document.getElementById('spec-status');if(e)e.textContent=m;}
function setElDisabled(id,v){const e=document.getElementById(id);if(e)e.disabled=v;}
function syncFreqInputs(){
  const mn=document.getElementById('spec-freq-min'),mx=document.getElementById('spec-freq-max');
  if(mn)mn.value=_freqMin; if(mx)mx.value=_freqMax;
}
function fmtHz(f){return f>=1000?(f/1000).toFixed(2)+' kHz':Math.round(f)+' Hz';}
