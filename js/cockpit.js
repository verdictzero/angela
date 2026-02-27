/**
 * Cockpit Interior — Left-Hand Drive
 *
 * Renders a first-person car dashboard with the steering wheel
 * on the LEFT side (LHD). Driver sits on the left, center console
 * and passenger space to the right.
 */

import * as THREE from 'three';
import { lerp, createCanvasTexture } from './utils.js';

// LHD driver offset: steering wheel is to the left of center
const DRIVER_X = -0.35;

export class Cockpit {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();
        this.camera.add(this.group);

        this._buildDashboard();
        this._buildSteeringWheel();
        this._buildWindshieldFrame();
        this._buildDoorPanel();
        this._buildHeadlights();

        this.wheelTargetAngle = 0;
        this.wheelCurrentAngle = 0;
    }

    _buildDashboard() {
        const dashMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
        const darkMat = new THREE.MeshLambertMaterial({ color: 0x111111 });

        // Main dashboard — full width
        const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.15, 0.8), dashMat);
        dash.position.set(0.1, -0.55, -1.2);
        this.group.add(dash);

        // Dashboard top surface
        const dashTop = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 0.5), dashMat);
        dashTop.position.set(0.1, -0.45, -1.0);
        dashTop.rotation.x = -0.3;
        this.group.add(dashTop);

        // Instrument cluster (behind steering wheel, left side)
        const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 0.05), darkMat);
        cluster.position.set(DRIVER_X, -0.35, -1.35);
        cluster.rotation.x = -0.4;
        this.group.add(cluster);

        // Instrument binnacle hood
        const hood = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.2), dashMat);
        hood.position.set(DRIVER_X, -0.27, -1.3);
        hood.rotation.x = -0.2;
        this.group.add(hood);

        // Tachometer circle (left gauge)
        const tachoGeo = new THREE.RingGeometry(0.06, 0.08, 16);
        const gaugeMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee, side: THREE.DoubleSide });
        const tacho = new THREE.Mesh(tachoGeo, gaugeMat);
        tacho.position.set(DRIVER_X - 0.12, -0.34, -1.33);
        tacho.rotation.x = -0.4;
        this.group.add(tacho);

        // Speedometer circle (right gauge)
        const speedo = new THREE.Mesh(tachoGeo.clone(), gaugeMat);
        speedo.position.set(DRIVER_X + 0.12, -0.34, -1.33);
        speedo.rotation.x = -0.4;
        this.group.add(speedo);

        // Speed indicator light
        this._speedIndicator = new THREE.Mesh(
            new THREE.PlaneGeometry(0.06, 0.06),
            new THREE.MeshBasicMaterial({ color: 0x00ff00 })
        );
        this._speedIndicator.position.set(DRIVER_X, -0.31, -1.33);
        this._speedIndicator.rotation.x = -0.4;
        this.group.add(this._speedIndicator);

        // Center console (between driver and passenger)
        const centerConsole = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 0.38, 0.7),
            new THREE.MeshLambertMaterial({ color: 0x151515 })
        );
        centerConsole.position.set(0.15, -0.72, -0.85);
        this.group.add(centerConsole);

        // Radio/infotainment screen (dark rectangle on center dash)
        const screen = new THREE.Mesh(
            new THREE.PlaneGeometry(0.28, 0.18),
            new THREE.MeshBasicMaterial({ color: 0x0a0a15 })
        );
        screen.position.set(0.15, -0.38, -1.34);
        screen.rotation.x = -0.35;
        this.group.add(screen);

        // Passenger side glove box area
        const glovebox = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.2, 0.35),
            new THREE.MeshLambertMaterial({ color: 0x181818 })
        );
        glovebox.position.set(0.65, -0.58, -1.15);
        this.group.add(glovebox);

        // AC vents (small dark rectangles across dash)
        const ventMat = new THREE.MeshLambertMaterial({ color: 0x0f0f0f });
        for (const vx of [DRIVER_X - 0.4, 0.15, 0.65]) {
            const vent = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.04, 0.03), ventMat);
            vent.position.set(vx, -0.42, -1.38);
            this.group.add(vent);
        }
    }

    _buildSteeringWheel() {
        const columnMat = new THREE.MeshLambertMaterial({ color: 0x222222 });

        // Steering column (angled toward driver)
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), columnMat);
        column.rotation.x = Math.PI / 2 + 0.4;
        column.position.set(DRIVER_X, -0.42, -1.05);
        this.group.add(column);

        // Steering wheel group (rotates)
        this._wheelGroup = new THREE.Group();
        this._wheelGroup.position.set(DRIVER_X, -0.32, -0.85);
        this._wheelGroup.rotation.x = -0.3;

        // Wheel ring
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.18, 0.016, 8, 24),
            new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
        );
        this._wheelGroup.add(ring);

        // Leather wrapping (slightly different shade)
        const wrapRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.18, 0.018, 8, 24),
            new THREE.MeshLambertMaterial({ color: 0x151515, transparent: true, opacity: 0.5 })
        );
        this._wheelGroup.add(wrapRing);

        // 3 spokes
        const spokeMat = new THREE.MeshLambertMaterial({ color: 0x252525 });
        for (let i = 0; i < 3; i++) {
            const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
            const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.014, 0.014), spokeMat);
            spoke.position.set(Math.cos(angle) * 0.09, Math.sin(angle) * 0.09, 0);
            spoke.rotation.z = angle;
            this._wheelGroup.add(spoke);
        }

        // Center hub with airbag cover
        const hub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.05, 0.025, 12),
            spokeMat
        );
        hub.rotation.x = Math.PI / 2;
        this._wheelGroup.add(hub);

        this.group.add(this._wheelGroup);
    }

    _buildWindshieldFrame() {
        const frameMat = new THREE.MeshLambertMaterial({ color: 0x111111 });

        // Top bar
        const topBar = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.08, 0.08), frameMat);
        topBar.position.set(0, 0.7, -1.6);
        this.group.add(topBar);

        // Left A-pillar (driver side, closer)
        const leftPillar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), frameMat);
        leftPillar.position.set(-1.3, 0.1, -1.6);
        leftPillar.rotation.z = 0.15;
        this.group.add(leftPillar);

        // Right A-pillar (passenger side, further)
        const rightPillar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), frameMat);
        rightPillar.position.set(1.3, 0.1, -1.6);
        rightPillar.rotation.z = -0.15;
        this.group.add(rightPillar);

        // Rearview mirror (slightly left of center for LHD)
        const mirror = new THREE.Mesh(
            new THREE.BoxGeometry(0.25, 0.06, 0.03),
            new THREE.MeshBasicMaterial({ color: 0x335577 })
        );
        mirror.position.set(-0.05, 0.55, -1.55);
        this.group.add(mirror);

        const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 4), frameMat);
        stalk.position.set(-0.05, 0.63, -1.56);
        this.group.add(stalk);
    }

    _buildDoorPanel() {
        // Left door panel (driver's door, visible on the left edge)
        const doorMat = new THREE.MeshLambertMaterial({ color: 0x161616 });

        const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 1.2), doorMat);
        doorPanel.position.set(-1.15, -0.3, -0.9);
        this.group.add(doorPanel);

        // Door armrest
        const armrest = new THREE.Mesh(
            new THREE.BoxGeometry(0.12, 0.05, 0.35),
            new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
        );
        armrest.position.set(-1.1, -0.35, -0.8);
        this.group.add(armrest);

        // Window switch panel
        const switchPanel = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.02, 0.12),
            new THREE.MeshLambertMaterial({ color: 0x222222 })
        );
        switchPanel.position.set(-1.08, -0.32, -0.8);
        this.group.add(switchPanel);

        // Side mirror visible through left window (approximation)
        const sideMirror = new THREE.Mesh(
            new THREE.BoxGeometry(0.15, 0.1, 0.02),
            new THREE.MeshBasicMaterial({ color: 0x334466 })
        );
        sideMirror.position.set(-1.35, 0.1, -1.3);
        sideMirror.rotation.y = 0.3;
        this.group.add(sideMirror);
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

    /**
     * Set headlight intensity (called by day/night system).
     */
    setHeadlightIntensity(intensity) {
        this._headlightL.intensity = intensity;
        this._headlightR.intensity = intensity;
    }

    update(dt, vehicle) {
        this.wheelTargetAngle = -vehicle.steerAngle * 2.5;
        this.wheelCurrentAngle = lerp(this.wheelCurrentAngle, this.wheelTargetAngle, 12 * dt);
        this._wheelGroup.rotation.z = this.wheelCurrentAngle;

        const speedRatio = vehicle.speedKmh / 180;
        if (speedRatio < 0.5) {
            this._speedIndicator.material.color.setHex(0x00ff00);
        } else if (speedRatio < 0.8) {
            this._speedIndicator.material.color.setHex(0xffff00);
        } else {
            this._speedIndicator.material.color.setHex(0xff0000);
        }
    }
}

// Export driver offset for camera positioning
export const DRIVER_OFFSET_X = DRIVER_X;
