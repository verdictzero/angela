/**
 * Cockpit — 2D Image Plane Overlay
 *
 * Dashboard and steering wheel as textured planes attached to the camera.
 * Instrument gauges (tach, speedo, clock) on a layer between dash and wheel.
 * Everything sways with steering input for parallax depth.
 */

import * as THREE from 'three';
import { lerp } from './utils.js';
import { createUnlitMaterial } from './shaders.js';

// LHD driver offset — used by main.js for camera positioning
const DRIVER_X = -0.35;

// ── Layer depths (negative Z = forward from camera) ──────────
const DASH_Z = -1.5;
const INSTRUMENTS_Z = -1.35;
const WHEEL_Z = -1.2;
const Z_RATIO_INST = Math.abs(INSTRUMENTS_Z) / Math.abs(DASH_Z);
const Z_RATIO_WHEEL = Math.abs(WHEEL_Z) / Math.abs(DASH_Z);

// ── Dashboard ────────────────────────────────────────────────
const DASH_WIDTH_PAD = 1.15;   // wider than viewport to cover edges during sway

// ── Steering wheel — centered on red + from dash_notes ──────
// Red + position in dash image coords (0-1, top-left origin)
const RED_CROSS_X = 0.28;
const RED_CROSS_Y = 0.68;
const WHEEL_SIZE_FRAC = 0.85;  // wheel height as fraction of dash height

// ── Gauge positions in dash image coords (0-1, top-left origin) ─
const TACHO  = { x: 0.17,  y: 0.52, size: 0.065 };
const SPEEDO = { x: 0.265, y: 0.52, size: 0.065 };
const CLOCK  = { x: 0.70,  y: 0.48, w: 0.08, h: 0.055 };

// ── Sway ─────────────────────────────────────────────────────
const SWAY_AMOUNT = 0.15;
const SWAY_SPEED = 6;
const DASH_PARALLAX = 0.7;
const INSTRUMENTS_PARALLAX = 0.85;
const WHEEL_PARALLAX = 1.0;

// ── Gauge canvas size ────────────────────────────────────────
const GAUGE_RES = 128;

export class Cockpit {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();
        camera.add(this.group);

        this.dashMesh = null;
        this.wheelMesh = null;
        this.dashAspect = 2.4;
        this.wheelAspect = 1.0;

        this.swayX = 0;
        this.wheelCurrentAngle = 0;

        // Base positions (set in _updateLayout, sway added in update)
        this._dashBaseX = 0;
        this._wheelBaseX = 0;
        this._wheelBaseY = 0;
        this._tachoBaseX = 0;
        this._tachoBaseY = 0;
        this._speedoBaseX = 0;
        this._speedoBaseY = 0;
        this._clockBaseX = 0;
        this._clockBaseY = 0;

        // Smoothed RPM for tachometer
        this._rpm = 800;

        this._createGauges();
        this._loadImages();
        this._buildHeadlights();

