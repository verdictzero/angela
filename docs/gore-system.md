# Gore System — Technical Reference

> **File:** `js/gore.js` (544 lines)
> **Class:** `GoreSystem`
> **Dependencies:** Three.js, `shaders.js`, `utils.js`

## Overview

The gore system is a multi-layered particle effects framework that triggers when the player's vehicle collides with NPCs. It manages five independent subsystems—each backed by its own `THREE.InstancedMesh`—to produce an explosive burst of particles, airborne chunks, atmospheric blood clouds, and persistent ground decals. A full-screen CSS blood flash provides additional screen feedback on every hit.

All rendering uses a custom unlit billboard shader with support for day/night ambient tinting, distance fog, and headlight illumination. Object pooling and instanced rendering keep the system garbage-collection-free at runtime.

---

## Architecture

```
Vehicle hits NPC (killable_npcs.js)
        │
        ▼
  gore.spawn(position, impactVelocity)
        │
        ├── 60 Gore Particles      (small red squares, wide spray)
        ├── 12 Big Gore Chunks      (large squares, launched far ahead)
        ├──  6 Blood Clouds         (red evaporation puffs)
        ├──  2 Blood Decals         (ground splatter marks)
        └──  1 Screen Blood Flash   (CSS radial-gradient overlay)

  gore.update(dt, camera, vehiclePos, vehicleAngle, vehicleSpeed)
        │
        ├── Updates all 5 subsystems (physics, fading, ground collision)
        ├── Detects vehicle driving over grounded Big Chunks
        │       │
        │       └── Per chunk hit:
        │           ├── 16 Sub-Gore Chunks (secondary burst)
        │           ├──  1 Blood Cloud
        │           └──  1 Blood Decal
        │
        └── Returns chunkHitCount → triggers camera shake (0.05 intensity)
```

---

## Subsystems

### 1. Gore Particles

Small red billboard squares that spray outward from the impact point in a wide burst.

| Property | Value |
|---|---|
| Pool size | 1,500 |
| Per hit | 60 |
| Lifetime | 3.5s (×0.5–1.0 random) |
| Size | 0.12–0.6 units |
| Color | `0xff1100` (bright arterial red) |
| Ground threshold | Y ≤ 0.03 |

**Velocity formula:**
```
vx = impactVelocity.x × random(0.5, 2.0) + random(-8, 8)
vy = random(5, 18)
vz = impactVelocity.z × random(0.5, 2.0) + random(-8, 8)
```

**Behavior:**
- Gravity-affected (−15 m/s²)
- When grounded: remaining lifetime is clamped to `age + random(0.3, 1.0)`
- Fade via scale shrink over the final 40% of lifetime
- Does **not** spawn decals/clouds on ground impact (unlike sub-chunks)

### 2. Big Gore Chunks

Large red billboard squares launched far ahead of the vehicle. These are interactive—the player can drive over them after they land to trigger a secondary explosion.

| Property | Value |
|---|---|
| Pool size | 200 |
| Per hit | 12 |
| Lifetime | 8.0s (fixed) |
| Size | 0.7–1.8 units |
| Color | `0xdd2200` (slightly darker red) |
| Hit radius | 2.0 units |
| Ground threshold | Y ≤ 0.05 |

**Velocity formula:**
```
vx = impactVelocity.x × random(2.5, 5.0) + random(-6, 6)
vy = random(6, 18)
vz = impactVelocity.z × random(2.5, 5.0) + random(-6, 6)
```

**Behavior:**
- Gravity-affected (−15 m/s²)
- `hittable` flag set to `true` when the chunk lands (Y ≤ 0.05)
- Spawns a blood decal at landing position
- Vehicle hit detection: checks a point 2 units ahead of the car; if within `CHUNK_HIT_RADIUS` of a grounded chunk, the chunk explodes
- On vehicle re-hit: spawns 16 sub-chunks + 1 decal + 1 cloud, chunk is deactivated
- Vehicle must be moving at speed > 3 m/s for hit detection to activate
- Fade via scale shrink over the final 30% of lifetime

### 3. Sub-Gore Chunks

Small secondary particles spawned when the vehicle drives over a grounded Big Chunk. They inherit the vehicle's forward direction.

| Property | Value |
|---|---|
| Pool size | 600 |
| Per hit | 16 |
| Lifetime | 5.0s (×0.6–1.0 random) |
| Size | 0.2–0.6 units |
| Color | `0xee1500` (medium red) |
| Ground threshold | Y ≤ 0.03 |

**Velocity formula:**
```
vx = forward.x × vehicleSpeed × random(0.3, 1.2) + random(-8, 8)
vy = random(4, 14)
vz = forward.z × vehicleSpeed × random(0.3, 1.2) + random(-8, 8)
```

**Behavior:**
- Gravity-affected (−15 m/s²)
- Spawns a blood decal + blood cloud on ground impact (once per sub-chunk via `decalSpawned` flag)
- Fade via scale shrink over the final 40% of lifetime

