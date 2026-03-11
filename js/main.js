/**
 * ROADKILL — Main Game Entry Point
 *
 * Sets up Three.js scene, game loop, and connects all systems.
 * Integrates day/night cycle, LHD camera offset, and atmospheric effects.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createUzeboxLUTPass } from './uzeboxLUT.js';
import { InputManager } from './input.js';
import { RoadManager } from './road.js';
import { Vehicle } from './vehicle.js';
import { Cockpit, DRIVER_OFFSET_X } from './cockpit.js';
import { KillableNPCManager } from './killable_npcs.js';
import { GoreSystem } from './gore.js';
import { HUD, getGearAndRPM } from './hud.js';
import { DayNightCycle } from './daynight.js';

import { FoliageManager } from './foliage.js';
import { unlitUniforms } from './shaders.js';
import { AudioEngine } from './audio.js';

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

// Disable auto-reset so renderer.info stats accumulate across all
// EffectComposer passes (scene render + bloom).  We reset manually each frame.
renderer.info.autoReset = false;

const scene = new THREE.Scene();

// Fog — dynamically controlled by day/night cycle
const fog = new THREE.Fog(0x1a2a1a, 80, 350);
scene.fog = fog;
scene.background = new THREE.Color(0x1a2a1a);

// Camera
const camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 600
);

// ── Post-Processing ──────────────────────────────────────────

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55,  // strength
    0.6,   // radius
    0.78   // threshold
);
composer.addPass(bloomPass);

// Uzebox palette LUT — async load, inserted after bloom once ready
createUzeboxLUTPass('assets/uzebox.hex').then(lutPass => {
    // Mark bloom as no longer the final pass
    bloomPass.renderToScreen = false;
    composer.addPass(lutPass);
});

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
const audio = new AudioEngine();

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

// ── Engine Start Button ───────────────────────────────────────

const engineStartBtn = document.getElementById('engine-start-btn');

function tryStartEngine() {
    if (vehicle.engineRunning) return;
    vehicle.startEngine();
    audio.resume();
    audio.playEngineStart();
    if (engineStartBtn) engineStartBtn.classList.add('hidden');
}

if (engineStartBtn) {
    engineStartBtn.addEventListener('click', tryStartEngine);
    engineStartBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        tryStartEngine();
    });
}

// Enter key starts engine
window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && gameStarted && !vehicle.engineRunning) {
        tryStartEngine();
    }
});

// ── Sound Toggle ──────────────────────────────────────────────

const soundToggleBtn = document.getElementById('sound-toggle');

function toggleSound() {
    const muted = !audio.isMuted();
    audio.setMuted(muted);
    if (soundToggleBtn) {
        soundToggleBtn.textContent = muted ? 'SND OFF' : 'SND ON';
        soundToggleBtn.className = muted ? 'sound-off' : 'sound-on';
    }
}

if (soundToggleBtn) {
    soundToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSound();
    });
    soundToggleBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSound();
    });
}

// M key toggles sound
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && gameStarted) {
        toggleSound();
    }
});

// ── Start Screen ──────────────────────────────────────────────

let gameStarted = false;
const startScreen = document.getElementById('start-screen');

function startGame() {
    if (gameStarted) return;
    gameStarted = true;

    // Initialize audio on first user gesture — start muted by default
    audio.init();
    audio.resume();
    audio.setMuted(true);
    if (soundToggleBtn) {
        soundToggleBtn.textContent = 'SND OFF';
        soundToggleBtn.className = 'sound-off';
    }

    // Fade out start screen instead of instant hide
    if (startScreen) {
        startScreen.classList.add('fade-out');
        startScreen.addEventListener('transitionend', () => {
            startScreen.style.display = 'none';
        }, { once: true });
    }

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

// ── Resize Handling (with "Updating UI" overlay) ─────────────

const updatingOverlay = document.getElementById('updating-ui-overlay');
let resizeTimer = null;

function doResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}

function onResize() {
    if (!updatingOverlay) {
        doResize();
        return;
    }

    // Fade in the overlay (CSS transition handles animation)
    updatingOverlay.classList.add('visible');

    // Clear previous debounce timer
    if (resizeTimer) clearTimeout(resizeTimer);

    // Wait for resize events to settle, then resize and fade out
    resizeTimer = setTimeout(() => {
        doResize();
        requestAnimationFrame(() => {
            updatingOverlay.classList.remove('visible');
        });
    }, 400);
}

window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// ── Game Loop ─────────────────────────────────────────────────

let prevTime = performance.now();
let timeScale = 1.0;
let sceneStatsCache = { objects: 0, materials: 0, lights: 0 };
let sceneStatsFrame = 0;

function gameLoop() {
    requestAnimationFrame(gameLoop);

    const now = performance.now();
    let dt = (now - prevTime) / 1000;
    prevTime = now;
    dt = Math.min(dt, 0.1);
    dt *= timeScale;

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
        renderer.info.reset();
        composer.render();

        return;
    }

    // Update input
    input.update(dt);

    // Process transmission controls
    if (input.toggleTransmission) {
        vehicle.toggleTransmission();
        const btn = document.getElementById('btn-trans-mode');
        if (btn) btn.textContent = vehicle.manualMode ? 'MAN' : 'AUTO';
    }
    if (input.shiftUp) vehicle.shiftUp();
    if (input.shiftDown) vehicle.shiftDown();

    // Get road info at vehicle position
    const roadInfo = road.getRoadInfoAt(vehicle.position);

    // Update vehicle physics
    vehicle.update(dt, input, roadInfo);

    // Redline health degradation
    {
        const overrideGear = vehicle.manualMode ? vehicle.currentGear : undefined;
        const { rpm } = getGearAndRPM(Math.abs(vehicle.speed), overrideGear);
        if (vehicle.engineRunning && rpm >= 7000) {
            vehicle._redlineTimer += dt;
            if (vehicle._redlineTimer > vehicle._redlineGracePeriod) {
                vehicle.health = Math.max(0, vehicle.health - vehicle._redlineDamageRate * dt);
            }
        } else {
            vehicle._redlineTimer = Math.max(0, vehicle._redlineTimer - dt * 2);
        }
    }

    // Update road (generate ahead, remove behind)
    road.update(vehicle.position);

    // Spawn NPCs in new chunks
    spawnNPCsForNewChunks();

    // Update killable NPCs (pass road points so they follow the road)
    killableNPCs.update(dt, camera, vehicle.position, vehicle.angle, road.points);

    // Check tree collisions
    const treeHit = foliage.checkTreeCollision(vehicle.position, 1.2);
    if (treeHit) {
        audio.playTreeCrash(Math.abs(vehicle.speed) / 50);
        vehicle.applyTreeImpact(vehicle.speed);
    }

    // Check NPC hits
    const hits = killableNPCs.checkHits(vehicle.position, vehicle.angle, vehicle.speed);
    for (const hit of hits) {
        gore.spawn(hit.position, hit.velocity);
        vehicle.applyImpact(0.15);
        cockpit.addBloodSplatter(1.0);
        hud.addKill();
        audio.playImpact(0.8);
        audio.playSplat();
    }

    // Update foliage (distance culling + billboards)
    foliage.update(camera);

    // Update gore particles + chunk hit detection
    const chunkHits = gore.update(dt, camera, vehicle.position, vehicle.angle, vehicle.speed);
    for (let i = 0; i < chunkHits; i++) {
        vehicle.applyImpact(0.05);
        audio.playChunkHit();
    }

    // Show/hide engine start button
    if (engineStartBtn) {
        if (!vehicle.engineRunning) {
            engineStartBtn.classList.remove('hidden');
        } else {
            engineStartBtn.classList.add('hidden');
        }
    }

    // Update cockpit (pass input for wiper/washer controls)
    cockpit.update(dt, vehicle, input);

    // Detect engine stall (vehicle sets engineStalled flag each frame it stalls)
    if (vehicle.engineStalled) {
        audio.playEngineStall();
    }

    // Determine surface type for audio
    let audioSurface = 'road';
    if (roadInfo) {
        if (roadInfo.offRoad) audioSurface = 'offRoad';
        else if (roadInfo.onSidewalk) audioSurface = 'sidewalk';
        else if (roadInfo.onShoulder) audioSurface = 'shoulder';
    }

    // Per-frame audio update — engine, tires, surface rumble
    audio.update(dt, {
        speed: vehicle.speed,
        gear: vehicle.getGear(),
        gasInput: input.gas,
        brakeInput: input.brake,
        engineRunning: vehicle.engineRunning,
        drifting: vehicle.drifting,
        driftAngle: vehicle.driftAngle,
        surface: audioSurface,
        handbrake: input.handbrake,
    });

    // NPC proximity moped buzz
    audio.updateNPCSounds(killableNPCs.npcs, vehicle.position);

    // Update camera — LHD offset
    updateCamera(dt);

    // Sync headlight pos/dir now that camera is positioned
    unlitUniforms.headlightPos.value.copy(camera.position);
    unlitUniforms.headlightDir.value.copy(vehicle.getForward());

    // Scene stats (computed every 30 frames to avoid traversal overhead)
    sceneStatsFrame++;
    if (sceneStatsFrame % 30 === 0) {
        let objCount = 0, lightCount = 0;
        const matSet = new Set();
        scene.traverse((obj) => {
            objCount++;
            if (obj.isMesh && obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach(m => matSet.add(m));
                } else {
                    matSet.add(obj.material);
                }
            }
            if (obj.isLight) lightCount++;
        });
        sceneStatsCache = { objects: objCount, materials: matSet.size, lights: lightCount };
    }

    // Render — reset stats manually, then render so stats accumulate across all passes
    renderer.info.reset();
    composer.render();

    // Update HUD after render so renderer.info has accurate stats
    const currentChunk = road.getChunkAt(vehicle.position);
    hud.update(dt, vehicle.speedKmh, dayNight.getTimeString(), dayNight.getPhaseName(), {
        chunkId: currentChunk ? currentChunk.id : -1,
        x: Math.round(vehicle.position.x),
        z: Math.round(vehicle.position.z),
        npcCount: killableNPCs.aliveCount,
        sceneObjects: sceneStatsCache.objects,
        sceneMaterials: sceneStatsCache.materials,
        sceneLights: sceneStatsCache.lights,
        bloomStrength: bloomPass.strength,
        bloomRadius: bloomPass.radius,
        bloomThreshold: bloomPass.threshold,
        toneMapping: 'ACES Filmic',
        toneMappingExposure: renderer.toneMappingExposure,
        colorSpace: renderer.outputColorSpace,
        pixelRatioCapped: Math.min(window.devicePixelRatio, 2),
        pixelRatioNative: window.devicePixelRatio,
        canvasWidth: renderer.domElement.width,
        canvasHeight: renderer.domElement.height,
    }, vehicle.health, cockpit.washerFluid, vehicle);
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

// ── Loading Screen Dismissal ─────────────────────────────────
// Robust readiness gate: waits for minimum display time, rendered frame,
// and HUD DOM layout before fading out.
const loadingScreen = document.getElementById('loading-screen');
const loadingStatus = document.getElementById('loading-status');
const MINIMUM_LOADING_MS = 1500;
const MAX_LOADING_MS = 8000;
const loadStartTime = performance.now();
let loadingDismissed = false;

function checkReadyToDismiss() {
    if (loadingDismissed) return;

    const elapsed = performance.now() - loadStartTime;

    // Safety fallback — dismiss after 8s no matter what
    if (elapsed >= MAX_LOADING_MS) {
        dismissLoading();
        return;
    }

    // Condition 1: minimum display time
    if (elapsed < MINIMUM_LOADING_MS) {
        if (loadingStatus) loadingStatus.textContent = 'Preparing scene...';
        requestAnimationFrame(checkReadyToDismiss);
        return;
    }

    // Condition 2: at least one frame rendered
    if (renderer.info.render.frame < 1) {
        if (loadingStatus) loadingStatus.textContent = 'Rendering first frame...';
        requestAnimationFrame(checkReadyToDismiss);
        return;
    }

    // Condition 3: HUD elements have laid out
    const speedEl = document.getElementById('hud-speed');
    const debugEl = document.getElementById('hud-debug');
    if (!speedEl || speedEl.offsetHeight === 0 || !debugEl) {
        if (loadingStatus) loadingStatus.textContent = 'Laying out UI...';
        requestAnimationFrame(checkReadyToDismiss);
        return;
    }

    // All conditions met
    dismissLoading();
}

function dismissLoading() {
    if (loadingDismissed) return;
    loadingDismissed = true;
    if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        loadingScreen.addEventListener('transitionend', () => {
            loadingScreen.style.display = 'none';
        }, { once: true });
    }
}

requestAnimationFrame(checkReadyToDismiss);
