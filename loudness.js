/**
 * loudness.js — Real-time binaural TVL loudness model
 * Moore, Glasberg, Varathanathan & Schlittenlacher (2016)
 * Trends in Hearing, Vol. 20. DOI: 10.1177/2331216516682698
 *
 * Called every animation frame with Float32Array dBFS data from two
 * Web Audio AnalyserNodes (left and right channels).
 *
 * Returns { shortTermSones, longTermSones, shortTermPhons, longTermPhons }
 */
'use strict';

/* ── ERB / Cam scale ─────────────────────────────────────────────────────
   Moore & Glasberg (1990): ERBN-number = 21.4 * log10(4.37*f/1000 + 1)   */
function hzToCam(f) { return 21.4 * Math.log10(4.37 * f / 1000 + 1); }
function camToHz(c) { return (Math.pow(10, c / 21.4) - 1) / 4.37 * 1000; }

/* ── Cam grid: 1.75 → 39 Cam in 0.25 steps (150 points) ──────────────── */
const CAM_MIN = 1.75, CAM_MAX = 39.0, CAM_STEP = 0.25;
const N_CAMS  = Math.round((CAM_MAX - CAM_MIN) / CAM_STEP) + 1; // 150

const _camHz = new Float64Array(N_CAMS);
for (let k = 0; k < N_CAMS; k++) {
  _camHz[k] = camToHz(CAM_MIN + k * CAM_STEP);
}

/* ── Free-field to eardrum gain (dB) ─────────────────────────────────────
   Sampled from Shaw (1974) / Figure 2 of the paper.                       */
const _ffHz  = [50, 100, 200, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 15000];
const _ffDB  = [-1,   0,   1,   2,    2,    2,    7,   13,   14,   11,    3,    -5,    -8];
function earGainLin(hz) {
  if (hz <= _ffHz[0]) return Math.pow(10, _ffDB[0]/20);
  const last = _ffHz.length - 1;
  if (hz >= _ffHz[last]) return Math.pow(10, _ffDB[last]/20);
  for (let i = 0; i < last; i++) {
    if (hz <= _ffHz[i+1]) {
      const t = (hz - _ffHz[i]) / (_ffHz[i+1] - _ffHz[i]);
      const db = _ffDB[i] + t * (_ffDB[i+1] - _ffDB[i]);
      return Math.pow(10, db / 20);
    }
  }
  return 1;
}
const _earGain = new Float64Array(N_CAMS);
for (let k = 0; k < N_CAMS; k++) _earGain[k] = earGainLin(_camHz[k]);

/* ── Absolute threshold (Moore 2012 formula) ─────────────────────────────
   Tq(f) ≈ 3.64*(f/kHz)^-0.8 - 6.5*exp(-0.6*(f/kHz-3.3)²) + 1e-3*(f/kHz)^4
   Expressed as linear power (Pa²) re 20 µPa.                              */
const _eThr = new Float64Array(N_CAMS);
for (let k = 0; k < N_CAMS; k++) {
  const fk = Math.max(0.1, _camHz[k] / 1000);
  const db = 3.64*Math.pow(fk,-0.8) - 6.5*Math.exp(-0.6*Math.pow(fk-3.3,2)) + 1e-3*Math.pow(fk,4);
  _eThr[k] = Math.pow(10, Math.min(db, 60) / 10); // linear power, clamped
}

/* ── Specific loudness: Moore et al. (1997), C=0.063 ─────────────────────
   N'(i) = C * ((E/Ethr)^0.23 - 1) for E > Ethr, else 0                  */
const C_LOUD = 0.063;
function specLoud(E, k) {
  if (E <= _eThr[k]) return 0;
  return C_LOUD * (Math.pow(E / _eThr[k], 0.23) - 1);
}

/* ── Gaussian smoothing weights (Eq. 5, B=0.08, ±18 steps) ─────────────  */
const B_GAUSS = 0.08, GHALF = 18;
const _gw = new Float64Array(2*GHALF+1);
for (let d = -GHALF; d <= GHALF; d++) _gw[d+GHALF] = Math.exp(-B_GAUSS*d*d);

/* ── Running AGC state ───────────────────────────────────────────────────  */
const _stL = new Float64Array(N_CAMS); // short-term specific loudness, left
const _stR = new Float64Array(N_CAMS); // short-term specific loudness, right
let _ltL = 0, _ltR = 0;               // long-term loudness per ear

// Attack/release constants (paper §Short-Term / Long-Term Loudness)
const A_ST = 0.045, R_ST = 0.02;
const A_LT = 0.01,  R_LT = 0.0005;

