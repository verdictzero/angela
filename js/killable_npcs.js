/**
 * Killable NPC Manager — Moped Riders (InstancedMesh)
 *
 * Spawns moped riders on the road that drive in the same direction
 * as the player at varying slower speeds. NPCs follow the road
 * by advancing along road spine points. Uses three InstancedMeshes
 * (back/front/side) to show the correct sprite based on viewing angle.
 */

import * as THREE from 'three';
import { createUnlitMaterial } from './shaders.js';
import { randomRange, normalizeAngle } from './utils.js';

const HIT_RADIUS = 2.5;             // hit detection radius
const HIT_FORWARD = 4;              // how far in front of car to check
const MAX_NPCS = 120;
const DESPAWN_BEHIND = 80;           // despawn if this far behind player
const MOPED_SPEED_MIN = 5;          // m/s (~18 km/h)
const MOPED_SPEED_MAX = 12;         // m/s (~43 km/h)
const MOPED_HEIGHT = 2.2;
const MOPED_WIDTH_BACK  = MOPED_HEIGHT * (250 / 625);   // ~0.88m
const MOPED_WIDTH_FRONT = MOPED_HEIGHT * (289 / 625);   // ~1.02m
const MOPED_WIDTH_SIDE  = MOPED_HEIGHT * (628 / 625);   // ~2.21m

const ANGLE_FRONT = Math.PI / 4;      // < 45° from front → front sprite
const ANGLE_BACK  = Math.PI * 3 / 4;  // > 135° from front → back sprite

const STATIC_NPC_SPAWN_CHANCE = 0.08;  // ~8% chance per spawn slot
const STATIC_NPC_HEIGHT = 2.25;
const STATIC_NPC_WIDTH = STATIC_NPC_HEIGHT * 0.5;

// Reusable math objects
const _identityQuat = new THREE.Quaternion();
const _oneScale = new THREE.Vector3(1, 1, 1);
const _matrix = new THREE.Matrix4();
const _camDir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

// Shared textures — loaded once
let mopedBackTexture = null;
let mopedFrontTexture = null;
let mopedSideTexture = null;
let staticNpcTexture = null;

function getMopedBackTexture() {
    if (!mopedBackTexture) {
        mopedBackTexture = new THREE.TextureLoader().load('assets/moped_guy.png');
        mopedBackTexture.colorSpace = THREE.SRGBColorSpace;
        mopedBackTexture.magFilter = THREE.NearestFilter;
        mopedBackTexture.minFilter = THREE.NearestFilter;
    }
    return mopedBackTexture;
}

function getMopedFrontTexture() {
    if (!mopedFrontTexture) {
        mopedFrontTexture = new THREE.TextureLoader().load('assets/moped_guy_front.png');
        mopedFrontTexture.colorSpace = THREE.SRGBColorSpace;
        mopedFrontTexture.magFilter = THREE.NearestFilter;
        mopedFrontTexture.minFilter = THREE.NearestFilter;
    }
    return mopedFrontTexture;
}

function getMopedSideTexture() {
    if (!mopedSideTexture) {
        mopedSideTexture = new THREE.TextureLoader().load('assets/moped_guy_side.png');
        mopedSideTexture.colorSpace = THREE.SRGBColorSpace;
        mopedSideTexture.magFilter = THREE.NearestFilter;
        mopedSideTexture.minFilter = THREE.NearestFilter;
    }
    return mopedSideTexture;
}

function getStaticNpcTexture() {
    if (!staticNpcTexture) {
        staticNpcTexture = new THREE.TextureLoader().load('assets/static_npc_1.png');
        staticNpcTexture.colorSpace = THREE.SRGBColorSpace;
        staticNpcTexture.magFilter = THREE.NearestFilter;
        staticNpcTexture.minFilter = THREE.NearestFilter;
    }
    return staticNpcTexture;
}

