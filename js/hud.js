/**
 * HUD Manager
 *
 * Updates on-screen UI elements: speed, score, combo counter, time of day,
 * and an extended debug panel (FPS, GPU, browser, memory, renderer stats,
 * display info, post-processing, scene composition, and game-world data).
 */

export class HUD {
    constructor(renderer) {
        this._speedEl = document.getElementById('hud-speed');
        this._scoreEl = document.getElementById('hud-score');
        this._comboEl = document.getElementById('hud-combo');
        this._timeEl = document.getElementById('hud-time');
        this._debugEl = document.getElementById('hud-debug');

        this._renderer = renderer;

        this.score = 0;
        this.combo = 0;
        this.comboTimer = 0;
        this.comboTimeout = 2.0;

        // FPS tracking — rolling window
        this._fpsFrames = 0;
        this._fpsAccum = 0;
        this._fps = 0;
        this._frameTime = 0;
        this._fpsInterval = 0.5; // update every 0.5s

        // Frame time min/max/avg — rolling 5s window
        this._ftMin = Infinity;
        this._ftMax = 0;
        this._ftSum = 0;
        this._ftSamples = 0;
        this._ftResetAccum = 0;
        this._ftResetInterval = 5.0;

        // Static info (gathered once)
        this._browserStr = this._parseBrowser();
        this._gpuStr = this._queryGPU();
        this._coresStr = navigator.hardwareConcurrency
            ? `${navigator.hardwareConcurrency}`
            : '?';
        this._deviceMemStr = navigator.deviceMemory
            ? `${navigator.deviceMemory} GB`
            : 'N/A';
        this._glInfo = this._queryGLInfo();
    }

    _parseBrowser() {
        const ua = navigator.userAgent;
        let browser = 'Unknown';
        let os = 'Unknown';

        if (ua.includes('Firefox/')) {
            const v = ua.match(/Firefox\/([\d.]+)/);
            browser = `Firefox ${v ? v[1] : ''}`;
        } else if (ua.includes('Edg/')) {
            const v = ua.match(/Edg\/([\d.]+)/);
            browser = `Edge ${v ? v[1] : ''}`;
        } else if (ua.includes('Chrome/')) {
            const v = ua.match(/Chrome\/([\d.]+)/);
            browser = `Chrome ${v ? v[1] : ''}`;
        } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
            const v = ua.match(/Version\/([\d.]+)/);
            browser = `Safari ${v ? v[1] : ''}`;
        }

        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Mac OS')) os = 'macOS';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('CrOS')) os = 'ChromeOS';

