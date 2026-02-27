/**
 * Monster Manager
 *
 * Spawns, updates, and manages monsters on the road.
 * Handles hit detection with the player vehicle.
 */

import * as THREE from 'three';
import { DirectionalSprite, generateMonsterSprites } from './sprites.js';
import { randomRange, normalizeAngle } from './utils.js';

const MONSTER_HIT_RADIUS = 2.5;      // hit detection radius
const MONSTER_HIT_FORWARD = 4;       // how far in front of car to check
const MAX_MONSTERS = 80;             // max alive monsters
const SPAWN_AHEAD = 300;             // spawn this far ahead (m)
const DESPAWN_BEHIND = 100;          // remove monsters this far behind
const WANDER_SPEED = 1.5;            // base wander speed (m/s)
const ALERT_RANGE = 30;              // distance to start facing player
const MONSTER_TYPES = 4;             // number of sprite variants

/**
 * Monster states
 */
const STATE_IDLE = 0;
const STATE_WANDER = 1;
const STATE_ALERT = 2;

export class MonsterManager {
    constructor(scene) {
        this.scene = scene;
        this.monsters = [];
        this._spriteCache = [];
        this._lastSpawnChunkIdx = -1;

        // Pre-generate sprite textures for each variant
        for (let i = 0; i < MONSTER_TYPES; i++) {
            this._spriteCache.push(generateMonsterSprites(i));
        }
    }

    /**
     * Spawn monsters from road chunk spawn positions.
     */
    spawnFromChunk(chunkIndex, spawnPositions) {
        if (chunkIndex <= this._lastSpawnChunkIdx) return;
        this._lastSpawnChunkIdx = chunkIndex;

        for (const spawn of spawnPositions) {
            if (this.monsters.length >= MAX_MONSTERS) break;
            if (Math.random() > 0.6) continue; // not every position gets a monster

            const variant = Math.floor(Math.random() * MONSTER_TYPES);
            const textures = this._spriteCache[variant];
            const sprite = new DirectionalSprite(textures, 1.8, 2.2);
            sprite.setPosition(spawn.position.x, spawn.position.y, spawn.position.z);
            sprite.facingAngle = Math.random() * Math.PI * 2;

            const monster = {
                sprite,
                state: Math.random() > 0.4 ? STATE_WANDER : STATE_IDLE,
                wanderAngle: Math.random() * Math.PI * 2,
                wanderTimer: randomRange(2, 6),
                speed: randomRange(0.5, WANDER_SPEED),
                alive: true,
                hp: 1,
                variant,
                spawnType: spawn.type
            };

            this.scene.add(sprite.mesh);
            this.monsters.push(monster);
        }
    }

    /**
     * Update all monsters: AI, sprites, despawn.
     */
    update(dt, cameraPosition, vehiclePos, vehicleAngle) {
        const playerPos2D = new THREE.Vector2(vehiclePos.x, vehiclePos.z);

        for (let i = this.monsters.length - 1; i >= 0; i--) {
            const m = this.monsters[i];
            if (!m.alive) continue;

            const mpos = m.sprite.mesh.position;
            const dx = vehiclePos.x - mpos.x;
            const dz = vehiclePos.z - mpos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            // Despawn if too far behind
            if (dist > SPAWN_AHEAD + 50) {
                this._removeMonster(i);
                continue;
            }

            // AI behavior
            this._updateAI(m, dt, vehiclePos, dist);

            // Update sprite direction/billboard
            m.sprite.update(cameraPosition);
        }
    }

    _updateAI(monster, dt, playerPos, distToPlayer) {
        const mpos = monster.sprite.mesh.position;

        switch (monster.state) {
            case STATE_IDLE:
                // Occasionally switch to wander
                monster.wanderTimer -= dt;
                if (monster.wanderTimer <= 0) {
                    monster.state = STATE_WANDER;
                    monster.wanderAngle = Math.random() * Math.PI * 2;
                    monster.wanderTimer = randomRange(3, 8);
                }
                // Face random directions slowly
                monster.sprite.facingAngle += (Math.random() - 0.5) * 0.5 * dt;
                break;

            case STATE_WANDER:
                // Move in wander direction
                mpos.x += Math.sin(monster.wanderAngle) * monster.speed * dt;
                mpos.z -= Math.cos(monster.wanderAngle) * monster.speed * dt;
                monster.sprite.facingAngle = monster.wanderAngle;

                monster.wanderTimer -= dt;
                if (monster.wanderTimer <= 0) {
                    monster.state = STATE_IDLE;
                    monster.wanderTimer = randomRange(1, 4);
                }
                break;

            case STATE_ALERT:
                // Face toward player
                const angleToPlayer = Math.atan2(
                    playerPos.x - mpos.x,
                    -(playerPos.z - mpos.z)
                );
                monster.sprite.facingAngle = angleToPlayer;
                break;
        }

        // Switch to alert if player is close
        if (distToPlayer < ALERT_RANGE && monster.state !== STATE_ALERT) {
            monster.state = STATE_ALERT;
        } else if (distToPlayer > ALERT_RANGE * 1.5 && monster.state === STATE_ALERT) {
            monster.state = STATE_WANDER;
            monster.wanderAngle = Math.random() * Math.PI * 2;
            monster.wanderTimer = randomRange(2, 5);
        }
    }

    /**
     * Check for vehicle-monster collisions.
     * Returns array of hit monster positions for gore spawning.
     */
    checkHits(vehiclePos, vehicleAngle, vehicleSpeed) {
        if (Math.abs(vehicleSpeed) < 3) return []; // need some speed to hit

        const hits = [];
        const forward = new THREE.Vector3(
            Math.sin(vehicleAngle), 0, -Math.cos(vehicleAngle)
        );

        // Check area in front of car
        const checkPos = new THREE.Vector3(
            vehiclePos.x + forward.x * MONSTER_HIT_FORWARD * 0.5,
            vehiclePos.y,
            vehiclePos.z + forward.z * MONSTER_HIT_FORWARD * 0.5
        );

        for (let i = this.monsters.length - 1; i >= 0; i--) {
            const m = this.monsters[i];
            if (!m.alive) continue;

            const mpos = m.sprite.mesh.position;
            const dx = checkPos.x - mpos.x;
            const dz = checkPos.z - mpos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < MONSTER_HIT_RADIUS) {
                hits.push({
                    position: mpos.clone(),
                    variant: m.variant,
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
