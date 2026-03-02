/**
 * Gore System — Instanced Red Billboard Squares
 *
 * 5 subsystems, each backed by its own InstancedMesh:
 *   1. Gore Particles  — small red squares burst from NPC hits
 *   2. Big Gore Chunks  — large red squares launched ahead of car, hittable
 *   3. Sub-Gore Chunks  — tiny red squares from chunk re-hits
 *   4. Blood Clouds     — quick-fading red evaporation puffs
 *   5. Blood Decals     — ground splatter marks
 */

import * as THREE from 'three';
import { createUnlitColorMaterial, createUnlitMaterial } from './shaders.js';
import { randomRange, createCanvasTexture } from './utils.js';

// ── Particles (small red squares) ────────────────────────────
const MAX_PARTICLES = 2000;
const PARTICLES_PER_HIT = 80;
const PARTICLE_LIFETIME = 3.5;
const PARTICLE_SIZE_MIN = 0.06;
const PARTICLE_SIZE_MAX = 0.9;

// ── Big Chunks (hittable, launched forward) ──────────────────
const MAX_CHUNKS = 600;
const CHUNKS_PER_HIT = 45;
const CHUNK_LIFETIME = 8.0;
const CHUNK_SIZE_MIN = 0.15;
const CHUNK_SIZE_MAX = 1.0;
const CHUNK_HIT_RADIUS = 2.0;

// ── Sub-Chunks (from chunk explosions) ───────────────────────
const MAX_SUB_CHUNKS = 900;
const SUB_CHUNKS_PER_HIT = 24;
const SUB_CHUNK_LIFETIME = 5.0;
const SUB_CHUNK_SIZE_MIN = 0.08;
const SUB_CHUNK_SIZE_MAX = 1.1;

// ── Blood Clouds (evaporation puffs) ─────────────────────────
const MAX_CLOUDS = 100;
const CLOUDS_PER_HIT = 6;
const CLOUD_LIFETIME = 1.0;
const CLOUD_SIZE = 5.0;

// ── Blood Decals ─────────────────────────────────────────────
const MAX_DECALS = 250;
const DECAL_LIFETIME = 15.0;

// ── Physics ──────────────────────────────────────────────────
const GRAVITY = -15;

// Reusable math objects
const _matrix = new THREE.Matrix4();
const _identityQuat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _rotQuat = new THREE.Quaternion();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

export class GoreSystem {
    constructor(scene) {
        this.scene = scene;

        // Blood overlay element
        this._bloodOverlay = document.getElementById('blood-overlay');

        // ── Materials (dark arterial colors + emissive for night visibility) ──
        // Particles, chunks, sub-chunks use white base + per-instance color for shade diversity
        this._goreMat = createUnlitColorMaterial(0xffffff, {
            transparent: true, side: THREE.DoubleSide,
            billboard: true, depthWrite: false,
            emissiveBoost: 0.35, useInstanceColor: true
        });

        this._chunkMat = createUnlitColorMaterial(0xffffff, {
            transparent: true, side: THREE.DoubleSide,
            billboard: true, depthWrite: false,
            emissiveBoost: 0.55, useInstanceColor: true
        });

        this._subChunkMat = createUnlitColorMaterial(0xffffff, {
            transparent: true, side: THREE.DoubleSide,
            billboard: true, depthWrite: false,
            emissiveBoost: 0.35, useInstanceColor: true
        });

        this._cloudMat = createUnlitColorMaterial(0x880000, {
            transparent: true, side: THREE.DoubleSide,
            billboard: true, depthWrite: false, opacity: 0.6,
            emissiveBoost: 0.35
        });

        // Disable depth testing so gore renders on top of world geometry
        // (matches cockpit.js approach — prevents depth buffer occlusion)
        this._goreMat.depthTest = false;
        this._chunkMat.depthTest = false;
        this._subChunkMat.depthTest = false;
        this._cloudMat.depthTest = false;

        this._decalTex = this._generateDecalTexture();
        this._decalMat = createUnlitMaterial(this._decalTex, {
            transparent: true, depthWrite: false,
            side: THREE.DoubleSide,
            emissiveBoost: 0.25
        });

        // ── Geometries ───────────────────────────────────────
        const quadGeo = new THREE.PlaneGeometry(1, 1);

        const groundQuadGeo = new THREE.PlaneGeometry(1, 1);
        groundQuadGeo.rotateX(-Math.PI / 2);

        // ── InstancedMeshes ──────────────────────────────────
        this._particleMesh = this._createIM(quadGeo, this._goreMat, MAX_PARTICLES, true);
        this._chunkMesh = this._createIM(quadGeo, this._chunkMat, MAX_CHUNKS, true);
        this._subChunkMesh = this._createIM(quadGeo, this._subChunkMat, MAX_SUB_CHUNKS, true);
        this._cloudMesh = this._createIM(quadGeo, this._cloudMat, MAX_CLOUDS);
        this._decalMesh = this._createIM(groundQuadGeo, this._decalMat, MAX_DECALS);

        // ── State Pools ──────────────────────────────────────
        this._particles = this._createPhysicsPool(MAX_PARTICLES);
        this._chunks = this._createChunkPool(MAX_CHUNKS);
        this._subChunks = this._createPhysicsPool(MAX_SUB_CHUNKS);
        this._clouds = this._createCloudPool(MAX_CLOUDS);
        this._decals = this._createDecalPool(MAX_DECALS);
    }

