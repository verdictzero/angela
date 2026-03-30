/**
 * Unified Input Manager
 * Handles keyboard, mouse, gamepad, and touch input.
 * Exposes normalized control values: steer, gas, brake, handbrake, boost,
 * clutch, shiftUp, shiftDown, toggleTransmission.
 */

import { clamp, lerp } from './utils.js';

export class InputManager {
    constructor() {
        // Normalized outputs
        this.steer = 0;        // -1 (left) to 1 (right)
        this.gas = 0;          // 0 to 1
        this.brake = 0;        // 0 to 1
        this.handbrake = false;
        this.boost = false;
        this.wipers = false;   // toggle on F
        this.washer = false;   // held on R
        this.clutch = false;   // held on C / left ctrl
        this.headlights = true;  // toggle on H (default on)
        this.highBeams = false;  // toggle on J (default off)

        // Edge-triggered shift events (consumed per frame)
        this.shiftUp = false;
        this.shiftDown = false;
        this.toggleTransmission = false;

        // Wiper toggle tracking
        this._wipersToggle = false;
        this._headlightsToggle = false;
        this._highBeamsToggle = false;

        // Shift edge tracking
        this._shiftUpEdge = false;
        this._shiftDownEdge = false;
        this._transToggleEdge = false;

        // Keyboard state
        this._keys = {};

        // Mouse steering
        this._mouseSteering = false;
        this._mouseSteerValue = 0;
        this._mouseMovementX = 0;

        // Touch state
        this._touchActive = false;
        this._touchSteer = 0;         // smoothed output value
        this._touchSteerTarget = 0;   // raw target from steering track
        this._steerSensitivity = 1.0; // multiplier from CFG slider (0.2–2.0)
        this._touchGas = false;
        this._touchBrake = false;
        this._touchHandbrake = false;
        this._touchClutch = false;
        this._touchShiftUp = false;
        this._touchShiftDown = false;
        this._touchTransToggle = false;
        this._joystickTouchId = null;
        this._joystickCenter = { x: 0, y: 0 };

        // Gamepad
        this._gamepadIndex = null;

        // Is touch device
        this.isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

        this._initKeyboard();
        this._initMouse();
        this._initGamepad();

        if (this.isTouchDevice) {
            this._initTouch();
        }
    }