        return `${browser} / ${os}`;
    }

    _queryGPU() {
        if (!this._renderer) return 'N/A';
        try {
            const gl = this._renderer.getContext();
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
                const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
                const gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
                // Trim long ANGLE strings
                const short = gpuRenderer
                    .replace(/ANGLE \(/, '')
                    .replace(/\)$/, '')
                    .replace(/,\s*Direct3D.*/, '')
                    .replace(/,\s*OpenGL.*/, '')
                    .replace(/,\s*Vulkan.*/, '');
                return short || `${vendor} ${gpuRenderer}`;
            }
            return gl.getParameter(gl.RENDERER) || 'Unknown';
        } catch (_) {
            return 'N/A';
        }
    }

    _queryGLInfo() {
        const info = {
            webglVersion: 'WebGL',
            maxTextureSize: 'N/A',
            maxViewportDims: 'N/A',
            antialias: false,
            maxRenderbufferSize: 'N/A',
            maxVaryings: 'N/A',
            extensions: [],
        };

        if (!this._renderer) return info;

        try {
            const gl = this._renderer.getContext();

            const v = gl.getParameter(gl.VERSION);
            if (v && v.includes('2.0')) info.webglVersion = 'WebGL 2.0';
            else info.webglVersion = v || 'WebGL';

            info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

            const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
            info.maxViewportDims = vp ? `${vp[0]}x${vp[1]}` : 'N/A';

            info.antialias = gl.getContextAttributes()?.antialias || false;

            info.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
            info.maxVaryings = gl.getParameter(gl.MAX_VARYING_VECTORS);

            const allExts = gl.getSupportedExtensions() || [];
            const keyExtensions = [
                'WEBGL_debug_renderer_info',
                'OES_texture_float',
                'OES_texture_half_float',
                'WEBGL_compressed_texture_s3tc',
                'EXT_texture_filter_anisotropic',
                'OES_element_index_uint',
                'EXT_color_buffer_float',
            ];
            info.extensions = keyExtensions.filter(e => allExts.includes(e));
        } catch (_) { /* noop */ }

        return info;
    }

    addKill(points = 100) {
        this.combo++;
        this.comboTimer = this.comboTimeout;

        const multiplier = Math.min(this.combo, 10);
        const total = points * multiplier;
        this.score += total;

        if (this._comboEl) {
            if (this.combo > 1) {
                this._comboEl.textContent = `x${this.combo} COMBO! +${total}`;
                this._comboEl.classList.remove('hidden');
                this._comboEl.style.opacity = '1';
            }
        }
    }

    update(dt, speedKmh, timeStr, phaseName, debugInfo) {
        if (this._speedEl) {
            this._speedEl.innerHTML = `${speedKmh} <span>km/h</span>`;
        }

        if (this._scoreEl) {
            this._scoreEl.textContent = `SCORE: ${this.score}`;
        }

        if (this._timeEl && timeStr) {
            this._timeEl.textContent = `${timeStr} ${phaseName}`;
        }

        // Combo timer
        if (this.comboTimer > 0) {
            this.comboTimer -= dt;
            if (this.comboTimer <= 0) {
                this.combo = 0;
                if (this._comboEl) {
                    this._comboEl.classList.add('hidden');
                }
            }
        }

        // Extended debug panel
        this._updateDebug(dt, debugInfo);
    }

    _updateDebug(dt, debugInfo) {
        if (!this._debugEl) return;

        // FPS rolling average
        this._fpsFrames++;
        this._fpsAccum += dt;
        if (this._fpsAccum >= this._fpsInterval) {
            this._fps = Math.round(this._fpsFrames / this._fpsAccum);
            this._frameTime = ((this._fpsAccum / this._fpsFrames) * 1000).toFixed(1);
            this._fpsFrames = 0;
            this._fpsAccum = 0;
        }

        // Frame time min/max/avg tracking
        const frameMs = dt * 1000;
        this._ftMin = Math.min(this._ftMin, frameMs);
        this._ftMax = Math.max(this._ftMax, frameMs);
        this._ftSum += frameMs;
        this._ftSamples++;
        this._ftResetAccum += dt;
        const ftAvg = (this._ftSum / this._ftSamples).toFixed(1);
        if (this._ftResetAccum >= this._ftResetInterval) {
            this._ftResetAccum = 0;
            this._ftMin = Infinity;
            this._ftMax = 0;
            this._ftSum = 0;
            this._ftSamples = 0;
        }

        // Frame budget usage (% of 16.67ms target for 60fps)
        const budgetPct = ((frameMs / 16.67) * 100).toFixed(0);

        // Renderer stats
        const info = this._renderer ? this._renderer.info : null;
        const calls = info ? info.render.calls : 0;
        const tris = info ? info.render.triangles : 0;
        const texCount = info ? info.memory.textures : 0;
        const geoCount = info ? info.memory.geometries : 0;
        const programs = info && info.programs ? info.programs.length : 0;

        // Format triangle count
        let triStr;
        if (tris >= 1000000) triStr = (tris / 1000000).toFixed(1) + 'M';
        else if (tris >= 1000) triStr = (tris / 1000).toFixed(1) + 'K';
        else triStr = String(tris);

        // Memory (Chrome-only)
        let memStr = 'N/A';
        if (performance.memory) {
            const used = (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(0);
            const total = (performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(0);
            memStr = `${used}/${total} MB`;
        }

        // Display info
        const dpr = window.devicePixelRatio.toFixed(2);
        const screenRes = `${screen.width}x${screen.height}`;
        const viewport = `${window.innerWidth}x${window.innerHeight}`;

        // Canvas resolution
        const canvasW = debugInfo ? debugInfo.canvasWidth : 0;
        const canvasH = debugInfo ? debugInfo.canvasHeight : 0;

        // Pixel ratio (native vs capped)
        const prNative = debugInfo ? debugInfo.pixelRatioNative?.toFixed(2) : dpr;
        const prCapped = debugInfo ? debugInfo.pixelRatioCapped?.toFixed(2) : dpr;

        // World data
        const chunkId = debugInfo ? debugInfo.chunkId : '-';
        const wx = debugInfo ? debugInfo.x : 0;
        const wz = debugInfo ? debugInfo.z : 0;
        const npcs = debugInfo ? debugInfo.npcCount : 0;

        // Scene stats
        const sceneObjs = debugInfo ? debugInfo.sceneObjects : 0;
        const sceneMats = debugInfo ? debugInfo.sceneMaterials : 0;
        const sceneLights = debugInfo ? debugInfo.sceneLights : 0;

        // Post-processing info
        const bloomStr = debugInfo && debugInfo.bloomStrength !== undefined
            ? `S:${debugInfo.bloomStrength} R:${debugInfo.bloomRadius} T:${debugInfo.bloomThreshold}`
            : 'N/A';

        // Tone mapping / color space
        const toneMap = debugInfo ? debugInfo.toneMapping : '?';
        const exposure = debugInfo ? debugInfo.toneMappingExposure?.toFixed(2) : '?';
        const colorSpace = debugInfo ? (debugInfo.colorSpace || '?') : '?';

        // GL static info
        const gl = this._glInfo;

        const lines = [
            `FPS: ${this._fps}  FRAME: ${this._frameTime}ms  BUDGET: ${budgetPct}%`,
            `FTIME: min ${this._ftMin === Infinity ? '-' : this._ftMin.toFixed(1)}  max ${this._ftMax === 0 ? '-' : this._ftMax.toFixed(1)}  avg ${ftAvg}ms`,
            `GPU: ${this._gpuStr}`,
            `${gl.webglVersion} | AA: ${gl.antialias ? 'ON' : 'OFF'} | MAX TEX: ${gl.maxTextureSize}`,
            `BROWSER: ${this._browserStr}`,
            `CORES: ${this._coresStr}  RAM: ${this._deviceMemStr}  HEAP: ${memStr}`,
            `DPR: ${prNative}${prNative !== prCapped ? ` (cap ${prCapped})` : ''}  SCREEN: ${screenRes}  VIEW: ${viewport}`,
            `CANVAS: ${canvasW}x${canvasH}px`,
            `DRAW: ${calls}  TRI: ${triStr}  TEX: ${texCount}  GEO: ${geoCount}  PROGS: ${programs}`,
            `SCENE: ${sceneObjs} objs  ${sceneMats} mats  ${sceneLights} lights`,
            `BLOOM: ${bloomStr}  TONE: ${toneMap}  EXP: ${exposure}`,
            `COLOR: ${colorSpace}`,
            `EXT: ${gl.extensions.length > 0 ? gl.extensions.map(e => e.replace('WEBGL_', '').replace('OES_', '').replace('EXT_', '').substring(0, 14)).join(' ') : 'none'}`,
            `CHUNK: ${chunkId}  X: ${wx}  Z: ${wz}  NPCs: ${npcs}`,
        ];

        this._debugEl.textContent = lines.join('\n');
    }
}
