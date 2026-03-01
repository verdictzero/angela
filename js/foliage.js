/**
 * Foliage Manager — Billboard Sprite Vegetation
 *
 * Spawns foliage sprites (ferns, bushes, juvenile trees, fir trees)
 * along road edges using chunk-based spawning with seeded random
 * for deterministic placement. Distance culling keeps sprite count low.
 */

import * as THREE from 'three';
import { BillboardSprite } from './sprites.js';
import { seededRandom } from './utils.js';

// Distance culling
const CULL_DISTANCE = 200;
const MAX_VISIBLE = 800;

// Foliage tier definitions
const TIERS = [
    {
        name: 'fern',
        textures: ['fern_1.png', 'fern_2.png', 'fern_3.png', 'fern_4.png'],
        baseWidth: 1.2, baseHeight: 0.8,
        minDist: 9, maxDist: 25,
        clusterSize: 3,
        countPerChunk: 8,
    },
    {
        name: 'bush',
        textures: ['forest_bush_1.png', 'forest_bush_2.png', 'forest_bush_3.png'],
        baseWidth: 3, baseHeight: 2.5,
        minDist: 10, maxDist: 40,
        clusterSize: 2,
        countPerChunk: 6,
    },
    {
        name: 'juvenile',
        textures: ['juvenile_fir_tree_1.png', 'juvenile_fir_tree_2.png', 'juvenile_fir_tree_4.png'],
        baseWidth: 4, baseHeight: 6,
        minDist: 15, maxDist: 60,
        clusterSize: 2,
        countPerChunk: 4,
    },
    {
        name: 'fir',
        textures: ['fir_tree_1.png', 'fir_tree_2.png', 'fir_tree_3.png', 'fir_tree_4.png'],
        baseWidth: 5, baseHeight: 10,
        minDist: 20, maxDist: 80,
        clusterSize: 1,
        countPerChunk: 3,
    },
];

export class FoliageManager {
    constructor(scene) {
        this.scene = scene;
        this._textures = {};
        this._chunkSprites = new Map(); // chunkId -> [sprite meshes]
        this._allSprites = [];          // flat list for culling
        this._loadTextures();
    }

    _loadTextures() {
        const loader = new THREE.TextureLoader();
        for (const tier of TIERS) {
            for (const file of tier.textures) {
                const tex = loader.load(`assets/foliage/${file}`);
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestFilter;
                this._textures[file] = tex;
            }
        }
    }

    /**
     * Spawn foliage sprites for a road chunk.
     */
    spawnForChunk(chunkId, roadPoints, startIdx, endIdx) {
        if (this._chunkSprites.has(chunkId)) return;

        const sprites = [];
        const rng = seededRandom(chunkId * 7919 + 31337);

        for (const tier of TIERS) {
            for (let c = 0; c < tier.countPerChunk; c++) {
                // Pick a road point within the chunk
                const ptIdx = startIdx + Math.floor(rng() * (endIdx - startIdx - 1));
                if (ptIdx >= roadPoints.length) continue;
                const pt = roadPoints[ptIdx];

                // Pick which side of the road (left or right)
                const side = rng() > 0.5 ? 1 : -1;

                for (let ci = 0; ci < tier.clusterSize; ci++) {
                    // Distance from road center
                    const dist = tier.minDist + rng() * (tier.maxDist - tier.minDist);
                    // Add some spread within cluster
                    const clusterSpread = ci * (2 + rng() * 3);
                    const totalDist = (dist + clusterSpread) * side;

                    // Along-road offset for cluster variation
                    const alongOffset = Math.floor(rng() * 3) - 1;
                    const actualIdx = Math.min(Math.max(ptIdx + alongOffset, startIdx), endIdx - 1);
                    const actualPt = roadPoints[actualIdx];

                    // World position
                    const wx = actualPt.position.x + actualPt.right.x * totalDist;
                    const wz = actualPt.position.z + actualPt.right.z * totalDist;

                    // Size variation +/- 20%
                    const sizeMult = 0.8 + rng() * 0.4;
                    const w = tier.baseWidth * sizeMult;
                    const h = tier.baseHeight * sizeMult;

                    // Pick random texture from tier
                    const texFile = tier.textures[Math.floor(rng() * tier.textures.length)];
                    const tex = this._textures[texFile];
                    if (!tex) continue;

                    const sprite = new BillboardSprite(tex, w, h);
                    sprite.setPosition(wx, 0, wz);
                    this.scene.add(sprite.mesh);
                    sprites.push(sprite);
                    this._allSprites.push(sprite);
                }
            }
        }

        this._chunkSprites.set(chunkId, sprites);
    }

    /**
     * Remove foliage for a chunk that was cleaned up.
     */
    removeChunk(chunkId) {
        const sprites = this._chunkSprites.get(chunkId);
        if (!sprites) return;

        for (const sprite of sprites) {
            this.scene.remove(sprite.mesh);
            sprite.dispose();
            const idx = this._allSprites.indexOf(sprite);
            if (idx >= 0) this._allSprites.splice(idx, 1);
        }
        this._chunkSprites.delete(chunkId);
    }

    /**
     * Per-frame update: distance culling + billboard rotation.
     */
    update(cameraPos) {
        let visibleCount = 0;

        for (const sprite of this._allSprites) {
            const dx = sprite.mesh.position.x - cameraPos.x;
            const dz = sprite.mesh.position.z - cameraPos.z;
            const distSq = dx * dx + dz * dz;

            if (distSq > CULL_DISTANCE * CULL_DISTANCE || visibleCount >= MAX_VISIBLE) {
                sprite.mesh.visible = false;
            } else {
                sprite.mesh.visible = true;
                sprite.update(cameraPos);
                visibleCount++;
            }
        }
    }
}
