/**
 * loudness.js — Real-time binaural TVL loudness model
 *
 * Implements the Moore, Glasberg, Varathanathan & Schlittenlacher (2016)
 * binaural time-varying loudness model from:
 *   "A Loudness Model for Time-Varying Sounds Incorporating Binaural Inhibition"
 *   Trends in Hearing, 2016, Vol. 20: 1–16. DOI: 10.1177/2331216516682698
 *
 * Pipeline per frame (called once per ms equivalent from ScriptProcessor):
 *   1. Outer/middle ear weighting (simplified free-field FIR → here: A-weighting
 *      approximation on the FFT bins, sufficient for display purposes)
 *   2. Excitation pattern on ERBN-number (Cam) scale, 0.25-Cam steps
 *   3. Specific loudness via compressive nonlinearity (Moore et al. 1997, C=0.063)
 *   4. Short-term specific loudness: AGC-style temporal smoothing
 *      attack α=0.045, release r=0.02
 *   5. Gaussian smoothing of short-term specific loudness (B=0.08, ±18 Cam)
 *   6. Binaural inhibition: INHI = 2 / (1 + sech(ratio)^γ), γ=1.598
 *   7. Inhibited specific loudness → sum across Cams → short-term loudness
 *   8. Long-term loudness: AGC on short-term loudness
 *      attack αl=0.01, release rl=0.0005
 *   9. Display: short-term loudness (sones) + long-term loudness (sones) → phons
 *
 * Notes:
 *   - Uses WebAudio AnalyserNode FFT bins as the spectral estimate.
 *     This replaces the 6-FFT multi-rate front end (which requires raw PCM);
 *     the AnalyserNode provides adequate resolution for a live display.
 *   - Both ears taken from the ChannelSplitter (L=0, R=1).
 *   - Output: { shortTermSones, longTermSones, shortTermPhons, longTermPhons }
 */
'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   ERB / CAM SCALE
   Moore & Glasberg (1990): ERB_N = 24.7 * (4.37 * f/1000 + 1)
════════════════════════════════════════════════════════════════════════════ */

/** Frequency (Hz) → ERBN-number (Cam) */
function hzToCam(f) {
  return 21.4 * Math.log10(4.37 * f / 1000 + 1);
}

/** Cam → Hz */
function camToHz(cam) {
  return 1000 * (Math.pow(10, cam / 21.4) - 1) / 4.37;
}

/* ════════════════════════════════════════════════════════════════════════════
   BUILD CAM GRID  (1.75 to 39 Cam in 0.25 steps → 150 points)
════════════════════════════════════════════════════════════════════════════ */
const CAM_MIN  = 1.75;   // ≈ 48 Hz
const CAM_MAX  = 39.0;   // ≈ 15 100 Hz
const CAM_STEP = 0.25;
const N_CAMS   = Math.round((CAM_MAX - CAM_MIN) / CAM_STEP) + 1;  // 150

// Pre-compute centre frequencies on the Cam grid
const _camGrid = new Float64Array(N_CAMS);
const _hzGrid  = new Float64Array(N_CAMS);
for (let k = 0; k < N_CAMS; k++) {
  _camGrid[k] = CAM_MIN + k * CAM_STEP;
  _hzGrid[k]  = camToHz(_camGrid[k]);
}

/* ════════════════════════════════════════════════════════════════════════════
   OUTER + MIDDLE EAR  (free-field frontal incidence, simplified)
   Approximated here as a level correction per frequency bin derived from
   ISO 226:2003 equal-loudness contours (threshold curve ≈ outer+middle ear
   inverse).  We use the free-field-to-eardrum gain from Shaw (1974) /
   Glasberg & Moore (2006) sampled at the Cam grid.
   Values below are gain in dB (positive = boost toward eardrum).
════════════════════════════════════════════════════════════════════════════ */
// Free-field to eardrum transfer (dB), sampled at _hzGrid via cubic interp.
// Source: Figure 2 of the paper (solid "free field" curve), read at key freqs.
const _ffGainHz  = [  50,  100,  200,  500,  1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 15000];
const _ffGainDB  = [  -1,    0,    1,    2,     2,    2,    7,   13,   14,   11,    3,     -5,    -8];

