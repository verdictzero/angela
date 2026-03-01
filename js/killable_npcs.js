/**
 * Killable NPC Manager — Moped Riders
 *
 * Spawns moped riders on the road that drive in the same direction
 * as the player at varying slower speeds. NPCs follow the road
 * by advancing along road spine points. Uses BillboardSprite with
 * the unlit shader for ambient tint and fog.
 */

import * as THREE from 'three';
import { BillboardSprite } from './sprites.js';
import { randomRange } from './utils.js';

const HIT_RADIUS = 2.5;             // hit detection radius
const HIT_FORWARD = 4;              // how far in front of car to check
const MAX_NPCS = 600;
const DESPAWN_BEHIND = 80;           // despawn if this far behind player
const MOPED_SPEED_MIN = 5;          // m/s (~18 km/h)
const MOPED_SPEED_MAX = 12;         // m/s (~43 km/h)
const MOPED_HEIGHT = 2.2;
const MOPED_WIDTH = MOPED_HEIGHT * 0.4;  // maintain source image aspect ratio (250x625)
const NPC_CULL_DISTANCE = 200;

// Shared texture — loaded once, reused by all NPCs
let mopedTexture = null;

function getMopedTexture() {
    if (!mopedTexture) {
        mopedTexture = new THREE.TextureLoader().load('assets/moped_guy.png');
        mopedTexture.colorSpace = THREE.SRGBColorSpace;
        mopedTexture.magFilter = THREE.NearestFilter;
        mopedTexture.minFilter = THREE.NearestFilter;
    }
    return mopedTexture;
}

export class KillableNPCManager {
    constructor(scene) {
        this.scene = scene;
        this.npcs = [];
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

            const tex = getMopedTexture();
            const sprite = new BillboardSprite(tex, MOPED_WIDTH, MOPED_HEIGHT);
            sprite.setPosition(spawn.position.x, spawn.position.y, spawn.position.z);

            const npc = {
                sprite,
                alive: true,
                speed: randomRange(MOPED_SPEED_MIN, MOPED_SPEED_MAX),
                roadIndex: spawn.roadIndex,       // current road spine point index
                lateralOffset: spawn.lateralOffset || 0, // offset from road center
                distAccum: 0,                     // distance accumulated toward next point
            };

            this.scene.add(sprite.mesh);
            this.npcs.push(npc);
        }
    }

    /**
     * Update all NPCs: advance along road spine, billboard, despawn.
     * roadPoints is the full road.points array.
     */
    update(dt, camera, vehiclePos, vehicleAngle, roadPoints) {
        const pointSpacing = 4; // must match POINT_SPACING in road.js
        const maxIdx = roadPoints.length - 1;

        for (let i = this.npcs.length - 1; i >= 0; i--) {
            const m = this.npcs[i];
            if (!m.alive) continue;

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

            const mpos = m.sprite.mesh.position;
            mpos.x = cx + rx * m.lateralOffset;
            mpos.y = 0;
            mpos.z = cz + rz * m.lateralOffset;

            // Despawn if too far behind player
            const dx = vehiclePos.x - mpos.x;
            const dz = vehiclePos.z - mpos.z;
            const fwdX = Math.sin(vehicleAngle);
            const fwdZ = -Math.cos(vehicleAngle);
            const behind = dx * fwdX + dz * fwdZ;
            if (behind > DESPAWN_BEHIND) {
                this._removeNPC(i);
                continue;
            }

            // Billboard toward camera
            m.sprite.update(camera);
        }
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

            const mpos = m.sprite.mesh.position;
            const dx = checkPos.x - mpos.x;
            const dz = checkPos.z - mpos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < HIT_RADIUS) {
                hits.push({
                    position: mpos.clone(),
                    variant: 0,
                    velocity: forward.clone().multiplyScalar(vehicleSpeed * 0.5)
                });
                this._removeNPC(i);
            }
        }

        return hits;
    }

    _removeNPC(index) {
        const m = this.npcs[index];
        m.alive = false;
        this.scene.remove(m.sprite.mesh);
        m.sprite.dispose();
        this.npcs.splice(index, 1);
    }

    get aliveCount() {
        return this.npcs.length;
    }
}
