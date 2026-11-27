// Classic Snowdin Sans (моб).
// Уровень угрозы (опыт + убийства) -> ступени; на 4-й Санс дерётся: кости, бластеры, шипы, летающие кости, откидывание.
// Его можно ударить: он уворачивается 80 раз, потом выдыхается (или засыпает на 79-м) — тогда умирает с одного удара.
import { world, system, ItemStack } from "@minecraft/server";

const TYPE = "sansmode:snowdin_sans";

// ---- настройки ----
const KILLS_PER_LV = 3;           // сколько убийств = 1 уровень угрозы
const STAGE_LV = [5, 10, 15];     // <5 спокоен, 5-9 напряжён, 10-14 холодный, 15+ атакует
const WATCH_RANGE = 24;
const TALK_RANGE = 6;
const TALK_COOLDOWN = 600;        // тиков между репликами одному игроку
const ATTACK_RANGE = 20;
const ATTACK_COOLDOWN = 45;       // тиков между основными атаками
const TICK_STEP = 10;             // как часто Санс «думает»

const KNOCK_RANGE = 3;            // ближе — отталкивает
const KNOCK_POWER = 1.1;

// выбор основной атаки (сумма = 1): кость / бластер / шипы
const P_BONE = 0.35, P_BLASTER = 0.25, P_LIFT_BONES = 0.15; // остальное — шипы

const BONE_DAMAGE_ENTITY = "sansmode:snowdin_bone";

const SPIKE_COUNT = 5;            // шипов за волну
const SPIKE_RADIUS = 10;          // разброс вокруг игрока
const SPIKE_WARN = 12;            // тиков предупреждения (дым/звук)
const DMG = 3;                   // все атаки: 1.5 сердца
const WITHER_TICKS = 40;          // иссушение 2 сек после любой атаки
const BONE_SPEED = 2.9;          // было 2.3
const SPIKE_LAUNCH = 0.8;

const FLY_EVERY = [50, 90];       // тиков между летающими костями (мин, макс)
const FLY_HOVER = 14;             // тиков, пока кость «целится»
const FLY_SPEED = 0.5;            // блоков за тик (средняя скорость)
const FLY_MAX = 6;

const DODGE_ATTACK_UNLOCK = 40;   // две дополнительные атаки открываются после 40 уворотов
const DODGES_NEEDED = 100;        // уворотов до усталости
const SLEEP_AT = 99;
const BERSERK_AT = 65;             // после 65 уворотов: урон x1.7, скорость x1.5
const BERSERK_DAMAGE = 1.7;
const BERSERK_SPEED = 1.5;
const enraged = (s) => !!s && stateOf(s).dodges >= BERSERK_AT;
const attackDamage = (s, amount) => amount * (enraged(s) ? BERSERK_DAMAGE : 1);
const attackTicks = (s, ticks) => Math.max(1, Math.round(ticks / (enraged(s) ? BERSERK_SPEED : 1)));
const attackSpeed = (s, speed) => speed * (enraged(s) ? BERSERK_SPEED : 1);              // на этом уворте Санс может уснуть
const SLEEP_CHANCE = 0.5;
const WINDOW_TICKS = 200;         // 10 сек: окно, пока можно убить (сон / усталость)
const DODGE_STEP = [3, 5];        // на сколько блоков отпрыгивает
const SHOW_DODGE_COUNTER = false; // счётчик уворотов скрыт от игроков

const K_KILLS = "snowdin:kills";
const K_PEAK = "snowdin:peak_lv";

const safe = (f) => { try { return f(); } catch (_) { return undefined; } };
const ok = (e) => { try { return typeof e.isValid === "function" ? e.isValid() : !!e.isValid; } catch (_) { return false; } };
const rand = (a, b) => a + Math.random() * (b - a);
const fx = (dim, id, loc) => safe(() => dim.spawnParticle(id, loc));
const snd = (dim, name, loc, vol = 1, pitch = 1) =>
  safe(() => dim.runCommand(`playsound ${name} @a ${loc.x.toFixed(1)} ${loc.y.toFixed(1)} ${loc.z.toFixed(1)} ${vol} ${pitch}`));

const LINES = [
  [ // 0: спокоен
    "Привет. Классный денёк для прогулки, да?",
    "Не торопись. Тут можно просто посидеть и расслабиться.",
    "Папирус опять что-то готовит... держись подальше от кухни.",
    "Снег хрустит под ногами. Обожаю этот звук.",
  ],
  [ // 1: напряжён
    "Слушай... я краем глаза заметил, что ты кое с кем не церемонился.",
    "Я не из тех, кто ищет проблемы. Но если продолжишь... будет плохо. Просто предупреждаю.",
    "За всё приходится платить, знаешь ли. Я просто напоминаю.",
  ],
  [ // 2: холодный
    "...",
    "...ты сволочь.",
    "Лучше бы ты сюда не приходил.",
    "...",
  ],
  [ // 3: атакует
    "Ты зашёл слишком далеко.",
    "Это конец.",
  ],
];
const NAME = ["§bSans§r", "§bSans§r", "§8Sans§r", "§0§lSans§r"];
const stageOf = (lv) => (lv >= STAGE_LV[2] ? 3 : lv >= STAGE_LV[1] ? 2 : lv >= STAGE_LV[0] ? 1 : 0);

