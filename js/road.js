/**
 * Infinite Procedural Road Generator
 *
 * Road cross-section (from center outward):
 *   ±0 to ±8.75   Road surface (2 lanes, asphalt)
 *   ±8.75 to ±11.75  Shoulder (gravel)
 *   ±11.75 to ±12.35  Curb
 *   ±12.35 to ±18.35  Sidewalk (concrete)
 *   Beyond ±18.35   Ground (grass)
 */

import * as THREE from 'three';
import { randomRange, clamp, createCanvasTexture } from './utils.js';

// ── Road dimensions (2x wider) ─────────────────────────────────
const ROAD_HALF_WIDTH = 8.75;      // 2 lanes, each 8.75m
const SHOULDER_WIDTH = 3.0;
const CURB_WIDTH = 0.6;
const CURB_HEIGHT = 0.15;
const SIDEWALK_WIDTH = 6.0;
const SHOULDER_INNER = ROAD_HALF_WIDTH;
const SHOULDER_OUTER = ROAD_HALF_WIDTH + SHOULDER_WIDTH;
const CURB_INNER = SHOULDER_OUTER;
const CURB_OUTER = SHOULDER_OUTER + CURB_WIDTH;
const SW_INNER = CURB_OUTER;
const SW_OUTER = CURB_OUTER + SIDEWALK_WIDTH;

const POINT_SPACING = 4;
const POINTS_PER_CHUNK = 40;
const GENERATE_AHEAD = 1500;
const REMOVE_BEHIND = 200;
const DASH_LENGTH = 3;
const DASH_GAP = 4;
const GROUND_SIZE = 2000;

export class RoadManager {
    constructor(scene) {
        this.scene = scene;
        this.points = [];
        this.chunks = [];
        this.currentAngle = 0;
        this.currentCurvature = 0;
        this.targetCurvature = 0;
        this.totalDistance = 0;
        this._nextChunkId = 0;
        this._lastRemovedChunks = [];

        // Turn pattern state machine
        this._turnCooldown = 120;     // points until next pattern (~480m)
        this._turnDirection = 1;      // +1 or -1
        this._turnPhase = 'none';
        this._turnPhaseRemaining = 0;
        this._turnPattern = 'none';   // 'gradual-s', 'sharp-right', 'whiplash', 'chicane'

        // Spatial grid for self-intersection detection
        this._spatialGrid = new Map();  // "gx,gz" -> [pointIndices]
        this._gridCellSize = 30;        // 30m cells

        // Generate textures
        this._textures = this._generateTextures();

        // Materials — each surface gets its own distinct look
        this._roadMat = new THREE.MeshLambertMaterial({ map: this._textures.road });
        this._shoulderMat = new THREE.MeshLambertMaterial({ map: this._textures.shoulder });
        this._sidewalkMat = new THREE.MeshLambertMaterial({ map: this._textures.sidewalk });
        this._curbMat = new THREE.MeshLambertMaterial({ color: 0x555558 });
        this._markingMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
        this._yellowMat = new THREE.MeshBasicMaterial({ color: 0xddcc33 });

        // Ground plane
        this._groundMat = new THREE.MeshLambertMaterial({ map: this._textures.grass });
        this._ground = new THREE.Mesh(
            new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
            this._groundMat
        );
        this._ground.rotation.x = -Math.PI / 2;
        this._ground.position.y = -0.02;
        this._ground.receiveShadow = true;
        this.scene.add(this._ground);

        // Generate initial road
        this._generatePoints(POINTS_PER_CHUNK * 5);
        this._buildAllNeededChunks(new THREE.Vector3(0, 0, 0));
    }

    // ── Texture Generation ─────────────────────────────────────

