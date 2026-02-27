/**
 * ROADKILL — Main Game Entry Point
 *
 * Sets up Three.js scene, game loop, and connects all systems.
 */

import * as THREE from 'three';
import { InputManager } from './input.js';
import { RoadManager } from './road.js';
import { Vehicle } from './vehicle.js';
import { Cockpit } from './cockpit.js';
import { MonsterManager } from './monsters.js';
import { GoreSystem } from './gore.js';
import { HUD } from './hud.js';

// ── Scene Setup ──────────────────────────────────────────────

const container = document.getElementById('game-container');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false; // keep perf high
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Fog — hides chunk pop-in and gives atmosphere
const fogColor = 0x1a2a1a;
scene.fog = new THREE.Fog(fogColor, 80, 350);
scene.background = new THREE.Color(fogColor);

// Camera
const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 500
);

// ── Lighting ──────────────────────────────────────────────────

// Ambient
const ambient = new THREE.AmbientLight(0x334455, 1.5);
scene.add(ambient);

// Directional (moonlight / dusk)
const dirLight = new THREE.DirectionalLight(0x667788, 1.2);
dirLight.position.set(50, 100, -30);
scene.add(dirLight);

// Hemisphere (sky/ground gradient)
const hemiLight = new THREE.HemisphereLight(0x445566, 0x222211, 0.8);
scene.add(hemiLight);

// ── Game Systems ──────────────────────────────────────────────

const input = new InputManager();
const road = new RoadManager(scene);
const vehicle = new Vehicle();
const cockpit = new Cockpit(camera);
const monsters = new MonsterManager(scene);
const gore = new GoreSystem(scene);
const hud = new HUD();

// Cockpit is child of camera, add camera to scene
scene.add(camera);

// ── Monster Spawning ──────────────────────────────────────────

let lastSpawnedChunkIndex = -1;

function spawnMonstersForNewChunks() {
    const totalChunks = road.chunkCount;
    for (let i = lastSpawnedChunkIndex + 1; i < totalChunks; i++) {
        const spawnPositions = road.getSpawnPositions(i);
        monsters.spawnFromChunk(i, spawnPositions);
    }
    if (totalChunks > 0) {
        lastSpawnedChunkIndex = totalChunks - 1;
    }
}

// ── Start Screen ──────────────────────────────────────────────

let gameStarted = false;
const startScreen = document.getElementById('start-screen');

function startGame() {
    if (gameStarted) return;
    gameStarted = true;
    if (startScreen) startScreen.style.display = 'none';

    // Lock pointer for mouse steering (optional, won't fail on mobile)
    try {
        renderer.domElement.requestPointerLock();
    } catch (_) { /* ignore */ }
}

// Start on click/tap
if (startScreen) {
    startScreen.addEventListener('click', startGame);
    startScreen.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startGame();
    });
}

// Also start on any key
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

    // Clamp dt to prevent physics explosions on tab switch
    dt = Math.min(dt, 0.1);

    if (!gameStarted) {
        // Still render the scene so the road is visible behind start screen
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

    // Spawn monsters in new chunks
    spawnMonstersForNewChunks();

    // Update monsters
    monsters.update(dt, camera.position, vehicle.position, vehicle.angle);

    // Check monster hits
    const hits = monsters.checkHits(vehicle.position, vehicle.angle, vehicle.speed);
    for (const hit of hits) {
        gore.spawn(hit.position, hit.velocity);
        vehicle.applyImpact(0.15);
        hud.addKill();
    }

    // Update gore particles
    gore.update(dt, camera.position);

    // Update cockpit (steering wheel, indicators)
    cockpit.update(dt, vehicle);

    // Update camera position to follow vehicle
    updateCamera(dt);

    // Update HUD
    hud.update(dt, vehicle.speedKmh);

    // Render
    renderer.render(scene, camera);
}

function updateCamera(dt) {
    const forward = vehicle.getForward();
    const camHeight = 1.3;

    // Position camera at driver's eye level
    camera.position.set(
        vehicle.position.x + vehicle.shakeOffset.x,
        vehicle.position.y + camHeight + vehicle.shakeOffset.y,
        vehicle.position.z + vehicle.shakeOffset.z
    );

    // Look in the direction the car is heading
    const lookTarget = new THREE.Vector3(
        vehicle.position.x + forward.x * 20,
        vehicle.position.y + camHeight - 0.3,
        vehicle.position.z + forward.z * 20
    );
    camera.lookAt(lookTarget);
}

// ── Initialize ────────────────────────────────────────────────

// Initial monster spawn
spawnMonstersForNewChunks();

// Start game loop
gameLoop();