// ---- уровень угрозы: пик опыта (не падает от зачарований) + убийства ----
function readStats(p) {
  const kills = Number(safe(() => p.getDynamicProperty(K_KILLS))) || 0;
  let peak = Number(safe(() => p.getDynamicProperty(K_PEAK))) || 0;
  const lvl = Number(safe(() => p.level)) || 0;
  if (lvl > peak) { peak = lvl; safe(() => p.setDynamicProperty(K_PEAK, peak)); }
  return { kills, peak, lv: Math.max(peak, Math.floor(kills / KILLS_PER_LV)) };
}

// ---- состояние каждого Санса ----
// mode: guard (уворачивается) | sleep | tired; dodges: сколько уже было
const states = new Map();
const stateOf = (s) => {
  let st = states.get(s.id);
  if (!st) { st = { mode: "guard", dodges: 0, until: 0, lastDodge: -99, atkAt: 0, flyAt: 0, ult: false, ultCount: 0, kit: new Set() }; states.set(s.id, st); }
  return st;
};

const IGNORE = new Set(["minecraft:armor_stand", "minecraft:item", "minecraft:xp_orb", "minecraft:player", TYPE]);
world.afterEvents.entityDie.subscribe((ev) => {
  const id = safe(() => ev.deadEntity.typeId);
  if (id === TYPE) { states.delete(safe(() => ev.deadEntity.id)); return; }
  const killer = safe(() => ev.damageSource && ev.damageSource.damagingEntity);
  if (!killer || killer.typeId !== "minecraft:player") return;
  if (!id || IGNORE.has(id)) return;
  const n = (Number(safe(() => killer.getDynamicProperty(K_KILLS))) || 0) + 1;
  safe(() => killer.setDynamicProperty(K_KILLS, n));
});

// ---- помощники ----
function isEmptyBlock(b) {
  if (!b) return true;
  const air = typeof b.isAir === "function" ? b.isAir() : b.isAir;
  if (air) return true;
  const liquid = typeof b.isLiquid === "function" ? b.isLiquid() : b.isLiquid;
  const solid = typeof b.isSolid === "function" ? b.isSolid() : b.isSolid;
  return !liquid && solid === false;
}
function groundY(dim, x, y, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let yy = Math.floor(y) + 2; yy >= Math.floor(y) - 6; yy--) {
    const b = safe(() => dim.getBlock({ x: bx, y: yy, z: bz }));
    if (b && !isEmptyBlock(b)) return yy + 1;
  }
  return y;
}
function knock(ent, dx, dz, h, v) {
  try { ent.applyKnockback(dx, dz, h, v); }
  catch (_) { safe(() => ent.applyImpulse({ x: dx * h, y: v, z: dz * h })); }
}
function hurtPlayer(p, amount, source) {
  amount = attackDamage(source, amount);
  try { p.applyDamage(amount, { cause: "entityAttack", damagingEntity: source }); }
  catch (_) { safe(() => p.applyDamage(amount)); }
  safe(() => p.addEffect("wither", WITHER_TICKS, { amplifier: 0, showParticles: true }));
}
function nearestPlayer(s, r) {
  const list = safe(() => s.dimension.getPlayers({ location: s.location, maxDistance: r, closest: 1 })) || [];
  return list[0];
}
const say = (p, stage, line) => safe(() => p.sendMessage(NAME[stage] + ": " + line));

function setStage(s, stage) {
  const cur = safe(() => s.getComponent("minecraft:variant").value);
  if (cur === 5 || cur === 6) return;           // сон/усталость ведёт скрипт
  if (cur === 4 && stage === 3) return;         // вспышка голубого глаза
  if (cur !== stage) safe(() => s.triggerEvent("sansmode:stage_" + stage));
}


// ---- набор тому, кто ввязался в драку: красный нож (9999 урона, Санс всё равно уворачивается), 30 чар. яблок, баффы ----
const KIT_EFFECT_TICKS = 12000;   // 10 минут
function giveKit(p) {
  safe(() => {
    const inv = p.getComponent("minecraft:inventory").container;
    let knife = safe(() => new ItemStack("sansmode:red_knife", 1));
    if (!knife) { knife = new ItemStack("minecraft:netherite_sword", 1); knife.nameTag = "§cКрасный нож"; }  // запасной вариант, если кастомный предмет не загрузился
    inv.addItem(knife);
    inv.addItem(new ItemStack("minecraft:enchanted_golden_apple", 30));
  });
  safe(() => p.addEffect("regeneration", KIT_EFFECT_TICKS, { amplifier: 2, showParticles: false }));  // Регенерация III
  safe(() => p.addEffect("speed", KIT_EFFECT_TICKS, { amplifier: 1, showParticles: false }));         // Скорость II
  safe(() => p.addEffect("jump_boost", KIT_EFFECT_TICKS, { amplifier: 1, showParticles: false }));    // Прыжок II
  safe(() => p.sendMessage("§c[ ! ] §7Ты ввязался в драку с Сансом. Тебе выдан §cКрасный нож§7 и припасы."));
}
function engage(s, p) {
  if (!p || safe(() => p.typeId) !== "minecraft:player") return;
  const st = stateOf(s);
  if (st.kit.has(p.id)) return;
  st.kit.add(p.id);
  giveKit(p);
}