    _generateTextures() {
        // Dark asphalt — road surface
        const road = this._makeTexture(256, 256, (ctx, w, h) => {
            ctx.fillStyle = '#2e2e33';
            ctx.fillRect(0, 0, w, h);
            // Aggregate noise
            for (let i = 0; i < 5000; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const g = 35 + Math.random() * 30;
                ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
                ctx.fillRect(x, y, 1 + Math.random(), 1 + Math.random());
            }
            // Cracks
            ctx.strokeStyle = '#222228';
            ctx.lineWidth = 0.5;
            for (let i = 0; i < 4; i++) {
                ctx.beginPath();
                let cx = Math.random() * w, cy = Math.random() * h;
                ctx.moveTo(cx, cy);
                for (let j = 0; j < 6; j++) {
                    cx += (Math.random() - 0.5) * 40;
                    cy += (Math.random() - 0.5) * 40;
                    ctx.lineTo(cx, cy);
                }
                ctx.stroke();
            }
            // Oil stain patches
            for (let i = 0; i < 2; i++) {
                ctx.fillStyle = `rgba(20,20,25,${0.15 + Math.random() * 0.1})`;
                ctx.beginPath();
                ctx.ellipse(
                    Math.random() * w, Math.random() * h,
                    10 + Math.random() * 15, 5 + Math.random() * 8,
                    Math.random() * Math.PI, 0, Math.PI * 2
                );
                ctx.fill();
            }
        }, 3, 3);

        // Gravel shoulder — lighter, rougher
        const shoulder = this._makeTexture(128, 128, (ctx, w, h) => {
            ctx.fillStyle = '#6a6355';
            ctx.fillRect(0, 0, w, h);
            // Gravel stones
            for (let i = 0; i < 4000; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const base = 75 + Math.random() * 45;
                const r = base + Math.random() * 15;
                const g = base + Math.random() * 5;
                const b = base - 10 + Math.random() * 10;
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                const sz = 1 + Math.random() * 2.5;
                ctx.fillRect(x, y, sz, sz);
            }
            // Larger stones
            for (let i = 0; i < 30; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const g = 90 + Math.random() * 40;
                ctx.fillStyle = `rgb(${g + 5},${g},${g - 5})`;
                ctx.beginPath();
                ctx.arc(x, y, 2 + Math.random() * 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }, 3, 3);

        // Concrete sidewalk — file-based texture
        const sidewalkTex = new THREE.TextureLoader().load('assets/sidewalk.png');
        sidewalkTex.wrapS = THREE.RepeatWrapping;
        sidewalkTex.wrapT = THREE.RepeatWrapping;
        sidewalkTex.repeat.set(2, 2);
        sidewalkTex.offset.set(0.5, 0);
        sidewalkTex.colorSpace = THREE.SRGBColorSpace;
        sidewalkTex.magFilter = THREE.NearestFilter;
        sidewalkTex.minFilter = THREE.NearestFilter;
        const sidewalk = sidewalkTex;

        // Grass ground — loaded from texture file
        const grassTex = new THREE.TextureLoader().load('assets/terrain/terrain_new_meadow_grass_checkered_v2.png');
        grassTex.wrapS = THREE.RepeatWrapping;
        grassTex.wrapT = THREE.RepeatWrapping;
        grassTex.repeat.set(480, 480);
        grassTex.colorSpace = THREE.SRGBColorSpace;
        grassTex.magFilter = THREE.NearestFilter;
        grassTex.minFilter = THREE.NearestFilter;
        const grass = grassTex;

        return { road, shoulder, sidewalk, grass };
    }

    _makeTexture(w, h, drawFn, repeatX, repeatY) {
        const canvas = createCanvasTexture(w, h, drawFn);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        return tex;
    }

    // ── Road Point Generation ──────────────────────────────────

    // ── Spatial grid for self-intersection detection ──────────

    _gridKey(x, z) {
        const gx = Math.floor(x / this._gridCellSize);
        const gz = Math.floor(z / this._gridCellSize);
        return `${gx},${gz}`;
    }

    _registerPoint(idx, pos) {
        const key = this._gridKey(pos.x, pos.z);
        if (!this._spatialGrid.has(key)) this._spatialGrid.set(key, []);
        this._spatialGrid.get(key).push(idx);
    }

    /**
     * Check if a candidate position is too close to existing road points.
     * Skips the most recent `skipRecent` points (so the road doesn't
     * collide with itself at the current tip).
     * Returns true if intersection detected.
     */
    _wouldSelfIntersect(pos, skipRecent = 100) {
        const minDist = ROAD_HALF_WIDTH * 2 + SHOULDER_WIDTH * 2 + 6; // ~29m clearance
        const minDistSq = minDist * minDist;
        const latestSafe = this.points.length - skipRecent;
        const gx = Math.floor(pos.x / this._gridCellSize);
        const gz = Math.floor(pos.z / this._gridCellSize);

        // Check 5x5 neighborhood of grid cells for wider coverage
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                const key = `${gx + dx},${gz + dz}`;
                const cell = this._spatialGrid.get(key);
                if (!cell) continue;
                for (let k = 0; k < cell.length; k++) {
                    const idx = cell[k];
                    if (idx >= latestSafe) continue; // skip recent points
                    const other = this.points[idx].position;
                    const ddx = pos.x - other.x;
                    const ddz = pos.z - other.z;
                    if (ddx * ddx + ddz * ddz < minDistSq) return true;
                }
            }
        }
        return false;
    }

