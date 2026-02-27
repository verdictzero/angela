/**
 * Infinite Procedural Road Generator
 *
 * Generates road segments as chunks along a smooth spline path.
 * Each chunk includes road surface, sidewalks, curbs, and lane markings.
 */

import * as THREE from 'three';
import { randomRange, clamp, createCanvasTexture } from './utils.js';

// Road dimensions
const ROAD_HALF_WIDTH = 6;
const CURB_WIDTH = 0.3;
const CURB_HEIGHT = 0.15;
const SIDEWALK_WIDTH = 3.5;
const POINT_SPACING = 4;          // distance between road centerline points
const POINTS_PER_CHUNK = 40;      // points per chunk
const GENERATE_AHEAD = 500;       // generate road this far ahead (meters)
const REMOVE_BEHIND = 200;        // remove chunks this far behind (meters)
const DASH_LENGTH = 3;
const DASH_GAP = 4;

export class RoadManager {
    constructor(scene) {
        this.scene = scene;
        this.points = [];           // Array of { position: Vector3, forward: Vector3, right: Vector3 }
        this.chunks = [];           // Array of { group: THREE.Group, startIdx, endIdx, startDist }
        this.currentAngle = 0;
        this.currentCurvature = 0;
        this.targetCurvature = 0;
        this.totalDistance = 0;

        // Materials
        this._roadMat = new THREE.MeshLambertMaterial({ color: 0x333338 });
        this._sidewalkMat = new THREE.MeshLambertMaterial({ color: 0x666666 });
        this._curbMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
        this._markingMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
        this._edgeMarkingMat = new THREE.MeshBasicMaterial({ color: 0xcccc44 });

        // Ground plane
        this._groundMat = new THREE.MeshLambertMaterial({ color: 0x2a3a1a });
        this._ground = new THREE.Mesh(
            new THREE.PlaneGeometry(2000, 2000),
            this._groundMat
        );
        this._ground.rotation.x = -Math.PI / 2;
        this._ground.position.y = -0.01;
        this._ground.receiveShadow = true;
        this.scene.add(this._ground);

        // Generate initial road
        this._generatePoints(POINTS_PER_CHUNK * 5);
        this._buildAllNeededChunks(new THREE.Vector3(0, 0, 0));
    }