// иссушение на 2 сек от снарядов Санса (кость, бластер) — вдобавок к урону
const WITHER_SOURCES = new Set([BONE_DAMAGE_ENTITY, "sansmode:snowdin_blast", "sansmode:snowdin_gb"]);
if (world.afterEvents.entityHurt) {
  world.afterEvents.entityHurt.subscribe((ev) => {
    const v = ev.hurtEntity;
    if (!v || safe(() => v.typeId) !== "minecraft:player") return;
    const ds = ev.damageSource;
    const proj = safe(() => ds.damagingProjectile.typeId), src = safe(() => ds.damagingEntity.typeId);
    if (WITHER_SOURCES.has(proj) || WITHER_SOURCES.has(src)) safe(() => v.addEffect("wither", WITHER_TICKS, { amplifier: 0, showParticles: true }));
    // Урон снарядов задан в entity JSON, поэтому добавляем бонус 70% после попадания.
    if (proj === BONE_DAMAGE_ENTITY || proj === "sansmode:snowdin_blast") {
      const owner = safe(() => v.dimension.getEntities({ type: TYPE, location: v.location, maxDistance: 32, closest: 1 }))?.[0];
      if (owner && enraged(owner)) safe(() => v.applyDamage(3 * (BERSERK_DAMAGE - 1)));
    }
  });
}

// ---- увороты ----
function registerDodge(s, attacker) {
  if (!ok(s)) return;
  const variant = safe(() => s.getComponent("minecraft:variant").value);
  // До четвёртой стадии Санс не вступает в бой и не принимает удары.
  if (variant !== 3) return;
  engage(s, attacker || nearestPlayer(s, 16));
  const st = stateOf(s), t = system.currentTick;
  if (st.mode !== "guard") return;
  if (t - st.lastDodge < 4) return;             // один и тот же удар из нескольких источников считаем один раз
  st.lastDodge = t;
  st.dodges++;

  const dim = s.dimension, from = s.location;
  const a = rand(0, Math.PI * 2), d = rand(DODGE_STEP[0], DODGE_STEP[1]);
  const x = from.x + Math.cos(a) * d, z = from.z + Math.sin(a) * d;
  const y = groundY(dim, x, from.y, z);
  for (let k = 0; k < 4; k++) fx(dim, "minecraft:basic_smoke_particle", { x: from.x + rand(-0.4, 0.4), y: from.y + rand(0.2, 1.6), z: from.z + rand(-0.4, 0.4) });
  safe(() => s.teleport({ x, y, z }));
  snd(dim, "mob.endermen.portal", { x, y, z }, 0.4, 1.6);

  const p = nearestPlayer(s, 16);
  if (SHOW_DODGE_COUNTER && p) safe(() => p.onScreenDisplay.setActionBar(`§7Уворот ${st.dodges}/${DODGES_NEEDED}`));

  if (st.dodges >= DODGES_NEEDED) {
    st.mode = "tired"; st.until = t + WINDOW_TICKS;
    safe(() => s.triggerEvent("sansmode:tired"));
    safe(() => s.triggerEvent("sansmode:vulnerable_on"));
    if (p) say(p, 0, "...хах... я... выдохся.");
  } else if (st.dodges === SLEEP_AT && Math.random() < SLEEP_CHANCE) {
    st.mode = "sleep"; st.until = t + WINDOW_TICKS;
    safe(() => s.triggerEvent("sansmode:sleep"));
    safe(() => s.triggerEvent("sansmode:vulnerable_on"));
    if (p) say(p, 0, "...zzz...");
  }
}

// команда /scriptevent snowdin:dodge прилетает из события сущности (on_damage)
// + страховка: ближний удар и снаряд, которые сам Санс мог не отразить событием
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const h = ev.hitEntity;
  if (h && safe(() => h.typeId) === TYPE) registerDodge(h, ev.damagingEntity);
});
if (world.afterEvents.projectileHitEntity) {
  world.afterEvents.projectileHitEntity.subscribe((ev) => {
    const h = safe(() => ev.getEntityHit().entity);
    if (h && safe(() => h.typeId) === TYPE) registerDodge(h, safe(() => ev.source));
  });
}

function wake(s, st) {
  st.mode = "guard"; st.dodges = 0;
  safe(() => s.triggerEvent("sansmode:vulnerable_off"));
  safe(() => s.triggerEvent("sansmode:stage_3"));
}

// ---- атаки ----
function throwBone(s, p) {
  const sl = s.location, pl = p.location;
  const from = { x: sl.x, y: sl.y + 1.3, z: sl.z };
  let dx = pl.x - from.x, dy = (pl.y + 1.0) - from.y, dz = pl.z - from.z;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  safe(() => s.teleport(sl, { facingLocation: pl }));
  const at = { x: from.x + dx * 1.2, y: from.y + dy * 1.2, z: from.z + dz * 1.2 };
  const bone = safe(() => s.dimension.spawnEntity(BONE_DAMAGE_ENTITY, at));
  if (!bone) return;
  const boneSpeed = attackSpeed(s, BONE_SPEED);
  const v = { x: dx * boneSpeed, y: dy * boneSpeed, z: dz * boneSpeed };
  const pc = safe(() => bone.getComponent("minecraft:projectile"));
  if (!(pc && safe(() => { pc.shoot(v); return true; }))) safe(() => bone.applyImpulse(v));
  safe(() => s.triggerEvent("sansmode:blue_eye"));
  system.runTimeout(() => { if (ok(s) && stateOf(s).mode === "guard") safe(() => s.triggerEvent("sansmode:stage_3")); }, 12);
  safe(() => s.dimension.playSound("random.bow", sl));
}

