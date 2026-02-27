/**
 * Day/Night Cycle System
 *
 * Smoothly transitions through dawn → day → dusk → night.
 * Controls sky color, fog, ambient/directional lighting,
 * headlight intensity, and stars.
 */

import * as THREE from 'three';
import { lerp, clamp, smoothstep } from './utils.js';

// Cycle duration in seconds (one full day)
const CYCLE_DURATION = 300; // 5 minutes

// Time phases (0 to 1)
const NIGHT_END = 0.20;
const DAWN_END = 0.30;
const DAY_END = 0.70;
const DUSK_END = 0.80;
// NIGHT again from 0.80 to 1.0 (and 0.0 to 0.20)

// Color presets
const COLORS = {
    night: {
        sky: new THREE.Color(0x060610),
        fog: new THREE.Color(0x050508),
        sun: new THREE.Color(0x1a2244),
        ambient: new THREE.Color(0x0a0a18),
        hemiSky: new THREE.Color(0x0a0a20),
        hemiGround: new THREE.Color(0x050508),
    },
    dawn: {
        sky: new THREE.Color(0xdd7744),
        fog: new THREE.Color(0x885544),
        sun: new THREE.Color(0xffaa66),
        ambient: new THREE.Color(0x554433),
        hemiSky: new THREE.Color(0xcc8855),
        hemiGround: new THREE.Color(0x332211),
    },
    day: {
        sky: new THREE.Color(0x5599cc),
        fog: new THREE.Color(0x8899aa),
        sun: new THREE.Color(0xffeedd),
        ambient: new THREE.Color(0x445566),
        hemiSky: new THREE.Color(0x6699bb),
        hemiGround: new THREE.Color(0x333322),
    },
    dusk: {
        sky: new THREE.Color(0xcc5533),
        fog: new THREE.Color(0x664433),
        sun: new THREE.Color(0xff7744),
        ambient: new THREE.Color(0x443322),
        hemiSky: new THREE.Color(0xbb6644),
        hemiGround: new THREE.Color(0x221111),
    }
};

const INTENSITY = {
    night: { ambient: 0.3, sun: 0.15, hemi: 0.2, headlight: 50, fogNear: 30, fogFar: 180 },
    dawn:  { ambient: 0.8, sun: 0.7,  hemi: 0.5, headlight: 15, fogNear: 60, fogFar: 280 },
    day:   { ambient: 1.5, sun: 1.4,  hemi: 0.9, headlight: 5,  fogNear: 100, fogFar: 400 },
    dusk:  { ambient: 0.6, sun: 0.5,  hemi: 0.4, headlight: 25, fogNear: 50, fogFar: 250 },
};

export class DayNightCycle {
    constructor(scene) {
        this.scene = scene;
        this.time = 0.35; // Start in early daytime
        this.speed = 1.0 / CYCLE_DURATION;

        // Stars
        this._stars = this._createStars();
        this.scene.add(this._stars);

        // Sun direction helper (for directional light positioning)
        this._sunAngle = 0;

        // Current interpolated values (exposed for external reads)
        this.currentColors = {
            sky: new THREE.Color(),
            fog: new THREE.Color(),
        };
        this.currentIntensity = { ...INTENSITY.day };
        this.isNight = false;
    }

