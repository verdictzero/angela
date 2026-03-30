/**
 * Debug Maze Road Generator
 *
 * Grid-based maze with:
 *   5-unit wide corridors (floor)
 *   1-unit wide walls (solid blocks, 3 units tall)
 *   Long straight runs, 90-degree corners, T-intersections, random rooms
 *
 * Implements same public API as RoadManager so it can be swapped in.
 */

import * as THREE from 'three';
import { clamp, createCanvasTexture, seededRandom } from './utils.js';

// ── Maze dimensions ────────────────────────────────────────────
const CORRIDOR_WIDTH = 5;       // floor width in world units
const WALL_WIDTH = 1;           // wall thickness in world units
const CELL_SIZE = CORRIDOR_WIDTH + WALL_WIDTH; // 6 units per cell
const WALL_HEIGHT = 3;          // wall block height
const MAZE_COLS = 80;           // grid columns
const MAZE_ROWS = 80;           // grid rows
const MAZE_ORIGIN_X = -(MAZE_COLS * CELL_SIZE) / 2; // center maze on origin
const MAZE_ORIGIN_Z = -(MAZE_ROWS * CELL_SIZE) / 2;

// Chunk = 10x10 cells = 60x60 world units
const CHUNK_CELLS = 10;
const CHUNK_SIZE = CHUNK_CELLS * CELL_SIZE;
const CHUNKS_COLS = Math.ceil(MAZE_COLS / CHUNK_CELLS);
const CHUNKS_ROWS = Math.ceil(MAZE_ROWS / CHUNK_CELLS);
const LOAD_RADIUS = 180;       // load chunks within this distance
const UNLOAD_RADIUS = 240;     // unload chunks beyond this distance
const GROUND_SIZE = 2000;

// Directions: N, E, S, W
const DIR_N = 0, DIR_E = 1, DIR_S = 2, DIR_W = 3;
const DX = [0, 1, 0, -1];
const DZ = [-1, 0, 1, 0];
const OPPOSITE = [DIR_S, DIR_W, DIR_N, DIR_E];

// Wall bits per cell
const WALL_N = 1, WALL_E = 2, WALL_S = 4, WALL_W = 8;
const WALL_BITS = [WALL_N, WALL_E, WALL_S, WALL_W];

export class MazeRoadManager {
    constructor(scene) {
        this.scene = scene;
        this.chunks = [];
        this._builtChunks = new Map(); // "cx,cz" -> { id, group, cx, cz }
        this._nextChunkId = 0;
        this._lastRemovedChunks = [];

        // Maze grid: each cell stores wall bitmask
        this._grid = new Uint8Array(MAZE_COLS * MAZE_ROWS);
        this._grid.fill(WALL_N | WALL_E | WALL_S | WALL_W); // all walls

        // Seed-based RNG for reproducible mazes
        this._rng = seededRandom(42);

        // Generate maze
        this._generateMaze();

        // Textures and materials
        this._textures = this._generateTextures();
        this._floorMat = new THREE.MeshLambertMaterial({ map: this._textures.floor });
        this._wallMat = new THREE.MeshLambertMaterial({ color: 0x666666 });
        this._wallTopMat = new THREE.MeshLambertMaterial({ color: 0x777777 });
        this._groundMat = new THREE.MeshLambertMaterial({ map: this._textures.grass });

        // Ground plane
        this._ground = new THREE.Mesh(
            new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
            this._groundMat
        );
        this._ground.rotation.x = -Math.PI / 2;
        this._ground.position.y = -0.05;
        this._ground.receiveShadow = true;
        this.scene.add(this._ground);

        // Build initial chunks around origin
        this._buildAllNeededChunks(new THREE.Vector3(0, 0, 0));

        // Fake points array for compatibility (just the center of maze)
        this.points = [{
            position: new THREE.Vector3(0, 0, 0),
            forward: new THREE.Vector3(0, 0, -1),
            right: new THREE.Vector3(1, 0, 0),
        }];
        this.totalDistance = 0;
    }

