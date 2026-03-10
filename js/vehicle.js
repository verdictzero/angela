/**
 * AWD Vehicle Physics — Bicycle Model
 *
 * Realistic all-wheel-drive physics with:
 *   - Two-axle bicycle model (front/rear slip angles)
 *   - Pacejka-inspired tire force curve (linear → peak → falloff)
 *   - Dynamic weight transfer under acceleration and braking
 *   - AWD power delivery with friction-circle grip limiting on both axles
 *   - Handbrake locks rear wheels for drift initiation
 *   - Counter-steer friendly oversteer dynamics
 *   - Kinematic low-speed blending for parking maneuvers
 */

import * as THREE from 'three';
import { clamp, lerp } from './utils.js';

// ── Vehicle Body ───────────────────────────────────────────────
const MASS = 1250;                  // kg — sporty AWD coupe
const INERTIA = 2400;               // kg·m² yaw moment of inertia
const WHEELBASE = 2.65;             // m front-to-rear axle
const FRONT_DIST = 1.47;            // m CG to front axle
const REAR_DIST = 1.18;             // m CG to rear axle (rear-biased weight)
const CG_HEIGHT = 0.52;             // m center of gravity height
const GRAVITY = 9.81;

// ── Engine / Drivetrain (AWD) ──────────────────────────────────
const MAX_ENGINE_FORCE = 3200;      // N peak total (split across axles) — scaled to match visual scene
const BOOST_ENGINE_MULT = 1.275;    // reduced boost (half the bonus)
const MAX_SPEED = 50;               // m/s (~180 km/h) soft limit — matches visual object speed
const BOOST_MAX_SPEED = 70;
const REVERSE_FORCE_FRAC = 0.30;   // reverse is 30 % of forward power
const AWD_FRONT_SPLIT = 0.40;      // 40% front / 60% rear torque split
const AWD_REAR_SPLIT = 0.60;

// ── Braking ────────────────────────────────────────────────────
const MAX_BRAKE_FORCE = 18000;      // N total
const BRAKE_BIAS_FRONT = 0.62;
const BRAKE_BIAS_REAR = 0.38;

// ── Aerodynamics ───────────────────────────────────────────────
const DRAG_COEFF = 0.42;            // Cd·A·½ρ lumped
const ROLLING_RESISTANCE = 90;      // N constant

// ── Tire Model (Pacejka-lite) ──────────────────────────────────
const CS_FRONT = 145000;            // N/rad cornering stiffness (ultra high-perf tires)
const CS_REAR = 155000;
const MU_FRONT = 2.60;              // peak grip coefficient (maximum traction)
const MU_REAR = 2.55;
const PACEJKA_C = 1.45;             // shape factor (higher = sharper peak)
const GRIP_MIN_FRAC = 0.25;         // minimum lateral grip even when spinning

// Handbrake — dramatically kills rear grip for drift initiation
const HANDBRAKE_REAR_MU = 0.18;

// ── Steering ───────────────────────────────────────────────────
const MAX_STEER_ANGLE = 0.40;       // rad (~23 °) — tighter max angle
const STEER_SPEED_LOW = 2.0;        // rad/s input rate at low speed
const STEER_SPEED_HIGH = 0.8;       // rad/s at high speed
const STEER_RETURN = 5.0;           // self-centering rate
const MIN_STEER_SPEED = 1.0;        // m/s minimum to steer
const DRIFT_STEER_BOOST = 1.3;      // counter-steer responsiveness multiplier

// ── Stability helpers ──────────────────────────────────────────
const YAW_DAMPING = 700;            // N·m·s/rad prevents oscillation
const LOW_SPEED_BLEND = 3.5;        // m/s — below this, blend kinematic model
const LOW_SPEED_LAT_DAMP = 6.0;     // artificial lateral kill at crawl speed

// ── Transmission ───────────────────────────────────────────────
const GEAR_SHIFTS = [0, 4, 9, 15, 23, 32, 42];
const GEAR_COUNT = 7;

// ── Drift detection ────────────────────────────────────────────
const DRIFT_SLIP_THRESHOLD = 0.10;  // rad (~6 °) rear slip to flag "drifting"
const DRIFT_SLIP_MAX = 0.85;        // clamp visual drift angle