    _initKeyboard() {
        window.addEventListener('keydown', (e) => {
            this._keys[e.code] = true;
            // Wiper toggle on F keydown edge
            if (e.code === 'KeyF' && !this._wipersToggle) {
                this._wipersToggle = true;
                this.wipers = !this.wipers;
            }
            // Headlight toggle on H keydown edge
            if (e.code === 'KeyH' && !this._headlightsToggle) {
                this._headlightsToggle = true;
                this.headlights = !this.headlights;
            }
            // High beam toggle on J keydown edge
            if (e.code === 'KeyJ' && !this._highBeamsToggle) {
                this._highBeamsToggle = true;
                this.highBeams = !this.highBeams;
            }
            // Shift up edge (E)
            if (e.code === 'KeyE' && !this._shiftUpEdge) {
                this._shiftUpEdge = true;
                this.shiftUp = true;
            }
            // Shift down edge (Q)
            if (e.code === 'KeyQ' && !this._shiftDownEdge) {
                this._shiftDownEdge = true;
                this.shiftDown = true;
            }
            // Transmission toggle edge (T)
            if (e.code === 'KeyT' && !this._transToggleEdge) {
                this._transToggleEdge = true;
                this.toggleTransmission = true;
            }
            // Prevent default for game keys
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
                 'ShiftLeft', 'ShiftRight', 'KeyF', 'KeyR', 'KeyC', 'KeyE',
                 'KeyQ', 'KeyT', 'KeyH', 'KeyJ', 'ControlLeft'].includes(e.code)) {
                e.preventDefault();
            }
        });
        window.addEventListener('keyup', (e) => {
            this._keys[e.code] = false;
            if (e.code === 'KeyF') this._wipersToggle = false;
            if (e.code === 'KeyH') this._headlightsToggle = false;
            if (e.code === 'KeyJ') this._highBeamsToggle = false;
            if (e.code === 'KeyE') this._shiftUpEdge = false;
            if (e.code === 'KeyQ') this._shiftDownEdge = false;
            if (e.code === 'KeyT') this._transToggleEdge = false;
        });
        // Reset keys on blur to prevent stuck keys
        window.addEventListener('blur', () => {
            this._keys = {};
        });
    }

    _initMouse() {
        window.addEventListener('mousemove', (e) => {
            this._mouseMovementX += e.movementX;
        });
        // Right click toggles mouse steering
        window.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('mousedown', (e) => {
            if (e.button === 2) {
                this._mouseSteering = !this._mouseSteering;
                if (!this._mouseSteering) this._mouseSteerValue = 0;
            }
        });
    }

    _initGamepad() {
        window.addEventListener('gamepadconnected', (e) => {
            this._gamepadIndex = e.gamepad.index;
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            if (this._gamepadIndex === e.gamepad.index) {
                this._gamepadIndex = null;
            }
        });
    }

    _initTouch() {
        const touchControls = document.getElementById('touch-controls');
        if (touchControls) touchControls.classList.remove('hidden');

        const settingsBtn = document.getElementById('touch-settings-btn');
        if (settingsBtn) settingsBtn.classList.remove('hidden');

        const steeringTrack = document.getElementById('steering-track');
        const steeringThumb = document.getElementById('steering-thumb');
        const btnGas = document.getElementById('btn-gas');
        const btnBrake = document.getElementById('btn-brake');
        const btnEbrake = document.getElementById('btn-ebrake');
        const btnClutch = document.getElementById('btn-clutch');
        const btnShiftUp = document.getElementById('btn-shift-up');
        const btnShiftDown = document.getElementById('btn-shift-down');
        const btnTransMode = document.getElementById('btn-trans-mode');
        const btnHeadlights = document.getElementById('btn-headlights');
        const btnHighBeams = document.getElementById('btn-highbeams');

        if (steeringTrack) {
            steeringTrack.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const touch = e.changedTouches[0];
                this._joystickTouchId = touch.identifier;
                const rect = steeringTrack.getBoundingClientRect();
                this._joystickCenter = { x: rect.left + rect.width / 2, y: 0 };
                this._joystickMaxDist = rect.width / 2;
                this._updateSteering(touch.clientX, steeringTrack, steeringThumb);
            });

            steeringTrack.addEventListener('touchmove', (e) => {
                e.preventDefault();
                for (const touch of e.changedTouches) {
                    if (touch.identifier === this._joystickTouchId) {
                        this._updateSteering(touch.clientX, steeringTrack, steeringThumb);
                    }
                }
            });

            const endSteering = (e) => {
                for (const touch of e.changedTouches) {
                    if (touch.identifier === this._joystickTouchId) {
                        this._joystickTouchId = null;
                        this._touchSteerTarget = 0;
                        if (steeringThumb) {
                            steeringThumb.style.left = '50%';
                            steeringThumb.style.transform = 'translate(-50%, -50%)';
                        }
                    }
                }
            };
            steeringTrack.addEventListener('touchend', endSteering);
            steeringTrack.addEventListener('touchcancel', endSteering);
        }

        // Helper for hold buttons
        const holdButton = (el, flag) => {
            if (!el) return;
            el.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this[flag] = true;
                el.classList.add('pressed');
            });
            const end = () => { this[flag] = false; el.classList.remove('pressed'); };
            el.addEventListener('touchend', end);
            el.addEventListener('touchcancel', end);
        };

        holdButton(btnGas, '_touchGas');
        holdButton(btnBrake, '_touchBrake');
        holdButton(btnEbrake, '_touchHandbrake');
        holdButton(btnClutch, '_touchClutch');

        // Edge-triggered touch buttons
        const edgeButton = (el, flag) => {
            if (!el) return;
            el.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this[flag] = true;
                el.classList.add('pressed');
            });
            const end = () => { el.classList.remove('pressed'); };
            el.addEventListener('touchend', end);
            el.addEventListener('touchcancel', end);
        };

        edgeButton(btnShiftUp, '_touchShiftUp');
        edgeButton(btnShiftDown, '_touchShiftDown');
        edgeButton(btnTransMode, '_touchTransToggle');

        // Toggle buttons for lights
        const toggleButton = (el, prop) => {
            if (!el) return;
            el.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this[prop] = !this[prop];
                el.classList.add('pressed');
                el.classList.toggle('active', this[prop]);
                el.classList.toggle('inactive', !this[prop]);
            });
            const end = () => { el.classList.remove('pressed'); };
            el.addEventListener('touchend', end);
            el.addEventListener('touchcancel', end);
        };

        toggleButton(btnHeadlights, 'headlights');
        toggleButton(btnHighBeams, 'highBeams');

        // Set initial visual state
        if (btnHeadlights) {
            btnHeadlights.classList.add('active');
        }
        if (btnHighBeams) {
            btnHighBeams.classList.add('inactive');
        }
    }

    /**
     * Apply deadzone remapping and non-linear response curve to a raw axis value.
     * @param {number} raw  — input in range -1..1 (or 0..1 for unsigned)
     * @param {number} deadZone — fraction of range treated as zero (e.g. 0.12)
     * @param {number} exponent — response curve exponent (>1 = less sensitive near center)
     * @returns {number} processed value with same sign as input
     */
    _applyAnalogCurve(raw, deadZone = 0.12, exponent = 1.6) {
        const sign = Math.sign(raw);
        const abs = Math.abs(raw);
        if (abs < deadZone) return 0;
        const remapped = (abs - deadZone) / (1 - deadZone);
        return sign * Math.pow(remapped, exponent);
    }

    /**
     * Steering-specific sensitivity ramp for thumbstick input.
     * Uses a two-stage curve: gentle near center for precision,
     * then ramps up aggressively for fast turns at full deflection.
     * @param {number} raw — input in range -1..1
     * @param {number} deadZone — fraction treated as zero
     * @returns {number} processed steering value
     */
    _applySteerRamp(raw, deadZone = 0.10) {
        const sign = Math.sign(raw);
        const abs = Math.abs(raw);
        if (abs < deadZone) return 0;
        const remapped = (abs - deadZone) / (1 - deadZone);
        // Two-stage ramp: soft inner zone (0–0.5) with high exponent,
        // aggressive outer zone (0.5–1.0) that accelerates to full lock
        if (remapped <= 0.5) {
            // Inner half: gentle (exponent 2.5 on 0–1 rescaled range)
            const inner = remapped / 0.5;
            return sign * 0.25 * Math.pow(inner, 2.5);
        }
        // Outer half: ramp from 0.25 to 1.0 with exponent 1.5
        const outer = (remapped - 0.5) / 0.5;
        return sign * (0.25 + 0.75 * Math.pow(outer, 1.5));
    }

    setSensitivity(value) {
        this._steerSensitivity = clamp(value, 0.2, 2.0);
    }

    _updateSteering(touchX, track, thumb) {
        const maxDist = this._joystickMaxDist || 150; // px — adapts to UI scale
        const deadZone = 0.12;

        // X axis only (steering) — sensitivity scales the raw input
        const dx = touchX - this._joystickCenter.x;
        const clampedX = clamp(dx, -maxDist, maxDist);
        const adjusted = clamp((clampedX / maxDist) * this._steerSensitivity, -1, 1);
        this._touchSteerTarget = this._applySteerRamp(adjusted, deadZone);

        if (thumb) {
            const pctX = 50 + (clampedX / maxDist) * 40;
            thumb.style.left = pctX + '%';
            thumb.style.transform = 'translate(-50%, -50%)';
        }
    }

    update(dt) {
        // Reset edge triggers
        this.shiftUp = false;
        this.shiftDown = false;
        this.toggleTransmission = false;

        let steer = 0;
        let gas = 0;
        let brake = 0;
        let handbrake = false;
        let boost = false;
        let clutch = false;

        // --- Keyboard ---
        if (this._keys['ArrowLeft'] || this._keys['KeyA']) steer -= 1;
        if (this._keys['ArrowRight'] || this._keys['KeyD']) steer += 1;
        if (this._keys['ArrowUp'] || this._keys['KeyW']) gas = 1;
        if (this._keys['ArrowDown'] || this._keys['KeyS']) brake = 1;
        if (this._keys['Space']) handbrake = true;
        if (this._keys['ShiftLeft'] || this._keys['ShiftRight']) boost = true;
        if (this._keys['KeyC'] || this._keys['ControlLeft']) clutch = true;

        // Edge-triggered keyboard events (set in keydown handler)
        if (this._shiftUpEdge && this._keys['KeyE']) {
            this.shiftUp = true;
            this._shiftUpEdge = false; // consume
        }
        if (this._shiftDownEdge && this._keys['KeyQ']) {
            this.shiftDown = true;
            this._shiftDownEdge = false;
        }
        if (this._transToggleEdge && this._keys['KeyT']) {
            this.toggleTransmission = true;
            this._transToggleEdge = false;
        }

        // --- Mouse steering ---
        if (this._mouseSteering) {
            const sensitivity = 0.002;
            this._mouseSteerValue += this._mouseMovementX * sensitivity;
            this._mouseSteerValue = clamp(this._mouseSteerValue, -1, 1);
            this._mouseSteerValue *= 0.95;
            steer += this._mouseSteerValue;
        }
        this._mouseMovementX = 0;

        // --- Gamepad (analog with deadzone remapping + response curve) ---
        if (this._gamepadIndex !== null) {
            const gamepads = navigator.getGamepads();
            const gp = gamepads[this._gamepadIndex];
            if (gp) {
                // Left stick X — steering with sensitivity ramp
                const lx = gp.axes[0] || 0;
                const steerVal = this._applySteerRamp(lx, 0.10);
                if (steerVal !== 0) steer += steerVal;

                // Right trigger — gas (analog)
                const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
                const gasVal = this._applyAnalogCurve(rt, 0.05, 1.3);
                if (gasVal > 0) gas = Math.max(gas, gasVal);

                // Left trigger — brake (analog)
                const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
                const brakeVal = this._applyAnalogCurve(lt, 0.05, 1.3);
                if (brakeVal > 0) brake = Math.max(brake, brakeVal);

                if (gp.buttons[0] && gp.buttons[0].pressed) handbrake = true;
                if ((gp.buttons[1] && gp.buttons[1].pressed) ||
                    (gp.buttons[5] && gp.buttons[5].pressed)) boost = true;
            }
        }

        // --- Touch ---
        if (this.isTouchDevice) {
            // Smooth touch inputs — lerp toward targets for fluid feel
            const smoothRate = 8;  // higher = faster response (but still smooth)
            const t = 1 - Math.exp(-smoothRate * dt);

            // Steering (X-axis)
            this._touchSteer = lerp(this._touchSteer, this._touchSteerTarget, t);
            if (this._touchSteerTarget === 0 && Math.abs(this._touchSteer) < 0.005) {
                this._touchSteer = 0;
            }
            if (this._touchSteer !== 0) steer += this._touchSteer;

            // Gas/brake from dedicated buttons only
            if (this._touchGas) gas = Math.max(gas, 1);
            if (this._touchBrake) brake = Math.max(brake, 1);

            if (this._touchHandbrake) handbrake = true;
            if (this._touchClutch) clutch = true;
            if (this._touchShiftUp) { this.shiftUp = true; this._touchShiftUp = false; }
            if (this._touchShiftDown) { this.shiftDown = true; this._touchShiftDown = false; }
            if (this._touchTransToggle) { this.toggleTransmission = true; this._touchTransToggle = false; }
        }

        // Washer — held while R pressed
        this.washer = !!(this._keys['KeyR']);

        // Finalize
        this.steer = clamp(steer, -1, 1);
        this.gas = clamp(gas, 0, 1);
        this.brake = clamp(brake, 0, 1);
        this.handbrake = handbrake;
        this.boost = boost;
        this.clutch = clutch;
    }
}