### 4. Blood Clouds

Quick-fading atmospheric puffs that evaporate upward. Created both at initial impact and when sub-chunks/chunks hit the ground.

| Property | Value |
|---|---|
| Pool size | 100 |
| Per initial hit | 6 |
| Lifetime | 1.0s (×0.8–1.2 random) |
| Size | 5.0 units (fixed) |
| Color | `0xff0000` (pure red) |
| Initial opacity | 0.6 |

**Behavior:**
- Rise at 1.5 units/sec
- Scale down linearly from full size to zero (evaporation effect)
- No gravity, no ground collision

### 5. Blood Decals

Persistent ground splatter marks rendered as XZ-aligned quads with a procedurally generated texture.

| Property | Value |
|---|---|
| Pool size | 250 |
| Per initial hit | 2 |
| Lifetime | 15.0s (×0.7–1.0 random) |
| Size | 2.5–6.0 units |
| Y position | 0.02 (just above ground) |

**Texture generation:**
- 64×64 canvas, 8 random circles per texture
- Dark-red color range: `rgba(120–180, 0, 0, 0.3–0.7)`
- Random angle/distance from center for organic splatter look
- `THREE.NearestFilter` for pixelated aesthetic

**Behavior:**
- Random Y-axis rotation for variety
- Fade via scale shrink over the final 30% of lifetime
- Also spawned by: chunks landing, sub-chunks landing, chunk re-hits

---

## Physics

All physics-based subsystems (particles, chunks, sub-chunks) share the same integration model:

```
velocity.y += GRAVITY × dt        // GRAVITY = -15 m/s²
position   += velocity × dt
```

**Ground collision** sets `grounded = true` and clamps the Y position. Grounded objects stop moving but continue aging and fading until their lifetime expires.

---

## Rendering

### Materials

All gore materials use the custom unlit shader system defined in `shaders.js`. Key properties shared across all gore materials:

| Property | Value |
|---|---|
| Shading | Unlit (no scene lights) |
| Billboard | Y-axis rotation in vertex shader |
| Transparency | Enabled, double-sided |
| Depth write | Disabled |
| Render order | 1 (after opaque geometry) |
| Emissive boost | 0.25–0.35 (minimum brightness floor for night visibility) |
| Tone mapping | Disabled |

### Billboard System

The vertex shader rotates each quad around the Y-axis to face the camera:

```glsl
#ifdef BILLBOARD_Y
float c = cos(billboardRotY), s = sin(billboardRotY);
pos = vec3(position.x * c, position.y, position.x * s);
#endif
```

The `billboardRotY` uniform is computed per frame from the camera direction:
```js
const rotY = Math.atan2(dir.x, -dir.z);
```

This is set once per frame and applied to all four billboard materials (particles, chunks, sub-chunks, clouds). Decals use a ground-aligned geometry and don't billboard.

### Shader Features

The fragment shader applies these effects in order:

1. **Headlight spotlight** — cone-shaped illumination from vehicle headlights with distance attenuation
2. **Ambient tinting** — day/night cycle color multiplication
3. **Emissive boost** — minimum brightness floor (`max(lighting, vec3(emissiveBoost))`)
4. **Distance fog** — smoothstep blend toward fog color

---

## Object Pooling

All five subsystems use a pre-allocated object pool pattern with zero runtime allocation:

```
_acquire(pool):
  1. Scan pool for first inactive slot → return it
  2. If all slots occupied → find oldest (max age) → recycle it
```

Each pool element is a plain object created at construction time. The pool never grows or shrinks—`_acquire` either reuses an inactive slot or forcibly recycles the oldest active element.

**Instance count optimization:** Each `InstancedMesh.count` is set to the number of active objects per frame. Inactive objects are excluded from the draw call entirely by packing active instances into contiguous indices.

---

## Integration Points

### Trigger: NPC Hit Detection (`killable_npcs.js`)

```
KillableNPCManager.checkHits(vehiclePos, vehicleAngle, vehicleSpeed)
```

- Checks a point `HIT_FORWARD × 0.5` (2 units) ahead of the car
- Collision radius: 2.5 units
- Minimum speed threshold: 3 m/s
- Returns `{ position, velocity }` where velocity = forward × speed × 0.5

### Game Loop Integration (`main.js`)

```js
// NPC hits → spawn gore + camera shake + score
const hits = killableNPCs.checkHits(vehicle.position, vehicle.angle, vehicle.speed);
for (const hit of hits) {
    gore.spawn(hit.position, hit.velocity);     // trigger gore explosion
    vehicle.applyImpact(0.15);                  // camera shake (strong)
    hud.addKill();                              // increment score
}

// Gore update → chunk re-hits → camera shake
const chunkHits = gore.update(dt, camera, vehicle.position, vehicle.angle, vehicle.speed);
for (let i = 0; i < chunkHits; i++) {
    vehicle.applyImpact(0.05);                  // camera shake (light)
}
```

