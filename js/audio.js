/**
 * Procedural Audio Engine — Web Audio API
 *
 * All sounds are synthesized in real-time, no audio files needed.
 * Systems:
 *   1. Engine drone    — layered oscillators, pitch tracks RPM
 *   2. Rev limiter     — crackle/pops at redline
 *   3. Gear shifts     — brief pitch transient + thump
 *   4. NPC impact      — metallic crunch + low thump
 *   5. Gore splat      — wet noise burst
 *   6. Tree crash      — heavy impact + glass-like shatter
 *   7. Tire screech    — filtered noise during drift
 *   8. Surface rumble  — low-freq noise varying by surface
 *   9. Engine start    — starter motor whine → catch
 *  10. Engine stall    — descending pitch + sputter
 *  11. NPC moped buzz  — proximity-based buzzy tone
 */

import { clamp, lerp } from './utils.js';

// ── Gear / RPM constants (must match vehicle.js) ────────────
const GEAR_SHIFTS = [0, 4, 9, 15, 23, 32, 42];
const GEAR_COUNT = 7;
const MAX_SPEED = 50;

// ── Engine tuning ───────────────────────────────────────────
const ENGINE_BASE_FREQ = 55;          // Hz — idle fundamental (A1)
const ENGINE_MAX_FREQ = 220;          // Hz — redline fundamental
const ENGINE_IDLE_RPM = 0.08;         // minimum RPM fraction when running
const REV_LIMITER_THRESHOLD = 0.92;   // RPM fraction where limiter kicks in
const REV_LIMITER_CUT_RATE = 30;      // Hz — how fast the limiter pulses

// ════════════════════════════════════════════════════════════
export class AudioEngine {
    constructor() {
        this._ctx = null;
        this._initialized = false;
        this._masterGain = null;

        // Engine state
        this._engineNodes = null;
        this._currentRPM = 0;            // 0–1 normalized
        this._targetRPM = 0;
        this._engineRunning = false;
        this._throttle = 0;
        this._prevGear = 1;

        // Rev limiter
        this._revLimiterActive = false;
        this._revLimiterPhase = 0;

        // Tire screech
        this._screechNodes = null;
        this._screechGain = 0;

        // Surface rumble
        this._rumbleNodes = null;

        // NPC moped sounds
        this._mopedNodes = [];
        this._mopedPool = [];

        // One-shot cooldowns
        this._lastImpactTime = 0;
        this._lastSplatTime = 0;
    }

    /**
     * Must be called from a user gesture (click/keydown) to unlock Web Audio.
     */
    init() {
        if (this._initialized) return;

        try {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio not available:', e);
            return;
        }

        this._initialized = true;

        // Master output
        this._masterGain = this._ctx.createGain();
        this._masterGain.gain.value = 0.7;
        this._masterGain.connect(this._ctx.destination);

        // Compressor to tame peaks
        this._compressor = this._ctx.createDynamicsCompressor();
        this._compressor.threshold.value = -18;
        this._compressor.knee.value = 12;
        this._compressor.ratio.value = 6;
        this._compressor.attack.value = 0.003;
        this._compressor.release.value = 0.15;
        this._compressor.connect(this._masterGain);

        this._buildEngine();
        this._buildTireScreech();
        this._buildSurfaceRumble();
    }

    /**
     * Resume audio context if suspended (browsers require user gesture).
     */
    resume() {
        if (this._ctx && this._ctx.state === 'suspended') {
            this._ctx.resume();
        }
    }

    // ── Engine Sound ────────────────────────────────────────

