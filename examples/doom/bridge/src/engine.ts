import { readProgressEvents, keyColors } from './progression.ts';
import { readFile } from 'node:fs/promises';
import { readEntities } from './telemetry.ts';
import { PNG } from 'pngjs';
import { stepSchema, weapons } from '../../contracts/src/game.ts';
import type { GameState, Input, Step, ProgressEvent } from '../../contracts/src/game.ts';

// ABI from wasmdoom dd321b50. See assets/README.md for source and licenses.
const key: Record<Input, number> = {
  forward: 0xad, backward: 0xaf, left: 0xac, right: 0xae,
  strafeLeft: 0x2c, strafeRight: 0x2e, fire: 0x9d, use: 0x20,
  weapon1: 0x31, weapon2: 0x32, weapon3: 0x33, weapon4: 0x34,
  weapon5: 0x35, weapon6: 0x36, weapon7: 0x37, weapon8: 0x38,
};
type EngineExports = { memory: WebAssembly.Memory } & Record<string, unknown>;

export class DoomEngine {
  // Own instance field: a prototype-only upgrade of an old HTTP bridge must
  // not claim that its unchanged request parser accepts new weapon inputs.
  private readonly acceptsWeaponInputs = true;
  private tickCount = 0;
  private progressEvents: ProgressEvent[] = [];
  private progressMap?: string;
  private constructor(private readonly wasm: EngineExports) {}

  static async load(wasmPath: string, wadPath: string): Promise<DoomEngine> {
    const [wasm, wad] = await Promise.all([readFile(wasmPath), readFile(wadPath)]);
    const { instance } = await WebAssembly.instantiate(wasm, {});
    if (!(instance.exports.memory instanceof WebAssembly.Memory)) throw new Error('Doom engine has no memory export');
    const engine = new DoomEngine(instance.exports as EngineExports);
    for (const name of ['wad_alloc', 'argv_ptr', 'init', 'tick', 'keydown', 'keyup', 'get_framebuffer', 'get_palette', 'snapshot_player', 'player_snapshot_ptr', 'snapshot_settings', 'settings_ptr', 'snapshot_map_objects', 'map_objects_ptr']) {
      if (typeof instance.exports[`wasmdoom_${name}`] !== 'function') throw new Error(`Incompatible engine: missing ${name}`);
    }
    const ptr = engine.call('wad_alloc', wad.length);
    if (!ptr) throw new Error('Doom WAD allocation failed');
    new Uint8Array(engine.wasm.memory.buffer, ptr, wad.length).set(wad);
    const args = new TextEncoder().encode(['-iwad', 'freedoom1.wad', '-warp', '1', '1', '-skill', '2', '', ''].join('\0'));
    new Uint8Array(engine.wasm.memory.buffer, engine.call('argv_ptr'), args.length).set(args);
    engine.call('init');
    // Finish the initial screen wipe before exposing the first decision point.
    engine.step({ ticks: 35, inputs: [] });
    return engine;
  }

  private call(name: string, ...args: number[]): number {
    const fn = this.wasm[`wasmdoom_${name}`];
    if (typeof fn !== 'function') throw new Error(`Missing engine export ${name}`);
    return fn(...args) as number;
  }

  step({ ticks, inputs }: Step): GameState {
    stepSchema.parse({ ticks, inputs });
    for (const input of inputs) this.call('keydown', key[input]);
    try {
      for (let i = 0; i < ticks; i++) {
        this.call('events_clear');
        this.call('tick');
        this.tickCount++;
        const events = new DataView(this.wasm.memory.buffer, this.call('events_ptr'), this.call('events_len'));
        this.progressEvents = [...(this.progressEvents ?? []), ...readProgressEvents(events, this.tickCount)].filter(e => this.tickCount - e.tick < 350).slice(-24);
      }
    } finally {
      for (const input of inputs) this.call('keyup', key[input]);
    }
    return this.state();
  }

  state(): GameState {
    if (!this.call('snapshot_player')) throw new Error('Doom player is not available');
    this.call('snapshot_settings');
    const p = new DataView(this.wasm.memory.buffer, this.call('player_snapshot_ptr'), 164);
    const s = new DataView(this.wasm.memory.buffer, this.call('settings_ptr'), 52);
    const mapIdentity = `${s.getInt32(4, true)}:${s.getInt32(8, true)}`;
    if (this.progressMap && this.progressMap !== mapIdentity) this.progressEvents = [];
    this.progressMap = mapIdentity;
    const n = (offset: number) => p.getInt32(offset, true);
    const count = this.call('snapshot_map_objects');
    const objects = new DataView(this.wasm.memory.buffer, this.call('map_objects_ptr'), count * 32);
    const entities = readEntities(objects, { x: n(128) / 65536, y: n(132) / 65536, z: n(136) / 65536, angle: p.getUint32(140, true) / 2 ** 32 * 360 });
    const within = entities.filter(e => e.distance <= 2048);
    return {
      keys: keyColors.filter((_, i) => Boolean(n(64) & ((1 << i) | (1 << (i + 3))))),
      progressEvents: structuredClone(this.progressEvents ?? []),
      keyPickups: within.filter(e => e.kind === 'pickup' && e.engineType >= 47 && e.engineType <= 52),
      z: n(136) / 65536,
      velocity: { x: n(144) / 65536, y: n(148) / 65536, z: n(152) / 65536 },
      enemies: within.filter(e => e.kind === 'enemy').slice(0, 16),
      projectiles: within.filter(e => e.kind === 'projectile').slice(0, 24),
      pickups: within.filter(e => e.kind === 'pickup').slice(0, 16),
      telemetry: { radius: 2048, lineOfSightKnown: false, engineObjectCount: count },
      tick: this.tickCount, health: n(0), armor: n(4), kills: n(28), items: n(32), secrets: n(36),
      weapon: weapons[n(12)] ?? 'unknown',
      weapons: weapons.filter((_, i) => Boolean(n(68) & (1 << i))),
      pendingWeapon: weapons[n(16)] ?? null,
      ...(this.acceptsWeaponInputs ? { weaponSelection: true as const } : {}),
      ammo: [72, 76, 80, 84].map(n), x: n(128) / 65536, y: n(132) / 65536,
      angle: p.getUint32(140, true) / 2 ** 32 * 360,
      episode: s.getInt32(4, true), map: s.getInt32(8, true),
      phase: (['level', 'intermission', 'finale', 'demo'] as const)[s.getInt32(0, true)] ?? 'demo',
      alive: n(0) > 0 && n(40) === 0,
    };
  }

  frame(): Buffer {
    const pixels = new Uint8Array(this.wasm.memory.buffer, this.call('get_framebuffer'), 320 * 200);
    const palette = new Uint8Array(this.wasm.memory.buffer, this.call('get_palette'), 768);
    const png = new PNG({ width: 320, height: 200 });
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i]! * 3;
      png.data[i * 4] = palette[c]!;
      png.data[i * 4 + 1] = palette[c + 1]!;
      png.data[i * 4 + 2] = palette[c + 2]!;
      png.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(png);
  }
}
