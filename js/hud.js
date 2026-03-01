/**
 * HUD Manager
 *
 * Updates on-screen UI elements: speed, score, combo counter, time of day,
 * and extended debug info (FPS, viewport, GPU, draw calls, etc.).
 */

export class HUD {
    constructor() {
        this._speedEl = document.getElementById('hud-speed');
        this._scoreEl = document.getElementById('hud-score');
        this._comboEl = document.getElementById('hud-combo');
        this._timeEl = document.getElementById('hud-time');
        this._debugEl = document.getElementById('hud-debug');

        this.score = 0;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboTimeout = 2.0;

        // FPS tracking (smoothed over 0.5s windows)
        this._fpsFrames = 0;
        this._fpsAccum = 0;
        this._fpsDisplay = 0;
        this._frameTimeDisplay = '0.0';
    }

    addKill(points = 100) {
        this.combo++;
        this.comboTimer = this.comboTimeout;

        const multiplier = Math.min(this.combo, 10);
        const total = points * multiplier;
        this.score += total;

        if (this._comboEl) {
            if (this.combo > 1) {
                this._comboEl.textContent = `x${this.combo} COMBO! +${total}`;
                this._comboEl.classList.remove('hidden');
                this._comboEl.style.opacity = '1';
            }
        }
    }

    update(dt, speedKmh, timeStr, phaseName, debugInfo) {
        if (this._speedEl) {
            this._speedEl.innerHTML = `${speedKmh} <span>km/h</span>`;
        }

        if (this._scoreEl) {
            this._scoreEl.textContent = `SCORE: ${this.score}`;
        }

        if (this._timeEl && timeStr) {
            this._timeEl.textContent = `${timeStr} ${phaseName}`;
        }

        // FPS calculation (update display ~2x per second)
        this._fpsFrames++;
        this._fpsAccum += dt;
        if (this._fpsAccum >= 0.5) {
            this._fpsDisplay = Math.round(this._fpsFrames / this._fpsAccum);
            this._frameTimeDisplay = (this._fpsAccum / this._fpsFrames * 1000).toFixed(1);
            this._fpsFrames = 0;
            this._fpsAccum = 0;
        }

        // Extended debug display
        if (this._debugEl && debugInfo) {
            const s = debugInfo.staticInfo;
            const lines = [
                `FPS: ${this._fpsDisplay}  FRAME: ${this._frameTimeDisplay}ms  DT: ${(dt * 1000).toFixed(1)}ms`,
                `VIEWPORT: ${debugInfo.viewportW}x${debugInfo.viewportH} @${debugInfo.dpr.toFixed(1)}x`,
                `DRAW: ${debugInfo.drawCalls}  TRIS: ${debugInfo.triangles}  GEO: ${debugInfo.geometries}  TEX: ${debugInfo.textures}`,
                `CHUNK: ${debugInfo.chunkId}  X: ${debugInfo.x}  Z: ${debugInfo.z}  NPCs: ${debugInfo.npcCount}`,
            ];

            if (s) {
                lines.push(
                    `GPU: ${s.glRenderer}`,
                    `CPU: ${s.cores} cores  MEM: ${s.memory}  PLAT: ${s.platform}`,
                );
            }

            this._debugEl.textContent = lines.join('\n');
        }

        if (this.comboTimer > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.combo = 0;
                if (this._comboEl) {
                    this._comboEl.classList.add('hidden');
                }
            }
        }
    }
}