// Подбрасывание игрока и костяные шипы под точкой взлёта.
function liftAndBoneTrap(s, p) {
  if (!ok(s) || !ok(p)) return;
  const dim = s.dimension;
  const start = { x: p.location.x, y: p.location.y, z: p.location.z };
  // Подброс примерно на 10 блоков, затем резкий переход к падению.
  safe(() => p.applyImpulse({ x: 0, y: 1.35, z: 0 }));
  snd(dim, "mob.enderdragon.flap", start, 1, 0.8);
  fx(dim, "minecraft:totem_particle", { x: start.x, y: start.y + 0.2, z: start.z });
  const offsets = [
    [0, 0], [1.8, 0], [-1.8, 0], [0, 1.8], [0, -1.8]
  ];
  for (const [ox, oz] of offsets) {
    const x = start.x + ox, z = start.z + oz;
    const y = groundY(dim, x, start.y, z);
    for (let k = 0; k < 3; k++) fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
    system.runTimeout(() => {
      if (!ok(s) || spikes.length > 24) return;
      const ent = safe(() => dim.spawnEntity("playersans:bone_spike", { x, y, z }));
      if (ent) spikes.push({
        ent, dim, x, y, z, born: system.currentTick, hit: new Set(), owner: s,
        life: 64, activeFrom: 2, activeTo: 58
      });
    }, 14);
  }
  // На вершине траектории резко отправляем цель вниз.
  system.runTimeout(() => {
    if (ok(p)) safe(() => p.applyImpulse({ x: 0, y: -1.35, z: 0 }));
  }, 23);
  // Непосредственно перед приземлением замедляем падение: эффект предотвращает урон от падения.
  system.runTimeout(() => {
    if (ok(p)) safe(() => p.addEffect("slow_falling", 35, { amplifier: 0, showParticles: false }));
  }, 29);
}

// Обычная атака бластером: d_gb сам ищет цель с тегом pst, сам стреляет и самонаводится (так задумано).
// Берём клон sansmode:snowdin_gb — тот же бластер, но стреляет слабым снарядом snowdin_blast (1.5 сердца).
let activeBlasters = 0;
function fireBlaster(s, p) {
  const pl = p.location, dim = s.dimension;
  const a = rand(0, Math.PI * 2);
  const at = { x: pl.x + Math.cos(a) * 4, y: pl.y + 2.2, z: pl.z + Math.sin(a) * 4 };
  safe(() => p.addTag("pst"));
  const gb = safe(() => dim.spawnEntity("sansmode:snowdin_gb", at));
  if (!gb) { if (activeBlasters === 0) safe(() => p.removeTag("pst")); return; }
  activeBlasters++;
  snd(dim, "random.bow", at, 0.8, 0.6);
  system.runTimeout(() => {
    if (ok(gb)) safe(() => gb.remove());
    activeBlasters = Math.max(0, activeBlasters - 1);
    if (activeBlasters === 0 && ok(p)) safe(() => p.removeTag("pst"));
  }, 80);
}