    /**
     * Check if the line segment from A to B crosses any existing road segment.
     * Uses 2D line-segment intersection test on the XZ plane.
     */
    _segmentCrossesRoad(ax, az, bx, bz, skipRecent = 100) {
        const latestSafe = this.points.length - skipRecent;
        if (latestSafe < 2) return false;

        const gx1 = Math.floor(Math.min(ax, bx) / this._gridCellSize) - 1;
        const gx2 = Math.floor(Math.max(ax, bx) / this._gridCellSize) + 1;
        const gz1 = Math.floor(Math.min(az, bz) / this._gridCellSize) - 1;
        const gz2 = Math.floor(Math.max(az, bz) / this._gridCellSize) + 1;

        const checked = new Set();
        for (let gx = gx1; gx <= gx2; gx++) {
            for (let gz = gz1; gz <= gz2; gz++) {
                const cell = this._spatialGrid.get(`${gx},${gz}`);
                if (!cell) continue;
                for (let k = 0; k < cell.length; k++) {
                    const idx = cell[k];
                    if (idx >= latestSafe || idx < 1) continue;
                    if (checked.has(idx)) continue;
                    checked.add(idx);
                    const p1 = this.points[idx - 1].position;
                    const p2 = this.points[idx].position;
                    if (this._segmentsIntersect(ax, az, bx, bz, p1.x, p1.z, p2.x, p2.z)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * 2D line-segment intersection test (XZ plane).
     */
    _segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
        const rx = bx - ax, ry = by - ay;
        const sx = dx - cx, sy = dy - cy;
        const denom = rx * sy - ry * sx;
        if (Math.abs(denom) < 1e-10) return false; // parallel
        const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
        const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
        return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
    }

    /**
     * Get the minimum distance to any existing road point (excluding recent).
     * Returns Infinity if no nearby points.
     */
    _nearestRoadDistance(pos, skipRecent = 100) {
        let minDistSq = Infinity;
        const latestSafe = this.points.length - skipRecent;
        const gx = Math.floor(pos.x / this._gridCellSize);
        const gz = Math.floor(pos.z / this._gridCellSize);

        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                const key = `${gx + dx},${gz + dz}`;
                const cell = this._spatialGrid.get(key);
                if (!cell) continue;
                for (let k = 0; k < cell.length; k++) {
                    const idx = cell[k];
                    if (idx >= latestSafe) continue;
                    const other = this.points[idx].position;
                    const ddx = pos.x - other.x;
                    const ddz = pos.z - other.z;
                    const dsq = ddx * ddx + ddz * ddz;
                    if (dsq < minDistSq) minDistSq = dsq;
                }
            }
        }
        return Math.sqrt(minDistSq);
    }

    /**
     * Simulate several points ahead from a given state to check if
     * committing to this direction would cause intersection soon.
     * Returns true if look-ahead detects a future intersection.
     */
    _lookAheadIntersects(startPos, angle, curvature, steps = 8) {
        let px = startPos.x, pz = startPos.z;
        let a = angle, c = curvature;
        for (let i = 0; i < steps; i++) {
            a += c;
            const nx = px + Math.sin(a) * POINT_SPACING;
            const nz = pz - Math.cos(a) * POINT_SPACING;
            // Check proximity
            const testPos = { x: nx, z: nz };
            if (this._wouldSelfIntersectXZ(nx, nz, 100 + i)) return true;
            // Check segment crossing
            if (this._segmentCrossesRoad(px, pz, nx, nz, 100 + i)) return true;
            px = nx;
            pz = nz;
        }
        return false;
    }

    /**
     * Lightweight XZ-only proximity check (avoids creating Vector3).
     */
    _wouldSelfIntersectXZ(x, z, skipRecent = 100) {
        const minDist = ROAD_HALF_WIDTH * 2 + SHOULDER_WIDTH * 2 + 6;
        const minDistSq = minDist * minDist;
        const latestSafe = this.points.length - skipRecent;
        const gx = Math.floor(x / this._gridCellSize);
        const gz = Math.floor(z / this._gridCellSize);

        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                const key = `${gx + dx},${gz + dz}`;
                const cell = this._spatialGrid.get(key);
                if (!cell) continue;
                for (let k = 0; k < cell.length; k++) {
                    const idx = cell[k];
                    if (idx >= latestSafe) continue;
                    const other = this.points[idx].position;
                    const ddx = x - other.x;
                    const ddz = z - other.z;
                    if (ddx * ddx + ddz * ddz < minDistSq) return true;
                }
            }
        }
        return false;
    }