    _createStars() {
        const count = 800;
        const positions = new Float32Array(count * 3);
        const radius = 400;

        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(Math.random() * 0.8 + 0.2); // upper hemisphere mostly
            positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = radius * Math.cos(phi);
            positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 1.5,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0,
            fog: false,
        });

        return new THREE.Points(geo, mat);
    }

    /**
     * Get the interpolation factor between two phases.
     */
    _getPhaseBlend(time) {
        // Returns { phaseA, phaseB, t } for smooth blending
        if (time < NIGHT_END) {
            // Night
            return { a: 'night', b: 'night', t: 0 };
        } else if (time < DAWN_END) {
            // Night → Dawn
            const t = smoothstep(NIGHT_END, DAWN_END, time);
            return { a: 'night', b: 'dawn', t };
        } else if (time < (DAWN_END + DAY_END) / 2) {
            // Dawn → Day
            const t = smoothstep(DAWN_END, (DAWN_END + DAY_END) / 2, time);
            return { a: 'dawn', b: 'day', t };
        } else if (time < DAY_END) {
            // Day
            return { a: 'day', b: 'day', t: 0 };
        } else if (time < DUSK_END) {
            // Day → Dusk
            const t = smoothstep(DAY_END, DUSK_END, time);
            return { a: 'day', b: 'dusk', t };
        } else if (time < (DUSK_END + 1.0) / 2) {
            // Dusk → Night
            const t = smoothstep(DUSK_END, (DUSK_END + 1.0) / 2, time);
            return { a: 'dusk', b: 'night', t };
        } else {
            // Night
            return { a: 'night', b: 'night', t: 0 };
        }
    }

    _lerpColor(target, colorA, colorB, t) {
        target.copy(colorA).lerp(colorB, t);
    }

    _lerpIntensity(keyA, keyB, t) {
        const a = INTENSITY[keyA];
        const b = INTENSITY[keyB];
        const result = {};
        for (const key of Object.keys(a)) {
            result[key] = lerp(a[key], b[key], t);
        }
        return result;
    }

    /**
     * Update cycle. Call every frame.
     * Returns current state for external systems.
     */
    update(dt, ambientLight, dirLight, hemiLight, fog, scene) {
        this.time += this.speed * dt;
        if (this.time >= 1.0) this.time -= 1.0;

        const phase = this._getPhaseBlend(this.time);
        const cA = COLORS[phase.a];
        const cB = COLORS[phase.b];
        const t = phase.t;

        // Interpolate colors
        this._lerpColor(this.currentColors.sky, cA.sky, cB.sky, t);
        this._lerpColor(this.currentColors.fog, cA.fog, cB.fog, t);

        // Apply to scene
        scene.background.copy(this.currentColors.sky);
        fog.color.copy(this.currentColors.fog);

        // Interpolate and apply intensities
        this.currentIntensity = this._lerpIntensity(phase.a, phase.b, t);

        // Ambient light
        const ambColor = new THREE.Color();
        this._lerpColor(ambColor, cA.ambient, cB.ambient, t);
        ambientLight.color.copy(ambColor);
        ambientLight.intensity = this.currentIntensity.ambient;

        // Directional light (sun/moon)
        const sunColor = new THREE.Color();
        this._lerpColor(sunColor, cA.sun, cB.sun, t);
        dirLight.color.copy(sunColor);
        dirLight.intensity = this.currentIntensity.sun;

        // Animate sun position across the sky
        this._sunAngle = this.time * Math.PI * 2;
        const sunHeight = Math.sin(this._sunAngle - Math.PI * 0.3);
        dirLight.position.set(
            Math.cos(this._sunAngle) * 80,
            Math.max(10, sunHeight * 100 + 30),
            Math.sin(this._sunAngle) * 60 - 30
        );

        // Hemisphere light
        const hemiSkyColor = new THREE.Color();
        const hemiGroundColor = new THREE.Color();
        this._lerpColor(hemiSkyColor, cA.hemiSky, cB.hemiSky, t);
        this._lerpColor(hemiGroundColor, cA.hemiGround, cB.hemiGround, t);
        hemiLight.color.copy(hemiSkyColor);
        hemiLight.groundColor.copy(hemiGroundColor);
        hemiLight.intensity = this.currentIntensity.hemi;

        // Fog distances
        fog.near = this.currentIntensity.fogNear;
        fog.far = this.currentIntensity.fogFar;

        // Stars visibility
        const nightness = this._getNightness();
        this._stars.material.opacity = nightness;
        this._stars.visible = nightness > 0.01;

        // Update star dome position to follow camera (done in main.js via getStarDome)

        this.isNight = nightness > 0.5;

        return this.currentIntensity;
    }

    /**
     * Get how "night" it currently is (0 = full day, 1 = full night).
     */
    _getNightness() {
        if (this.time < NIGHT_END) return 1;
        if (this.time < DAWN_END) return 1 - smoothstep(NIGHT_END, DAWN_END, this.time);
        if (this.time < DAY_END) return 0;
        if (this.time < DUSK_END) return smoothstep(DAY_END, DUSK_END, this.time);
        return 1;
    }

    /**
     * Get the star dome mesh (for repositioning).
     */
    getStarDome() {
        return this._stars;
    }

    /**
     * Get a human-readable time string.
     */
    getTimeString() {
        const hours = Math.floor(this.time * 24);
        const minutes = Math.floor((this.time * 24 - hours) * 60);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }

    /**
     * Get phase name for HUD display.
     */
    getPhaseName() {
        if (this.time < NIGHT_END) return 'NIGHT';
        if (this.time < DAWN_END) return 'DAWN';
        if (this.time < DAY_END) return 'DAY';
        if (this.time < DUSK_END) return 'DUSK';
        return 'NIGHT';
    }
}