// γ for binaural inhibition (Eq. 6)
const GAMMA = 1.598;
function sech(x) { const e=Math.exp(x); return 2/(e+1/e); }

/* ════════════════════════════════════════════════════════════════════════════
   MAIN ENTRY POINT
   dataL, dataR : Float32Array from getFloatFrequencyData() (dBFS, ≤ 0)
   sampleRate   : number
   Returns      : { shortTermSones, longTermSones, shortTermPhons, longTermPhons }
════════════════════════════════════════════════════════════════════════════ */
function processBinauralLoudness(dataL, dataR, sampleRate) {
  const bins    = dataL.length;
  const nyquist = sampleRate / 2;

  /* Step 1 — map FFT bins → excitation (linear power, Pa²) on Cam grid ── */
  const EL = new Float64Array(N_CAMS);
  const ER = new Float64Array(N_CAMS);

  for (let k = 0; k < N_CAMS; k++) {
    const f   = _camHz[k];
    if (f > nyquist) continue;
    const bi  = Math.max(0, Math.min(bins-1, Math.round(f/nyquist*(bins-1))));

    // dBFS → dB SPL: assume 0 dBFS ≡ 100 dB SPL (reasonable for a mic input)
    const splL = dataL[bi] + 100;
    const splR = dataR[bi] + 100;

    // linear power * ear gain²
    const g2 = _earGain[k] * _earGain[k];
    EL[k] = Math.pow(10, splL/10) * g2;
    ER[k] = Math.pow(10, splR/10) * g2;
  }

  /* Step 2 — instantaneous specific loudness ──────────────────────────── */
  const iSL = new Float64Array(N_CAMS);
  const iSR = new Float64Array(N_CAMS);
  for (let k = 0; k < N_CAMS; k++) {
    iSL[k] = specLoud(EL[k], k);
    iSR[k] = specLoud(ER[k], k);
  }

  /* Step 3 — short-term specific loudness (AGC, Eq. 1–4) ─────────────── */
  for (let k = 0; k < N_CAMS; k++) {
    const aL = iSL[k] > _stL[k] ? A_ST : R_ST;
    const aR = iSR[k] > _stR[k] ? A_ST : R_ST;
    _stL[k] = aL*iSL[k] + (1-aL)*_stL[k];
    _stR[k] = aR*iSR[k] + (1-aR)*_stR[k];
  }

  /* Step 4 — Gaussian smoothing for inhibition (Eq. 5) ───────────────── */
  const EPS = 1e-13;
  const smL = new Float64Array(N_CAMS);
  const smR = new Float64Array(N_CAMS);
  for (let k = 0; k < N_CAMS; k++) {
    let sL=0, sR=0;
    for (let d=-GHALF; d<=GHALF; d++) {
      const ki = k+d;
      if (ki<0||ki>=N_CAMS) continue;
      const w = _gw[d+GHALF];
      sL += _stL[ki]*w; sR += _stR[ki]*w;
    }
    smL[k] = sL + EPS;
    smR[k] = sR + EPS;
  }

  /* Step 5 — binaural inhibition (Eq. 6) ─────────────────────────────── */
  let stSonesL = 0, stSonesR = 0;
  for (let k = 0; k < N_CAMS; k++) {
    const inhL = 2 / (1 + Math.pow(sech(smR[k]/smL[k]), GAMMA));
    const inhR = 2 / (1 + Math.pow(sech(smL[k]/smR[k]), GAMMA));
    stSonesL += _stL[k] / inhL;
    stSonesR += _stR[k] / inhR;
  }
  stSonesL *= CAM_STEP;
  stSonesR *= CAM_STEP;
  const shortTermSones = stSonesL + stSonesR;

  /* Step 6 — long-term loudness (Eq. 7–8) ────────────────────────────── */
  const aL2 = stSonesL > _ltL ? A_LT : R_LT;
  const aR2 = stSonesR > _ltR ? A_LT : R_LT;
  _ltL = aL2*stSonesL + (1-aL2)*_ltL;
  _ltR = aR2*stSonesR + (1-aR2)*_ltR;
  const longTermSones = _ltL + _ltR;

  /* Sones → phons (ISO 532 inverse) ────────────────────────────────────  */
  function s2p(s) {
    if (s <= 0)  return 0;
    if (s >= 1)  return 40 + (10/Math.log10(2)) * Math.log10(s);
    return 40 * Math.pow(s + 0.0005, 0.35);
  }

  return {
    shortTermSones,
    longTermSones,
    shortTermPhons: s2p(shortTermSones),
    longTermPhons:  s2p(longTermSones),
  };
}

function resetLoudnessModel() {
  _stL.fill(0); _stR.fill(0);
  _ltL = 0; _ltR = 0;
}
