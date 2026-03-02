/**
 * Cockpit — 2D Image Plane Overlay
 *
 * Dashboard and steering wheel as textured planes attached to the camera.
 * Both layers track together with the same parallax sway on steering.
 */

import * as THREE from 'three';
import { lerp } from './utils.js';
import { createUnlitMaterial } from './shaders.js';

// LHD driver offset — used by main.js for camera positioning
const DRIVER_X = -0.35;

// ── Layer depths (negative Z = forward from camera) ──────────
const DASH_Z = -1.5;
const WHEEL_Z = -1.2;
const Z_RATIO_WHEEL = Math.abs(WHEEL_Z) / Math.abs(DASH_Z);

// ── Dashboard ────────────────────────────────────────────────
const DASH_WIDTH_PAD = 1.15;   // wider than viewport to cover edges during sway
const MIN_DASH_ASPECT = 2.0;   // minimum effective viewport aspect — prevents portrait squish

// ── Steering wheel — centered on red + from dash_notes ──────
// Red + position in dash image coords (0-1, top-left origin)
const RED_CROSS_X = 0.22;
const RED_CROSS_Y = 0.73;
const WHEEL_SIZE_FRAC = 1.70;  // wheel height as fraction of dash height (2x)

// ── Sway ─────────────────────────────────────────────────────
const SWAY_AMOUNT = 0.15;
const SWAY_SPEED = 6;
const COCKPIT_PARALLAX = 0.7;  // same for dash and wheel — they track together

export class Cockpit {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();
        camera.add(this.group);

        this.dashMesh = null;
        this.underDashMesh = null;
        this.wheelMesh = null;
        this.dashAspect = 2.4;
        this.underDashAspect = 2.0;
        this.wheelAspect = 1.0;

        this.swayX = 0;
        this.wheelCurrentAngle = 0;

        // Base positions (set in _updateLayout, sway added in update)
        this._dashBaseX = 0;
        this._wheelBaseX = 0;
        this._wheelBaseY = 0;

        // Windshield blood overlay
        this.windshieldCanvas = document.getElementById('windshield-canvas');
        this.windshieldCtx = null;
        if (this.windshieldCanvas) {
            this.windshieldCtx = this.windshieldCanvas.getContext('2d');
            this._resizeWindshield();
        }

        // Wiper state
        this.wipersActive = false;
        this.wiperAngle = 0;        // 0 to ~120 degrees
        this.wiperDirection = 1;     // +1 sweep right, -1 sweep left
        this._prevWipers = false;    // edge detection

        // Washer fluid
        this.washerFluid = 100;      // 0-100
        this.washerSpraying = false;

        this._loadImages();
        this._buildHeadlights();