    // ── Turn pattern selection ──────────────────────────────────

    _pickTurnPattern() {
        const r = Math.random();
        if (r < 0.30) return 'gradual-s';    // gradual S-curve hairpin
        if (r < 0.55) return 'sharp-right';   // sudden sharp right
        if (r < 0.80) return 'whiplash';       // light left, hard right
        return 'chicane';                       // hard left, hard right rapid combo
    }

    _generatePoints(count) {
        for (let i = 0; i < count; i++) {
            const ptIndex = this.points.length;
            let pos;
            if (ptIndex === 0) {
                pos = new THREE.Vector3(0, 0, 0);
            } else {
                const last = this.points[ptIndex - 1].position;

                // ── Turn Pattern State Machine ──
                let curvatureClampMax = 0.04;
                let smoothRate = 0.08;

                if (this._turnPhase === 'none') {
                    this._turnCooldown--;
                    if (this._turnCooldown <= 0) {
                        // Don't start a new turn if we're near existing road
                        const preCheckDist = this._nearestRoadDistance(
                            { x: last.x, z: last.z }, 100
                        );
                        if (preCheckDist < ROAD_HALF_WIDTH * 4 + SHOULDER_WIDTH * 2 + 30) {
                            // Too close to existing road — postpone the turn
                            this._turnCooldown = 40;
                        } else {
                            this._turnPattern = this._pickTurnPattern();
                            this._turnDirection = Math.random() < 0.5 ? 1 : -1;
                            this._turnPhase = 'leadin';
                            this._turnPhaseRemaining = 15;
                        }
                    }
                }

                if (this._turnPhase === 'leadin') {
                    // Straighten before the pattern
                    this.targetCurvature = 0;
                    curvatureClampMax = 0.01;
                    smoothRate = 0.12;
                    this._turnPhaseRemaining--;
                    if (this._turnPhaseRemaining <= 0) {
                        this._turnPhase = 'exec';
                        this._turnExecStep = 0;
                        this._turnPhaseRemaining = this._getPatternDuration();
                    }
                } else if (this._turnPhase === 'exec') {
                    const result = this._execTurnPattern(curvatureClampMax, smoothRate);
                    curvatureClampMax = result.clamp;
                    smoothRate = result.smooth;
                    this._turnPhaseRemaining--;
                    if (this._turnPhaseRemaining <= 0) {
                        this._turnPhase = 'leadout';
                        this._turnPhaseRemaining = 15;
                    }
                } else if (this._turnPhase === 'leadout') {
                    this.targetCurvature = 0;
                    curvatureClampMax = 0.01;
                    smoothRate = 0.12;
                    this._turnPhaseRemaining--;
                    if (this._turnPhaseRemaining <= 0) {
                        this._turnPhase = 'none';
                        this._turnCooldown = 80 + Math.floor(Math.random() * 120);
                    }
                } else {
                    // Normal gentle curves
                    this.targetCurvature += (Math.random() - 0.5) * 0.05;
                }

                // Clamp and smooth curvature
                this.targetCurvature = clamp(this.targetCurvature, -curvatureClampMax, curvatureClampMax);
                this.currentCurvature += (this.targetCurvature - this.currentCurvature) * smoothRate;

                // ── Proactive self-intersection avoidance ──
                // Check proximity to existing road and dampen curvature proactively
                const probeDist = this._nearestRoadDistance(
                    { x: last.x, z: last.z }, 100
                );
                const warningDist = ROAD_HALF_WIDTH * 4 + SHOULDER_WIDTH * 2 + 20; // ~63m warning zone
                const dangerDist = ROAD_HALF_WIDTH * 2 + SHOULDER_WIDTH * 2 + 10;  // ~33m danger zone
                if (probeDist < warningDist && probeDist > dangerDist) {
                    // In warning zone: reduce turn aggressiveness
                    const dampFactor = (probeDist - dangerDist) / (warningDist - dangerDist);
                    this.targetCurvature *= dampFactor;
                    curvatureClampMax *= dampFactor;
                    // Re-clamp after damping
                    this.targetCurvature = clamp(this.targetCurvature, -curvatureClampMax, curvatureClampMax);
                    this.currentCurvature += (this.targetCurvature - this.currentCurvature) * smoothRate;
                } else if (probeDist <= dangerDist) {
                    // In danger zone: force straightening and abort turn
                    this.targetCurvature = 0;
                    this.currentCurvature *= 0.3;
                    if (this._turnPhase === 'exec') {
                        this._turnPhase = 'leadout';
                        this._turnPhaseRemaining = 15;
                    }
                }

                // ── Self-intersection check with segment crossing ──
                const savedAngle = this.currentAngle;
                const savedCurvature = this.currentCurvature;
                this.currentAngle += this.currentCurvature;

                let candidatePos = new THREE.Vector3(
                    last.x + Math.sin(this.currentAngle) * POINT_SPACING,
                    0,
                    last.z - Math.cos(this.currentAngle) * POINT_SPACING
                );

                // Combined check: proximity + segment crossing + look-ahead
                const intersects = this._wouldSelfIntersect(candidatePos) ||
                    this._segmentCrossesRoad(last.x, last.z, candidatePos.x, candidatePos.z) ||
                    this._lookAheadIntersects(candidatePos, this.currentAngle, this.currentCurvature, 6);

                if (intersects) {
                    // Try steering away: 20 correction attempts with larger range
                    let resolved = false;
                    for (let attempt = 1; attempt <= 20; attempt++) {
                        // Alternate left/right corrections of increasing magnitude
                        const sign = (attempt % 2 === 0) ? 1 : -1;
                        const nudge = sign * attempt * 0.04; // larger steps, up to ±0.4 rad (~23°)
                        this.currentAngle = savedAngle + savedCurvature + nudge;
                        candidatePos = new THREE.Vector3(
                            last.x + Math.sin(this.currentAngle) * POINT_SPACING,
                            0,
                            last.z - Math.cos(this.currentAngle) * POINT_SPACING
                        );
                        // Verify the corrected direction is also safe in look-ahead
                        if (!this._wouldSelfIntersect(candidatePos) &&
                            !this._segmentCrossesRoad(last.x, last.z, candidatePos.x, candidatePos.z) &&
                            !this._lookAheadIntersects(candidatePos, this.currentAngle, 0, 4)) {
                            this.currentCurvature = nudge * 0.4;
                            this.targetCurvature = 0;
                            if (this._turnPhase === 'exec') {
                                this._turnPhase = 'leadout';
                                this._turnPhaseRemaining = 15;
                            }
                            resolved = true;
                            break;
                        }
                    }
                    if (!resolved) {
                        // Full 360° sweep in 15° increments to find ANY safe direction
                        const step = Math.PI / 12; // 15 degrees
                        let bestAngle = savedAngle;
                        let bestDist = 0;
                        for (let a = 0; a < Math.PI * 2; a += step) {
                            const testAngle = savedAngle + a;
                            const tx = last.x + Math.sin(testAngle) * POINT_SPACING;
                            const tz = last.z - Math.cos(testAngle) * POINT_SPACING;
                            if (!this._wouldSelfIntersectXZ(tx, tz) &&
                                !this._segmentCrossesRoad(last.x, last.z, tx, tz)) {
                                const dist = this._nearestRoadDistance({ x: tx, z: tz }, 100);
                                if (dist > bestDist) {
                                    bestDist = dist;
                                    bestAngle = testAngle;
                                }
                            }
                        }
                        this.currentAngle = bestAngle;
                        this.currentCurvature = 0;
                        this.targetCurvature = 0;
                        candidatePos = new THREE.Vector3(
                            last.x + Math.sin(this.currentAngle) * POINT_SPACING,
                            0,
                            last.z - Math.cos(this.currentAngle) * POINT_SPACING
                        );
                        if (this._turnPhase === 'exec' || this._turnPhase === 'leadin') {
                            this._turnPhase = 'leadout';
                            this._turnPhaseRemaining = 20;
                        }
                        // Increase cooldown to keep road straight after recovery
                        this._turnCooldown = Math.max(this._turnCooldown, 150);
                    }
                }

                pos = candidatePos;
            }
            const forward = new THREE.Vector3(
                Math.sin(this.currentAngle), 0, -Math.cos(this.currentAngle)
            ).normalize();
            const right = new THREE.Vector3(
                Math.cos(this.currentAngle), 0, Math.sin(this.currentAngle)
            ).normalize();
            const newPt = { position: pos.clone(), forward: forward.clone(), right: right.clone() };
            this.points.push(newPt);
            this._registerPoint(ptIndex, pos);
            this.totalDistance += POINT_SPACING;
        }
    }

