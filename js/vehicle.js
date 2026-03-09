/**
 * Arcade Vehicle Physics
 *
 * Simple but fun car controller with acceleration, braking,
 * steering, drift mechanics, and manual/auto transmission.
 */

import * as THREE from 'three';
import { clamp, lerp } from './utils.js';

const MAX_SPEED = 100;          // m/s (~360 km/h)
const BOOST_MAX_SPEED = 140;    // m/s (~504 km/h)
const ACCELERATION = 24;        // m/s^2
const BRAKE_FORCE = 30;         // m/s^2
const DRAG = 0.25;              // natural deceleration (terminal ~96 m/s)
const HANDBRAKE_DRAG = 8;       // reduced — drift bleeds speed more gently
const STEER_SPEED = 2.5;        // radians/sec at low speed
const STEER_SPEED_HIGH = 1.0;   // radians/sec at high speed
const STEER_RETURN = 5.0;       // how fast steering centers
const MIN_STEER_SPEED = 2;      // need some speed to steer

// Drift constants
const DRIFT_BUILDUP = 3.0;      // how fast drift angle builds
const DRIFT_MAX_ANGLE = 0.7;    // max radians of drift slip angle
const DRIFT_RECOVERY = 2.5;     // how fast drift recovers when e-brake released
const DRIFT_STEER_BOOST = 1.8;  // steering multiplier during drift
const DRIFT_MIN_SPEED = 8;      // minimum speed to initiate drift

// Transmission — 7-speed gear thresholds in m/s
const GEAR_SHIFTS = [0, 8, 18, 30, 45, 62, 80];
const GEAR_COUNT = 7;

export class Vehicle {
    constructor() {
        this.position = new THREE.Vector3(0, 0.6, 0);
        this.angle = 0;             // Y-axis rotation (heading)
        this.speed = 0;             // forward speed (m/s)
        this.steerAngle = 0;       // current wheel angle
        this.velocity = new THREE.Vector3();

        // Health
        this.health = 100;

        // Shake
        this.shakeAmount = 0;
        this.shakeOffset = new THREE.Vector3();

        // For HUD
        this.speedKmh = 0;

        // Drift state
        this.driftAngle = 0;        // current slip angle (radians)
        this.drifting = false;       // is the car actively drifting

        // Transmission
        this.manualMode = false;     // false = auto, true = manual
        this.currentGear = 1;       // 1-7 (used in manual mode)
        this.clutchHeld = false;     // clutch pedal state
    }

    shiftUp() {
        if (this.currentGear < GEAR_COUNT) this.currentGear++;
    }

    shiftDown() {
        if (this.currentGear > 1) this.currentGear--;
    }

    toggleTransmission() {
        this.manualMode = !this.manualMode;
    }

    /**
     * Get current gear — auto selects by speed, manual uses currentGear.
     */
    getGear() {
        if (!this.manualMode) {
            const absSpeed = Math.abs(this.speed);
            let gear = 1;
            for (let i = GEAR_SHIFTS.length - 1; i >= 1; i--) {
                if (absSpeed >= GEAR_SHIFTS[i]) {
                    gear = i + 1;
                    break;
                }
            }
            this.currentGear = gear;
            return gear;
        }
        return this.currentGear;
    }

    /**
     * Get acceleration multiplier based on gear/speed mismatch in manual mode.
     * In auto mode, always returns 1.
     */
    _getGearEfficiency() {
        if (!this.manualMode || this.clutchHeld) return this.clutchHeld ? 0 : 1;

        const absSpeed = Math.abs(this.speed);
        const gearIdx = this.currentGear - 1;
        const lo = GEAR_SHIFTS[gearIdx];
        const hi = gearIdx + 1 < GEAR_SHIFTS.length ? GEAR_SHIFTS[gearIdx + 1] : MAX_SPEED;

        // Efficiency drops if speed is way outside this gear's range
        if (absSpeed < lo * 0.5) return 0.3;  // too high a gear for this speed
        if (absSpeed > hi * 1.3) return 0.5;  // over-revving
        return 1.0;
    }

