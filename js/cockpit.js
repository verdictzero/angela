/**
 * Cockpit — 2D Image Plane Overlay
 *
 * Dashboard and steering wheel as textured planes attached to the camera.
 * Both layers track together with the same parallax sway on steering.
 *
 * Blood splatters render on an offscreen canvas → CanvasTexture on a plane
 * at renderOrder 98 so they appear behind the dashboard and steering wheel.
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

// ── Blood splatter pool ──────────────────────────────────────
const MAX_SPLATTERS = 64;

function _rng(min, max) { return min + Math.random() * (max - min); }

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

        // Wiper state
        this.wipersActive = false;
        this.wiperAngle = 0;        // 0 to ~120 degrees
        this.wiperDirection = 1;     // +1 sweep right, -1 sweep left
        this._prevWipers = false;    // edge detection

        // Washer fluid
        this.washerFluid = 100;      // 0-100
        this.washerSpraying = false;

        // ── Blood splatter system (offscreen canvas → Three.js plane) ──
        this._initBloodSystem();

        this._loadImages();
        this._buildHeadlights();

        window.addEventListener('resize', () => {
            this._updateLayout();
            this._resizeBloodCanvas();
        });
    }

    // ── Blood System Init ─────────────────────────────────────

    _initBloodSystem() {
        // Offscreen canvas at half resolution
        this._bloodCanvas = document.createElement('canvas');
        this._bloodCanvas.width = Math.max(1, Math.floor(window.innerWidth / 2));
        this._bloodCanvas.height = Math.max(1, Math.floor(window.innerHeight / 2));
        this._bloodCtx = this._bloodCanvas.getContext('2d');

        // Three.js texture from canvas
        this._bloodTexture = new THREE.CanvasTexture(this._bloodCanvas);
        this._bloodTexture.magFilter = THREE.LinearFilter;
        this._bloodTexture.minFilter = THREE.LinearFilter;

        // Simple passthrough shader — no fog/tint/headlight influence
        const bloodMat = new THREE.ShaderMaterial({
            uniforms: {
                bloodMap: { value: this._bloodTexture },
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D bloodMap;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = texture2D(bloodMap, vUv);
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
            side: THREE.FrontSide,
        });

        this.bloodMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bloodMat);
        this.bloodMesh.renderOrder = 98;
        this.bloodMesh.position.z = DASH_Z;
        this.group.add(this.bloodMesh);

        // Splatter pool
        this._splatters = [];
        for (let i = 0; i < MAX_SPLATTERS; i++) {
            this._splatters.push(this._createSplatter());
        }

        this._bloodDirty = false;
        this._anyDripping = false;
    }

    _createSplatter() {
        return {
            active: false,
            x: 0, y: 0,
            velocityY: 0,
            blobs: [],
            satellites: [],
            streaks: [],
            age: 0,
            opacity: 1.0,
            size: 0,
            dripping: false,
            dripDelay: 0,
        };
    }

    _acquireSplatter() {
        // Find first inactive
        for (let i = 0; i < MAX_SPLATTERS; i++) {
            if (!this._splatters[i].active) return this._splatters[i];
        }
        // Recycle oldest (lowest index that's active — pool is roughly FIFO)
        let oldest = 0;
        let oldestAge = -1;
        for (let i = 0; i < MAX_SPLATTERS; i++) {
            if (this._splatters[i].age > oldestAge) {
                oldestAge = this._splatters[i].age;
                oldest = i;
            }
        }
        return this._splatters[oldest];
    }

    _resizeBloodCanvas() {
        this._bloodCanvas.width = Math.max(1, Math.floor(window.innerWidth / 2));
        this._bloodCanvas.height = Math.max(1, Math.floor(window.innerHeight / 2));
        this._bloodDirty = true;
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

        // ── Blood plane — fill viewport at DASH_Z, padded for sway
        if (this.bloodMesh) {
            this.bloodMesh.scale.set(dashW, visH_dash * DASH_WIDTH_PAD, 1);
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

    // ── Procedural Blood Splatter Generation ──────────────────

    addBloodSplatter(intensity) {
        const count = Math.floor(2 + intensity * 3);
        for (let i = 0; i < count; i++) {
            const s = this._acquireSplatter();

            s.active = true;
            s.x = Math.random();
            s.y = _rng(0.05, 0.75);
            s.velocityY = 0;
            s.age = 0;
            s.opacity = _rng(0.7, 1.0);
            s.size = _rng(0.03, 0.07) + intensity * _rng(0.02, 0.05);
            s.dripping = false;
            s.dripDelay = _rng(0.5, 3.0);

            // Generate blob shapes (bezier outlines)
            const numBlobs = Math.floor(_rng(2, 4));
            s.blobs = [];
            for (let b = 0; b < numBlobs; b++) {
                s.blobs.push(this._generateBlob(s.size, b === 0 ? 1.0 : _rng(0.5, 0.8)));
            }

            // Satellite droplets
            const numSats = Math.floor(_rng(4, 12));
            s.satellites = [];
            for (let j = 0; j < numSats; j++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = s.size * _rng(1.2, 3.0);
                s.satellites.push({
                    ox: Math.cos(angle) * dist,
                    oy: Math.sin(angle) * dist,
                    r: _rng(0.002, 0.006),
                    red: Math.floor(_rng(100, 170)),
                    alpha: _rng(0.5, 0.9),
                });
            }

            // Directional streaks (more likely for high intensity)
            s.streaks = [];
            if (intensity > 0.5 && Math.random() > 0.3) {
                const numStreaks = Math.floor(_rng(1, 4));
                for (let k = 0; k < numStreaks; k++) {
                    const angle = _rng(-Math.PI * 0.7, Math.PI * 0.7);
                    s.streaks.push({
                        angle: angle,
                        length: s.size * _rng(1.5, 3.5),
                        width: _rng(0.003, 0.008),
                        red: Math.floor(_rng(90, 160)),
                        alpha: _rng(0.3, 0.6),
                    });
                }
            }
        }

        this._bloodDirty = true;
    }

    _generateBlob(baseSize, scale) {
        const numPts = Math.floor(_rng(8, 14));
        const points = [];
        for (let i = 0; i < numPts; i++) {
            const angle = (i / numPts) * Math.PI * 2 + _rng(-0.15, 0.15);
            const r = baseSize * scale * _rng(0.3, 1.0);
            const cpLen = r * _rng(0.3, 0.8);
            points.push({ angle, r, cpLen });
        }
        return {
            points,
            ox: scale < 1.0 ? _rng(-baseSize * 0.3, baseSize * 0.3) : 0,
            oy: scale < 1.0 ? _rng(-baseSize * 0.3, baseSize * 0.3) : 0,
            red: Math.floor(_rng(100, 180)),
            green: Math.floor(_rng(0, 10)),
            alpha: scale < 1.0 ? _rng(0.3, 0.6) : _rng(0.6, 0.9),
        };
    }

    // ── Canvas Drawing ────────────────────────────────────────

    _redrawBloodCanvas() {
        const ctx = this._bloodCtx;
        const w = this._bloodCanvas.width;
        const h = this._bloodCanvas.height;
        ctx.clearRect(0, 0, w, h);

        for (let i = 0; i < MAX_SPLATTERS; i++) {
            const s = this._splatters[i];
            if (!s.active) continue;
            this._drawSplatter(ctx, s, w, h);
        }

        this._bloodTexture.needsUpdate = true;
    }

    _drawSplatter(ctx, s, w, h) {
        const cx = s.x * w;
        const cy = s.y * h;

        ctx.save();
        ctx.globalAlpha = s.opacity;

        // Draw blobs
        for (const blob of s.blobs) {
            const bx = cx + blob.ox * w;
            const by = cy + blob.oy * h;
            ctx.fillStyle = `rgba(${blob.red}, ${blob.green}, 0, ${blob.alpha})`;
            ctx.beginPath();

            const pts = blob.points;
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const px = bx + Math.cos(p.angle) * p.r * w;
                const py = by + Math.sin(p.angle) * p.r * h;

                if (i === 0) {
                    ctx.moveTo(px, py);
                } else {
                    // Bezier curve from previous point
                    const prev = pts[i - 1];
                    const prevX = bx + Math.cos(prev.angle) * prev.r * w;
                    const prevY = by + Math.sin(prev.angle) * prev.r * h;

                    // Control points offset perpendicular to the line between points
                    const midAngle = (prev.angle + p.angle) / 2;
                    const cp1x = prevX + Math.cos(prev.angle + 0.5) * prev.cpLen * w;
                    const cp1y = prevY + Math.sin(prev.angle + 0.5) * prev.cpLen * h;
                    const cp2x = px + Math.cos(p.angle - 0.5) * p.cpLen * w;
                    const cp2y = py + Math.sin(p.angle - 0.5) * p.cpLen * h;

                    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, px, py);
                }
            }

            // Close with bezier back to first point
            if (pts.length > 1) {
                const first = pts[0];
                const last = pts[pts.length - 1];
                const fx = bx + Math.cos(first.angle) * first.r * w;
                const fy = by + Math.sin(first.angle) * first.r * h;
                const lx = bx + Math.cos(last.angle) * last.r * w;
                const ly = by + Math.sin(last.angle) * last.r * h;
                const cp1x = lx + Math.cos(last.angle + 0.5) * last.cpLen * w;
                const cp1y = ly + Math.sin(last.angle + 0.5) * last.cpLen * h;
                const cp2x = fx + Math.cos(first.angle - 0.5) * first.cpLen * w;
                const cp2y = fy + Math.sin(first.angle - 0.5) * first.cpLen * h;
                ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, fx, fy);
            }

            ctx.fill();
        }

        // Draw satellites
        for (const sat of s.satellites) {
            const sx = cx + sat.ox * w;
            const sy = cy + sat.oy * h;
            ctx.fillStyle = `rgba(${sat.red}, 0, 0, ${sat.alpha})`;
            ctx.beginPath();
            ctx.arc(sx, sy, sat.r * w, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw streaks
        for (const st of s.streaks) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(st.angle);
            ctx.fillStyle = `rgba(${st.red}, 0, 0, ${st.alpha})`;
            ctx.beginPath();
            // Tapered streak — wide at base, narrow at tip
            const len = st.length * h;
            const halfW = st.width * w * 0.5;
            ctx.moveTo(-halfW, 0);
            ctx.lineTo(halfW, 0);
            ctx.lineTo(halfW * 0.2, len);
            ctx.lineTo(-halfW * 0.2, len);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        ctx.restore();
    }

    // ── Blood Drip Animation ──────────────────────────────────

    _updateBloodSplatters(dt) {
        this._anyDripping = false;
        for (let i = 0; i < MAX_SPLATTERS; i++) {
            const s = this._splatters[i];
            if (!s.active) continue;

            s.age += dt;

            // Start dripping after delay
            if (!s.dripping && s.age > s.dripDelay) {
                s.dripping = true;
                s.velocityY = _rng(0.002, 0.008);
            }

            if (s.dripping) {
                // Accelerate slowly (viscous fluid), cap speed
                s.velocityY = Math.min(s.velocityY + 0.001 * dt, 0.02);
                s.y += s.velocityY * dt;

                // Thin out as it slides
                s.opacity = Math.max(0.1, s.opacity - 0.015 * dt);

                this._anyDripping = true;
                this._bloodDirty = true;
            }

            // Off-screen bottom — deactivate
            if (s.y > 1.3) {
                s.active = false;
                this._bloodDirty = true;
            }
        }
    }

    // ── Windshield / Wipers ───────────────────────────────────

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
        if (this.wipersActive) {
            const sweepSpeed = 90; // degrees per second
            this.wiperAngle += this.wiperDirection * sweepSpeed * dt;

            if (this.wiperAngle >= 120) {
                this.wiperAngle = 120;
                this.wiperDirection = -1;
            } else if (this.wiperAngle <= 0) {
                this.wiperAngle = 0;
                this.wiperDirection = 1;
            }

            this._applyWiperClear(dt);
        }

        // Update drip animation
        this._updateBloodSplatters(dt);

        // Redraw canvas only when dirty
        if (this._bloodDirty) {
            this._redrawBloodCanvas();
            this._bloodDirty = false;
        }
    }

    _applyWiperClear(dt) {
        const pivotX = 0.5;
        const pivotY = 1.1;
        const wiperLength = 1.2;

        const angleRad = (-60 + this.wiperAngle) * Math.PI / 180;
        const sweepWidth = 8; // degrees

        const startAngle = angleRad - (sweepWidth * Math.PI / 180) - Math.PI / 2;
        const endAngle = angleRad + (sweepWidth * Math.PI / 180) - Math.PI / 2;

        const fadeRate = this.washerSpraying ? 3.0 : 0.45;

        for (let i = 0; i < MAX_SPLATTERS; i++) {
            const s = this._splatters[i];
            if (!s.active) continue;

            const dx = s.x - pivotX;
            const dy = s.y - pivotY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > wiperLength) continue;

            const angle = Math.atan2(dy, dx);

            // Normalize angle check — handle wrap-around
            let a = angle;
            if (a < startAngle - Math.PI) a += Math.PI * 2;
            if (a > endAngle + Math.PI) a -= Math.PI * 2;

            if (a >= startAngle && a <= endAngle) {
                s.opacity -= fadeRate * dt;
                if (s.opacity <= 0) {
                    s.active = false;
                }
                this._bloodDirty = true;
            }
        }
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

        // Blood plane tracks sway with cockpit
        if (this.bloodMesh) {
            this.bloodMesh.position.x = this._dashBaseX + sway;
        }

        // Windshield blood + wipers
        this._updateWindshield(dt, input);
    }
}

// Export driver offset for camera positioning in main.js
export const DRIVER_OFFSET_X = DRIVER_X;
