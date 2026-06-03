# Spectrogram — ObieWebApp 2

Real-time horizontal scrolling spectrogram, right-channel only.  
Layout matches Spectroid (phone app) rotated 90° counter-clockwise:  
**X = time** (new data enters right, scrolls left) | **Y = frequency** (low = bottom, high = top).

## Files in this folder

| File | Purpose |
|---|---|
| `index.html` | Main page (ObieWebApp 2 HTML shell) |
| `spectrogram.css` | Tool-specific styles |
| `spectrogram.js` | All spectrogram logic — Web Audio API + Canvas |
| `main.py` | Minimal PyScript entry point (hides loading overlay) |
| `pyscript.toml` | PyScript 2026.3.1 config (no extra packages) |

## Deployment

This folder is **self-contained** but assumes it lives two levels below shared assets:

```
your-server/
├── coi-serviceworker.js        ← copy from ObieApp repo root
├── css/
│   └── theme.css               ← copy from Web/css/
├── js/
│   ├── plotly-theme.js
│   ├── audio.js
│   ├── obie-settings.js
│   └── browser-check.js        ← all from Web/js/
└── tools/
    └── spectrogram/            ← this folder
        ├── index.html
        ├── spectrogram.css
        ├── spectrogram.js
        ├── main.py
        └── pyscript.toml
```

Or place it anywhere — just adjust the `../../` paths in `index.html` to point at your shared assets and `coi-serviceworker.js`.

## Requirements

- **Chrome or Edge** (required for SharedArrayBuffer / File System Access API)
- **HTTPS** host (required for microphone + SharedArrayBuffer)
- Microphone permission — tool requests the right channel specifically

## Controls

| Control | Description |
|---|---|
| ▶ Start | Opens mic, begins streaming |
| ■ Stop | Closes mic stream |
| FFT size | 1 k / 2 k / 4 k / 8 k bins |
| dB floor | Bottom of colour scale (−120 to −60 dB) |
| Speed | Pixels per frame (×1 / ×2 / ×4) |

Hover over the canvas to see frequency readout at cursor position.