    // ── Maze Generation ────────────────────────────────────────

    _cellIdx(col, row) {
        return row * MAZE_COLS + col;
    }

    _inBounds(col, row) {
        return col >= 0 && col < MAZE_COLS && row >= 0 && row < MAZE_ROWS;
    }

    _removeWall(col, row, dir) {
        const idx = this._cellIdx(col, row);
        this._grid[idx] &= ~WALL_BITS[dir];
        const nc = col + DX[dir];
        const nr = row + DZ[dir];
        if (this._inBounds(nc, nr)) {
            this._grid[this._cellIdx(nc, nr)] &= ~WALL_BITS[OPPOSITE[dir]];
        }
    }

    _hasWall(col, row, dir) {
        if (!this._inBounds(col, row)) return true;
        return (this._grid[this._cellIdx(col, row)] & WALL_BITS[dir]) !== 0;
    }

    _generateMaze() {
        const rng = this._rng;
        const visited = new Uint8Array(MAZE_COLS * MAZE_ROWS);
        const stack = [];

        // Start from center cell
        const startCol = Math.floor(MAZE_COLS / 2);
        const startRow = Math.floor(MAZE_ROWS / 2);
        visited[this._cellIdx(startCol, startRow)] = 1;
        stack.push({ col: startCol, row: startRow, lastDir: -1 });

        while (stack.length > 0) {
            const current = stack[stack.length - 1];
            const { col, row, lastDir } = current;

            // Find unvisited neighbors
            const neighbors = [];
            for (let d = 0; d < 4; d++) {
                const nc = col + DX[d];
                const nr = row + DZ[d];
                if (this._inBounds(nc, nr) && !visited[this._cellIdx(nc, nr)]) {
                    neighbors.push(d);
                }
            }

            if (neighbors.length === 0) {
                stack.pop();
                continue;
            }

            // Bias: 70% chance to continue in same direction for longer runs
            let chosenDir;
            if (lastDir >= 0 && neighbors.includes(lastDir) && rng() < 0.70) {
                chosenDir = lastDir;
            } else {
                // Shuffle and pick random
                chosenDir = neighbors[Math.floor(rng() * neighbors.length)];
            }

            // Carve passage
            this._removeWall(col, row, chosenDir);
            const nc = col + DX[chosenDir];
            const nr = row + DZ[chosenDir];
            visited[this._cellIdx(nc, nr)] = 1;
            stack.push({ col: nc, row: nr, lastDir: chosenDir });
        }

        // Post-process: remove ~15% of remaining walls for loops/T-intersections
        const wallsToRemove = Math.floor(MAZE_COLS * MAZE_ROWS * 0.15);
        for (let i = 0; i < wallsToRemove; i++) {
            const col = Math.floor(rng() * (MAZE_COLS - 2)) + 1;
            const row = Math.floor(rng() * (MAZE_ROWS - 2)) + 1;
            const dir = Math.floor(rng() * 4);
            const nc = col + DX[dir];
            const nr = row + DZ[dir];
            if (this._inBounds(nc, nr)) {
                this._removeWall(col, row, dir);
            }
        }

        // Post-process: carve random rooms (clear rectangular areas)
        const numRooms = 5 + Math.floor(rng() * 6); // 5-10 rooms
        for (let r = 0; r < numRooms; r++) {
            const rw = 2 + Math.floor(rng() * 3); // 2-4 cells wide
            const rh = 2 + Math.floor(rng() * 3); // 2-4 cells tall
            const rc = 2 + Math.floor(rng() * (MAZE_COLS - rw - 4));
            const rr = 2 + Math.floor(rng() * (MAZE_ROWS - rh - 4));

            // Remove all internal walls in the room
            for (let y = rr; y < rr + rh; y++) {
                for (let x = rc; x < rc + rw; x++) {
                    if (x < rc + rw - 1) this._removeWall(x, y, DIR_E);
                    if (y < rr + rh - 1) this._removeWall(x, y, DIR_S);
                }
            }

            // Ensure at least 2 exits from room
            const exits = [
                { col: rc, row: rr, dir: DIR_N },
                { col: rc + rw - 1, row: rr, dir: DIR_E },
                { col: rc, row: rr + rh - 1, dir: DIR_S },
                { col: rc + rw - 1, row: rr + rh - 1, dir: DIR_E },
            ];
            let exitCount = 0;
            for (const e of exits) {
                if (exitCount >= 2) break;
                const nc = e.col + DX[e.dir];
                const nr = e.row + DZ[e.dir];
                if (this._inBounds(nc, nr)) {
                    this._removeWall(e.col, e.row, e.dir);
                    exitCount++;
                }
            }
        }

        // Ensure starting area (center) is clear — 3x3 room
        const cx = startCol, cz = startRow;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const c = cx + dx, r = cz + dy;
                if (!this._inBounds(c, r)) continue;
                if (dx < 1) this._removeWall(c, r, DIR_E);
                if (dy < 1) this._removeWall(c, r, DIR_S);
            }
        }
    }

    // ── Textures ───────────────────────────────────────────────

    _generateTextures() {
        // Floor texture — dark asphalt
        const floorCanvas = createCanvasTexture(128, 128, (ctx, w, h) => {
            ctx.fillStyle = '#2e2e33';
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 2000; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const g = 35 + Math.random() * 25;
                ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
                ctx.fillRect(x, y, 1 + Math.random(), 1 + Math.random());
            }
        });
        const floorTex = new THREE.CanvasTexture(floorCanvas);
        floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
        floorTex.repeat.set(2, 2);

        // Grass texture
        const grassCanvas = createCanvasTexture(128, 128, (ctx, w, h) => {
            ctx.fillStyle = '#3a5a2a';
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 3000; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const g = 40 + Math.random() * 40;
                ctx.fillStyle = `rgb(${Math.floor(g * 0.6)},${Math.floor(g)},${Math.floor(g * 0.4)})`;
                ctx.fillRect(x, y, 1, 2 + Math.random() * 2);
            }
        });
        const grassTex = new THREE.CanvasTexture(grassCanvas);
        grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
        grassTex.repeat.set(300, 300);

        return { floor: floorTex, grass: grassTex };
    }

    // ── Coordinate helpers ─────────────────────────────────────

    // World pos -> grid cell (col, row)
    _worldToCell(x, z) {
        const col = Math.floor((x - MAZE_ORIGIN_X) / CELL_SIZE);
        const row = Math.floor((z - MAZE_ORIGIN_Z) / CELL_SIZE);
        return { col, row };
    }

    // Grid cell -> world center of corridor floor
    _cellToWorld(col, row) {
        return {
            x: MAZE_ORIGIN_X + col * CELL_SIZE + CORRIDOR_WIDTH / 2,
            z: MAZE_ORIGIN_Z + row * CELL_SIZE + CORRIDOR_WIDTH / 2,
        };
    }

    // Check if world position is inside a wall
    _isWall(x, z) {
        const lx = x - MAZE_ORIGIN_X;
        const lz = z - MAZE_ORIGIN_Z;
        if (lx < 0 || lz < 0 || lx >= MAZE_COLS * CELL_SIZE || lz >= MAZE_ROWS * CELL_SIZE) {
            return true; // outside maze bounds
        }

        const col = Math.floor(lx / CELL_SIZE);
        const row = Math.floor(lz / CELL_SIZE);
        const cx = lx - col * CELL_SIZE; // local x within cell [0, CELL_SIZE)
        const cz = lz - row * CELL_SIZE; // local z within cell [0, CELL_SIZE)

        // Cell layout: floor is [0, CORRIDOR_WIDTH) x [0, CORRIDOR_WIDTH)
        // Wall strip on right edge: [CORRIDOR_WIDTH, CELL_SIZE) (east wall column)
        // Wall strip on bottom edge: [0, CELL_SIZE) x [CORRIDOR_WIDTH, CELL_SIZE) (south wall row)
        const inFloorX = cx < CORRIDOR_WIDTH;
        const inFloorZ = cz < CORRIDOR_WIDTH;

        if (inFloorX && inFloorZ) {
            // In the corridor floor area — always passable
            return false;
        }

        if (!inFloorX && inFloorZ) {
            // East wall column — check if wall exists between (col, row) and (col+1, row)
            return this._hasWall(col, row, DIR_E);
        }

        if (inFloorX && !inFloorZ) {
            // South wall row — check if wall exists between (col, row) and (col, row+1)
            return this._hasWall(col, row, DIR_S);
        }

        // Corner (both east and south strip) — wall if either adjacent wall exists
        // This is the small 1x1 corner piece at cell intersections
        // It's a wall unless both the east and south passages are open
        const eastOpen = !this._hasWall(col, row, DIR_E);
        const southOpen = !this._hasWall(col, row, DIR_S);
        // Also check the cell to the east's south wall and cell to the south's east wall
        const nc = col + 1, nr = row + 1;
        const eastSouthOpen = this._inBounds(nc, nr) && !this._hasWall(nc, row, DIR_S);
        const southEastOpen = this._inBounds(nc, nr) && !this._hasWall(col, nr, DIR_E);

        // Corner is open only if it would create a passage (at least 2 adjacent openings)
        const openCount = (eastOpen ? 1 : 0) + (southOpen ? 1 : 0) +
                          (eastSouthOpen ? 1 : 0) + (southEastOpen ? 1 : 0);
        return openCount < 2;
    }

    // ── Chunk Building ─────────────────────────────────────────

    _buildChunkGeometry(chunkCol, chunkRow) {
        const group = new THREE.Group();
        const startCol = chunkCol * CHUNK_CELLS;
        const startRow = chunkRow * CHUNK_CELLS;
        const endCol = Math.min(startCol + CHUNK_CELLS, MAZE_COLS);
        const endRow = Math.min(startRow + CHUNK_CELLS, MAZE_ROWS);

        // ── Floor plane for entire chunk ──
        const floorWidth = (endCol - startCol) * CELL_SIZE;
        const floorDepth = (endRow - startRow) * CELL_SIZE;
        const floorGeo = new THREE.PlaneGeometry(floorWidth, floorDepth);
        const floorMesh = new THREE.Mesh(floorGeo, this._floorMat);
        floorMesh.rotation.x = -Math.PI / 2;
        floorMesh.position.set(
            MAZE_ORIGIN_X + startCol * CELL_SIZE + floorWidth / 2,
            0,
            MAZE_ORIGIN_Z + startRow * CELL_SIZE + floorDepth / 2
        );
        floorMesh.receiveShadow = true;
        group.add(floorMesh);

        // ── Walls — merge into single geometry per chunk ──
        const wallBoxes = [];

        for (let row = startRow; row < endRow; row++) {
            for (let col = startCol; col < endCol; col++) {
                const wx = MAZE_ORIGIN_X + col * CELL_SIZE;
                const wz = MAZE_ORIGIN_Z + row * CELL_SIZE;

                // East wall (vertical strip on right edge of cell)
                if (this._hasWall(col, row, DIR_E)) {
                    wallBoxes.push({
                        x: wx + CORRIDOR_WIDTH + WALL_WIDTH / 2,
                        z: wz + CORRIDOR_WIDTH / 2,
                        w: WALL_WIDTH,
                        d: CORRIDOR_WIDTH,
                    });
                }

                // South wall (horizontal strip on bottom edge of cell)
                if (this._hasWall(col, row, DIR_S)) {
                    wallBoxes.push({
                        x: wx + CORRIDOR_WIDTH / 2,
                        z: wz + CORRIDOR_WIDTH + WALL_WIDTH / 2,
                        w: CORRIDOR_WIDTH,
                        d: WALL_WIDTH,
                    });
                }

                // Corner pillar — the 1x1 block at (CORRIDOR_WIDTH, CORRIDOR_WIDTH)
                // Always place corner pillars where walls meet
                const eastWall = this._hasWall(col, row, DIR_E);
                const southWall = this._hasWall(col, row, DIR_S);
                const nc = col + 1, nr = row + 1;
                const eastSouth = this._inBounds(nc, row) && this._hasWall(nc, row, DIR_S);
                const southEast = this._inBounds(col, nr) && this._hasWall(col, nr, DIR_E);
                const openCount = (eastWall ? 0 : 1) + (southWall ? 0 : 1) +
                                  (eastSouth ? 0 : 1) + (southEast ? 0 : 1);
                // Place pillar unless surrounded by open passages
                if (openCount < 4) {
                    wallBoxes.push({
                        x: wx + CORRIDOR_WIDTH + WALL_WIDTH / 2,
                        z: wz + CORRIDOR_WIDTH + WALL_WIDTH / 2,
                        w: WALL_WIDTH,
                        d: WALL_WIDTH,
                    });
                }
            }
        }

        // Merge wall boxes into single geometry
        if (wallBoxes.length > 0) {
            const merged = this._mergeWallBoxes(wallBoxes);
            const wallMesh = new THREE.Mesh(merged, this._wallMat);
            wallMesh.castShadow = true;
            wallMesh.receiveShadow = true;
            group.add(wallMesh);
        }

        return group;
    }

    _mergeWallBoxes(boxes) {
        const verticesPerBox = 24; // 6 faces * 4 verts
        const indicesPerBox = 36;  // 6 faces * 2 tris * 3
        const totalVerts = boxes.length * verticesPerBox;
        const totalIndices = boxes.length * indicesPerBox;

        const positions = new Float32Array(totalVerts * 3);
        const normals = new Float32Array(totalVerts * 3);
        const indices = new Uint32Array(totalIndices);

        let vi = 0, ni = 0, ii = 0, baseVertex = 0;

        for (const box of boxes) {
            const hw = box.w / 2;
            const hd = box.d / 2;
            const hh = WALL_HEIGHT / 2;
            const cx = box.x;
            const cy = WALL_HEIGHT / 2;
            const cz = box.z;

            // 6 faces of the box
            const faces = [
                // front (z+)
                { n: [0, 0, 1], verts: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]] },
                // back (z-)
                { n: [0, 0, -1], verts: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]] },
                // right (x+)
                { n: [1, 0, 0], verts: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]] },
                // left (x-)
                { n: [-1, 0, 0], verts: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]] },
                // top (y+)
                { n: [0, 1, 0], verts: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]] },
                // bottom (y-)
                { n: [0, -1, 0], verts: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]] },
            ];

            for (const face of faces) {
                for (const v of face.verts) {
                    positions[vi++] = cx + v[0];
                    positions[vi++] = cy + v[1];
                    positions[vi++] = cz + v[2];
                    normals[ni++] = face.n[0];
                    normals[ni++] = face.n[1];
                    normals[ni++] = face.n[2];
                }
                // Two triangles per face
                indices[ii++] = baseVertex;
                indices[ii++] = baseVertex + 1;
                indices[ii++] = baseVertex + 2;
                indices[ii++] = baseVertex;
                indices[ii++] = baseVertex + 2;
                indices[ii++] = baseVertex + 3;
                baseVertex += 4;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        return geo;
    }

    // ── Chunk Management ───────────────────────────────────────

    _chunkKey(cx, cz) { return `${cx},${cz}`; }

    _buildAllNeededChunks(playerPos) {
        for (let cz = 0; cz < CHUNKS_ROWS; cz++) {
            for (let cx = 0; cx < CHUNKS_COLS; cx++) {
                const key = this._chunkKey(cx, cz);
                if (this._builtChunks.has(key)) continue;

                const centerX = MAZE_ORIGIN_X + (cx + 0.5) * CHUNK_SIZE;
                const centerZ = MAZE_ORIGIN_Z + (cz + 0.5) * CHUNK_SIZE;
                const dx = playerPos.x - centerX;
                const dz = playerPos.z - centerZ;
                const dist = Math.sqrt(dx * dx + dz * dz);

                if (dist < LOAD_RADIUS) {
                    const group = this._buildChunkGeometry(cx, cz);
                    this.scene.add(group);
                    const chunk = {
                        id: this._nextChunkId++,
                        group, cx, cz,
                        startIdx: (cz * CHUNKS_COLS + cx) * CHUNK_CELLS,
                        endIdx: (cz * CHUNKS_COLS + cx) * CHUNK_CELLS + CHUNK_CELLS,
                        startDist: 0,
                    };
                    this._builtChunks.set(key, chunk);
                    this.chunks.push(chunk);
                }
            }
        }
    }

    _removeDistantChunks(playerPos) {
        this._lastRemovedChunks = [];
        for (const [key, chunk] of this._builtChunks.entries()) {
            const centerX = MAZE_ORIGIN_X + (chunk.cx + 0.5) * CHUNK_SIZE;
            const centerZ = MAZE_ORIGIN_Z + (chunk.cz + 0.5) * CHUNK_SIZE;
            const dx = playerPos.x - centerX;
            const dz = playerPos.z - centerZ;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist > UNLOAD_RADIUS) {
                this._lastRemovedChunks.push(chunk.id);
                this.scene.remove(chunk.group);
                chunk.group.traverse((child) => {
                    if (child.geometry) child.geometry.dispose();
                });
                this._builtChunks.delete(key);
                const idx = this.chunks.indexOf(chunk);
                if (idx >= 0) this.chunks.splice(idx, 1);
            }
        }
    }

    // ── Wall Collision ─────────────────────────────────────────

    /**
     * Check if a circle (vehicle) at pos with given radius overlaps any wall.
     * Returns push-back vector to resolve collision, or null if no collision.
     */
    getWallCollision(pos, radius) {
        const pushX = this._getAxisPush(pos.x, pos.z, radius, 'x');
        const pushZ = this._getAxisPush(pos.x, pos.z, radius, 'z');

        if (pushX === 0 && pushZ === 0) return null;
        return new THREE.Vector3(pushX, 0, pushZ);
    }

    _getAxisPush(x, z, radius, axis) {
        // Sample points around the vehicle to detect wall overlap
        const samples = axis === 'x'
            ? [[x + radius, z], [x - radius, z]]
            : [[x, z + radius], [x, z - radius]];

        for (const [sx, sz] of samples) {
            if (this._isWall(sx, sz)) {
                // Find the wall edge and push back
                const lx = sx - MAZE_ORIGIN_X;
                const lz = sz - MAZE_ORIGIN_Z;
                const col = Math.floor(lx / CELL_SIZE);
                const row = Math.floor(lz / CELL_SIZE);
                const cx = lx - col * CELL_SIZE;
                const cz = lz - row * CELL_SIZE;

                if (axis === 'x') {
                    if (cx >= CORRIDOR_WIDTH) {
                        // Hit east wall — push left
                        const wallEdge = MAZE_ORIGIN_X + col * CELL_SIZE + CORRIDOR_WIDTH;
                        return (wallEdge - radius) - x + 0.01;
                    } else {
                        // Coming from the right side (west wall of next cell)
                        const wallEdge = MAZE_ORIGIN_X + col * CELL_SIZE + CELL_SIZE;
                        return (wallEdge + radius) - x - 0.01;
                    }
                } else {
                    if (cz >= CORRIDOR_WIDTH) {
                        const wallEdge = MAZE_ORIGIN_Z + row * CELL_SIZE + CORRIDOR_WIDTH;
                        return (wallEdge - radius) - z + 0.01;
                    } else {
                        const wallEdge = MAZE_ORIGIN_Z + row * CELL_SIZE + CELL_SIZE;
                        return (wallEdge + radius) - z - 0.01;
                    }
                }
            }
        }
        return 0;
    }

    // ── Public API (RoadManager compatibility) ─────────────────

    getRoadInfoAt(pos) {
        const isWall = this._isWall(pos.x, pos.z);
        const { col, row } = this._worldToCell(pos.x, pos.z);
        const center = this._cellToWorld(
            clamp(col, 0, MAZE_COLS - 1),
            clamp(row, 0, MAZE_ROWS - 1)
        );

        const fwd = new THREE.Vector3(0, 0, -1);
        const right = new THREE.Vector3(1, 0, 0);
        const pt = {
            position: new THREE.Vector3(center.x, 0, center.z),
            forward: fwd,
            right: right,
        };

        return {
            index: row * MAZE_COLS + col,
            point: pt,
            lateralOffset: pos.x - center.x,
            onRoad: !isWall,
            onShoulder: false,
            onSidewalk: false,
            offRoad: isWall,
        };
    }

    getNewChunks(lastId) {
        return this.chunks.filter(c => c.id > lastId);
    }

    getChunkAt(pos) {
        const cx = Math.floor((pos.x - MAZE_ORIGIN_X) / CHUNK_SIZE);
        const cz = Math.floor((pos.z - MAZE_ORIGIN_Z) / CHUNK_SIZE);
        const key = this._chunkKey(cx, cz);
        return this._builtChunks.get(key) || (this.chunks.length > 0 ? this.chunks[0] : null);
    }

    getSpawnPositions(chunkIndex) {
        if (chunkIndex >= this.chunks.length) return [];
        const chunk = this.chunks[chunkIndex];
        const positions = [];
        const startCol = chunk.cx * CHUNK_CELLS;
        const startRow = chunk.cz * CHUNK_CELLS;
        const endCol = Math.min(startCol + CHUNK_CELLS, MAZE_COLS);
        const endRow = Math.min(startRow + CHUNK_CELLS, MAZE_ROWS);

        // Place spawn points in corridor centers, every few cells
        for (let row = startRow; row < endRow; row += 3) {
            for (let col = startCol; col < endCol; col += 3) {
                const center = this._cellToWorld(col, row);
                positions.push({
                    position: new THREE.Vector3(center.x, 0, center.z),
                    forward: new THREE.Vector3(0, 0, -1),
                    lateralOffset: 0,
                    roadIndex: row * MAZE_COLS + col,
                    type: 'road',
                });
            }
        }
        return positions;
    }

    getPointAt(index) {
        const col = index % MAZE_COLS;
        const row = Math.floor(index / MAZE_COLS);
        const center = this._cellToWorld(col, row);
        return {
            position: new THREE.Vector3(center.x, 0, center.z),
            forward: new THREE.Vector3(0, 0, -1),
            right: new THREE.Vector3(1, 0, 0),
        };
    }

    update(playerPos) {
        // Move ground with player
        this._ground.position.x = playerPos.x;
        this._ground.position.z = playerPos.z;

        const rep = this._textures.grass.repeat;
        this._textures.grass.offset.x = playerPos.x * rep.x / GROUND_SIZE;
        this._textures.grass.offset.y = -playerPos.z * rep.y / GROUND_SIZE;

        this._buildAllNeededChunks(playerPos);
        this._removeDistantChunks(playerPos);
    }

    get chunkCount() {
        return this.chunks.length;
    }

    get removedChunkIds() {
        return this._lastRemovedChunks;
    }
}
