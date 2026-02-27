/**
 * Infinite Procedural Road Generator
 *
 * Generates road segments as chunks along a smooth spline path.
 * Each chunk includes textured road surface, sidewalks, curbs,
 * lane markings, telephone poles, street lights, buildings, and
 * occasional intersections.
 */

import * as THREE from 'three';
import { randomRange, randomInt, clamp, createCanvasTexture } from './utils.js';

// Road dimensions
const ROAD_HALF_WIDTH = 6;
const CURB_WIDTH = 0.3;
const CURB_HEIGHT = 0.15;
const SIDEWALK_WIDTH = 3.5;
const POINT_SPACING = 4;
const POINTS_PER_CHUNK = 40;
const GENERATE_AHEAD = 500;
const REMOVE_BEHIND = 200;
const DASH_LENGTH = 3;
const DASH_GAP = 4;

// Props
const POLE_INTERVAL = 10;          // every N road points
const BUILDING_INTERVAL = 6;       // every N road points
const BUILDING_SETBACK = 11;       // distance from road center
const INTERSECTION_INTERVAL = 5;   // every N chunks
const STREETLIGHT_INTERVAL = 8;    // every N road points

export class RoadManager {
    constructor(scene) {
        this.scene = scene;
        this.points = [];
        this.chunks = [];
        this.currentAngle = 0;
        this.currentCurvature = 0;
        this.targetCurvature = 0;
        this.totalDistance = 0;
        this.chunkCounter = 0;

        // Street lights (tracked for day/night intensity control)
        this.streetLights = [];

        // Generate textures
        this._textures = this._generateTextures();

        // Materials
        this._roadMat = new THREE.MeshLambertMaterial({ map: this._textures.road });
        this._sidewalkMat = new THREE.MeshLambertMaterial({ map: this._textures.sidewalk });
        this._curbMat = new THREE.MeshLambertMaterial({ color: 0x555558 });
        this._markingMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
        this._edgeMarkingMat = new THREE.MeshBasicMaterial({ color: 0xcccc44 });
        this._crosswalkMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });

        // Prop materials
        this._poleMat = new THREE.MeshLambertMaterial({ color: 0x5a4030 });
        this._metalMat = new THREE.MeshLambertMaterial({ color: 0x666666 });
        this._concreteMat = new THREE.MeshLambertMaterial({ color: 0x888888 });

        // Shared prop geometries
        this._poleGeo = new THREE.CylinderGeometry(0.1, 0.13, 8, 6);
        this._crossbarGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4);
        this._wireGeo = new THREE.CylinderGeometry(0.01, 0.01, 1, 3);
        this._lampGeo = new THREE.CylinderGeometry(0.06, 0.12, 0.3, 6);
        this._lampArmGeo = new THREE.BoxGeometry(0.06, 0.06, 1.5);

        // Building colors
        this._buildingColors = [
            0x8a7a6a, 0x6a6a7a, 0x7a6a5a, 0x5a5a6a,
            0x888078, 0x706860, 0x907860, 0x606870,
            0x786050, 0x585868, 0x9a8a7a, 0x686058
        ];

        // Ground plane with grass texture
        this._groundMat = new THREE.MeshLambertMaterial({ map: this._textures.grass });
        this._ground = new THREE.Mesh(
            new THREE.PlaneGeometry(2000, 2000),
            this._groundMat
        );
        this._ground.rotation.x = -Math.PI / 2;
        this._ground.position.y = -0.02;
        this._ground.receiveShadow = true;
        this.scene.add(this._ground);

        // Generate initial road
        this._generatePoints(POINTS_PER_CHUNK * 5);
        this._buildAllNeededChunks(new THREE.Vector3(0, 0, 0));
    }

    // ── Texture Generation ─────────────────────────────────────

    _generateTextures() {
        // Asphalt road
        const road = this._makeTexture(256, 256, (ctx, w, h) => {
            ctx.fillStyle = '#333338';
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 4000; i++) {
                const x = Math.random() * w;
                const y = Math.random() * h;
                const g = 38 + Math.random() * 28;
                ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
                ctx.fillRect(x, y, 1 + Math.random(), 1 + Math.random());
            }
            // Occasional crack
            ctx.strokeStyle = '#28282d';
            ctx.lineWidth = 0.5;
            for (let i = 0; i < 3; i++) {
                ctx.beginPath();
                let cx = Math.random() * w, cy = Math.random() * h;
                ctx.moveTo(cx, cy);
                for (let j = 0; j < 5; j++) {
                    cx += (Math.random() - 0.5) * 40;
                    cy += (Math.random() - 0.5) * 40;
                    ctx.lineTo(cx, cy);
                }
                ctx.stroke();
            }
        }, 4, 4);

        // Concrete sidewalk
        const sidewalk = this._makeTexture(128, 128, (ctx, w, h) => {
            ctx.fillStyle = '#808080';
            ctx.fillRect(0, 0, w, h);
            // Panel grid
            ctx.strokeStyle = '#707070';
            ctx.lineWidth = 1.5;
            for (let x = 0; x <= w; x += 32) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            }
            for (let y = 0; y <= h; y += 32) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
            }
            // Noise
            for (let i = 0; i < 1500; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const g = 110 + Math.random() * 40;
                ctx.fillStyle = `rgb(${g},${g},${g})`;
                ctx.fillRect(x, y, 1, 1);
            }
        }, 2, 2);

        // Grass ground
        const grass = this._makeTexture(256, 256, (ctx, w, h) => {
            ctx.fillStyle = '#2a4a1a';
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 8000; i++) {
                const x = Math.random() * w, y = Math.random() * h;
                const r = 25 + Math.random() * 30;
                const g = r + 25 + Math.random() * 25;
                const b = 10 + Math.random() * 15;
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 3);
            }
            // Dark patches
            for (let i = 0; i < 8; i++) {
                ctx.fillStyle = `rgba(15,30,10,${0.15 + Math.random() * 0.15})`;
                ctx.beginPath();
                ctx.arc(Math.random() * w, Math.random() * h, 10 + Math.random() * 20, 0, Math.PI * 2);
                ctx.fill();
            }
        }, 150, 150);

        return { road, sidewalk, grass };
    }

    _makeTexture(w, h, drawFn, repeatX, repeatY) {
        const canvas = createCanvasTexture(w, h, drawFn);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
    }

    // ── Road Point Generation ──────────────────────────────────

    _generatePoints(count) {
        for (let i = 0; i < count; i++) {
            let pos;
            if (this.points.length === 0) {
                pos = new THREE.Vector3(0, 0, 0);
            } else {
                const last = this.points[this.points.length - 1].position;
                this.targetCurvature += (Math.random() - 0.5) * 0.06;
                this.targetCurvature = clamp(this.targetCurvature, -0.04, 0.04);
                this.currentCurvature += (this.targetCurvature - this.currentCurvature) * 0.08;
                this.currentAngle += this.currentCurvature;

                pos = new THREE.Vector3(
                    last.x + Math.sin(this.currentAngle) * POINT_SPACING,
                    0,
                    last.z - Math.cos(this.currentAngle) * POINT_SPACING
                );
            }

            const forward = new THREE.Vector3(
                Math.sin(this.currentAngle), 0, -Math.cos(this.currentAngle)
            ).normalize();
            const right = new THREE.Vector3(
                Math.cos(this.currentAngle), 0, Math.sin(this.currentAngle)
            ).normalize();

            this.points.push({ position: pos.clone(), forward: forward.clone(), right: right.clone() });
            this.totalDistance += POINT_SPACING;
        }
    }

    // ── Chunk Building ─────────────────────────────────────────

    _buildChunk(startIdx, endIdx) {
        const group = new THREE.Group();
        const count = endIdx - startIdx;
        if (count < 2) return null;

        this.chunkCounter++;
        const isIntersection = (this.chunkCounter % INTERSECTION_INTERVAL === 0);

        // Road surface
        const roadGeo = this._buildStripGeometry(startIdx, endIdx, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0, 0, 12);
        const roadMesh = new THREE.Mesh(roadGeo, this._roadMat);
        roadMesh.receiveShadow = true;
        group.add(roadMesh);

        // Sidewalks
        const lswOuter = -(ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH);
        const lswInner = -(ROAD_HALF_WIDTH + CURB_WIDTH);
        const lswGeo = this._buildStripGeometry(startIdx, endIdx, lswOuter, lswInner, CURB_HEIGHT, CURB_HEIGHT, 3.5);
        group.add(new THREE.Mesh(lswGeo, this._sidewalkMat));

        const rswInner = ROAD_HALF_WIDTH + CURB_WIDTH;
        const rswOuter = ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH;
        const rswGeo = this._buildStripGeometry(startIdx, endIdx, rswInner, rswOuter, CURB_HEIGHT, CURB_HEIGHT, 3.5);
        group.add(new THREE.Mesh(rswGeo, this._sidewalkMat));

        // Curbs
        const lcGeo = this._buildStripGeometry(startIdx, endIdx, -ROAD_HALF_WIDTH - CURB_WIDTH, -ROAD_HALF_WIDTH, 0, CURB_HEIGHT, 0.3);
        group.add(new THREE.Mesh(lcGeo, this._curbMat));
        const rcGeo = this._buildStripGeometry(startIdx, endIdx, ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + CURB_WIDTH, CURB_HEIGHT, 0, 0.3);
        group.add(new THREE.Mesh(rcGeo, this._curbMat));

        // Lane markings
        this._addDashedLine(group, startIdx, endIdx, 0, 0.02, 0.15);
        this._addSolidLine(group, startIdx, endIdx, -ROAD_HALF_WIDTH + 0.3, 0.02, 0.1, this._edgeMarkingMat);
        this._addSolidLine(group, startIdx, endIdx, ROAD_HALF_WIDTH - 0.3, 0.02, 0.1, this._edgeMarkingMat);

        // Telephone poles
        this._addTelephonePoles(group, startIdx, endIdx, isIntersection);

        // Street lights
        this._addStreetLights(group, startIdx, endIdx, isIntersection);

        // Buildings
        this._addBuildings(group, startIdx, endIdx, isIntersection);

        // Intersection
        if (isIntersection) {
            const midIdx = startIdx + Math.floor(count / 2);
            this._buildIntersection(group, midIdx);
        }

        const chunk = { group, startIdx, endIdx, startDist: startIdx * POINT_SPACING };
        this.scene.add(group);
        this.chunks.push(chunk);
        return chunk;
    }

    // ── Strip Geometry with UVs ────────────────────────────────

    _buildStripGeometry(startIdx, endIdx, leftOffset, rightOffset, leftY, rightY, texWidth) {
        const count = endIdx - startIdx;
        const vertices = new Float32Array(count * 2 * 3);
        const normals = new Float32Array(count * 2 * 3);
        const uvs = new Float32Array(count * 2 * 2);
        const indices = [];

        for (let i = 0; i < count; i++) {
            const pt = this.points[startIdx + i];
            const p = pt.position;
            const r = pt.right;
            const vi = i * 6;
            const ui = i * 4;

            // Left vertex
            vertices[vi] = p.x + r.x * leftOffset;
            vertices[vi + 1] = leftY;
            vertices[vi + 2] = p.z + r.z * leftOffset;
            // Right vertex
            vertices[vi + 3] = p.x + r.x * rightOffset;
            vertices[vi + 4] = rightY;
            vertices[vi + 5] = p.z + r.z * rightOffset;

            // Normals
            normals[vi] = 0; normals[vi + 1] = 1; normals[vi + 2] = 0;
            normals[vi + 3] = 0; normals[vi + 4] = 1; normals[vi + 5] = 0;

            // UVs (tile based on distance along road)
            const v = (i * POINT_SPACING) / (texWidth || 1);
            uvs[ui] = 0;
            uvs[ui + 1] = v;
            uvs[ui + 2] = 1;
            uvs[ui + 3] = v;

            if (i < count - 1) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                indices.push(bl, tl, br, br, tl, tr);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        return geo;
    }

    // ── Telephone Poles ────────────────────────────────────────

    _addTelephonePoles(group, startIdx, endIdx, skipNearCenter) {
        const midIdx = startIdx + Math.floor((endIdx - startIdx) / 2);

        for (let i = startIdx + 2; i < endIdx - 2; i += POLE_INTERVAL) {
            // Skip near intersection center
            if (skipNearCenter && Math.abs(i - midIdx) < 8) continue;

            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;

            // Place on right sidewalk edge
            const lateral = ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH - 0.3;
            const px = p.x + r.x * lateral;
            const pz = p.z + r.z * lateral;

            // Pole
            const pole = new THREE.Mesh(this._poleGeo, this._poleMat);
            pole.position.set(px, 4, pz);
            group.add(pole);

            // Crossbar
            const crossbar = new THREE.Mesh(this._crossbarGeo, this._metalMat);
            crossbar.position.set(px, 7.8, pz);
            crossbar.rotation.z = Math.PI / 2;
            // Align crossbar perpendicular to road
            crossbar.rotation.y = Math.atan2(r.x, r.z);
            group.add(crossbar);

            // Insulators (small bumps on crossbar)
            for (const side of [-0.7, -0.3, 0.3, 0.7]) {
                const ins = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.03, 0.03, 0.15, 4),
                    this._concreteMat
                );
                ins.position.set(
                    px + r.x * side * 0.3,
                    8.0,
                    pz + r.z * side * 0.3
                );
                group.add(ins);
            }
        }
    }

    // ── Street Lights ──────────────────────────────────────────

    _addStreetLights(group, startIdx, endIdx, skipNearCenter) {
        const midIdx = startIdx + Math.floor((endIdx - startIdx) / 2);

        for (let i = startIdx + 4; i < endIdx - 4; i += STREETLIGHT_INTERVAL) {
            if (skipNearCenter && Math.abs(i - midIdx) < 8) continue;

            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;

            // Alternate sides
            const side = (Math.floor(i / STREETLIGHT_INTERVAL) % 2 === 0) ? -1 : 1;
            const lateral = side * (ROAD_HALF_WIDTH + CURB_WIDTH + 0.5);
            const lx = p.x + r.x * lateral;
            const lz = p.z + r.z * lateral;

            // Lamp post
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.08, 5, 6),
                this._metalMat
            );
            post.position.set(lx, 2.5, lz);
            group.add(post);

            // Arm extending over road
            const arm = new THREE.Mesh(this._lampArmGeo, this._metalMat);
            const armDir = -side; // arm points toward road
            arm.position.set(
                lx + r.x * armDir * 0.75,
                4.9,
                lz + r.z * armDir * 0.75
            );
            arm.rotation.y = Math.atan2(r.x, r.z);
            group.add(arm);

            // Lamp head
            const lamp = new THREE.Mesh(this._lampGeo, new THREE.MeshBasicMaterial({ color: 0xffeecc }));
            const lampX = lx + r.x * armDir * 1.5;
            const lampZ = lz + r.z * armDir * 1.5;
            lamp.position.set(lampX, 4.8, lampZ);
            group.add(lamp);

            // Point light
            const light = new THREE.PointLight(0xffddaa, 0.8, 25, 1.5);
            light.position.set(lampX, 4.7, lampZ);
            group.add(light);
            this.streetLights.push(light);
        }
    }

    // ── Buildings ──────────────────────────────────────────────

    _addBuildings(group, startIdx, endIdx, skipNearCenter) {
        const midIdx = startIdx + Math.floor((endIdx - startIdx) / 2);

        for (let i = startIdx + 1; i < endIdx - 1; i += BUILDING_INTERVAL) {
            if (skipNearCenter && Math.abs(i - midIdx) < 12) continue;

            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;
            const f = pt.forward;

            for (const side of [-1, 1]) {
                if (Math.random() > 0.7) continue; // not every slot gets a building

                const w = randomRange(5, 14);
                const h = randomRange(4, 18);
                const d = randomRange(5, 12);
                const setback = BUILDING_SETBACK + d / 2 + randomRange(0, 3);
                const lateral = side * setback;
                const along = randomRange(-2, 2);

                const bx = p.x + r.x * lateral + f.x * along;
                const bz = p.z + r.z * lateral + f.z * along;

                const colorIdx = Math.floor(Math.random() * this._buildingColors.length);
                const buildingMat = new THREE.MeshLambertMaterial({ color: this._buildingColors[colorIdx] });
                const geo = new THREE.BoxGeometry(w, h, d);
                const building = new THREE.Mesh(geo, buildingMat);
                building.position.set(bx, h / 2, bz);
                building.rotation.y = Math.atan2(f.x, f.z) + randomRange(-0.1, 0.1);
                group.add(building);

                // Windows (dark rectangles on the face toward the road)
                this._addBuildingWindows(group, building, w, h, d, bx, bz, r, side);
            }
        }
    }

    _addBuildingWindows(group, building, w, h, d, bx, bz, roadRight, side) {
        const windowMat = new THREE.MeshBasicMaterial({ color: 0x223344 });
        const litWindowMat = new THREE.MeshBasicMaterial({ color: 0xffeeaa });
        const windowGeo = new THREE.PlaneGeometry(0.8, 1.0);

        const faceDist = d / 2 + 0.01;
        const cols = Math.floor(w / 2.5);
        const rows = Math.floor(h / 3);

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                if (Math.random() > 0.8) continue;

                const wx = (col - (cols - 1) / 2) * 2.2;
                const wy = 1.5 + row * 2.8;
                const isLit = Math.random() > 0.6;

                const win = new THREE.Mesh(windowGeo, isLit ? litWindowMat : windowMat);
                // Position on the face toward the road
                const faceDir = -side;
                win.position.set(
                    bx + roadRight.x * faceDir * faceDist + roadRight.z * wx,
                    wy,
                    bz + roadRight.z * faceDir * faceDist - roadRight.x * wx
                );
                win.rotation.y = Math.atan2(roadRight.x * faceDir, roadRight.z * faceDir);
                group.add(win);
            }
        }
    }

    // ── Intersections ──────────────────────────────────────────

    _buildIntersection(group, pointIdx) {
        const pt = this.points[clamp(pointIdx, 0, this.points.length - 1)];
        const p = pt.position;
        const r = pt.right;
        const f = pt.forward;

        // Cross-street surface (perpendicular road)
        const crossLength = 25;
        const crossWidth = 8;
        const segments = 12;
        const verts = [];
        const uvs = [];
        const indices = [];

        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * 2 - 1;
            const dist = t * crossLength;
            // Left/right along cross-street (which is the main road's right direction)
            const lx = p.x + r.x * dist - f.x * crossWidth / 2;
            const lz = p.z + r.z * dist - f.z * crossWidth / 2;
            const rx = p.x + r.x * dist + f.x * crossWidth / 2;
            const rz = p.z + r.z * dist + f.z * crossWidth / 2;

            verts.push(lx, 0.005, lz, rx, 0.005, rz);
            uvs.push(0, dist / 8, 1, dist / 8);

            if (i < segments) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                indices.push(bl, tl, br, br, tl, tr);
            }
        }

        const crossGeo = new THREE.BufferGeometry();
        crossGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        crossGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        crossGeo.setIndex(indices);
        crossGeo.computeVertexNormals();
        group.add(new THREE.Mesh(crossGeo, this._roadMat));

        // Cross-street sidewalks (both sides of the cross-street)
        for (const cside of [-1, 1]) {
            const swVerts = [];
            const swUvs = [];
            const swIndices = [];
            const swWidth = 3;
            const swOffset = crossWidth / 2 + CURB_WIDTH;

            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * 2 - 1;
                const dist = t * crossLength;

                const baseX = p.x + r.x * dist;
                const baseZ = p.z + r.z * dist;
                const innerDist = cside * swOffset;
                const outerDist = cside * (swOffset + swWidth);

                const lx = baseX + f.x * innerDist;
                const lz = baseZ + f.z * innerDist;
                const rx = baseX + f.x * outerDist;
                const rz = baseZ + f.z * outerDist;

                swVerts.push(lx, CURB_HEIGHT, lz, rx, CURB_HEIGHT, rz);
                swUvs.push(0, dist / 3, 1, dist / 3);

                if (i < segments) {
                    const bl = i * 2, br = i * 2 + 1;
                    const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                    swIndices.push(bl, tl, br, br, tl, tr);
                }
            }

            const swGeo = new THREE.BufferGeometry();
            swGeo.setAttribute('position', new THREE.Float32BufferAttribute(swVerts, 3));
            swGeo.setAttribute('uv', new THREE.Float32BufferAttribute(swUvs, 2));
            swGeo.setIndex(swIndices);
            swGeo.computeVertexNormals();
            group.add(new THREE.Mesh(swGeo, this._sidewalkMat));
        }

        // Crosswalk markings (zebra stripes across main road at intersection)
        for (const cwSide of [-1, 1]) {
            const cwDist = cwSide * (crossWidth / 2 + 1);
            for (let s = -ROAD_HALF_WIDTH + 1; s < ROAD_HALF_WIDTH - 1; s += 1.5) {
                const sx = p.x + f.x * cwDist + r.x * s;
                const sz = p.z + f.z * cwDist + r.z * s;

                const stripe = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.6, 3),
                    this._crosswalkMat
                );
                stripe.rotation.x = -Math.PI / 2;
                stripe.rotation.z = Math.atan2(f.x, f.z);
                stripe.position.set(sx, 0.03, sz);
                group.add(stripe);
            }
        }

        // Traffic light posts at intersection corners
        this._addTrafficLight(group, p, r, f, -1, 1);
        this._addTrafficLight(group, p, r, f, 1, -1);
    }

    _addTrafficLight(group, center, right, forward, rSide, fSide) {
        const x = center.x + right.x * rSide * (ROAD_HALF_WIDTH + 1) + forward.x * fSide * 5;
        const z = center.z + right.z * rSide * (ROAD_HALF_WIDTH + 1) + forward.z * fSide * 5;

        // Post
        const post = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.08, 4.5, 6),
            this._metalMat
        );
        post.position.set(x, 2.25, z);
        group.add(post);

        // Light housing
        const housing = new THREE.Mesh(
            new THREE.BoxGeometry(0.4, 1.0, 0.3),
            new THREE.MeshLambertMaterial({ color: 0x222222 })
        );
        housing.position.set(x, 4.8, z);
        group.add(housing);

        // Red, yellow, green lights
        const colors = [0xff0000, 0xffaa00, 0x00ff00];
        for (let i = 0; i < 3; i++) {
            const bulb = new THREE.Mesh(
                new THREE.SphereGeometry(0.07, 6, 6),
                new THREE.MeshBasicMaterial({ color: colors[i] })
            );
            bulb.position.set(x, 5.1 - i * 0.3, z + 0.16);
            group.add(bulb);
        }
    }

    // ── Lane Markings ──────────────────────────────────────────

    _addDashedLine(group, startIdx, endIdx, lateralOffset, yOffset, halfWidth) {
        let accumDist = 0;
        let dashVerts = [];
        let dashIndices = [];
        let vCount = 0;

        for (let i = startIdx; i < endIdx; i++) {
            const pt = this.points[i];
            const p = pt.position;
            const r = pt.right;

            if (i > startIdx) accumDist += POINT_SPACING;
            const cycle = accumDist % (DASH_LENGTH + DASH_GAP);
            const shouldDraw = cycle < DASH_LENGTH;

            if (shouldDraw) {
                const lx = p.x + r.x * (lateralOffset - halfWidth);
                const lz = p.z + r.z * (lateralOffset - halfWidth);
                const rx = p.x + r.x * (lateralOffset + halfWidth);
                const rz = p.z + r.z * (lateralOffset + halfWidth);

                dashVerts.push(lx, yOffset, lz, rx, yOffset, rz);
                if (vCount >= 2) {
                    const bl = vCount - 2, br = vCount - 1;
                    const tl = vCount, tr = vCount + 1;
                    dashIndices.push(bl, tl, br, br, tl, tr);
                }
                vCount += 2;
            } else {
                vCount = 0;
            }
        }

        if (dashVerts.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(dashVerts, 3));
            geo.setIndex(dashIndices);
            geo.computeVertexNormals();
            group.add(new THREE.Mesh(geo, this._markingMat));
        }
    }

    _addSolidLine(group, startIdx, endIdx, lateralOffset, yOffset, halfWidth, material) {
        const count = endIdx - startIdx;
        if (count < 2) return;
        const verts = new Float32Array(count * 2 * 3);
        const indices = [];

        for (let i = 0; i < count; i++) {
            const pt = this.points[startIdx + i];
            const p = pt.position;
            const r = pt.right;
            const vi = i * 6;
            verts[vi] = p.x + r.x * (lateralOffset - halfWidth);
            verts[vi + 1] = yOffset;
            verts[vi + 2] = p.z + r.z * (lateralOffset - halfWidth);
            verts[vi + 3] = p.x + r.x * (lateralOffset + halfWidth);
            verts[vi + 4] = yOffset;
            verts[vi + 5] = p.z + r.z * (lateralOffset + halfWidth);
            if (i < count - 1) {
                const bl = i * 2, br = i * 2 + 1;
                const tl = (i + 1) * 2, tr = (i + 1) * 2 + 1;
                indices.push(bl, tl, br, br, tl, tr);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, material));
    }

    // ── Chunk Management ───────────────────────────────────────

    _buildAllNeededChunks(playerPos) {
        let lastChunkEnd = 0;
        if (this.chunks.length > 0) {
            lastChunkEnd = this.chunks[this.chunks.length - 1].endIdx;
        }

        const playerIdx = this._findClosestPointIndex(playerPos);
        const aheadIdx = playerIdx + Math.ceil(GENERATE_AHEAD / POINT_SPACING);

        while (this.points.length < aheadIdx + POINTS_PER_CHUNK) {
            this._generatePoints(POINTS_PER_CHUNK);
        }

        while (lastChunkEnd < aheadIdx) {
            const start = lastChunkEnd;
            const end = Math.min(start + POINTS_PER_CHUNK, this.points.length);
            if (end - start < 2) break;
            this._buildChunk(start, end);
            lastChunkEnd = end;
        }
    }

    _findClosestPointIndex(pos) {
        let bestIdx = 0;
        let bestDist = Infinity;
        const step = Math.max(1, Math.floor(this.points.length / 500));
        for (let i = 0; i < this.points.length; i += step) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        const searchStart = Math.max(0, bestIdx - step * 2);
        const searchEnd = Math.min(this.points.length - 1, bestIdx + step * 2);
        for (let i = searchStart; i <= searchEnd; i++) {
            const dx = this.points[i].position.x - pos.x;
            const dz = this.points[i].position.z - pos.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        return bestIdx;
    }

    getPointAt(index) {
        return this.points[clamp(index, 0, this.points.length - 1)];
    }

    getRoadInfoAt(pos) {
        const idx = this._findClosestPointIndex(pos);
        const pt = this.points[idx];
        const dx = pos.x - pt.position.x;
        const dz = pos.z - pt.position.z;
        const lateral = dx * pt.right.x + dz * pt.right.z;
        const along = dx * pt.forward.x + dz * pt.forward.z;
        return {
            index: idx, point: pt, lateralOffset: lateral, alongOffset: along,
            onRoad: Math.abs(lateral) < ROAD_HALF_WIDTH,
            onSidewalk: Math.abs(lateral) > ROAD_HALF_WIDTH + CURB_WIDTH &&
                Math.abs(lateral) < ROAD_HALF_WIDTH + CURB_WIDTH + SIDEWALK_WIDTH
        };
    }

    getSpawnPositions(chunkIndex) {
        if (chunkIndex >= this.chunks.length) return [];
        const chunk = this.chunks[chunkIndex];
        const positions = [];
        for (let i = chunk.startIdx + 5; i < chunk.endIdx - 5; i += 8) {
            const pt = this.points[i];
            const roadLateral = randomRange(-ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH - 1);
            positions.push({
                position: new THREE.Vector3(
                    pt.position.x + pt.right.x * roadLateral, 0,
                    pt.position.z + pt.right.z * roadLateral
                ),
                roadIndex: i, type: 'road'
            });
            if (Math.random() > 0.5) {
                const side = Math.random() > 0.5 ? 1 : -1;
                const swLateral = side * (ROAD_HALF_WIDTH + CURB_WIDTH + randomRange(0.5, SIDEWALK_WIDTH - 0.5));
                positions.push({
                    position: new THREE.Vector3(
                        pt.position.x + pt.right.x * swLateral, CURB_HEIGHT,
                        pt.position.z + pt.right.z * swLateral
                    ),
                    roadIndex: i, type: 'sidewalk'
                });
            }
        }
        return positions;
    }

    /**
     * Set street light intensity (called by day/night system).
     */
    setStreetLightIntensity(intensity) {
        for (const light of this.streetLights) {
            light.intensity = intensity;
        }
    }

    update(playerPos) {
        this._ground.position.x = playerPos.x;
        this._ground.position.z = playerPos.z;
        this._buildAllNeededChunks(playerPos);

        const playerIdx = this._findClosestPointIndex(playerPos);
        const removeBeforeIdx = playerIdx - Math.ceil(REMOVE_BEHIND / POINT_SPACING);

        while (this.chunks.length > 0 && this.chunks[0].endIdx < removeBeforeIdx) {
            const old = this.chunks.shift();
            this.scene.remove(old.group);
            // Clean up lights from this chunk
            old.group.traverse((child) => {
                if (child.isPointLight) {
                    const idx = this.streetLights.indexOf(child);
                    if (idx !== -1) this.streetLights.splice(idx, 1);
                }
                if (child.geometry) child.geometry.dispose();
            });
        }
    }

    get chunkCount() {
        return this.chunks.length;
    }
}
