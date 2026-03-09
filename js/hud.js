/**
 * HUD Manager
 *
 * Updates the 7-segment display bar with vehicle telemetry (left)
 * and scoring info (right).
 */

// Fake 7-speed auto transmission: gear speed thresholds in m/s
// Spread across achievable speed range (~96 m/s terminal velocity)
const GEAR_SHIFTS = [0, 8, 18, 30, 45, 62, 80];
const RPM_IDLE = 800;
const RPM_REDLINE = 7200;

export function getGearAndRPM(speedMs, overrideGear) {
    const absSpeed = Math.abs(speedMs);

    // Use override gear (manual mode) or compute from speed (auto)
    let gear;
    if (overrideGear !== undefined) {
        gear = overrideGear;
    } else {
        gear = 1;
        for (let i = GEAR_SHIFTS.length - 1; i >= 1; i--) {
            if (absSpeed >= GEAR_SHIFTS[i]) {
                gear = i + 1;
                break;
            }
        }
    }

    // RPM: interpolate between shift points
    const lo = GEAR_SHIFTS[gear - 1] || 0;
    const hi = gear < GEAR_SHIFTS.length ? GEAR_SHIFTS[gear] : GEAR_SHIFTS[gear - 1] + 30;
    const range = hi - lo;
    const t = range > 0 ? Math.min((absSpeed - lo) / range, 1.0) : 0;
    const rpm = RPM_IDLE + t * (RPM_REDLINE - RPM_IDLE);

    return { gear, rpm: Math.round(rpm) };
}

export class HUD {
    constructor() {
        this._speedEl = document.getElementById('hud-speed');
        this._tachEl = document.getElementById('hud-tach');
        this._scoreEl = document.getElementById('hud-score');
        this._timeEl = document.getElementById('hud-time');
        this._hpEl = document.getElementById('hud-hp');
        this._fluidEl = document.getElementById('hud-fluid');
        this._fuelEl = document.getElementById('hud-fuel');
        this._multEl = document.getElementById('hud-mult');
        this._hitEl = document.getElementById('hud-hit');
        this._shiftLightEl = document.getElementById('shift-light');

        this._fuel = 100; // percent

        this.score = 0;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboTimeout = 2.0;

        this._lastHitPoints = 0;
        this._hitTimer = 0;
        this._hitDisplayTime = 1.5;

        // Tach flash timer
        this._tachFlashTimer = 0;
    }

    addKill(points = 100) {
        this.combo++;
        this.comboTimer = this.comboTimeout;

        const multiplier = Math.min(this.combo, 10);
        const total = points * multiplier;
        this.score += total;

        this._lastHitPoints = total;
        this._hitTimer = this._hitDisplayTime;
    }

    update(dt, speedKmh, timeStr, phaseName, debugInfo, health, washerFluid, vehicle) {
        // Fuel slowly depletes
        this._fuel = Math.max(0, this._fuel - dt * 0.03);

        // Speed (m/s from km/h for tach calc)
        const speedMs = speedKmh / 3.6;
        if (this._speedEl) {
            const mph = Math.round(speedKmh * 0.621371);
            this._speedEl.textContent = `VEL: ${String(mph).padStart(3, '0')} mph`;
        }

        // Tachometer — use vehicle gear in manual mode
        if (this._tachEl) {
            const overrideGear = (vehicle && vehicle.manualMode) ? vehicle.currentGear : undefined;
            const { gear, rpm } = getGearAndRPM(speedMs, overrideGear);
            const modeChar = (vehicle && vehicle.manualMode) ? 'M' : 'A';

            // Show STALL if engine is off
            if (vehicle && !vehicle.engineRunning) {
                this._tachEl.textContent = `TACH: STALL/${modeChar}${gear}`;
            } else {
                this._tachEl.textContent = `TACH: ${String(rpm).padStart(4, '0')}/${modeChar}${gear}`;
            }

            // Flash tach red on stall
            if (vehicle && vehicle.engineStalled) {
                this._tachFlashTimer = 0.6;
            }

            // Flash tach red on redline (RPM >= 7000)
            if (vehicle && vehicle.engineRunning && rpm >= 7000) {
                this._tachFlashTimer = Math.max(this._tachFlashTimer, 0.15);
            }

            // Apply/remove flash class
            if (this._tachFlashTimer > 0) {
                this._tachFlashTimer -= dt;
                this._tachEl.classList.add('tach-flash');
            } else {
                this._tachEl.classList.remove('tach-flash');
            }

            // Shift light — illuminate when RPM > 6200 and engine running
            if (this._shiftLightEl) {
                const shiftLightOn = vehicle && vehicle.engineRunning && rpm > 6200;
                this._shiftLightEl.className = shiftLightOn ? 'shift-light-on' : 'shift-light-off';
            }
        }

        // Score
        if (this._scoreEl) {
            this._scoreEl.textContent = `SCORE: ${String(this.score).padStart(6, '0')}`;
        }

        // Time of day
        if (this._timeEl && timeStr) {
            this._timeEl.textContent = `TIME ${timeStr}`;
        }

        // Vehicle health
        if (this._hpEl && health !== undefined) {
            const hp = Math.round(health);
            this._hpEl.textContent = `HP: ${String(hp).padStart(3, '0')}/100`;
        }

        // Washer fluid
        if (this._fluidEl && washerFluid !== undefined) {
            this._fluidEl.textContent = `W_FLD: ${String(Math.round(washerFluid)).padStart(3, '0')}`;
        }

        // Fuel
        if (this._fuelEl) {
            this._fuelEl.textContent = `FUEL: ${String(Math.round(this._fuel)).padStart(3, '0')}`;
        }

        // Score multiplier (combo)
        if (this._multEl) {
            const multiplier = Math.min(this.combo, 10);
            const active = this.comboTimer > 0 && multiplier > 1;
            this._multEl.textContent = active
                ? `MULTx${String(multiplier).padStart(2, '0')}`
                : 'MULTx00';
            this._multEl.classList.toggle('dim', !active);
        }

        // Hit points flash
        if (this._hitEl) {
            const active = this._hitTimer > 0;
            this._hitEl.textContent = active
                ? `+${String(this._lastHitPoints).padStart(5, '0')}`
                : '+00000';
            if (active) this._hitTimer -= dt;
            this._hitEl.classList.toggle('dim', !active);
        }

        // Combo timer
        if (this.comboTimer > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.combo = 0;
            }
        }
    }
}
