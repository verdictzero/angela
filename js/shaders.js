/**
 * Unlit Shader System
 *
 * Mirrors the galvarius approach: all meshes are unshaded,
 * base texture is multiplied by an ambient tint color,
 * then blended toward fog color by distance (smoothstep).
 *
 * Shared uniforms ensure all unlit materials update together
 * when the day/night cycle changes tint and fog values.
 */

import * as THREE from 'three';

// ── Shared Uniforms ──────────────────────────────────────────
// All unlit materials reference these SAME objects.
// Mutating .value updates every material in one shot.

export const unlitUniforms = {
    ambientTint:        { value: new THREE.Color(1, 1, 1) },
    fogColor:           { value: new THREE.Color(0x889999) },
    fogStart:           { value: 100.0 },
    fogEnd:             { value: 400.0 },
    headlightPos:       { value: new THREE.Vector3() },
    headlightDir:       { value: new THREE.Vector3(0, 0, -1) },
    headlightIntensity: { value: 0.0 },
};

// ── Vertex Shader ────────────────────────────────────────────

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying float vViewDepth;
varying vec3 vWorldPos;

#ifdef BILLBOARD_Y
uniform float billboardRotY;
#endif

void main() {
    vUv = uv;

    vec3 pos = position;

    #ifdef BILLBOARD_Y
    // Rotate quad around Y in object space before world transform
    // PlaneGeometry is in XY plane so position.z ≈ 0
    float c = cos(billboardRotY), s = sin(billboardRotY);
    pos = vec3(position.x * c, position.y, position.x * s);
    #endif

    #ifdef USE_INSTANCING
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(pos, 1.0);
    #else
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    #endif

    vWorldPos = worldPos.xyz;
    vec4 mvPosition = viewMatrix * worldPos;
    vViewDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
}
`;

// ── Fragment Shader ──────────────────────────────────────────

const fragmentShader = /* glsl */ `
uniform sampler2D albedoMap;
uniform vec3 ambientTint;
uniform vec3 fogColor;
uniform float fogStart;
uniform float fogEnd;
uniform float alphaTest;
uniform float opacity;
uniform vec3 headlightPos;
uniform vec3 headlightDir;
uniform float headlightIntensity;
uniform float emissiveBoost;

varying vec2 vUv;
varying float vViewDepth;
varying vec3 vWorldPos;

void main() {
    vec4 texColor = texture2D(albedoMap, vUv);

    if (texColor.a < alphaTest) discard;

    // Headlight spotlight
    vec3 toFrag = vWorldPos - headlightPos;
    float dist = length(toFrag);
    vec3 toFragDir = toFrag / dist;
    float cosAngle = dot(toFragDir, headlightDir);
    float spotEffect = smoothstep(0.7, 0.9, cosAngle);
    float atten = clamp(1.0 - dist / 120.0, 0.0, 1.0);
    atten *= atten;
    vec3 headlight = vec3(1.0, 1.0, 0.8) * headlightIntensity * spotEffect * atten;

    // Multiplicative tint + additive headlight (emissiveBoost sets minimum brightness floor)
    vec3 lighting = ambientTint + headlight;
    vec3 color = texColor.rgb * max(lighting, vec3(emissiveBoost));

    // Distance fog via smoothstep
    float fogFactor = smoothstep(fogStart, fogEnd, vViewDepth);
    color = mix(color, fogColor, fogFactor);

    gl_FragColor = vec4(color, texColor.a * opacity);
}
`;

// ── Material Factory ─────────────────────────────────────────

/**
 * Create an unlit material with ambient tint and distance fog.
 * Tint/fog uniforms are shared globally — one update affects all.
 *
 * @param {THREE.Texture} texture - Albedo texture (or 1x1 solid color)
 * @param {object} options
 * @param {number} options.alphaTest - Alpha cutoff (default 0)
 * @param {boolean} options.transparent - Enable alpha blending
 * @param {number} options.side - THREE.FrontSide / DoubleSide / BackSide
 * @param {number} options.opacity - Overall opacity multiplier
 * @param {boolean} options.depthWrite - Write to depth buffer
 * @param {boolean} options.billboard - Enable shader-based Y-axis billboard (for InstancedMesh)
 */
export function createUnlitMaterial(texture, options = {}) {
    const {
        alphaTest = 0.0,
        transparent = false,
        side = THREE.FrontSide,
        opacity = 1.0,
        depthWrite = true,
        billboard = false,
    } = options;

    const emissiveBoost = options.emissiveBoost || 0.0;

    const uniforms = {
        albedoMap:   { value: texture },
        alphaTest:   { value: alphaTest },
        opacity:     { value: opacity },
        emissiveBoost: { value: emissiveBoost },
        // Shared — mutating .value on these updates all materials
        ambientTint:        unlitUniforms.ambientTint,
        fogColor:           unlitUniforms.fogColor,
        fogStart:           unlitUniforms.fogStart,
        fogEnd:             unlitUniforms.fogEnd,
        headlightPos:       unlitUniforms.headlightPos,
        headlightDir:       unlitUniforms.headlightDir,
        headlightIntensity: unlitUniforms.headlightIntensity,
    };

    const defines = {};

    if (billboard) {
        defines.BILLBOARD_Y = '';
        uniforms.billboardRotY = { value: 0.0 };
    }

    return new THREE.ShaderMaterial({
        uniforms,
        defines,
        vertexShader,
        fragmentShader,
        transparent,
        side,
        depthWrite,
        toneMapped: false,
        fog: false,
        lights: false,
    });
}

/**
 * Create an unlit material from a flat color (no texture file needed).
 */
export function createUnlitColorMaterial(color, options = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const c = new THREE.Color(color);
    ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    ctx.fillRect(0, 0, 1, 1);
    const tex = new THREE.CanvasTexture(canvas);
    return createUnlitMaterial(tex, options);
}
