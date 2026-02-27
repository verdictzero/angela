# DOOM-Style Driving Game - Implementation Plan

## Overview
A browser-based Three.js driving game where the player drives in first-person cockpit view down procedurally generated road networks, hitting monsters that explode into gore. Monsters and smaller items are Y-billboarded sprites with directional facing (Doom-style 4/8-angle sprite system). Supports keyboard+mouse, gamepad controller, and touch input.

---

## Phase 1: Project Scaffolding & Core Engine

### 1.1 Project Structure
```
angela/
├── index.html              # Entry point
├── css/
│   └── style.css           # UI, HUD, touch controls styling
├── js/
│   ├── main.js             # Game init, loop, scene setup
│   ├── input.js            # Unified input manager (keyboard, mouse, gamepad, touch)
│   ├── vehicle.js          # Car physics, steering, acceleration
│   ├── road.js             # Procedural road network generation
│   ├── cockpit.js          # Dashboard/interior rendering
│   ├── sprites.js          # Y-billboarded sprite system with directional facing
│   ├── monsters.js         # Monster spawning, AI, hit detection
│   ├── gore.js             # Explosion/gore particle effects
│   ├── hud.js              # Speed, score, minimap overlay
│   └── utils.js            # Helpers (math, random, etc.)
├── assets/
│   └── placeholders/       # Generated placeholder textures/sprites
└── lib/
    └── three.min.js        # Three.js (loaded via CDN in HTML)
```

### 1.2 HTML Setup
- Single `index.html` with Three.js loaded from CDN
- Canvas fills viewport, no scrolling
- Touch control overlay divs (hidden on desktop)
- HUD overlay for speed, score, etc.

---

## Phase 2: Procedural Road Network (Infinite)

### 2.1 Road Generation Strategy
- **Chunk-based system**: Road is generated in chunks (~200m segments) ahead of the player
- **Road types**: Straight, gentle curves, sharp turns, intersections, T-junctions
- **Each chunk contains**:
  - Road surface (textured plane, ~2-3 lanes wide)
  - Sidewalks on both sides (slightly elevated, driveable)
  - Curbs (small geometry between road and sidewalk)
  - Lane markings (dashed center line, solid edge lines)
- **Procedural path**: Use a spline-based approach
  - Generate control points with randomized offsets for curves
  - Extrude road mesh along the spline
  - Sidewalks follow the same spline with lateral offset
- **Chunk recycling**: Remove chunks far behind the player, reuse geometry/materials
- **Road network branching**: Occasional forks/intersections where the player can choose a path

### 2.2 Roadside Environment
- Placeholder buildings (colored boxes) along sidewalks
- Street lights (simple cylinder + point light)
- Barriers, trash cans, etc. (small destructible props — Y-billboarded sprites)

### 2.3 Ground/Terrain
- Flat ground plane extending beyond the road with a simple texture
- Fog to hide chunk loading/unloading in the distance

---

## Phase 3: Vehicle & Cockpit

### 3.1 Vehicle Physics (Simplified Arcade)
- Position tracked along the road spline + lateral offset
- **Controls**: Accelerate, brake/reverse, steer left/right
- **Physics**: Simple velocity/acceleration model, friction, max speed
- Collision with curbs slows the player; sidewalks are driveable but bumpier
- No complex tire simulation — arcade feel

### 3.2 Cockpit Interior
- **Dashboard mesh**: Simple 3D model (box-based placeholder)
  - Steering wheel (rotates with input)
  - Speedometer (needle or digital readout on HUD)
  - Dashboard surface with placeholder texture
- **Windshield frame**: Dark border geometry framing the view
- Camera is fixed inside the cockpit, slight bob with movement
- Rearview mirror (optional, stretch goal — small render-to-texture)

---

## Phase 4: Sprite System (Y-Billboarded, Directional)