    // ── Turn pattern durations ──────────────────────────────────

    _getPatternDuration() {
        switch (this._turnPattern) {
            case 'gradual-s':   return 120;  // ~480m total S-curve
            case 'sharp-right': return 18;   // ~72m quick snap
            case 'whiplash':    return 40;   // ~160m light-then-hard
            case 'chicane':     return 50;   // ~200m left-right-left
            default:            return 30;
        }
    }

    // ── Execute active turn pattern for one step ────────────────

    _execTurnPattern(defaultClamp, defaultSmooth) {
        const total = this._getPatternDuration();
        const elapsed = total - this._turnPhaseRemaining;
        const t = elapsed / total; // 0→1 progress
        let clamp_ = defaultClamp;
        let smooth = defaultSmooth;

        switch (this._turnPattern) {
            case 'gradual-s': {
                // Gradual S-curve: smooth sinusoidal curvature, moderate intensity
                // First half curves one way, second half curves the other
                const curveMag = 0.05 + Math.random() * 0.005;
                this.targetCurvature = this._turnDirection * curveMag * Math.sin(t * Math.PI * 2);
                clamp_ = 0.06;
                smooth = 0.06;
                break;
            }
            case 'sharp-right': {
                // Sudden sharp right turn (always right = -1 direction for surprise)
                this.targetCurvature = -0.07 - Math.random() * 0.01;
                clamp_ = 0.09;
                smooth = 0.20;
                break;
            }
            case 'whiplash': {
                // Light drift left, then HARD snap right
                if (t < 0.45) {
                    // Gentle left
                    this.targetCurvature = this._turnDirection * 0.025;
                    clamp_ = 0.04;
                    smooth = 0.08;
                } else {
                    // Hard opposite direction
                    this.targetCurvature = -this._turnDirection * (0.07 + Math.random() * 0.01);
                    clamp_ = 0.09;
                    smooth = 0.18;
                }
                break;
            }
            case 'chicane': {
                // Rapid left-right-left sequence
                const phase3 = t * 3;
                if (phase3 < 1) {
                    // Hard left
                    this.targetCurvature = this._turnDirection * 0.06;
                    clamp_ = 0.08;
                    smooth = 0.15;
                } else if (phase3 < 2) {
                    // Hard right
                    this.targetCurvature = -this._turnDirection * 0.07;
                    clamp_ = 0.09;
                    smooth = 0.18;
                } else {
                    // Mild left recovery
                    this.targetCurvature = this._turnDirection * 0.03;
                    clamp_ = 0.05;
                    smooth = 0.10;
                }
                break;
            }
        }
        return { clamp: clamp_, smooth };
    }

