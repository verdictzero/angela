/**
 * Pixelation Pass — Full-screen half-res nearest-neighbor downscale
 *
 * Snaps UV coordinates to a grid at half the screen resolution,
 * producing a chunky pixelated look before the dither/LUT pass.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const PixelateShader = {
    uniforms: {
        tDiffuse: { value: null },
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
        uniform vec2 uResolution;

        varying vec2 vUv;

        void main() {
            // Half-res grid: snap pixel coordinates to 2×2 blocks
            vec2 pixelSize = 2.0 / uResolution;
            vec2 snapped = floor(vUv / pixelSize + 0.5) * pixelSize;
            gl_FragColor = texture2D(tDiffuse, snapped);
        }
    `,
};

export function createPixelatePass() {
    const pass = new ShaderPass(PixelateShader);

    const origSetSize = pass.setSize.bind(pass);
    pass.setSize = (w, h) => {
        origSetSize(w, h);
        pass.uniforms.uResolution.value.set(w, h);
    };

    return pass;
}