    _createIM(geo, mat, count, useInstanceColor = false) {
        const geometry = useInstanceColor ? geo.clone() : geo;
        const mesh = new THREE.InstancedMesh(geometry, mat, count);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.renderOrder = 1; // render after opaque world geometry for correct alpha compositing
        if (useInstanceColor) {
            const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
            geometry.setAttribute('instanceColor', colorAttr);
        }
        this.scene.add(mesh);
        return mesh;
    }

    _createPhysicsPool(max) {
        const pool = new Array(max);
        for (let i = 0; i < max; i++) {
            pool[i] = {
                active: false,
                position: new THREE.Vector3(),
                velocity: new THREE.Vector3(),
                age: 0, lifetime: 0, size: 0,
                grounded: false,
                decalSpawned: false,
                colorR: 0.5, colorG: 0, colorB: 0,
            };
        }
        return pool;
    }

    _createChunkPool(max) {
        const pool = new Array(max);
        for (let i = 0; i < max; i++) {
            pool[i] = {
                active: false,
                position: new THREE.Vector3(),
                velocity: new THREE.Vector3(),
                age: 0, lifetime: 0, size: 0,
                grounded: false, hittable: false,
                colorR: 0.4, colorG: 0, colorB: 0,
            };
        }
        return pool;
    }

    _createCloudPool(max) {
        const pool = new Array(max);
        for (let i = 0; i < max; i++) {
            pool[i] = {
                active: false,
                position: new THREE.Vector3(),
                age: 0, lifetime: 0,
            };
        }
        return pool;
    }

    _createDecalPool(max) {
        const pool = new Array(max);
        for (let i = 0; i < max; i++) {
            pool[i] = {
                active: false,
                position: new THREE.Vector3(),
                age: 0, lifetime: 0,
                rotation: 0, size: 0,
            };
        }
        return pool;
    }

