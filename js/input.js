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

        // Edge-triggered shift events (consumed per frame)
        this.shiftUp = false;
        this.shiftDown = false;
        this.toggleTransmission = false;

        // Wiper toggle tracking
        this._wipersToggle = false;

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
        this._touchSteerTarget = 0;   // raw target from joystick
        this._touchGasAnalog = 0;     // analog gas from joystick Y-axis (0-1)
        this._touchBrakeAnalog = 0;   // analog brake from joystick Y-axis (0-1)
        this._touchGasTarget = 0;
        this._touchBrakeTarget = 0;
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
                 'KeyQ', 'KeyT', 'ControlLeft'].includes(e.code)) {
                e.preventDefault();
            }
        });
        window.addEventListener('keyup', (e) => {
            this._keys[e.code] = false;
            if (e.code === 'KeyF') this._wipersToggle = false;
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

        const joystickBase = document.getElementById('joystick-base');
        const joystickThumb = document.getElementById('joystick-thumb');
        const btnGas = document.getElementById('btn-gas');
        const btnBrake = document.getElementById('btn-brake');
        const btnEbrake = document.getElementById('btn-ebrake');
        const btnClutch = document.getElementById('btn-clutch');
        const btnShiftUp = document.getElementById('btn-shift-up');
        const btnShiftDown = document.getElementById('btn-shift-down');
        const btnTransMode = document.getElementById('btn-trans-mode');

        if (joystickBase) {
            joystickBase.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const touch = e.changedTouches[0];
                this._joystickTouchId = touch.identifier;
                const rect = joystickBase.getBoundingClientRect();
                this._joystickCenter = {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                };
                this._updateJoystick(touch.clientX, touch.clientY, joystickBase, joystickThumb);
            });

            joystickBase.addEventListener('touchmove', (e) => {
                e.preventDefault();
                for (const touch of e.changedTouches) {
                    if (touch.identifier === this._joystickTouchId) {
                        this._updateJoystick(touch.clientX, touch.clientY, joystickBase, joystickThumb);
                    }
                }
            });

            const endJoystick = (e) => {
                for (const touch of e.changedTouches) {
                    if (touch.identifier === this._joystickTouchId) {
                        this._joystickTouchId = null;
                        this._touchSteerTarget = 0;
                        this._touchGasTarget = 0;
                        this._touchBrakeTarget = 0;
                        if (joystickThumb) {
                            joystickThumb.style.transform = 'translate(-50%, -50%)';
                            joystickThumb.style.left = '50%';
                            joystickThumb.style.top = '50%';
                        }
                    }
                }
            };
            joystickBase.addEventListener('touchend', endJoystick);
            joystickBase.addEventListener('touchcancel', endJoystick);
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

    _updateJoystick(touchX, touchY, base, thumb) {
        const maxDist = 140;          // px — max joystick displacement
        const deadZone = 0.12;        // 12% dead zone near center

        // --- X axis (steering) ---
        const dx = touchX - this._joystickCenter.x;
        const clampedX = clamp(dx, -maxDist, maxDist);
        this._touchSteerTarget = this._applyAnalogCurve(clampedX / maxDist, deadZone, 1.6);

        // --- Y axis (gas / brake) ---
        const dy = touchY - this._joystickCenter.y;
        const clampedY = clamp(dy, -maxDist, maxDist);
        const rawY = this._applyAnalogCurve(clampedY / maxDist, deadZone, 1.4);
        // Up (negative Y) = gas, Down (positive Y) = brake
        this._touchGasTarget = rawY < 0 ? -rawY : 0;
        this._touchBrakeTarget = rawY > 0 ? rawY : 0;

        if (thumb) {
            const pctX = 50 + (clampedX / maxDist) * 40;
            const pctY = 50 + (clampedY / maxDist) * 40;
            thumb.style.left = pctX + '%';
            thumb.style.top = pctY + '%';
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
                // Left stick X — steering with deadzone + response curve
                const lx = gp.axes[0] || 0;
                const steerVal = this._applyAnalogCurve(lx, 0.10, 1.6);
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

            // Analog gas/brake from joystick Y-axis (smoothed)
            this._touchGasAnalog = lerp(this._touchGasAnalog, this._touchGasTarget, t);
            this._touchBrakeAnalog = lerp(this._touchBrakeAnalog, this._touchBrakeTarget, t);
            if (this._touchGasTarget === 0 && this._touchGasAnalog < 0.005) this._touchGasAnalog = 0;
            if (this._touchBrakeTarget === 0 && this._touchBrakeAnalog < 0.005) this._touchBrakeAnalog = 0;

            // Joystick Y-axis analog values, or fall back to button (full press)
            gas = Math.max(gas, this._touchGasAnalog);
            brake = Math.max(brake, this._touchBrakeAnalog);
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
