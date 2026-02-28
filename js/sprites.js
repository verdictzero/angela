/**
 * Y-Billboarded Directional Sprite System
 *
 * Sprites that face the camera on Y-axis only, with Doom-style
 * directional sprite switching (front, back, left/right mirrored).
 */

import * as THREE from 'three';
import { normalizeAngle, createCanvasTexture } from './utils.js';
import { createUnlitMaterial } from './shaders.js';

/**
 * Sprite direction indices:
 * 0 = front (facing camera)
 * 1 = side (left or right, mirrored)
 * 2 = back (facing away)
 */
const DIR_FRONT = 0;
const DIR_SIDE = 1;
const DIR_BACK = 2;

/**
 * Generate placeholder monster sprites (canvas textures).
 * Returns { front: Texture, side: Texture, back: Texture }
 */
export function generateMonsterSprites(variant = 0) {
    const colors = [
        { body: '#3a7a3a', accent: '#2a5a2a', eye: '#ff0000' },   // green zombie
        { body: '#7a3a3a', accent: '#5a2a2a', eye: '#ffff00' },   // red demon
        { body: '#4a4a7a', accent: '#2a2a5a', eye: '#ff4400' },   // blue ghoul
        { body: '#7a6a3a', accent: '#5a4a2a', eye: '#ff0044' },   // brown beast
    ];

    const c = colors[variant % colors.length];
    const size = 128;

    function drawMonster(ctx, w, h, direction) {
        ctx.clearRect(0, 0, w, h);

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(w / 2, h - 4, 20, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Legs
        ctx.fillStyle = c.accent;
        ctx.fillRect(w / 2 - 18, h - 40, 12, 36);
        ctx.fillRect(w / 2 + 6, h - 40, 12, 36);

        // Body
        ctx.fillStyle = c.body;
        ctx.fillRect(w / 2 - 22, h - 80, 44, 44);

        // Shoulders
        ctx.fillRect(w / 2 - 30, h - 78, 60, 12);

        if (direction === 'front') {
            // Arms down/forward
            ctx.fillStyle = c.accent;
            ctx.fillRect(w / 2 - 34, h - 72, 10, 32);
            ctx.fillRect(w / 2 + 24, h - 72, 10, 32);

            // Head
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.arc(w / 2, h - 92, 18, 0, Math.PI * 2);
            ctx.fill();

            // Eyes
            ctx.fillStyle = c.eye;
            ctx.fillRect(w / 2 - 10, h - 98, 7, 5);
            ctx.fillRect(w / 2 + 3, h - 98, 7, 5);

            // Mouth
            ctx.fillStyle = '#220000';
            ctx.fillRect(w / 2 - 8, h - 88, 16, 4);

            // Eye glow
            ctx.fillStyle = c.eye;
            ctx.globalAlpha = 0.3;
            ctx.beginPath();
            ctx.arc(w / 2 - 6, h - 96, 8, 0, Math.PI * 2);
            ctx.arc(w / 2 + 6, h - 96, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;

        } else if (direction === 'side') {
            // Arms — one visible reaching forward
            ctx.fillStyle = c.accent;
            ctx.fillRect(w / 2 + 14, h - 74, 24, 8);
            ctx.fillRect(w / 2 + 34, h - 74, 8, 18); // hanging claw

            // Head (profile)
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.arc(w / 2 + 4, h - 92, 18, 0, Math.PI * 2);
            ctx.fill();

            // One eye
            ctx.fillStyle = c.eye;
            ctx.fillRect(w / 2 + 10, h - 98, 7, 5);

            // Jaw
            ctx.fillStyle = c.accent;
            ctx.fillRect(w / 2 + 2, h - 84, 18, 6);

        } else { // back
            // Arms at sides
            ctx.fillStyle = c.accent;
            ctx.fillRect(w / 2 - 34, h - 72, 10, 28);
            ctx.fillRect(w / 2 + 24, h - 72, 10, 28);

            // Head (back view)
            ctx.fillStyle = c.body;
            ctx.beginPath();
            ctx.arc(w / 2, h - 92, 18, 0, Math.PI * 2);
            ctx.fill();

            // Back detail (spine line)
            ctx.strokeStyle = c.accent;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(w / 2, h - 78);
            ctx.lineTo(w / 2, h - 42);
            ctx.stroke();
        }
    }

    const frontCanvas = createCanvasTexture(size, size, (ctx, w, h) => drawMonster(ctx, w, h, 'front'));
    const sideCanvas = createCanvasTexture(size, size, (ctx, w, h) => drawMonster(ctx, w, h, 'side'));
    const backCanvas = createCanvasTexture(size, size, (ctx, w, h) => drawMonster(ctx, w, h, 'back'));

    const makeTexture = (canvas) => {
        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        return tex;
    };

    return {
        front: makeTexture(frontCanvas),
        side: makeTexture(sideCanvas),
        back: makeTexture(backCanvas)
    };
}

/**
 * Generate placeholder prop sprites.
 */
export function generatePropSprite(type) {
    const size = 64;
    const canvas = createCanvasTexture(size, size, (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        if (type === 'barrel') {
            ctx.fillStyle = '#8B4513';
            ctx.fillRect(w / 2 - 14, h - 40, 28, 36);
            ctx.strokeStyle = '#5a3010';
            ctx.lineWidth = 2;
            ctx.strokeRect(w / 2 - 14, h - 40, 28, 36);
            // Bands
            ctx.strokeStyle = '#333';
            ctx.beginPath();
            ctx.moveTo(w / 2 - 14, h - 28);
            ctx.lineTo(w / 2 + 14, h - 28);
            ctx.moveTo(w / 2 - 14, h - 16);
            ctx.lineTo(w / 2 + 14, h - 16);
            ctx.stroke();
        } else if (type === 'trashcan') {
            ctx.fillStyle = '#666';
            ctx.fillRect(w / 2 - 10, h - 32, 20, 28);
            ctx.fillStyle = '#888';
            ctx.fillRect(w / 2 - 12, h - 34, 24, 4);
        }
    });

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
}

/**
 * DirectionalSprite — a Y-billboarded sprite entity that switches
 * textures based on the viewing angle relative to its facing direction.
 */
export class DirectionalSprite {
    constructor(textures, width = 2, height = 2) {
        this.textures = textures; // { front, side, back }
        this.facingAngle = 0;     // world-space angle the entity faces

        // Create materials for each direction
        this._materials = {
            front: new THREE.MeshBasicMaterial({
                map: textures.front, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
            }),
            side: new THREE.MeshBasicMaterial({
                map: textures.side, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
            }),
            back: new THREE.MeshBasicMaterial({
                map: textures.back, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
            })
        };

        // Quad geometry
        const geo = new THREE.PlaneGeometry(width, height);
        this.mesh = new THREE.Mesh(geo, this._materials.front);
        this.mesh.castShadow = false;
        this.mesh.receiveShadow = false;

        // Position bottom of sprite at y=0 of entity
        this.mesh.geometry.translate(0, height / 2, 0);

        this.currentDir = DIR_FRONT;
    }

    /**
     * Update billboard rotation and sprite direction.
     * Call every frame.
     */
    update(cameraPosition) {
        const spritePos = this.mesh.position;

        // Y-billboard: face camera on Y axis only
        const dx = cameraPosition.x - spritePos.x;
        const dz = cameraPosition.z - spritePos.z;
        const angleToCamera = Math.atan2(dx, dz);

        // Set Y-billboard rotation
        this.mesh.rotation.y = angleToCamera;

        // Determine which sprite direction to show
        const relAngle = normalizeAngle(angleToCamera - this.facingAngle);
        const absAngle = Math.abs(relAngle);

        let newDir;
        if (absAngle < Math.PI / 4) {
            // Camera is in front of the monster (monster faces toward camera)
            newDir = DIR_FRONT;
        } else if (absAngle > Math.PI * 3 / 4) {
            // Camera is behind the monster
            newDir = DIR_BACK;
        } else {
            // Camera is to the side
            newDir = DIR_SIDE;
        }

        // Update material if direction changed
        if (newDir !== this.currentDir) {
            this.currentDir = newDir;
            switch (newDir) {
                case DIR_FRONT:
                    this.mesh.material = this._materials.front;
                    this.mesh.scale.x = 1;
                    break;
                case DIR_SIDE:
                    this.mesh.material = this._materials.side;
                    // Mirror based on which side
                    this.mesh.scale.x = relAngle > 0 ? 1 : -1;
                    break;
                case DIR_BACK:
                    this.mesh.material = this._materials.back;
                    this.mesh.scale.x = 1;
                    break;
            }
        } else if (newDir === DIR_SIDE) {
            // Update mirror even if direction didn't change
            this.mesh.scale.x = relAngle > 0 ? 1 : -1;
        }
    }

    setPosition(x, y, z) {
        this.mesh.position.set(x, y, z);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this._materials.front.dispose();
        this._materials.side.dispose();
        this._materials.back.dispose();
    }
}

/**
 * BillboardSprite — a Y-billboarded sprite with a single texture,
 * rendered using the unlit ambient-tint shader.
 */
export class BillboardSprite {
    constructor(texture, width = 2, height = 2) {
        const geo = new THREE.PlaneGeometry(width, height);
        // Anchor bottom of sprite at y=0
        geo.translate(0, height / 2, 0);

        const mat = createUnlitMaterial(texture, {
            transparent: true,
            alphaTest: 0.1,
            side: THREE.DoubleSide,
        });

        this.mesh = new THREE.Mesh(geo, mat);
    }

    update(cameraYaw) {
        this.mesh.rotation.y = cameraYaw;
    }

    setPosition(x, y, z) {
        this.mesh.position.set(x, y, z);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}