    _buildEngine() {
        const ctx = this._ctx;

        // Engine bus
        const engineBus = ctx.createGain();
        engineBus.gain.value = 0;
        engineBus.connect(this._compressor);

        // Low-pass filter — opens with RPM
        const engineFilter = ctx.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 300;
        engineFilter.Q.value = 2.5;
        engineFilter.connect(engineBus);

        // Waveshaper for grit
        const waveshaper = ctx.createWaveShaper();
        waveshaper.curve = this._makeDistortionCurve(8);
        waveshaper.oversample = '2x';
        waveshaper.connect(engineFilter);

        // Layer 1: Fundamental — sawtooth
        const osc1 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.value = ENGINE_BASE_FREQ;
        const g1 = ctx.createGain();
        g1.gain.value = 0.35;
        osc1.connect(g1);
        g1.connect(waveshaper);
        osc1.start();

        // Layer 2: 2nd harmonic — square (adds body)
        const osc2 = ctx.createOscillator();
        osc2.type = 'square';
        osc2.frequency.value = ENGINE_BASE_FREQ * 2;
        const g2 = ctx.createGain();
        g2.gain.value = 0.15;
        osc2.connect(g2);
        g2.connect(waveshaper);
        osc2.start();

        // Layer 3: Sub-bass — sine (low rumble)
        const osc3 = ctx.createOscillator();
        osc3.type = 'sine';
        osc3.frequency.value = ENGINE_BASE_FREQ * 0.5;
        const g3 = ctx.createGain();
        g3.gain.value = 0.25;
        osc3.connect(g3);
        g3.connect(waveshaper);
        osc3.start();

        // Layer 4: 4th harmonic — triangle (high-end shimmer)
        const osc4 = ctx.createOscillator();
        osc4.type = 'triangle';
        osc4.frequency.value = ENGINE_BASE_FREQ * 4;
        const g4 = ctx.createGain();
        g4.gain.value = 0.08;
        osc4.connect(g4);
        g4.connect(engineFilter);  // bypass distortion for cleaner top
        osc4.start();

        // Exhaust rumble — filtered noise
        const exhaustNoise = this._createNoiseSource();
        const exhaustFilter = ctx.createBiquadFilter();
        exhaustFilter.type = 'bandpass';
        exhaustFilter.frequency.value = 120;
        exhaustFilter.Q.value = 1.5;
        const exhaustGain = ctx.createGain();
        exhaustGain.gain.value = 0.12;
        exhaustNoise.connect(exhaustFilter);
        exhaustFilter.connect(exhaustGain);
        exhaustGain.connect(engineBus);

        this._engineNodes = {
            bus: engineBus,
            filter: engineFilter,
            waveshaper,
            oscs: [osc1, osc2, osc3, osc4],
            gains: [g1, g2, g3, g4],
            exhaustFilter,
            exhaustGain,
        };
    }

    _buildTireScreech() {
        const ctx = this._ctx;

        const noise = this._createNoiseSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3000;
        bp.Q.value = 3;

        const screechGain = ctx.createGain();
        screechGain.gain.value = 0;

        noise.connect(bp);
        bp.connect(screechGain);
        screechGain.connect(this._compressor);

        this._screechNodes = { noise, filter: bp, gain: screechGain };
    }

    _buildSurfaceRumble() {
        const ctx = this._ctx;

        const noise = this._createNoiseSource();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 80;
        lp.Q.value = 1;

        const rumbleGain = ctx.createGain();
        rumbleGain.gain.value = 0;

        noise.connect(lp);
        lp.connect(rumbleGain);
        rumbleGain.connect(this._compressor);

        this._rumbleNodes = { noise, filter: lp, gain: rumbleGain };
    }

    // ── Per-Frame Update ────────────────────────────────────

