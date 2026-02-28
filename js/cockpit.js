/**
 * Cockpit — 2D Image Plane Overlay
 *
 * Renders dashboard and steering wheel as textured planes
 * attached to the camera. Both scale to fill the viewport
 * bottom-center and sway with steering input for parallax depth.
 */

import * as THREE from 'three';
import { lerp } from './utils.js';
import { createUnlitMaterial } from './shaders.js';

// LHD driver offset — used by main.js for camera positioning
const DRIVER_X = -0.35;

// Layer depths in camera-local space (negative Z = forward)
const DASH_Z = -1.5;
const WHEEL_Z = -1.2;

// Sway
const SWAY_AMOUNT = 0.15;      // max lateral shift at full steer
const SWAY_SPEED = 6;          // lerp rate
const DASH_PARALLAX = 0.7;     // further layer sways less
const WHEEL_PARALLAX = 1.0;    // closer layer sways more

// Dashboard sizing
const DASH_WIDTH_PAD = 1.15;   // 15% wider than viewport to cover edges during sway

// Steering wheel sizing & placement
const WHEEL_SCALE = 0.65;      // fraction of visible height
const WHEEL_Y_ANCHOR = 0.35;   // how far up from bottom (0=bottom edge, 1=center)
const WHEEL_X_FRAC = -0.23;    // fraction of visible width from center (negative = left, aligns with column)

export class Cockpit {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();
        camera.add(this.group);

        this.dashMesh = null;
        this.wheelMesh = null;
        this.dashAspect = 2.4;  // placeholder until image loads
        this.wheelAspect = 1.0;

        this.swayX = 0;
        this.wheelCurrentAngle = 0;
        this._wheelBaseX = 0;
        this._dashBaseX = 0;

        this._loadImages();
        this._buildHeadlights();

        window.addEventListener('resize', () => this._updateLayout());
    }

    _loadImages() {
        const loader = new THREE.TextureLoader();

        // Dashboard
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

        // Steering wheel
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
            this.wheelMesh.renderOrder = 101;
            this.wheelMesh.position.z = WHEEL_Z;
            this.group.add(this.wheelMesh);
            this._updateLayout();
        });
    }

    /**
     * Recalculate plane sizes so they fill the viewport correctly.
     * Called on load and on window resize.
     */
    _updateLayout() {
        const fov = this.camera.fov * Math.PI / 180;
        const aspect = this.camera.aspect;

        // Dashboard — fill width, pin to bottom
        if (this.dashMesh) {
            const d = Math.abs(DASH_Z);
            const visH = 2 * d * Math.tan(fov / 2);
            const visW = visH * aspect;

            const dashW = visW * DASH_WIDTH_PAD;
            const dashH = dashW / this.dashAspect;

            this.dashMesh.scale.set(dashW, dashH, 1);
            this.dashMesh.position.y = -visH / 2 + dashH / 2;
        }

        // Steering wheel — aligned with column opening on the left side of the dash
        if (this.wheelMesh) {
            const d = Math.abs(WHEEL_Z);
            const visH = 2 * d * Math.tan(fov / 2);
            const visW = visH * aspect;

            const wheelH = visH * WHEEL_SCALE;
            const wheelW = wheelH * this.wheelAspect;

            this.wheelMesh.scale.set(wheelW, wheelH, 1);
            this._wheelBaseX = visW * WHEEL_X_FRAC;
            this.wheelMesh.position.x = this._wheelBaseX;
            this.wheelMesh.position.y = -visH / 2 + wheelH * WHEEL_Y_ANCHOR;
        }
    }

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

    update(dt, vehicle) {
        // Sway — steering shifts cockpit laterally (simulates head inertia)
        const swayTarget = vehicle.steerAngle * SWAY_AMOUNT;
        this.swayX = lerp(this.swayX, swayTarget, SWAY_SPEED * dt);

        if (this.dashMesh) {
            this.dashMesh.position.x = this._dashBaseX + this.swayX * DASH_PARALLAX;
        }

        if (this.wheelMesh) {
            this.wheelMesh.position.x = this._wheelBaseX + this.swayX * WHEEL_PARALLAX;

            // Rotate steering wheel with input
            const wheelTarget = -vehicle.steerAngle * 2.5;
            this.wheelCurrentAngle = lerp(this.wheelCurrentAngle, wheelTarget, 12 * dt);
            this.wheelMesh.rotation.z = this.wheelCurrentAngle;
        }
    }
}

// Export driver offset for camera positioning in main.js
export const DRIVER_OFFSET_X = DRIVER_X;
