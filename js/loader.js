/**
 * GLB Model Loader
 *
 * Loads .glb files via GLTFLoader, replaces all mesh materials
 * with the unlit ambient-tint shader, preserving embedded textures.
 * Models are cached by URL — subsequent loads return clones.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createUnlitMaterial } from './shaders.js';

const gltfLoader = new GLTFLoader();
const cache = new Map();  // url → { scene, animations }

/**
 * Load a GLB file and apply the unlit shader to every mesh.
 *
 * @param {string} url - Path to the .glb file (e.g. 'assets/monster.glb')
 * @param {object} [options]
 * @param {boolean} [options.castShadow=false] - not used (unlit), reserved
 * @returns {Promise<{ model: THREE.Group, animations: THREE.AnimationClip[] }>}
 */
export async function loadGLB(url, options = {}) {
    // Return cached clone
    if (cache.has(url)) {
        const cached = cache.get(url);
        return {
            model: cloneModel(cached.scene),
            animations: cached.animations,
        };
    }

    // Load
    const gltf = await new Promise((resolve, reject) => {
        gltfLoader.load(url, resolve, undefined, reject);
    });

    const scene = gltf.scene;

    // Walk every mesh and swap its material to our unlit shader
    scene.traverse((child) => {
        if (!child.isMesh) return;

        const oldMat = child.material;
        const texture = oldMat.map || null;

        const matOpts = {
            alphaTest:   oldMat.alphaTest || 0.0,
            transparent: oldMat.transparent || false,
            side:        oldMat.side !== undefined ? oldMat.side : THREE.FrontSide,
            opacity:     oldMat.opacity !== undefined ? oldMat.opacity : 1.0,
            depthWrite:  oldMat.depthWrite !== undefined ? oldMat.depthWrite : true,
        };

        if (texture) {
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;
            child.material = createUnlitMaterial(texture, matOpts);
        } else {
            // No texture — bake the material color into a 1×1 canvas texture
            const color = oldMat.color || new THREE.Color(1, 1, 1);
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`;
            ctx.fillRect(0, 0, 1, 1);
            child.material = createUnlitMaterial(new THREE.CanvasTexture(canvas), matOpts);
        }

        oldMat.dispose();
    });

    // Cache the template (never added to the scene directly)
    cache.set(url, { scene, animations: gltf.animations || [] });

    return {
        model: cloneModel(scene),
        animations: gltf.animations || [],
    };
}

/**
 * Shallow-clone a model group.
 * Geometry and materials are shared across clones for efficiency.
 * If you need per-instance material changes (e.g. fade-out),
 * clone the material on that specific mesh yourself.
 */
function cloneModel(source) {
    return source.clone(true);
}

/**
 * Preload multiple GLB files in parallel.
 * Good for a loading screen before gameplay starts.
 *
 * @param {string[]} urls
 * @returns {Promise<Map<string, { model: THREE.Group, animations: THREE.AnimationClip[] }>>}
 */
export async function preloadGLBs(urls) {
    const results = await Promise.all(urls.map((url) => loadGLB(url).then((r) => [url, r])));
    return new Map(results);
}