    // ── Chunk Building ─────────────────────────────────────────

    _buildChunk(startIdx, endIdx) {
        const group = new THREE.Group();
        const count = endIdx - startIdx;
        if (count < 2) return null;

        // Road surface (2 lanes)
        const roadGeo = this._buildStripGeometry(startIdx, endIdx, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0, 0, 7);
        const roadMesh = new THREE.Mesh(roadGeo, this._roadMat);
        roadMesh.receiveShadow = true;
        group.add(roadMesh);

        // Left shoulder
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, -SHOULDER_OUTER, -SHOULDER_INNER, 0, 0, SHOULDER_WIDTH),
            this._shoulderMat
        ));
        // Right shoulder
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, SHOULDER_INNER, SHOULDER_OUTER, 0, 0, SHOULDER_WIDTH),
            this._shoulderMat
        ));

        // Left sidewalk
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, -SW_OUTER, -SW_INNER, CURB_HEIGHT, CURB_HEIGHT, SIDEWALK_WIDTH),
            this._sidewalkMat
        ));
        // Right sidewalk
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, SW_INNER, SW_OUTER, CURB_HEIGHT, CURB_HEIGHT, SIDEWALK_WIDTH),
            this._sidewalkMat
        ));

        // Curbs (angled from road level to sidewalk level)
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, -CURB_OUTER, -CURB_INNER, CURB_HEIGHT, 0, CURB_WIDTH),
            this._curbMat
        ));
        group.add(new THREE.Mesh(
            this._buildStripGeometry(startIdx, endIdx, CURB_INNER, CURB_OUTER, 0, CURB_HEIGHT, CURB_WIDTH),
            this._curbMat
        ));

        // ── Lane markings ──────────────────────────────────────
        // Double yellow center line (2 lines with small gap)
        this._addSolidLine(group, startIdx, endIdx, -0.20, 0.02, 0.08, this._yellowMat);
        this._addSolidLine(group, startIdx, endIdx, 0.20, 0.02, 0.08, this._yellowMat);

        // White edge lines (where road meets shoulder)
        this._addSolidLine(group, startIdx, endIdx, -ROAD_HALF_WIDTH + 0.25, 0.02, 0.10, this._markingMat);
        this._addSolidLine(group, startIdx, endIdx, ROAD_HALF_WIDTH - 0.25, 0.02, 0.10, this._markingMat);

        const chunk = { id: this._nextChunkId++, group, startIdx, endIdx, startDist: startIdx * POINT_SPACING };
        this.scene.add(group);
        this.chunks.push(chunk);
        return chunk;
    }

    // ── Strip Geometry with UVs ────────────────────────────────

    _buildStripGeometry(startIdx, endIdx, leftOffset, rightOffset, leftY, rightY, texWidth) {
        const count = endIdx - startIdx;
        const vertices = new Float32Array(count * 2 * 3);
        const normals = new Float32Array(count * 2 * 3);
        const uvs = new Float32Array(count * 2 * 2);
        const indices = [];

        for (let i = 0; i < count; i++) {
            const pt = this.points[startIdx + i];
            const p = pt.position;
            const r = pt.right;
            const vi = i * 6;
            const ui = i * 4;

            vertices[vi] = p.x + r.x * leftOffset;
            vertices[vi + 1] = leftY;
            vertices[vi + 2] = p.z + r.z * leftOffset;
            vertices[vi + 3] = p.x + r.x * rightOffset;
            vertices[vi + 4] = rightY;
            vertices[vi + 5] = p.z + r.z * rightOffset;

            normals[vi] = 0; normals[vi + 1] = 1; normals[vi + 2] = 0;
            normals[vi + 3] = 0; normals[vi + 4] = 1; normals[vi + 5] = 0;

            const v = (i * POINT_SPACING) / (texWidth || 1);
            uvs[ui] = 0;     uvs[ui + 1] = v;
            uvs[ui + 2] = 1; uvs[ui + 3] = v;

            if (i < count - 1) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                // CCW winding from above so faces aren't back-face culled
                indices.push(bl, br, tl, br, tr, tl);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        return geo;
    }

    // ── Lane Markings ──────────────────────────────────────────

    _addDashedLine(group, startIdx, endIdx, lateralOffset, yOffset, halfWidth, material) {
        let accumDist = 0;
        let dashVerts = [], dashIndices = [], vCount = 0;
        for (let i = startIdx; i < endIdx; i++) {
            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;
            if (i > startIdx) accumDist += POINT_SPACING;
            const shouldDraw = (accumDist % (DASH_LENGTH + DASH_GAP)) < DASH_LENGTH;
            if (shouldDraw) {
                dashVerts.push(
                    p.x + r.x * (lateralOffset - halfWidth), yOffset, p.z + r.z * (lateralOffset - halfWidth),
                    p.x + r.x * (lateralOffset + halfWidth), yOffset, p.z + r.z * (lateralOffset + halfWidth)
                );
                if (vCount >= 2) {
                    dashIndices.push(vCount - 2, vCount - 1, vCount, vCount - 1, vCount + 1, vCount);
                }
                vCount += 2;
            } else {
                vCount = 0;
            }
        }
        if (dashVerts.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(dashVerts, 3));
            geo.setIndex(dashIndices);
            geo.computeVertexNormals();
            group.add(new THREE.Mesh(geo, material || this._markingMat));
        }
    }

    _addSolidLine(group, startIdx, endIdx, lateralOffset, yOffset, halfWidth, material) {
        const count = endIdx - startIdx;
        if (count < 2) return;
        const verts = new Float32Array(count * 2 * 3);
        const indices = [];
        for (let i = 0; i < count; i++) {
            const pt = this.points[startIdx + i];
            const p = pt.position;
            const r = pt.right;
            const vi = i * 6;
            verts[vi] = p.x + r.x * (lateralOffset - halfWidth);
            verts[vi + 1] = yOffset;
            verts[vi + 2] = p.z + r.z * (lateralOffset - halfWidth);
            verts[vi + 3] = p.x + r.x * (lateralOffset + halfWidth);
            verts[vi + 4] = yOffset;
            verts[vi + 5] = p.z + r.z * (lateralOffset + halfWidth);
            if (i < count - 1) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                indices.push(bl, br, tl, br, tr, tl);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, material));
    }

    // ── Chunk Management ───────────────────────────────────────

    _buildAllNeededChunks(playerPos) {
        let lastChunkEnd = this.chunks.length > 0 ? this.chunks[this.chunks.length - 1].endIdx : 0;
        const playerIdx = this._findClosestPointIndex(playerPos);
        const aheadIdx = playerIdx + Math.ceil(GENERATE_AHEAD / POINT_SPACING);
        while (this.points.length < aheadIdx + POINTS_PER_CHUNK) {
            this._generatePoints(POINTS_PER_CHUNK);
        }
        while (lastChunkEnd < aheadIdx) {
            // Overlap by 1 point so geometry bridges chunk boundaries
            const start = (lastChunkEnd > 0) ? lastChunkEnd - 1 : 0;
            const end = Math.min(lastChunkEnd + POINTS_PER_CHUNK, this.points.length);
            if (end - start < 2) break;
            this._buildChunk(start, end);
            lastChunkEnd = end;
        }
    }

    _findClosestPointIndex(pos) {
        let bestIdx = 0, bestDist = Infinity;
        const step = Math.max(1, Math.floor(this.points.length / 500));
        for (let i = 0; i < this.points.length; i += step) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        const ss = Math.max(0, bestIdx - step * 2);
        const se = Math.min(this.points.length - 1, bestIdx + step * 2);
        for (let i = ss; i <= se; i++) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    getPointAt(index) {
        return this.points[clamp(index, 0, this.points.length - 1)];
    }

    getRoadInfoAt(pos) {
        const idx = this._findClosestPointIndex(pos);
        const pt = this.points[idx];
        const dx = pos.x - pt.position.x;
        const dz = pos.z - pt.position.z;
        const lateral = dx * pt.right.x + dz * pt.right.z;
        const absLat = Math.abs(lateral);

        const onRoad = absLat < ROAD_HALF_WIDTH;
        const onShoulder = absLat >= ROAD_HALF_WIDTH && absLat < SHOULDER_OUTER;
        const onSidewalk = absLat >= SW_INNER && absLat < SW_OUTER;
        const offRoad = absLat >= SW_OUTER;

        return {
            index: idx, point: pt, lateralOffset: lateral,
            onRoad, onShoulder, onSidewalk, offRoad,
        };
    }

    /**
     * Return chunks with id > lastId (for spawn tracking).
     */
    getNewChunks(lastId) {
        return this.chunks.filter(c => c.id > lastId);
    }

    /**
     * Return the chunk containing the given world position, or null.
     */
    getChunkAt(pos) {
        const idx = this._findClosestPointIndex(pos);
        for (const chunk of this.chunks) {
            if (idx >= chunk.startIdx && idx < chunk.endIdx) {
                return chunk;
            }
        }
        return this.chunks.length > 0 ? this.chunks[0] : null;
    }

    getSpawnPositions(chunkIndex) {
        if (chunkIndex >= this.chunks.length) return [];
        return this._spawnPositionsForChunk(this.chunks[chunkIndex]);
    }

    _spawnPositionsForChunk(chunk) {
        const positions = [];
        for (let i = chunk.startIdx + 2; i < chunk.endIdx - 2; i += 15) {
            const pt = this.points[i];
            const roadLat = randomRange(-ROAD_HALF_WIDTH + 1.5, ROAD_HALF_WIDTH - 1.5);
            positions.push({
                position: new THREE.Vector3(
                    pt.position.x + pt.right.x * roadLat, 0,
                    pt.position.z + pt.right.z * roadLat
                ),
                forward: pt.forward.clone(),
                lateralOffset: roadLat,
                roadIndex: i, type: 'road'
            });
        }
        return positions;
    }

    update(playerPos) {
        // Move ground with player
        this._ground.position.x = playerPos.x;
        this._ground.position.z = playerPos.z;

        // Scroll ground UV so the grass texture stays world-fixed
        // X offset tracks player X; Y offset is negated because the plane
        // rotation (-PI/2 around X) maps local Y to -world Z
        const rep = this._textures.grass.repeat;
        this._textures.grass.offset.x = playerPos.x * rep.x / GROUND_SIZE;
        this._textures.grass.offset.y = -playerPos.z * rep.y / GROUND_SIZE;

        this._buildAllNeededChunks(playerPos);

        this._lastRemovedChunks = [];
        const playerIdx = this._findClosestPointIndex(playerPos);
        const removeBeforeIdx = playerIdx - Math.ceil(REMOVE_BEHIND / POINT_SPACING);
        while (this.chunks.length > 0 && this.chunks[0].endIdx < removeBeforeIdx) {
            const old = this.chunks.shift();
            this._lastRemovedChunks.push(old.id);
            this.scene.remove(old.group);
            old.group.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
            });
        }
    }

    get chunkCount() {
        return this.chunks.length;
    }

    get removedChunkIds() {
        return this._lastRemovedChunks;
    }
}