    /**
     * Generate N new road centerline points.
     */
    _generatePoints(count) {
        for (let i = 0; i < count; i++) {
            let pos;
            if (this.points.length === 0) {
                pos = new THREE.Vector3(0, 0, 0);
            } else {
                const last = this.points[this.points.length - 1].position;

                // Smoothly vary curvature
                this.targetCurvature += (Math.random() - 0.5) * 0.06;
                this.targetCurvature = clamp(this.targetCurvature, -0.04, 0.04);
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

    /**
     * Build a mesh chunk from point range [startIdx, endIdx).
     */
    _buildChunk(startIdx, endIdx) {
        const group = new THREE.Group();
        const count = endIdx - startIdx;
        if (count < 2) return null;

        // Build road surface
        const roadGeo = this._buildStripGeometry(startIdx, endIdx, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0, 0);
        const roadMesh = new THREE.Mesh(roadGeo, this._roadMat);
        roadMesh.receiveShadow = true;
        group.add(roadMesh);

        // Build left sidewalk
        const lswOuter = -(ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH);
        const lswInner = -(ROAD_HALF_WIDTH + CURB_WIDTH);
        const lswGeo = this._buildStripGeometry(startIdx, endIdx, lswOuter, lswInner, CURB_HEIGHT, CURB_HEIGHT);
        const lswMesh = new THREE.Mesh(lswGeo, this._sidewalkMat);
        lswMesh.receiveShadow = true;
        group.add(lswMesh);

        // Build right sidewalk
        const rswInner = ROAD_HALF_WIDTH + CURB_WIDTH;
        const rswOuter = ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH;
        const rswGeo = this._buildStripGeometry(startIdx, endIdx, rswInner, rswOuter, CURB_HEIGHT, CURB_HEIGHT);
        const rswMesh = new THREE.Mesh(rswGeo, this._sidewalkMat);
        rswMesh.receiveShadow = true;
        group.add(rswMesh);

        // Build curbs (top face — small horizontal strip at curb height)
        const lcGeo = this._buildStripGeometry(startIdx, endIdx, -ROAD_HALF_WIDTH - CURB_WIDTH, -ROAD_HALF_WIDTH, 0, CURB_HEIGHT);
        group.add(new THREE.Mesh(lcGeo, this._curbMat));

        const rcGeo = this._buildStripGeometry(startIdx, endIdx, ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + CURB_WIDTH, CURB_HEIGHT, 0);
        group.add(new THREE.Mesh(rcGeo, this._curbMat));

        // Lane markings — dashed center line
        this._addDashedLine(group, startIdx, endIdx, 0, 0.02, 0.15);

        // Edge lines (solid yellow)
        this._addSolidLine(group, startIdx, endIdx, -ROAD_HALF_WIDTH + 0.3, 0.02, 0.1, this._edgeMarkingMat);
        this._addSolidLine(group, startIdx, endIdx, ROAD_HALF_WIDTH - 0.3, 0.02, 0.1, this._edgeMarkingMat);

        const chunk = {
            group,
            startIdx,
            endIdx,
            startDist: startIdx * POINT_SPACING
        };

        this.scene.add(group);
        this.chunks.push(chunk);
        return chunk;
    }

    /**
     * Build a strip of quads between road points, offset left/right from center.
     */
    _buildStripGeometry(startIdx, endIdx, leftOffset, rightOffset, leftY, rightY) {
        const count = endIdx - startIdx;
        const vertices = new Float32Array(count * 2 * 3);
        const indices = [];
        const normals = new Float32Array(count * 2 * 3);

        for (let i = 0; i < count; i++) {
            const pt = this.points[startIdx + i];
            const p = pt.position;
            const r = pt.right;

            // Left vertex
            const li = i * 6;
            vertices[li] = p.x + r.x * leftOffset;
            vertices[li + 1] = leftY;
            vertices[li + 2] = p.z + r.z * leftOffset;

            // Right vertex
            vertices[li + 3] = p.x + r.x * rightOffset;
            vertices[li + 4] = rightY;
            vertices[li + 5] = p.z + r.z * rightOffset;

            // Normals (up)
            normals[li] = 0; normals[li + 1] = 1; normals[li + 2] = 0;
            normals[li + 3] = 0; normals[li + 4] = 1; normals[li + 5] = 0;

            // Indices (two triangles per quad, except for the last point)
            if (i < count - 1) {
                const bl = i * 2;
                const br = i * 2 + 1;
                const tl = (i + 1) * 2;
                const tr = (i + 1) * 2 + 1;
                indices.push(bl, tl, br);
                indices.push(br, tl, tr);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setIndex(indices);
        return geo;
    }

    /**
     * Add dashed center line markings to a chunk.
     */
    _addDashedLine(group, startIdx, endIdx, lateralOffset, yOffset, halfWidth) {
        let accumDist = 0;
        let inDash = true;
        let dashVerts = [];
        let dashIndices = [];
        let vCount = 0;

        for (let i = startIdx; i < endIdx; i++) {
            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;
            const f = pt.forward;

            if (i > startIdx) accumDist += POINT_SPACING;

            const totalDist = accumDist;
            const cycle = totalDist % (DASH_LENGTH + DASH_GAP);
            const shouldDraw = cycle < DASH_LENGTH;

            if (shouldDraw) {
                // Add vertices
                const lx = p.x + r.x * (lateralOffset - halfWidth);
                const lz = p.z + r.z * (lateralOffset - halfWidth);
                const rx = p.x + r.x * (lateralOffset + halfWidth);
                const rz = p.z + r.z * (lateralOffset + halfWidth);

                dashVerts.push(lx, yOffset, lz, rx, yOffset, rz);

                if (vCount >= 2) {
                    const bl = vCount - 2;
                    const br = vCount - 1;
                    const tl = vCount;
                    const tr = vCount + 1;
                    dashIndices.push(bl, tl, br, br, tl, tr);
                }
                vCount += 2;
            } else {
                // Gap: reset vertex tracking for next dash
                if (vCount > 0) {
                    vCount = 0;
                }
                vCount = 0;
            }
        }

        if (dashVerts.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(dashVerts, 3));
            geo.setIndex(dashIndices);
            geo.computeVertexNormals();
            group.add(new THREE.Mesh(geo, this._markingMat));
        }
    }

    /**
     * Add a solid line along the road.
     */
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
                indices.push(bl, tl, br, br, tl, tr);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, material));
    }

    /**
     * Build all chunks needed to cover the area around the player.
     */
    _buildAllNeededChunks(playerPos) {
        // Find furthest generated chunk end
        let lastChunkEnd = 0;
        if (this.chunks.length > 0) {
            lastChunkEnd = this.chunks[this.chunks.length - 1].endIdx;
        }

        // Find player's approximate index on the road
        const playerIdx = this._findClosestPointIndex(playerPos);
        const aheadIdx = playerIdx + Math.ceil(GENERATE_AHEAD / POINT_SPACING);

        // Generate more points if needed
        while (this.points.length < aheadIdx + POINTS_PER_CHUNK) {
            this._generatePoints(POINTS_PER_CHUNK);
        }

        // Build chunks from lastChunkEnd to aheadIdx
        while (lastChunkEnd < aheadIdx) {
            const start = lastChunkEnd;
            const end = Math.min(start + POINTS_PER_CHUNK, this.points.length);
            if (end - start < 2) break;
            this._buildChunk(start, end);
            lastChunkEnd = end;
        }
    }

    /**
     * Find the closest road point to a world position.
     */
    _findClosestPointIndex(pos) {
        let bestIdx = 0;
        let bestDist = Infinity;

        // Only check every few points for performance
        const step = Math.max(1, Math.floor(this.points.length / 500));
        for (let i = 0; i < this.points.length; i += step) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        // Refine around best guess
        const searchStart = Math.max(0, bestIdx - step * 2);
        const searchEnd = Math.min(this.points.length - 1, bestIdx + step * 2);
        for (let i = searchStart; i <= searchEnd; i++) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        return bestIdx;
    }

    /**
     * Get the road point and info at a given index.
     */
    getPointAt(index) {
        const idx = clamp(index, 0, this.points.length - 1);
        return this.points[idx];
    }

    /**
     * Get road info at player's approximate position.
     */
    getRoadInfoAt(pos) {
        const idx = this._findClosestPointIndex(pos);
        const pt = this.points[idx];
        // Compute lateral offset
        const dx = pos.x - pt.position.x;
        const dz = pos.z - pt.position.z;
        const lateral = dx * pt.right.x + dz * pt.right.z;
        const along = dx * pt.forward.x + dz * pt.forward.z;
        return {
            index: idx,
            point: pt,
            lateralOffset: lateral,
            alongOffset: along,
            onRoad: Math.abs(lateral) < ROAD_HALF_WIDTH,
            onSidewalk: Math.abs(lateral) > ROAD_HALF_WIDTH + CURB_WIDTH &&
                Math.abs(lateral) < ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH
        };
    }

    /**
     * Get spawn positions for a chunk (for monster/prop placement).
     */
    getSpawnPositions(chunkIndex) {
        if (chunkIndex >= this.chunks.length) return [];
        const chunk = this.chunks[chunkIndex];
        const positions = [];

        for (let i = chunk.startIdx + 5; i < chunk.endIdx - 5; i += 8) {
            const pt = this.points[i];
            // Spawn on road
            const roadLateral = randomRange(-ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH - 1);
            positions.push({
                position: new THREE.Vector3(
                    pt.position.x + pt.right.x * roadLateral,
                    0,
                    pt.position.z + pt.right.z * roadLateral
                ),
                roadIndex: i,
                type: 'road'
            });

            // Spawn on sidewalk occasionally
            if (Math.random() > 0.5) {
                const side = Math.random() > 0.5 ? 1 : -1;
                const swLateral = side * (ROAD_HALF_WIDTH + CURB_WIDTH + randomRange(0.5, SIDEWALK_WIDTH - 0.5));
                positions.push({
                    position: new THREE.Vector3(
                        pt.position.x + pt.right.x * swLateral,
                        CURB_HEIGHT,
                        pt.position.z + pt.right.z * swLateral
                    ),
                    roadIndex: i,
                    type: 'sidewalk'
                });
            }
        }

        return positions;
    }

    /**
     * Update road — generate ahead, remove behind.
     */
    update(playerPos) {
        // Move ground with player
        this._ground.position.x = playerPos.x;
        this._ground.position.z = playerPos.z;

        // Generate new chunks ahead
        this._buildAllNeededChunks(playerPos);

        // Remove old chunks behind
        const playerIdx = this._findClosestPointIndex(playerPos);
        const removeBeforeIdx = playerIdx - Math.ceil(REMOVE_BEHIND / POINT_SPACING);

        while (this.chunks.length > 0 && this.chunks[0].endIdx < removeBeforeIdx) {
            const old = this.chunks.shift();
            this.scene.remove(old.group);
            old.group.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
            });
        }
    }

    get chunkCount() {
        return this.chunks.length;
    }
}
