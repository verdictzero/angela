/**
 * Foliage Manager — World-Grid Billboard Vegetation
 *
 * Spawns foliage sprites (ferns, bushes, juvenile trees, fir trees)
 * using a world-space grid system. Vegetation covers all terrain
 * (not just near road), with road/shoulder/sidewalk avoidance.
 * Distance culling keeps sprite count manageable.
 */

import * as THREE from 'three';
import { BillboardSprite } from './sprites.js';

// Grid and culling
const CELL_SIZE = 50;        // 50×50m world-space cells
const ACTIVE_RADIUS = 5;     // cells around camera
const CULL_DISTANCE = 200;
const MAX_VISIBLE = 3200;

// Foliage tier definitions (4x density, no road-relative distances)
const TIERS = [
    {
        name: 'fern',
        textures: ['fern_1.png', 'fern_2.png', 'fern_3.png', 'fern_4.png'],
        baseWidth: 1.2, baseHeight: 0.8,
        clusterSize: 3,
        countPerCell: 32,
    },
    {
        name: 'bush',
        textures: ['forest_bush_1.png', 'forest_bush_2.png', 'forest_bush_3.png'],
        baseWidth: 3, baseHeight: 2.5,
        clusterSize: 2,
        countPerCell: 24,
    },
    {
        name: 'juvenile',
        textures: ['juvenile_fir_tree_1.png', 'juvenile_fir_tree_2.png', 'juvenile_fir_tree_4.png'],
        baseWidth: 4, baseHeight: 6,
        clusterSize: 2,
        countPerCell: 16,
    },
    {
        name: 'fir',
        textures: ['fir_tree_1.png', 'fir_tree_2.png', 'fir_tree_3.png', 'fir_tree_4.png'],
        baseWidth: 5, baseHeight: 10,
        clusterSize: 1,
        countPerCell: 12,
    },
];

// Deterministic seeded random from cell coordinates
function cellRng(cx, cz) {
    let seed = (cx * 73856093 + cz * 19349669) & 0x7fffffff;
    return function () {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed >>> 1) / 0x3fffffff;
    };
}

export class FoliageManager {
    constructor(scene, road) {
        this.scene = scene;
        this.road = road;
        this._textures = {};
        this._cells = new Map();      // "cx,cz" -> [sprites]
        this._allSprites = [];        // flat list for culling
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

    _spawnCell(cx, cz) {
        const key = `${cx},${cz}`;
        if (this._cells.has(key)) return;

        const sprites = [];
        const rng = cellRng(cx, cz);
        const cellX = cx * CELL_SIZE;
        const cellZ = cz * CELL_SIZE;

        for (const tier of TIERS) {
            for (let c = 0; c < tier.countPerCell; c++) {
                // Base position within the cell
                const baseX = cellX + rng() * CELL_SIZE;
                const baseZ = cellZ + rng() * CELL_SIZE;

                for (let ci = 0; ci < tier.clusterSize; ci++) {
                    // Cluster spread
                    const wx = baseX + (ci > 0 ? (rng() - 0.5) * 6 : 0);
                    const wz = baseZ + (ci > 0 ? (rng() - 0.5) * 6 : 0);

                    // Road avoidance: skip if on road/shoulder/sidewalk
                    const info = this.road.getRoadInfoAt({ x: wx, z: wz });
                    if (!info.offRoad) {
                        // Consume remaining rng calls to keep determinism
                        rng(); rng();
                        continue;
                    }

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

        this._cells.set(key, sprites);
    }

    _removeCell(key) {
        const sprites = this._cells.get(key);
        if (!sprites) return;

        for (const sprite of sprites) {
            this.scene.remove(sprite.mesh);
            sprite.dispose();
            const idx = this._allSprites.indexOf(sprite);
            if (idx >= 0) this._allSprites.splice(idx, 1);
        }
        this._cells.delete(key);
    }

    /**
     * Per-frame update: manage cell lifecycle, distance culling, billboards.
     */
    update(camera) {
        const camX = camera.position.x;
        const camZ = camera.position.z;
        const camCX = Math.floor(camX / CELL_SIZE);
        const camCZ = Math.floor(camZ / CELL_SIZE);

        // Determine which cells should be active
        const activeCells = new Set();
        for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
            for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
                activeCells.add(`${camCX + dx},${camCZ + dz}`);
            }
        }

        // Spawn new cells
        for (const key of activeCells) {
            if (!this._cells.has(key)) {
                const [cx, cz] = key.split(',').map(Number);
                this._spawnCell(cx, cz);
            }
        }

        // Remove cells out of range
        for (const key of this._cells.keys()) {
            if (!activeCells.has(key)) {
                this._removeCell(key);
            }
        }

        // Billboard update
        for (const sprite of this._allSprites) {
            sprite.update(camera);
        }
    }
}
