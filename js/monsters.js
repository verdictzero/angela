/**
 * Monster Manager — Moped Riders
 *
 * Spawns moped riders on the road that drive in the same direction
 * as the player at varying slower speeds. Uses BillboardSprite with
 * the unlit shader for ambient tint and fog.
 */

import * as THREE from 'three';
import { BillboardSprite } from './sprites.js';
import { randomRange } from './utils.js';

const HIT_RADIUS = 2.5;             // hit detection radius
const HIT_FORWARD = 4;              // how far in front of car to check
const MAX_MONSTERS = 300;
const SPAWN_AHEAD = 300;
const MOPED_SPEED_MIN = 5;          // m/s (~18 km/h)
const MOPED_SPEED_MAX = 12;         // m/s (~43 km/h)
const MOPED_HEIGHT = 2.2;
const MOPED_WIDTH = MOPED_HEIGHT * 0.4;  // maintain source image aspect ratio (250x625)

// Shared texture — loaded once, reused by all mopeds
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

export class MonsterManager {
    constructor(scene) {
        this.scene = scene;
        this.monsters = [];
        this._lastSpawnChunkIdx = -1;
    }

    /**
     * Spawn moped riders from road chunk spawn positions.
     */
    spawnFromChunk(chunkIndex, spawnPositions) {
        if (chunkIndex <= this._lastSpawnChunkIdx) return;
        this._lastSpawnChunkIdx = chunkIndex;

        for (const spawn of spawnPositions) {
            if (this.monsters.length >= MAX_MONSTERS) break;

            // Only spawn on road (not sidewalks)
            if (spawn.type !== 'road') continue;

            const tex = getMopedTexture();
            const sprite = new BillboardSprite(tex, MOPED_WIDTH, MOPED_HEIGHT);
            sprite.setPosition(spawn.position.x, spawn.position.y, spawn.position.z);

            const monster = {
                sprite,
                alive: true,
                speed: randomRange(MOPED_SPEED_MIN, MOPED_SPEED_MAX),
                forward: spawn.forward ? spawn.forward.clone() : new THREE.Vector3(0, 0, -1),
            };

            this.scene.add(sprite.mesh);
            this.monsters.push(monster);
        }
    }

    /**
     * Update all mopeds: movement, billboarding, despawn.
     */
    update(dt, cameraPosition, vehiclePos, vehicleAngle) {
        for (let i = this.monsters.length - 1; i >= 0; i--) {
            const m = this.monsters[i];
            if (!m.alive) continue;

            const mpos = m.sprite.mesh.position;

            // Despawn if too far behind
            const dx = vehiclePos.x - mpos.x;
            const dz = vehiclePos.z - mpos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist > SPAWN_AHEAD + 50) {
                this._removeMonster(i);
                continue;
            }

            // Drive forward along the road
            mpos.x += m.forward.x * m.speed * dt;
            mpos.z += m.forward.z * m.speed * dt;

            // Billboard toward camera
            m.sprite.update(cameraPosition);
        }
    }

    /**
     * Check for vehicle-moped collisions.
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

        for (let i = this.monsters.length - 1; i >= 0; i--) {
            const m = this.monsters[i];
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
                this._removeMonster(i);
            }
        }

        return hits;
    }

    _removeMonster(index) {
        const m = this.monsters[index];
        m.alive = false;
        this.scene.remove(m.sprite.mesh);
        m.sprite.dispose();
        this.monsters.splice(index, 1);
    }

    get aliveCount() {
        return this.monsters.length;
    }
}