function createMopedMesh(scene, width, texture, billboard) {
    const geo = new THREE.PlaneGeometry(width, MOPED_HEIGHT);
    geo.translate(0, MOPED_HEIGHT / 2, 0);

    const mat = createUnlitMaterial(texture, {
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
        billboard,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, MAX_NPCS);
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material: mat };
}

export class KillableNPCManager {
    constructor(scene) {
        this.scene = scene;
        this.npcs = [];

        // Three moped meshes: back, front (oriented by road heading), side (billboard)
        const back  = createMopedMesh(scene, MOPED_WIDTH_BACK,  getMopedBackTexture(),  false);
        const front = createMopedMesh(scene, MOPED_WIDTH_FRONT, getMopedFrontTexture(), false);
        const side  = createMopedMesh(scene, MOPED_WIDTH_SIDE,  getMopedSideTexture(),  true);

        this._backMesh  = back.mesh;   this._backMat  = back.material;
        this._frontMesh = front.mesh;  this._frontMat = front.material;
        this._sideMesh  = side.mesh;   this._sideMat  = side.material;

        // Static NPC InstancedMesh — separate texture, billboard
        const staticGeo = new THREE.PlaneGeometry(STATIC_NPC_WIDTH, STATIC_NPC_HEIGHT);
        staticGeo.translate(0, STATIC_NPC_HEIGHT / 2, 0);

        this._staticMaterial = createUnlitMaterial(getStaticNpcTexture(), {
            transparent: true,
            alphaTest: 0.1,
            side: THREE.DoubleSide,
            billboard: true,
        });

        this._staticMesh = new THREE.InstancedMesh(staticGeo, this._staticMaterial, MAX_NPCS);
        this._staticMesh.count = 0;
        this._staticMesh.frustumCulled = false;
        this.scene.add(this._staticMesh);
    }

    /**
     * Spawn NPC riders from road chunk spawn positions.
     * roadPoints is the full road.points array so NPCs can follow the road.
     */
    spawnFromChunk(chunkIndex, spawnPositions, roadPoints) {
        for (const spawn of spawnPositions) {
            if (this.npcs.length >= MAX_NPCS) break;

            // Only spawn on road (not sidewalks)
            if (spawn.type !== 'road') continue;

            // Rarely spawn a static NPC instead of a moped
            const isStatic = Math.random() < STATIC_NPC_SPAWN_CHANCE;

            const npc = {
                position: new THREE.Vector3(
                    spawn.position.x,
                    spawn.position.y,
                    spawn.position.z
                ),
                alive: true,
                speed: isStatic ? 0 : randomRange(MOPED_SPEED_MIN, MOPED_SPEED_MAX),
                roadIndex: spawn.roadIndex,
                lateralOffset: spawn.lateralOffset || 0,
                distAccum: 0,
                isStatic,
                isCrossTraffic: false,
            };

            this.npcs.push(npc);
        }
    }

    /**
     * Spawn cross-traffic NPCs at an intersection.
     * They travel perpendicular to the main road.
     */
    spawnCrossTraffic(intersection) {
        const CROSS_NPC_COUNT = 3 + Math.floor(Math.random() * 2); // 3-4
        for (let i = 0; i < CROSS_NPC_COUNT; i++) {
            if (this.npcs.length >= MAX_NPCS) break;

            const direction = Math.random() < 0.5 ? 1 : -1;
            const startDist = -35 + Math.random() * 10; // start at far end of cross-road
            const lateralOffset = (Math.random() - 0.5) * 8; // random lane on cross-road

            const startX = intersection.position.x + intersection.right.x * startDist * direction
                + intersection.forward.x * lateralOffset;
            const startZ = intersection.position.z + intersection.right.z * startDist * direction
                + intersection.forward.z * lateralOffset;

            const npc = {
                position: new THREE.Vector3(startX, 0, startZ),
                alive: true,
                speed: randomRange(MOPED_SPEED_MIN, MOPED_SPEED_MAX),
                roadIndex: intersection.pointIndex,
                lateralOffset: 0,
                distAccum: 0,
                isStatic: false,
                isCrossTraffic: true,
                crossDirection: direction,
                crossRight: intersection.right.clone(),
                crossForward: intersection.forward.clone(),
                crossOrigin: intersection.position.clone(),
                crossLateralOffset: lateralOffset,
            };

            this.npcs.push(npc);
        }
    }

