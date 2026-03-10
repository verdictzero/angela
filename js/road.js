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

        // Hairpin turn state
        this._hairpinCooldown = 200;  // points until next hairpin (~800m)
        this._hairpinRemaining = 0;   // points remaining in current hairpin
        this._hairpinDirection = 1;   // +1 or -1
        this._hairpinPhase = 'none';  // 'none', 'leadin', 'turn', 'leadout'
        this._hairpinPhaseRemaining = 0;

        // Intersection state
        this.intersections = [];
        this._intersectionCooldown = 250;  // ~1000m

        // Gas station state
        this.gasStations = [];
        this._gasStationCooldown = 400;   // ~1600m

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

    _generatePoints(count) {
        for (let i = 0; i < count; i++) {
            const ptIndex = this.points.length;
            let pos;
            if (ptIndex === 0) {
                pos = new THREE.Vector3(0, 0, 0);
            } else {
                const last = this.points[ptIndex - 1].position;

                // ── Hairpin Turn Logic ──
                let curvatureClampMax = 0.04;
                if (this._hairpinPhase === 'none') {
                    this._hairpinCooldown--;
                    if (this._hairpinCooldown <= 0) {
                        // Start a hairpin: lead-in phase first
                        this._hairpinDirection = Math.random() < 0.5 ? 1 : -1;
                        this._hairpinPhase = 'leadin';
                        this._hairpinPhaseRemaining = 10;
                    }
                }

                if (this._hairpinPhase === 'leadin') {
                    // Straighten out before the turn
                    this.targetCurvature *= 0.8;
                    curvatureClampMax = 0.02;
                    this._hairpinPhaseRemaining--;
                    if (this._hairpinPhaseRemaining <= 0) {
                        this._hairpinPhase = 'turn';
                        this._hairpinPhaseRemaining = 25 + Math.floor(Math.random() * 10);
                    }
                } else if (this._hairpinPhase === 'turn') {
                    // Force high curvature in one direction
                    this.targetCurvature = this._hairpinDirection * (0.12 + Math.random() * 0.03);
                    curvatureClampMax = 0.15;
                    this._hairpinPhaseRemaining--;
                    if (this._hairpinPhaseRemaining <= 0) {
                        this._hairpinPhase = 'leadout';
                        this._hairpinPhaseRemaining = 10;
                    }
                } else if (this._hairpinPhase === 'leadout') {
                    // Gradually return to normal
                    this.targetCurvature *= 0.7;
                    curvatureClampMax = 0.08;
                    this._hairpinPhaseRemaining--;
                    if (this._hairpinPhaseRemaining <= 0) {
                        this._hairpinPhase = 'none';
                        this._hairpinCooldown = 150 + Math.floor(Math.random() * 150);
                    }
                } else {
                    // Normal curvature
                    this.targetCurvature += (Math.random() - 0.5) * 0.06;
                }

                // ── Intersection / Gas Station: force straight ──
                let forceStraight = false;

                this._intersectionCooldown--;
                if (this._intersectionCooldown <= 0 && this._hairpinPhase === 'none') {
                    const forward = new THREE.Vector3(
                        Math.sin(this.currentAngle), 0, -Math.cos(this.currentAngle)
                    ).normalize();
                    const right = new THREE.Vector3(
                        Math.cos(this.currentAngle), 0, Math.sin(this.currentAngle)
                    ).normalize();
                    this.intersections.push({
                        pointIndex: ptIndex,
                        position: last.clone(),
                        forward: forward.clone(),
                        right: right.clone(),
                    });
                    this._intersectionCooldown = 200 + Math.floor(Math.random() * 100);
                    forceStraight = true;
                }

                this._gasStationCooldown--;
                if (this._gasStationCooldown <= 0 && this._hairpinPhase === 'none') {
                    const forward = new THREE.Vector3(
                        Math.sin(this.currentAngle), 0, -Math.cos(this.currentAngle)
                    ).normalize();
                    const right = new THREE.Vector3(
                        Math.cos(this.currentAngle), 0, Math.sin(this.currentAngle)
                    ).normalize();
                    const side = Math.random() < 0.5 ? 1 : -1;
                    this.gasStations.push({
                        pointIndex: ptIndex,
                        position: last.clone(),
                        forward: forward.clone(),
                        right: right.clone(),
                        side,  // +1 = right side, -1 = left side
                    });
                    this._gasStationCooldown = 350 + Math.floor(Math.random() * 100);
                    forceStraight = true;
                }

                if (forceStraight) {
                    this.targetCurvature = 0;
                    this.currentCurvature *= 0.3;
                }

                // Clamp curvature
                this.targetCurvature = clamp(this.targetCurvature, -curvatureClampMax, curvatureClampMax);
                this.currentCurvature += (this.targetCurvature - this.currentCurvature) * 0.08;
                this.currentAngle += this.currentCurvature;
                pos = new THREE.Vector3(
                    last.x + Math.sin(this.currentAngle) * POINT_SPACING,
                    0,
                    last.z - Math.cos(this.currentAngle) * POINT_SPACING
                );
            }
            const forward = new THREE.Vector3(
                Math.sin(this.currentAngle), 0, -Math.cos(this.currentAngle)
            ).normalize();
            const right = new THREE.Vector3(
                Math.cos(this.currentAngle), 0, Math.sin(this.currentAngle)
            ).normalize();
            this.points.push({ position: pos.clone(), forward: forward.clone(), right: right.clone() });
            this.totalDistance += POINT_SPACING;
        }
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

        // ── Intersections ──────────────────────────────────────
        for (const ix of this.intersections) {
            if (ix.pointIndex >= startIdx && ix.pointIndex < endIdx) {
                this._buildIntersection(group, ix);
            }
        }

        // ── Gas Stations ──────────────────────────────────────
        for (const gs of this.gasStations) {
            if (gs.pointIndex >= startIdx && gs.pointIndex < endIdx) {
                this._buildGasStation(group, gs);
            }
        }

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

    // ── Intersection Geometry ─────────────────────────────────

    _buildIntersection(group, ix) {
        const pos = ix.position;
        const right = ix.right;  // perpendicular to main road = direction of cross-road
        const fwd = ix.forward;  // main road forward = cross-road's lateral

        const CROSS_LENGTH = 40;   // how far the cross-road extends each side
        const CROSS_HALF_WIDTH = 6; // half-width of cross-road
        const CROSS_SHOULDER = 2;   // shoulder width on cross-road
        const SEGMENTS = 20;

        // Build cross-road surface as a flat strip along the right vector
        const verts = [];
        const uvs = [];
        const indices = [];

        for (let i = 0; i <= SEGMENTS; i++) {
            const t = (i / SEGMENTS) * 2 - 1; // -1 to 1
            const dist = t * CROSS_LENGTH;
            const cx = pos.x + right.x * dist;
            const cz = pos.z + right.z * dist;

            // Left and right edges (using main road forward as lateral direction for cross-road)
            verts.push(
                cx - fwd.x * CROSS_HALF_WIDTH, 0.005, cz - fwd.z * CROSS_HALF_WIDTH,
                cx + fwd.x * CROSS_HALF_WIDTH, 0.005, cz + fwd.z * CROSS_HALF_WIDTH
            );

            const v = (i / SEGMENTS) * CROSS_LENGTH * 2 / 7;
            uvs.push(0, v, 1, v);

            if (i < SEGMENTS) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                indices.push(bl, br, tl, br, tr, tl);
            }
        }

        const crossGeo = new THREE.BufferGeometry();
        crossGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        crossGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        crossGeo.setIndex(indices);
        crossGeo.computeVertexNormals();
        group.add(new THREE.Mesh(crossGeo, this._roadMat));

        // Cross-road shoulders
        for (const sideSign of [-1, 1]) {
            const sVerts = [];
            const sUvs = [];
            const sIndices = [];
            for (let i = 0; i <= SEGMENTS; i++) {
                const t = (i / SEGMENTS) * 2 - 1;
                const dist = t * CROSS_LENGTH;
                const cx = pos.x + right.x * dist;
                const cz = pos.z + right.z * dist;

                const innerEdge = CROSS_HALF_WIDTH * sideSign;
                const outerEdge = (CROSS_HALF_WIDTH + CROSS_SHOULDER) * sideSign;

                sVerts.push(
                    cx + fwd.x * innerEdge, 0.003, cz + fwd.z * innerEdge,
                    cx + fwd.x * outerEdge, 0.003, cz + fwd.z * outerEdge
                );
                const v = (i / SEGMENTS) * CROSS_LENGTH * 2 / 3;
                sUvs.push(0, v, 1, v);
                if (i < SEGMENTS) {
                    const bl = i * 2, br = i * 2 + 1;
                    const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                    sIndices.push(bl, br, tl, br, tr, tl);
                }
            }
            const sGeo = new THREE.BufferGeometry();
            sGeo.setAttribute('position', new THREE.Float32BufferAttribute(sVerts, 3));
            sGeo.setAttribute('uv', new THREE.Float32BufferAttribute(sUvs, 2));
            sGeo.setIndex(sIndices);
            sGeo.computeVertexNormals();
            group.add(new THREE.Mesh(sGeo, this._shoulderMat));
        }

        // Stop lines on cross-road approaches (white lines where cross-road meets main road)
        for (const sideSign of [-1, 1]) {
            const lineDist = ROAD_HALF_WIDTH + SHOULDER_WIDTH + 1; // just outside main road shoulder
            const lx = pos.x + right.x * lineDist * sideSign;
            const lz = pos.z + right.z * lineDist * sideSign;
            const lineGeo = new THREE.PlaneGeometry(CROSS_HALF_WIDTH * 2, 0.4);
            lineGeo.rotateX(-Math.PI / 2);
            const lineMesh = new THREE.Mesh(lineGeo, this._markingMat);
            lineMesh.position.set(lx, 0.02, lz);
            lineMesh.rotation.y = Math.atan2(fwd.x, fwd.z);
            group.add(lineMesh);
        }

        // Center dashed line on cross-road
        for (let i = 0; i <= SEGMENTS; i++) {
            const t = (i / SEGMENTS) * 2 - 1;
            const dist = t * CROSS_LENGTH;
            // Skip the section that overlaps main road
            if (Math.abs(dist) < ROAD_HALF_WIDTH + SHOULDER_WIDTH + 2) continue;
            // Only draw dashes
            const dashPos = Math.abs(dist) % (DASH_LENGTH + DASH_GAP);
            if (dashPos > DASH_LENGTH) continue;

            const cx = pos.x + right.x * dist;
            const cz = pos.z + right.z * dist;
            const dashGeo = new THREE.PlaneGeometry(0.15, POINT_SPACING * 0.8);
            dashGeo.rotateX(-Math.PI / 2);
            const dashMesh = new THREE.Mesh(dashGeo, this._yellowMat);
            dashMesh.position.set(cx, 0.02, cz);
            dashMesh.rotation.y = Math.atan2(right.x, right.z);
            group.add(dashMesh);
        }
    }

    // ── Gas Station Geometry ──────────────────────────────────

    _buildGasStation(group, gs) {
        const pos = gs.position;
        const fwd = gs.forward;
        const right = gs.right;
        const side = gs.side; // +1 right, -1 left

        // Pulloff area dimensions
        const PULLOFF_LENGTH = 24;
        const PULLOFF_WIDTH = 14;
        const PULLOFF_LATERAL_START = SW_OUTER + 1; // just beyond sidewalk

        // Center of the pulloff area
        const pulloffCenterLat = PULLOFF_LATERAL_START + PULLOFF_WIDTH / 2;
        const cx = pos.x + right.x * pulloffCenterLat * side;
        const cz = pos.z + right.z * pulloffCenterLat * side;

        // Pulloff surface (flat asphalt)
        const pulloffGeo = new THREE.PlaneGeometry(PULLOFF_LENGTH, PULLOFF_WIDTH);
        pulloffGeo.rotateX(-Math.PI / 2);
        const pulloffMesh = new THREE.Mesh(pulloffGeo, this._roadMat);
        pulloffMesh.position.set(cx, 0.004, cz);
        pulloffMesh.rotation.y = Math.atan2(fwd.x, fwd.z);
        group.add(pulloffMesh);

        // Canopy — thin wide roof
        const CANOPY_WIDTH = 10;
        const CANOPY_DEPTH = 6;
        const CANOPY_HEIGHT = 4.2;
        const CANOPY_THICKNESS = 0.25;
        const canopyMat = new THREE.MeshLambertMaterial({ color: 0x334455 });

        // Canopy center (slightly further from road than pulloff center)
        const canopyCenterLat = PULLOFF_LATERAL_START + 5;
        const canopyX = pos.x + right.x * canopyCenterLat * side;
        const canopyZ = pos.z + right.z * canopyCenterLat * side;

        // Roof
        const roofGeo = new THREE.BoxGeometry(CANOPY_WIDTH, CANOPY_THICKNESS, CANOPY_DEPTH);
        const roofMesh = new THREE.Mesh(roofGeo, canopyMat);
        roofMesh.position.set(canopyX, CANOPY_HEIGHT, canopyZ);
        roofMesh.rotation.y = Math.atan2(fwd.x, fwd.z);
        group.add(roofMesh);

        // 4 pillars
        const pillarMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
        const pillarGeo = new THREE.BoxGeometry(0.3, CANOPY_HEIGHT, 0.3);
        const pillarOffsets = [
            [-CANOPY_WIDTH / 2 + 0.5, -CANOPY_DEPTH / 2 + 0.5],
            [CANOPY_WIDTH / 2 - 0.5, -CANOPY_DEPTH / 2 + 0.5],
            [-CANOPY_WIDTH / 2 + 0.5, CANOPY_DEPTH / 2 - 0.5],
            [CANOPY_WIDTH / 2 - 0.5, CANOPY_DEPTH / 2 - 0.5],
        ];
        for (const [along, across] of pillarOffsets) {
            const px = canopyX + fwd.x * along + right.x * across * side;
            const pz = canopyZ + fwd.z * along + right.z * across * side;
            const pillar = new THREE.Mesh(pillarGeo, pillarMat);
            pillar.position.set(px, CANOPY_HEIGHT / 2, pz);
            group.add(pillar);
        }

        // Pump islands — 2 pumps under canopy
        const pumpMat = new THREE.MeshLambertMaterial({ color: 0xcc4444 });
        const pumpGeo = new THREE.BoxGeometry(0.5, 1.4, 0.4);
        for (let pi = 0; pi < 2; pi++) {
            const along = (pi - 0.5) * 4;
            const px = canopyX + fwd.x * along;
            const pz = canopyZ + fwd.z * along;
            const pump = new THREE.Mesh(pumpGeo, pumpMat);
            pump.position.set(px, 0.7, pz);
            pump.rotation.y = Math.atan2(fwd.x, fwd.z);
            group.add(pump);
        }

        // Building behind canopy
        const buildingMat = new THREE.MeshLambertMaterial({ color: 0x665544 });
        const BLDG_WIDTH = 8;
        const BLDG_DEPTH = 5;
        const BLDG_HEIGHT = 3.5;
        const bldgLat = PULLOFF_LATERAL_START + PULLOFF_WIDTH - BLDG_DEPTH / 2;
        const bldgX = pos.x + right.x * bldgLat * side;
        const bldgZ = pos.z + right.z * bldgLat * side;
        const buildingGeo = new THREE.BoxGeometry(BLDG_WIDTH, BLDG_HEIGHT, BLDG_DEPTH);
        const building = new THREE.Mesh(buildingGeo, buildingMat);
        building.position.set(bldgX, BLDG_HEIGHT / 2, bldgZ);
        building.rotation.y = Math.atan2(fwd.x, fwd.z);
        group.add(building);

        // Store bounds for refuel detection
        gs.pulloffCenter = new THREE.Vector3(cx, 0, cz);
        gs.pulloffHalfLength = PULLOFF_LENGTH / 2;
        gs.pulloffHalfWidth = PULLOFF_WIDTH / 2;
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

        let onRoad = absLat < ROAD_HALF_WIDTH;
        let onShoulder = absLat >= ROAD_HALF_WIDTH && absLat < SHOULDER_OUTER;
        const onSidewalk = absLat >= SW_INNER && absLat < SW_OUTER;
        let offRoad = absLat >= SW_OUTER;

        // Check if on an intersection cross-road
        if (!onRoad) {
            for (const ix of this.intersections) {
                const ix_dx = pos.x - ix.position.x;
                const ix_dz = pos.z - ix.position.z;
                // Distance along cross-road (right vector of main road)
                const alongCross = ix_dx * ix.right.x + ix_dz * ix.right.z;
                // Distance lateral to cross-road (forward vector of main road)
                const lateralCross = Math.abs(ix_dx * ix.forward.x + ix_dz * ix.forward.z);
                if (Math.abs(alongCross) < 40 && lateralCross < 6) {
                    onRoad = true;
                    onShoulder = false;
                    offRoad = false;
                    break;
                }
                if (Math.abs(alongCross) < 40 && lateralCross < 8) {
                    onShoulder = true;
                    offRoad = false;
                    break;
                }
            }
        }

        // Check if on a gas station pulloff
        if (offRoad) {
            for (const gs of this.gasStations) {
                if (!gs.pulloffCenter) continue;
                const gs_dx = pos.x - gs.pulloffCenter.x;
                const gs_dz = pos.z - gs.pulloffCenter.z;
                const alongRoad = Math.abs(gs_dx * gs.forward.x + gs_dz * gs.forward.z);
                const acrossRoad = Math.abs(gs_dx * gs.right.x + gs_dz * gs.right.z);
                if (alongRoad < gs.pulloffHalfLength && acrossRoad < gs.pulloffHalfWidth) {
                    onRoad = true;
                    offRoad = false;
                    break;
                }
            }
        }

        return {
            index: idx, point: pt, lateralOffset: lateral,
            onRoad, onShoulder, onSidewalk, offRoad,
        };
    }

    getGasStationAt(pos) {
        for (const gs of this.gasStations) {
            if (!gs.pulloffCenter) continue;
            const dx = pos.x - gs.pulloffCenter.x;
            const dz = pos.z - gs.pulloffCenter.z;
            const alongRoad = Math.abs(dx * gs.forward.x + dz * gs.forward.z);
            const acrossRoad = Math.abs(dx * gs.right.x + dz * gs.right.z);
            if (alongRoad < gs.pulloffHalfLength && acrossRoad < gs.pulloffHalfWidth) {
                return gs;
            }
        }
        return null;
    }

    getIntersections() {
        return this.intersections;
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