// Крест бластеров (как в комбо/финале Classic Sans): 4 бластера со всех сторон, прицел фиксируется один раз
// и больше не меняется (без самонаведения), потом луч. Урон считаем сами.
const CROSS = { R: 7.5, H: 1.0, LOCK: 14, FIRE: 28, BEAM: 8, BEAM_R: 1.1, BEAM_LEN: 28 };
const crossBlasters = [];
const v3 = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  mul: (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  norm: (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
};
function crossVolley(s, p, ult) {
  const dim = s.dimension, t = system.currentTick, base = rand(0, Math.PI * 2);
  const tc = { x: p.location.x, y: p.location.y + 0.9, z: p.location.z };
  for (let k = 0; k < 4; k++) {
    const ang = base + (k * Math.PI) / 2;
    const pos = { x: tc.x + Math.cos(ang) * CROSS.R, y: tc.y + CROSS.H, z: tc.z + Math.sin(ang) * CROSS.R };
    const ent = safe(() => dim.spawnEntity("playersans:ult_blaster", pos));
    if (!ent) continue;
    safe(() => ent.teleport(pos, { facingLocation: tc }));
    snd(dim, "mob.endermen.portal", pos, 0.8, 0.6);
    crossBlasters.push({ ent, dim, pos, ang, p, s, tc, ult, lockAt: t + CROSS.LOCK, fireAt: t + CROSS.FIRE, endAt: 0, state: "orbit", dir: null, hit: false });
  }
}
function removeCross(ult) {
  for (let i = crossBlasters.length - 1; i >= 0; i--) {
    if (crossBlasters[i].ult === ult) { safe(() => crossBlasters[i].ent.remove()); crossBlasters.splice(i, 1); }
  }
}
function tickCross(t) {
  for (let i = crossBlasters.length - 1; i >= 0; i--) {
    const b = crossBlasters[i];
    if (!ok(b.ent)) { crossBlasters.splice(i, 1); continue; }
    if (b.state === "orbit") {                     // пока не зафиксировал — стоит на своём месте креста и смотрит на цель
      if (ok(b.p)) {
        b.tc = { x: b.p.location.x, y: b.p.location.y + 0.9, z: b.p.location.z };
        b.pos = { x: b.tc.x + Math.cos(b.ang) * CROSS.R, y: b.tc.y + CROSS.H, z: b.tc.z + Math.sin(b.ang) * CROSS.R };
        safe(() => b.ent.teleport(b.pos, { facingLocation: b.tc }));
      }
      if (t >= b.lockAt) {                         // прицел фиксируется здесь и больше не меняется
        b.state = "locked"; b.aim = { ...b.tc };
        b.dir = v3.norm(v3.sub(b.aim, v3.add(b.pos, { x: 0, y: 0.3, z: 0 })));
        safe(() => b.ent.teleport(b.pos, { facingLocation: b.aim }));
        safe(() => b.ent.triggerEvent("playersans:charge"));
        snd(b.dim, "beacon.activate", b.pos, 1, 1.4);
      }
      continue;
    }
    const origin = v3.add(b.pos, { x: 0, y: 0.3, z: 0 });
    if (b.state === "locked") {
      if (t % 2 === 0) {                           // телеграф: линия и точка прицеливания
        for (let k = 2; k <= 24; k += 4) fx(b.dim, "minecraft:villager_angry", v3.add(origin, v3.mul(b.dir, k)));
        fx(b.dim, "minecraft:basic_flame_particle", b.aim);
      }
      if (t >= b.fireAt) {
        b.state = "fire"; b.endAt = t + (b.beamTicks ?? CROSS.BEAM);
        safe(() => b.ent.teleport(b.pos, { facingLocation: v3.add(b.pos, b.dir) }));
        safe(() => b.ent.triggerEvent("playersans:fire"));
        snd(b.dim, "mob.warden.sonic_boom", b.pos, 2, 1);
      }
      continue;
    }
    if (t >= b.endAt) { safe(() => b.ent.remove()); crossBlasters.splice(i, 1); continue; }
    if (!b.hit && ok(b.p)) {
      const c = { x: b.p.location.x, y: b.p.location.y + 0.9, z: b.p.location.z };
      const rel = v3.sub(c, origin);
      const along = Math.max(0, Math.min(CROSS.BEAM_LEN, rel.x * b.dir.x + rel.y * b.dir.y + rel.z * b.dir.z));
      const closest = v3.add(origin, v3.mul(b.dir, along));
      if (v3.len(v3.sub(c, closest)) <= CROSS.BEAM_R) {
        b.hit = true;
        hurtPlayer(b.p, DMG, ok(b.s) ? b.s : undefined);
        knock(b.p, b.dir.x, b.dir.z, 0.6, 0.3);
        fx(b.dim, "minecraft:basic_flame_particle", c);
      }
    }
  }
}

// Шипы: появляются из-под земли в радиусе вокруг игрока
const spikes = [];
function spikeWave(s, p) {
  const dim = s.dimension, pl = p.location;
  const warnTicks = attackTicks(s, SPIKE_WARN);
  safe(() => s.teleport(s.location, { facingLocation: pl }));
  for (let i = 0; i < SPIKE_COUNT; i++) {
    let x, z;
    if (i === 0) { const a = rand(0, Math.PI * 2), r = rand(0.3, 2); x = pl.x + Math.cos(a) * r; z = pl.z + Math.sin(a) * r; }
    else { const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * SPIKE_RADIUS; x = pl.x + Math.cos(a) * r; z = pl.z + Math.sin(a) * r; }
    const y = groundY(dim, x, pl.y, z);
    for (let k = 0; k < 3; k++) fx(dim, "minecraft:basic_smoke_particle", { x: x + rand(-0.4, 0.4), y: y + 0.1, z: z + rand(-0.4, 0.4) });
    snd(dim, "dig.stone", { x, y, z }, 0.7, 1.5);
    system.runTimeout(() => {
      if (!ok(s) || spikes.length > 24) return;
      const ent = safe(() => dim.spawnEntity("playersans:bone_spike", { x, y, z }));
      if (!ent) return;
      snd(dim, "dig.stone", { x, y, z }, 1, 0.8);
      spikes.push({ ent, dim, x, y, z, born: system.currentTick, hit: new Set(), owner: s });
    }, warnTicks + attackTicks(s, i * 2));
  }
}
function tickSpikes(t) {
  for (let i = spikes.length - 1; i >= 0; i--) {
    const sp = spikes[i], age = t - sp.born;
    if (!ok(sp.ent) || age >= (sp.life ?? 24)) { safe(() => sp.ent.remove()); spikes.splice(i, 1); continue; }
    if (age < (sp.activeFrom ?? 2) || age > (sp.activeTo ?? 12)) continue;
    for (const pl of safe(() => sp.dim.getPlayers({ location: { x: sp.x, y: sp.y, z: sp.z }, maxDistance: 3 })) || []) {
      if (sp.hit.has(pl.id)) continue;
      const l = pl.location;
      if (Math.hypot(l.x - sp.x, l.z - sp.z) > 1.1) continue;
      if (l.y > sp.y + 2.2 || l.y < sp.y - 1.7) continue;
      sp.hit.add(pl.id);
      hurtPlayer(pl, DMG, ok(sp.owner) ? sp.owner : undefined);
      knock(pl, 0, 0, 0, SPIKE_LAUNCH);
    }
  }
}

// Летающие кости (как в Final Attack): появляются рядом, на миг зависают, затем летят в игрока
const flyBones = [];
function spawnFlyBone(s, p) {
  if (flyBones.length >= FLY_MAX) return;
  const dim = s.dimension, pl = p.location;
  const a = rand(0, Math.PI * 2), r = rand(6, 9);
  const from = { x: pl.x + Math.cos(a) * r, y: pl.y + rand(0.8, 1.8), z: pl.z + Math.sin(a) * r };
  const ent = safe(() => dim.spawnEntity("playersans:flying_bone", from));
  if (!ent) return;
  snd(dim, "mob.skeleton.step", from, 1, 1.2);
  fx(dim, "minecraft:basic_flame_particle", from);
  flyBones.push({ ent, dim, pos: { ...from }, target: p, born: system.currentTick, vel: null, owner: s, hover: attackTicks(s, FLY_HOVER), speed: attackSpeed(s, FLY_SPEED) });
}
function tickFlyBones(t) {
  for (let i = flyBones.length - 1; i >= 0; i--) {
    const b = flyBones[i], age = t - b.born;
    if (!ok(b.ent) || age > 120) { safe(() => b.ent.remove()); flyBones.splice(i, 1); continue; }
    if (!b.vel) {
      if (ok(b.target)) { const tl = b.target.location; safe(() => b.ent.teleport(b.pos, { facingLocation: { x: tl.x, y: tl.y + 1, z: tl.z } })); }
      if (age >= (b.hover ?? FLY_HOVER) && ok(b.target)) {
        const tl = b.target.location;
        let dx = tl.x - b.pos.x, dy = tl.y + 1 - b.pos.y, dz = tl.z - b.pos.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        const spd = b.speed ?? FLY_SPEED;
        b.vel = { x: (dx / l) * spd, y: (dy / l) * spd, z: (dz / l) * spd };
      } else if (age >= (b.hover ?? FLY_HOVER)) { safe(() => b.ent.remove()); flyBones.splice(i, 1); }
      continue;
    }
    b.pos = { x: b.pos.x + b.vel.x, y: b.pos.y + b.vel.y, z: b.pos.z + b.vel.z };
    safe(() => b.ent.teleport(b.pos, { facingLocation: { x: b.pos.x + b.vel.x, y: b.pos.y + b.vel.y, z: b.pos.z + b.vel.z } }));
    let hit = false;
    for (const pl of safe(() => b.dim.getPlayers({ location: b.pos, maxDistance: 2 })) || []) {
      const l = pl.location;
      if (Math.hypot(l.x - b.pos.x, l.z - b.pos.z) > 0.9) continue;
      if (b.pos.y < l.y - 0.4 || b.pos.y > l.y + 2.0) continue;
      hurtPlayer(pl, DMG, ok(b.owner) ? b.owner : undefined);
      hit = true;
      break;
    }
    if (hit) { safe(() => b.ent.remove()); flyBones.splice(i, 1); }
  }
}

function knockBack(s, p) {
  const dx = p.location.x - s.location.x, dz = p.location.z - s.location.z;
  const l = Math.hypot(dx, dz) || 1;
  knock(p, dx / l, dz / l, KNOCK_POWER, 0.35);
}


// ---- УЛЬТА: настоящая блочная платформа (как у Dust / Last Breath) — левитация, костяные блоки под
// ногами, площадка едет туда-сюда; сверху медленно падает кость; периодически стреляют бластеры ----
const ULT = {
  CHANCE: 0.15, COOLDOWN: 600, DURATION: 220,
  SIZE: 2, LIFT: 5, LIFT_TICKS: 10, MOVE_EVERY: 16, BLOCK: "minecraft:bone_block",
  BONE_EVERY: 50, BONE_DROP: 0.12, BLAST_EVERY: 60,
};
const PLAT_MOVE = [1, 2, 1, 0, -1, -2, -1, 0];
const ults = [];

function platSet(u, ox, oz) {
  for (const b of u.plat) safe(() => { const bl = u.dim.getBlock(b); if (bl && bl.typeId === ULT.BLOCK) bl.setType("minecraft:air"); });
  u.plat = [];
  for (let dx = -ULT.SIZE; dx <= ULT.SIZE; dx++) for (let dz = -ULT.SIZE; dz <= ULT.SIZE; dz++) {
    const pos = { x: u.cx + ox + dx, y: u.by, z: u.cz + oz + dz };
    safe(() => { const bl = u.dim.getBlock(pos); if (bl && isEmptyBlock(bl)) { bl.setType(ULT.BLOCK); u.plat.push(pos); } });
  }
  u.ox = ox; u.oz = oz;
}

function startUlt(s, p) {
  const dim = s.dimension, pl = p.location, t = system.currentTick;
  const u = {
    s, p, dim, born: t, cx: Math.floor(pl.x), cz: Math.floor(pl.z), by: Math.floor(pl.y) + ULT.LIFT - 1,
    mv: Math.random() < 0.5 ? { x: 1, z: 0 } : { x: 0, z: 1 }, step: 0, plat: [], bone: null, lastBlast: t, placed: false,
  };
  ults.push(u);
  const ss = stateOf(s); ss.ult = true; ss.ultCount++; ss.ultAt = t + ULT.COOLDOWN;
  safe(() => p.addEffect("levitation", ULT.LIFT_TICKS, { amplifier: 8, showParticles: true }));
  fx(dim, "minecraft:totem_particle", pl);
  snd(dim, "mob.wither.shoot", pl, 1.3, 0.8);
  say(p, 3, "Ты думал, что это будет просто?");
}

function endUlt(u) {
  removeCross(u);
  for (const b of u.plat) safe(() => { const bl = u.dim.getBlock(b); if (bl && bl.typeId === ULT.BLOCK) bl.setType("minecraft:air"); });
  u.plat = [];
  if (u.bone && ok(u.bone)) safe(() => u.bone.remove());
  if (ok(u.p)) safe(() => u.p.addEffect("slow_falling", 100, { amplifier: 0, showParticles: false })); // мягко спустится, если платформа исчезла под ногами
  if (ok(u.s)) stateOf(u.s).ult = false;
}

function tickUlts(t) {
  for (let i = ults.length - 1; i >= 0; i--) {
    const u = ults[i], age = t - u.born;
    if (!ok(u.s) || !ok(u.p) || age > ULT.DURATION) { endUlt(u); ults.splice(i, 1); continue; }

    if (!u.placed && age >= ULT.LIFT_TICKS) {
      u.placed = true;
      platSet(u, 0, 0);
      safe(() => u.p.removeEffect("levitation"));
      safe(() => u.p.teleport({ x: u.cx + 0.5, y: u.by + 1, z: u.cz + 0.5 }));
      snd(u.dim, "dig.stone", u.p.location, 1, 0.7);
    }
    if (!u.placed) continue;

    if (age % 3 === 0 && ok(u.p) && u.p.location.y < u.by + 0.4) {   // упал на землю — обратно на платформу
      safe(() => u.p.teleport({ x: u.cx + 0.5 + (u.ox || 0), y: u.by + 1, z: u.cz + 0.5 + (u.oz || 0) }));
      snd(u.dim, "mob.endermen.portal", u.p.location, 0.6, 1.4);
    }
    if (age % ULT.MOVE_EVERY === 0) {
      u.step++;
      const off = PLAT_MOVE[u.step % PLAT_MOVE.length];
      platSet(u, u.mv.x * off, u.mv.z * off);
    }
    // кость сверху, медленно опускается на игрока
    if (!u.bone && age % ULT.BONE_EVERY === 0) {
      const pl = u.p.location;
      u.bone = safe(() => u.dim.spawnEntity("playersans:flying_bone", { x: pl.x, y: pl.y + 9, z: pl.z }));
    }
    if (u.bone && ok(u.bone)) {
      const pl = u.p.location;
      const b = u.bone.location;
      const ny = b.y - ULT.BONE_DROP;
      safe(() => u.bone.teleport({ x: pl.x, y: ny, z: pl.z }, { facingLocation: { x: pl.x, y: ny - 1, z: pl.z } }));
      if (ny <= pl.y + 1.2) { hurtPlayer(u.p, DMG, ok(u.s) ? u.s : undefined); safe(() => u.bone.remove()); u.bone = null; }
    } else u.bone = null;
    // крест бластеров (прицел фиксируется, без самонаведения)
    if (t - u.lastBlast >= ULT.BLAST_EVERY) { u.lastBlast = t; crossVolley(u.s, u.p, u); }
  }
}

// ---- мозг Санса ----
// Средняя атака: кольцо костяных шипов с коротким предупреждением и последовательным появлением.
function dodgeBoneRing(s, p) {
  const dim = s.dimension, center = p.location, count = 8, radius = 3.6;
  const bornAt = system.currentTick;
  say(p, 3, "Кости повсюду. Посмотрим, куда ты побежишь.");
  snd(dim, "mob.wither.shoot", center, 0.9, 1.25);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = center.x + Math.cos(a) * radius;
    const z = center.z + Math.sin(a) * radius;
    const y = groundY(dim, x, center.y, z);
    for (let k = 0; k < 4; k++) {
      const t = bornAt + 12 + i * 2 + k * 3;
      system.runTimeout(() => fx(dim, "minecraft:villager_angry", { x, y: y + 0.1, z }), Math.max(1, t - system.currentTick));
    }
    system.runTimeout(() => {
      if (!ok(s) || spikes.length >= 40) return;
      const ent = safe(() => dim.spawnEntity("playersans:bone_spike", { x, y, z }));
      if (ent) spikes.push({
        ent, dim, x, y, z, born: system.currentTick, hit: new Set(), owner: s,
        life: 52, activeFrom: 2, activeTo: 46
      });
      snd(dim, "dig.stone", { x, y, z }, 0.75, 1.15);
    }, 12 + i * 2);
  }
}