/** Linear interpolation of the free-field ear gain table for a given Hz */
function earGainDB(hz) {
  if (hz <= _ffGainHz[0])                          return _ffGainDB[0];
  if (hz >= _ffGainHz[_ffGainHz.length - 1])       return _ffGainDB[_ffGainDB.length - 1];
  for (let i = 0; i < _ffGainHz.length - 1; i++) {
    if (hz >= _ffGainHz[i] && hz <= _ffGainHz[i+1]) {
      const t = (hz - _ffGainHz[i]) / (_ffGainHz[i+1] - _ffGainHz[i]);
      return _ffGainDB[i] + t * (_ffGainDB[i+1] - _ffGainDB[i]);
    }
  }
  return 0;
}

// Pre-compute ear gain correction for each Cam
const _earGainLinear = new Float64Array(N_CAMS);
for (let k = 0; k < N_CAMS; k++) {
  _earGainLinear[k] = Math.pow(10, earGainDB(_hzGrid[k]) / 20);
}

/* ════════════════════════════════════════════════════════════════════════════
   ABSOLUTE THRESHOLD  (ISO 226:2003 / Glasberg & Moore 2006)
   Represented as excitation at threshold (linear pressure units²).
   Approximation from Moore et al. (1997).
════════════════════════════════════════════════════════════════════════════ */
const _eThrDb  = new Float64Array(N_CAMS);
const _eThrLin = new Float64Array(N_CAMS);

// Absolute threshold in dB SPL, approximate formula from Moore (2012):
// Tq(f) ≈ 3.64*(f/1000)^-0.8 - 6.5*exp(-0.6*(f/1000-3.3)²) + 1e-3*(f/1000)^4
for (let k = 0; k < N_CAMS; k++) {
  const fk = _hzGrid[k] / 1000;
  const t  = 3.64 * Math.pow(fk, -0.8)
           - 6.5  * Math.exp(-0.6 * Math.pow(fk - 3.3, 2))
           + 1e-3 * Math.pow(fk, 4);
  _eThrDb[k]  = Math.max(t, -10);  // clamp to reasonable range
  _eThrLin[k] = Math.pow(10, _eThrDb[k] / 10);
}

/* ════════════════════════════════════════════════════════════════════════════
   SPECIFIC LOUDNESS  (Moore et al. 1997, modified C=0.063)
   N'(i) = C * ( (E(i)/E_thr(i))^0.23 - 1 )   if E > E_thr, else 0
   where E is excitation (linear power), E_thr is excitation at threshold.
════════════════════════════════════════════════════════════════════════════ */
const C_LOUD = 0.063;   // paper §Transformation, modified for binaural inhibition

function specificLoudness(excitationLin, kIdx) {
  const ratio = excitationLin / _eThrLin[kIdx];
  if (ratio <= 1) return 0;
  return C_LOUD * (Math.pow(ratio, 0.23) - 1);
}

/* ════════════════════════════════════════════════════════════════════════════
   GAUSSIAN SMOOTHING WEIGHTS  (Equation 5, B=0.08, ±18 Cam steps of 0.25)
════════════════════════════════════════════════════════════════════════════ */
const B_GAUSS      = 0.08;
const GAUSS_HALF   = 18;   // ±18 steps of 0.25 Cam = ±4.5 Cam
const _gaussWeight = new Float64Array(2 * GAUSS_HALF + 1);
for (let di = -GAUSS_HALF; di <= GAUSS_HALF; di++) {
  _gaussWeight[di + GAUSS_HALF] = Math.exp(-B_GAUSS * di * di);
}

