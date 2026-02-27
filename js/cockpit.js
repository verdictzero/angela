/**
 * Cockpit Interior
 *
 * Renders a first-person car dashboard with steering wheel,
 * instrument cluster, and windshield frame.
 */

import * as THREE from 'three';
import { lerp, createCanvasTexture } from './utils.js';

export class Cockpit {
    constructor(camera) {
        this.camera = camera;
        this.group = new THREE.Group();

        // The cockpit group is added as child of camera so it moves with it
        this.camera.add(this.group);

        this._buildDashboard();
        this._buildSteeringWheel();
        this._buildWindshieldFrame();
        this._buildHeadlights();

        this.wheelTargetAngle = 0;
        this.wheelCurrentAngle = 0;
    }

    _buildDashboard() {
        // Main dashboard surface
        const dashGeo = new THREE.BoxGeometry(2.4, 0.15, 0.8);
        const dashMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
        const dash = new THREE.Mesh(dashGeo, dashMat);
        dash.position.set(0, -0.55, -1.2);
        this.group.add(dash);

        // Dashboard top surface (slightly curved feel with angled box)
        const dashTopGeo = new THREE.BoxGeometry(2.4, 0.05, 0.5);
        const dashTop = new THREE.Mesh(dashTopGeo, dashMat);
        dashTop.position.set(0, -0.45, -1.0);
        dashTop.rotation.x = -0.3;
        this.group.add(dashTop);

        // Instrument cluster backing
        const clusterGeo = new THREE.BoxGeometry(0.5, 0.3, 0.05);
        const clusterMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const cluster = new THREE.Mesh(clusterGeo, clusterMat);
        cluster.position.set(0, -0.35, -1.35);
        cluster.rotation.x = -0.4;
        this.group.add(cluster);

        // Speed indicator light (glows based on speed — updated in update())
        const indicatorGeo = new THREE.PlaneGeometry(0.08, 0.08);
        this._speedIndicator = new THREE.Mesh(
            indicatorGeo,
            new THREE.MeshBasicMaterial({ color: 0x00ff00 })
        );
        this._speedIndicator.position.set(0.15, -0.3, -1.33);
        this._speedIndicator.rotation.x = -0.4;
        this.group.add(this._speedIndicator);

        // Center console
        const consoleGeo = new THREE.BoxGeometry(0.3, 0.4, 0.6);
        const consoleMat = new THREE.MeshLambertMaterial({ color: 0x151515 });
        const centerConsole = new THREE.Mesh(consoleGeo, consoleMat);
        centerConsole.position.set(0, -0.7, -0.9);
        this.group.add(centerConsole);
    }

    _buildSteeringWheel() {
        // Steering column
        const columnGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8);
        const columnMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
        const column = new THREE.Mesh(columnGeo, columnMat);
        column.rotation.x = Math.PI / 2 + 0.4;
        column.position.set(0, -0.42, -1.05);
        this.group.add(column);

        // Steering wheel group (rotates)
        this._wheelGroup = new THREE.Group();
        this._wheelGroup.position.set(0, -0.32, -0.85);
        this._wheelGroup.rotation.x = -0.3;

        // Wheel ring
        const ringGeo = new THREE.TorusGeometry(0.18, 0.015, 8, 24);
        const ringMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        this._wheelGroup.add(ring);

        // Wheel spokes (3 spokes)
        const spokeMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
        for (let i = 0; i < 3; i++) {
            const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
            const spokeGeo = new THREE.BoxGeometry(0.15, 0.012, 0.012);
            const spoke = new THREE.Mesh(spokeGeo, spokeMat);
            spoke.position.set(Math.cos(angle) * 0.09, Math.sin(angle) * 0.09, 0);
            spoke.rotation.z = angle;
            this._wheelGroup.add(spoke);
        }

        // Center hub
        const hubGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12);
        const hub = new THREE.Mesh(hubGeo, spokeMat);
        hub.rotation.x = Math.PI / 2;
        this._wheelGroup.add(hub);

        this.group.add(this._wheelGroup);
    }

    _buildWindshieldFrame() {
        const frameMat = new THREE.MeshLambertMaterial({ color: 0x111111 });

        // Top bar
        const topBar = new THREE.Mesh(
            new THREE.BoxGeometry(2.8, 0.08, 0.08),
            frameMat
        );
        topBar.position.set(0, 0.7, -1.6);
        this.group.add(topBar);

        // Bottom bar (merges with dash)
        // Already covered by dashboard

        // Left A-pillar
        const leftPillar = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 1.4, 0.06),
            frameMat
        );
        leftPillar.position.set(-1.3, 0.1, -1.6);
        leftPillar.rotation.z = 0.15;
        this.group.add(leftPillar);

        // Right A-pillar
        const rightPillar = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 1.4, 0.06),
            frameMat
        );
        rightPillar.position.set(1.3, 0.1, -1.6);
        rightPillar.rotation.z = -0.15;
        this.group.add(rightPillar);

        // Rearview mirror
        const mirrorGeo = new THREE.BoxGeometry(0.25, 0.06, 0.03);
        const mirrorMat = new THREE.MeshBasicMaterial({ color: 0x335577 });
        const mirror = new THREE.Mesh(mirrorGeo, mirrorMat);
        mirror.position.set(0, 0.55, -1.55);
        this.group.add(mirror);

        // Mirror stalk
        const stalkGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.18, 4);
        const stalk = new THREE.Mesh(stalkGeo, frameMat);
        stalk.position.set(0, 0.63, -1.56);
        this.group.add(stalk);
    }

    _buildHeadlights() {
        // Two spot lights for headlights
        this._headlightL = new THREE.SpotLight(0xffffcc, 30, 100, Math.PI / 6, 0.5, 1);
        this._headlightL.position.set(-0.6, -0.2, -1.8);
        this._headlightL.target.position.set(-0.6, -1, -20);
        this.group.add(this._headlightL);
        this.group.add(this._headlightL.target);

        this._headlightR = new THREE.SpotLight(0xffffcc, 30, 100, Math.PI / 6, 0.5, 1);
        this._headlightR.position.set(0.6, -0.2, -1.8);
        this._headlightR.target.position.set(0.6, -1, -20);
        this.group.add(this._headlightR);
        this.group.add(this._headlightR.target);
    }

    update(dt, vehicle) {
        // Rotate steering wheel based on vehicle steer angle
        this.wheelTargetAngle = -vehicle.steerAngle * 2.5;
        this.wheelCurrentAngle = lerp(this.wheelCurrentAngle, this.wheelTargetAngle, 12 * dt);
        this._wheelGroup.rotation.z = this.wheelCurrentAngle;

        // Speed indicator color
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
