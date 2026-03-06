/**
 * Uzebox Palette LUT — Post-processing pass
 *
 * Quantizes every pixel to the nearest color in the Uzebox 256-color
 * palette (8R × 8G × 4B). Uses a 2D lookup texture (8×32) laid out
 * as 4 blue slices side by side, each 8×8 (R across, G down).
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const R_STEPS = 8;
const G_STEPS = 8;
const B_STEPS = 4;

// Build a 2D LUT texture: width = R_STEPS * B_STEPS = 32, height = G_STEPS = 8
// Layout: B slices placed horizontally. Each slice is 8 wide (R) × 8 tall (G).
function buildLUT(hexEntries) {
    const palette = hexEntries.map(h => [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
    ]);

    const w = R_STEPS * B_STEPS; // 32
    const h = G_STEPS;            // 8
    const data = new Uint8Array(w * h * 4);

    for (let bi = 0; bi < B_STEPS; bi++) {
        for (let gi = 0; gi < G_STEPS; gi++) {
            for (let ri = 0; ri < R_STEPS; ri++) {
                const palIdx = ri + gi * R_STEPS + bi * R_STEPS * G_STEPS;
                const c = palette[palIdx];
                const px = bi * R_STEPS + ri;
                const py = gi;
                const idx = (py * w + px) * 4;
                data[idx]     = c[0];
                data[idx + 1] = c[1];
                data[idx + 2] = c[2];
                data[idx + 3] = 255;
            }
        }
    }

    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

const UzeboxLUTShader = {
    uniforms: {
        tDiffuse: { value: null },
        uLUT: { value: null },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    },

    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    fragmentShader: /* glsl */ `
        precision highp float;

        uniform sampler2D tDiffuse;
        uniform sampler2D uLUT;
        uniform vec2 uResolution;

        varying vec2 vUv;

        // Palette dimensions
        const float R_STEPS = 8.0;
        const float G_STEPS = 8.0;
        const float B_STEPS = 4.0;
        const float LUT_W = R_STEPS * B_STEPS; // 32

        // 2×2 Bayer matrix for checkerboard dithering
        float bayer2(vec2 p) {
            float x = mod(p.x, 2.0);
            float y = mod(p.y, 2.0);
            // Returns -0.375, -0.125, 0.125, 0.375
            return (step(1.0, x) * 2.0 + step(1.0, y)) * 0.25 - 0.375;
        }

        void main() {
            vec4 color = texture2D(tDiffuse, vUv);
            vec2 pixel = floor(vUv * uResolution);

            // Dither: offset color before quantizing
            float dither = bayer2(pixel);
            vec3 c = clamp(color.rgb + vec3(
                dither / (R_STEPS - 1.0),
                dither / (G_STEPS - 1.0),
                dither / (B_STEPS - 1.0)
            ), 0.0, 1.0);

            // Snap to nearest palette index per channel
            float ri = floor(c.r * (R_STEPS - 1.0) + 0.5);
            float gi = floor(c.g * (G_STEPS - 1.0) + 0.5);
            float bi = floor(c.b * (B_STEPS - 1.0) + 0.5);

            // UV into the 2D LUT (32 wide × 8 tall)
            float u = (bi * R_STEPS + ri + 0.5) / LUT_W;
            float v = (gi + 0.5) / G_STEPS;

            vec3 mapped = texture2D(uLUT, vec2(u, v)).rgb;
            gl_FragColor = vec4(mapped, color.a);
        }
    `,
};

export async function createUzeboxLUTPass(hexPath) {
    const resp = await fetch(hexPath);
    const text = await resp.text();
    const entries = text.trim().split(/\s+/);

    const lutTex = buildLUT(entries);

    const pass = new ShaderPass(UzeboxLUTShader);
    pass.uniforms.uLUT.value = lutTex;

    // Keep resolution uniform in sync on resize
    const origSetSize = pass.setSize.bind(pass);
    pass.setSize = (w, h) => {
        origSetSize(w, h);
        pass.uniforms.uResolution.value.set(w, h);
    };

    return pass;
}