### 4.1 Y-Billboard Implementation
- Sprites always face the camera on the Y-axis only (they don't tilt up/down)
- Use `THREE.Sprite` or custom `PlaneGeometry` with manual Y-billboard math
- Custom approach preferred for directional sprite control

### 4.2 Directional Sprite Angles (Doom-style)
- Each monster has **4 direction sprites** (front, back, left, right) — or 3 with left/right mirrored
- Calculate angle between:
  - Vector from monster to player (camera)
  - Monster's own facing direction
- Map the resulting angle to one of 4 (or 8) sprite indices
- Swap the sprite texture/UV accordingly each frame
- For 3-sprite setup: use `scale.x = -1` to mirror the side sprite for the opposite side

### 4.3 Placeholder Sprite Generation
- Generate colored canvas textures at runtime as placeholders:
  - Monsters: humanoid silhouette in different colors per direction (front=red, back=blue, side=green)
  - Props: simple shapes (barrel=brown circle, trash=gray square)
  - Gore chunks: red splatter shapes
- Each placeholder clearly labeled with direction text for debugging

---

## Phase 5: Monsters & Combat

### 5.1 Monster Spawning
- Spawn monsters on/near the road ahead of the player (in upcoming chunks)
- Variety: slow shamblers on the road, faster ones on sidewalks
- Monsters face a direction (wandering or toward player) — drives sprite selection

### 5.2 Hit Detection
- Simple distance + bounding box check between car front and monster position
- On hit:
  - Remove monster sprite
  - Trigger gore explosion (Phase 6)
  - Add score
  - Screen shake / impact feedback
  - Splat sound (placeholder: Web Audio API beep/crunch)

### 5.3 Monster Behavior (Simple)
- Idle: stand in place, occasionally turn
- Wander: slowly move in a direction
- Alert: face toward player when car is close
- No monster attacks in v1 — purely targets to run over

---

## Phase 6: Gore & Effects

### 6.1 Gore Particle System
- On monster death: spawn 10-20 particles
  - Red-tinted sprites/planes
  - Physics: initial burst velocity outward + gravity
  - Fade out over 1-2 seconds
  - Some stick to ground as decals (flat planes on road surface)
- Blood splatter on "windshield" (screen-space overlay that fades)

### 6.2 Other Effects
- Skid marks on road when braking
- Dust/debris when hitting props
- Simple headlights (spot lights attached to car)

---

## Phase 7: Input System (Unified)

### 7.1 Keyboard + Mouse
- **WASD / Arrow Keys**: Accelerate, brake, steer
- **Mouse**: Optional steering (horizontal mouse movement = steer)
- **Space**: Handbrake
- **Shift**: Boost (if implemented)

### 7.2 Gamepad Controller
- Use the Gamepad API (`navigator.getGamepads()`)
- Left stick: steering
- Right trigger: accelerate
- Left trigger: brake
- Map common layouts (Xbox, PlayStation, generic)

### 7.3 Touch Controls
- **Virtual joystick** (left side): Steering
- **Pedal buttons** (right side): Gas and brake buttons
- Auto-detected: show touch controls only on touch devices
- Styled as semi-transparent overlays
- Use touch events (`touchstart`, `touchmove`, `touchend`)

---

## Phase 8: HUD & UI

### 8.1 HUD Elements (HTML overlay)
- Speedometer (top or dash-integrated)
- Score counter (monsters hit)
- Minimap (small canvas showing road ahead, optional)

### 8.2 Start/Pause Screen
- Simple title screen with "Tap/Click to Start"
- Pause menu on Escape key

---

## Implementation Order (Step by Step)

1. **index.html + style.css + main.js** — Basic Three.js scene, renderer, camera, game loop
2. **road.js** — Procedural infinite road with chunk system, sidewalks, lane markings
3. **vehicle.js** — Arcade car physics moving along the road
4. **input.js** — Unified input (keyboard first, then gamepad, then touch)
5. **cockpit.js** — Placeholder dashboard interior attached to camera
6. **sprites.js** — Y-billboard sprite system with directional angle selection
7. **monsters.js** — Spawn placeholder monsters on road with directional sprites
8. **gore.js** — Particle explosion on monster hit
9. **hud.js** — Score, speed, touch controls UI
10. **Polish** — Fog, lighting, screen shake, sound stubs, start screen

---

## Technical Notes

- **Three.js version**: r158+ (ES module via CDN or bundled)
- **No build tools**: Pure HTML/JS/CSS, open `index.html` directly
- **Performance targets**: 60fps on modern devices, 30fps minimum on mobile
- **All assets are placeholders**: Canvas-generated textures, simple geometry. Designed to be swapped for real sprites/models later
- **Sprite swap system**: Monsters reference a sprite sheet config that maps angle ranges to texture regions, making it easy to drop in real Doom-style sprite sheets later