    /**
     * Call every frame with current vehicle state.
     */
    update(dt, vehicleState) {
        if (!this._initialized || !this._ctx) return;

        const {
            speed = 0,
            gear = 1,
            gasInput = 0,
            brakeInput = 0,
            engineRunning = true,
            drifting = false,
            driftAngle = 0,
            surface = 'road',
            handbrake = false,
        } = vehicleState;

        this._throttle = gasInput;

        // ── RPM Calculation ──────────────────────────────────
        const absSpeed = Math.abs(speed);
        const gearIdx = clamp(gear - 1, 0, GEAR_SHIFTS.length - 1);
        const gearLo = GEAR_SHIFTS[gearIdx];
        const gearHi = gearIdx + 1 < GEAR_SHIFTS.length
            ? GEAR_SHIFTS[gearIdx + 1]
            : MAX_SPEED;

        let rpm;
        if (!engineRunning) {
            rpm = 0;
        } else if (absSpeed < 0.5) {
            // Idle
            rpm = ENGINE_IDLE_RPM + gasInput * 0.3;
        } else {
            const range = Math.max(gearHi - gearLo, 1);
            rpm = clamp((absSpeed - gearLo) / range, 0, 1);
            // Boost RPM with throttle
            rpm = rpm * 0.7 + gasInput * 0.3;
            rpm = clamp(rpm, ENGINE_IDLE_RPM, 1.0);
        }
        this._targetRPM = rpm;

        // Smooth RPM changes (fast rise, slower fall)
        const rpmRate = this._targetRPM > this._currentRPM ? 8.0 : 4.0;
        this._currentRPM = lerp(this._currentRPM, this._targetRPM, 1 - Math.exp(-rpmRate * dt));

        // ── Engine Sound ─────────────────────────────────────
        this._updateEngine(dt, engineRunning, gasInput);

        // ── Rev Limiter ──────────────────────────────────────
        this._updateRevLimiter(dt);

        // ── Gear Shift Detection ─────────────────────────────
        if (gear !== this._prevGear && engineRunning && absSpeed > 2) {
            this._playGearShift(gear > this._prevGear);
        }
        this._prevGear = gear;

        // ── Tire Screech ─────────────────────────────────────
        this._updateTireScreech(dt, drifting, driftAngle, absSpeed, handbrake, brakeInput);

        // ── Surface Rumble ───────────────────────────────────
        this._updateSurfaceRumble(dt, surface, absSpeed);
    }

    _updateEngine(dt, running, gas) {
        if (!this._engineNodes) return;
        const { bus, filter, oscs, exhaustFilter } = this._engineNodes;
        const rpm = this._currentRPM;

        // Frequency: map RPM to engine frequency range
        const freq = ENGINE_BASE_FREQ + rpm * (ENGINE_MAX_FREQ - ENGINE_BASE_FREQ);

        // Set oscillator frequencies (harmonics)
        oscs[0].frequency.setTargetAtTime(freq, this._ctx.currentTime, 0.02);
        oscs[1].frequency.setTargetAtTime(freq * 2, this._ctx.currentTime, 0.02);
        oscs[2].frequency.setTargetAtTime(freq * 0.5, this._ctx.currentTime, 0.02);
        oscs[3].frequency.setTargetAtTime(freq * 4, this._ctx.currentTime, 0.02);

        // Filter opens with RPM
        const filterFreq = 300 + rpm * 3500;
        filter.frequency.setTargetAtTime(filterFreq, this._ctx.currentTime, 0.03);

        // Exhaust rumble tracks RPM
        exhaustFilter.frequency.setTargetAtTime(
            80 + rpm * 200, this._ctx.currentTime, 0.05
        );

        // Volume: idle baseline + throttle boost
        let vol = running ? 0.15 + gas * 0.35 + rpm * 0.15 : 0;
        bus.gain.setTargetAtTime(vol, this._ctx.currentTime, 0.03);
    }

    _updateRevLimiter(dt) {
        if (!this._engineNodes) return;

        const rpm = this._currentRPM;
        const wasActive = this._revLimiterActive;

        if (rpm > REV_LIMITER_THRESHOLD) {
            this._revLimiterActive = true;
            this._revLimiterPhase += dt * REV_LIMITER_CUT_RATE;

            // Rapid gain modulation (simulates misfires)
            const limiterMod = 0.4 + 0.6 * Math.abs(Math.sin(this._revLimiterPhase * Math.PI));
            this._engineNodes.bus.gain.setTargetAtTime(
                this._engineNodes.bus.gain.value * limiterMod,
                this._ctx.currentTime, 0.005
            );

            // Random pops/bangs
            if (Math.random() < dt * 25) {
                this._playExhaustPop();
            }
        } else {
            this._revLimiterActive = false;
            this._revLimiterPhase = 0;
        }
    }