// Сложная атака: шесть бластеров окружают цель и стреляют веером с небольшими интервалами.
function dodgeSixBlasters(s, p) {
  const dim = s.dimension, t = system.currentTick;
  const tc = { x: p.location.x, y: p.location.y + 0.9, z: p.location.z };
  const base = rand(0, Math.PI * 2);
  const attackId = "dodge40:" + s.id + ":" + t;
  say(p, 3, "Не успеешь увернуться от всех.");
  snd(dim, "mob.wither.spawn", tc, 0.9, 1.35);
  for (let k = 0; k < 6; k++) {
    const ang = base + (k * Math.PI) / 3;
    const pos = { x: tc.x + Math.cos(ang) * 8.5, y: tc.y + (k % 2 ? 1.4 : 0.7), z: tc.z + Math.sin(ang) * 8.5 };
    const ent = safe(() => dim.spawnEntity("playersans:ult_blaster", pos));
    if (!ent) continue;
    safe(() => ent.teleport(pos, { facingLocation: tc }));
    snd(dim, "mob.endermen.portal", pos, 0.55, 0.8 + k * 0.04);
    crossBlasters.push({
      ent, dim, pos, ang, p, s, tc: { ...tc }, ult: attackId,
      lockAt: t + attackTicks(s, 12 + k * 3), fireAt: t + attackTicks(s, 27 + k * 3),
      beamTicks: attackTicks(s, CROSS.BEAM), endAt: 0, state: "orbit", dir: null, hit: false
    });
  }
}

