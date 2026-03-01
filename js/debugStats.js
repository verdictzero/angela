/**
 * Debug Stats Overlay
 *
 * Displays renderer performance metrics: FPS, draw calls, triangles, geometries, textures.
 * Must be updated AFTER renderer.render() so that renderer.info contains current-frame data.
 * Panel can be collapsed to a small toggle button.
 */

export class DebugStats {
    constructor() {
        this._panelEl = document.getElementById('debug-stats-panel');
        this._toggleEl = document.getElementById('debug-stats-toggle');
        this._fpsEl = document.getElementById('debug-fps');
        this._drawsEl = document.getElementById('debug-draws');
        this._trisEl = document.getElementById('debug-tris');
        this._geomsEl = document.getElementById('debug-geoms');
        this._texturesEl = document.getElementById('debug-textures');

        // FPS tracking — accumulate over 1-second windows for stable readout
        this._frames = 0;
        this._fpsAccum = 0;
        this._currentFps = 0;

        // Start collapsed so it's unobtrusive by default
        this._collapsed = true;

        if (this._toggleEl) {
            this._toggleEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggle();
            });
        }
    }

    toggle() {
        this._collapsed = !this._collapsed;
        if (this._panelEl) {
            this._panelEl.classList.toggle('collapsed', this._collapsed);
        }
    }

    /**
     * Call AFTER renderer.render(scene, camera).
     * Three.js resets renderer.info at the START of render(), so reading
     * it after render gives us the current frame's actual stats.
     */
    update(dt, renderer) {
        this._frames++;
        this._fpsAccum += dt;
        if (this._fpsAccum >= 1.0) {
            this._currentFps = Math.round(this._frames / this._fpsAccum);
            this._frames = 0;
            this._fpsAccum = 0;
        }

        if (this._collapsed) return;

        const info = renderer.info;

        if (this._fpsEl) this._fpsEl.textContent = `FPS: ${this._currentFps}`;
        if (this._drawsEl) this._drawsEl.textContent = `DRAWS: ${info.render.calls}`;
        if (this._trisEl) this._trisEl.textContent = `TRIS: ${info.render.triangles}`;
        if (this._geomsEl) this._geomsEl.textContent = `GEOMS: ${info.memory.geometries}`;
        if (this._texturesEl) this._texturesEl.textContent = `TEX: ${info.memory.textures}`;
    }
}
