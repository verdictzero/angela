/**
 * Gore Particle System
 *
 * Handles blood/gore explosions when monsters are hit.
 * Uses a particle pool for performance.
 */

import * as THREE from 'three';
import { randomRange, createCanvasTexture } from './utils.js';

const MAX_PARTICLES = 500;
const PARTICLES_PER_HIT = 20;
const PARTICLE_LIFETIME = 2.0;
const GRAVITY = -15;
const DECAL_LIFETIME = 8.0;
const MAX_DECALS = 60;

export class GoreSystem {
    constructor(scene) {
        this.scene = scene;
        this.particles = [];
        this.decals = [];

        // Blood overlay element
        this._bloodOverlay = document.getElementById('blood-overlay');

        // Generate gore textures
        this._goreTextures = this._generateTextures();
        this._decalTexture = this._generateDecalTexture();

        // Shared materials
        this._particleMaterials = this._goreTextures.map(tex =>
            new THREE.MeshBasicMaterial({
                map: tex, transparent: true, alphaTest: 0.05,
                side: THREE.DoubleSide, depthWrite: false
            })
        );

        this._decalMaterial = new THREE.MeshBasicMaterial({
            map: this._decalTexture, transparent: true,
            side: THREE.DoubleSide, depthWrite: false
        });
    }

    _generateTextures() {
        const textures = [];
        const colors = ['#cc0000', '#990000', '#770000', '#aa0000', '#880011'];

        for (let i = 0; i < 5; i++) {
            const canvas = createCanvasTexture(32, 32, (ctx, w, h) => {
                ctx.clearRect(0, 0, w, h);
                ctx.fillStyle = colors[i];
                // Random blob shapes
                ctx.beginPath();
                const cx = w / 2, cy = h / 2;
                const points = 5 + Math.floor(Math.random() * 4);
                for (let j = 0; j < points; j++) {
                    const angle = (j / points) * Math.PI * 2;
                    const r = 8 + Math.random() * 6;
                    const x = cx + Math.cos(angle) * r;
                    const y = cy + Math.sin(angle) * r;
                    if (j === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fill();

                // Darker center
                ctx.fillStyle = '#440000';
                ctx.beginPath();
                ctx.arc(cx, cy, 3 + Math.random() * 3, 0, Math.PI * 2);
                ctx.fill();
            });

            const tex = new THREE.CanvasTexture(canvas);
            tex.magFilter = THREE.NearestFilter;
            textures.push(tex);
        }

        return textures;
    }

    _generateDecalTexture() {
        const canvas = createCanvasTexture(64, 64, (ctx, w, h) => {
            ctx.clearRect(0, 0, w, h);
            // Blood splatter
            const cx = w / 2, cy = h / 2;
            for (let i = 0; i < 8; i++) {
                ctx.fillStyle = `rgba(${120 + Math.random() * 60}, 0, 0, ${0.3 + Math.random() * 0.4})`;
                ctx.beginPath();
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * 15;
                const r = 5 + Math.random() * 10;
                ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, r, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        return tex;
    }

    /**
     * Spawn a gore explosion at the given position.
     */
    spawn(position, impactVelocity) {
        for (let i = 0; i < PARTICLES_PER_HIT; i++) {
            if (this.particles.length >= MAX_PARTICLES) {
                // Recycle oldest
                const oldest = this.particles.shift();
                this.scene.remove(oldest.mesh);
                oldest.mesh.geometry.dispose();
            }

            const size = randomRange(0.15, 0.5);
            const geo = new THREE.PlaneGeometry(size, size);
            const matIdx = Math.floor(Math.random() * this._particleMaterials.length);
            const mesh = new THREE.Mesh(geo, this._particleMaterials[matIdx]);

            mesh.position.copy(position);
            mesh.position.y += randomRange(0.3, 1.5);

            const particle = {
                mesh,
                velocity: new THREE.Vector3(
                    impactVelocity.x * randomRange(0.2, 0.8) + randomRange(-5, 5),
                    randomRange(3, 10),
                    impactVelocity.z * randomRange(0.2, 0.8) + randomRange(-5, 5)
                ),
                lifetime: PARTICLE_LIFETIME * randomRange(0.5, 1.0),
                age: 0,
                grounded: false
            };

            this.scene.add(mesh);
            this.particles.push(particle);
        }

        // Spawn a ground decal
        this._spawnDecal(position);

        // Blood screen effect
        this._flashBlood();
    }

    _spawnDecal(position) {
        if (this.decals.length >= MAX_DECALS) {
            const oldest = this.decals.shift();
            this.scene.remove(oldest.mesh);
            oldest.mesh.geometry.dispose();
        }

        const size = randomRange(1.5, 3.5);
        const geo = new THREE.PlaneGeometry(size, size);
        const mesh = new THREE.Mesh(geo, this._decalMaterial.clone());
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(position.x, 0.02, position.z);
        mesh.rotation.z = Math.random() * Math.PI * 2;

        this.scene.add(mesh);
        this.decals.push({
            mesh,
            lifetime: DECAL_LIFETIME,
            age: 0
        });
    }

    _flashBlood() {
        if (this._bloodOverlay) {
            this._bloodOverlay.classList.add('active');
            clearTimeout(this._bloodTimeout);
            this._bloodTimeout = setTimeout(() => {
                this._bloodOverlay.classList.remove('active');
            }, 200);
        }
    }

    /**
     * Update all particles and decals.
     */
    update(dt, cameraPosition) {
        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.age += dt;

            if (p.age >= p.lifetime) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                this.particles.splice(i, 1);
                continue;
            }

            if (!p.grounded) {
                // Physics
                p.velocity.y += GRAVITY * dt;
                p.mesh.position.x += p.velocity.x * dt;
                p.mesh.position.y += p.velocity.y * dt;
                p.mesh.position.z += p.velocity.z * dt;

                // Ground collision
                if (p.mesh.position.y <= 0.05) {
                    p.mesh.position.y = 0.05;
                    p.grounded = true;
                    p.mesh.rotation.x = -Math.PI / 2;
                    // Reduce remaining lifetime
                    p.lifetime = p.age + randomRange(0.5, 1.5);
                }

                // Billboard toward camera
                if (!p.grounded) {
                    p.mesh.lookAt(cameraPosition);
                }
            }

            // Fade out
            const fadeStart = p.lifetime * 0.6;
            if (p.age > fadeStart) {
                const alpha = 1 - (p.age - fadeStart) / (p.lifetime - fadeStart);
                p.mesh.material.opacity = Math.max(0, alpha);
            }
        }

        // Update decals
        for (let i = this.decals.length - 1; i >= 0; i--) {
            const d = this.decals[i];
            d.age += dt;

            if (d.age >= d.lifetime) {
                this.scene.remove(d.mesh);
                d.mesh.geometry.dispose();
                d.mesh.material.dispose();
                this.decals.splice(i, 1);
                continue;
            }

            // Fade out decals
            const fadeStart = d.lifetime * 0.7;
            if (d.age > fadeStart) {
                const alpha = 1 - (d.age - fadeStart) / (d.lifetime - fadeStart);
                d.mesh.material.opacity = Math.max(0, alpha);
            }
        }
    }
}
