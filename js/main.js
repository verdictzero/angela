/**
 * ROADKILL — Main Game Entry Point
 *
 * Sets up Three.js scene, game loop, and connects all systems.
 * Integrates day/night cycle, LHD camera offset, and atmospheric effects.
 */

import * as THREE from 'three';
import { InputManager } from './input.js';
import { RoadManager } from './road.js';
import { Vehicle } from './vehicle.js';
import { Cockpit, DRIVER_OFFSET_X } from './cockpit.js';
import { KillableNPCManager } from './killable_npcs.js';
import { GoreSystem } from './gore.js';
import { HUD } from './hud.js';
import { DayNightCycle } from './daynight.js';
import { FoliageManager } from './foliage.js';
import { unlitUniforms } from './shaders.js';

// ── Scene Setup ──────────────────────────────────────────────

const container = document.getElementById('game-container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Fog — dynamically controlled by day/night cycle
const fog = new THREE.Fog(0x1a2a1a, 80, 350);
scene.fog = fog;
scene.background = new THREE.Color(0x1a2a1a);

// Camera
const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 500
);

// ── Lighting ──────────────────────────────────────────────────

const ambient = new THREE.AmbientLight(0x334455, 1.5);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0x667788, 1.2);
dirLight.position.set(50, 100, -30);
scene.add(dirLight);

const hemiLight = new THREE.HemisphereLight(0x445566, 0x222211, 0.8);
scene.add(hemiLight);

// ── Game Systems ──────────────────────────────────────────────

const input = new InputManager();
const road = new RoadManager(scene);
const vehicle = new Vehicle();
const cockpit = new Cockpit(camera);
const killableNPCs = new KillableNPCManager(scene);
const gore = new GoreSystem(scene);
const hud = new HUD();
const dayNight = new DayNightCycle(scene);
const foliage = new FoliageManager(scene, road);

// Cockpit is child of camera, add camera to scene
scene.add(camera);

// ── NPC Spawning ─────────────────────────────────────────────

let lastSpawnedChunkId = -1;
const spawnedChunkIds = new Set();

function spawnNPCsForNewChunks() {
    const newChunks = road.getNewChunks(lastSpawnedChunkId);
    for (const chunk of newChunks) {
        if (!spawnedChunkIds.has(chunk.id)) {
            const spawnPositions = road._spawnPositionsForChunk(chunk);
            killableNPCs.spawnFromChunk(chunk.id, spawnPositions, road.points);
            spawnedChunkIds.add(chunk.id);
        }
        if (chunk.id > lastSpawnedChunkId) lastSpawnedChunkId = chunk.id;
    }
}

// ── Start Screen ──────────────────────────────────────────────

let gameStarted = false;
const startScreen = document.getElementById('start-screen');

function startGame() {
    if (gameStarted) return;
    gameStarted = true;
    if (startScreen) startScreen.style.display = 'none';

    try {
        renderer.domElement.requestPointerLock();
    } catch (_) { /* ignore */ }
}

if (startScreen) {
    startScreen.addEventListener('click', startGame);
    startScreen.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startGame();
    });
}

window.addEventListener('keydown', startGame, { once: false });

// ── Resize Handling ───────────────────────────────────────────

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Game Loop ─────────────────────────────────────────────────

let prevTime = performance.now();

function gameLoop() {
    requestAnimationFrame(gameLoop);

    const now = performance.now();
    let dt = (now - prevTime) / 1000;
    prevTime = now;
    dt = Math.min(dt, 0.1);

    // Day/night cycle (always runs, even on start screen)
    const intensity = dayNight.update(dt, ambient, dirLight, hemiLight, fog, scene);

    // Sync shared unlit shader uniforms with day/night state
    unlitUniforms.ambientTint.value.copy(dayNight.currentColors.ambientTint);
    unlitUniforms.fogColor.value.copy(fog.color);
    unlitUniforms.fogStart.value = fog.near;
    unlitUniforms.fogEnd.value = fog.far;

    // Headlights follow day/night
    cockpit.setHeadlightIntensity(intensity.headlight);

    // Headlight uniforms for unlit shader (updated after updateCamera sets camera.position)
    unlitUniforms.headlightIntensity.value = intensity.headlight / 50.0;

    // Tone mapping exposure shifts slightly with time of day
    renderer.toneMappingExposure = dayNight.isNight ? 0.8 : 1.1;

    // Move star dome with camera
    const starDome = dayNight.getStarDome();
    if (starDome) {
        starDome.position.copy(camera.position);
    }

    if (!gameStarted) {
        updateCamera(dt);
        renderer.render(scene, camera);
        return;
    }

    // Update input
    input.update(dt);

    // Get road info at vehicle position
    const roadInfo = road.getRoadInfoAt(vehicle.position);

    // Update vehicle physics
    vehicle.update(dt, input, roadInfo);

    // Update road (generate ahead, remove behind)
    road.update(vehicle.position);

    // Spawn NPCs in new chunks
    spawnNPCsForNewChunks();

    // Update killable NPCs (pass road points so they follow the road)
    killableNPCs.update(dt, camera, vehicle.position, vehicle.angle, road.points);

    // Check NPC hits
    const hits = killableNPCs.checkHits(vehicle.position, vehicle.angle, vehicle.speed);
    for (const hit of hits) {
        gore.spawn(hit.position, hit.velocity);
        vehicle.applyImpact(0.15);
        hud.addKill();
    }

    // Update foliage (distance culling + billboards)
    foliage.update(camera);

    // Update gore particles
    gore.update(dt, camera);

    // Update cockpit
    cockpit.update(dt, vehicle);

    // Update camera — LHD offset
    updateCamera(dt);

    // Sync headlight pos/dir now that camera is positioned
    unlitUniforms.headlightPos.value.copy(camera.position);
    unlitUniforms.headlightDir.value.copy(vehicle.getForward());

    // Update HUD — include debug info (chunk ID, coordinates, NPC count)
    const currentChunk = road.getChunkAt(vehicle.position);
    hud.update(dt, vehicle.speedKmh, dayNight.getTimeString(), dayNight.getPhaseName(), {
        chunkId: currentChunk ? currentChunk.id : -1,
        x: Math.round(vehicle.position.x),
        z: Math.round(vehicle.position.z),
        npcCount: killableNPCs.aliveCount,
    });

    // Render
    renderer.render(scene, camera);
}

function updateCamera(dt) {
    const forward = vehicle.getForward();
    const right = vehicle.getRight();
    const camHeight = 1.3;

    // LHD: camera offset to driver's left seat position
    camera.position.set(
        vehicle.position.x + right.x * DRIVER_OFFSET_X + vehicle.shakeOffset.x,
        vehicle.position.y + camHeight + vehicle.shakeOffset.y,
        vehicle.position.z + right.z * DRIVER_OFFSET_X + vehicle.shakeOffset.z
    );

    // Look along the driving direction, from driver's seat
    const lookTarget = new THREE.Vector3(
        vehicle.position.x + forward.x * 20 + right.x * DRIVER_OFFSET_X,
        vehicle.position.y + camHeight - 0.3,
        vehicle.position.z + forward.z * 20 + right.z * DRIVER_OFFSET_X
    );
    camera.lookAt(lookTarget);
}

// ── Initialize ────────────────────────────────────────────────

spawnNPCsForNewChunks();
gameLoop();