    _playExhaustPop() {
        const ctx = this._ctx;
        const now = ctx.currentTime;

        // Short noise burst — exhaust backfire
        const bufferSize = ctx.sampleRate * 0.04;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 200 + Math.random() * 400;
        bp.Q.value = 2;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25 + Math.random() * 0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

        source.connect(bp);
        bp.connect(gain);
        gain.connect(this._compressor);

        source.start(now);
        source.stop(now + 0.06);
    }

    _updateTireScreech(dt, drifting, driftAngle, speed, handbrake, brakeInput) {
        if (!this._screechNodes) return;

        let targetGain = 0;

        if (drifting && speed > 5) {
            // Screech intensity from drift angle
            targetGain = clamp(Math.abs(driftAngle) * 2.5, 0, 0.4);
        }

        if (handbrake && speed > 8) {
            targetGain = Math.max(targetGain, 0.3);
        }

        // Heavy braking screech
        if (brakeInput > 0.8 && speed > 15) {
            targetGain = Math.max(targetGain, 0.15);
        }

        this._screechGain = lerp(this._screechGain, targetGain, 1 - Math.exp(-10 * dt));
        this._screechNodes.gain.gain.setTargetAtTime(
            this._screechGain, this._ctx.currentTime, 0.02
        );

        // Pitch variation with speed
        const screechFreq = 2000 + speed * 40 + Math.abs(driftAngle) * 1000;
        this._screechNodes.filter.frequency.setTargetAtTime(
            screechFreq, this._ctx.currentTime, 0.05
        );
    }

    _updateSurfaceRumble(dt, surface, speed) {
        if (!this._rumbleNodes) return;

        let targetGain = 0;
        let freq = 60;

        if (speed > 2) {
            switch (surface) {
                case 'offRoad':
                    targetGain = clamp(speed * 0.008, 0, 0.25);
                    freq = 40 + speed * 1.5;
                    break;
                case 'sidewalk':
                    targetGain = clamp(speed * 0.005, 0, 0.15);
                    freq = 60 + speed * 2;
                    break;
                case 'shoulder':
                    targetGain = clamp(speed * 0.003, 0, 0.10);
                    freq = 50 + speed * 1.0;
                    break;
                default: // road
                    targetGain = clamp(speed * 0.001, 0, 0.03);
                    freq = 30 + speed * 0.5;
                    break;
            }
        }

        this._rumbleNodes.gain.gain.setTargetAtTime(
            targetGain, this._ctx.currentTime, 0.05
        );
        this._rumbleNodes.filter.frequency.setTargetAtTime(
            freq, this._ctx.currentTime, 0.08
        );
    }

    // ── One-Shot Sound Effects ──────────────────────────────

    /**
     * Play NPC impact sound — metallic crunch + body thump.
     */
    playImpact(intensity = 1.0) {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;
        if (now - this._lastImpactTime < 0.08) return;
        this._lastImpactTime = now;

        // Low thump
        const thump = this._ctx.createOscillator();
        thump.type = 'sine';
        thump.frequency.setValueAtTime(80, now);
        thump.frequency.exponentialRampToValueAtTime(30, now + 0.15);

        const thumpGain = this._ctx.createGain();
        thumpGain.gain.setValueAtTime(0.5 * intensity, now);
        thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        thump.connect(thumpGain);
        thumpGain.connect(this._compressor);
        thump.start(now);
        thump.stop(now + 0.2);

        // Metallic crunch — noise burst through resonant bandpass
        const crunchLen = 0.12;
        const crunchBuf = this._ctx.createBuffer(1, this._ctx.sampleRate * crunchLen, this._ctx.sampleRate);
        const crunchData = crunchBuf.getChannelData(0);
        for (let i = 0; i < crunchData.length; i++) {
            crunchData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (crunchData.length * 0.2));
        }

        const crunchSrc = this._ctx.createBufferSource();
        crunchSrc.buffer = crunchBuf;

        const bp = this._ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 800 + Math.random() * 600;
        bp.Q.value = 4;

        const crunchGain = this._ctx.createGain();
        crunchGain.gain.setValueAtTime(0.4 * intensity, now);
        crunchGain.gain.exponentialRampToValueAtTime(0.001, now + crunchLen);