        window.addEventListener('resize', () => this._updateLayout());
    }

    // ── Image Loading ────────────────────────────────────────

    _loadImages() {
        const loader = new THREE.TextureLoader();

        loader.load('assets/dashboard.png', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            this.dashAspect = tex.image.width / tex.image.height;

            const mat = createUnlitMaterial(tex, {
                transparent: true,
                alphaTest: 0.01,
                depthWrite: false,
            });
            mat.depthTest = false;

            this.dashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
            this.dashMesh.renderOrder = 100;
            this.dashMesh.position.z = DASH_Z;
            this.group.add(this.dashMesh);
            this._updateLayout();
        });

        loader.load('assets/steering_wheel.png', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            this.wheelAspect = tex.image.width / tex.image.height;

            const mat = createUnlitMaterial(tex, {
                transparent: true,
                alphaTest: 0.01,
                depthWrite: false,
            });
            mat.depthTest = false;

            this.wheelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
            this.wheelMesh.renderOrder = 102;
            this.wheelMesh.position.z = WHEEL_Z;
            this.group.add(this.wheelMesh);
            this._updateLayout();
        });
    }

    // ── Gauge Creation ───────────────────────────────────────

    _createGauges() {
        // Tachometer
        this._tachoCanvas = this._makeCanvas(GAUGE_RES, GAUGE_RES);
        this._tachoTex = new THREE.CanvasTexture(this._tachoCanvas);
        this._tachoMesh = this._makeGaugeMesh(this._tachoTex, INSTRUMENTS_Z, 101);
        this.group.add(this._tachoMesh);

        // Speedometer
        this._speedoCanvas = this._makeCanvas(GAUGE_RES, GAUGE_RES);
        this._speedoTex = new THREE.CanvasTexture(this._speedoCanvas);
        this._speedoMesh = this._makeGaugeMesh(this._speedoTex, INSTRUMENTS_Z, 101);
        this.group.add(this._speedoMesh);

        // Clock
        this._clockCanvas = this._makeCanvas(GAUGE_RES, Math.round(GAUGE_RES * 0.7));
        this._clockTex = new THREE.CanvasTexture(this._clockCanvas);
        this._clockMesh = this._makeGaugeMesh(this._clockTex, INSTRUMENTS_Z, 101);
        this.group.add(this._clockMesh);
    }

    _makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    _makeGaugeMesh(texture, z, renderOrder) {
        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            side: THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.renderOrder = renderOrder;
        mesh.position.z = z;
        return mesh;
    }

    // ── Layout ───────────────────────────────────────────────

    /**
     * Convert a point in dash image coords (0-1, top-left origin)
     * to camera-space position at a target Z plane.
     */
    _dashImageToCamera(imgX, imgY, targetZ) {
        const s = this.dashMesh.scale;
        const p = this.dashMesh.position;
        const camX = p.x + (imgX - 0.5) * s.x;
        const camY = p.y + (0.5 - imgY) * s.y;
        const zRatio = Math.abs(targetZ) / Math.abs(DASH_Z);
        return { x: camX * zRatio, y: camY * zRatio };
    }

    _updateLayout() {
        if (!this.dashMesh) return;

        const fov = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect;
        const dDash = Math.abs(DASH_Z);
        const visH_dash = 2 * dDash * Math.tan(fov / 2);
        const visW_dash = visH_dash * aspect;

        // ── Dashboard — fill width, push down so top edge is at screen midpoint
        const dashW = visW_dash * DASH_WIDTH_PAD;
        const dashH = dashW / this.dashAspect;

        this.dashMesh.scale.set(dashW, dashH, 1);
        // Top edge at y=0 (screen center): center = -dashH/2
        this.dashMesh.position.y = -dashH / 2;
        this._dashBaseX = 0;

        // Reset UVs to show full texture (no cropping)
        const uv = this.dashMesh.geometry.getAttribute('uv');
        uv.setY(0, 1);
        uv.setY(1, 1);
        uv.needsUpdate = true;

        // ── Steering wheel — center on red + position
        if (this.wheelMesh) {
            const pos = this._dashImageToCamera(RED_CROSS_X, RED_CROSS_Y, WHEEL_Z);
            this._wheelBaseX = pos.x;
            this._wheelBaseY = pos.y;

            const wheelH = dashH * WHEEL_SIZE_FRAC * Z_RATIO_WHEEL;
            const wheelW = wheelH * this.wheelAspect;
            this.wheelMesh.scale.set(wheelW, wheelH, 1);
            this.wheelMesh.position.x = this._wheelBaseX;
            this.wheelMesh.position.y = this._wheelBaseY;
        }

        // ── Gauges — position at dash_notes locations
        this._layoutGauge(this._tachoMesh, TACHO.x, TACHO.y, TACHO.size, TACHO.size / this.dashAspect);
        this._layoutGauge(this._speedoMesh, SPEEDO.x, SPEEDO.y, SPEEDO.size, SPEEDO.size / this.dashAspect);
        this._layoutGauge(this._clockMesh, CLOCK.x, CLOCK.y, CLOCK.w, CLOCK.h);
    }

    _layoutGauge(mesh, imgX, imgY, wFrac, hFrac) {
        if (!this.dashMesh || !mesh) return;

        const pos = this._dashImageToCamera(imgX, imgY, INSTRUMENTS_Z);
        const s = this.dashMesh.scale;

        // Size: fractions of dash width/height, projected to instruments Z
        const gw = wFrac * s.x * Z_RATIO_INST;
        const gh = hFrac * s.y * Z_RATIO_INST;

        mesh.scale.set(gw, gh, 1);
        mesh.position.x = pos.x;
        mesh.position.y = pos.y;

        // Store base positions for sway
        if (mesh === this._tachoMesh)  { this._tachoBaseX = pos.x;  this._tachoBaseY = pos.y; }
        if (mesh === this._speedoMesh) { this._speedoBaseX = pos.x; this._speedoBaseY = pos.y; }
        if (mesh === this._clockMesh)  { this._clockBaseX = pos.x;  this._clockBaseY = pos.y; }
    }

    // ── Gauge Drawing ────────────────────────────────────────

    _updateGauges(speedKmh, timeString) {
        // Simulate RPM: sawtooth gear pattern
        const gearWidth = 45; // km/h per gear
        const gearFrac = (speedKmh % gearWidth) / gearWidth;
        const targetRpm = speedKmh < 1 ? 800 : 1200 + gearFrac * 5300;
        this._rpm = lerp(this._rpm, targetRpm, 0.15);

        this._drawCircularGauge(
            this._tachoCanvas, this._tachoTex,
            this._rpm, 8000, 7000, 'RPM', [0, 1, 2, 3, 4, 5, 6, 7, 8]
        );

        this._drawCircularGauge(
            this._speedoCanvas, this._speedoTex,
            speedKmh, 220, 200, 'km/h', [0, 40, 80, 120, 160, 200]
        );

        this._drawClock(timeString);
    }

    _drawCircularGauge(canvas, tex, value, maxVal, redline, label, ticks) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const cx = w / 2, cy = h / 2, r = w * 0.42;

        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 10, 12, 0.92)';
        ctx.fill();
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Arc range: 7 o'clock to 5 o'clock (225° sweep)
        const startA = Math.PI * 0.75;
        const endA = Math.PI * 2.25;
        const sweep = endA - startA;

        // Redline arc
        if (redline < maxVal) {
            const redStartA = startA + (redline / maxVal) * sweep;
            ctx.beginPath();
            ctx.arc(cx, cy, r - 3, redStartA, endA);
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
            ctx.lineWidth = 5;
            ctx.stroke();
        }

        // Tick marks + labels
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${Math.round(w * 0.09)}px monospace`;

        for (const t of ticks) {
            const frac = t / maxVal;
            const a = startA + frac * sweep;
            const cos = Math.cos(a), sin = Math.sin(a);
            const inner = r * 0.78, outer = r * 0.92;

            ctx.beginPath();
            ctx.moveTo(cx + cos * inner, cy + sin * inner);
            ctx.lineTo(cx + cos * outer, cy + sin * outer);
            ctx.strokeStyle = frac >= redline / maxVal ? '#ff3333' : '#bbb';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Number
            const lr = r * 0.62;
            ctx.fillStyle = frac >= redline / maxVal ? '#ff5555' : '#999';
            const numLabel = maxVal > 1000 ? Math.round(t / 1000) : t;
            ctx.fillText(String(numLabel), cx + cos * lr, cy + sin * lr);
        }

        // Label
        ctx.font = `${Math.round(w * 0.09)}px monospace`;
        ctx.fillStyle = '#666';
        ctx.fillText(label, cx, cy + r * 0.35);

        // Needle
        const valFrac = Math.min(value / maxVal, 1);
        const needleA = startA + valFrac * sweep;
        const needleLen = r * 0.72;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(needleA) * needleLen, cy + Math.sin(needleA) * needleLen);
        ctx.strokeStyle = '#ff3300';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Center cap
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3300';
        ctx.fill();

        tex.needsUpdate = true;
    }

    _drawClock(timeString) {
        const canvas = this._clockCanvas;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;

        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = 'rgba(8, 10, 8, 0.9)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.strokeRect(1, 1, w - 2, h - 2);

        // Time text
        ctx.font = `bold ${Math.round(h * 0.45)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#44ff88';
        ctx.shadowColor = '#44ff88';
        ctx.shadowBlur = 6;
        ctx.fillText(timeString || '00:00', w / 2, h / 2);
        ctx.shadowBlur = 0;

        this._clockTex.needsUpdate = true;
    }

    // ── Headlights ───────────────────────────────────────────

    _buildHeadlights() {
        this._headlightL = new THREE.SpotLight(0xffffcc, 30, 120, Math.PI / 6, 0.5, 1);
        this._headlightL.position.set(-0.6, -0.2, -1.8);
        this._headlightL.target.position.set(-0.6, -1, -20);
        this.group.add(this._headlightL);
        this.group.add(this._headlightL.target);

        this._headlightR = new THREE.SpotLight(0xffffcc, 30, 120, Math.PI / 6, 0.5, 1);
        this._headlightR.position.set(0.6, -0.2, -1.8);
        this._headlightR.target.position.set(0.6, -1, -20);
        this.group.add(this._headlightR);
        this.group.add(this._headlightR.target);
    }

    setHeadlightIntensity(intensity) {
        this._headlightL.intensity = intensity;
        this._headlightR.intensity = intensity;
    }

    // ── Per-Frame Update ─────────────────────────────────────

    update(dt, vehicle, speedKmh, timeString) {
        // Sway
        const swayTarget = vehicle.steerAngle * SWAY_AMOUNT;
        this.swayX = lerp(this.swayX, swayTarget, SWAY_SPEED * dt);

        if (this.dashMesh) {
            this.dashMesh.position.x = this._dashBaseX + this.swayX * DASH_PARALLAX;
        }

        if (this.wheelMesh) {
            this.wheelMesh.position.x = this._wheelBaseX + this.swayX * WHEEL_PARALLAX;

            const wheelTarget = -vehicle.steerAngle * 2.5;
            this.wheelCurrentAngle = lerp(this.wheelCurrentAngle, wheelTarget, 12 * dt);
            this.wheelMesh.rotation.z = this.wheelCurrentAngle;
        }

        // Instruments sway
        const instSway = this.swayX * INSTRUMENTS_PARALLAX;
        this._tachoMesh.position.x = this._tachoBaseX + instSway;
        this._speedoMesh.position.x = this._speedoBaseX + instSway;
        this._clockMesh.position.x = this._clockBaseX + instSway;

        // Update gauge canvases
        this._updateGauges(speedKmh || 0, timeString || '');
    }
}

// Export driver offset for camera positioning in main.js
export const DRIVER_OFFSET_X = DRIVER_X;