/* ════════════════════════════════════════════════════════════════════════════
   MODEL STATE  (short-term and long-term running estimates)
════════════════════════════════════════════════════════════════════════════ */
// Short-term specific loudness patterns (per Cam, per ear)
const _stSpecLoud_L = new Float64Array(N_CAMS);
const _stSpecLoud_R = new Float64Array(N_CAMS);

// Long-term loudness per ear
let _ltLoud_L = 0;
let _ltLoud_R = 0;

// AGC constants (paper §Calculation of Short-Term Specific Loudness)
const ALPHA_ATT = 0.045;   // attack  (a)
const ALPHA_REL = 0.02;    // release (r)
// AGC constants for long-term (paper §Calculation of Long-Term Loudness)
const ALPHA_LT_ATT = 0.01;
const ALPHA_LT_REL = 0.0005;

// γ for binaural inhibition (paper §Calculation of Inhibited, γ=1.598)
const GAMMA = 1.598;

/* ════════════════════════════════════════════════════════════════════════════
   SECH
════════════════════════════════════════════════════════════════════════════ */
function sech(x) {
  // sech(x) = 2 / (e^x + e^-x)
  const ex = Math.exp(x);
  return 2 / (ex + 1 / ex);
}

/* ════════════════════════════════════════════════════════════════════════════
   MAIN PROCESSING FUNCTION
   Called each animation frame with the current FFT magnitude data (dBFS)
   for left and right channels separately.

   @param  dataL  Float32Array  — getFloatFrequencyData output, left channel
   @param  dataR  Float32Array  — getFloatFrequencyData output, right channel
   @param  sampleRate  number
   @returns { shortTermSones, longTermSones, shortTermPhons, longTermPhons,
              stSpecLoud_L, stSpecLoud_R }   (stSpecLoud arrays for visualisation)
════════════════════════════════════════════════════════════════════════════ */
function processBinauralLoudness(dataL, dataR, sampleRate) {
  const binCount = dataL.length;
  const nyquist  = sampleRate / 2;

  /* ── Step 1: map FFT bins → excitation on Cam grid ───────────────────── */
  const instExcL = new Float64Array(N_CAMS);
  const instExcR = new Float64Array(N_CAMS);

  for (let k = 0; k < N_CAMS; k++) {
    const f      = _hzGrid[k];
    const binIdx = Math.round((f / nyquist) * (binCount - 1));
    const bi     = Math.max(0, Math.min(binCount - 1, binIdx));

    // Convert dBFS → linear power, apply ear gain
    const dbL = dataL[bi];
    const dbR = dataR[bi];

    // dBFS from AnalyserNode is referenced to full scale; add ~94 dB to get
    // approximate SPL (assumes 0 dBFS ≈ 94 dB SPL, a common calibration)
    const splL = dbL + 94;
    const splR = dbR + 94;

    const earG = _earGainLinear[k];
    // Excitation = power at eardrum (linear, referenced to 20 µPa²)
    instExcL[k] = Math.pow(10, splL / 10) * earG * earG;
    instExcR[k] = Math.pow(10, splR / 10) * earG * earG;
  }

  /* ── Step 2: instantaneous specific loudness ──────────────────────────── */
  const instSL_L = new Float64Array(N_CAMS);
  const instSL_R = new Float64Array(N_CAMS);

  for (let k = 0; k < N_CAMS; k++) {
    instSL_L[k] = specificLoudness(instExcL[k], k);
    instSL_R[k] = specificLoudness(instExcR[k], k);
  }

  /* ── Step 3: short-term specific loudness (AGC temporal smoothing) ────── */
  // Equation 1–4 of the paper
  for (let k = 0; k < N_CAMS; k++) {
    const sL = instSL_L[k];
    const sR = instSL_R[k];
    const aL = sL > _stSpecLoud_L[k] ? ALPHA_ATT : ALPHA_REL;
    const aR = sR > _stSpecLoud_R[k] ? ALPHA_ATT : ALPHA_REL;
    _stSpecLoud_L[k] = aL * sL + (1 - aL) * _stSpecLoud_L[k];
    _stSpecLoud_R[k] = aR * sR + (1 - aR) * _stSpecLoud_R[k];
  }

  /* ── Step 4: Gaussian smoothing of short-term specific loudness ─────────
     Equation 5 of the paper. Used only for computing binaural inhibition.  */
  const smoothL = new Float64Array(N_CAMS);
  const smoothR = new Float64Array(N_CAMS);
  const EPS = 1e-13;

  for (let k = 0; k < N_CAMS; k++) {
    let sumL = 0, sumR = 0;
    for (let di = -GAUSS_HALF; di <= GAUSS_HALF; di++) {
      const ki = k + di;
      if (ki < 0 || ki >= N_CAMS) continue;
      const w = _gaussWeight[di + GAUSS_HALF];
      sumL += _stSpecLoud_L[ki] * w;
      sumR += _stSpecLoud_R[ki] * w;
    }
    smoothL[k] = sumL + EPS;
    smoothR[k] = sumR + EPS;
  }

  /* ── Step 5: binaural inhibition ─────────────────────────────────────────
     Equation 6 of the paper:
     INHI(i) = 2 / (1 + sech(N_CONTRA_smooth / N_IPSI_smooth) ^ γ)          */
  const inhibL = new Float64Array(N_CAMS);
  const inhibR = new Float64Array(N_CAMS);

  for (let k = 0; k < N_CAMS; k++) {
    // For left ear: IPSI = L, CONTRA = R
    const inhFactorL = 2 / (1 + Math.pow(sech(smoothR[k] / smoothL[k]), GAMMA));
    const inhFactorR = 2 / (1 + Math.pow(sech(smoothL[k] / smoothR[k]), GAMMA));
    // Inhibited = original / inhibition factor
    inhibL[k] = _stSpecLoud_L[k] / inhFactorL;
    inhibR[k] = _stSpecLoud_R[k] / inhFactorR;
  }

  /* ── Step 6: short-term loudness (sum across Cams, both ears) ────────── */
  let stL = 0, stR = 0;
  for (let k = 0; k < N_CAMS; k++) {
    stL += inhibL[k];
    stR += inhibR[k];
  }
  stL *= CAM_STEP;   // integrate over Cam width
  stR *= CAM_STEP;
  const shortTermSones = stL + stR;   // overall binaural short-term loudness

  /* ── Step 7: long-term loudness (AGC on short-term) ─────────────────────
     Equations 7–8 of the paper                                              */
  const aAttL = stL > _ltLoud_L ? ALPHA_LT_ATT : ALPHA_LT_REL;
  const aAttR = stR > _ltLoud_R ? ALPHA_LT_ATT : ALPHA_LT_REL;
  _ltLoud_L = aAttL * stL + (1 - aAttL) * _ltLoud_L;
  _ltLoud_R = aAttR * stR + (1 - aAttR) * _ltLoud_R;
  const longTermSones = _ltLoud_L + _ltLoud_R;

  /* ── Step 8: convert sones → phons ──────────────────────────────────────
     ISO 532 inverse sone formula:
       phons = 40 + 10/log10(2) * log10(sones)   for sones ≥ 1
       phons = 40 * (sones + 0.0005)^0.35          for sones < 1  */
  function sonesToPhons(s) {
    if (s <= 0) return 0;
    if (s >= 1) return 40 + (10 / Math.log10(2)) * Math.log10(s);
    return 40 * Math.pow(s + 0.0005, 0.35);
  }

  return {
    shortTermSones,
    longTermSones,
    shortTermPhons:  sonesToPhons(shortTermSones),
    longTermPhons:   sonesToPhons(longTermSones),
    inhibL,
    inhibR,
  };
}

/** Reset all running state (call when stopping/starting) */
function resetLoudnessModel() {
  _stSpecLoud_L.fill(0);
  _stSpecLoud_R.fill(0);
  _ltLoud_L = 0;
  _ltLoud_R = 0;
}