        crunchSrc.connect(bp);
        bp.connect(crunchGain);
        crunchGain.connect(this._compressor);
        crunchSrc.start(now);
        crunchSrc.stop(now + crunchLen);

        // Glass/plastic shatter overtone
        const shatter = this._ctx.createOscillator();
        shatter.type = 'square';
        shatter.frequency.setValueAtTime(2500 + Math.random() * 1500, now);
        shatter.frequency.exponentialRampToValueAtTime(800, now + 0.06);

        const shatterGain = this._ctx.createGain();
        shatterGain.gain.setValueAtTime(0.08 * intensity, now);
        shatterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

        shatter.connect(shatterGain);
        shatterGain.connect(this._compressor);
        shatter.start(now);
        shatter.stop(now + 0.06);
    }

    /**
     * Play wet splat sound — for gore hits.
     */
    playSplat() {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;
        if (now - this._lastSplatTime < 0.05) return;
        this._lastSplatTime = now;

        const duration = 0.15 + Math.random() * 0.1;

        // Wet noise burst
        const bufLen = this._ctx.sampleRate * duration;
        const buf = this._ctx.createBuffer(1, bufLen, this._ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) {
            // Envelope: sharp attack, medium decay
            const env = Math.exp(-i / (bufLen * 0.25));
            data[i] = (Math.random() * 2 - 1) * env;
        }

        const src = this._ctx.createBufferSource();
        src.buffer = buf;

        // Low-pass with resonance sweep — gives "wet" character
        const lp = this._ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(2000 + Math.random() * 1000, now);
        lp.frequency.exponentialRampToValueAtTime(200, now + duration);
        lp.Q.value = 5 + Math.random() * 5;

        const gain = this._ctx.createGain();
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        src.connect(lp);
        lp.connect(gain);
        gain.connect(this._compressor);
        src.start(now);
        src.stop(now + duration);

        // Sub-bass "squelch" — low sine pop
        const squelch = this._ctx.createOscillator();
        squelch.type = 'sine';
        squelch.frequency.setValueAtTime(120 + Math.random() * 60, now);
        squelch.frequency.exponentialRampToValueAtTime(40, now + 0.08);

        const squelchGain = this._ctx.createGain();
        squelchGain.gain.setValueAtTime(0.25, now);
        squelchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

        squelch.connect(squelchGain);
        squelchGain.connect(this._compressor);
        squelch.start(now);
        squelch.stop(now + 0.1);
    }

    /**
     * Play heavy tree crash — deep impact + crunch + glass shatter.
     */
    playTreeCrash(speedFraction) {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;
        const intensity = clamp(speedFraction, 0.3, 1.0);

        // Deep impact thump
        const thump = this._ctx.createOscillator();
        thump.type = 'sine';
        thump.frequency.setValueAtTime(60, now);
        thump.frequency.exponentialRampToValueAtTime(15, now + 0.35);

        const thumpGain = this._ctx.createGain();
        thumpGain.gain.setValueAtTime(0.6 * intensity, now);
        thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        thump.connect(thumpGain);
        thumpGain.connect(this._compressor);
        thump.start(now);
        thump.stop(now + 0.4);

        // Metal crunch — long decay
        const crunchLen = 0.3;
        const buf = this._ctx.createBuffer(1, this._ctx.sampleRate * crunchLen, this._ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.15));
        }

        const crunchSrc = this._ctx.createBufferSource();
        crunchSrc.buffer = buf;

        const bp = this._ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 500 + Math.random() * 400;
        bp.Q.value = 3;

        const crunchGain = this._ctx.createGain();
        crunchGain.gain.setValueAtTime(0.5 * intensity, now);
        crunchGain.gain.exponentialRampToValueAtTime(0.001, now + crunchLen);

        crunchSrc.connect(bp);
        bp.connect(crunchGain);
        crunchGain.connect(this._compressor);
        crunchSrc.start(now);
        crunchSrc.stop(now + crunchLen);

        // Glass shatter — high-pitched descending noise
        const shatterLen = 0.25;
        const sBuf = this._ctx.createBuffer(1, this._ctx.sampleRate * shatterLen, this._ctx.sampleRate);
        const sData = sBuf.getChannelData(0);
        for (let i = 0; i < sData.length; i++) {
            sData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sData.length * 0.12));
        }

        const sSrc = this._ctx.createBufferSource();
        sSrc.buffer = sBuf;

        const hp = this._ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(4000, now);
        hp.frequency.exponentialRampToValueAtTime(1000, now + shatterLen);
        hp.Q.value = 1;

        const sGain = this._ctx.createGain();
        sGain.gain.setValueAtTime(0.2 * intensity, now);
        sGain.gain.exponentialRampToValueAtTime(0.001, now + shatterLen);

        sSrc.connect(hp);
        hp.connect(sGain);
        sGain.connect(this._compressor);
        sSrc.start(now);
        sSrc.stop(now + shatterLen);
    }

    /**
     * Play gear shift transient.
     */
    _playGearShift(isUpshift) {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;

        // Brief throttle cut — dip engine volume momentarily
        if (this._engineNodes) {
            const bus = this._engineNodes.bus;
            const current = bus.gain.value;
            bus.gain.setValueAtTime(current, now);
            bus.gain.setTargetAtTime(current * 0.3, now, 0.01);
            bus.gain.setTargetAtTime(current, now + 0.06, 0.03);
        }

        // Mechanical "clunk" — short sine burst
        const clunk = this._ctx.createOscillator();
        clunk.type = 'triangle';
        clunk.frequency.setValueAtTime(isUpshift ? 300 : 200, now);
        clunk.frequency.exponentialRampToValueAtTime(
            isUpshift ? 100 : 80, now + 0.04
        );

        const clunkGain = this._ctx.createGain();
        clunkGain.gain.setValueAtTime(0.12, now);
        clunkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        clunk.connect(clunkGain);
        clunkGain.connect(this._compressor);
        clunk.start(now);
        clunk.stop(now + 0.05);

        // Upshift exhaust pop
        if (isUpshift && Math.random() > 0.3) {
            this._playExhaustPop();
        }
    }

    /**
     * Play engine start sequence.
     */
    playEngineStart() {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;

        // Starter motor whine — ascending sawtooth
        const starter = this._ctx.createOscillator();
        starter.type = 'sawtooth';
        starter.frequency.setValueAtTime(30, now);
        starter.frequency.linearRampToValueAtTime(80, now + 0.3);
        starter.frequency.linearRampToValueAtTime(55, now + 0.5);

        const starterFilter = this._ctx.createBiquadFilter();
        starterFilter.type = 'lowpass';
        starterFilter.frequency.value = 400;
        starterFilter.Q.value = 2;

        const starterGain = this._ctx.createGain();
        starterGain.gain.setValueAtTime(0, now);
        starterGain.gain.linearRampToValueAtTime(0.2, now + 0.05);
        starterGain.gain.setValueAtTime(0.2, now + 0.35);
        starterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

        starter.connect(starterFilter);
        starterFilter.connect(starterGain);
        starterGain.connect(this._compressor);
        starter.start(now);
        starter.stop(now + 0.55);

        // "Catch" — engine turns over burst
        const catchLen = 0.1;
        const buf = this._ctx.createBuffer(1, this._ctx.sampleRate * catchLen, this._ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5 * Math.exp(-i / (data.length * 0.3));
        }

        const catchSrc = this._ctx.createBufferSource();
        catchSrc.buffer = buf;

        const catchGain = this._ctx.createGain();
        catchGain.gain.setValueAtTime(0.3, now + 0.35);
        catchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

        catchSrc.connect(catchGain);
        catchGain.connect(this._compressor);
        catchSrc.start(now + 0.35);
        catchSrc.stop(now + 0.5);
    }

    /**
     * Play engine stall — descending pitch + sputter out.
     */
    playEngineStall() {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;

        // Descending oscillator
        const stall = this._ctx.createOscillator();
        stall.type = 'sawtooth';
        const currentFreq = ENGINE_BASE_FREQ + this._currentRPM * (ENGINE_MAX_FREQ - ENGINE_BASE_FREQ);
        stall.frequency.setValueAtTime(currentFreq, now);
        stall.frequency.exponentialRampToValueAtTime(20, now + 0.4);

        const stallFilter = this._ctx.createBiquadFilter();
        stallFilter.type = 'lowpass';
        stallFilter.frequency.setValueAtTime(800, now);
        stallFilter.frequency.exponentialRampToValueAtTime(100, now + 0.4);

        const stallGain = this._ctx.createGain();
        stallGain.gain.setValueAtTime(0.25, now);
        stallGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

        stall.connect(stallFilter);
        stallFilter.connect(stallGain);
        stallGain.connect(this._compressor);
        stall.start(now);
        stall.stop(now + 0.5);

        // Force engine sound off
        this._currentRPM = 0;
    }

    /**
     * Play gore chunk re-hit — small crunch.
     */
    playChunkHit() {
        if (!this._initialized) return;
        const now = this._ctx.currentTime;

        const len = 0.06;
        const buf = this._ctx.createBuffer(1, this._ctx.sampleRate * len, this._ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.2));
        }

        const src = this._ctx.createBufferSource();
        src.buffer = buf;

        const bp = this._ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 400 + Math.random() * 600;
        bp.Q.value = 3;

        const gain = this._ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + len);

        src.connect(bp);
        bp.connect(gain);
        gain.connect(this._compressor);
        src.start(now);
        src.stop(now + len);
    }

    /**
     * Update NPC proximity buzz sounds.
     * @param {Array} npcs — array of { position, speed, isStatic }
     * @param {THREE.Vector3} listenerPos — vehicle position
     */
    updateNPCSounds(npcs, listenerPos) {
        if (!this._initialized || !npcs || npcs.length === 0) return;

        const ctx = this._ctx;
        const now = ctx.currentTime;
        const MAX_MOPED_SOUNDS = 4;
        const AUDIBLE_RANGE = 40;

        // Find closest moving NPCs
        const audible = [];
        for (let i = 0; i < npcs.length && audible.length < MAX_MOPED_SOUNDS * 2; i++) {
            const npc = npcs[i];
            if (npc.isStatic || !npc.alive) continue;

            const dx = npc.position.x - listenerPos.x;
            const dz = npc.position.z - listenerPos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < AUDIBLE_RANGE) {
                audible.push({ npc, dist });
            }
        }

        // Sort by distance
        audible.sort((a, b) => a.dist - b.dist);

        // Ensure we have enough moped oscillators
        while (this._mopedPool.length < MAX_MOPED_SOUNDS) {
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = 0;

            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 400;
            filter.Q.value = 3;

            const gain = ctx.createGain();
            gain.gain.value = 0;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this._compressor);
            osc.start();

            this._mopedPool.push({ osc, filter, gain, active: false });
        }

        // Assign closest NPCs to pool slots
        for (let i = 0; i < MAX_MOPED_SOUNDS; i++) {
            const slot = this._mopedPool[i];
            if (i < audible.length) {
                const { npc, dist } = audible[i];
                const volume = clamp(1 - dist / AUDIBLE_RANGE, 0, 1) * 0.08;
                const freq = 80 + npc.speed * 8; // higher speed = higher pitch

                slot.osc.frequency.setTargetAtTime(freq, now, 0.05);
                slot.filter.frequency.setTargetAtTime(freq * 3, now, 0.05);
                slot.gain.gain.setTargetAtTime(volume, now, 0.05);
                slot.active = true;
            } else {
                // Fade out unused slots
                slot.gain.gain.setTargetAtTime(0, now, 0.05);
                slot.active = false;
            }
        }
    }

    // ── Utility ─────────────────────────────────────────────

    /**
     * Create a looping white noise source.
     */
    _createNoiseSource() {
        const ctx = this._ctx;
        const bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.start();
        return source;
    }

    /**
     * Create a waveshaper distortion curve.
     */
    _makeDistortionCurve(amount) {
        const samples = 256;
        const curve = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
        }
        return curve;
    }
}
