/**
 * Foliage Manager — InstancedMesh Billboard Vegetation
 *
 * Spawns foliage sprites (ferns, bushes, juvenile trees, fir trees)
 * using a world-space grid system. Uses InstancedMesh (one per texture)
 * to render all instances in minimal draw calls. Billboard rotation
 * is handled via a shader uniform, not per-instance matrix updates.
 */

import * as THREE from 'three';
import { createUnlitMaterial } from './shaders.js';

// Grid and culling
const CELL_SIZE = 50;        // 50×50m world-space cells
const ACTIVE_RADIUS = 5;     // cells around camera

// Foliage tier definitions
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

// Total cells in active grid
const GRID_CELLS = (2 * ACTIVE_RADIUS + 1) ** 2;

// Estimate max instances per texture for capacity allocation.
// Each tier distributes across its textures, across all active cells.
function estimateCapacity() {
    const caps = {};
    for (const tier of TIERS) {
        const maxPerCell = tier.countPerCell * tier.clusterSize;
        const perTexture = Math.ceil(maxPerCell / tier.textures.length);
        const total = perTexture * GRID_CELLS;
        for (const file of tier.textures) {
            caps[file] = (caps[file] || 0) + total;
        }
    }
    return caps;
}

// Reusable math objects
const _identityQuat = new THREE.Quaternion();
const _matrix = new THREE.Matrix4();
const _camDir = new THREE.Vector3();

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
        this._textures = {};           // filename -> THREE.Texture
        this._meshes = new Map();      // filename -> { mesh, material }
        this._cellData = new Map();    // "cx,cz" -> [{ texFile, x, y, z, w, h }]
        this._dirty = false;
        this._loadTextures();
        this._createInstancedMeshes();
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

    _createInstancedMeshes() {
        // Shared unit quad geometry, bottom-anchored
        const geo = new THREE.PlaneGeometry(1, 1);
        geo.translate(0, 0.5, 0);

        const capacities = estimateCapacity();

        for (const tier of TIERS) {
            for (const file of tier.textures) {
                if (this._meshes.has(file)) continue;

                const tex = this._textures[file];
                const material = createUnlitMaterial(tex, {
                    transparent: true,
                    alphaTest: 0.1,
                    side: THREE.DoubleSide,
                    billboard: true,
                });

                const capacity = capacities[file] || 1000;
                const mesh = new THREE.InstancedMesh(geo, material, capacity);
                mesh.count = 0;
                mesh.frustumCulled = false;

                this.scene.add(mesh);
                this._meshes.set(file, { mesh, material });
            }
        }
    }

    _spawnCell(cx, cz) {
        const key = `${cx},${cz}`;
        if (this._cellData.has(key)) return;

        const instances = [];
        const rng = cellRng(cx, cz);
        const cellX = cx * CELL_SIZE;
        const cellZ = cz * CELL_SIZE;

        for (const tier of TIERS) {
            for (let c = 0; c < tier.countPerCell; c++) {
                const baseX = cellX + rng() * CELL_SIZE;
                const baseZ = cellZ + rng() * CELL_SIZE;

                for (let ci = 0; ci < tier.clusterSize; ci++) {
                    const wx = baseX + (ci > 0 ? (rng() - 0.5) * 6 : 0);
                    const wz = baseZ + (ci > 0 ? (rng() - 0.5) * 6 : 0);

                    // Road avoidance
                    const info = this.road.getRoadInfoAt({ x: wx, z: wz });
                    if (!info.offRoad) {
                        rng(); rng();
                        continue;
                    }

                    const sizeMult = 0.8 + rng() * 0.4;
                    const w = tier.baseWidth * sizeMult;
                    const h = tier.baseHeight * sizeMult;

                    const texFile = tier.textures[Math.floor(rng() * tier.textures.length)];
                    if (!this._textures[texFile]) continue;

                    instances.push({ texFile, x: wx, y: 0, z: wz, w, h });
                }
            }
        }

        this._cellData.set(key, instances);
        this._dirty = true;
    }

    _removeCell(key) {
        if (!this._cellData.has(key)) return;
        this._cellData.delete(key);
        this._dirty = true;
    }

    _rebuildInstances() {
        // Collect all instances grouped by texture
        const buckets = new Map();
        for (const file of this._meshes.keys()) {
            buckets.set(file, []);
        }

        for (const instances of this._cellData.values()) {
            for (const inst of instances) {
                const bucket = buckets.get(inst.texFile);
                if (bucket) bucket.push(inst);
            }
        }

        // Write instance matrices
        const scale = new THREE.Vector3();
        for (const [file, data] of this._meshes) {
            const bucket = buckets.get(file);
            const count = bucket.length;
            data.mesh.count = count;

            for (let i = 0; i < count; i++) {
                const inst = bucket[i];
                scale.set(inst.w, inst.h, inst.w);
                _matrix.compose(
                    { x: inst.x, y: inst.y, z: inst.z },  // position-like object
                    _identityQuat,
                    scale
                );
                data.mesh.setMatrixAt(i, _matrix);
            }

            if (count > 0) {
                data.mesh.instanceMatrix.needsUpdate = true;
            }
        }

        this._dirty = false;
    }

    /**
     * Per-frame update: manage cell lifecycle, rebuild instances if needed,
     * update billboard uniform.
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
            if (!this._cellData.has(key)) {
                const [cx, cz] = key.split(',').map(Number);
                this._spawnCell(cx, cz);
            }
        }

        // Remove cells out of range
        for (const key of this._cellData.keys()) {
            if (!activeCells.has(key)) {
                this._removeCell(key);
            }
        }

        // Rebuild instance buffers if cells changed
        if (this._dirty) {
            this._rebuildInstances();
        }

        // Billboard uniform — computed once from camera direction
        const dir = camera.getWorldDirection(_camDir);
        const rotY = Math.atan2(dir.x, dir.z);
        for (const md of this._meshes.values()) {
            md.material.uniforms.billboardRotY.value = rotY;
        }
    }
}
