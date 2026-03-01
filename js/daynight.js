/**
 * Day/Night Cycle System
 *
 * Smoothly transitions through dawn → day → dusk → night.
 * Controls sky color, fog, ambient/directional lighting,
 * headlight intensity, stars, and visible sun/moon.
 */

import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { lerp, clamp, smoothstep } from './utils.js';

// Cycle duration in seconds (one full day)
const CYCLE_DURATION = 300; // 5 minutes

// Time phases (0 to 1)
// Quick dawn/dusk (~15s each), long day/night (~135s each)
const NIGHT_END = 0.225;
const DAWN_END  = 0.275;
const DAY_END   = 0.725;
const DUSK_END  = 0.775;
// NIGHT again from 0.775 to 1.0 (and 0.0 to 0.225)

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
    night: { ambient: 0.3, sun: 0.15, hemi: 0.2, headlight: 50, fogNear: 15, fogFar: 90 },
    dawn:  { ambient: 0.8, sun: 0.7,  hemi: 0.5, headlight: 15, fogNear: 25, fogFar: 140 },
    day:   { ambient: 1.5, sun: 1.4,  hemi: 0.9, headlight: 5,  fogNear: 40, fogFar: 180 },
    dusk:  { ambient: 0.6, sun: 0.5,  hemi: 0.4, headlight: 25, fogNear: 18, fogFar: 110 },
};

// Fullscreen color tint per phase — [r, g, b, opacity]
const TINT = {
    night: [10, 18, 55, 0.22],
    dawn:  [255, 140, 70, 0.10],
    day:   [255, 252, 245, 0.0],
    dusk:  [255, 90, 40, 0.14],
};

// Ambient tint for unlit shader — multiplied with base textures.
const AMBIENT_TINT = {
    night: new THREE.Color(0.08, 0.08, 0.15),
    dawn:  new THREE.Color(1.0, 0.85, 0.6),
    day:   new THREE.Color(1.0, 0.98, 0.93),
    dusk:  new THREE.Color(0.9, 0.6, 0.4),
};

// Sun/moon orbit radius
const ORBIT_RADIUS = 300;

/**
 * Generate a procedural radial-gradient lens flare texture.
 */
function createFlareTexture(size, r, g, b) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, `rgba(${r},${g},${b},1.0)`);
    gradient.addColorStop(0.2, `rgba(${r},${g},${b},0.8)`);
    gradient.addColorStop(0.4, `rgba(${r},${g},${b},0.3)`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
}

