# main.py — ObieWebApp 2 · Spectrogram
#
# This tool's signal processing is entirely handled by the browser's
# Web Audio API (AnalyserNode FFT), so no Python DSP is needed here.
# This file exists to satisfy the ObieWebApp PyScript shell convention
# and to hide the loading overlay once the Python runtime is ready.

from pyscript import document, window  # noqa: F401


def hide_loading():
    overlay = document.getElementById("loading")
    if overlay:
        overlay.style.display = "none"


hide_loading()