// ── Surface friction multipliers ───────────────────────────────
const SURFACE_MU = { road: 1.0, shoulder: 0.75, sidewalk: 0.60, offRoad: 0.45 };

// ────────────────────────────────────────────────────────────────
// Pacejka-lite lateral tire force
//   F = −D · sin(C · atan(B · α))
// where D = peak grip,  B = Cα / (C · D)
// Returns force opposing the slip (negative α → positive force).
// ────────────────────────────────────────────────────────────────
function tireLateral(alpha, cAlpha, peakGrip) {
    if (peakGrip < 1) return 0;
    const B = cAlpha / (PACEJKA_C * peakGrip);
    return -peakGrip * Math.sin(PACEJKA_C * Math.atan(B * alpha));
}

// ════════════════════════════════════════════════════════════════
export class Vehicle {
    constructor() {
        this.position = new THREE.Vector3(0, 0.6, 0);
        this.angle = 0;              // heading (rad, CW from −Z)

        // ── Body-frame velocities ──────────────────────────────
        this.vForward = 0;           // m/s along heading (+forward)
        this.vLateral = 0;           // m/s perpendicular (+right)
        this.yawRate = 0;            // rad/s (+CW / right turn)

        // ── Public compat (used by HUD, cockpit, camera, NPCs) ─
        this.speed = 0;
        this.steerAngle = 0;
        this.velocity = new THREE.Vector3();

        // Health
        this.health = 100;

        // Shake
        this.shakeAmount = 0;
        this.shakeOffset = new THREE.Vector3();

        // HUD
        this.speedKmh = 0;

        // Drift state — derived each frame from actual tire slip
        this.driftAngle = 0;
        this.drifting = false;

        // Transmission
        this.manualMode = false;
        this.currentGear = 1;
        this.clutchHeld = false;

        // Engine
        this.engineRunning = true;
        this.engineStalled = false;
        this._wasMoving = false;
    }

    // ── Transmission helpers (unchanged API) ───────────────────

    shiftUp() {
        if (this.currentGear < GEAR_COUNT) {
            if (this.manualMode && !this.clutchHeld) { this.stallEngine(); return; }
            this.currentGear++;
        }
    }

    shiftDown() {
        if (this.currentGear > 1) {
            if (this.manualMode && !this.clutchHeld) { this.stallEngine(); return; }
            this.currentGear--;
        }
    }

    stallEngine() {
        if (!this.engineRunning) return;
        this.engineRunning = false;
        this.engineStalled = true;
        this.vForward *= 0.3;
    }

    startEngine() {
        this.engineRunning = true;
        this.engineStalled = false;
    }

    toggleTransmission() {
        this.manualMode = !this.manualMode;
    }

    getGear() {
        if (!this.manualMode) {
            const s = Math.abs(this.vForward);
            let gear = 1;
            for (let i = GEAR_SHIFTS.length - 1; i >= 1; i--) {
                if (s >= GEAR_SHIFTS[i]) { gear = i + 1; break; }
            }
            this.currentGear = gear;
            return gear;
        }
        return this.currentGear;
    }

    _getGearEfficiency() {
        if (this.clutchHeld) return 0;
        if (!this.manualMode) return 1;
        const s = Math.abs(this.vForward);
        const idx = this.currentGear - 1;
        const lo = GEAR_SHIFTS[idx];
        const hi = idx + 1 < GEAR_SHIFTS.length ? GEAR_SHIFTS[idx + 1] : MAX_SPEED;
        if (s < lo * 0.5) return 0.3;
        if (s > hi * 1.3) return 0.5;
        return 1.0;
    }

    // ── Main physics tick ──────────────────────────────────────