function tickSans(s) {
  const t = system.currentTick;
  const st = stateOf(s);

  if (st.mode !== "guard") {                    // спит или выдохся: только ждём окно
    if (st.mode === "sleep" && t % 20 < TICK_STEP) {
      const l = s.location;
      fx(s.dimension, "sansmode:sleep_z", { x: l.x + 0.2, y: l.y + 1.9, z: l.z });
    }
    if (t >= st.until) wake(s, st);
    return;
  }

  const p = nearestPlayer(s, WATCH_RANGE);
  if (!p) return;
  const { lv } = readStats(p);
  const stage = stageOf(lv);
  setStage(s, stage);
  if (st.ult) return;
  const dist = Math.hypot(p.location.x - s.location.x, p.location.y - s.location.y, p.location.z - s.location.z);

  if (stage === 3) {
    if (!st.announced && dist <= TALK_RANGE * 2) { st.announced = true; say(p, 3, LINES[3][0]); }
    if (dist < KNOCK_RANGE) knockBack(s, p);
    if (dist <= ATTACK_RANGE && t >= st.atkAt) {
      st.atkAt = t + attackTicks(s, ATTACK_COOLDOWN);
      if (st.ultCount < 5 && st.dodges >= 50 && Math.random() < ULT.CHANCE && t >= (st.ultAt || 0)) { startUlt(s, p); return; }
      // После 40 успешных уворотов Санс начинает чередовать две новые атаки.
      if (st.dodges >= DODGE_ATTACK_UNLOCK && t >= (st.specialAt || 0) && Math.random() < 0.4) {
        st.specialAt = t + 100;
        st.specialCount = (st.specialCount || 0) + 1;
        if (st.specialCount % 2 === 1) dodgeBoneRing(s, p);
        else dodgeSixBlasters(s, p);
        return;
      }
      const r = Math.random();
      if (r < P_BONE) throwBone(s, p);
      else if (r < P_BONE + P_BLASTER) fireBlaster(s, p);
      else if (r < P_BONE + P_BLASTER + P_LIFT_BONES) liftAndBoneTrap(s, p);
      else spikeWave(s, p);
    }
    if (dist <= 30 && t >= st.flyAt) {
      st.flyAt = t + attackTicks(s, Math.floor(rand(FLY_EVERY[0], FLY_EVERY[1])));
      spawnFlyBone(s, p);
    }
    return;
  }
  if (dist <= TALK_RANGE) {
    const key = s.id + ":" + p.id;
    if (t >= (talkAt.get(key) || 0)) {
      talkAt.set(key, t + TALK_COOLDOWN);
      const pool = LINES[stage];
      say(p, stage, pool[Math.floor(Math.random() * pool.length)]);
    }
  }
}
const talkAt = new Map();