export class DayNightCycle {
    constructor(scene) {
        this.scene = scene;
        this.time = 0.35; // Start in early daytime
        this.speed = 1.0 / CYCLE_DURATION;

        // Sky group holds stars, sun, and moon — moved together in main.js
        this._skyGroup = new THREE.Group();

        // Stars
        this._stars = this._createStars();
        this._skyGroup.add(this._stars);

        // Sun mesh
        this._sunMesh = this._createSunMesh();
        this._skyGroup.add(this._sunMesh);

        // Moon mesh
        this._moonMesh = this._createMoonMesh();
        this._skyGroup.add(this._moonMesh);

        // Lens flares
        this._sunFlare = this._createLensflare(
            createFlareTexture(256, 255, 220, 100),
            createFlareTexture(256, 255, 200, 80)
        );
        this._sunMesh.add(this._sunFlare);

        this._moonFlare = this._createLensflare(
            createFlareTexture(256, 200, 200, 230),
            createFlareTexture(256, 180, 180, 210)
        );
        this._moonMesh.add(this._moonFlare);

        this.scene.add(this._skyGroup);

        // Sun direction helper (for directional light positioning)
        this._sunAngle = 0;

        // Fullscreen tint overlay
        this._tintOverlay = document.createElement('div');
        this._tintOverlay.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;z-index:1;background:transparent;';
        document.body.appendChild(this._tintOverlay);

        // Current interpolated values (exposed for external reads)
        this.currentColors = {
            sky: new THREE.Color(),
            fog: new THREE.Color(),
            ambientTint: new THREE.Color(1, 1, 1),
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

    _createSunMesh() {
        const geo = new THREE.SphereGeometry(8, 16, 16);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffdd44,
            fog: false,
            transparent: true,
            opacity: 1.0,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        return mesh;
    }

    _createMoonMesh() {
        const geo = new THREE.SphereGeometry(5, 16, 16);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xccccdd,
            fog: false,
            transparent: true,
            opacity: 0.85,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        return mesh;
    }

    _createLensflare(coreTexture, haloTexture) {
        const sizes = [300, 600, 150, 100];
        const els = [
            new LensflareElement(coreTexture, sizes[0], 0),
            new LensflareElement(haloTexture, sizes[1], 0),
            new LensflareElement(haloTexture, sizes[2], 0.4),
            new LensflareElement(haloTexture, sizes[3], 0.7),
        ];
        const flare = new Lensflare();
        for (const el of els) flare.addElement(el);
        flare.userData.baseSizes = sizes;
        flare.userData.elements = els;
        return flare;
    }

    /**
     * Get the interpolation factor between two phases.
     */
    _getPhaseBlend(time) {
        if (time < NIGHT_END) {
            return { a: 'night', b: 'night', t: 0 };
        } else if (time < DAWN_END) {
            const t = smoothstep(NIGHT_END, DAWN_END, time);
            return { a: 'night', b: 'dawn', t };
        } else if (time < (DAWN_END + DAY_END) / 2) {
            const t = smoothstep(DAWN_END, (DAWN_END + DAY_END) / 2, time);
            return { a: 'dawn', b: 'day', t };
        } else if (time < DAY_END) {
            return { a: 'day', b: 'day', t: 0 };
        } else if (time < DUSK_END) {
            const t = smoothstep(DAY_END, DUSK_END, time);
            return { a: 'day', b: 'dusk', t };
        } else if (time < (DUSK_END + 1.0) / 2) {
            const t = smoothstep(DUSK_END, (DUSK_END + 1.0) / 2, time);
            return { a: 'dusk', b: 'night', t };
        } else {
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

        // Ambient tint for unlit shader materials
        this._lerpColor(
            this.currentColors.ambientTint,
            AMBIENT_TINT[phase.a], AMBIENT_TINT[phase.b], t
        );

        // Apply to scene — fog matches sky for seamless horizon blend
        scene.background.copy(this.currentColors.sky);
        fog.color.copy(this.currentColors.sky);

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

        // Fullscreen tint overlay
        const tA = TINT[phase.a];
        const tB = TINT[phase.b];
        const tr = lerp(tA[0], tB[0], t);
        const tg = lerp(tA[1], tB[1], t);
        const tb = lerp(tA[2], tB[2], t);
        const ta = lerp(tA[3], tB[3], t);
        this._tintOverlay.style.background =
            `rgba(${Math.round(tr)},${Math.round(tg)},${Math.round(tb)},${ta.toFixed(3)})`;

        // Stars visibility — only after sunset, fade out during dawn
        const starVis = this._getStarVisibility();
        this._stars.material.opacity = starVis;
        this._stars.visible = starVis > 0.01;

        // Sun and moon visual meshes
        this._updateSunMoon();

        // Nightness for isNight flag (headlights etc)
        const nightness = this._getNightness();
        this.isNight = nightness > 0.5;

        return this.currentIntensity;
    }

    /**
     * Update sun and moon mesh positions and visibility.
     */
    _updateSunMoon() {
        // Sun orbits based on cycle time — peaks at midday (time=0.5)
        // Map time so sun is at zenith around time=0.5
        const sunOrbitAngle = (this.time - 0.25) * Math.PI * 2;
        const sunX = Math.cos(sunOrbitAngle) * ORBIT_RADIUS;
        const sunY = Math.sin(sunOrbitAngle) * ORBIT_RADIUS;
        const sunZ = Math.sin(sunOrbitAngle * 0.3) * ORBIT_RADIUS * 0.3;
        this._sunMesh.position.set(sunX, sunY, sunZ);

        // Moon is opposite the sun (180 degrees offset)
        this._moonMesh.position.set(-sunX, -sunY, -sunZ);

        // Sun visibility and color
        if (sunY > -10) {
            this._sunMesh.visible = true;
            // Fade near horizon
            const horizonFade = clamp((sunY + 10) / 40, 0, 1);
            this._sunMesh.material.opacity = horizonFade;
            // Shift to orange near horizon
            const horizonT = 1 - clamp(sunY / ORBIT_RADIUS, 0, 1);
            const sunColor = new THREE.Color(0xffdd44).lerp(new THREE.Color(0xff6622), horizonT * 0.7);
            this._sunMesh.material.color.copy(sunColor);
            // Scale flare with horizon fade
            this._sunFlare.visible = horizonFade > 0.05;
            const sunBases = this._sunFlare.userData.baseSizes;
            const sunEls = this._sunFlare.userData.elements;
            for (let i = 0; i < sunEls.length; i++) {
                sunEls[i].size = sunBases[i] * horizonFade;
            }
        } else {
            this._sunMesh.visible = false;
            this._sunFlare.visible = false;
        }

        // Moon visibility
        const moonY = -sunY;
        if (moonY > -10) {
            this._moonMesh.visible = true;
            const horizonFade = clamp((moonY + 10) / 40, 0, 1);
            this._moonMesh.material.opacity = 0.85 * horizonFade;
            // Scale flare with horizon fade
            this._moonFlare.visible = horizonFade > 0.05;
            const moonBases = this._moonFlare.userData.baseSizes;
            const moonEls = this._moonFlare.userData.elements;
            for (let i = 0; i < moonEls.length; i++) {
                moonEls[i].size = moonBases[i] * horizonFade;
            }
        } else {
            this._moonMesh.visible = false;
            this._moonFlare.visible = false;
        }
    }

    /**
     * Star visibility: 0 during day and dusk, fades in after DUSK_END, fades out during dawn.
     */
    _getStarVisibility() {
        if (this.time < NIGHT_END) return 1;
        if (this.time < DAWN_END) return 1 - smoothstep(NIGHT_END, DAWN_END, this.time);
        if (this.time < DUSK_END) return 0;
        // Fade in after dusk ends
        return smoothstep(DUSK_END, DUSK_END + 0.05, this.time);
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
     * Get the sky group (stars + sun + moon) for repositioning.
     */
    getStarDome() {
        return this._skyGroup;
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