### Vehicle Impact (`vehicle.js`)

`applyImpact(intensity)` sets a screen shake amount that decays at `5×dt` per frame. The shake offset is applied to the camera position in `updateCamera()`.

| Event | Shake intensity |
|---|---|
| NPC kill | 0.15 |
| Chunk re-hit | 0.05 |

### Screen Blood Flash (`index.html` + `css/style.css`)

A full-screen `<div id="blood-overlay">` with:
- Radial gradient: semi-transparent center (20% opacity) → opaque edges (80% opacity)
- Fast fade-in: 30ms via CSS transition
- Auto-removal after 350ms timeout
- Slow fade-out: 150ms via CSS transition

---

## Pool Capacities at a Glance

| Subsystem | Max Pool | Per NPC Hit | Per Chunk Re-Hit | Lifetime |
|---|---|---|---|---|
| Gore Particles | 1,500 | 60 | — | 1.75–3.5s |
| Big Chunks | 200 | 12 | — | 8.0s |
| Sub-Chunks | 600 | — | 16 | 3.0–5.0s |
| Blood Clouds | 100 | 6 | 1 | 0.8–1.2s |
| Blood Decals | 250 | 2 | 1 | 10.5–15.0s |

**Theoretical peak per NPC hit:** 60 particles + 12 chunks + 6 clouds + 2 decals = **80 new objects**

**Theoretical peak per chunk re-hit:** 16 sub-chunks + 1 cloud + 1 decal = **18 new objects**

---

## Constants Reference

```js
// Particles
MAX_PARTICLES       = 1500
PARTICLES_PER_HIT   = 60
PARTICLE_LIFETIME   = 3.5       // seconds
PARTICLE_SIZE_MIN   = 0.12
PARTICLE_SIZE_MAX   = 0.6

// Big Chunks
MAX_CHUNKS          = 200
CHUNKS_PER_HIT      = 12
CHUNK_LIFETIME      = 8.0
CHUNK_SIZE_MIN      = 0.7
CHUNK_SIZE_MAX      = 1.8
CHUNK_HIT_RADIUS    = 2.0

// Sub-Chunks
MAX_SUB_CHUNKS      = 600
SUB_CHUNKS_PER_HIT  = 16
SUB_CHUNK_LIFETIME  = 5.0
SUB_CHUNK_SIZE_MIN  = 0.2
SUB_CHUNK_SIZE_MAX  = 0.6

// Blood Clouds
MAX_CLOUDS          = 100
CLOUDS_PER_HIT      = 6
CLOUD_LIFETIME      = 1.0
CLOUD_SIZE          = 5.0

// Blood Decals
MAX_DECALS          = 250
DECAL_LIFETIME      = 15.0

// Physics
GRAVITY             = -15       // m/s²
```

---

## Method Reference

| Method | Signature | Description |
|---|---|---|
| `constructor` | `(scene)` | Initializes all materials, meshes, and pools |
| `spawn` | `(position, impactVelocity)` | Triggers full gore explosion at hit position |
| `update` | `(dt, camera, vehiclePos, vehicleAngle, vehicleSpeed)` → `number` | Per-frame update of all subsystems; returns chunk re-hit count |
| `_spawnCloud` | `(position)` | Creates a single blood evaporation puff |
| `_spawnDecal` | `(position)` | Creates a single ground splatter mark |
| `_spawnSubChunks` | `(position, forward, vehicleSpeed)` | Spawns 16 sub-chunks when a grounded chunk is hit |
| `_flashBlood` | `()` | Triggers CSS blood overlay flash |
| `_updatePhysicsPool` | `(pool, mesh, dt, max, spawnDecalOnGround)` | Generic physics update for particles/sub-chunks |
| `_updateChunks` | `(dt, vehiclePos, vehicleAngle, vehicleSpeed)` → `number` | Chunk-specific update with vehicle hit detection |
| `_updateClouds` | `(dt)` | Cloud rise and evaporation animation |
| `_updateDecals` | `(dt)` | Decal fade-out over time |
| `_acquire` | `(pool)` → `object` | Pool acquisition: finds inactive slot or recycles oldest |
| `_createIM` | `(geo, mat, count)` → `InstancedMesh` | Factory for instanced mesh setup |
| `_createPhysicsPool` | `(max)` → `Array` | Allocates particle/sub-chunk pool |
| `_createChunkPool` | `(max)` → `Array` | Allocates chunk pool (with `hittable` flag) |
| `_createCloudPool` | `(max)` → `Array` | Allocates cloud pool |
| `_createDecalPool` | `(max)` → `Array` | Allocates decal pool |
| `_generateDecalTexture` | `()` → `CanvasTexture` | Procedurally generates 64×64 splatter texture |