    update(dt, input, roadInfo) {
        this.engineStalled = false;

        const gear = this.getGear();
        const gearEff = this._getGearEfficiency();
        this.clutchHeld = input.clutch;

        // Stall-on-stop in manual
        if (this.engineRunning && this.manualMode && !this.clutchHeld
            && this._wasMoving && Math.abs(this.vForward) < 0.5) {
            this.stallEngine();
        }

        const absVf = Math.abs(this.vForward);

        // ── Surface grip ────────────────────────────────────────
        let surfaceMu = SURFACE_MU.road;
        if (roadInfo) {
            if (roadInfo.offRoad)       surfaceMu = SURFACE_MU.offRoad;
            else if (roadInfo.onSidewalk) surfaceMu = SURFACE_MU.sidewalk;
            else if (roadInfo.onShoulder) surfaceMu = SURFACE_MU.shoulder;
        }

        // ── Desired engine & brake forces ───────────────────────
        let engineForce = 0;
        if (input.gas > 0 && !this.clutchHeld && this.engineRunning) {
            const maxSpd = input.boost ? BOOST_MAX_SPEED : MAX_SPEED;
            const boostM = input.boost ? BOOST_ENGINE_MULT : 1.0;
            if (this.vForward < maxSpd) {
                engineForce = MAX_ENGINE_FORCE * input.gas * gearEff * boostM;
            }
        }

        let brakeInput = input.brake;
        let reverseForce = 0;
        // Brake → reverse when nearly stopped
        if (input.brake > 0 && this.vForward < 1.0
            && this.engineRunning && !this.clutchHeld) {
            reverseForce = MAX_ENGINE_FORCE * REVERSE_FORCE_FRAC * input.brake * gearEff;
            if (this.vForward < 0.5) brakeInput = 0;
        }

        const totalBrake = MAX_BRAKE_FORCE * brakeInput;

        // ── Weight transfer ─────────────────────────────────────
        const netLong = engineForce - totalBrake * Math.sign(Math.max(this.vForward, 0.01));
        const wt = clamp(
            MASS * (netLong / MASS) * CG_HEIGHT / WHEELBASE,
            -MASS * GRAVITY * 0.35,
             MASS * GRAVITY * 0.35
        );
        const wFront = Math.max(200, MASS * GRAVITY * REAR_DIST / WHEELBASE - wt);
        const wRear  = Math.max(200, MASS * GRAVITY * FRONT_DIST / WHEELBASE + wt);

        // ── Slip angles ─────────────────────────────────────────
        // Guard against near-zero forward speed
        const vfSafe = Math.max(absVf, 0.5);
        // Ramp tire forces from 0→1 over 0.5→LOW_SPEED_BLEND m/s
        const dynBlend = clamp((absVf - 0.5) / (LOW_SPEED_BLEND - 0.5), 0, 1);

        let alphaF = 0, alphaR = 0;
        if (absVf > 0.5) {
            const signVf = this.vForward >= 0 ? 1 : -1;
            alphaF = Math.atan2(
                this.vLateral + FRONT_DIST * this.yawRate, vfSafe
            ) - this.steerAngle * signVf;
            alphaR = Math.atan2(
                this.vLateral - REAR_DIST * this.yawRate, vfSafe
            );
        }

        // ── Peak grip budgets ───────────────────────────────────
        const gripF = wFront * MU_FRONT * surfaceMu;
        const rearMu = input.handbrake ? HANDBRAKE_REAR_MU : MU_REAR;
        const gripR = wRear * rearMu * surfaceMu;

        // ── Lateral tire forces (Pacejka-lite) ──────────────────
        let fLatF = tireLateral(alphaF, CS_FRONT, gripF) * dynBlend;
        let fLatR = tireLateral(alphaR, CS_REAR, gripR) * dynBlend;

        // ── Friction circle (AWD — both axles) ────────────────────
        // Split drive force between front and rear axles
        const driveF = engineForce * AWD_FRONT_SPLIT;
        const driveR = engineForce * AWD_REAR_SPLIT;

        const clampedDriveF = clamp(driveF, 0, gripF);
        const clampedDriveR = clamp(driveR, 0, gripR);

        // Front friction circle
        const usageFracF = clampedDriveF / Math.max(gripF, 1);
        const latBudgetF = gripF * Math.max(
            GRIP_MIN_FRAC,
            Math.sqrt(Math.max(0, 1 - usageFracF * usageFracF))
        );
        fLatF = clamp(fLatF, -latBudgetF, latBudgetF);

        // Rear friction circle
        const usageFracR = clampedDriveR / Math.max(gripR, 1);
        const latBudgetR = gripR * Math.max(
            GRIP_MIN_FRAC,
            Math.sqrt(Math.max(0, 1 - usageFracR * usageFracR))
        );
        fLatR = clamp(fLatR, -latBudgetR, latBudgetR);

        // ── Longitudinal forces ─────────────────────────────────
        // Drive (AWD — both axles)
        let fDrive = clampedDriveF + clampedDriveR;
        if (reverseForce > 0) fDrive = -reverseForce;

        // Braking
        let fBrakeF = 0, fBrakeR = 0;
        if (brakeInput > 0 && absVf > 0.3) {
            const s = Math.sign(this.vForward);
            fBrakeF = -s * totalBrake * BRAKE_BIAS_FRONT;
            fBrakeR = -s * totalBrake * BRAKE_BIAS_REAR;
        }

        // Handbrake extra longitudinal drag
        if (input.handbrake && absVf > 0.3) {
            fBrakeR -= Math.sign(this.vForward) * wRear * MU_REAR * 0.55;
        }

        // Aero drag (∝ v²) + rolling resistance
        const fDrag = -DRAG_COEFF * this.vForward * absVf;
        const fRoll = absVf > 0.3
            ? -Math.sign(this.vForward) * ROLLING_RESISTANCE : 0;

        // ── Sum forces (body frame) ─────────────────────────────
        const cosD = Math.cos(this.steerAngle);
        const sinD = Math.sin(this.steerAngle);

        // Forward (along heading)
        const Fx = fDrive + fBrakeF + fBrakeR + fDrag + fRoll
                 - fLatF * sinD;   // lateral-to-longitudinal from steered wheels

        // Lateral (perpendicular, +right)
        const Fy = fLatF * cosD + fLatR;

        // ── Yaw torque ──────────────────────────────────────────
        // Front lateral → turning torque, rear lateral → restoring torque
        const Mz = (fLatF * cosD) * FRONT_DIST - fLatR * REAR_DIST;
        const yawDamp = -YAW_DAMPING * this.yawRate;

        // ── Integrate (rotating body frame) ─────────────────────
        // m·(dvx − vy·r) = Fx  →  dvx = Fx/m + vy·r
        // m·(dvy + vx·r) = Fy  →  dvy = Fy/m − vx·r
        // I·dr = Mz + damping
        const ax = Fx / MASS + this.vLateral * this.yawRate;
        const ay = Fy / MASS - this.vForward * this.yawRate;
        const ar = (Mz + yawDamp) / INERTIA;

        this.vForward += ax * dt;
        this.vLateral += ay * dt;
        this.yawRate  += ar * dt;

        // ── Low-speed kinematic blending ────────────────────────
        // Below LOW_SPEED_BLEND, fade in an Ackermann-based yaw rate
        // so the car steers naturally in a parking lot.
        if (absVf > MIN_STEER_SPEED && absVf < LOW_SPEED_BLEND) {
            const kinYaw = this.vForward * Math.tan(this.steerAngle) / WHEELBASE;
            const t = 1 - clamp(
                (absVf - MIN_STEER_SPEED) / (LOW_SPEED_BLEND - MIN_STEER_SPEED), 0, 1
            );
            this.yawRate = lerp(this.yawRate, kinYaw, t * 8 * dt);
        }

        // Damp lateral velocity & yaw at very low speed
        if (absVf < LOW_SPEED_BLEND) {
            const k = 1 - (1 - absVf / LOW_SPEED_BLEND) * LOW_SPEED_LAT_DAMP * dt;
            const d = Math.max(0, k);
            this.vLateral *= d;
            // Lighter yaw damping so parking-speed turns still work
            this.yawRate *= Math.max(0, 1 - (1 - absVf / LOW_SPEED_BLEND) * 2.0 * dt);
        }

        // ── Velocity clamp ──────────────────────────────────────
        const totalV = Math.sqrt(this.vForward * this.vForward + this.vLateral * this.vLateral);
        const vCap = (input.boost ? BOOST_MAX_SPEED : MAX_SPEED) * 1.1;
        if (totalV > vCap) {
            const s = vCap / totalV;
            this.vForward *= s;
            this.vLateral *= s;
        }

        // Clean stop
        if (absVf < 0.25 && Math.abs(this.vLateral) < 0.25
            && input.gas === 0 && input.brake === 0 && reverseForce === 0) {
            this.vForward *= 0.90;
            this.vLateral *= 0.90;
            this.yawRate  *= 0.90;
            if (Math.abs(this.vForward) < 0.05) this.vForward = 0;
            if (Math.abs(this.vLateral) < 0.05) this.vLateral = 0;
            if (Math.abs(this.yawRate) < 0.005) this.yawRate = 0;
        }

        // ── Heading update ──────────────────────────────────────
        this.angle += this.yawRate * dt;

        // ── World-space position ────────────────────────────────
        const sinA = Math.sin(this.angle);
        const cosA = Math.cos(this.angle);
        // Forward dir = (sinA, 0, −cosA),  Right dir = (cosA, 0, sinA)
        const worldVx = this.vForward * sinA + this.vLateral * cosA;
        const worldVz = -this.vForward * cosA + this.vLateral * sinA;

        this.position.x += worldVx * dt;
        this.position.z += worldVz * dt;

        // Ride height (+ sidewalk curb bump)
        let targetY = 0.6;
        if (roadInfo && roadInfo.onSidewalk) targetY = 0.75;
        this.position.y = lerp(this.position.y, targetY, 10 * dt);

        // ── Steering input ──────────────────────────────────────
        if (absVf > MIN_STEER_SPEED) {
            const speedFrac = clamp(1 - absVf / MAX_SPEED, 0, 1);
            let steerRate = lerp(STEER_SPEED_HIGH, STEER_SPEED_LOW, speedFrac);
            if (this.drifting) steerRate *= DRIFT_STEER_BOOST;
            this.steerAngle += input.steer * steerRate * dt;
        }

        // Self-centering
        if (Math.abs(input.steer) < 0.1) {
            this.steerAngle -= this.steerAngle * STEER_RETURN * dt;
            if (Math.abs(this.steerAngle) < 0.01) this.steerAngle = 0;
        }
        this.steerAngle = clamp(this.steerAngle, -MAX_STEER_ANGLE, MAX_STEER_ANGLE);

        // ── Derived public state ────────────────────────────────
        this.speed = this.vForward;
        this.velocity.set(worldVx, 0, worldVz);
        this.speedKmh = Math.abs(Math.round(this.vForward * 3.6));

        // Drift detection — from actual rear tire slip
        const absRearSlip = Math.abs(alphaR);
        this.drifting = absRearSlip > DRIFT_SLIP_THRESHOLD && absVf > 4;
        this.driftAngle = clamp(alphaR, -DRIFT_SLIP_MAX, DRIFT_SLIP_MAX);

        // ── Shake ───────────────────────────────────────────────
        // Surface rumble
        if (roadInfo) {
            if (roadInfo.onShoulder)
                this.shakeAmount = Math.max(this.shakeAmount, absVf * 0.002);
            else if (roadInfo.onSidewalk)
                this.shakeAmount = Math.max(this.shakeAmount, absVf * 0.003);
            else if (roadInfo.offRoad)
                this.shakeAmount = Math.max(this.shakeAmount, absVf * 0.005);
        }
        // Tire slip shake
        if (this.drifting) {
            this.shakeAmount = Math.max(this.shakeAmount, absRearSlip * 0.25);
        }
        // Shake decay
        this.shakeAmount *= Math.max(0, 1 - 5 * dt);
        this.shakeOffset.set(
            (Math.random() - 0.5) * this.shakeAmount,
            (Math.random() - 0.5) * this.shakeAmount * 0.5,
            (Math.random() - 0.5) * this.shakeAmount * 0.3
        );

        this._wasMoving = Math.abs(this.vForward) > 1.0;
    }

    // ── Impacts (unchanged API) ────────────────────────────────

    applyImpact(intensity) {
        this.shakeAmount = Math.max(this.shakeAmount, intensity);
        this.vForward *= 0.95;
    }

    applyTreeImpact(speed) {
        const absSpeed = Math.abs(speed);
        const damage = 15 + (absSpeed / MAX_SPEED) * 10;
        this.health = Math.max(0, this.health - damage);
        this.vForward *= 0.05;
        this.vLateral *= 0.3;
        this.yawRate  *= 0.3;
        this.shakeAmount = Math.max(this.shakeAmount, 0.5);
    }

    getForward() {
        return new THREE.Vector3(Math.sin(this.angle), 0, -Math.cos(this.angle));
    }

    getRight() {
        return new THREE.Vector3(Math.cos(this.angle), 0, Math.sin(this.angle));
    }
}
