/**
 * Arcade Vehicle Physics
 *
 * Simple but fun car controller with acceleration, braking,
 * steering, and basic interaction with road/sidewalk surfaces.
 */

import * as THREE from 'three';
import { clamp, lerp } from './utils.js';

const MAX_SPEED = 100;          // m/s (~360 km/h)
const BOOST_MAX_SPEED = 140;    // m/s (~504 km/h)
const ACCELERATION = 24;        // m/s^2
const BRAKE_FORCE = 30;         // m/s^2
const DRAG = 0.5;               // natural deceleration
const HANDBRAKE_DRAG = 15;
const STEER_SPEED = 2.5;        // radians/sec at low speed
const STEER_SPEED_HIGH = 1.0;   // radians/sec at high speed
const STEER_RETURN = 5.0;       // how fast steering centers
const MIN_STEER_SPEED = 2;      // need some speed to steer

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
    }

    update(dt, input, roadInfo) {
        // Acceleration / braking
        if (input.gas > 0) {
            const maxSpd = input.boost ? BOOST_MAX_SPEED : MAX_SPEED;
            if (this.speed < maxSpd) {
                this.speed += ACCELERATION * input.gas * dt;
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

        // Handbrake
        if (input.handbrake) {
            this.speed -= Math.sign(this.speed) * HANDBRAKE_DRAG * dt;
            if (Math.abs(this.speed) < 1) this.speed = 0;
        }

        // Drag
        this.speed -= this.speed * DRAG * dt;

        // Surface effects
        if (roadInfo) {
            if (roadInfo.onShoulder) {
                // Rumble strip feel on shoulder
                this.speed *= (1 - 0.3 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.002);
            } else if (roadInfo.onSidewalk) {
                // Bumpy, slower on sidewalk
                this.speed *= (1 - 0.8 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.003);
            } else if (roadInfo.offRoad) {
                // Heavy drag off-road
                this.speed *= (1 - 1.5 * dt);
                this.shakeAmount = Math.max(this.shakeAmount, Math.abs(this.speed) * 0.005);
            }
        }

        // Steering
        const absSpeed = Math.abs(this.speed);
        if (absSpeed > MIN_STEER_SPEED) {
            const speedFactor = clamp(1 - absSpeed / MAX_SPEED, 0, 1);
            const steerRate = lerp(STEER_SPEED_HIGH, STEER_SPEED, speedFactor);
            this.steerAngle += input.steer * steerRate * dt;
        }

        // Return steering to center when no input
        if (Math.abs(input.steer) < 0.1) {
            this.steerAngle -= this.steerAngle * STEER_RETURN * dt;
            if (Math.abs(this.steerAngle) < 0.01) this.steerAngle = 0;
        }

        this.steerAngle = clamp(this.steerAngle, -0.6, 0.6);

        // Apply steering to heading
        if (absSpeed > MIN_STEER_SPEED) {
            const turnFactor = this.speed > 0 ? 1 : -1;
            this.angle += this.steerAngle * (absSpeed / MAX_SPEED) * turnFactor * dt * 3;
        }

        // Move position
        const forward = new THREE.Vector3(
            Math.sin(this.angle), 0, -Math.cos(this.angle)
        );

        this.position.x += forward.x * this.speed * dt;
        this.position.z += forward.z * this.speed * dt;

        // Y position (ride height + sidewalk)
        let targetY = 0.6;
        if (roadInfo && roadInfo.onSidewalk) {
            targetY = 0.6 + 0.15; // curb height
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

    /**
     * Apply an impact shake (from hitting a monster).
     */
    applyImpact(intensity) {
        this.shakeAmount = Math.max(this.shakeAmount, intensity);
        // Slight speed reduction on impact
        this.speed *= 0.95;
    }

    /**
     * Apply tree collision — hard stop, damage scaled by speed, big shake.
     */
    applyTreeImpact(speed) {
        const absSpeed = Math.abs(speed);
        const damage = 15 + (absSpeed / MAX_SPEED) * 10;
        this.health = Math.max(0, this.health - damage);
        this.speed *= 0.05; // near-zero hard stop
        this.shakeAmount = Math.max(this.shakeAmount, 0.5);
    }

    getForward() {
        return new THREE.Vector3(Math.sin(this.angle), 0, -Math.cos(this.angle));
    }

    getRight() {
        return new THREE.Vector3(Math.cos(this.angle), 0, Math.sin(this.angle));
    }
}