    /**
     * Update all NPCs: advance along road spine, rebuild instance matrices, billboard.
     * roadPoints is the full road.points array.
     */
    update(dt, camera, vehiclePos, vehicleAngle, roadPoints) {
        const pointSpacing = 4; // must match POINT_SPACING in road.js
        const maxIdx = roadPoints.length - 1;

        for (let i = this.npcs.length - 1; i >= 0; i--) {
            const m = this.npcs[i];
            if (!m.alive) continue;

            // Static NPCs don't move — skip road following
            if (m.isCrossTraffic) {
                // Cross-traffic: move along the perpendicular road
                const dist = m.speed * dt;
                m.distAccum += dist;
                const travel = m.distAccum * m.crossDirection;
                m.position.x = m.crossOrigin.x
                    + m.crossRight.x * travel
                    + m.crossForward.x * m.crossLateralOffset;
                m.position.z = m.crossOrigin.z
                    + m.crossRight.z * travel
                    + m.crossForward.z * m.crossLateralOffset;
                m.position.y = 0;

                // Despawn if past end of cross-road
                if (Math.abs(travel) > 45) {
                    this._removeNPC(i);
                    continue;
                }
            } else if (!m.isStatic) {
                // Advance along road spine
                const dist = m.speed * dt;
                m.distAccum += dist;

                // Move to next road point(s) when accumulated distance exceeds spacing
                while (m.distAccum >= pointSpacing && m.roadIndex < maxIdx) {
                    m.distAccum -= pointSpacing;
                    m.roadIndex++;
                }

                // Clamp to valid range
                if (m.roadIndex >= maxIdx) {
                    this._removeNPC(i);
                    continue;
                }

                // Interpolate position between current and next road point
                const ptA = roadPoints[m.roadIndex];
                const ptB = roadPoints[Math.min(m.roadIndex + 1, maxIdx)];
                const t = m.distAccum / pointSpacing;

                const cx = ptA.position.x + (ptB.position.x - ptA.position.x) * t;
                const cz = ptA.position.z + (ptB.position.z - ptA.position.z) * t;

                // Apply lateral offset using interpolated right vector
                const rx = ptA.right.x + (ptB.right.x - ptA.right.x) * t;
                const rz = ptA.right.z + (ptB.right.z - ptA.right.z) * t;

                m.position.x = cx + rx * m.lateralOffset;
                m.position.y = 0;
                m.position.z = cz + rz * m.lateralOffset;
            }

            // Despawn if too far behind player
            const dx = vehiclePos.x - m.position.x;
            const dz = vehiclePos.z - m.position.z;
            const fwdX = Math.sin(vehicleAngle);
            const fwdZ = -Math.cos(vehicleAngle);
            const behind = dx * fwdX + dz * fwdZ;
            if (behind > DESPAWN_BEHIND) {
                this._removeNPC(i);
                continue;
            }
        }

        // Camera position for angle calculations
        const camPos = camera.position;

        // Rebuild instance matrices — three moped meshes + static mesh
        let backCount = 0;
        let frontCount = 0;
        let sideCount = 0;
        let staticCount = 0;

        for (const npc of this.npcs) {
            if (npc.isStatic) {
                _matrix.compose(npc.position, _identityQuat, _oneScale);
                this._staticMesh.setMatrixAt(staticCount, _matrix);
                staticCount++;
                continue;
            }

            // Get forward direction at NPC's position
            let mopedAngle;
            if (npc.isCrossTraffic) {
                // Cross-traffic: facing along perpendicular road
                const dir = npc.crossDirection;
                mopedAngle = Math.atan2(npc.crossRight.x * dir, npc.crossRight.z * dir);
            } else {
                const pt = roadPoints[Math.min(npc.roadIndex, maxIdx)];
                mopedAngle = Math.atan2(pt.forward.x, pt.forward.z);
            }

            // Angle from NPC to camera
            const toCamAngle = Math.atan2(camPos.x - npc.position.x, camPos.z - npc.position.z);
            const relAngle = normalizeAngle(toCamAngle - mopedAngle);
            const absAngle = Math.abs(relAngle);

            if (absAngle < ANGLE_FRONT) {
                // Front view — camera is ahead of moped
                // Sprite plane faces along road direction (toward camera)
                _quat.setFromAxisAngle(_yAxis, mopedAngle);
                _matrix.compose(npc.position, _quat, _oneScale);
                this._frontMesh.setMatrixAt(frontCount, _matrix);
                frontCount++;
            } else if (absAngle > ANGLE_BACK) {
                // Back view — camera is behind moped
                // Sprite plane faces opposite to road direction (toward camera)
                _quat.setFromAxisAngle(_yAxis, mopedAngle + Math.PI);
                _matrix.compose(npc.position, _quat, _oneScale);
                this._backMesh.setMatrixAt(backCount, _matrix);
                backCount++;
            } else {
                // Side view — billboard, mirror when camera is on right side
                const mirrorX = relAngle < 0 ? -1 : 1;
                _scale.set(mirrorX, 1, 1);
                _matrix.compose(npc.position, _identityQuat, _scale);
                this._sideMesh.setMatrixAt(sideCount, _matrix);
                sideCount++;
            }
        }

        // Update moped mesh counts
        this._backMesh.count = backCount;
        if (backCount > 0) this._backMesh.instanceMatrix.needsUpdate = true;

        this._frontMesh.count = frontCount;
        if (frontCount > 0) this._frontMesh.instanceMatrix.needsUpdate = true;

        this._sideMesh.count = sideCount;
        if (sideCount > 0) this._sideMesh.instanceMatrix.needsUpdate = true;

        this._staticMesh.count = staticCount;
        if (staticCount > 0) this._staticMesh.instanceMatrix.needsUpdate = true;

        // Billboard uniform — only for side mesh and static mesh
        const dir = camera.getWorldDirection(_camDir);
        const rotY = Math.atan2(dir.x, -dir.z);
        this._sideMat.uniforms.billboardRotY.value = rotY;
        this._staticMaterial.uniforms.billboardRotY.value = rotY;
    }

    /**
     * Check for vehicle-NPC collisions.
     * Returns array of hit positions for gore spawning.
     */
    checkHits(vehiclePos, vehicleAngle, vehicleSpeed) {
        if (Math.abs(vehicleSpeed) < 3) return [];

        const hits = [];
        const forward = new THREE.Vector3(
            Math.sin(vehicleAngle), 0, -Math.cos(vehicleAngle)
        );

        const checkPos = new THREE.Vector3(
            vehiclePos.x + forward.x * HIT_FORWARD * 0.5,
            vehiclePos.y,
            vehiclePos.z + forward.z * HIT_FORWARD * 0.5
        );

        for (let i = this.npcs.length - 1; i >= 0; i--) {
            const m = this.npcs[i];
            if (!m.alive) continue;

            const dx = checkPos.x - m.position.x;
            const dz = checkPos.z - m.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < HIT_RADIUS) {
                hits.push({
                    position: m.position.clone(),
                    variant: 0,
                    velocity: forward.clone().multiplyScalar(vehicleSpeed * 0.5)
                });
                this._removeNPC(i);
            }
        }

        return hits;
    }

    _removeNPC(index) {
        this.npcs.splice(index, 1);
    }

    get aliveCount() {
        return this.npcs.length;
    }
}