    update(dt, input, roadInfo) {
        const gear = this.getGear();
        const gearEff = this._getGearEfficiency();

        // Acceleration / braking
        if (input.gas > 0 && !this.clutchHeld) {
            const maxSpd = input.boost ? BOOST_MAX_SPEED : MAX_SPEED;
            if (this.speed < maxSpd) {
                this.speed += ACCELERATION * input.gas * gearEff * dt;
            }
        }

        if (input.brake > 0) {
            if (this.speed > 0) {
                this.speed -= BRAKE_FORCE * input.brake * dt;
                if (this.speed < 0) this.speed = 0;
            } else {
                // Reverse
                this.speed -= ACCELERATION * 0.4 * input.brake * dt;
                this.speed = Math.max(this.speed, -MAX_SPEED * 0.3);
            }
        }

        // Clutch — engine disconnected, only drag slows you
        this.clutchHeld = input.clutch;

        // ── Drift / E-brake ──────────────────────────────────
        const absSpeed = Math.abs(this.speed);
        const wasDrifting = this.drifting;

        if (input.handbrake && absSpeed > DRIFT_MIN_SPEED) {
            // E-brake engaged: build drift angle based on steering
            this.drifting = true;
            const steerInfluence = this.steerAngle * DRIFT_BUILDUP * dt;
            this.driftAngle += steerInfluence;
            this.driftAngle = clamp(this.driftAngle, -DRIFT_MAX_ANGLE, DRIFT_MAX_ANGLE);

            // Slower speed bleed during drift (feels like sliding, not braking)
            this.speed -= Math.sign(this.speed) * HANDBRAKE_DRAG * dt;
            if (Math.abs(this.speed) < 1) this.speed = 0;

            // Shake during drift
            this.shakeAmount = Math.max(this.shakeAmount, absSpeed * 0.002);
        } else {
            // Recover drift angle toward zero
            if (Math.abs(this.driftAngle) > 0.01) {
                this.driftAngle = lerp(this.driftAngle, 0, DRIFT_RECOVERY * dt);
            } else {
                this.driftAngle = 0;
                this.drifting = false;
            }

            // Normal handbrake (at low speed or no steering)
            if (input.handbrake) {
                this.speed -= Math.sign(this.speed) * HANDBRAKE_DRAG * 2 * dt;
                if (Math.abs(this.speed) < 1) this.speed = 0;
            }
        }

        // Drag
        this.speed -= this.speed * DRAG * dt;

        // Surface effects
        if (roadInfo) {
            if (roadInfo.onShoulder) {
                this.speed *= (1 - 0.3 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.002);
            } else if (roadInfo.onSidewalk) {
                this.speed *= (1 - 0.8 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.003);
            } else if (roadInfo.offRoad) {
                this.speed *= (1 - 1.5 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.005);
            }
        }

        // Steering
        if (absSpeed > MIN_STEER_SPEED) {
            const speedFactor = clamp(1 - absSpeed / MAX_SPEED, 0, 1);
            let steerRate = lerp(STEER_SPEED_HIGH, STEER_SPEED, speedFactor);
            // Boost steering during drift for better control
            if (this.drifting) steerRate *= DRIFT_STEER_BOOST;
            this.steerAngle += input.steer * steerRate * dt;
        }

        // Return steering to center when no input
        if (Math.abs(input.steer) < 0.1) {
            this.steerAngle -= this.steerAngle * STEER_RETURN * dt;
            if (Math.abs(this.steerAngle) < 0.01) this.steerAngle = 0;
        }

        this.steerAngle = clamp(this.steerAngle, -0.6, 0.6);

        // Apply steering + drift to heading
        if (absSpeed > MIN_STEER_SPEED) {
            const turnFactor = this.speed > 0 ? 1 : -1;
            // Normal steering turn
            let turnRate = this.steerAngle * (absSpeed / MAX_SPEED) * turnFactor * dt * 3;
            // Drift adds extra rotation from the slip angle
            if (this.drifting) {
                turnRate += this.driftAngle * dt * 2;
            }
            this.angle += turnRate;
        }

        // ── Movement ─────────────────────────────────────────
        const forward = new THREE.Vector3(
            Math.sin(this.angle), 0, -Math.cos(this.angle)
        );

        // During drift, movement is a blend of heading and drift direction
        if (this.drifting && Math.abs(this.driftAngle) > 0.01) {
            const driftDir = new THREE.Vector3(
                Math.sin(this.angle - this.driftAngle), 0,
                -Math.cos(this.angle - this.driftAngle)
            );
            const blendedDir = forward.clone().lerp(driftDir, Math.abs(this.driftAngle) / DRIFT_MAX_ANGLE * 0.6);
            blendedDir.normalize();
            this.position.x += blendedDir.x * this.speed * dt;
            this.position.z += blendedDir.z * this.speed * dt;
        } else {
            this.position.x += forward.x * this.speed * dt;
            this.position.z += forward.z * this.speed * dt;
        }

        // Y position (ride height + sidewalk)
        let targetY = 0.6;
        if (roadInfo && roadInfo.onSidewalk) {
            targetY = 0.6 + 0.15;
        }
        this.position.y = lerp(this.position.y, targetY, 10 * dt);

        // Update velocity for external use
        this.velocity.copy(forward).multiplyScalar(this.speed);

        // Speed for HUD
        this.speedKmh = Math.abs(Math.round(this.speed * 3.6));

        // Shake decay
        this.shakeAmount *= Math.max(0, 1 - 5 * dt);
        this.shakeOffset.set(
            (Math.random() - 0.5) * this.shakeAmount,
            (Math.random() - 0.5) * this.shakeAmount * 0.5,
            (Math.random() - 0.5) * this.shakeAmount * 0.3
        );
    }

    applyImpact(intensity) {
        this.shakeAmount = Math.max(this.shakeAmount, intensity);
        this.speed *= 0.95;
    }

    applyTreeImpact(speed) {
        const absSpeed = Math.abs(speed);
        const damage = 15 + (absSpeed / MAX_SPEED) * 10;
        this.health = Math.max(0, this.health - damage);
        this.speed *= 0.05;
        this.shakeAmount = Math.max(this.shakeAmount, 0.5);
    }

    getForward() {
        return new THREE.Vector3(Math.sin(this.angle), 0, -Math.cos(this.angle));
    }

    getRight() {
        return new THREE.Vector3(Math.cos(this.angle), 0, Math.sin(this.angle));
    }
}
