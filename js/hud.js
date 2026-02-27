/**
 * HUD Manager
 *
 * Updates on-screen UI elements: speed, score, combo counter.
 */

export class HUD {
    constructor() {
        this._speedEl = document.getElementById('hud-speed');
        this._scoreEl = document.getElementById('hud-score');
        this._comboEl = document.getElementById('hud-combo');

        this.score = 0;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboTimeout = 2.0; // seconds to maintain combo
    }

    /**
     * Register a monster kill.
     */
    addKill(points = 100) {
        this.combo++;
        this.comboTimer = this.comboTimeout;

        const multiplier = Math.min(this.combo, 10);
        const total = points * multiplier;
        this.score += total;

        // Update combo display
        if (this._comboEl) {
            if (this.combo > 1) {
                this._comboEl.textContent = `x${this.combo} COMBO! +${total}`;
                this._comboEl.classList.remove('hidden');
                this._comboEl.style.opacity = '1';
            }
        }
    }

    update(dt, speedKmh) {
        // Speed display
        if (this._speedEl) {
            this._speedEl.innerHTML = `${speedKmh} <span>km/h</span>`;
        }

        // Score display
        if (this._scoreEl) {
            this._scoreEl.textContent = `SCORE: ${this.score}`;
        }

        // Combo timer
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