    _generateDecalTexture() {
        const canvas = createCanvasTexture(64, 64, (ctx, w, h) => {
            ctx.clearRect(0, 0, w, h);
            const cx = w / 2, cy = h / 2;
            for (let i = 0; i < 12; i++) {
                ctx.fillStyle = `rgba(${40 + Math.random() * 80}, 0, 0, ${0.35 + Math.random() * 0.5})`;
                ctx.beginPath();
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * 18;
                const r = 3 + Math.random() * 14;
                ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, r, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        return tex;
    }

    // ── Acquire from pool (find inactive or recycle oldest) ──

    _acquire(pool) {
        // Find first inactive slot
        for (let i = 0; i < pool.length; i++) {
            if (!pool[i].active) return pool[i];
        }
        // Recycle oldest
        let oldest = pool[0], maxAge = 0;
        for (let i = 1; i < pool.length; i++) {
            if (pool[i].age > maxAge) {
                maxAge = pool[i].age;
                oldest = pool[i];
            }
        }
        oldest.active = false;
        return oldest;
    }

    // ── Spawn Methods ────────────────────────────────────────

    /**
     * Spawn gore explosion at NPC hit position.
     */
    spawn(position, impactVelocity) {
        // 1. Gore particles (small red squares — wide spray, varied dark shades)
        for (let i = 0; i < PARTICLES_PER_HIT; i++) {
            const p = this._acquire(this._particles);
            p.position.set(
                position.x + randomRange(-1.0, 1.0),
                position.y + randomRange(0.3, 2.2),
                position.z + randomRange(-1.0, 1.0)
            );
            p.velocity.set(
                impactVelocity.x * randomRange(0.5, 2.0) + randomRange(-8, 8),
                randomRange(5, 18),
                impactVelocity.z * randomRange(0.5, 2.0) + randomRange(-8, 8)
            );
            p.size = randomRange(PARTICLE_SIZE_MIN, PARTICLE_SIZE_MAX);
            p.lifetime = PARTICLE_LIFETIME * randomRange(0.5, 1.0);
            p.age = 0;
            p.grounded = false;
            // Dark red shade diversity: from near-black blood to deep arterial red
            p.colorR = randomRange(0.25, 0.70);
            p.colorG = randomRange(0.0, 0.06);
            p.colorB = randomRange(0.0, 0.03);
            p.active = true;
        }

        // 2. Big gore chunks (launched FAR ahead of car, varied dark meaty shades)
        for (let i = 0; i < CHUNKS_PER_HIT; i++) {
            const c = this._acquire(this._chunks);
            c.position.set(
                position.x + randomRange(-0.8, 0.8),
                position.y + randomRange(0.5, 1.5),
                position.z + randomRange(-0.8, 0.8)
            );
            c.velocity.set(
                impactVelocity.x * randomRange(2.5, 5.0) + randomRange(-6, 6),
                randomRange(6, 18),
                impactVelocity.z * randomRange(2.5, 5.0) + randomRange(-6, 6)
            );
            c.size = randomRange(CHUNK_SIZE_MIN, CHUNK_SIZE_MAX);
            c.lifetime = CHUNK_LIFETIME;
            c.age = 0;
            c.grounded = false;
            c.hittable = false;
            // Bright meaty shades for visible chunks — vivid crimson to deep red
            c.colorR = randomRange(0.55, 0.95);
            c.colorG = randomRange(0.0, 0.08);
            c.colorB = randomRange(0.0, 0.05);
            c.active = true;
        }

        // 3. Blood evaporation clouds
        for (let i = 0; i < CLOUDS_PER_HIT; i++) {
            this._spawnCloud(position);
        }

        // 4. Ground decals at impact (two for extra carnage)
        this._spawnDecal(position);
        this._spawnDecal({ x: position.x + randomRange(-1.5, 1.5), z: position.z + randomRange(-1.5, 1.5) });

        // 5. Screen blood flash
        this._flashBlood();
    }

    _spawnCloud(position) {
        const c = this._acquire(this._clouds);
        c.position.set(
            position.x + randomRange(-0.5, 0.5),
            position.y + randomRange(0.3, 1.2),
            position.z + randomRange(-0.5, 0.5)
        );
        c.lifetime = CLOUD_LIFETIME * randomRange(0.8, 1.2);
        c.age = 0;
        c.active = true;
    }

    _spawnDecal(position) {
        const d = this._acquire(this._decals);
        d.position.set(position.x, 0.02, position.z);
        d.rotation = Math.random() * Math.PI * 2;
        d.size = randomRange(2.5, 6.0);
        d.lifetime = DECAL_LIFETIME * randomRange(0.7, 1.0);
        d.age = 0;
        d.active = true;
    }

    _spawnSubChunks(position, forward, vehicleSpeed) {
        for (let i = 0; i < SUB_CHUNKS_PER_HIT; i++) {
            const s = this._acquire(this._subChunks);
            s.position.set(
                position.x + randomRange(-0.3, 0.3),
                position.y + randomRange(0.1, 0.8),
                position.z + randomRange(-0.3, 0.3)
            );
            s.velocity.set(
                forward.x * vehicleSpeed * randomRange(1.5, 3.5) + randomRange(-4, 4),
                randomRange(5, 16),
                forward.z * vehicleSpeed * randomRange(1.5, 3.5) + randomRange(-4, 4)
            );
            s.size = randomRange(SUB_CHUNK_SIZE_MIN, SUB_CHUNK_SIZE_MAX);
            s.lifetime = SUB_CHUNK_LIFETIME * randomRange(0.6, 1.0);
            s.age = 0;
            s.grounded = false;
            s.decalSpawned = false;
            // Mixed dark shades for re-hit debris
            s.colorR = randomRange(0.20, 0.65);
            s.colorG = randomRange(0.0, 0.05);
            s.colorB = randomRange(0.0, 0.03);
            s.active = true;
        }
    }

    _flashBlood() {
        if (this._bloodOverlay) {
            this._bloodOverlay.classList.add('active');
            clearTimeout(this._bloodTimeout);
            this._bloodTimeout = setTimeout(() => {
                this._bloodOverlay.classList.remove('active');
            }, 350);
        }
    }

    // ── Update ───────────────────────────────────────────────

    /**
     * Per-frame update. Also checks if vehicle hits any grounded chunks.
     * Returns number of chunk hits (for optional impact feedback).
     */
    update(dt, camera, vehiclePos, vehicleAngle, vehicleSpeed) {
        // Billboard rotation for all billboard materials
        const dir = camera.getWorldDirection(_camDir);
        const rotY = Math.atan2(dir.x, -dir.z);
        this._goreMat.uniforms.billboardRotY.value = rotY;
        this._chunkMat.uniforms.billboardRotY.value = rotY;
        this._subChunkMat.uniforms.billboardRotY.value = rotY;
        this._cloudMat.uniforms.billboardRotY.value = rotY;

        // Update each subsystem
        this._updatePhysicsPool(this._particles, this._particleMesh, dt, MAX_PARTICLES, false);
        const chunkHits = this._updateChunks(dt, vehiclePos, vehicleAngle, vehicleSpeed);
        this._updateSubChunks(dt);
        this._updateClouds(dt);
        this._updateDecals(dt);

        return chunkHits;
    }

    _updatePhysicsPool(pool, mesh, dt, max, spawnDecalOnGround) {
        let writeIdx = 0;
        const colorAttr = mesh.geometry.getAttribute('instanceColor');
        const colorArray = colorAttr ? colorAttr.array : null;

        for (let i = 0; i < max; i++) {
            const p = pool[i];
            if (!p.active) continue;

            p.age += dt;
            if (p.age >= p.lifetime) {
                p.active = false;
                continue;
            }

            if (!p.grounded) {
                p.velocity.y += GRAVITY * dt;
                p.position.x += p.velocity.x * dt;
                p.position.y += p.velocity.y * dt;
                p.position.z += p.velocity.z * dt;

                if (p.position.y <= 0.03) {
                    p.position.y = 0.03;
                    if (Math.abs(p.velocity.y) > 1.5) {
                        // Bounce with energy loss
                        p.velocity.y *= -0.35;
                        p.velocity.x *= 0.7;
                        p.velocity.z *= 0.7;
                        // Splat on first contact
                        if (spawnDecalOnGround && !p.decalSpawned) {
                            this._spawnDecal(p.position);
                            this._spawnCloud(p.position);
                            p.decalSpawned = true;
                        }
                    } else {
                        p.grounded = true;
                        p.lifetime = Math.min(p.lifetime, p.age + randomRange(0.3, 1.0));
                    }
                }
            }

            // Fade via scale shrink
            const fadeStart = p.lifetime * 0.6;
            let s = p.size;
            if (p.age > fadeStart) {
                s *= 1 - (p.age - fadeStart) / (p.lifetime - fadeStart);
            }
            if (s < 0.001) s = 0;

            _scale.set(s, s, s);
            _matrix.compose(p.position, _identityQuat, _scale);
            mesh.setMatrixAt(writeIdx, _matrix);

            if (colorArray) {
                const ci = writeIdx * 3;
                colorArray[ci] = p.colorR;
                colorArray[ci + 1] = p.colorG;
                colorArray[ci + 2] = p.colorB;
            }

            writeIdx++;
        }
        mesh.count = writeIdx;
        if (writeIdx > 0) {
            mesh.instanceMatrix.needsUpdate = true;
            if (colorAttr) colorAttr.needsUpdate = true;
        }
    }

    _updateSubChunks(dt) {
        this._updatePhysicsPool(this._subChunks, this._subChunkMesh, dt, MAX_SUB_CHUNKS, true);
    }

    _updateChunks(dt, vehiclePos, vehicleAngle, vehicleSpeed) {
        let writeIdx = 0;
        let chunkHitCount = 0;
        const colorAttr = this._chunkMesh.geometry.getAttribute('instanceColor');
        const colorArray = colorAttr ? colorAttr.array : null;

        // Pre-compute vehicle check position
        const canCheck = Math.abs(vehicleSpeed) > 3;
        let checkX = 0, checkZ = 0, fwdX = 0, fwdZ = 0;
        if (canCheck) {
            fwdX = Math.sin(vehicleAngle);
            fwdZ = -Math.cos(vehicleAngle);
            checkX = vehiclePos.x + fwdX * 2;
            checkZ = vehiclePos.z + fwdZ * 2;
        }

        const _fwd = new THREE.Vector3();

        for (let i = 0; i < MAX_CHUNKS; i++) {
            const c = this._chunks[i];
            if (!c.active) continue;

            c.age += dt;
            if (c.age >= c.lifetime) {
                c.active = false;
                continue;
            }

            // Physics
            if (!c.grounded) {
                c.velocity.y += GRAVITY * dt;
                c.position.x += c.velocity.x * dt;
                c.position.y += c.velocity.y * dt;
                c.position.z += c.velocity.z * dt;

                if (c.position.y <= 0.05) {
                    c.position.y = 0.05;
                    if (Math.abs(c.velocity.y) > 2.0) {
                        // Meaty bounce with energy loss
                        c.velocity.y *= -0.4;
                        c.velocity.x *= 0.65;
                        c.velocity.z *= 0.65;
                        this._spawnDecal(c.position); // splat on each bounce
                    } else {
                        c.grounded = true;
                        c.hittable = true;
                        this._spawnDecal(c.position);
                    }
                }
            }

            // Hit detection: car drives over grounded chunk
            if (c.hittable && canCheck) {
                const dx = checkX - c.position.x;
                const dz = checkZ - c.position.z;
                if (dx * dx + dz * dz < CHUNK_HIT_RADIUS * CHUNK_HIT_RADIUS) {
                    _fwd.set(fwdX, 0, fwdZ);
                    this._spawnSubChunks(c.position, _fwd, vehicleSpeed);
                    this._spawnDecal(c.position);
                    this._spawnCloud(c.position);
                    c.active = false;
                    chunkHitCount++;
                    continue;
                }
            }

            // Fade via scale shrink
            const fadeStart = c.lifetime * 0.7;
            let s = c.size;
            if (c.age > fadeStart) {
                s *= 1 - (c.age - fadeStart) / (c.lifetime - fadeStart);
            }
            if (s < 0.001) s = 0;

            _scale.set(s, s, s);
            _matrix.compose(c.position, _identityQuat, _scale);
            this._chunkMesh.setMatrixAt(writeIdx, _matrix);

            if (colorArray) {
                const ci = writeIdx * 3;
                colorArray[ci] = c.colorR;
                colorArray[ci + 1] = c.colorG;
                colorArray[ci + 2] = c.colorB;
            }

            writeIdx++;
        }
        this._chunkMesh.count = writeIdx;
        if (writeIdx > 0) {
            this._chunkMesh.instanceMatrix.needsUpdate = true;
            if (colorAttr) colorAttr.needsUpdate = true;
        }

        return chunkHitCount;
    }

    _updateClouds(dt) {
        let writeIdx = 0;
        for (let i = 0; i < MAX_CLOUDS; i++) {
            const c = this._clouds[i];
            if (!c.active) continue;

            c.age += dt;
            if (c.age >= c.lifetime) {
                c.active = false;
                continue;
            }

            // Rise slowly
            c.position.y += 1.5 * dt;

            // Scale down linearly (evaporation effect)
            const t = c.age / c.lifetime;
            const s = CLOUD_SIZE * (1 - t);

            _scale.set(s, s, s);
            _matrix.compose(c.position, _identityQuat, _scale);
            this._cloudMesh.setMatrixAt(writeIdx, _matrix);
            writeIdx++;
        }
        this._cloudMesh.count = writeIdx;
        if (writeIdx > 0) this._cloudMesh.instanceMatrix.needsUpdate = true;
    }

    _updateDecals(dt) {
        let writeIdx = 0;
        for (let i = 0; i < MAX_DECALS; i++) {
            const d = this._decals[i];
            if (!d.active) continue;

            d.age += dt;
            if (d.age >= d.lifetime) {
                d.active = false;
                continue;
            }

            // Fade by scaling down in final 30%
            let s = d.size;
            const fadeStart = d.lifetime * 0.7;
            if (d.age > fadeStart) {
                s *= 1 - (d.age - fadeStart) / (d.lifetime - fadeStart);
            }
            if (s < 0.001) s = 0;

            _rotQuat.setFromAxisAngle(_yAxis, d.rotation);
            _scale.set(s, s, s);
            _matrix.compose(d.position, _rotQuat, _scale);
            this._decalMesh.setMatrixAt(writeIdx, _matrix);
            writeIdx++;
        }
        this._decalMesh.count = writeIdx;
        if (writeIdx > 0) this._decalMesh.instanceMatrix.needsUpdate = true;
    }
}