        window.addEventListener('resize', () => {
            this._updateLayout();
            this._resizeWindshield();
        });
    }

    _resizeWindshield() {
        if (!this.windshieldCanvas) return;
        this.windshieldCanvas.width = window.innerWidth;
        this.windshieldCanvas.height = window.innerHeight;
    }

    // ── Image Loading ────────────────────────────────────────

    _loadImages() {
        const loader = new THREE.TextureLoader();

        loader.load('assets/dashboard.png', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
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

        loader.load('assets/under_dash.png', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            this.underDashAspect = tex.image.width / tex.image.height;

            const mat = createUnlitMaterial(tex, {
                transparent: true,
                alphaTest: 0.01,
                depthWrite: false,
            });
            mat.depthTest = false;

            this.underDashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
            this.underDashMesh.renderOrder = 99;
            this.underDashMesh.position.z = DASH_Z;
            this.group.add(this.underDashMesh);
            this._updateLayout();
        });

        loader.load('assets/steering_wheel.png', (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
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

        // ── Dashboard — fill width (clamped so portrait doesn't squish)
        const effectiveAspect = Math.max(aspect, MIN_DASH_ASPECT);
        const dashW = (visH_dash * effectiveAspect) * DASH_WIDTH_PAD;
        const dashH = dashW / this.dashAspect;

        this.dashMesh.scale.set(dashW, dashH, 1);
        // Bottom third: top edge at -visH_dash/2 + visH_dash/3 = -visH_dash/6
        // Mesh center = topEdge - dashH/2
        this.dashMesh.position.y = -visH_dash / 6 - dashH / 2;
        this._dashBaseX = 0;

        // Reset UVs to show full texture (no cropping)
        const uv = this.dashMesh.geometry.getAttribute('uv');
        uv.setY(0, 1);
        uv.setY(1, 1);
        uv.needsUpdate = true;

        // ── Under-dash — top edge at 75% down dashboard, extends below viewport
        if (this.underDashMesh) {
            const topY = this.dashMesh.position.y + dashH / 2 - dashH * 0.75;
            const udW = dashW;
            const udH = udW / this.underDashAspect;
            // If the image isn't tall enough to extend well below viewport, scale it up
            const minUdH = visH_dash;
            const finalUdH = Math.max(udH, minUdH);
            const finalUdW = finalUdH * this.underDashAspect;
            this.underDashMesh.scale.set(Math.max(udW, finalUdW), finalUdH, 1);
            this.underDashMesh.position.y = topY - finalUdH / 2;
        }

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

    // ── Windshield Blood + Wipers ─────────────────────────────

    addBloodSplatter(intensity) {
        if (!this.windshieldCtx) return;
        const ctx = this.windshieldCtx;
        const w = this.windshieldCanvas.width;
        const h = this.windshieldCanvas.height;
        const count = Math.floor(3 + intensity * 5);

        for (let i = 0; i < count; i++) {
            const cx = Math.random() * w;
            const cy = Math.random() * h;
            const size = 40 + Math.random() * 80;

            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(${80 + Math.floor(Math.random() * 60)}, 0, 0, ${0.6 + Math.random() * 0.3})`;
            ctx.beginPath();

            // Irregular blob shape
            const points = 6 + Math.floor(Math.random() * 4);
            for (let p = 0; p < points; p++) {
                const angle = (p / points) * Math.PI * 2;
                const r = size * (0.4 + Math.random() * 0.6);
                const px = cx + Math.cos(angle) * r;
                const py = cy + Math.sin(angle) * r;
                if (p === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();

            // Add some drip streaks
            if (Math.random() > 0.5) {
                ctx.fillStyle = `rgba(${70 + Math.floor(Math.random() * 40)}, 0, 0, 0.4)`;
                const dripW = 3 + Math.random() * 8;
                const dripH = 20 + Math.random() * 60;
                ctx.fillRect(cx - dripW / 2, cy, dripW, dripH);
            }

            ctx.restore();
        }
    }

    _updateWindshield(dt, input) {
        if (!input) return;

        // Washer fluid
        this.washerSpraying = input.washer && this.washerFluid > 0;
        if (this.washerSpraying) {
            this.washerFluid = Math.max(0, this.washerFluid - 20 * dt);
        }

        // Sync wiper state from input toggle
        this.wipersActive = input.wipers;

        // Wiper sweep
        if (this.wipersActive && this.windshieldCtx) {
            const sweepSpeed = 90; // degrees per second
            this.wiperAngle += this.wiperDirection * sweepSpeed * dt;

            if (this.wiperAngle >= 120) {
                this.wiperAngle = 120;
                this.wiperDirection = -1;
            } else if (this.wiperAngle <= 0) {
                this.wiperAngle = 0;
                this.wiperDirection = 1;
            }

            // Draw wiper clear arc
            this._drawWiperClear();
        }
    }

    _drawWiperClear() {
        const ctx = this.windshieldCtx;
        const w = this.windshieldCanvas.width;
        const h = this.windshieldCanvas.height;

        // Wiper pivot at bottom-center of screen
        const pivotX = w * 0.5;
        const pivotY = h * 1.1;
        const wiperLength = h * 1.2;

        // Convert wiper angle to radians — sweep from left to right
        const angleRad = (-60 + this.wiperAngle) * Math.PI / 180;
        const sweepWidth = 6; // degrees of arc cleared per frame

        const alpha = this.washerSpraying ? 1.0 : 0.15;

        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(pivotX, pivotY);
        const startAngle = angleRad - (sweepWidth * Math.PI / 180) - Math.PI / 2;
        const endAngle = angleRad + (sweepWidth * Math.PI / 180) - Math.PI / 2;
        ctx.arc(pivotX, pivotY, wiperLength, startAngle, endAngle);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    // ── Per-Frame Update ─────────────────────────────────────

    update(dt, vehicle, input) {
        // Sway — same parallax for dash and wheel so they track together
        const swayTarget = vehicle.steerAngle * SWAY_AMOUNT;
        this.swayX = lerp(this.swayX, swayTarget, SWAY_SPEED * dt);

        const sway = this.swayX * COCKPIT_PARALLAX;

        if (this.dashMesh) {
            this.dashMesh.position.x = this._dashBaseX + sway;
        }

        if (this.underDashMesh) {
            this.underDashMesh.position.x = this._dashBaseX + sway;
        }

        if (this.wheelMesh) {
            this.wheelMesh.position.x = this._wheelBaseX + sway;

            const wheelTarget = -vehicle.steerAngle * 2.5;
            this.wheelCurrentAngle = lerp(this.wheelCurrentAngle, wheelTarget, 12 * dt);
            this.wheelMesh.rotation.z = this.wheelCurrentAngle;
        }

        // Windshield blood + wipers
        this._updateWindshield(dt, input);
    }
}

// Export driver offset for camera positioning in main.js
export const DRIVER_OFFSET_X = DRIVER_X;