system.runInterval(() => {
  for (const name of ["overworld", "nether", "the_end"]) {
    const dim = safe(() => world.getDimension(name));
    if (!dim) continue;
    for (const s of safe(() => dim.getEntities({ type: TYPE })) || []) safe(() => tickSans(s));
  }
}, TICK_STEP);

system.runInterval(() => {
  const t = system.currentTick;
  if (spikes.length) tickSpikes(t);
  if (flyBones.length) tickFlyBones(t);
  if (ults.length) tickUlts(t);
  if (crossBlasters.length) tickCross(t);
}, 1);

// ---- команды /scriptevent ----
// snowdin:status | snowdin:setlv N | snowdin:reset | snowdin:dodges N (ближайшему Сансу)
const se = system.afterEvents && system.afterEvents.scriptEventReceive;
if (se) {
  se.subscribe((ev) => {
    if (!ev.id.startsWith("snowdin:")) return;
    const cmd = ev.id.slice(8);
    const src = ev.sourceEntity;
    if (cmd === "dodge") {                       // от самого Санса (on_damage)
      if (src && safe(() => src.typeId) === TYPE) registerDodge(src);
      return;
    }
    if (!src || src.typeId !== "minecraft:player") return;
    const p = src;
    if (cmd === "status") {
      const st = readStats(p);
      const sans = safe(() => p.dimension.getEntities({ type: TYPE, location: p.location, maxDistance: 40, closest: 1 }))?.[0];
      const ss = sans ? stateOf(sans) : null;
      p.sendMessage(`§7LV ${st.lv} (пик ${st.peak}, убийств ${st.kills}) → ступень ${stageOf(st.lv)}` + (ss ? ` | Санс: ${ss.mode}, уворотов ${ss.dodges}/${DODGES_NEEDED}` : ""));
    } else if (cmd === "setlv") {
      const n = Math.max(0, parseInt(ev.message, 10) || 0);
      safe(() => p.setDynamicProperty(K_PEAK, n));
      safe(() => p.setDynamicProperty(K_KILLS, n * KILLS_PER_LV));
      p.sendMessage(`§7LV теперь ${n}`);
    } else if (cmd === "reset") {
      safe(() => p.setDynamicProperty(K_PEAK, 0));
      safe(() => p.setDynamicProperty(K_KILLS, 0));
      p.sendMessage("§7Счётчики сброшены");
    } else if (cmd === "dodges") {
      const sans = safe(() => p.dimension.getEntities({ type: TYPE, location: p.location, maxDistance: 40, closest: 1 }))?.[0];
      if (!sans) return p.sendMessage("§7Санса рядом нет");
      const n = Math.max(0, parseInt(ev.message, 10) || 0);
      stateOf(sans).dodges = n;
      p.sendMessage(`§7Уворотов у Санса: ${n}`);
    }
  });
}
