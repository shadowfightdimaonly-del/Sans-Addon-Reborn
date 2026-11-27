// ============================================================================
//  Sans mode: «Костяные шипы» (bone_spikes) и «Последняя атака» (final_attack)
//
//  Как это работает:
//   1. Предмет удерживается и отпускается (как d_gb / trial_time).
//   2. Контроллер анимации (animation_controllers/sans.json, psansitem) при
//      отпускании вешает на игрока тег sans_cast_spikes / sans_cast_ult.
//   3. Этот скрипт каждый тик ловит тег, проверяет стамину (variant 300..336),
//      списывает её событием игрока и запускает атаку.
//
//  Trial Time («Время суда») и Gravity («Гравитация»):
//   - Trial Time: списывает 5,5 сердец стамины и на 30 с включает режим:
//       стамина на остальные атаки не тратится, скин меняется (глаза),
//       урон всех способностей +1 сердце. Таймер и теги ведёт этот скрипт.
//   - Gravity выдаётся на время режима и работает только в нём: все существа
//       в радиусе 7 блоков отбрасываются на 8 блоков.
//
//  Все числа ниже можно менять.
// ============================================================================
import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";

const CFG = {
  // Бить ли других игроков (по умолчанию да — как и остальные атаки мода).
  HIT_PLAYERS: true,
  // Тип урона: "magic" игнорирует броню (незерит почти не режет урон). "entityAttack" — броня работает.
  DAMAGE_CAUSE: "magic",
  // Эти существа не выбираются целями «Последней атаки» и комбо (шипы и стены бьют всех). Железные големы — цели.
  SPARE_TYPES: ["minecraft:villager", "minecraft:villager_v2", "minecraft:wandering_trader", "minecraft:cat", "minecraft:npc"],

  SPIKES: {
    COST: 2,            // стамина (2 = 1 сердце)
    COUNT: 8,           // костей в ряду
    START: 1.8,         // расстояние до первой кости
    SPACING: 1.6,       // шаг между костями
    STEP: 2,            // тиков между появлением соседних костей (волна)
    WARN: 8,            // тиков предупреждения (трещина/дым) до появления кости
    DAMAGE: 10,         // 5 сердец
    LAUNCH: 0.8,        // подброс
    COOLDOWN: 30,       // тиков
    LIFE: 24,           // тиков жизни кости (анимация подъёма/спуска на клиенте 1.2 c)
    ACTIVE_FROM: 3,
    ACTIVE_TO: 16,
    HIT_R: 0.85,
    HEIGHT: 2.3,
  },

  WALL: {
    COST: 4,            // 2 сердца стамины
    DIST: 2.5,          // расстояние от игрока до стены
    HALF_WIDTH: 5.4,    // полуширина (общая ширина ~11 блоков)
    SPACING: 0.6,       // шаг между костями в ряду
    ROWS: 2,            // толщина стены (рядов костей, со смещением)
    ROW_GAP: 0.5,
    WARN: 6,
    LIFE: 82,           // тиков (~4 с)
    DAMAGE: 5,          // 2,5 сердца
    PUSH: 1.7,          // откидывание при ударе (обычные мобы ~0.4-0.5)
    REPEL: 1.0,         // повторное отталкивание, если лезут сквозь стену
    HIT_R: 0.75,
    HEIGHT: 2.3,
    COOLDOWN: 60,
  },

  TELE: {
    COST: 6,            // 3 сердца стамины
    RADIUS: 5,
    WINDUP: 6,          // тиков до подброса
    AMPLIFIER: 9,       // сила левитации (скорость подъёма ~0.5 бл/тик)
    TICKS: 21,          // длительность левитации => высота ~10-11 блоков
    COOLDOWN: 100,
  },

  TRIAL: {
    COST: 11,           // 5,5 сердец стамины (2 единицы = 1 сердце)
    DURATION: 600,      // 30 секунд (20 тиков = 1 с)
    BONUS_DAMAGE: 2,    // +1 сердце к урону каждой способности
    TAG: "sans_trial",  // тег на игроке, пока режим активен (его читают контроллеры)
  },

  GRAVITY: {
    RADIUS: 7,          // кого задевает (блоки от игрока)
    DISTANCE: 8,        // на сколько блоков отбрасывает
    TICKS: 8,           // за сколько тиков пролетает это расстояние
    HOP: 0.35,          // небольшой подскок в начале
  },

  ULT: {
    COST: 24,           // 12 сердец стамины (из 16)
    RADIUS: 28,         // радиус поиска целей
    MAX_TARGETS: 8,
    IFRAME: 12,         // «кадры неуязвимости» цели между попаданиями, тики
    // Кости
    BONE_DAMAGE: 8,         // 4 сердца
    BONE_FLOOR: 1,      // кости не опускают цель ниже этого HP (шанс выжить)
    BONE_SPEED: 0.55,
    BONE_R: 1.15,       // радиус капсулы кости (+ ширина цели)
    BONE_HALF_LEN: 1.4, // половина длины кости вдоль полёта
    BONE_VR: 0.65,      // вертикальный допуск (низкие кости можно перепрыгнуть)
    SUMMARY: true,      // в конце ульты писать в чат, сколько попаданий и урона
    MAX_BONES: 90,
    // Бластеры
    BEAM_LEN: 30,
    BEAM_R: 1.8,
    BEAM_TICKS: 14,
    BEAM_DAMAGE: 10,
    BEAM_FLOOR: 1,      // бластеры 1-2 залпов тоже не убивают...
    FINALE_DAMAGE: 16,
    LETHAL_FINALE: true,// ...а финальный залп может убить, если не увернуться
    MAX_BLASTERS: 24,
  },
};

const TAG_SPIKES = "sans_cast_spikes";
const TAG_ULT = "sans_cast_ult";

// ---------------------------------------------------------------- helpers ---
const now = () => system.currentTick;
const rand = (a, b) => a + Math.random() * (b - a);
const safe = (f) => { try { return f(); } catch (e) { return undefined; } };

// ---- Локализация: тексты на экране (чат / title / actionbar) идут через ключи из texts/*.lang (en_US, ru_RU, zh_CN).
// Клиент сам подставляет язык игрока. Незнакомая строка выводится как есть.
const TR = {
  "§cНе хватает стамины": "sans.msg.stamina",
  "§cНе хватает стамины для комбо": "sans.msg.stamina_combo",
  "§cНе хватает стамины для последней атаки": "sans.msg.stamina_ult",
  "§cНе хватает стамины для Времени суда": "sans.msg.stamina_trial",
  "§7Поблизости нет целей": "sans.msg.no_targets_near",
  "§7Нет цели для комбо": "sans.msg.no_target_combo",
  "§7Нет целей": "sans.msg.no_targets",
  "§7Нет цели": "sans.msg.no_target",
  "§7Нет целей рядом": "sans.msg.no_targets_close",
  "§7Нет целей для поглощения": "sans.msg.no_targets_absorb",
  "§7Поблизости никого нет": "sans.msg.nobody_near",
  "§7Время ещё не восстановилось": "sans.msg.time_cd",
  "§bВремя суда уже идёт": "sans.msg.trial_active",
  "§cГравитация работает только во время Времени суда": "sans.msg.gravity_trial",
  "§7Папирус ещё не готов": "sans.msg.papyrus_cd",
  "§cКетчуп помогает только Сансу": "sans.msg.ketchup_only",
  "§7Стамина и так полная": "sans.msg.stamina_full",
  "§7Путь заблокирован": "sans.msg.path_blocked",
  "§7Ульта перезаряжается": "sans.msg.ult_cd",
  "§7Перезарядка": "sans.msg.cooldown",
  "§7Бластеры в момент прицеливания: стоишь — §bголубые§7, идёшь — §6оранжевые": "sans.msg.gaster_bo_hint",
  "§aТы увернулся!": "sans.msg.dodged",
  "§c«ударь его!»": "sans.msg.hit_him",
  "§4§l...§r§7 ещё не время.": "sans.msg.not_yet",
  "§l§9[ Комбо ]": "sans.title.combo_9",
  "§l§b[ Комбо ]": "sans.title.combo_b",
  "§l§e[ Время остановлено ]": "sans.title.time_stop",
  "§7[ Время пошло ]": "sans.title.time_go",
  "§l§9[ Гравитация ]": "sans.title.gravity",
  "§l§b[ Последняя атака ]": "sans.title.final_attack",
  "§l§c[ Бластеры ]": "sans.title.blasters_c",
  "§l§6[ Бластеры ]": "sans.title.blasters_6",
  "§l§b[ Бластеры ]": "sans.title.blasters_b",
  "§l§9[ Платформа ]": "sans.title.platform",
  "§l§9[ Комбо: Суд ]": "sans.title.combo_trial",
  "§c§l[ Удар! ]": "sans.title.strike",
  "§l§9[ Время суда ]": "sans.title.trial",
  "§7[ Время суда окончено ]": "sans.title.trial_end",
  "§7[ Murder Time окончен ]": "sans.title.murder_end",
  "§l§4[ Last Breath: Арена ]": "sans.title.lb_arena",
  "§l§4[ Last Breath: Платформа ]": "sans.title.lb_platform",
  "§l§4[ Шипы на месте выстрела ]": "sans.title.lb_spikes",
  "§l§4[ Last Breath: 4 стены ]": "sans.title.lb_walls",
  "§l§4[ Last Breath: Телекинез ]": "sans.title.lb_tele",
  "§l§4[ Last Breath: Шипы-бластеры ]": "sans.title.lb_spike_blast",
  "§l§9[ Last Breath: Спасение ]": "sans.title.lb_rescue",
  "§4§lУЛЬТА": "sans.title.ult",
  "§l§6[ Руки ]": "sans.title.hands",
  "§l§5[ ГЛЮК ]": "sans.title.glitch",
  "§l§e[ Круговорот ]": "sans.title.vortex",
};
const tx = (s) => (typeof s === "string" ? (TR[s] ? { translate: TR[s] } : { text: s }) : s); // RawMessage
const trf = (key, ...args) => ({ translate: key, with: args.map((a) => String(a)) });          // ключ с параметрами %1$s %2$s
const tt = (s) => `titleraw @s title ${JSON.stringify({ rawtext: [tx(s)] })}`;                 // команда title на языке игрока
const ok = (e) => { try { return typeof e.isValid === "function" ? e.isValid() : !!e.isValid; } catch (_) { return false; } };
const fx = (dim, id, loc) => safe(() => dim.spawnParticle(id, loc));
const snd = (dim, name, loc, vol = 1, pitch = 1) =>
  safe(() => dim.runCommand(`playsound ${name} @a ${loc.x.toFixed(1)} ${loc.y.toFixed(1)} ${loc.z.toFixed(1)} ${vol} ${pitch}`));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const hp = (e) => safe(() => e.getComponent("minecraft:health").currentValue);

function stamina(p) {
  const c = safe(() => p.getComponent("minecraft:variant"));
  const v = c ? c.value : 336;
  if (v >= 1000) return v - 1000;                      // Gaster: 1000..1050
  if (v >= 900) return v - 900;                        // Last Breath: 900..992
  if (v >= 800) return v - 800;                        // Horror: 800..836
  if (v >= 700) return v - 700;                        // Killer: 700..752
  if (v >= 600) return v - 600;                        // Nightmare: 600..680
  return v >= 500 ? v - 500 : (v >= 300 ? v - 300 : -1); // Dust: variant 500..572, Sans: 300..336
}
// ---- Dust Sans: общие помощники ----
function isDust(p) { return !!p && safe(() => p.hasTag("dust_sans")) === true; }
function isGaster(p) { return !!p && safe(() => p.hasTag("gaster_sans")) === true; }
function isError(p) { return !!p && safe(() => p.hasTag("error_sans")) === true; }
// ---- Last Breath Sans: редкая (40%) трансформация умирающего обычного Санса ----
function isLastBreath(p) { return !!p && safe(() => p.hasTag("lastbreath_sans")) === true; }
const LB = {
  ACTIVATE_CHANCE: 0.4,   // шанс активации вместо обычной сцены смерти
  FULL: 92,               // максимум стаимны (variant 900..992), чуть больше чем у Dust (72)
  TRANS_STEP: 10,         // тиков между стадиями трещины
  WITHER_TICKS: 100,      // иссушение от атак Last Breath (5 секунд)
  WITHER_AMP: 1,
  KNOCK_H: 1.3, KNOCK_V: 0.45, // откидывание того, кто бьёт Last Breath
  // стоимости базовых (уже не Shift) атак
  COST: { bone: 6, spikes: 6, wall: 10, tele: 10, gb: 6, control: 6 },
};
// Dust: кость с шансом 50% красная (+урон). Сущность получает событие dst_red -> variant 1 -> красная текстура
// ===================================== ГОЛУБЫЕ КОСТИ (Время суда) ===
// Пока идёт суд, все кости/шипы/стены голубые: урон 3 получает только тот, кто ДВИГАЕТСЯ. Стоишь на месте — кость проходит сквозь.
const blueIds = new Set();
const BLUE = { DAMAGE: 3, SPEED: 0.04, GRACE: 2 };
const isBlue = (ent) => !!ent && blueIds.has(ent.id);
const motionAt = new Map(); // id игрока -> { x, y, z, at }
function trackMotion() {
  const t = now();
  for (const p of world.getAllPlayers()) {
    const l = safe(() => p.location); if (!l) continue;
    const m = motionAt.get(p.id);
    if (!m) { motionAt.set(p.id, { x: l.x, y: l.y, z: l.z, at: -99 }); continue; }
    if (Math.hypot(l.x - m.x, l.z - m.z) > 0.03 || Math.abs(l.y - m.y) > 0.06) m.at = t;
    m.x = l.x; m.y = l.y; m.z = l.z;
  }
  if (blueIds.size > 4000) blueIds.clear();
}
function isMoving(e) {
  const v = safe(() => e.getVelocity());
  if (v && (Math.hypot(v.x, v.z) > BLUE.SPEED || Math.abs(v.y) > 0.25)) return true;
  const m = motionAt.get(e.id);
  return !!m && now() - m.at <= BLUE.GRACE;
}
function blueHit(e, owner) { return isMoving(e) ? hurt(e, BLUE.DAMAGE, owner, 0, true) : -2; } // -2: цель стоит, урона нет
function tryHitBlue(c, e, t) {
  if ((c.iframe.get(e.id) || 0) > t) return false;
  const dealt = blueHit(e, c.owner);
  if (dealt < 0) return false;
  c.iframe.set(fk, t + CFG.ULT.IFRAME);
  if (c.stats) { if (dealt > 0) { c.stats.hits++; c.stats.dmg += dealt; } c.stats.ids.add(e.id); }
  return true;
}

function dstRed(owner, ent) {
  if (ent && isTrial(owner)) { safe(() => ent.triggerEvent("bone_blue")); blueIds.add(ent.id); return false; } // Время суда: голубая кость
  if (!ent || !isDust(owner) || Math.random() >= DST.RED_CHANCE) return false;
  safe(() => ent.triggerEvent("dst_red"));
  return true;
}
// какое событие вернёт базовый скин режима (Dust / Horror / обычный Санс)
const skinBaseEvt = (p) => (isError(p) ? "error_skin_on" : isGaster(p) ? "gaster_skin_on" : isLastBreath(p) ? "lb_skin_on" : isKiller(p) ? "killer_skin_on" : isNight(p) ? "nightmare_skin_on" : isDust(p) ? "dst_skin_on" : (safe(() => p.hasTag("horror_sans")) ? "horror_skin_on" : "trial_off"));
const HS_EVENTS = new Set(["bone0_remove", "bone_spikes_remove", "bone_wall_remove", "control_remove", "telekinesis_remove", "gb_remove", "bone0_free", "control_free", "hbone0_remove"]);
const GS_EVENTS = new Set(["gb_remove", "gb_free", "hand"]);
const sevt = (p, name) => (isGaster(p) && GS_EVENTS.has(name)) ? "gs_" + name : (isLastBreath(p) ? "lb_" + name : isDust(p) ? "dst_" + name : (isHorror(p) && HS_EVENTS.has(name)) ? "hs_" + name : name);            // событие траты стамины
const addEvt = (p) => (isLastBreath(p) ? "lb_add" : isKiller(p) ? "killer_add" : isNight(p) ? "nightmare_add" : isDust(p) ? "dst_add" : isGaster(p) ? "gs_add" : isHorror(p) ? "hs_add" : "sans_add");              // событие регенерации
const ET = (p, type) => (isGaster(p) && type === "playersans:ult_blaster") ? "gasterbones:ult_blaster" : (isDust(p) ? type.replace("playersans:", "dustsans:") : isError(p) ? type.replace("playersans:", "errorbones:") : (isHorror(p) && /bone_spike$|bone_wall_piece$/.test(type)) ? type.replace("playersans:", "horrorsans:") : type); // тип сущности атаки
const DP = (p, particle) => (isDust(p) ? "sansmode:dust_spark" : particle);          // частицы: фиолетовые у Dust
const DST = { SPIKE_COUNT: 12, WALL_HEIGHT: 3.9, TELE_TICKS: 42, BONE_SPEED_MUL: 1.45, MAX_BLASTERS: 40, SLEEP_FULL: 72,
  RED_CHANCE: 0.35, RED_BONUS: 2,                 // красные кости: 50% и +2 урона (1 сердце) поверх x2
  ULT_UNDER_CHANCE: 0.25, ULT_UNDER_WARN: 14, ULT_UNDER_DMG: 4, // в последней атаке: доля костей, которые вылезают снизу
  ULT_TELE_AT: [150, 470], ULT_TELE_LIFT: 14, ULT_TELE_HOVER: 36, ULT_TELE_WARN: 8, ULT_TELE_DMG: 4 }; // подброс + шипы снизу

function deny(p, text) { if (typeof text === "string" && isLastBreath(p)) text = text.replace(" для комбо", ""); safe(() => p.sendMessage(tx(text))); }

// ---- Trial Time: активен ли режим у игрока (состояние хранит скрипт)
const trials = new Map(); // playerId -> { end: тик окончания }
const isTrial = (p) => !!p && trials.has(p.id);
const trialBonus = (p) => { const tr = p && trials.get(p.id); return tr ? CFG.TRIAL.BONUS_DAMAGE * (tr.mult || 1) : 0; };

function hurt(ent, amount, owner, floor, raw, bonus = 0) {
  const before = hp(ent);
  if (before === undefined || before <= 0) return -1;      // цель уже мертва / не существует
  let a = amount;
  if (!raw && isDust(owner)) a *= 2;                  // Dust Sans: урон всех атак x2
  if (!raw) a += trialBonus(owner); // Trial Time: +1 сердце (в комбо-режиме +2)
  a += bonus;                       // красная кость Dust: +2 поверх множителя
  if (floor > 0) a = Math.min(a, before - floor);
  if (a <= 0) return 0;                                    // касание без урона: цель на минимуме HP
  if (isPlayerEnt(ent) && dying.has(ent.id)) return 0;     // пока идёт сцена смерти — неуязвим
  if (isPlayerEnt(ent) && a >= before && isSansP(ent)) { startDeath(ent, owner); return a; } // смертельный удар -> сцена
  try {
    ent.applyDamage(a, { cause: CFG.DAMAGE_CAUSE, damagingEntity: owner });
  } catch (_) {
    safe(() => ent.applyDamage(a));
  }
  if (isLastBreath(owner) || isHorror(owner)) safe(() => ent.addEffect("wither", LB.WITHER_TICKS, { amplifier: LB.WITHER_AMP, showParticles: true })); // LB/Horror: иссушение от любой атаки
  // Если урон «не прошёл» (иммунитет, кадры неуязвимости, сопротивление моба) — снимаем здоровье напрямую.
  // Игроков это не касается (креатив, тотемы и т.п. должны работать как обычно).
  const after = hp(ent);
  if (!isPlayerEnt(ent) && after !== undefined && after > before - a * 0.5) {
    const left = before - a;
    if (left <= (floor > 0 ? floor : 0) && !(floor > 0)) safe(() => ent.kill());
    else safe(() => ent.getComponent("minecraft:health").setCurrentValue(Math.max(floor > 0 ? floor : 0, left)));
  }
  return a;
}
function knock(ent, dx, dz, h, v) {
  try { ent.applyKnockback(dx, dz, h, v); }
  catch (_) { safe(() => ent.applyImpulse({ x: dx * h, y: v, z: dz * h })); }
}

// Живые существа вокруг точки, которых можно задеть.
function candidates(dim, loc, radius, owner, spare) {
  const q = { location: loc, maxDistance: radius, excludeFamilies: ["inanimate", "psans"], excludeTags: ["sans_ignore"] };
  const ex = [];
  if (!CFG.HIT_PLAYERS) ex.push("minecraft:player");
  if (spare) ex.push(...CFG.SPARE_TYPES);
  if (ex.length) q.excludeTypes = ex;
  const list = safe(() => dim.getEntities(q)) || [];
  return list.filter((e) => e.id !== owner.id && ok(e) && (hp(e) ?? 0) > 0);
}

// Верхушка земли в колонке (x,z) около высоты y.
function isEmpty(b) {
  if (!b) return true;
  const air = typeof b.isAir === "function" ? b.isAir() : b.isAir;
  if (air) return true;
  const liquid = typeof b.isLiquid === "function" ? b.isLiquid() : b.isLiquid;
  const solid = typeof b.isSolid === "function" ? b.isSolid() : b.isSolid;
  return !liquid && solid === false;
}
function groundY(dim, x, y, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let yy = Math.floor(y) + 1; yy >= Math.floor(y) - 6; yy--) {
    const b = safe(() => dim.getBlock({ x: bx, y: yy, z: bz }));
    if (b && !isEmpty(b)) return yy + 1;
  }
  return y;
}

// ======================================================= BONE SPIKES (ряд) ===
const spikes = [];
const spikeCooldown = new Map();

function castSpikes(p) {
  const S = CFG.SPIKES, t = now();
  if (!isDust(p) && t < (spikeCooldown.get(p.id) || 0)) return;
  const free = isTrial(p); // в режиме Trial Time стамина не тратится
  if (!free && stamina(p) < S.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent(sevt(p, "bone_spikes_remove"));
  spikeCooldown.set(p.id, t + S.COOLDOWN);

  const dim = p.dimension, o = p.location;
  const d = p.getViewDirection();
  let hx = d.x, hz = d.z, l = Math.hypot(hx, hz);
  if (l < 0.15) { // смотрит вертикально — берём поворот тела
    const yaw = (p.getRotation().y * Math.PI) / 180;
    hx = -Math.sin(yaw); hz = Math.cos(yaw); l = 1;
  }
  hx /= l; hz /= l;

  const COUNT = isDust(p) ? DST.SPIKE_COUNT : S.COUNT; // Dust: до 12 (вместо 8)
  for (let i = 0; i < COUNT; i++) {
    const dist = S.START + i * S.SPACING;
    const x = o.x + hx * dist, z = o.z + hz * dist;
    system.runTimeout(() => {
      if (!ok(p)) return;
      const y = groundY(dim, x, o.y, z);
      // предупреждение: трещина, пыль
      for (let k = 0; k < 3; k++) fx(dim, "minecraft:basic_smoke_particle", { x: x + rand(-0.4, 0.4), y: y + 0.1, z: z + rand(-0.4, 0.4) });
      snd(dim, "dig.stone", { x, y, z }, 0.7, 1.5);
      system.runTimeout(() => {
        if (!ok(p)) return;
        const ent = safe(() => dim.spawnEntity(ET(p, "playersans:bone_spike"), { x, y, z }));
        if (!ent) return;
        snd(dim, "dig.stone", { x, y, z }, 1, 0.8);
        fx(dim, DP(p, "minecraft:water_evaporation_bucket_emitter"), { x, y: y + 0.2, z });
        spikes.push({ red: dstRed(p, ent), ent, dim, x, y, z, born: now(), owner: p, hit: new Set() });
      }, S.WARN);
    }, i * S.STEP);
  }
}

function tickSpikes(t) {
  const S = CFG.SPIKES;
  for (let i = spikes.length - 1; i >= 0; i--) {
    const s = spikes[i], age = t - s.born;
    if (!ok(s.ent) || age >= S.LIFE) { safe(() => s.ent.remove()); spikes.splice(i, 1); continue; }
    if (age < S.ACTIVE_FROM || age > S.ACTIVE_TO || !ok(s.owner)) continue;
    for (const e of candidates(s.dim, { x: s.x, y: s.y + 1, z: s.z }, 3, s.owner, false)) {
      if (s.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - s.x, l.z - s.z) > (s.big ? S.HIT_R * 3 : S.HIT_R)) continue;
      if (l.y > s.y + (s.big ? S.HEIGHT * 3 : S.HEIGHT) || l.y < s.y - 1.7) continue;
      if (isBlue(s.ent)) { if (blueHit(e, s.owner) > 0) s.hit.add(e.id); continue; } // голубой шип бьёт только движущегося
      s.hit.add(e.id);
      if (hurt(e, s.dmg ?? S.DAMAGE, s.owner, 0, false, s.red ? DST.RED_BONUS : 0) >= 0 && (s.launch ?? S.LAUNCH) > 0) knock(e, 0, 0, 0, s.launch ?? S.LAUNCH);
    }
  }
}

// ===================================================== BONE WALL (стена) ===
const wallPieces = [];
const wallCooldown = new Map();

function viewDirH(p) {
  const d = p.getViewDirection();
  let hx = d.x, hz = d.z, l = Math.hypot(hx, hz);
  if (l < 0.15) {
    const yaw = (p.getRotation().y * Math.PI) / 180;
    hx = -Math.sin(yaw); hz = Math.cos(yaw); l = 1;
  }
  return { x: hx / l, z: hz / l };
}

function castWall(p) {
  const W = CFG.WALL, t = now();
  if (!isDust(p) && t < (wallCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && stamina(p) < W.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent(sevt(p, "bone_wall_remove"));
  wallCooldown.set(p.id, t + W.COOLDOWN);

  const dim = p.dimension, o = p.location, h = viewDirH(p);
  const perp = { x: -h.z, z: h.x };
  const dist = W.DIST + (isDust(p) ? 3 : 0);

  const n = Math.round(W.HALF_WIDTH / W.SPACING);
  const shared = { hit: new Set(), pushed: new Map() }; // один урон/откидывание на цель за всю стену
  for (let row = 0; row < W.ROWS; row++) {
    for (let i = -n; i <= n; i++) {
      const u = i * W.SPACING + (row % 2 ? W.SPACING / 2 : 0);
      if (Math.abs(u) > W.HALF_WIDTH + 0.01) continue;
      const x = o.x + h.x * (dist + row * W.ROW_GAP) + perp.x * u;
      const z = o.z + h.z * (dist + row * W.ROW_GAP) + perp.z * u;
      const delay = Math.floor(Math.abs(u) * 1.2); // волна от центра к краям
      system.runTimeout(() => {
        if (!ok(p)) return;
        const y = groundY(dim, x, o.y, z);
        fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
        system.runTimeout(() => {
          const ent = safe(() => dim.spawnEntity(ET(p, "playersans:bone_wall_piece"), { x, y, z }));
          if (!ent) return;
          if (i % 4 === 0) snd(dim, "dig.stone", { x, y, z }, 0.8, 0.8);
          wallPieces.push({ red: dstRed(p, ent), ent, dim, x, y, z, nx: h.x, nz: h.z, born: now(), owner: p, shared, tall: isDust(p) });
        }, W.WARN);
      }, delay);
    }
  }
}

function tickWalls(t) {
  const W = CFG.WALL;
  for (let i = wallPieces.length - 1; i >= 0; i--) {
    const s = wallPieces[i], age = t - s.born;
    const life = s.life ?? W.LIFE;
    if (!ok(s.ent) || age >= life) { safe(() => s.ent.remove()); wallPieces.splice(i, 1); continue; }
    if (age < 3 || age > life - 6 || !ok(s.owner)) continue; // пока поднимается / опускается — не бьёт
    for (const e of candidates(s.dim, { x: s.x, y: s.y + 1, z: s.z }, 2.5, s.owner, false)) {
      const l = e.location;
      if (Math.hypot(l.x - s.x, l.z - s.z) > W.HIT_R) continue;
      if (l.y > s.y + (s.tall ? DST.WALL_HEIGHT : W.HEIGHT) || l.y < s.y - 1.7) continue;
      let side = (l.x - s.x) * s.nx + (l.z - s.z) * s.nz;
      if (Math.abs(side) < 0.05) side = -((s.owner.location.x - s.x) * s.nx + (s.owner.location.z - s.z) * s.nz);
      const sg = side >= 0 ? 1 : -1;
      const sh = s.shared;
      if (!sh.hit.has(e.id)) {
        const blue = isBlue(s.ent);
        if (blue && !isMoving(e)) continue;                      // голубая стена: стоишь — не бьёт
        sh.hit.add(e.id);
        if ((blue ? hurt(e, BLUE.DAMAGE, s.owner, 0, true) : hurt(e, W.DAMAGE, s.owner, 0, false, s.red ? DST.RED_BONUS : 0)) < 0) continue;
        knock(e, s.nx * sg, s.nz * sg, W.PUSH, 0.35);
        sh.pushed.set(e.id, t);
      } else if (t - (sh.pushed.get(e.id) || 0) >= 4) { // стена не пускает: каждый раз отбрасывает назад
        sh.pushed.set(e.id, t);
        knock(e, s.nx * sg, s.nz * sg, W.REPEL, 0.2);
      }
    }
  }
}

// ===================================================== TELEKINESIS (подброс) ===
const teleCooldown = new Map();

function castTele(p) {
  const T = CFG.TELE, t = now();
  if (!isDust(p) && t < (teleCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && stamina(p) < T.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent(sevt(p, "telekinesis_remove"));
  teleCooldown.set(p.id, t + T.COOLDOWN);

  const dim = p.dimension;
  snd(dim, "beacon.power_select", p.location, 1.2, 1.2);
  // подготовка: кольца частиц сжимаются к игроку
  for (let k = 0; k < T.WINDUP; k++) {
    system.runTimeout(() => {
      if (!ok(p)) return;
      const r = T.RADIUS * (1 - k / T.WINDUP);
      const o = p.location;
      for (let j = 0; j < 20; j++) {
        const a = (j / 20) * Math.PI * 2;
        fx(dim, "minecraft:totem_particle", { x: o.x + Math.cos(a) * r, y: o.y + 0.2, z: o.z + Math.sin(a) * r });
      }
    }, k);
  }
  system.runTimeout(() => {
    if (!ok(p)) return;
    const o = p.location;
    snd(dim, "mob.wither.shoot", o, 1.5, 0.8);
    for (const e of candidates(dim, o, T.RADIUS, p, false)) {
      const lift = isDust(p) ? DST.TELE_TICKS : T.TICKS; // Dust: подброс вдвое выше
      safe(() => e.addEffect("levitation", lift, { amplifier: T.AMPLIFIER, showParticles: false }));
      fx(dim, DP(p, "minecraft:totem_particle"), e.location);
      if (isDust(p)) for (let k = 0; k < lift; k += 2) system.runTimeout(() => { if (ok(e)) fx(dim, "sansmode:dust_spark", e.location); }, k);
    }
  }, T.WINDUP);
}

// ==================================================== FINAL ATTACK (ульта) ===
const ults = new Map();

function findTargets(p) {
  const U = CFG.ULT;
  const o = p.location;
  return candidates(p.dimension, o, U.RADIUS, p, true)
    .sort((a, b) => len(sub(a.location, o)) - len(sub(b.location, o)))
    .slice(0, U.MAX_TARGETS);
}

function castUltimate(p, combo = false, pay = null) {
  const DU2 = isDust(p) ? COMBO.ULT_DUST : COMBO.ULT, U = CFG.ULT, cost = combo ? DU2.COST : U.COST;
  if (ults.has(p.id)) return;
  const free = isTrial(p);
  if (!free && !pay && stamina(p) < cost) return deny(p, "§cНе хватает стамины для последней атаки");
  if (!findTargets(p).length) return deny(p, "§7Поблизости нет целей");
  if (!free) { if (pay) pay(); else p.triggerEvent(combo ? "combo_ult_remove" : sevt(p, "ult_remove")); }
  const ctx = { stats: { hits: 0, dmg: 0, ids: new Set() }, owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, done: false, bonus: combo && isDust(p) ? DU2.BONUS : 0, rainMin: DU2.RAIN_MIN, rainMax: DU2.RAIN_MAX };
  ults.set(p.id, ctx);
  { // Final Attack: eyes effect per character (Classic/Dust - black sockets; Last Breath - grey static/black flicker)
    let eyesGrp = null;
    if (isDust(p)) eyesGrp = "ult_eyes_dust";
    else if (isLastBreath(p)) eyesGrp = "ult_eyes_lb";
    else if (!isKiller(p) && !isGaster(p) && !isNight(p) && !isError(p) && !safe(() => p.hasTag("horror_sans"))) eyesGrp = "ult_eyes_classic";
    if (eyesGrp) {
      const g = eyesGrp;
      safe(() => p.triggerEvent(g + "_on"));
      const prevEnd = ctx.onEnd;
      ctx.onEnd = (cc) => { if (prevEnd) safe(() => prevEnd(cc)); safe(() => p.triggerEvent(g + "_off")); };
    }
  }
  ctx.timeline = buildTimeline();
  if (isDust(p)) ctx.timeline = ctx.timeline.concat((combo ? [...DST.ULT_TELE_AT, ...DST.ULT_TELE_AT.map((x) => x + 60)] : DST.ULT_TELE_AT).map((tk) => [tk, (c) => ultTele(c)])).sort((a, b) => a[0] - b[0]);
  if (combo) { // ускоренный темп + периодические кости с неба
    ctx.combo = true;
    ctx.timeline = ctx.timeline.map(([tk, fn]) => [Math.round(tk * COMBO.ULT.TEMPO), fn]);
    ctx.rainAt = DU2.RAIN_FIRST;
    ctx.rain = makeRain(p, p.dimension, DU2.RAIN_DMG, Infinity);
  }
}

const title = (c, text) => { if (isLastBreath(c.owner) && String(text).includes("Комбо")) return; return safe(() => c.owner.runCommand(tt(text))); }; // у Last Breath это обычные атаки, а не комбо
const center = (e) => { const l = e.location; return { x: l.x, y: l.y + 0.9, z: l.z }; };

// --- общий учёт попаданий с «кадрами неуязвимости»
// Возвращает true, если атака «коснулась» живой цели (даже если урон уже упёрся в минимум HP):
// тогда цель отбрасывается и видит эффект, а не проходит сквозь кость/луч.
function tryHit(c, e, dmg, floor, t, bonus = 0, ik = "") {
  const fk = ik ? e.id + ":" + ik : e.id;
  if ((c.iframe.get(fk) || 0) > t) return false;
  const dealt = hurt(e, dmg, c.owner, floor, false, bonus + (c.bonus || 0));
  if (dealt < 0) return false;                             // мёртвая цель
  c.iframe.set(e.id, t + CFG.ULT.IFRAME);
  if (c.stats) { if (dealt > 0) { c.stats.hits++; c.stats.dmg += dealt; } c.stats.ids.add(e.id); }
  return true;
}

// ------------------------------------------------------------------ КОСТИ ---
// spec: { pos, launchAt, speed, life, vel?  | aimFn?, lockAt? }
function addBone(c, spec) {
  if (c.bones.length >= CFG.ULT.MAX_BONES) return;
  if (isDust(c.owner) && !spec._d) { // Dust: кости быстрее
    spec = { ...spec, _d: true, speed: spec.speed ? spec.speed * DST.BONE_SPEED_MUL : spec.speed, vel: spec.vel ? mul(spec.vel, DST.BONE_SPEED_MUL) : spec.vel, life: spec.life ? Math.ceil(spec.life / DST.BONE_SPEED_MUL) + 2 : spec.life };
  }
  const ent = safe(() => c.dim.spawnEntity(ET(c.owner, "playersans:flying_bone"), spec.pos));
  if (!ent) return;
  c.bones.push({ red: dstRed(c.owner, ent), ent, pos: { ...spec.pos }, prev: { ...spec.pos }, tgtMob: !!spec.mob, vel: spec.vel || null, aimFn: spec.aimFn, lockAt: spec.lockAt, launchAt: spec.launchAt, life: spec.life, speed: spec.speed });
}

const isPlayerEnt = (e) => safe(() => e.typeId === "minecraft:player") === true;
// Точка прицеливания. Для мобов (не игроков) упреждаем движение — кости/лучи «косят» бегущих,
// игрокам упреждения нет: у них остаётся шанс увернуться.
function aimPoint(e, fallback, yOff, from, speed) {
  if (e && ok(e) && !isPlayerEnt(e) && from && speed) {
    const l = e.location, v = safe(() => e.getVelocity()) || { x: 0, y: 0, z: 0 };
    const d = len(sub({ x: l.x, y: l.y + yOff, z: l.z }, from)), ticks = Math.min(40, d / speed);
    return { x: l.x + Math.max(-6, Math.min(6, v.x * ticks)), y: l.y + yOff, z: l.z + Math.max(-6, Math.min(6, v.z * ticks)) };
  }
  return aimPointBase(e, fallback, yOff);
}
function aimPointBase(e, fallback, yOff) {
  if (e && ok(e)) { const l = e.location; return { x: l.x, y: l.y + yOff, z: l.z }; }
  return fallback;
}

function waveRing(c, n) {
  const U = CFG.ULT, t = now();
  const per = Math.max(3, Math.floor(n / Math.max(1, Math.ceil(c.targets.length / 3))));
  for (const tg of c.targets) {
    const base = rand(0, Math.PI * 2), R = 13, ctr = center(tg);
    for (let j = 0; j < per; j++) {
      if (isDust(c.owner) && Math.random() < DST.ULT_UNDER_CHANCE) { underSpike(c, tg); continue; } // Dust: кость из-под земли
      const a = base + (j * Math.PI * 2) / per;
      const pos = { x: ctr.x + Math.cos(a) * R, y: ctr.y + rand(-0.4, 0.4), z: ctr.z + Math.sin(a) * R };
      const launchAt = t + 24 + j * 2;
      addBone(c, { pos, mob: !isPlayerEnt(tg), launchAt, lockAt: launchAt - 8, speed: U.BONE_SPEED, life: Math.ceil((R * 2 + 6) / U.BONE_SPEED),
        aimFn: (f, sp) => aimPoint(tg, ctr, 0.9, f, sp) });
    }
  }
}

function waveWall(c, phi, delay = 0) {
  const U = CFG.ULT, t = now();
  const dir = { x: Math.cos(phi), y: 0, z: Math.sin(phi) };
  const perp = { x: -dir.z, y: 0, z: dir.x };
  for (const tg of c.targets) {
    const ctr = tg.location;
    const gap = rand(-2.5, 2.5);
    const low = Math.random() < 0.5; // низкая стена — можно перепрыгнуть
    const y = ctr.y + (low ? 0.4 : 1.1);
    for (let off = -9; off <= 9.01; off += 1.5) {
      if (Math.abs(off - gap) < 1.3) continue; // «окно» для уворота
      const pos = add({ x: ctr.x, y, z: ctr.z }, add(mul(dir, -13), mul(perp, off)));
      addBone(c, { pos, launchAt: t + 30 + delay, vel: mul(dir, 0.42), life: Math.ceil(34 / 0.42) });
    }
  }
}

function waveCross(c, n) {
  const U = CFG.ULT, t = now();
  for (const tg of c.targets) {
    for (let j = 0; j < n; j++) {
      if (isDust(c.owner) && Math.random() < DST.ULT_UNDER_CHANCE) { underSpike(c, tg); continue; } // Dust: кость из-под земли
      const a = rand(0, Math.PI * 2), R = 12, l = tg.location;
      const pos = { x: l.x + Math.cos(a) * R, y: l.y + rand(0.3, 1.4), z: l.z + Math.sin(a) * R };
      const launchAt = t + 20 + j * 7;
      addBone(c, { pos, mob: !isPlayerEnt(tg), launchAt, lockAt: launchAt - 8, speed: U.BONE_SPEED + 0.05, life: Math.ceil((R * 2 + 6) / U.BONE_SPEED),
        aimFn: (f, sp) => aimPoint(tg, pos, 0.9, f, sp) });
    }
  }
}

function segDist2D(px, pz, A, B) {
  const dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz;
  let k = l2 ? ((px - A.x) * dx + (pz - A.z) * dz) / l2 : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(px - (A.x + dx * k), pz - (A.z + dz * k));
}

function tickBone(c, b, t) {
  const U = CFG.ULT;
  if (!ok(b.ent)) return false;
  if (!b.vel && b.aimFn && t >= (b.tgtMob ? b.launchAt : b.lockAt) && !b.locked) { // фиксируем направление — дальше уворачивайся
    const a = b.aimFn(b.pos, b.speed);
    b.vel = mul(norm(sub(a, b.pos)), b.speed);
    b.locked = true;
  }
  if (t < b.launchAt) {
    if (b.vel && !b.faced) { b.faced = true; safe(() => b.ent.teleport(b.pos, { facingLocation: add(b.pos, b.vel) })); }
    // телеграф: цепочка частиц по траектории (у «стены» — пореже)
    if (b.vel && (b.aimFn ? t % 3 === 0 : t % 8 === 0)) {
      for (let k = 1; k <= (b.aimFn ? 4 : 2); k++) fx(c.dim, "minecraft:villager_angry", add(b.pos, mul(norm(b.vel), k * 4)));
    }
    return true;
  }
  if (!b.vel) return false;
  b.prev = b.pos;
  b.pos = add(b.pos, b.vel);
  safe(() => b.ent.teleport(b.pos, { facingLocation: add(b.pos, b.vel) }));
  if (t - b.launchAt >= b.life) return false;
  // Хитбокс = капсула по всей длине кости (модель ~2,7 блока) и по пути за этот тик
  const dn = norm(b.vel), A = sub(b.prev, mul(dn, U.BONE_HALF_LEN)), B = add(b.pos, mul(dn, U.BONE_HALF_LEN));
  for (const e of c.cands) {
    if (!ok(e)) continue;
    const l = e.location;
    if (segDist2D(l.x, l.z, A, B) > U.BONE_R) continue;
    const feet = l.y, head = safe(() => e.getHeadLocation().y) ?? feet + 1.8;
    if (feet > b.pos.y + U.BONE_VR || head < b.pos.y - U.BONE_VR) continue; // низкие кости можно перепрыгнуть
    if (isBlue(b.ent) ? tryHitBlue(c, e, t) : tryHit(c, e, U.BONE_DAMAGE, U.BONE_FLOOR, t, b.red ? DST.RED_BONUS : 0)) {
      const d = norm({ x: b.vel.x, y: 0, z: b.vel.z });
      knock(e, d.x, d.z, 0.5, 0.25);
      fx(c.dim, "minecraft:villager_angry", center(e));
    }
  }
  return true;
}

// -------------------------------------------------------------- БЛАСТЕРЫ ---
// spec: { target, ang, r, h, spawnAt, lockAt, fireAt, dmg, floor }
function addBlaster(c, spec) {
  if (c.blasters.length >= (isDust(c.owner) ? DST.MAX_BLASTERS : isGaster(c.owner) ? 40 : CFG.ULT.MAX_BLASTERS)) return;
  const tc = center(spec.target);
  const pos = { x: tc.x + Math.cos(spec.ang) * spec.r, y: tc.y + spec.h, z: tc.z + Math.sin(spec.ang) * spec.r };
  const ent = safe(() => c.dim.spawnEntity(spec.type || ET(c.owner, "playersans:ult_blaster"), pos));
  if (!ent) return;
  safe(() => ent.teleport(pos, { facingLocation: tc }));
  snd(c.dim, "mob.endermen.portal", pos, 0.8, 0.6);
  c.blasters.push({ ...spec, ent, pos, state: "orbit", aim: null, lastTc: tc });
}

function volley(c, list) {
  if (isDust(c.owner)) { // Dust: больше бластеров за залп — добавляем вторую «нить» между уже имеющимися
    const n = list.length;
    list = list.concat(list.map((x, i) => ({ ...x, ang: x.ang + Math.PI / n, r: x.r + 1.5, h: x.h + 0.4 })));
  } // list: массив spec без target
  const tg = c.targets;
  const per = Math.max(1, Math.floor((isDust(c.owner) ? DST.MAX_BLASTERS : isGaster(c.owner) ? 40 : CFG.ULT.MAX_BLASTERS) / Math.max(1, tg.length)));
  for (const target of tg) for (const s of list.slice(0, per)) addBlaster(c, { ...s, target });
}

function tickBlaster(c, b, t) {
  const U = CFG.ULT;
  if (!ok(b.ent)) return false;
  if (isDust(c.owner) && t % 3 === 0) fx(c.dim, "sansmode:dust_spark", b.pos); // Dust: фиолетовые частицы из бластера
  if (b.state === "orbit") {
    const tc = aimPoint(b.target, b.lastTc, b.yOff ?? 0.9); b.lastTc = tc;
    b.ang += b.spin ?? 0.03; // кружатся вокруг цели («карусель»)
    b.pos = { x: tc.x + Math.cos(b.ang) * b.r, y: tc.y + b.h, z: tc.z + Math.sin(b.ang) * b.r };
    safe(() => b.ent.teleport(b.pos, { facingLocation: tc }));
    if (t >= b.lockAt) { // цель зафиксирована
      b.aim = tc; b.state = "locked";
      if (b.recolor) gsRecolorBlaster(c, b, tc); // Гастер: голубой (если стоит) / оранжевый (если ходит)
      safe(() => b.ent.teleport(b.pos, { facingLocation: tc }));
      b.dir = norm(sub(tc, add(b.pos, { x: 0, y: 0.3, z: 0 }))); // направление взгляда фиксируется здесь и больше не меняется
      safe(() => b.ent.triggerEvent("playersans:charge"));
      snd(c.dim, "beacon.activate", b.pos, 1, 1.4);
    }
    return true;
  }
  const origin = add(b.pos, { x: 0, y: 0.3, z: 0 });
  const dir = b.dir || norm(sub(b.aim, origin)); // без автонаводки: стреляет туда, куда смотрит бластер
  if (b.state === "locked") {
    if (t % 2 === 0) { // телеграф: линия и точка прицеливания
      for (let k = 2; k <= 24; k += 4) fx(c.dim, "minecraft:villager_angry", add(origin, mul(dir, k)));
      fx(c.dim, "minecraft:basic_flame_particle", b.aim);
    }
    if (t >= b.fireAt) {
      b.state = "fire"; b.endAt = t + (b.beamTicks ?? U.BEAM_TICKS);
      safe(() => b.ent.teleport(b.pos, { facingLocation: add(b.pos, dir) })); // модель луча смотрит ровно туда же, куда бьёт урон
      safe(() => b.ent.triggerEvent("playersans:fire"));
      snd(c.dim, "mob.warden.sonic_boom", b.pos, 2, 1);
    }
    return true;
  }
  // fire
  if (t >= b.endAt) return false;
  if (isGaster(c.owner) && t % 3 === 0) { // Гастер: луч дополнительно подсвечен частицами
    const pid = b.kind === "orange" ? "minecraft:basic_flame_particle" : b.kind === "blue" ? "minecraft:blue_flame_particle" : "minecraft:endrod";
    for (let k = 1; k <= 26; k += 3) fx(c.dim, pid, add(origin, mul(dir, k)));
  }
  for (const e of c.cands) {
    if (!ok(e)) continue;
    if (b.kind && (b.kind === "blue" ? !isMoving(e) : isMoving(e))) continue; // голубой бьёт только движущихся, оранжевый — только стоящих
    const p = center(e), rel = sub(p, origin);
    const along = Math.max(0, Math.min(U.BEAM_LEN, rel.x * dir.x + rel.y * dir.y + rel.z * dir.z));
    const closest = add(origin, mul(dir, along));
    if (len(sub(p, closest)) > (b.beamR ?? U.BEAM_R)) continue;
    const floor = b.lethal && CFG.ULT.LETHAL_FINALE ? 0 : U.BEAM_FLOOR;
    if (tryHit(c, e, b.dmg, floor, t, 0, b.ik)) {
      knock(e, dir.x, dir.z, 0.6, 0.3);
      fx(c.dim, "minecraft:basic_flame_particle", p);
    }
  }
  return true;
}

// -------------------------------------------------------- сценарий ульты ---
function buildTimeline() {
  const TL = [];
  const at = (tick, fn) => TL.push([tick, fn]);
  const ang = () => rand(0, Math.PI * 2);

  at(0, (c) => {
    title(c, "§l§b[ Последняя атака ]");
    snd(c.dim, "mob.wither.spawn", c.owner.location, 1, 1.4);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      fx(c.dim, "minecraft:totem_particle", add(c.owner.location, { x: Math.cos(a) * 1.5, y: 0.2 + (k % 3) * 0.6, z: Math.sin(a) * 1.5 }));
    }
  });
  // ----- ФАЗА 1: кости со всех сторон
  at(40,  (c) => waveRing(c, 8));
  at(105, (c) => waveWall(c, ang()));
  at(160, (c) => waveCross(c, 6));
  at(225, (c) => waveRing(c, 10));
  at(275, (c) => { const a = ang(); waveWall(c, a); waveWall(c, a + Math.PI / 2, 14); });
  // ----- пауза («Санс устал») — время выдохнуть и перегруппироваться
  at(385, (c) => title(c, "§l§c[ Бластеры ]"));
  // ----- ФАЗА 2: бластеры
  at(405, (c) => { // залп 1: четыре со всех сторон
    const t = now(), base = ang();
    volley(c, [0, 1, 2, 3].map((k) => ({ ang: base + (k * Math.PI) / 2, r: 8.5, h: 1.0, spawnAt: t, lockAt: t + 30, fireAt: t + 56, dmg: CFG.ULT.BEAM_DAMAGE, floor: CFG.ULT.BEAM_FLOOR })));
  });
  at(490, (c) => { // залп 2: шесть, стреляют по очереди «по кругу»
    const t = now(), base = ang();
    volley(c, [0, 1, 2, 3, 4, 5].map((k) => ({ ang: base + (k * Math.PI) / 3, r: 9, h: k % 2 ? 1.6 : 0.6, spawnAt: t, lockAt: t + 26 + k * 8, fireAt: t + 48 + k * 8, dmg: CFG.ULT.BEAM_DAMAGE, floor: CFG.ULT.BEAM_FLOOR })));
  });
  at(610, (c) => { // финал: кольцо из 12 бластеров, долгая подготовка, залп одновременно
    title(c, "§l§4[ ... ]");
    const t = now(), base = ang();
    volley(c, Array.from({ length: 12 }, (_, k) => ({ ang: base + (k * Math.PI) / 6, r: 10, h: [0.5, 1.2, 1.9][k % 3], spawnAt: t, lockAt: t + 34, fireAt: t + 60, dmg: CFG.ULT.FINALE_DAMAGE, lethal: true })));
  });
  at(720, (c) => { c.finishing = true; });
  return TL;
}

function endUlt(c, id) {
  if (c.onEnd) safe(() => c.onEnd(c));
  for (const b of c.bones) safe(() => b.ent.remove());
  for (const b of c.blasters) safe(() => b.ent.remove());
  ults.delete(id);
  if (c.rain) c.rain.until = 0;
  if (ok(c.owner) && !c.quiet) {
    title(c, "§7...");
    if (c.stats && CFG.ULT.SUMMARY) safe(() => c.owner.sendMessage(trf("sans.msg.ult_summary", c.stats.hits, c.stats.ids.size, Math.round(c.stats.dmg))));
  }
}

function tickUlt(id, c, t) {
  const o = c.owner;
  const dead = !ok(o) || o.dimension !== c.dim || (hp(o) ?? 1) <= 0;
  if (dead) { endUlt(c, id); return; }
  while (c.next < c.timeline.length && t - c.start >= c.timeline[c.next][0]) {
    c.targets = c.fixed ? c.fixed.filter((x) => ok(x) && (hp(x) ?? 0) > 0) : findTargets(o);
    const fn = c.timeline[c.next][1];
    c.next++;
    safe(() => fn(c));
  }
  if (c.combo && !c.finishing && t - c.start >= c.rainAt) { // комбо-ульта: кости с неба по целям
    c.rainAt = t - c.start + Math.round(rand(c.rainMin, c.rainMax));
    for (const tg of findTargets(o)) { const l = tg.location; dropBone(c.rain, l.x, l.z, l.y); }
  }
  if (t - c.candsAt >= 3) { c.cands = candidates(c.dim, o.location, CFG.ULT.RADIUS + 18, o, true); c.candsAt = t; }
  c.bones = c.bones.filter((b) => { const keep = tickBone(c, b, t); if (!keep) safe(() => b.ent.remove()); return keep; });
  c.blasters = c.blasters.filter((b) => { const keep = tickBlaster(c, b, t); if (!keep) safe(() => b.ent.remove()); return keep; });
  if (c.finishing && !c.bones.length && !c.blasters.length) endUlt(c, id);
}



// ---- Dust, последняя атака: кость, вылезающая из-под земли прямо под противником
// Предупреждение: фиолетовые искры на земле ULT_UNDER_WARN тиков, затем шип; вызывается вместо части костей волн.
function underSpike(c, tg) {
  const D = DST, l = tg.location, pt = { x: l.x + rand(-1.1, 1.1), z: l.z + rand(-1.1, 1.1) };
  for (let k = 0; k < D.ULT_UNDER_WARN; k += 4) system.runTimeout(() => {
    if (!ok(c.owner)) return;
    const gy = groundY(c.dim, pt.x, l.y, pt.z) + 0.1;
    for (let j = 0; j < 6; j++) { const a = (j * Math.PI) / 3; fx(c.dim, "sansmode:dust_spark", { x: pt.x + Math.cos(a) * 0.8, y: gy, z: pt.z + Math.sin(a) * 0.8 }); }
  }, k);
  system.runTimeout(() => {
    if (!ok(c.owner)) return;
    const y = groundY(c.dim, pt.x, l.y, pt.z);
    const ent = safe(() => c.dim.spawnEntity("dustsans:bone_spike", { x: pt.x, y, z: pt.z }));
    if (!ent) return;
    snd(c.dim, "dig.stone", { x: pt.x, y, z: pt.z }, 1, 0.8);
    spikes.push({ red: dstRed(c.owner, ent), ent, dim: c.dim, x: pt.x, y, z: pt.z, born: now(), owner: c.owner, hit: new Set(), dmg: D.ULT_UNDER_DMG + (c.bonus || 0) });
  }, D.ULT_UNDER_WARN);
}

// ---- Dust, последняя атака: «Телекинез» (подброс всех в радиусе 5), затем зависание и шипы снизу под ногами
function ultTele(c) {
  const D = DST, T = CFG.TELE, owner = c.owner, dim = c.dim;
  if (!ok(owner)) return;
  snd(dim, "beacon.power_select", owner.location, 1.2, 1.2);
  for (let k = 0; k < T.WINDUP; k++) system.runTimeout(() => { // кольца сжимаются к игроку
    if (!ok(owner)) return;
    const q = owner.location, r = T.RADIUS * (1 - k / T.WINDUP);
    for (let j = 0; j < 16; j++) { const a = (j / 16) * Math.PI * 2; fx(dim, "sansmode:dust_spark", { x: q.x + Math.cos(a) * r, y: q.y + 0.2, z: q.z + Math.sin(a) * r }); }
  }, k);
  system.runTimeout(() => { // подброс
    if (!ok(owner)) return;
    const q = owner.location, victims = [];
    snd(dim, "mob.wither.shoot", q, 1.4, 0.8);
    for (const e of candidates(dim, q, T.RADIUS, owner, false)) if (tryEffect(e, ["levitation"], D.ULT_TELE_LIFT, T.AMPLIFIER)) victims.push(e);
    system.runTimeout(() => { // зависание: цели уже в воздухе
      if (!ok(owner)) return;
      for (const e of victims) if (ok(e)) { safe(() => e.removeEffect("levitation")); tryEffect(e, ["levitation"], D.ULT_TELE_HOVER, 0); fx(dim, "sansmode:dust_spark", e.location); }
      system.runTimeout(() => { // шипы снизу, прямо под парящими целями
        if (!ok(owner)) return;
        for (const e of victims) {
          if (!ok(e)) continue;
          const l = e.location, y = l.y - 0.6;
          const ent = safe(() => dim.spawnEntity("dustsans:bone_spike", { x: l.x, y, z: l.z }));
          if (!ent) continue;
          spikes.push({ red: dstRed(owner, ent), ent, dim, x: l.x, y, z: l.z, born: now(), owner, hit: new Set(), dmg: D.ULT_TELE_DMG + (c.bonus || 0) });
        }
        snd(dim, "dig.stone", q, 1.2, 0.6);
      }, D.ULT_TELE_WARN);
    }, D.ULT_TELE_LIFT);
  }, T.WINDUP);
}

// ---- Летящие кости «крестом» ----
// После серии метательных костей: серия из FLY.THROWS метаний -> кости летят в цель с 1, потом 2, 3 и 4 сторон
//   (каждая следующая серия добавляет сторону; без метаний SIDES_IDLE тиков счёт начинается заново).
// После залпа гастер-бластеров: кости летят с одной случайной стороны.
// Кости летят рядами: каждый ряд стартует через ROW_STEP тиков после предыдущего.
// Метания и гастер-бластеры сообщают о себе тегами из animation_controllers/sans.json: sans_cast_bthrow / sans_cast_gbfire.
const FLY = {
  THROWS: 3,          // метаний в одной серии
  SERIES_IDLE: 200,   // тиков без метаний — серия метаний прерывается
  SIDES_IDLE: 900,    // тиков без серий — «крест» снова начинается с 1 стороны
  MAX_SIDES: 4,
  ROWS: 2,            // рядов на одну сторону
  ROW_STEP: 7,        // тиков между рядами (ряды летят по очереди, не все сразу)
  FIRST: 20,          // задержка первого ряда после метаний (телеграф)
  GB_FIRST: 30,       // задержка после выстрела гастер-бластеров (сначала бьют они)
  R: 12,              // дистанция первого ряда от цели
  R_STEP: 3,          // второй ряд ближе
  WIDTH: 3.6,         // ширина ряда
  BONES: 4,           // костей в ряду
  SPEED: 0.6,         // скорость (блоков/тик)
};
const flyStates = new Map(); // p.id -> { n, last, done, no }
function flyState(p) {
  let s = flyStates.get(p.id);
  if (!s) flyStates.set(p.id, (s = { n: 0, last: -99999, done: -99999, no: 0 }));
  return s;
}


// ================================================================ DUST: Shift-комбо через скрипт ===
// В анимациях Dust нет состояний Shift, поэтому комбо определяем тут. Обычный каст уже списал стамину обычной атаки,
// комбо доплачивает ещё раз то же самое (итого x2). Не хватает на доплату — идёт обычная атака.
const sneaking = (p) => safe(() => p.isSneaking) === true;
function dustCombo(p, evt, normalCost, fn) {
  if (!isDust(p)) return false;
  const sn = sneaking(p);

  if (!sn) return false;
  if (!isTrial(p) && stamina(p) < normalCost) return false;
  fn(() => safe(() => p.triggerEvent(evt)));
  return true;
}

// ---- Shift + Гастер-бластеры: ещё 2 бластера сзади цели, потом дождь костей
function comboGasterBehind(p, pay) {
  const X = COMBO.GX, key = "gbb:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  if (!isTrial(p) && pay) pay();

  const o = p.location, tl = target.location, a0 = Math.atan2(tl.z - o.z, tl.x - o.x); // от игрока через цель = «сзади цели»
  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false };
  c.timeline = [
    [0, (cc) => {
      title(cc, "§l§b[ Комбо ]");
      const t = now();
      for (const d of [-0.5, 0.5]) addBlaster(cc, { target, ang: a0 + d, r: 7.5, h: 1.0, spin: 0, spawnAt: t, lockAt: t + 20, fireAt: t + 40, beamTicks: 24, dmg: CFG.ULT.BEAM_DAMAGE, floor: CFG.ULT.BEAM_FLOOR });
    }],
    [42, () => { const l = ok(target) ? target.location : tl; startRainAt(p, { x: l.x, y: l.y, z: l.z }, 40, 50, 12, 8); }],
    [150, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key + ":" + now(), c);
}

// ---- Shift + Откидывание: цель подбрасывается на подвижную платформу, по ней по очереди бьют бластеры (можно подпрыгнуть)
const PLAT = { SIZE: 2, LIFT: 5, LIFT_TICKS: 10, MOVE_EVERY: 12, SHOTS: 6, SHOT_GAP: 38, LOCK: 12, FIRE: 20, BEAM: 8, R: 6.5, BEAM_R: 1.1, BLOCK: "minecraft:bone_block" };
const PLAT_MOVE = [1, 2, 1, 0, -1, -2, -1, 0];
function platSet(c, ox, oz) { // перекладываем блоки платформы со сдвигом
  const P = PLAT;
  for (const b of c.plat) safe(() => { const bl = c.dim.getBlock(b); if (bl && bl.typeId === P.BLOCK) bl.setType("minecraft:air"); });
  c.plat = [];
  for (let dx = -P.SIZE; dx <= P.SIZE; dx++) for (let dz = -P.SIZE; dz <= P.SIZE; dz++) {
    const pos = { x: c.cx + ox + dx, y: c.by, z: c.cz + oz + dz };
    safe(() => { const bl = c.dim.getBlock(pos); if (bl && isEmpty(bl)) { bl.setType(P.BLOCK); c.plat.push(pos); } });
  }
  c.ox = ox; c.oz = oz; // где сейчас платформа — нужно, чтобы вернуть цель обратно, если она упала
}
function comboPlatform(p, pay) {
  const P = PLAT, U = CFG.ULT, free = isTrial(p), dim = p.dimension;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  if (!free && pay) pay();

  const l0 = target.location;
  const mv = Math.random() < 0.5 ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const c = { owner: p, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false,
    plat: [], cx: Math.floor(l0.x), cz: Math.floor(l0.z), by: Math.floor(l0.y) + P.LIFT - 1 };
  c.onEnd = (cc) => { for (const b of cc.plat) safe(() => { const bl = cc.dim.getBlock(b); if (bl && bl.typeId === P.BLOCK) bl.setType("minecraft:air"); }); cc.plat = []; };
  const t0 = P.LIFT_TICKS, firstShot = t0 + 8, total = firstShot + P.SHOTS * P.SHOT_GAP + P.FIRE + P.BEAM;
  const sides = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  c.timeline = [
    [0, (cc) => {
      title(cc, "§l§9[ Платформа ]");
      snd(dim, "mob.wither.shoot", l0, 1.3, 0.8);
      if (ok(target)) { tryEffect(target, ["levitation"], P.LIFT_TICKS, 8); fx(dim, "minecraft:totem_particle", target.location); }
    }],
    [t0, (cc) => { // платформа готова: цель встаёт на неё
      if (!ok(target)) return;
      safe(() => target.removeEffect("levitation"));
      tryEffect(target, ["slow_falling"], total + 80, 0); // не разобьётся, если спрыгнет или платформа исчезнет
      platSet(cc, 0, 0);
      safe(() => target.teleport({ x: cc.cx + 0.5, y: cc.by + 1, z: cc.cz + 0.5 }, { dimension: dim }));
      snd(dim, "dig.stone", target.location, 1, 0.7);
    }],
  ];
  for (let k = 1; t0 + k * P.MOVE_EVERY < total; k++) { // платформа плавно ездит туда-сюда
    const off = PLAT_MOVE[k % PLAT_MOVE.length];
    c.timeline.push([t0 + k * P.MOVE_EVERY, (cc) => platSet(cc, mv.x * off, mv.z * off)]);
  }
  for (let k = 0; t0 + 4 + k * 3 < total; k++) { // упал мимо платформы на землю — возвращаем на платформу
    c.timeline.push([t0 + 4 + k * 3, (cc) => {
      if (!ok(target)) return;
      if (target.location.y < cc.by + 0.4) {
        safe(() => target.teleport({ x: cc.cx + 0.5 + (cc.ox || 0), y: cc.by + 1, z: cc.cz + 0.5 + (cc.oz || 0) }, { dimension: dim }));
        snd(dim, "mob.endermen.portal", target.location, 0.6, 1.4);
      }
    }]);
  }
  for (let i = 0; i < P.SHOTS; i++) { // бластеры по очереди с разных сторон, луч у самых ног — перепрыгни
    const at = firstShot + i * P.SHOT_GAP;
    c.timeline.push([at, (cc) => {
      if (!ok(target)) return;
      const t = now(), ang = (sides[i % 4] * Math.PI) / 2 + rand(-0.2, 0.2);
      addBlaster(cc, { target, ang, r: P.R, h: 0, yOff: 0.1, beamR: P.BEAM_R, spin: 0, spawnAt: t, lockAt: t + P.LOCK, fireAt: t + P.FIRE, beamTicks: P.BEAM, dmg: U.BEAM_DAMAGE, floor: U.BEAM_FLOOR });
    }]);
  }
  c.timeline.sort((a, b) => a[0] - b[0]);
  c.timeline.push([total + 4, (cc) => { cc.finishing = true; }]);
  ults.set("plat:" + p.id + ":" + now(), c);
}

// ---- Shift + Метательные кости: цель откидывает, сзади её ждёт фантомный Папирус и бьёт веером костей
function comboPapFan(p, target) {
  const dim = p.dimension, o = p.location, tl = { ...target.location };
  const d = norm({ x: tl.x - o.x, y: 0, z: tl.z - o.z });

  knock(target, d.x, d.z, 1.1, 0.35);
  const pp = { x: tl.x + d.x * 9, y: tl.y, z: tl.z + d.z * 9 };
  pp.y = groundY(dim, pp.x, tl.y, pp.z);
  const ent = safe(() => dim.spawnEntity("dustsans:papyrus", pp));
  if (ent) { safe(() => ent.teleport(pp, { facingLocation: tl })); snd(dim, "mob.endermen.portal", pp, 1.0, 0.5); for (let k = 0; k < 16; k++) fx(dim, "sansmode:dust", { x: pp.x + rand(-0.6, 0.6), y: pp.y + rand(0.2, 2.0), z: pp.z + rand(-0.6, 0.6) }); }
  const c = { owner: p, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false,
    onEnd: () => { if (ent && ok(ent)) { const l = ent.location; for (let k = 0; k < 20; k++) fx(dim, "sansmode:dust", { x: l.x + rand(-0.6, 0.6), y: l.y + rand(0.2, 2.0), z: l.z + rand(-0.6, 0.6) }); safe(() => ent.remove()); } } };
  const F = DU.PAP.FAN;
  c.timeline = [
    [26, (cc) => { // веер из 10 костей в цель
      const t = now(), from = { x: pp.x, y: pp.y + 1.3, z: pp.z };
      const aim = ok(target) ? chestOf(target) : add(tl, { x: 0, y: 1, z: 0 });
      const base = norm(sub(aim, from)), hz = Math.hypot(base.x, base.z) || 1, yaw0 = Math.atan2(base.z, base.x);
      for (let i = 0; i < F.COUNT; i++) {
        const a = yaw0 + (i / (F.COUNT - 1) - 0.5) * F.SPREAD, dir = norm({ x: Math.cos(a) * hz, y: base.y, z: Math.sin(a) * hz });
        addBone(cc, { pos: add(from, mul(dir, 1.2)), launchAt: t + F.DELAY, vel: mul(dir, F.SPEED), life: Math.ceil(30 / F.SPEED) });
      }
      snd(dim, "mob.skeleton.step", from, 1, 0.6);
    }],
    [90, (cc) => { cc.finishing = true; }],
  ];
  ults.set("papfan:" + p.id + ":" + now(), c);
}

// ---- Метания: серия -> крест из костей (сторон столько, сколько серий подряд)
function onBoneThrow(p) {
  if (!isDust(p)) return; // только Dust
  const F = FLY, t = now(), s = flyState(p);
  if (t - s.last > F.SERIES_IDLE) s.n = 0;
  if (t - s.done > F.SIDES_IDLE) s.no = 0;
  s.last = t;

  if (++s.n < F.THROWS) return;
  s.n = 0; s.done = t; s.no++;
  const target = findTargets(p)[0];
  if (!target) return;
  const a0 = rand(0, Math.PI * 2);
  const sides = [0, Math.PI, Math.PI / 2, (Math.PI * 3) / 2].slice(0, Math.min(s.no, F.MAX_SIDES)).map((x) => a0 + x);
  if (sneaking(p)) return comboPapFan(p, target);

  flyCross(p, target, sides, F.FIRST, false); // Dust: кости красные с шансом 50%
}

// ---- Гастер-бластеры: кости с одной случайной стороны
function onGasterFire(p) {
  if (!isDust(p)) return; // только Dust
  const pst = safe(() => p.dimension.getEntities({ tags: ["pst"], location: p.location, maxDistance: 25 })) || [];
  const tg = pst.find((e) => e.id !== p.id && ok(e)) || findTargets(p)[0];
  if (!tg) return;

  flyCross(p, tg, [rand(0, Math.PI * 2)], FLY.GB_FIRST, false);
}

// Общий запуск: контекст ульты с фиксированной целью, ряды по таймлайну
function flyCross(p, target, angs, first, noRed) {
  const F = FLY;
  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false, timeline: [] };
  let k = 0;
  for (const a of angs) for (let r = 0; r < F.ROWS; r++, k++) {
    const R = F.R - r * F.R_STEP;
    c.timeline.push([first + k * F.ROW_STEP, (cc) => flyRow(cc, a, R, noRed)]);
  }
  c.timeline.push([first + (k + 1) * F.ROW_STEP, (cc) => { cc.finishing = true; }]);
  ults.set("fly:" + p.id + ":" + now(), c);
}

// Один ряд: костей в линию поперёк полёта, летят с стороны `a` к цели
function flyRow(c, a, R, noRed) {
  const F = FLY, t = now(), tg = c.targets && c.targets[0];
  if (!tg || !ok(tg)) return;
  const l = tg.location, d = { x: Math.cos(a), y: 0, z: Math.sin(a) }, perp = { x: -d.z, y: 0, z: d.x };
  const vel = mul(d, -F.SPEED), life = Math.ceil((R * 2 + 6) / F.SPEED);
  for (let j = 0; j < F.BONES; j++) {
    const off = (j - (F.BONES - 1) / 2) * (F.WIDTH / (F.BONES - 1));
    const pos = { x: l.x + d.x * R + perp.x * off, y: l.y + 0.9, z: l.z + d.z * R + perp.z * off };
    addBone(c, { pos, launchAt: t + 8, vel, life, noRed });
  }
}

// ======================================================== КОМБО-АТАКИ (Shift) ===
// Shift зажат в момент нажатия + предмет в руке:
//   кость (bone0)      -> comboBlasterBones : 2 бластера сверху + кости с боков
//   костяные шипы      -> comboCrossSpikes  : шипы тремя рядами в форме креста
//   костяная стена     -> comboArena        : круг из стен (мини-арена)
const COMBO = {
  BLASTER: { COST: 7, RANGE: 30, HEIGHT: 5.2, GAP: 1.8, LOCK: 18, FIRE: 40, BEAM_TICKS: 26, SIDE_DIST: 13, SIDE_BONES: 4, END: 130 },   // 3,5 сердца
  CROSS:   { COST: 8, SPACING: 1.6, ARM: 8, WIDTH: 3, ROW_STEP: 0.9, START: 1.8, STEP: 2, WARN: 8, COOLDOWN: 40 },                      // 4 сердца
  ARENA:   { COST_MULT: 2, LIFE_MULT: 2, RADIUS: 6, SPACING: 0.6, ROWS: 2, ROW_GAP: 0.5 },                                            // x2 стамина, x2 время жизни
};
const comboCooldown = new Map();
COMBO.CROSS_DUST = { ...COMBO.CROSS, COST: 4, WIDTH: 9 }; // Dust: стоимость x2, ширина x3 (количество), шипы x3 по размеру

function comboTarget(p) {
  const list = candidates(p.dimension, p.location, COMBO.BLASTER.RANGE, p, true);
  const ids = new Set(list.map((e) => e.id));
  const seen = safe(() => p.getEntitiesFromViewDirection({ maxDistance: COMBO.BLASTER.RANGE })) || [];
  for (const r of seen) if (r.entity && ids.has(r.entity.id)) return r.entity; // на кого смотрит игрок
  return findTargets(p)[0]; // иначе ближайший
}

// ---- Комбо 1: 2 бластера над врагом + кости с боков
function comboBlasterBones(p, pay = null) {
  const B = COMBO.BLASTER, key = "combo:" + p.id;
  if (ults.has(key) || ults.has(p.id)) return;
  const free = isTrial(p);
  if (!free && !pay && stamina(p) < B.COST) return deny(p, "§cНе хватает стамины для комбо");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  if (!free) { if (pay) pay(); else p.triggerEvent("combo_bone_remove"); }

  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false };
  const o = p.location, tl = target.location;
  const a0 = Math.atan2(tl.z - o.z, tl.x - o.x) + Math.PI / 2; // перпендикуляр к линии «игрок → цель»
  c.timeline = [
    [0, (cc) => {
      title(cc, "§l§b[ Комбо ]");
      const t = now();
      for (const side of [0, 1]) {
        addBlaster(cc, { target, ang: a0 + side * Math.PI, r: B.GAP, h: B.HEIGHT, spin: 0, spawnAt: t, lockAt: t + B.LOCK, fireAt: t + B.FIRE,
          beamTicks: B.BEAM_TICKS, dmg: CFG.ULT.BEAM_DAMAGE, lethal: true });
      }
    }],
    [8, (cc) => { // кости летят с боков навстречу друг другу, по очереди
      const t = now(), ctr = center(target);
      for (const side of [-1, 1]) {
        for (let j = 0; j < B.SIDE_BONES; j++) {
          const pos = { x: ctr.x + Math.cos(a0) * side * B.SIDE_DIST, y: ctr.y + [-0.5, 0, 0.5, 0][j % 4], z: ctr.z + Math.sin(a0) * side * B.SIDE_DIST };
          const launchAt = t + 18 + j * 9;
          addBone(cc, { pos, mob: !isPlayerEnt(target), launchAt, lockAt: launchAt - 8, speed: CFG.ULT.BONE_SPEED, life: Math.ceil((B.SIDE_DIST * 2 + 6) / CFG.ULT.BONE_SPEED),
            aimFn: (f, sp) => aimPoint(target, ctr, 0.9, f, sp) });
        }
      }
    }],
    [B.END, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key, c);
}

// ---- Комбо 2: шипы крестом, каждая линия в 3 ряда
function comboCrossSpikes(p, pay = null) {
  const X = isDust(p) ? COMBO.CROSS_DUST : COMBO.CROSS, S = CFG.SPIKES, t0 = now();

  if (!isDust(p) && t0 < (spikeCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && !pay && stamina(p) < X.COST) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) { if (pay) pay(); else p.triggerEvent("combo_spikes_remove"); }
  spikeCooldown.set(p.id, t0 + X.COOLDOWN);

  const dim = p.dimension, o = p.location, h = viewDirH(p);
  const perp = { x: -h.z, z: h.x };
  const mid = X.START + ((X.ARM - 1) / 2) * X.SPACING;     // где вторая часть креста пересекает первую
  const pts = [], seen = new Set();
  const add1 = (along, lateral, delay) => {
    const x = o.x + h.x * along + perp.x * lateral, z = o.z + h.z * along + perp.z * lateral;
    const k = Math.round(x * 2) + ":" + Math.round(z * 2);
    if (seen.has(k)) return; seen.add(k);
    pts.push({ x, z, delay });
  };
  const rows = Array.from({ length: X.WIDTH }, (_, r) => (r - (X.WIDTH - 1) / 2) * X.ROW_STEP);
  for (let i = 0; i < X.ARM; i++)                           // первая часть: по взгляду
    for (const lat of rows) add1(X.START + i * X.SPACING, lat, i * X.STEP);
  for (let j = 0; j < X.ARM; j++) {                         // вторая часть: поперёк, через середину первой
    const lateral = (j - (X.ARM - 1) / 2) * X.SPACING;
    const delay = Math.round(((X.ARM - 1) / 2) * X.STEP) + Math.floor(Math.abs(lateral) / X.SPACING * X.STEP);
    for (const al of rows) add1(mid + al, lateral, delay);
  }
  const shared = new Set(); // один удар на цель за всё комбо

  pts.forEach((pt, idx) => {
    system.runTimeout(() => {
      if (!ok(p)) return;
      const y = groundY(dim, pt.x, o.y, pt.z);
      for (let k = 0; k < 2; k++) fx(dim, "minecraft:basic_smoke_particle", { x: pt.x + rand(-0.3, 0.3), y: y + 0.1, z: pt.z + rand(-0.3, 0.3) });
      if (idx % 4 === 0) snd(dim, "dig.stone", { x: pt.x, y, z: pt.z }, 0.7, 1.5);
      system.runTimeout(() => {
        if (!ok(p)) return;
        const ent = safe(() => dim.spawnEntity(isDust(p) ? "dustsans:bone_spike_big" : "playersans:bone_spike", { x: pt.x, y, z: pt.z }));
        if (!ent) return;
        if (idx % 4 === 0) snd(dim, "dig.stone", { x: pt.x, y, z: pt.z }, 1, 0.8);
        spikes.push({ red: dstRed(p, ent), ent, dim, x: pt.x, y, z: pt.z, born: now(), owner: p, hit: shared, big: isDust(p) });
      }, X.WARN);
    }, pt.delay);
  });
}

// ---- Комбо 3: круг из костяных стен (арена)
function comboArena(p, pay = null) {
  const A = COMBO.ARENA, W = CFG.WALL, t0 = now();
  if (!isDust(p) && t0 < (wallCooldown.get(p.id) || 0)) return;
  const cost = W.COST * A.COST_MULT, free = isTrial(p);
  if (!free && !pay && stamina(p) < cost) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) { if (pay) pay(); else p.triggerEvent("combo_wall_remove"); }
  const life = W.LIFE * A.LIFE_MULT;
  wallCooldown.set(p.id, t0 + W.COOLDOWN + life);

  const dim = p.dimension, o = p.location;
  const shared = { hit: new Set(), pushed: new Map() };
  for (let row = 0; row < A.ROWS; row++) {
    const R = A.RADIUS + row * A.ROW_GAP;
    const n = Math.round((Math.PI * 2 * R) / A.SPACING);
    for (let i = 0; i < n; i++) {
      const ang = ((i + (row % 2 ? 0.5 : 0)) / n) * Math.PI * 2;
      const nx = Math.cos(ang), nz = Math.sin(ang);
      const x = o.x + nx * R, z = o.z + nz * R;
      system.runTimeout(() => {
        if (!ok(p)) return;
        const y = groundY(dim, x, o.y, z);
        fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
        system.runTimeout(() => {
          const ent = safe(() => dim.spawnEntity("playersans:bone_arena_piece", { x, y, z }));
          if (!ent) return;
          if (i % 8 === 0) snd(dim, "dig.stone", { x, y, z }, 0.9, 0.8);
          wallPieces.push({ red: dstRed(p, ent), ent, dim, x, y, z, nx, nz, born: now(), owner: p, shared, life });
        }, W.WARN);
      }, Math.floor((i / n) * 16)); // круг «замыкается» за ~0,8 с
    }
  }
  // Шипы обвивают стену: два кольца, снаружи и изнутри, вокруг каждого ряда
  const wrapShared = new Set();

  if (isDust(p)) for (const R of [A.RADIUS - 1.5, A.RADIUS + A.ROW_GAP + 1.5]) {
    const n = Math.round((Math.PI * 2 * R) / 1.4);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2, x = o.x + Math.cos(ang) * R, z = o.z + Math.sin(ang) * R;
      system.runTimeout(() => {
        if (!ok(p)) return;
        const y = groundY(dim, x, o.y, z);
        system.runTimeout(() => {
          if (!ok(p)) return;
          const ent = safe(() => dim.spawnEntity(ET(p, "playersans:bone_spike"), { x, y, z }));
          if (!ent) return;
          spikes.push({ red: dstRed(p, ent), ent, dim, x, y, z, born: now(), owner: p, hit: wrapShared });
        }, W.WARN + 2);
      }, Math.floor((i / n) * 16));
    }
  }
  snd(dim, "mob.wither.spawn", o, 0.8, 1.8);
}


// ================================================== КОМБО: Отбрасывание / Стоп-время / Гравитация ===
//   Shift + Отбрасывание  -> comboThrowWall : стена из костей в 10 блоках, всех рядом швыряет в неё
//   Shift + Быстрое перемещение -> comboTimeStop : «остановка времени» (заморозка всех вокруг)
//   Shift + Телекинез     -> comboSlam : подброс на ~4 блока, шипы из земли, удар об землю
COMBO.THROW = { COST: 8, DIST: 10, HALF_WIDTH: 8, RADIUS: 7, PUSH_DAMAGE: 6, SPEED: 1.1, LAUNCH_AT: 12, LIFE: 70, SPACING: 0.6, ROWS: 2, ROW_GAP: 0.5, COOLDOWN: 100 };   // 4 сердца
COMBO.TIME  = { COST: 12, DURATION: 100, DURATION_DUST: 300, RADIUS: 40, MAX: 90, COOLDOWN: 600 };                                                                                      // 6 сердец, 5 с
COMBO.SLAM  = { COST: 8, RADIUS: 5, FIELD_R: 3.2, WINDUP: 6, LIFT_AMP: 6, LIFT_TICKS: 14, HOVER_TICKS: 14, SPIKE_STEP: 1.2, SPIKE_DAMAGE: 10, FALL_DAMAGE: 3, SLAM_SPEED: 1.4, SAFE_TICKS: 160, COOLDOWN: 120 }; // 4 сердца
COMBO.SLAM_DUST = { COST: 12, RADIUS: 5, WINDUP: 6, LIFT_AMP: 6, LIFT_TICKS: 14, SAFE_TICKS: 160, COOLDOWN: 120, SIDE_R: 4.5, SIDE_LOCK: 12, SIDE_FIRE: 30, SIDE_BEAM: 16 }; // Dust: 6 сердец (x2 стамина)

const tryEffect = (e, names, dur, amp) => {
  for (const n of names) { try { if (e.addEffect(n, dur, { amplifier: amp, showParticles: false })) return true; } catch (_) {} }
  return false;
};

// ---------- Комбо: стена + швыряние ----------
const throwCooldown = new Map();
const flings = [];

function comboThrowWall(p) {
  const C = COMBO.THROW, W = CFG.WALL, t0 = now();
  if (!isDust(p) && t0 < (throwCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && stamina(p) < C.COST) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) p.triggerEvent("combo_throw_remove");
  throwCooldown.set(p.id, t0 + C.COOLDOWN);

  const dim = p.dimension, o = { ...p.location }, h = viewDirH(p), perp = { x: -h.z, z: h.x };
  safe(() => p.runCommand(tt("§l§9[ Комбо ]")));
  snd(dim, "mob.wither.shoot", o, 1.2, 0.7);

  // стена (те же куски, что у обычной Костяной стены: урон и отталкивание делает tickWalls)
  const shared = { hit: new Set(), pushed: new Map() };
  const n = Math.round(C.HALF_WIDTH / C.SPACING);
  for (let row = 0; row < C.ROWS; row++) {
    for (let i = -n; i <= n; i++) {
      const u = i * C.SPACING + (row % 2 ? C.SPACING / 2 : 0);
      if (Math.abs(u) > C.HALF_WIDTH + 0.01) continue;
      const x = o.x + h.x * (C.DIST + row * C.ROW_GAP) + perp.x * u;
      const z = o.z + h.z * (C.DIST + row * C.ROW_GAP) + perp.z * u;
      system.runTimeout(() => {
        if (!ok(p)) return;
        const y = groundY(dim, x, o.y, z);
        fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
        system.runTimeout(() => {
          const ent = safe(() => dim.spawnEntity("playersans:bone_wall_piece", { x, y, z }));
          if (!ent) return;
          if (i % 4 === 0) snd(dim, "dig.stone", { x, y, z }, 0.8, 0.8);
          wallPieces.push({ red: dstRed(p, ent), ent, dim, x, y, z, nx: h.x, nz: h.z, born: now(), owner: p, shared, life: C.LIFE });
        }, W.WARN);
      }, Math.floor(Math.abs(u) * 0.6)); // волна от центра к краям, быстрее обычной стены
    }
  }

  // швыряние: все рядом летят к стене (урон от отбрасывания + урон стены от tickWalls)
  system.runTimeout(() => {
    if (!ok(p)) return;
    const base = p.location;
    snd(dim, "mob.warden.sonic_boom", base, 1.5, 1.2);
    for (const e of candidates(dim, base, C.RADIUS, p, false)) {
      if (sliding.has(e.id)) continue;
      const l = e.location;
      const along = (l.x - o.x) * h.x + (l.z - o.z) * h.z;
      const lateral = (l.x - o.x) * perp.x + (l.z - o.z) * perp.z;
      const want = (C.DIST - 0.6) - along;           // остановиться у передней кромки стены
      if (want < 0.4 || Math.abs(lateral) > C.HALF_WIDTH - 0.5) continue;
      if (hurt(e, C.PUSH_DAMAGE, p, 0) < 0) continue;
      const room = freeDistance(dim, l, h.x, h.z, want);
      sliding.add(e.id);
      flings.push({ ent: e, id: e.id, dim, owner: p, from: { x: l.x, z: l.z }, dx: h.x, dz: h.z, dist: room, blocked: room < want - 0.6, k: 0 });
      knock(e, h.x, h.z, 0.01, 0.2);
      fx(dim, "minecraft:blue_flame_particle", { x: l.x, y: l.y + 1, z: l.z });
    }
  }, C.LAUNCH_AT);
}

function tickFlings() {
  const C = COMBO.THROW;
  for (let i = flings.length - 1; i >= 0; i--) {
    const f = flings[i];
    if (!ok(f.ent)) { sliding.delete(f.id); flings.splice(i, 1); continue; }
    f.k++;
    const d = Math.min(f.dist, f.k * C.SPEED);
    const y = safe(() => f.ent.location.y);
    if (y !== undefined) safe(() => f.ent.teleport({ x: f.from.x + f.dx * d, y, z: f.from.z + f.dz * d }, { dimension: f.dim }));
    if (f.k % 2 === 0) fx(f.dim, "minecraft:blue_flame_particle", f.ent.location);
    if (d >= f.dist) { // долетел
      if (f.blocked) { // упёрся в обычный блок: тоже «врезался в стену»
        if (hurt(f.ent, CFG.WALL.DAMAGE, f.owner, 0) >= 0) { snd(f.dim, "dig.stone", f.ent.location, 1, 0.7); }
      }
      if (!isPlayerEnt(f.ent)) safe(() => f.ent.clearVelocity());
      sliding.delete(f.id); flings.splice(i, 1);
    }
  }
}

// ---------- Комбо: «остановка времени» ----------
// В Bedrock время остановить нельзя, поэтому костыль: всех вокруг каждый тик возвращаем в точку заморозки,
// вешаем замедление 255 / слабость 255 (мобы и игроки не двигаются и не бьют), игрокам ещё темнота (как у вардена).
const timeStops = new Map();
const timeCooldown = new Map();
const TIME_SKIP_TYPES = ["minecraft:item", "minecraft:xp_orb", "minecraft:lightning_bolt", "minecraft:xp_bottle"];

function comboTimeStop(p) {
  const T = COMBO.TIME, t0 = now();
  if (timeStops.has(p.id)) return;
  if (!isDust(p) && t0 < (timeCooldown.get(p.id) || 0)) return deny(p, "§7Время ещё не восстановилось");
  const free = isTrial(p);
  if (!free && stamina(p) < T.COST) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) p.triggerEvent(isDust(p) ? "dst_under_remove" : "combo_time_remove"); // у Dust это чистое списание 12 стамины
  timeCooldown.set(p.id, t0 + T.COOLDOWN);


  const dim = p.dimension;
  snd(dim, "beacon.activate", p.location, 1.5, 0.5);
  snd(dim, "mob.endermen.portal", p.location, 1.2, 0.5);
  safe(() => p.runCommand(tt("§l§e[ Время остановлено ]")));
  timeStops.set(p.id, { owner: p, dim, end: t0 + (isDust(p) ? T.DURATION_DUST : T.DURATION), scanAt: -99, frozen: new Map() });
}

function freezeEffects(e) {
  tryEffect(e, ["slowness"], 12, 255);
  tryEffect(e, ["weakness"], 12, 255);
  if (isPlayerEnt(e)) {
    tryEffect(e, ["jump_boost"], 12, 128);
    tryEffect(e, ["darkness", "blindness"], 40, 0);
  }
}

function endTimeStop(id, c, quiet) {
  timeStops.delete(id);
  for (const f of c.frozen.values()) {
    if (!ok(f.ent)) continue;
    if (!isPlayerEnt(f.ent) && f.vel) safe(() => f.ent.applyImpulse(f.vel)); // снаряды и падающие летят дальше как летели
  }
  if (!quiet && ok(c.owner)) {
    snd(c.dim, "beacon.deactivate", c.owner.location, 1.5, 0.6);
    safe(() => c.owner.runCommand(tt("§7[ Время пошло ]")));
  }
}

function tickTimeStops(t) {
  const T = COMBO.TIME;
  for (const [id, c] of [...timeStops]) {
    const o = c.owner;
    if (!ok(o) || o.dimension !== c.dim || t >= c.end || (hp(o) ?? 1) <= 0) { endTimeStop(id, c); continue; }
    const scan = t - c.scanAt >= 5;
    if (scan) {
      c.scanAt = t;
      const q = { location: o.location, maxDistance: T.RADIUS, excludeFamilies: ["psans"], excludeTypes: TIME_SKIP_TYPES, excludeTags: ["sans_ignore"] };
      if (!CFG.HIT_PLAYERS) q.excludeTypes = [...TIME_SKIP_TYPES, "minecraft:player"];
      for (const e of safe(() => c.dim.getEntities(q)) || []) {
        if (e.id === o.id || c.frozen.has(e.id) || c.frozen.size >= T.MAX || !ok(e)) continue;
        c.frozen.set(e.id, { ent: e, pos: { ...e.location }, vel: safe(() => e.getVelocity()) });
      }
    }
    for (const [eid, f] of c.frozen) {
      if (!ok(f.ent)) { c.frozen.delete(eid); continue; }
      const l = f.ent.location;
      if (Math.abs(l.x - f.pos.x) + Math.abs(l.y - f.pos.y) + Math.abs(l.z - f.pos.z) > 0.02) {
        safe(() => f.ent.teleport(f.pos, { dimension: c.dim }));
        if (!isPlayerEnt(f.ent)) safe(() => f.ent.clearVelocity());
      }
      if (scan) freezeEffects(f.ent);
    }
    if (t % 10 === 0) for (const f of [...c.frozen.values()].slice(0, 12)) if (ok(f.ent)) fx(c.dim, "minecraft:totem_particle", f.ent.location);
  }
}

// ---------- Комбо: подброс на 4 блока + кости из земли + удар об землю ----------
const slamCooldown = new Map();
const slams = [];

function groundBelow(dim, x, y, z, depth) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let yy = Math.floor(y); yy >= Math.floor(y) - depth; yy--) {
    const b = safe(() => dim.getBlock({ x: bx, y: yy, z: bz }));
    if (b && !isEmpty(b)) return yy + 1;
  }
  return null;
}

function comboSlamOld(p) {
  const G = COMBO.SLAM, S = CFG.SPIKES, t0 = now();
  if (!isDust(p) && t0 < (slamCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && stamina(p) < G.COST) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) p.triggerEvent("combo_slam_remove");
  slamCooldown.set(p.id, t0 + G.COOLDOWN);

  const dim = p.dimension, o = { ...p.location };
  const tLift = G.WINDUP, tHover = tLift + G.LIFT_TICKS, tSlam = tHover + G.HOVER_TICKS;
  safe(() => p.runCommand(tt("§l§9[ Гравитация ]")));
  snd(dim, "beacon.power_select", o, 1.2, 1.0);

  // подготовка: сжимающиеся кольца + трещины там, где вылезут кости
  for (let k = 0; k < G.WINDUP; k++) system.runTimeout(() => {
    const r = G.RADIUS * (1 - k / G.WINDUP);
    for (let j = 0; j < 20; j++) { const a = (j / 20) * Math.PI * 2; fx(dim, "minecraft:totem_particle", { x: o.x + Math.cos(a) * r, y: o.y + 0.2, z: o.z + Math.sin(a) * r }); }
  }, k);
  for (let k = tLift; k < tSlam; k += 4) system.runTimeout(() => {
    for (let j = 0; j < 14; j++) { const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random()) * G.FIELD_R; fx(dim, "minecraft:basic_smoke_particle", { x: o.x + Math.cos(a) * r, y: o.y + 0.15, z: o.z + Math.sin(a) * r }); }
  }, k);

  // 1) подброс (~4 блока): игрок ещё может двигаться в воздухе
  const victims = [];
  system.runTimeout(() => {
    snd(dim, "mob.wither.shoot", o, 1.3, 0.8);
    for (const e of candidates(dim, o, G.RADIUS, p, false)) {
      if (tryEffect(e, ["levitation"], G.LIFT_TICKS, G.LIFT_AMP)) { victims.push(e); fx(dim, "minecraft:totem_particle", e.location); }
    }
  }, tLift);

  // 2) зависание: медленный подъём, время «увернуться в бок»
  system.runTimeout(() => {
    for (const e of victims) if (ok(e)) { safe(() => e.removeEffect("levitation")); tryEffect(e, ["levitation"], G.HOVER_TICKS, 0); }
  }, tHover);

  // 3) кости вылезают из земли чуть раньше удара
  const shared = new Set();
  const spikeAt = tSlam - 2;
  const R = G.FIELD_R, st = G.SPIKE_STEP;
  for (let gx = -R; gx <= R + 0.01; gx += st) for (let gz = -R; gz <= R + 0.01; gz += st) {
    if (Math.hypot(gx, gz) > R) continue;
    const x = o.x + gx, z = o.z + gz;
    system.runTimeout(() => {
      const y = groundY(dim, x, o.y, z);
      const ent = safe(() => dim.spawnEntity("playersans:bone_spike", { x, y, z }));
      if (!ent) return;
      spikes.push({ red: dstRed(p, ent), ent, dim, x, y, z, born: now(), owner: p, hit: shared, dmg: G.SPIKE_DAMAGE, launch: 0 });
    }, spikeAt);
  }
  system.runTimeout(() => snd(dim, "dig.stone", o, 1.3, 0.7), spikeAt);

  // 4) удар: кто остался над костями — швыряется вниз без смягчения, кто ушёл в сторону — получает медленное падение
  system.runTimeout(() => {
    for (const e of victims) {
      if (!ok(e)) continue;
      const l = e.location;
      if (Math.hypot(l.x - o.x, l.z - o.z) <= R + 0.5) {
        safe(() => e.removeEffect("levitation"));
        if (!slams.some((s) => s.id === e.id)) slams.push({ ent: e, id: e.id, dim, owner: p, k: 0 });
      } else {
        safe(() => e.removeEffect("levitation"));
        tryEffect(e, ["slow_falling"], G.SAFE_TICKS, 0);
        if (isPlayerEnt(e)) safe(() => e.sendMessage(tx("§aТы увернулся!")));
      }
    }
  }, tSlam);
}

function comboSlam(p, pay = null) { return (isDust(p) || isLastBreath(p)) ? comboSlamDust(p, pay) : comboSlamOld(p); } // Sans: прежнее поведение, Dust/Last Breath: новое
function comboSlamDust(p, pay = null) {
  const G = COMBO.SLAM_DUST, U = CFG.ULT, t0 = now();
  if (!isDust(p) && t0 < (slamCooldown.get(p.id) || 0)) return;
  const free = isTrial(p);
  if (!free && !pay && stamina(p) < G.COST) return deny(p, "§cНе хватает стамины для комбо");
  if (!free) { if (pay) pay(); else p.triggerEvent("combo_slam_remove"); }
  slamCooldown.set(p.id, t0 + G.COOLDOWN);

  const dim = p.dimension, o = { ...p.location };
  const tLift = G.WINDUP, tFall = tLift + G.LIFT_TICKS;

  safe(() => p.runCommand(tt("§l§9[ Гравитация ]")));
  snd(dim, "beacon.power_select", o, 1.2, 1.0);
  for (let k = 0; k < G.WINDUP; k++) system.runTimeout(() => { // сжимающиеся кольца
    const r = G.RADIUS * (1 - k / G.WINDUP);
    for (let j = 0; j < 20; j++) { const a = (j / 20) * Math.PI * 2; fx(dim, "minecraft:totem_particle", { x: o.x + Math.cos(a) * r, y: o.y + 0.2, z: o.z + Math.sin(a) * r }); }
  }, k);

  // Подброс → медленное падение (без урона от высоты). По пути вниз цель обстреливают бластеры с двух сторон.
  const c = { owner: p, dim, start: t0, next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [], victims: [], quiet: true, done: false, timeline: [] };
  c.timeline = [
    [tLift, (cc) => {
      snd(dim, "mob.wither.shoot", o, 1.3, 0.8);
      for (const e of candidates(dim, o, G.RADIUS, p, false)) {
        if (tryEffect(e, ["levitation"], G.LIFT_TICKS, G.LIFT_AMP)) { cc.victims.push(e); fx(dim, "minecraft:totem_particle", e.location); }
      }
      cc.fixed = cc.victims.slice();
    }],
    [tLift + 4, (cc) => { // два бластера с противоположных сторон у каждой цели
      const t = now(), a0 = rand(0, Math.PI * 2);
      for (const v of cc.victims) {
        if (!ok(v)) continue;
        for (const side of [0, 1]) addBlaster(cc, { target: v, ang: a0 + side * Math.PI, r: G.SIDE_R, h: 1.2, spin: 0.03, spawnAt: t, lockAt: t + G.SIDE_LOCK, fireAt: t + G.SIDE_FIRE,
          beamTicks: G.SIDE_BEAM, dmg: U.BEAM_DAMAGE, floor: U.BEAM_FLOOR });
      }
    }],
    [tFall, (cc) => { // верх подъёма: плавное падение без урона от высоты
      for (const v of cc.victims) if (ok(v)) { safe(() => v.removeEffect("levitation")); tryEffect(v, ["slow_falling"], G.SAFE_TICKS, 0); }
    }],
    [tFall + G.SIDE_FIRE + G.SIDE_BEAM, (cc) => { cc.finishing = true; }],
  ];
  ults.set("slam:" + p.id + ":" + t0, c);
}

function tickSlams() {
  const G = COMBO.SLAM;
  for (let i = slams.length - 1; i >= 0; i--) {
    const s = slams[i];
    if (!ok(s.ent)) { slams.splice(i, 1); continue; }
    s.k++;
    const l = s.ent.location;
    const gy = groundBelow(s.dim, l.x, l.y, l.z, 14);
    const ny = gy === null ? l.y - G.SLAM_SPEED : Math.max(gy, l.y - G.SLAM_SPEED);
    safe(() => s.ent.teleport({ x: l.x, y: ny, z: l.z }, { dimension: s.dim }));
    fx(s.dim, "minecraft:basic_smoke_particle", { x: l.x, y: l.y + 0.5, z: l.z });
    if ((gy !== null && ny <= gy + 0.01) || s.k > 30) {
      safe(() => s.ent.clearVelocity && !isPlayerEnt(s.ent) && s.ent.clearVelocity());
      hurt(s.ent, G.FALL_DAMAGE, s.owner, 0);
      snd(s.dim, "random.anvil_land", s.ent.location, 1, 0.8);
      fx(s.dim, "minecraft:huge_explosion_emitter", s.ent.location);
      slams.splice(i, 1);
    }
  }
}

// ---------- Фикс: сущность «control» (отбрасывание) живёт вечно ----------
// Основная починка в entities/sans_control.json (таймер + despawn). Тут страховка: убираем её по таймеру и после перезагрузки мира.
const controlBorn = new Map();
const CONTROL_LIFE = 20;
world.afterEvents.entitySpawn.subscribe((ev) => {
  const e = ev.entity;
  if (!e || e.typeId !== "playersans:control") return;
  controlBorn.set(e.id, now());
  system.runTimeout(() => { safe(() => e.remove()); controlBorn.delete(e.id); }, CONTROL_LIFE);
});
function sweepControl() {
  const t = now();
  for (const dn of ["overworld", "nether", "the_end"]) {
    const d = safe(() => world.getDimension(dn));
    if (!d) continue;
    for (const e of safe(() => d.getEntities({ type: "playersans:control" })) || []) {
      const born = controlBorn.get(e.id);
      if (born === undefined || t - born > CONTROL_LIFE + 20) { safe(() => e.remove()); controlBorn.delete(e.id); }
    }
  }
}
system.runTimeout(sweepControl, 40);


// ============================================ КОМБО: бластеры X / Суд x2 / Ульта ===
//   Shift + Бластер Гастера -> comboGasterX : 8 бластеров буквой X + быстрый дождь костей (радиус 15)
//   Shift + Время суда      -> comboTrial   : режим x2 (время, бонус урона, цена) + стены костей + 2 бластера
//   Shift + Последняя атака -> castUltimate(p, true) : ульта быстрее + кости с неба
COMBO.GX     = { COST: 12, RANGE: 30, ARM_R: [4.5, 8.5], H: 0.9, LOCK: 24, FIRE: 50, BEAM_TICKS: 26, RAIN_R: 15, RAIN_COUNT: 48, RAIN_TICKS: 60, RAIN_DMG: 8, END_PAD: 90 };   // 6 сердец
COMBO.TRIALC = { MULT: 2, WALL_W: 5, WALL_H: 4, STEP_W: 1.15, STEP_H: 1.0, BEHIND_A: 4, BEHIND_B: 8, SPEED: 0.75, LINEUP: 24, SIDE_R: 5.5, LOCK: 22, FIRE: 44 };                  // цена и режим x2
COMBO.ULT    = { COST: 28, TEMPO: 0.72, RAIN_FIRST: 30, RAIN_MIN: 28, RAIN_MAX: 48, RAIN_DMG: 8 };                                                                           // 14 сердец
COMBO.ULT_DUST = { COST: 48, RAIN_FIRST: 30, RAIN_MIN: 9, RAIN_MAX: 16, RAIN_DMG: 10, BONUS: 2 }; // Dust: x2 стамина, дождь втрое чаще, +урон
const RAIN = { SPEED: 1.9, H: 24, R: 1.6, THICK: 0.3, IFRAME: 8, MAX: 80, FLOOR: 1, CORE_R: 2.5, CORE_SHARE: 0.8 };  // кость тонкая: вертикальная зона ±0,3 блока  // ~3,5x быстрее костей ульты (0,55)

// ---------- «дождь» быстрых костей ----------
const rains = [];
function makeRain(owner, dim, dmg, until) {
  const r = { owner, dim, dmg, until, bones: [], cands: [], candsAt: -99, iframe: new Map() };
  rains.push(r);
  return r;
}
function dropBone(rain, x, z, yHint) {
  if (rain.bones.length >= RAIN.MAX) return;
  const gy = groundY(rain.dim, x, yHint, z), y = gy + RAIN.H;
  const ent = safe(() => rain.dim.spawnEntity(ET(rain.owner, "playersans:flying_bone"), { x, y, z }));
  if (!ent) return;
  safe(() => ent.teleport({ x, y, z }, { facingLocation: { x, y: y - 1, z } })); // кость торчит вертикально остриём вниз
  fx(rain.dim, "minecraft:basic_smoke_particle", { x, y: gy + 0.1, z });          // метка, куда упадёт
  rain.bones.push({ red: dstRed(rain.owner, ent), ent, x, y, z, gy });
}
function tickRains(t) {
  for (let i = rains.length - 1; i >= 0; i--) {
    const r = rains[i];
    const dead = !ok(r.owner) || r.owner.dimension !== r.dim;
    if (dead) { for (const b of r.bones) safe(() => b.ent.remove()); rains.splice(i, 1); continue; }
    if (t >= r.until && !r.bones.length) { rains.splice(i, 1); continue; }
    if (r.bones.length && t - r.candsAt >= 3) { r.cands = candidates(r.dim, r.owner.location, 55, r.owner, true); r.candsAt = t; }
    r.bones = r.bones.filter((b) => {
      if (!ok(b.ent)) return false;
      const prev = b.y;
      b.y -= RAIN.SPEED;
      safe(() => b.ent.teleport({ x: b.x, y: b.y, z: b.z }, { facingLocation: { x: b.x, y: b.y - 1, z: b.z } }));
      const lo = b.y - RAIN.THICK, hi = prev + RAIN.THICK; // участок, который кость «прошила» за тик
      for (const e of r.cands) {
        if (!ok(e) || (r.iframe.get(e.id) || 0) > t) continue;
        const l = e.location;
        if (Math.hypot(l.x - b.x, l.z - b.z) > RAIN.R) continue;
        const head = safe(() => e.getHeadLocation().y) ?? l.y + 1.8;
        if (lo > head || hi < l.y) continue;                              // lo/hi уже с учётом толщины
        const dealt = isBlue(b.ent) ? blueHit(e, r.owner) : hurt(e, r.dmg, r.owner, RAIN.FLOOR, false, b.red ? DST.RED_BONUS : 0);
        if (dealt < 0) continue;
        r.iframe.set(e.id, t + RAIN.IFRAME);
        fx(r.dim, "minecraft:villager_angry", { x: l.x, y: l.y + 1, z: l.z });
      }
      if (b.y - RAIN.THICK <= b.gy) { // коснулась земли
        fx(r.dim, "minecraft:basic_smoke_particle", { x: b.x, y: b.gy + 0.2, z: b.z });
        safe(() => b.ent.remove());
        return false;
      }
      return true;
    });
  }
}
function startRainAt(p, center, count, ticks, radius, dmg) {
  const dim = p.dimension, rain = makeRain(p, dim, dmg, now() + ticks + 40);
  snd(dim, "mob.wither.spawn", center, 1.2, 1.6);
  for (let j = 0; j < count; j++) {
    system.runTimeout(() => {
      const a = rand(0, Math.PI * 2);
      const core = Math.random() < RAIN.CORE_SHARE;                       // большинство — точно по противнику
      const d = core ? Math.sqrt(Math.random()) * RAIN.CORE_R : Math.sqrt(Math.random()) * radius;
      dropBone(rain, center.x + Math.cos(a) * d, center.z + Math.sin(a) * d, center.y);
    }, Math.floor((j / count) * ticks));
  }
}

// ---------- Комбо 1: бластеры буквой X + дождь костей ----------
function comboGasterX(p) {
  const X = COMBO.GX, key = "combo:" + p.id;
  if (ults.has(key) || ults.has(p.id)) return;
  const free = isTrial(p);
  if (!free && stamina(p) < X.COST) return deny(p, "§cНе хватает стамины для комбо");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  if (!free) p.triggerEvent("combo_gb_remove");

  const o = p.location, tl = target.location;
  const a0 = Math.atan2(tl.z - o.z, tl.x - o.x) + Math.PI / 4;          // диагонали X (вид сверху), враг в центре
  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false };
  c.timeline = [
    [0, (cc) => {
      title(cc, "§l§b[ Комбо ]");
      const t = now();
      for (let k = 0; k < 4; k++) for (const r of X.ARM_R) {          // по два бластера на каждую «палку» X
        addBlaster(cc, { target, ang: a0 + (k * Math.PI) / 2, r, h: X.H, spin: 0, spawnAt: t, lockAt: t + X.LOCK, fireAt: t + X.FIRE, beamTicks: X.BEAM_TICKS, dmg: CFG.ULT.BEAM_DAMAGE, lethal: true });
      }
    }],
    [X.FIRE, (cc) => { // в момент выстрела: дождь костей там, где стоял враг
      const l = ok(target) ? target.location : tl;
      startRainAt(p, { x: l.x, y: l.y, z: l.z }, X.RAIN_COUNT, X.RAIN_TICKS, X.RAIN_R, X.RAIN_DMG);
    }],
    [X.FIRE + X.END_PAD, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key, c);
}

// ---------- Комбо 2: Время суда x2 + стены костей + 2 бластера ----------
function comboTrial(p) {
  const C = COMBO.TRIALC, key = "combo:" + p.id;
  if (ults.has(key) || ults.has(p.id)) return;
  if (trials.has(p.id)) return deny(p, "§bВремя суда уже идёт");
  if (stamina(p) < CFG.TRIAL.COST * C.MULT) return deny(p, "§cНе хватает стамины для комбо");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  castTrial(p, true); // режим x2 и списание x2; дальше все атаки внутри бесплатны

  const o = p.location, tl = target.location;
  let dx = tl.x - o.x, dz = tl.z - o.z, dist = Math.hypot(dx, dz);
  if (dist < 1) { const v = viewDirH(p); dx = v.x; dz = v.z; dist = 1; }
  const dir = { x: dx / dist, y: 0, z: dz / dist }, perp = { x: -dir.z, y: 0, z: dir.x };
  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false };
  const flightA = Math.ceil((dist + C.BEHIND_A + 3) / C.SPEED), flightB = Math.ceil((C.BEHIND_B + 3) / C.SPEED);

  const wall = (cc, from, vdir, behind, launchAt, flight) => {
    for (let i = 0; i < C.WALL_W; i++) for (let j = 0; j < C.WALL_H; j++) {
      const lat = (i - (C.WALL_W - 1) / 2) * C.STEP_W;
      const pos = { x: from.x - vdir.x * behind + perp.x * lat, y: tl.y + 0.2 + j * C.STEP_H, z: from.z - vdir.z * behind + perp.z * lat };
      addBone(cc, { pos, launchAt, vel: mul(vdir, C.SPEED), life: flight });
    }
  };
  c.timeline = [
    [0, (cc) => {
      title(cc, "§l§9[ Комбо: Суд ]");
      const t = now();
      wall(cc, o, dir, C.BEHIND_A, t + C.LINEUP, flightA);                                   // позади игрока -> к цели
      wall(cc, tl, mul(dir, -1), C.BEHIND_B, t + C.LINEUP + Math.max(0, flightA - flightB), flightB); // позади цели -> к игроку (прилетают одновременно)
    }],
    [C.LINEUP + flightA + 6, (cc) => { // кости кончились -> два бластера по бокам
      const t = now(), a = Math.atan2(perp.z, perp.x);
      for (let k = 0; k < 2; k++) addBlaster(cc, { target, ang: a + k * Math.PI, r: C.SIDE_R, h: 0.9, spin: 0, spawnAt: t, lockAt: t + C.LOCK, fireAt: t + C.FIRE, beamTicks: COMBO.BLASTER.BEAM_TICKS, dmg: CFG.ULT.BEAM_DAMAGE, lethal: true });
    }],
    [C.LINEUP + flightA + 6 + C.FIRE + COMBO.BLASTER.BEAM_TICKS + 10, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key, c);
}

// ---- Звук выстрела обычных бластеров (предмет d_gb): раньше он был только у «Последней атаки»
const BLASTER_SHOT_TYPES = new Set([
  "playersans:d_gb", "playersans:d_gb_right", "playersans:d_gb_top",
  "playersans:d_gbx", "gasterbones:d_gb", "gasterbones:d_gb_right",
  "gasterbones:d_gb_top", "gasterbones:d_gbx"
]); // Базовые бластеры и их снаряды: звук не теряется у обычного Sans
const lastBlasterSound = new Map();
world.afterEvents.entitySpawn.subscribe((ev) => {
  const e = ev.entity;
  if (!e || !BLASTER_SHOT_TYPES.has(e.typeId)) return;
  const t = now(), dim = e.dimension, key = dim.id;
  if (t - (lastBlasterSound.get(key) || -99) < 6) return; // три бластера стреляют разом — один звук
  lastBlasterSound.set(key, t);
  snd(dim, "mob.warden.sonic_boom", e.location, 1.4, 1.1);
});

// ============================================ ПРЕВРАЩЕНИЕ В DUST SANS (15 уровень) ===
// Обычный Санс набрал 15 уровень -> анимация: капюшон надевается, одежда темнеет, глаза гаснут и вспыхивают.
// Все в радиусе 25 блоков замирают и смотрят на Санса. В конце запускается тот же режим, что и функция dustsansmode.
const DAN = { LEVEL: 15, RADIUS: 25, FRAMES: [0, 14, 28, 42, 58, 76, 92], END: 112 };
const dustAnims = new Map(); // playerId -> { p, start, step }
const dustDoneAt = new Map(); // playerId -> тик окончания (защита от повторного запуска)
const OTHER_SANS_TAGS = ["dust_sans", "killer_sans", "nightmare_sans", "horror_sans", "lastbreath_sans", "lastbreath_armed", "lastbreath_transforming", "error_sans"];

function canBecomeDust(p) {
  if (!safe(() => p.hasTag("sans")) || OTHER_SANS_TAGS.some((x) => safe(() => p.hasTag(x)))) return false; // только обычный Санс
  if (p.hasTag("sans_dust_anim") || p.hasTag("sans_sleep") || dying.has(p.id) || isTrial(p)) return false;
  if (safe(() => p.hasTag("dust_lvlup_done"))) return false; // уже превращался по 15 уровню — обратно в классику можно без повторного срабатывания
  if (now() - (dustDoneAt.get(p.id) || -9999) < 400) return false;
  return (hp(p) ?? 0) > 0;
}
function tickDustTrigger(t) {
  if (t % 10 !== 0) return;
  for (const p of world.getAllPlayers()) {
    if (!canBecomeDust(p)) continue;
    if ((safe(() => p.level) ?? 0) >= DAN.LEVEL) startDustAnim(p);
  }
}
function startDustAnim(p) {
  safe(() => p.addTag("sans_dust_anim"));
  safe(() => p.addTag("dust_lvlup_done")); // помечаем сразу: вернувшись в классику, игрок не должен тут же снова стать Dust из-за того же 15 уровня
  dustAnims.set(p.id, { p, start: now(), step: 0 });
  snd(p.dimension, "mob.wither.ambient", p.location, 1.6, 0.5);
}
// Все живые вокруг замирают и смотрят на Санса
function danFreeze(p) {
  const at = p.location, head = safe(() => p.getHeadLocation()) || { x: at.x, y: at.y + 1.6, z: at.z };
  tryEffect(p, ["slowness"], 6, 255); tryEffect(p, ["jump_boost"], 6, 128); tryEffect(p, ["resistance"], 6, 4); // сам Санс неподвижен и неуязвим
  const list = safe(() => p.dimension.getEntities({ location: at, maxDistance: DAN.RADIUS })) || [];
  let n = 0;
  for (const e of list) {
    if (e.id === p.id || !ok(e) || hp(e) === undefined) continue;
    if (++n > 60) break;
    tryEffect(e, ["slowness"], 6, 255); tryEffect(e, ["weakness"], 6, 255);
    if (isPlayerEnt(e)) tryEffect(e, ["jump_boost"], 6, 128);
    safe(() => e.teleport(e.location, { facingLocation: head, keepVelocity: true })); // смотрят на Санса
  }
}
function danFrame(p, k) {
  const dim = p.dimension, l = p.location, head = safe(() => p.getHeadLocation()) || { x: l.x, y: l.y + 1.6, z: l.z };
  safe(() => p.triggerEvent("dst_anim" + (k + 1) + "_on"));
  if (k <= 3) snd(dim, "armor.equip_leather", l, 1.4, [0.8, 0.7, 0.6, 0.9][k]);        // капюшон натягивается
  if (k === 2) snd(dim, "armor.equip_chain", l, 1.0, 0.7);
  if (k === 4) { snd(dim, "mob.wither.ambient", l, 1.6, 0.6); for (let j = 0; j < 14; j++) fx(dim, "minecraft:basic_smoke_particle", { x: l.x + rand(-0.8, 0.8), y: l.y + rand(0.1, 1.9), z: l.z + rand(-0.8, 0.8) }); } // одежда темнеет
  if (k === 5) snd(dim, "beacon.deactivate", l, 1.6, 0.5);                              // глаза гаснут
  if (k === 6) {                                                                         // глаза вспыхивают
    snd(dim, "beacon.activate", l, 2, 1.4); snd(dim, "mob.wither.spawn", l, 0.8, 1.5);
    for (let j = 0; j < 16; j++) { const a = (j / 16) * Math.PI * 2; fx(dim, "minecraft:totem_particle", { x: head.x + Math.cos(a) * 0.5, y: head.y, z: head.z + Math.sin(a) * 0.5 }); }
    fx(dim, "minecraft:basic_flame_particle", head);
  }
}
function danAmbient(p, age) {
  const l = p.location, a0 = age * 0.35;
  for (let j = 0; j < 3; j++) { const a = a0 + j * 2.094; fx(p.dimension, "sansmode:dust_spark", { x: l.x + Math.cos(a) * 1.1, y: l.y + 0.2 + (age % 40) * 0.05, z: l.z + Math.sin(a) * 1.1 }); }
}
function finishDustAnim(p) {
  dustAnims.delete(p.id); dustDoneAt.set(p.id, now());
  safe(() => p.removeTag("sans_dust_anim"));
  safe(() => p.runCommand("function dustsansmode")); // тот же режим, что и по функции
  safe(() => p.runCommand(tt("§5§l[ DUST SANS ]")));
  snd(p.dimension, "ambient.weather.thunder", p.location, 2, 0.6);
  for (let j = 0; j < 24; j++) { const a = (j / 24) * Math.PI * 2; fx(p.dimension, "sansmode:dust_spark", { x: p.location.x + Math.cos(a) * 1.5, y: p.location.y + 0.3, z: p.location.z + Math.sin(a) * 1.5 }); }
}
function tickDustAnims(t) {
  for (const [id, a] of [...dustAnims]) {
    const p = a.p;
    if (!ok(p) || (hp(p) ?? 0) <= 0 || dying.has(id)) { // прервана (вышел/умер): вернуть обычный скин
      dustAnims.delete(id);
      if (ok(p)) { safe(() => p.removeTag("sans_dust_anim")); safe(() => p.triggerEvent(skinBaseEvt(p))); }
      continue;
    }
    const age = t - a.start;
    if (age >= DAN.END) { finishDustAnim(p); continue; }
    danFreeze(p);
    while (a.step < DAN.FRAMES.length && age >= DAN.FRAMES[a.step]) { danFrame(p, a.step); a.step++; }
    if (age % 2 === 0) danAmbient(p, age);
  }
}


// ======================== HORROR SANS: AXE & CLEAVER ===
const HORROR = { AXE_DMG: 16, AXE_RADIUS: 3.5, CLEAVER_DMG: 12, CLEAVER_KB_H: 1.6, CLEAVER_KB_V: 0.5, AXE_CD: 30, CLEAVER_CD: 40,
  CHARGE_MAX: 40, CHARGE_MULT: 1.7, HEAVY_FRAC: 0.7, HEAVY_DELAY: 50,   // зарядка удара: до x1.7 урона, тяжёлый замах задерживает следующий
  THROW_DMG: 17, THROW_SPEED: 1.4, THROW_RANGE: 34, THROW_CD: 50, WITHER_TICKS: 120, WITHER_AMP: 1 };
const HAS_CHARGE_API = !!(world.afterEvents.itemStartUse && world.afterEvents.itemStopUse);
const horrorCooldowns = new Map();
function isHorrorCd(p, key) { return (horrorCooldowns.get(p.id) || {})[key] || 0; }
function setHorrorCd(p, key, t, ticks) { const m = horrorCooldowns.get(p.id) || {}; m[key] = t + ticks; horrorCooldowns.set(p.id, m); }
// Состояние Horror Sans по игрокам: берсерк-стамина, зарядка топора, охота, поглощение
const HB = { MAX: 100, DRAIN: 0.45, REGEN: 0.25, REGEN_DELAY: 30, EXHAUST: 200 };
const hsMap = new Map();
function horrorSt(p) {
  let st = hsMap.get(p.id);
  if (!st) { st = { berserk: HB.MAX, regenAt: 0, exhaustedUntil: 0, barStep: -1, chargeStart: -1, chargeFull: false, heavyUntil: 0, hunt: null, huntCd: 0, eating: false, consumeCd: 0, throwCd: 0 }; hsMap.set(p.id, st); }
  return st;
}
const holdsItem = (p, id) => { const eq = safe(() => p.getComponent("equippable")); const it = eq && safe(() => eq.getEquipment(EquipmentSlot.Mainhand)); return !!it && it.typeId === id; };
function doHorrorAxe(p, frac) {
  const dim = p.dimension, at = p.location, v = p.getViewDirection();
  const hl = Math.hypot(v.x, v.z) || 1, hd = { x: v.x / hl, z: v.z / hl };
  const mult = 1 + (HORROR.CHARGE_MULT - 1) * frac, dmg = HORROR.AXE_DMG * mult, radius = HORROR.AXE_RADIUS + frac * 0.8;
  snd(dim, "mob.zombie.attack", at, 1.4 + frac * 0.4, 0.7 - frac * 0.2);
  fx(dim, "minecraft:basic_smoke_particle", { x: at.x + hd.x * 1.6, y: at.y + 1.2, z: at.z + hd.z * 1.6 });
  let hit = 0;
  for (const e of candidates(dim, at, radius, p, false)) {
    const dx = e.location.x - at.x, dz = e.location.z - at.z, l = Math.hypot(dx, dz) || 1;
    if (l > 1.2 && (dx / l) * hd.x + (dz / l) * hd.z < 0.2) continue; // удар идёт перед собой
    if (hurt(e, dmg, p, 0, false) >= 0) {
      tryEffect(e, ["slowness"], 60, 2);
      knock(e, dx / l, dz / l, 0.8 + frac * 0.8, 0.2 + frac * 0.2);
      for (let k = 0; k < 4; k++) fx(dim, "minecraft:redstone_ore_dust_particle", { x: e.location.x + rand(-0.3, 0.3), y: e.location.y + rand(0.3, 1.5), z: e.location.z + rand(-0.3, 0.3) });
      hit++;
    }
  }
  if (hit > 0) snd(dim, "mob.zombie.hurt", at, 1.2, 0.8);
  if (isHorror(p)) safe(() => p.triggerEvent("horror_axe")); // только списание стамины
}
function castHorrorAxe(p, frac = 0) {
  const t = now();
  if (t < isHorrorCd(p, "axe")) return;
  const hs = horrorSt(p);
  const wait = Math.max(0, hs.heavyUntil - t);
  setHorrorCd(p, "axe", t, HORROR.AXE_CD + wait);
  if (frac >= HORROR.HEAVY_FRAC) hs.heavyUntil = t + wait + HORROR.HEAVY_DELAY;
  if (wait > 0) { // после тяжёлого замаха топор не поднять сразу — приходится замахиваться ещё раз
    snd(p.dimension, "random.anvil_land", p.location, 0.25, 1.8);
    system.runTimeout(() => { if (ok(p)) doHorrorAxe(p, frac); }, wait);
  } else doHorrorAxe(p, frac);
}
function castHorrorCleaver(p) {
  const t = now();
  if (t < isHorrorCd(p, "cleaver")) return;
  const target = nearestTarget(p.dimension, p.location, 8, p);
  if (!target) return;
  const at = p.location, dim = p.dimension, el = target.location;
  snd(dim, "mob.zombie.attack", at, 1.8, 0.5);
  for (let j = 0; j < 8; j++) fx(dim, "minecraft:basic_smoke_particle", { x: el.x + rand(-0.5, 0.5), y: el.y + 0.5 + j * 0.2, z: el.z + rand(-0.5, 0.5) });
  if (hurt(target, HORROR.CLEAVER_DMG, p, 0.3, false) >= 0) {
    const dx = el.x - at.x, dz = el.z - at.z, l = Math.hypot(dx, dz) || 1;
    knock(target, dx / l, dz / l, HORROR.CLEAVER_KB_H, HORROR.CLEAVER_KB_V);
    tryEffect(target, ["slowness"], 80, 3);
    snd(dim, "mob.zombie.hurt", el, 1.5, 0.6);
    title(p, "§c§l[ Удар! ]");
  }
  if (isHorror(p)) safe(() => p.triggerEvent("horror_cleaver"));
  setHorrorCd(p, "cleaver", t, HORROR.CLEAVER_CD);
}
// ---- Обычная кость в суде: нативный залп pbone заменён скриптовым голубым (13 костей вперёд)
function blueVolley(p) {
  const dim = p.dimension, t0 = now(), key = "bvol:" + p.id + ":" + t0;
  const c = { owner: p, dim, start: t0, next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [], quiet: true, done: false };
  snd(dim, "random.bow", p.location, 1, 1.4);
  c.timeline = [];
  for (let k = 0; k < 13; k++) {
    c.timeline.push([k, (cc) => {
      if (!ok(p)) return;
      const d = norm(add(p.getViewDirection(), { x: rand(-0.09, 0.09), y: rand(-0.06, 0.06), z: rand(-0.09, 0.09) }));
      const l = p.location, pos = { x: l.x + d.x * 1.2, y: l.y + 1.25 + d.y * 1.2, z: l.z + d.z * 1.2 };
      addBone(cc, { pos, launchAt: now(), vel: mul(d, 0.8), life: 34 });
    }]);
  }
  c.timeline.push([14, (cc) => { cc.finishing = true; }]);
  ults.set(key, c);
}

// ================================================== TRIAL TIME («Время суда») ===
function isGravityItem(it) { return it && (it.typeId === "playersans:gravity" || it.typeId === "dustsans:dgravity"); }

// Убирает выданную Gravity: из инвентаря и выброшенные предметы рядом.
function dropGravityItems(p) {
  safe(() => p.runCommand("clear @s playersans:gravity")); safe(() => p.runCommand("clear @s dustsans:dgravity"));
  const dim = safe(() => p.dimension), loc = safe(() => p.location);
  if (!dim || !loc) return;
  const items = safe(() => dim.getEntities({ type: "minecraft:item", location: loc, maxDistance: 64 })) || [];
  for (const it of items) {
    const stack = safe(() => it.getComponent("minecraft:item").itemStack);
    if (isGravityItem(stack)) safe(() => it.remove());
  }
}

function castTrial(p, combo = false) {
  const T = CFG.TRIAL, mult = combo ? COMBO.TRIALC.MULT : 1;
  if (trials.has(p.id)) return deny(p, "§bВремя суда уже идёт");
  if (stamina(p) < T.COST * mult) return deny(p, "§cНе хватает стамины для Времени суда");
  p.triggerEvent(combo ? "combo_trial_remove" : sevt(p, "trial_remove"));                 // -5,5 сердец стамины
  p.addTag(T.TAG);                                // дальше атаки бесплатны (контроллеры смотрят тег)
  p.triggerEvent(isKiller(p) ? "killer_skin_on" : isNight(p) ? "nightmare_skin_on" : isDust(p) ? "dst_trial_on" : "trial_on");                     // скин: чёрный глаз + голубой глаз со зрачком
  trials.set(p.id, { end: now() + T.DURATION * mult, mult });
  safe(() => p.runCommand(isDust(p) ? "give @s dustsans:dgravity" : "give @s playersans:gravity"));
  safe(() => p.runCommand(isDust(p) ? tt("§l§5[ Murder Time ]") : tt("§l§9[ Время суда ]")));
  const dim = p.dimension, o = p.location;
  snd(dim, "beacon.activate", o, 1.5, 0.7);
  snd(dim, "mob.wither.spawn", o, 0.8, 1.6);
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2;
    fx(dim, "minecraft:totem_particle", { x: o.x + Math.cos(a) * 1.4, y: o.y + 0.2 + (k % 4) * 0.5, z: o.z + Math.sin(a) * 1.4 });
  }
}

function endTrial(p, silent) {
  trials.delete(p.id);
  if (!ok(p)) return;
  safe(() => p.removeTag(CFG.TRIAL.TAG));
  safe(() => p.triggerEvent(skinBaseEvt(p)));
  dropGravityItems(p);
  if (!silent) {
    safe(() => p.runCommand(isDust(p) ? tt("§7[ Murder Time окончен ]") : tt("§7[ Время суда окончено ]")));
    snd(p.dimension, "beacon.deactivate", p.location, 1.2, 0.8);
  }
}

function tickTrials(t) {
  for (const [id, tr] of [...trials]) {
    const p = world.getAllPlayers().find((x) => x.id === id);
    if (!p || !ok(p)) { trials.delete(id); continue; }       // вышел / умер — тег и скин уберём при возвращении
    if (t >= tr.end || (hp(p) ?? 1) <= 0) endTrial(p, false);
  }
}

// Если тег/скин остался, а режима нет (перезапуск мира, смерть, выход) — приводим в порядок.
function cleanupStale(p) {
  if (trials.has(p.id) || !p.hasTag(CFG.TRIAL.TAG)) return;
  p.removeTag(CFG.TRIAL.TAG);
  p.triggerEvent(skinBaseEvt(p));
  dropGravityItems(p);
}
world.afterEvents.playerSpawn.subscribe((e) => {
  const p = e.player;
  dustAnims.delete(p.id); safe(() => p.removeTag("sans_dust_anim"));
  system.runTimeout(() => {
    if (!ok(p)) return;
    if (!trials.has(p.id)) { safe(() => p.triggerEvent(skinBaseEvt(p))); safe(() => cleanupStale(p)); }
  }, 20);
});
world.afterEvents.playerLeave.subscribe((e) => { trials.delete(e.playerId); dustAnims.delete(e.playerId); motionAt.delete(e.playerId); });

// Урон способностей, которые работают на «родных» сущностях (кости-снаряды, бластеры Гастера,
// «Отбрасывание»): в режиме Trial Time добавляем ещё сердце. Чистый урон мимо кадров неуязвимости.
const ABILITY_ENTITIES = new Set([
  "sans:pbone", "horrorsans:pbone", "dustsans:pbone", "dustsans:d_gbx", "dustsans:d_gb", "dustsans:d_gb_right", "dustsans:d_gb_top", "dustsans:control", "playersans:d_gbx", "playersans:d_gb", "playersans:d_gb_right", "playersans:d_gb_top", "playersans:control",
]);
world.afterEvents.entityHurt.subscribe((ev) => {
  if (!trials.size) return;
  const { hurtEntity, damageSource } = ev;
  if (!damageSource) return;
  const src = damageSource.damagingProjectile, ent = damageSource.damagingEntity;
  const srcId = safe(() => src && src.typeId), entId = safe(() => ent && ent.typeId);
  if (!(srcId && ABILITY_ENTITIES.has(srcId)) && !(entId && ABILITY_ENTITIES.has(entId))) return;
  if (!ok(hurtEntity)) return;
  // кто хозяин способности: ближайший игрок в режиме Trial Time
  const at = hurtEntity.location;
  let owner = null, best = 40 * 40;
  for (const p of world.getAllPlayers()) {
    if (!trials.has(p.id) || p.dimension.id !== hurtEntity.dimension.id) continue;
    const d = (p.location.x - at.x) ** 2 + (p.location.y - at.y) ** 2 + (p.location.z - at.z) ** 2;
    if (d < best) { best = d; owner = p; }
  }
  if (!owner || hurtEntity.id === owner.id) return;
  const h = safe(() => hurtEntity.getComponent("minecraft:health"));
  if (!h) return;
  const cur = h.currentValue, bonus = trialBonus(owner);
  if (cur - bonus <= 0) safe(() => hurtEntity.kill());
  else safe(() => h.setCurrentValue(cur - bonus));
});

// ============================================== GRAVITY (отбрасывание 7 -> 8) ===
const slides = [];
const sliding = new Set();

function passable(b) {
  if (!b) return false; // чанк не загружен — считаем стеной
  const air = typeof b.isAir === "function" ? b.isAir() : b.isAir;
  if (air) return true;
  const liquid = typeof b.isLiquid === "function" ? b.isLiquid() : b.isLiquid;
  if (liquid) return true;
  const solid = typeof b.isSolid === "function" ? b.isSolid() : b.isSolid;
  return solid === false;
}

// На какое расстояние (до DISTANCE) можно пролететь по прямой, не влетев в стену.
function freeDistance(dim, from, dx, dz, max) {
  let free = 0;
  for (let d = 0.5; d <= max + 0.001; d += 0.5) {
    const x = Math.floor(from.x + dx * d), z = Math.floor(from.z + dz * d);
    const blocked = [0.2, 1.0, 1.7].some((h) => !passable(safe(() => dim.getBlock({ x, y: Math.floor(from.y + h), z }))));
    if (blocked) break;
    free = d;
  }
  return free;
}

function castGravity(p) {
  const G = CFG.GRAVITY;
  if (!isTrial(p)) {
    deny(p, "§cГравитация работает только во время Времени суда");
    safe(() => p.runCommand("clear @s playersans:gravity"));
    return;
  }
  const dim = p.dimension, o = p.location;
  safe(() => p.runCommand(tt("§l§9[ Гравитация ]")));
  snd(dim, "mob.warden.sonic_boom", o, 1.2, 1.6);
  snd(dim, "random.anvil_land", o, 0.8, 0.6);
  for (let k = 0; k < 36; k++) { // кольцо радиуса действия
    const a = (k / 36) * Math.PI * 2;
    fx(dim, "minecraft:blue_flame_particle", { x: o.x + Math.cos(a) * G.RADIUS, y: o.y + 0.2, z: o.z + Math.sin(a) * G.RADIUS });
  }
  for (const e of candidates(dim, o, G.RADIUS, p, false)) {
    if (sliding.has(e.id)) continue;
    const l = e.location;
    let dx = l.x - o.x, dz = l.z - o.z, d = Math.hypot(dx, dz);
    if (d < 0.2) { const a = rand(0, Math.PI * 2); dx = Math.cos(a); dz = Math.sin(a); } else { dx /= d; dz /= d; }
    const dist = freeDistance(dim, l, dx, dz, G.DISTANCE);
    sliding.add(e.id);
    slides.push({ ent: e, id: e.id, dim, from: { x: l.x, z: l.z }, dx, dz, dist, k: 0 });
    knock(e, dx, dz, 0.01, G.HOP);
    fx(dim, "minecraft:blue_flame_particle", { x: l.x, y: l.y + 1, z: l.z });
  }
}

function tickSlides() {
  const G = CFG.GRAVITY;
  for (let i = slides.length - 1; i >= 0; i--) {
    const s = slides[i];
    if (!ok(s.ent)) { sliding.delete(s.id); slides.splice(i, 1); continue; }
    s.k++;
    const f = s.k / G.TICKS, d = s.dist * (1 - (1 - f) * (1 - f)); // быстрый старт, плавное торможение
    const y = safe(() => s.ent.location.y);
    if (y !== undefined) safe(() => s.ent.teleport({ x: s.from.x + s.dx * d, y, z: s.from.z + s.dz * d }, { dimension: s.dim, keepVelocity: true }));
    if (s.k % 2 === 0) fx(s.dim, "minecraft:blue_flame_particle", s.ent.location);
    if (s.k >= G.TICKS) { sliding.delete(s.id); slides.splice(i, 1); }
  }
}


// ===== Уборка «осиротевших» сущностей атак (остались после перезагрузки/выгрузки чанка/сбоя) =====
const PIECE_TYPES = ["dustsans:bone_spike_big", "playersans:bone_spike_big", "dustsans:bone_spike", "dustsans:bone_wall_piece", "dustsans:flying_bone", "dustsans:ult_blaster", "playersans:bone_spike", "playersans:bone_wall_piece", "horrorsans:bone_spike", "horrorsans:bone_wall_piece", "playersans:bone_arena_piece", "playersans:flying_bone", "playersans:ult_blaster"];
function sweepOrphans() {
  const tracked = new Set();
  const add1 = (e) => { const id = safe(() => e.id); if (id) tracked.add(id); };
  for (const s of spikes) add1(s.ent);
  for (const s of wallPieces) add1(s.ent);
  for (const c of ults.values()) { for (const b of c.bones) add1(b.ent); for (const b of c.blasters) add1(b.ent); }
  for (const r of rains) for (const b of r.bones) add1(b.ent);
  for (const dn of ["overworld", "nether", "the_end"]) {
    const d = safe(() => world.getDimension(dn));
    if (!d) continue;
    for (const type of PIECE_TYPES) {
      for (const e of safe(() => d.getEntities({ type })) || []) if (!tracked.has(e.id)) safe(() => e.remove());
    }
  }
}
system.runTimeout(sweepOrphans, 40);


// ============================================ СОН САНСА (афк 3 секунды) ===
// Работает только у Санса (variant >= 300). Стоишь 3 секунды -> тег sans_sleep: закрытые глаза, Z, быстрая стамина.
// Выход: движение, урон или полная стамина. Во сне атаки не работают (фильтр !sans_sleep в контроллерах + здесь).
// Сон Эррора «глитчит»: раз в 3-7 сек на пару тиков проскакивает классический скин — это фича, а не баг.
const errGlitchAt = new Map();
function errorSleepGlitch(p, t) {
  let next = errGlitchAt.get(p.id);
  if (next === undefined) { next = t + 60 + Math.floor(Math.random() * 80); errGlitchAt.set(p.id, next); }
  if (t < next) return;
  errGlitchAt.set(p.id, t + 60 + Math.floor(Math.random() * 80));
  safe(() => p.triggerEvent("sleep_skin_off"));
  snd(p.dimension, "random.glass", p.location, 0.5, 1.6);
  system.runTimeout(() => { if (ok(p)) safe(() => p.triggerEvent("error_sleep_skin_on")); }, 3);
}
const SLEEP = { COMBO_TICKS: 20, ATK_RANGE: 8, STILL_TICKS: 60, STILL_FULL_TICKS: 300, MOVE_EPS: 0.05, FULL: 36, Z_EVERY: 20, REGEN_EVERY: 2, MIN_REST_TICKS: 100 };
const sleepState = new Map(); // playerId -> { x, y, z, still, hp, asleep, zAt }
const isSansP = (p) => { const c = safe(() => p.getComponent("minecraft:variant")); return !!c && c.value >= 300; };

function wakeSleep(p, st, text) {
  st.asleep = false; st.still = 0; st.dodgeAt = null;
  safe(() => p.removeTag("sans_dodged"));
  safe(() => p.removeTag("sans_sleep"));
  safe(() => p.triggerEvent("sleep_skin_off")); if (p.hasTag("horror_sans")) safe(() => p.triggerEvent("horror_skin_on")); if (isGaster(p)) safe(() => p.triggerEvent("gaster_skin_on")); if (isDust(p)) safe(() => p.triggerEvent("dst_skin_on")); if (isNight(p)) safe(() => p.triggerEvent("nightmare_skin_on")); if (isKiller(p)) safe(() => p.triggerEvent("killer_skin_on")); if (isLastBreath(p)) safe(() => p.triggerEvent("lb_skin_on"));
  // в чат ничего не пишем: уснул/проснулся видно по анимации
}

// true -> игрок спит, действия блокируются
function sleepTick(p, t) {
  if (!isSansP(p)) { // не Санс: сна нет, прибираем следы
    const old = sleepState.get(p.id);
    if (old) { if (old.asleep) wakeSleep(p, old, null); sleepState.delete(p.id); }
    return false;
  }
  let st = sleepState.get(p.id);
  const l = p.location, h = hp(p);
  if (!st) { st = { x: l.x, y: l.y, z: l.z, still: 0, hp: h, asleep: false, zAt: 0 }; sleepState.set(p.id, st); }
  const moved = Math.abs(l.x - st.x) + Math.abs(l.y - st.y) + Math.abs(l.z - st.z) > SLEEP.MOVE_EPS;
  const wounded = h !== undefined && st.hp !== undefined && h < st.hp;
  st.x = l.x; st.y = l.y; st.z = l.z; st.hp = h;

  if (!st.asleep) {
    st.still = moved ? 0 : st.still + 1;
    const busy = ults.has(p.id) || ults.has("combo:" + p.id) || papyrus.has(p.id) || p.hasTag("nm_busy") || p.getTags().some((x) => x.startsWith("sans_cast") || x.startsWith("sans_combo"));
    const need = stamina(p) >= maxStaminaOf(p) ? SLEEP.STILL_FULL_TICKS : SLEEP.STILL_TICKS; // полная стамина: засыпает через 15 с
    if (st.still >= need && !busy && !isTrial(p) && (h ?? 1) > 0) {
      st.asleep = true; st.zAt = 0; st.sleepStart = t; st.startFull = stamina(p) >= maxStaminaOf(p);
      p.addTag("sans_sleep");
      safe(() => p.triggerEvent(isGaster(p) ? "gaster_skin_on" : isLastBreath(p) ? "lb_sleep_skin_on" : isKiller(p) ? "killer_sleep_skin_on" : isNight(p) ? "nightmare_sleep_skin_on" : isDust(p) ? "dst_sleep_skin_on" : (isError(p) ? "error_sleep_skin_on" : p.hasTag("horror_sans") ? "horror_sleep_skin_on" : "sleep_skin_on")));
      snd(p.dimension, "mob.bat.takeoff", l, 0.6, 1.4);
    }
    return false;
  }

  // во сне. Первый удар: Санс уворачивается (урон отменён в damage_sensor, ставится тег sans_dodged),
  // обидчику в чат: «ударь его!». Если он успеет ударить ещё раз за COMBO_TICKS — тег sans_hit2 -> Санс умирает.
  if (p.hasTag("sans_hit2")) {
    p.removeTag("sans_hit2");
    if (st.dodgeAt != null && t - st.dodgeAt <= SLEEP.COMBO_TICKS + 2) {
      const atk = st.atk && ok(st.atk) ? st.atk : null;
      p.removeTag("sans_dodged"); st.dodgeAt = null; st.atk = null;
      startDeath(p, atk);
      return false;
    }
  }
  if (!wounded && p.hasTag("sans_dodged")) {
    if (st.dodgeAt == null) { // свежий уворот
      st.dodgeAt = t;
      let best = null, bd = SLEEP.ATK_RANGE * SLEEP.ATK_RANGE;
      for (const e of safe(() => p.dimension.getEntities({ location: l, maxDistance: SLEEP.ATK_RANGE })) || []) {
        if (e.id === p.id || (isPlayerEnt(e) && isSansP(e))) continue;
        const hpE = hp(e); if (hpE === undefined) continue;
        const dd = (e.location.x - l.x) ** 2 + (e.location.y - l.y) ** 2 + (e.location.z - l.z) ** 2;
        if (isPlayerEnt(e) ? dd < bd * 4 : dd < bd) { if (isPlayerEnt(e)) { best = e; bd = dd / 4; } else if (!best || !isPlayerEnt(best)) { best = e; bd = dd; } }
      }
      st.atk = best;
      if (best && isPlayerEnt(best)) safe(() => best.sendMessage(tx("§c«ударь его!»")));
      snd(p.dimension, "random.swoosh", l, 1, 1.3);
      fx(p.dimension, "h2v:psans_miss", { x: l.x, y: l.y + 1.0, z: l.z });
      for (let i = 0; i < 6; i++) fx(p.dimension, "sansmode:dust", { x: l.x + rand(-0.4, 0.4), y: l.y + rand(0.2, 1.6), z: l.z + rand(-0.4, 0.4) });
    } else if (t - st.dodgeAt > SLEEP.COMBO_TICKS) { st.dodgeAt = null; st.atk = null; safe(() => p.removeTag("sans_dodged")); }
  }
  if (st.forcedUntil) { // принудительный сон (наказание охоты): лежит до конца таймера
    if (t >= st.forcedUntil) { st.forcedUntil = 0; wakeSleep(p, st, null); return false; }
  } else if (moved || wounded || (st.startFull ? (t - st.sleepStart >= SLEEP.MIN_REST_TICKS) : stamina(p) >= maxStaminaOf(p))) {
    wakeSleep(p, st, moved || wounded ? "§7Санс проснулся" : "§7Санс выспался");
    return false;
  }
  if (t - st.zAt >= SLEEP.Z_EVERY) { // плывущие вверх «Z» (у Гастера — всплеск глюков вместо «Z»)
    st.zAt = t;
    if (isGaster(p)) {
      fx(p.dimension, "sansmode:gaster_sleep_glitch", { x: l.x + 0.2, y: l.y + 1.9, z: l.z });
    } else if (isError(p)) {
      fx(p.dimension, "sansmode:gaster_glitch", { x: l.x + 0.2, y: l.y + 1.9, z: l.z });
    } else {
      fx(p.dimension, isLastBreath(p) ? "sansmode:sleep_z_lb" : isDust(p) ? "sansmode:sleep_z_dust" : (p.hasTag("horror_sans") ? "sansmode:sleep_z_red" : "sansmode:sleep_z"), { x: l.x + 0.2, y: l.y + 1.9, z: l.z });
    }
  }
  if (t % SLEEP.REGEN_EVERY === 0) safe(() => p.triggerEvent(addEvt(p))); // быстрая стамина
  return true;
}

// страховка: спящий не может использовать предметы
try {
  world.beforeEvents.itemUse.subscribe((ev) => { if (ev.source && ev.source.hasTag("sans_sleep")) ev.cancel = true; });
} catch (_) {}


// ============================================ СМЕРТЬ САНСА: сцена перед экраном смерти ===
// Смертельный удар не убивает сразу. Санс: кровь (скин psans_dead), камера глазами убийцы, смотрит на себя.
// Убийца (игрок ИЛИ любой моб): замирает и обязан смотреть на Санса. Через DEATH.TICKS Санс умирает по-настоящему.
const DEATH = { TICKS: 90, CAM_Y: 1.55, BLOOD_EVERY: 4, DEBUG: false, LOW: 14, HIGH: 18, CAM_FWD_MIN: 0.9, CAM_SEE: 2.2, CAM_UP: 0.3, CAM_MIN_DIST: 0.8 };
const dbg = (msg) => { if (DEATH.DEBUG) safe(() => world.sendMessage("§8[death] " + msg)); };
const dying = new Map();   // victimId -> { v, killer, end, pos, kpos, dim }
const ghosts = [];         // запасной вариант: Санс уже умер, убийца всё равно застывает { killer, pos, end, dim }
const ownKill = new Set();
const sansIds = new Set();
const lastHit = new Map();   // sansId -> { k: обидчик, t: тик }
const totemOn = new Set();   // у кого сейчас лежит наш тотем

// «Последний шанс»: при низком HP кладём Сансу в левую руку тотем. Если Санс получил смертельный удар (меч, моб, стрела),
// игра сама отменяет смерть и забирает тотем. Тотем пропал, а HP = 1 -> запускаем сцену смерти.
function lastStandTick(p, t) {
  const eq = safe(() => p.getComponent("minecraft:equippable"));
  if (!eq) return;
  const off = safe(() => eq.getEquipment(EquipmentSlot.Offhand));
  const hasTotem = !!off && off.typeId === "minecraft:totem_of_undying";
  const h = hp(p) ?? 20;
  if (totemOn.has(p.id) && !hasTotem) { // тотем сработал (или игрок его убрал)
    totemOn.delete(p.id);
    const lh = lastHit.get(p.id);
    if (h <= 2 && lh && t - lh.t <= 40) {
      for (const e of ["regeneration", "absorption", "fire_resistance"]) safe(() => p.removeEffect(e));
      startDeath(p, lh.k);
    } else dbg("тотем исчез без смертельного удара");
    return;
  }
  if (!hasTotem && !off && h <= DEATH.LOW) { safe(() => eq.setEquipment(EquipmentSlot.Offhand, new ItemStack("minecraft:totem_of_undying", 1))); totemOn.add(p.id); dbg("тотем выдан (HP " + h + ")"); }
  else if (hasTotem && totemOn.has(p.id) && h >= DEATH.HIGH) { safe(() => eq.setEquipment(EquipmentSlot.Offhand, undefined)); totemOn.delete(p.id); }
}

function eyePos(e) { const h = safe(() => e.getHeadLocation()); return h || { x: e.location.x, y: e.location.y + DEATH.CAM_Y, z: e.location.z }; }

function holdKiller(k, look, t) { // замереть и смотреть на точку look
  if (!ok(k)) return;
  tryEffect(k, ["slowness"], 12, 255); tryEffect(k, ["weakness"], 12, 255); tryEffect(k, ["jump_boost"], 12, 128);
  tryEffect(k, ["invisibility"], 12, 0); // невидим: его замахи и анимация атаки не лезут в камеру
}

function startDeath(v, killer) {
  if (dying.has(v.id)) return;
  dbg("сцена запущена, убийца: " + (killer ? killer.typeId : "нет"));
  if (totemOn.has(v.id)) { // свой тотем больше не нужен
    totemOn.delete(v.id);
    const eq = safe(() => v.getComponent("minecraft:equippable"));
    const off = eq && safe(() => eq.getEquipment(EquipmentSlot.Offhand));
    if (off && off.typeId === "minecraft:totem_of_undying") safe(() => eq.setEquipment(EquipmentSlot.Offhand, undefined));
  }
  const dim = v.dimension, t0 = now();
  const k = killer && ok(killer) && killer.id !== v.id ? killer : null;
  const info = { v, killer: k, end: t0 + DEATH.TICKS, pos: { ...v.location }, kpos: k ? { ...k.location } : null, dim, bloodAt: 0 };
  dying.set(v.id, info);
  const st = sleepState.get(v.id); if (st && st.asleep) wakeSleep(v, st, null);
  safe(() => v.addTag("sans_dying"));
  safe(() => v.removeTag("sans_dodged"));
  safe(() => v.addTag("sans_sleep"));                       // блок атак в контроллерах и itemUse
  safe(() => v.triggerEvent(isGaster(v) ? "gaster_skin_on" : isLastBreath(v) ? "lb_dead_skin_on" : isKiller(v) ? "killer_skin_on" : isNight(v) ? "nightmare_skin_on" : isDust(v) ? "dst_dead_skin_on" : (isError(v) ? "error_dead_skin_on" : v.hasTag("horror_sans") ? "horror_dead_skin_on" : "dead_skin_on")));              // кровь/кетчуп
  tryEffect(v, ["resistance"], DEATH.TICKS + 20, 4);
  tryEffect(v, ["slowness"], DEATH.TICKS + 20, 255);
  tryEffect(v, ["jump_boost"], DEATH.TICKS + 20, 128);
  if (k && isPlayerEnt(k)) safe(() => k.addTag("sans_sleep")); // убийца-игрок тоже не может атаковать
  if (k) tryEffect(k, ["invisibility"], DEATH.TICKS + 20, 0);
  snd(dim, "mob.skeleton.death", v.location, 1.2, 0.8);
  // камера Санса: глазами убийцы, взгляд на Санса (без убийцы — чуть сбоку)
  const look = { x: v.location.x, y: v.location.y + 1.0, z: v.location.z };
  let from = { x: look.x + 2.5, y: look.y + 0.5, z: look.z + 2.5 };
  if (k) { // камера у глаз убийцы, но сдвинута вперёд и чуть вверх: модель моба не лезет в кадр, Санс виден целиком
    const eye = eyePos(k), dx = look.x - eye.x, dy = look.y - eye.y, dz = look.z - eye.z, dist = Math.hypot(dx, dy, dz) || 1;
    const fwd = Math.min(Math.max(DEATH.CAM_FWD_MIN, dist - DEATH.CAM_SEE), Math.max(0.3, dist - DEATH.CAM_MIN_DIST));
    from = { x: eye.x + (dx / dist) * fwd, y: eye.y + (dy / dist) * fwd + DEATH.CAM_UP, z: eye.z + (dz / dist) * fwd };
  }
  safe(() => v.runCommand(`camera @s set minecraft:free pos ${from.x} ${from.y} ${from.z} facing ${look.x} ${look.y} ${look.z}`));
  safe(() => v.sendMessage("§7..."));
}

// Фаза 2: Санс испаряется — тело скрывается, расщепляется на белые частицы, и только потом настоящая смерть.
const DUST = { TICKS: 40, BURSTS: 8, EXTRA_PER_TICK: 3 };
function endDeath(info) {
  const v = info.v;
  if (!ok(v)) { dying.delete(info.v.id); return; }
  if (info.dust) return;
  info.dust = true;
  info.dustEnd = now() + DUST.TICKS;
  info.end = info.dustEnd;
  safe(() => v.triggerEvent("dust_skin_on"));   // модель исчезает (прозрачный скин)
  snd(info.dim, "mob.skeleton.death", info.pos, 1.0, 1.6);
  snd(info.dim, "random.fizz", info.pos, 1.0, 0.6);
  for (let i = 0; i < 3; i++) fx(info.dim, "sansmode:dust", info.pos);
}

function finishDeath(info) {
  dying.delete(info.v.id);
  const v = info.v;
  if (!ok(v)) return;
  safe(() => v.runCommand("camera @s clear"));
  safe(() => v.removeTag("sans_sleep")); safe(() => v.removeTag("sans_dying"));
  if (info.killer && ok(info.killer)) safe(() => info.killer.removeEffect("invisibility"));
  if (info.killer && ok(info.killer) && isPlayerEnt(info.killer)) safe(() => info.killer.removeTag("sans_sleep"));
  safe(() => v.removeEffect("resistance"));
  safe(() => v.addEffect("invisibility", 40, { amplifier: 0, showParticles: false })); // чтобы не мелькнула анимация падения
  ownKill.add(v.id);
  safe(() => v.kill());
  system.runTimeout(() => ownKill.delete(v.id), 40);
}

function tickDeaths(t) {
  for (const info of [...dying.values()]) {
    const v = info.v;
    if (!ok(v)) { dying.delete(v.id); continue; }
    if (info.dust) {
      if (t >= info.dustEnd) { finishDeath(info); continue; }
      const k0 = (t - (info.dustEnd - DUST.TICKS)) % 5;
      if (k0 === 0) fx(info.dim, "sansmode:dust", info.pos);
      for (let i = 0; i < DUST.EXTRA_PER_TICK; i++) // постоянная россыпь частиц вокруг тела
        fx(info.dim, "sansmode:dust", { x: info.pos.x + rand(-0.3, 0.3), y: info.pos.y + rand(0, 1.8), z: info.pos.z + rand(-0.3, 0.3) });
      continue;
    }
    if (t >= info.end) { endDeath(info); continue; }
    // Санс остаётся на месте
    const l = v.location;
    if (Math.abs(l.x - info.pos.x) + Math.abs(l.y - info.pos.y) + Math.abs(l.z - info.pos.z) > 0.05) safe(() => v.teleport(info.pos, { dimension: info.dim }));
    // убийца: на месте и смотрит на Санса
    const k = info.killer;
    if (k && ok(k)) {
      safe(() => k.teleport(info.kpos, { dimension: info.dim, facingLocation: { x: info.pos.x, y: info.pos.y + 1.0, z: info.pos.z } }));
      if (t % 5 === 0) holdKiller(k);
    }
    // кровь: рот и тело
    if (t - info.bloodAt >= DEATH.BLOOD_EVERY) {
      info.bloodAt = t;
      fx(info.dim, "minecraft:redstone_ore_dust_particle", { x: info.pos.x, y: info.pos.y + 1.45, z: info.pos.z });
      fx(info.dim, "minecraft:redstone_ore_dust_particle", { x: info.pos.x + rand(-0.2, 0.2), y: info.pos.y + 1.0, z: info.pos.z + rand(-0.2, 0.2) });
    }
    if (t === info.end - 20) snd(info.dim, "mob.skeleton.hurt", info.pos, 1, 0.6);
  }
  for (let i = ghosts.length - 1; i >= 0; i--) { // запасной вариант (если Санс всё-таки умер сразу)
    const g = ghosts[i];
    if (!ok(g.killer) || t >= g.end) { if (ok(g.killer)) safe(() => g.killer.removeEffect("invisibility")); ghosts.splice(i, 1); continue; }
    safe(() => g.killer.teleport(g.kpos, { dimension: g.dim, facingLocation: { x: g.pos.x, y: g.pos.y + 0.5, z: g.pos.z } }));
    if (t % 5 === 0) holdKiller(g.killer);
    if (t % 4 === 0) fx(g.dim, "minecraft:redstone_ore_dust_particle", { x: g.pos.x, y: g.pos.y + 0.6, z: g.pos.z });
  }
}

// ============================================================= LAST BREATH ===
// 40% шанс при смертельном ударе: Санс не рассыпается, а застывает на грани.
// Первый такой удар переживается молча. Если по нему бьют второй раз — белая рука
// защищает затылок, трещина чернеет, звучит предупреждение (варден) — и это Last Breath.
// Пока Last Breath жив, он игнорирует урон (атакующего просто откидывает) и умирает только
// когда садится стамина — тогда играет обычная сцена смерти, но в скине с крестом из трещин.
function lbActivate(v, killer) {
  safe(() => v.removeTag("sans"));                       // иначе сенсор sans_mode / base вернёт обычный режим
  safe(() => v.addTag("lastbreath_sans"));
  safe(() => v.addTag("lastbreath_transforming"));
  safe(() => v.removeTag("sans_dodged"));
  safe(() => v.triggerEvent("player"));                  // полный сброс режима Sans
  safe(() => v.triggerEvent("lastbreath_mode_on"));      // HP=1, стамина 92, сенсоры предметов, иммунитет к урону
  safe(() => v.runCommand("clear @s playersans:trial_time"));
  safe(() => v.runCommand("clear @s dustsans:dgravity"));
  snd(v.dimension, "mob.warden.sonic_boom", v.location, 1.6, 0.75); // предупреждение: тому, кто ударил, пизда гарантом
  safe(() => v.sendMessage(tx("§4§l...§r§7 ещё не время.")));
  tryEffect(v, ["slowness"], 50, 2);
  const stages = ["lb_t1_on", "lb_t2_on", "lb_t3_on", "lb_t4_on", "lb_t5_on", "lb_skin_on"];
  stages.forEach((evtName, i) => {
    system.runTimeout(() => {
      if (!ok(v)) return;
      safe(() => v.triggerEvent(evtName));
      fx(v.dimension, "minecraft:crack_block_particle", { x: v.location.x, y: v.location.y + 1.6, z: v.location.z });
      snd(v.dimension, "mob.skeleton.hurt", v.location, 1, 0.5 + i * 0.07);
      if (i === stages.length - 1) {
        safe(() => v.removeTag("lastbreath_transforming"));
        snd(v.dimension, "mob.wither.spawn", v.location, 1, 1.1);
      }
    }, i * LB.TRANS_STEP);
  });
}

const lbKnockAt = new Map();
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const v = ev.hitEntity, a = ev.damagingEntity;
  if (!ok(v) || !ok(a) || !isPlayerEnt(v) || !isLastBreath(v) || a.id === v.id) return;
  const t = now();
  if ((lbKnockAt.get(a.id) || 0) > t) return;
  lbKnockAt.set(a.id, t + 6);
  const dx = a.location.x - v.location.x, dz = a.location.z - v.location.z, l = Math.hypot(dx, dz) || 1;
  knock(a, dx / l, dz / l, LB.KNOCK_H, LB.KNOCK_V);
  snd(v.dimension, "mob.wither.hurt", v.location, 1, 0.6);
  fx(v.dimension, "minecraft:villager_angry", a.location);
});

// смертельный урон «не от способностей» (моб, стрела, падение): пробуем удержать Санса на 1 HP и запустить сцену
world.afterEvents.entityHurt.subscribe((ev) => {
  const v = ev.hurtEntity;
  if (!ok(v) || !isPlayerEnt(v) || dying.has(v.id) || !isSansP(v)) return;
  const killer = safe(() => ev.damageSource.damagingEntity);
  if (killer) lastHit.set(v.id, { k: killer, t: now() });

  // --- Last Breath уже активен: иммунитет, атакующего откидывает ---
  if (isLastBreath(v)) {
    safe(() => { const hh = v.getComponent("minecraft:health"); if (hh) hh.setCurrentValue(1); });
    if (killer && ok(killer) && killer.id !== v.id) {
      const dx = killer.location.x - v.location.x, dz = killer.location.z - v.location.z, l = Math.hypot(dx, dz) || 1;
      knock(killer, dx / l, dz / l, LB.KNOCK_H, LB.KNOCK_V);
      snd(v.dimension, "mob.wither.hurt", v.location, 1, 0.6);
      fx(v.dimension, "minecraft:villager_angry", killer.location);
    }
    return;
  }

  const h = safe(() => v.getComponent("minecraft:health"));
  if (!h || h.currentValue > 0) return;

  // --- второй удар по "вооружённому" Сансу: активация Last Breath ---
  if (v.hasTag("lastbreath_armed")) {
    safe(() => v.removeTag("lastbreath_armed"));
    safe(() => h.setCurrentValue(1));
    lbActivate(v, killer);
    return;
  }
  // --- первый смертельный удар: шанс 40% на активацию (только обычный Санс, без режимов) ---
  if (!v.hasTag("horror_sans") && !isDust(v) && !isNight(v) && !isKiller(v) && !isError(v) && Math.random() < LB.ACTIVATE_CHANCE) {
    safe(() => h.setCurrentValue(1));
    safe(() => v.addTag("lastbreath_armed"));
    dbg("Last Breath: шанс сработал, жду второй удар");
    return;
  }

  dbg("смертельный урон прошёл мимо тотема, пробую спасти");
  safe(() => h.setCurrentValue(1));
  if ((hp(v) ?? 0) > 0) startDeath(v, killer);
});
// если спасти не вышло — убийца всё равно застывает и смотрит на место смерти
world.afterEvents.entityDie.subscribe((ev) => {
  const d = ev.deadEntity;
  if (d && isPlayerEnt(d)) totemOn.delete(d.id);
  if (!d || ownKill.has(d.id) || !sansIds.has(d.id)) return;
  const k = safe(() => ev.damageSource.damagingEntity);
  dbg("Санс умер сразу (сцену не удалось запустить), убийца: " + (k ? k.typeId : "нет"));
  if (!k || !ok(k) || k.id === d.id) return;
  ghosts.push({ killer: k, pos: { ...d.location }, kpos: { ...k.location }, end: now() + DEATH.TICKS, dim: k.dimension });
});
// после респавна — обычный скин и обычная камера
world.afterEvents.playerSpawn.subscribe((e) => {
  const p = e.player;
  system.runTimeout(() => {
    if (!ok(p) || dying.has(p.id)) return;
    if (isLastBreath(p)) { // Last Breath — разовая трансформация: после респавна снова обычный Санс
      safe(() => p.removeTag("lastbreath_sans")); safe(() => p.removeTag("lastbreath_armed")); safe(() => p.removeTag("lastbreath_transforming"));
      safe(() => p.triggerEvent("lastbreath_off")); safe(() => p.triggerEvent("player"));
      safe(() => p.addTag("sans")); safe(() => p.triggerEvent("sans")); safe(() => p.addTag("sans_skin_sync"));
    }
    safe(() => p.triggerEvent("dead_skin_off")); if (p.hasTag("horror_sans")) safe(() => p.triggerEvent("horror_skin_on")); if (isGaster(p)) safe(() => p.triggerEvent("gaster_skin_on")); if (isDust(p)) safe(() => p.triggerEvent("dst_skin_on")); if (isKiller(p)) safe(() => p.triggerEvent("killer_skin_on")); if (isNight(p)) safe(() => p.triggerEvent("nightmare_skin_on")); safe(() => p.runCommand("camera @s clear")); safe(() => p.removeTag("sans_sleep")); safe(() => p.removeTag("sans_dying")); safe(() => p.removeTag("sans_dodged"));
  }, 5);
});
world.afterEvents.playerLeave.subscribe((e) => { dying.delete(e.playerId); sansIds.delete(e.playerId); });



// ============================================ DUST SANS: Кости из-под земли + ПАПИРУС ===
const DU = {
  UNDER: { COST: 12, COOLDOWN: 400, RADIUS: 25, WARN: 14, RING: 4, RING_R: 1.1, MAX_TARGETS: 16, COMBO_RADIUS: 35 },
  PAP: {
    COST: 30, COOLDOWN: 800, LIFE: 160, BACK: 1.7, SIDE: 2.0, UP: 0.1,
    FAN: { COUNT: 10, SPREAD: 0.95, SPEED: 0.55, DELAY: 8, CD: 30 },
    HEAD: { SPEED: 0.95, TURN: 0.2, DAMAGE: 6, LIFE: 90, CD: 50, RANGE: 30, HIT: 1.25 },
    ROW: { W: 11, ROWS: 2, STEP: 0.9, BEHIND: 3, SPEED: 0.9, DELAY: 14, CD: 60 },
    SCARF: { RANGE: 25, SPEED: 2.2, PULL: 1.1, FRONT: 2.3, CD: 80 },
  },
};
// какие 4 предмета Dust на время пропадают и чем заменяются (на том же месте)
const PAP_SWAP = [["dustsans:dbone", "dustsans:pbones"], ["dustsans:dcontrol", "dustsans:phead"], ["dustsans:dtrial", "dustsans:prow"], ["dustsans:dtelekinesis", "dustsans:pscarf"]];
const PAP_IDS = new Set(PAP_SWAP.map((x) => x[1]));
const PAP_KEY = "dust_pap_saved";
const papyrus = new Map();   // ownerId -> сессия
const papCool = new Map();
const underCool = new Map();

const chestOf = (e) => { const l = e.location; return { x: l.x, y: l.y + 1.0, z: l.z }; };
function nearestTarget(dim, from, radius, owner) {
  let best = null, bd = 1e9;
  for (const e of candidates(dim, from, radius, owner, false)) {
    const l = e.location, d = Math.hypot(l.x - from.x, l.y - from.y, l.z - from.z);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function drawLine(dim, a, b) { // шарф: цепочка красных частиц
  const d = len(sub(b, a)), n = Math.min(70, Math.max(2, Math.ceil(d * 2)));
  for (let i = 0; i <= n; i++) fx(dim, "sansmode:scarf_rope", { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
}
function freezeBound(e) { tryEffect(e, ["slowness"], 12, 255); tryEffect(e, ["weakness"], 12, 255); if (isPlayerEnt(e)) tryEffect(e, ["jump_boost"], 12, 128); }
function stepToward(e, dest, step, dim) {
  const l = e.location, d = sub(dest, l), dl = len(d);
  const np = dl <= step ? dest : add(l, mul(d, step / dl));
  safe(() => e.teleport(np, { dimension: dim }));
  if (!isPlayerEnt(e)) safe(() => e.clearVelocity());
  return dl <= step;
}

// ---------- Кости из-под земли ----------
function castUnder(p) {
  if (!isDust(p)) return;
  const U = DU.UNDER, t = now(), free = isTrial(p);
  const big = safe(() => p.isSneaking) === true; // Shift: комбо
  const cost = big ? U.COST * 2 : U.COST, radius = big ? U.COMBO_RADIUS : U.RADIUS;
  const redNow = (ent) => { if (isTrial(p)) return dstRed(p, ent); safe(() => ent.triggerEvent("dst_red")); return true; };
  if (!isDust(p) && t < (underCool.get(p.id) || 0)) return;
  if (!free && stamina(p) < cost) return deny(p, "§cНе хватает стамины");
  const dim = p.dimension, targets = candidates(dim, p.location, radius, p, false);

  if (!targets.length) return deny(p, "§7Нет целей");
  if (!free) p.triggerEvent("dst_under_remove");
  underCool.set(p.id, t + U.COOLDOWN);
  snd(dim, "mob.wither.shoot", p.location, 1.0, 0.6);
  const shared = new Set();
  for (const e of targets.slice(0, U.MAX_TARGETS)) {
    const l = e.location, lock = { x: l.x, y: l.y, z: l.z };
    for (let k = 0; k < U.WARN; k += 3) system.runTimeout(() => { // предупреждение: фиолетовое кольцо
      const gy = groundY(dim, lock.x, lock.y, lock.z) + 0.1;
      for (let j = 0; j < 6; j++) { const a = (j * Math.PI) / 3; fx(dim, "sansmode:dust_spark", { x: lock.x + Math.cos(a) * U.RING_R, y: gy, z: lock.z + Math.sin(a) * U.RING_R }); }
    }, k);
    system.runTimeout(() => {
      if (!ok(p)) return;
      const pts = [{ x: 0, z: 0 }];
      for (let j = 0; j < U.RING; j++) pts.push({ x: Math.cos((j * 2 * Math.PI) / U.RING) * U.RING_R, z: Math.sin((j * 2 * Math.PI) / U.RING) * U.RING_R });
      for (const o of pts) {
        const x = lock.x + o.x, z = lock.z + o.z, y = groundY(dim, x, lock.y, z);
        const ent = safe(() => dim.spawnEntity("dustsans:bone_spike", { x, y, z }));
        if (ent) spikes.push({ red: big ? redNow(ent) : dstRed(p, ent), ent, dim, x, y, z, born: now(), owner: p, hit: shared });
      }
      snd(dim, "dig.stone", lock, 1.0, 0.7);
    }, U.WARN);
  }
}

// ---------- Папирус ----------
function papHome(p) {
  const h = viewDirH(p), o = p.location;
  return { x: o.x - h.x * DU.PAP.BACK + -h.z * DU.PAP.SIDE, y: o.y + DU.PAP.UP, z: o.z - h.z * DU.PAP.BACK + h.x * DU.PAP.SIDE };
}
function swapIn(p) { // 4 предмета -> предметы Папируса на тех же слотах
  const inv = safe(() => p.getComponent("minecraft:inventory").container);
  if (!inv) return [];
  const saved = [], given = new Set();
  for (let i = 0; i < inv.size; i++) {
    const it = safe(() => inv.getItem(i));
    if (!it) continue;
    for (const [orig, pap] of PAP_SWAP) if (it.typeId === orig) { saved.push({ slot: i, id: orig }); safe(() => inv.setItem(i, new ItemStack(pap, 1))); given.add(pap); }
  }
  for (const [, pap] of PAP_SWAP) if (!given.has(pap)) safe(() => inv.addItem(new ItemStack(pap, 1)));
  return saved;
}
function swapOut(p, saved) { // убрать предметы Папируса, вернуть свои
  for (const [, pap] of PAP_SWAP) safe(() => p.runCommand("clear @s " + pap));
  const inv = safe(() => p.getComponent("minecraft:inventory").container);
  if (!inv) return;
  for (const s of saved) {
    const cur = safe(() => inv.getItem(s.slot));
    if (!cur) safe(() => inv.setItem(s.slot, new ItemStack(s.id, 1)));
    else safe(() => inv.addItem(new ItemStack(s.id, 1)));
  }
}
function purgePapItems(dim, loc) {
  const items = safe(() => dim.getEntities({ type: "minecraft:item", location: loc, maxDistance: 16 })) || [];
  for (const it of items) { const st = safe(() => it.getComponent("minecraft:item").itemStack); if (st && PAP_IDS.has(st.typeId)) safe(() => it.remove()); }
}

function summonPapyrus(p) {
  if (!isDust(p) || papyrus.has(p.id)) return;
  const t = now(), free = isTrial(p);
  if (!isDust(p) && t < (papCool.get(p.id) || 0)) return deny(p, "§7Папирус ещё не готов");
  if (!free && stamina(p) < DU.PAP.COST) return deny(p, "§cНе хватает стамины");
  const dim = p.dimension, pos = papHome(p);
  const ent = safe(() => dim.spawnEntity("dustsans:papyrus", pos));
  if (!ent) return;
  if (!free) p.triggerEvent("dst_papyrus_remove");
  papCool.set(p.id, t + DU.PAP.COOLDOWN);
  const saved = swapIn(p);
  safe(() => p.setDynamicProperty(PAP_KEY, JSON.stringify(saved))); // на случай выхода/смерти: вернём при респавне
  const ctx = { owner: p, dim, start: t, next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, quiet: true, done: false, timeline: [] };
  ults.set("pap:" + p.id, ctx); // движок костей ульты ведёт полёт и попадания костей Папируса
  papyrus.set(p.id, { owner: p, ent, dim, end: t + DU.PAP.LIFE, saved, ctx, cd: {}, pos: { ...pos }, missile: null, scarf: null });
  snd(dim, "mob.endermen.portal", pos, 1.0, 0.5);
  for (let k = 0; k < 16; k++) fx(dim, "sansmode:dust", { x: pos.x + rand(-0.6, 0.6), y: pos.y + rand(0.2, 2.0), z: pos.z + rand(-0.6, 0.6) });
}

function endPapyrus(id, s, restore) {
  papyrus.delete(id);
  const p = s.owner;
  if (s.missile) safe(() => s.missile.ent.remove());
  if (ok(s.ent)) {
    const l = s.ent.location;
    for (let k = 0; k < 28; k++) fx(s.dim, "sansmode:dust", { x: l.x + rand(-0.7, 0.7), y: l.y + rand(0.2, 2.2), z: l.z + rand(-0.7, 0.7) }); // испарение
    snd(s.dim, "mob.endermen.teleport", l, 0.8, 0.6);
    safe(() => s.ent.remove());
  }
  s.ctx.finishing = true;
  if (restore && ok(p)) { swapOut(p, s.saved); safe(() => p.setDynamicProperty(PAP_KEY, undefined)); }
}

function castPap(p, k) {
  const s = papyrus.get(p.id);
  if (!s || !ok(s.ent)) return;
  const t = now(), key = "a" + k, P = DU.PAP;
  if (t < (s.cd[key] || 0)) return;
  const tgt = nearestTarget(s.dim, s.pos, P.HEAD.RANGE, p);
  const from = { x: s.pos.x, y: s.pos.y + 1.3, z: s.pos.z };
  const vd = p.getViewDirection();
  const aim = tgt ? chestOf(tgt) : add(from, mul(vd, 10));
  const base = norm(sub(aim, from));
  const hz = Math.hypot(base.x, base.z) || 1;
  if (k === 1) { // веер из 10 костей
    const F = P.FAN, yaw0 = Math.atan2(base.z, base.x);
    for (let i = 0; i < F.COUNT; i++) {
      const a = yaw0 + (i / (F.COUNT - 1) - 0.5) * F.SPREAD, dir = norm({ x: Math.cos(a) * hz, y: base.y, z: Math.sin(a) * hz });
      addBone(s.ctx, { pos: add(from, mul(dir, 1.2)), launchAt: t + F.DELAY, vel: mul(dir, F.SPEED), life: Math.ceil(30 / F.SPEED) });
    }
    s.cd[key] = t + F.CD; snd(s.dim, "mob.skeleton.step", from, 1, 0.6);
  } else if (k === 2) { // голова-ракета
    if (!tgt || s.missile) return;
    const hp0 = { x: s.pos.x, y: s.pos.y + 1.9, z: s.pos.z };
    const ent = safe(() => s.dim.spawnEntity("dustsans:papyrus_head", hp0));
    if (!ent) return;
    safe(() => s.ent.triggerEvent("dustsans:headless"));
    s.missile = { ent, pos: hp0, vel: mul(norm(sub(chestOf(tgt), hp0)), P.HEAD.SPEED), target: tgt, born: t };
    s.cd[key] = t + P.HEAD.CD; snd(s.dim, "mob.ghast.shoot", hp0, 0.8, 1.4);
  } else if (k === 3) { // большой ряд костей сзади, летят прямо (не наводятся)
    const R = P.ROW, dirH = norm({ x: base.x, y: 0, z: base.z }), perp = { x: -dirH.z, y: 0, z: dirH.x };
    for (let r = 0; r < R.ROWS; r++) for (let i = 0; i < R.W; i++) {
      const lat = (i - (R.W - 1) / 2) * R.STEP;
      const pos = { x: from.x - dirH.x * R.BEHIND + perp.x * lat, y: from.y - 0.5 + r * 0.9, z: from.z - dirH.z * R.BEHIND + perp.z * lat };
      addBone(s.ctx, { pos, launchAt: t + R.DELAY, vel: mul(base, R.SPEED), life: Math.ceil((R.BEHIND + 32) / R.SPEED) });
    }
    s.cd[key] = t + R.CD; snd(s.dim, "mob.wither.spawn", from, 0.8, 1.6);
  } else if (k === 4) { // шарф
    if (!tgt || s.scarf) return;
    s.scarf = { target: tgt, phase: "extend", reach: 0 };
    s.cd[key] = t + P.SCARF.CD; snd(s.dim, "mob.horse.leather", from, 1, 0.7);
  }
}

function tickMissile(s, p, t) {
  const m = s.missile;
  if (!m) return;
  const H = DU.PAP.HEAD;
  const finish = () => { safe(() => m.ent.remove()); s.missile = null; if (ok(s.ent)) safe(() => s.ent.triggerEvent("dustsans:full")); };
  if (!ok(m.ent) || t - m.born > H.LIFE) return finish();
  if (!ok(m.target) || (hp(m.target) ?? 0) <= 0) { m.target = nearestTarget(s.dim, m.pos, H.RANGE, p); if (!m.target) return finish(); }
  const want = norm(sub(chestOf(m.target), m.pos)), cur = norm(m.vel);
  m.vel = mul(norm(add(mul(cur, 1 - H.TURN), mul(want, H.TURN))), H.SPEED); // самонаведение с ограниченным поворотом
  m.pos = add(m.pos, m.vel);
  safe(() => m.ent.teleport(m.pos, { dimension: s.dim, facingLocation: add(m.pos, m.vel) }));
  if (t % 2 === 0) fx(s.dim, "sansmode:dust", m.pos);
  if (len(sub(chestOf(m.target), m.pos)) < H.HIT) {
    if (hurt(m.target, H.DAMAGE, p, 0, true) >= 0) { snd(s.dim, "random.explode", m.pos, 0.8, 1.4); for (let k = 0; k < 10; k++) fx(s.dim, "sansmode:dust", m.pos); }
    finish();
  }
}

function tickScarf(s, p, t) {
  const sc = s.scarf;
  if (!sc) return;
  const C = DU.PAP.SCARF, tg = sc.target;
  if (!ok(tg) || (hp(tg) ?? 0) <= 0) { s.scarf = null; return; }
  const from = { x: s.pos.x, y: s.pos.y + 1.2, z: s.pos.z };
  const to = chestOf(tg), dist = len(sub(to, from));
  if (sc.phase === "extend") {
    if (dist > C.RANGE + 4) { s.scarf = null; return; }
    sc.reach += C.SPEED;
    drawLine(s.dim, from, add(from, mul(norm(sub(to, from)), Math.min(sc.reach, dist))));
    if (sc.reach >= dist) { sc.phase = "pull"; snd(s.dim, "random.anvil_land", to, 0.6, 1.6); }
    return;
  }
  if (t % 4 === 0) freezeBound(tg);
  const holdPt = add(p.location, mul(viewDirH(p), C.FRONT)); // место перед Dust
  if (sc.phase === "pull") { if (stepToward(tg, { x: s.pos.x, y: s.pos.y, z: s.pos.z }, C.PULL, s.dim)) sc.phase = "give"; }
  else if (sc.phase === "give") { if (stepToward(tg, holdPt, C.PULL, s.dim)) sc.phase = "hold"; }
  else safe(() => { tg.teleport(holdPt, { dimension: s.dim }); if (!isPlayerEnt(tg)) tg.clearVelocity(); }); // держит перед Dust, шарф не отпускает
  drawLine(s.dim, from, chestOf(tg));
}

function tickPapyrus(t) {
  for (const [id, s] of [...papyrus]) {
    const p = s.owner, alive = ok(p) && (hp(p) ?? 1) > 0;
    if (!alive || !ok(s.ent) || t >= s.end || !isDust(p)) { endPapyrus(id, s, alive); continue; }
    s.pos = add(s.pos, mul(sub(papHome(p), s.pos), 0.25)); // плавно следует за Dust
    if (t % 5 === 0) s.faceT = nearestTarget(s.dim, s.pos, 30, p);
    const fl = s.faceT && ok(s.faceT) ? s.faceT.location : add(s.pos, mul(viewDirH(p), 6));
    safe(() => s.ent.teleport(s.pos, { dimension: s.dim, facingLocation: { x: fl.x, y: s.pos.y, z: fl.z } }));
    if (t % 6 === 0) fx(s.dim, "sansmode:dust", { x: s.pos.x + rand(-0.4, 0.4), y: s.pos.y + rand(0.3, 2.0), z: s.pos.z + rand(-0.4, 0.4) });
    tickMissile(s, p, t); tickScarf(s, p, t);
  }
}
// конец сессии при смерти / выходе; возврат предметов после респавна
world.afterEvents.entityDie.subscribe((ev) => {
  const d = ev.deadEntity;
  if (!d || !papyrus.has(d.id)) return;
  const s = papyrus.get(d.id), loc = { ...d.location }, dim = d.dimension;
  endPapyrus(d.id, s, false);
  system.runTimeout(() => purgePapItems(dim, loc), 5);
});
world.afterEvents.playerLeave.subscribe((e) => { const s = papyrus.get(e.playerId); if (s) endPapyrus(e.playerId, s, false); });
world.afterEvents.playerSpawn.subscribe((e) => {
  const p = e.player;
  system.runTimeout(() => {
    if (!ok(p) || papyrus.has(p.id)) return;
    const raw = safe(() => p.getDynamicProperty(PAP_KEY));
    if (typeof raw !== "string") return;
    let saved = []; try { saved = JSON.parse(raw); } catch (_) {}
    swapOut(p, saved); safe(() => p.setDynamicProperty(PAP_KEY, undefined));
  }, 40);
});


// ============================================ NIGHTMARE SANS: щупальца, тёмные бластеры, НегаВарп, слизь, лужа ===
const NM = {
  TENT:   { COST: 8, COOLDOWN: 60,  RADIUS: 12, MAX: 6, COUNT: 4, RING: 2.4, DMG: 12, WARN: 12 },
  BLAST:  { COST: 6,  COOLDOWN: 70,  RANGE: 24, COUNT: 3, RING: 3.5, DELAY: 12, BEAM: 16, DMG: 9, SLOW: 80, WEAK: 80 },
  WARP:   { COST: 10, COOLDOWN: 90,  RANGE: 20, BEHIND: 2.0, CROSS_R: 2.6, SPEED: 0.3, TICKS: 26, DMG: 8 },
  ABSORB: { COST: 12, COOLDOWN: 200, RADIUS: 8, DURATION: 120, TENT_COUNT: 10, TENT_RADIUS: 5, TENT_DMG: 8, FX: 2 },
  PUDDLE: { COST: 14, COOLDOWN: 160, TICKS: 80 },
  ULT:    { COST: 24, COOLDOWN: 400, RADIUS: 16, MAX: 6, BLIND: 80, WARN: 20, FLY: 6, DMG: 10, BL_COUNT: 4, BL_R: 3.2, BL_DELAY: 14, BL_STAGGER: 4, BL_BEAM: 14 },
  FULL: 42,
};
const nmCool = new Map();        // id -> { tent, blast, warp, absorb, puddle }
const nmFlyers = [];             // кости креста НегаВарпа
const nmBlasts = [];             // тёмные бластеры
const nmTimers = [];             // отложенные действия {at, fn}
const isKiller = (p) => !!p && safe(() => p.hasTag("killer_sans")) === true;
const isHorror = (p) => !!p && safe(() => p.hasTag("horror_sans")) === true;
const isNight = (p) => !!p && safe(() => p.hasTag("nightmare_sans")) === true;
const nmCD = (p, k) => (nmCool.get(p.id) || {})[k] || 0;
const nmSetCD = (p, k, v) => { const o = nmCool.get(p.id) || {}; o[k] = v; nmCool.set(p.id, o); };
const nmLater = (ticks, fn) => nmTimers.push({ at: now() + ticks, fn });
function segDist(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, add(a, mul(ab, t))));
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// ---------- Щупальца из земли ----------
function castNightTent(p) {
  const T = NM.TENT, t = now(), free = isTrial(p), sneak = sneakOf(p);
  if (t < nmCD(p, "tent")) return;
  if (!free && stamina(p) < T.COST) return deny(p, "§cНе хватает стамины");
  const dim = p.dimension, targets = candidates(dim, p.location, T.RADIUS, p, false).slice(0, T.MAX);
  if (!targets.length) return deny(p, "§7Нет целей");
  if (!free) p.triggerEvent("night_tent_remove");
  nmSetCD(p, "tent", t + T.COOLDOWN);
  snd(dim, "mob.wither.ambient", p.location, 1.0, 0.5);
  for (const e of targets) {
    const l = e.location, shared = new Set();
    for (let k = 0; k < T.WARN; k += 3) system.runTimeout(() => {          // тёмное кольцо-предупреждение
      for (let j = 0; j < 6; j++) { const a = (j * Math.PI) / 3; fx(dim, "sansmode:nightmare_ink", { x: l.x + Math.cos(a) * T.RING, y: l.y + 0.1, z: l.z + Math.sin(a) * T.RING }); }
    }, k);
    system.runTimeout(() => {
      if (!ok(p)) return;
      for (let i = -1; i < T.COUNT; i++) { // i = -1: щупальце ровно в центре кольца, под целью
        const a = (i / T.COUNT) * Math.PI * 2 + rand(-0.3, 0.3), r = i < 0 ? 0 : T.RING * rand(0.5, 1.0);
        const x = l.x + Math.cos(a) * r, z = l.z + Math.sin(a) * r, y = groundY(dim, x, l.y, z);
        const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_tentacle", { x, y, z }));
        if (ent) spikes.push({ ent, dim, x, y, z, born: now(), owner: p, hit: shared, dmg: T.DMG, launch: 0.6 });
      }
      if (sneak) for (let i = -1; i < T.COUNT; i++) { // комбо: столько же щупалец падают с неба
        const a = (i / T.COUNT) * Math.PI * 2 + rand(-0.3, 0.3), r = i < 0 ? 0 : T.RING * rand(0.5, 1.0);
        nmSkyTentacle(p, dim, l.x + Math.cos(a) * r, l.z + Math.sin(a) * r, groundY(dim, l.x, l.y, l.z), shared, T.DMG);
      }
      snd(dim, "dig.stone", l, 1.2, 0.5);
    }, T.WARN);
  }
}

// ---------- Тёмные бластеры: замедление + слабость ----------
function castNightBlast(p) {
  const B = NM.BLAST, t = now(), free = isTrial(p), sneak = sneakOf(p);
  if (t < nmCD(p, "blast")) return;
  if (!free && stamina(p) < B.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, B.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  if (!free) p.triggerEvent("night_blast_remove");
  nmSetCD(p, "blast", t + B.COOLDOWN);
  for (let i = 0; i < B.COUNT; i++) {
    const a = (i / B.COUNT) * Math.PI * 2, l = tgt.location;
    const from = { x: l.x + Math.cos(a) * B.RING, y: l.y + 1.6, z: l.z + Math.sin(a) * B.RING };
    const ent = safe(() => p.dimension.spawnEntity("nightmaresans:nightmare_blaster", from));
    if (ent) {
      safe(() => ent.teleport(from, { facingLocation: { x: l.x, y: l.y + 1.0, z: l.z } }));
      safe(() => ent.triggerEvent("nightmaresans:charge"));
      nmBlasts.push({ ent, dim: p.dimension, owner: p, tgt, from, born: t, fire: t + B.DELAY, end: t + B.DELAY + B.BEAM, hit: new Set(), aim: null, sneak });
    }
  }
  snd(p.dimension, "mob.wither.shoot", p.location, 1.0, 0.6);
}
function tickNightBlasts(t) {
  const B = NM.BLAST;
  for (let i = nmBlasts.length - 1; i >= 0; i--) {
    const b = nmBlasts[i];
    if (!ok(b.ent) || !ok(b.owner) || t >= b.end) { safe(() => b.ent.remove()); nmBlasts.splice(i, 1); continue; }
    if (t < b.fire) { // наводится на цель, потом фиксирует прицел
      if (t < b.fire - Math.min(10, Math.floor((b.fire - b.born) / 2)) && ok(b.tgt)) { const tl = b.tgt.location; b.aimTmp = { x: tl.x, y: tl.y + 1.0, z: tl.z }; } // последние тики перед выстрелом бластер уже не следит за целью
      if (b.aimTmp) safe(() => b.ent.teleport(b.from, { facingLocation: b.aimTmp }));
      continue;
    }
    if (!b.aim) { // момент выстрела
      b.aim = b.aimTmp || { x: b.from.x, y: b.from.y - 1, z: b.from.z };
      safe(() => b.ent.teleport(b.from, { facingLocation: b.aim }));
      safe(() => b.ent.triggerEvent("nightmaresans:fire"));
      snd(b.dim, "mob.warden.sonic_boom", b.from, 1.5, 0.7);
    }
    const dir = norm(sub(b.aim, b.from)), end = add(b.from, mul(dir, B.RANGE + 6));
    if (t % 2 === 0) for (let k = 2; k <= B.RANGE; k += 4) fx(b.dim, b.fxId || "sansmode:nightmare_ink", add(b.from, mul(dir, k)));
    for (const e of candidates(b.dim, add(b.from, mul(dir, (B.RANGE + 6) / 2)), B.RANGE + 6, b.owner, false)) {
      if (b.hit.has(e.id)) continue;
      const l = { x: e.location.x, y: e.location.y + 1, z: e.location.z };
      if (segDist(l, b.from, end) > 1.4) continue;
      b.hit.add(e.id);
      if (hurt(e, B.DMG, b.owner, 0) >= 0) {
        tryEffect(e, ["slowness"], B.SLOW, 1); tryEffect(e, ["weakness"], B.WEAK, 1);
        if (b.sneak) nmSwallow(b.owner, e);
      }
    }
  }
}


// ============================================ NIGHTMARE: КОМБО (Shift + ...) ===
const sneakOf = (p) => safe(() => p.isSneaking) === true;
const nmFall = [];   // щупальца, падающие с неба
const nmSink = [];   // цели, наполовину втянутые тьмой в землю

// Щупальце падает сверху на точку и становится обычным шипом.
function nmSkyTentacle(p, dim, x, z, ground, shared, dmg) {
  const top = ground + 12;
  const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_tentacle", { x, y: top, z }));
  if (!ent) return;
  nmFall.push({ ent, dim, x, z, y: top, ground, owner: p, hit: shared, dmg, born: now() });
}
function tickNightFall() {
  for (let i = nmFall.length - 1; i >= 0; i--) {
    const f = nmFall[i];
    if (!ok(f.ent)) { nmFall.splice(i, 1); continue; }
    f.y = Math.max(f.ground, f.y - 1.1);
    safe(() => f.ent.teleport({ x: f.x, y: f.y, z: f.z }, { dimension: f.dim }));
    if (f.y <= f.ground) {
      nmFall.splice(i, 1);
      spikes.push({ ent: f.ent, dim: f.dim, x: f.x, y: f.ground, z: f.z, born: now(), owner: f.owner, hit: f.hit, dmg: f.dmg, launch: 0.6 });
      snd(f.dim, "dig.stone", { x: f.x, y: f.ground, z: f.z }, 1.0, 0.6);
    }
  }
}

// Цель, в которую попали бластеры в комбо, медленно уходит наполовину в землю.
function nmSwallow(p, e) {
  if (!ok(e)) return;
  tryEffect(e, ["slowness"], 50, 2);
  tryEffect(e, ["weakness"], 50, 1);
  hurt(e, 4, p, 0);                       // 2 сердца
  nmSink.push({ e, dim: e.dimension, base: { ...e.location }, born: now(), dur: 60, owner: p });
  snd(e.dimension, "mob.wither.break_block", e.location, 1.0, 0.5);
}
function tickNightSink(t) {
  for (let i = nmSink.length - 1; i >= 0; i--) {
    const s = nmSink[i];
    if (!ok(s.e) || !ok(s.owner)) { nmSink.splice(i, 1); continue; }
    const age = t - s.born;
    if (age >= s.dur) {                  // выныривает
      safe(() => s.e.teleport(s.base, { dimension: s.dim }));
      nmSink.splice(i, 1); continue;
    }
    const k = Math.min(1, age / 12) * 0.9;   // ушла в землю на 0.9 блока
    const y = s.base.y - k;
    safe(() => s.e.teleport({ x: s.base.x, y, z: s.base.z }, { dimension: s.dim }));
    if (!isPlayerEnt(s.e)) safe(() => s.e.clearVelocity());
    if (age % 4 === 0) for (let j = 0; j < 3; j++) fx(s.dim, "sansmode:nightmare_ink", { x: s.base.x + rand(-0.8, 0.8), y: s.base.y + 0.1, z: s.base.z + rand(-0.8, 0.8) });
  }
}

// Кольцо из щупалец вокруг точки, с одним проходом (можно выбраться).
function nmRingTentacles(p, c, radius, count, shared, dmg) {
  const dim = p.dimension, gap = Math.floor(Math.random() * count);
  for (let k = 0; k < 10; k += 3) system.runTimeout(() => {
    for (let j = 0; j < 6; j++) { const a = (j * Math.PI) / 3; fx(dim, "sansmode:nightmare_ink", { x: c.x + Math.cos(a) * radius, y: c.y + 0.1, z: c.z + Math.sin(a) * radius }); }
  }, k);
  system.runTimeout(() => {
    if (!ok(p)) return;
    for (let i = 0; i < count; i++) {
      if (i === gap) continue;
      const a = (i / count) * Math.PI * 2;
      const x = c.x + Math.cos(a) * radius, z = c.z + Math.sin(a) * radius, y = groundY(dim, x, c.y, z);
      const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_tentacle", { x, y, z }));
      if (ent) spikes.push({ ent, dim, x, y, z, born: now(), owner: p, hit: shared, dmg, launch: 0.6 });
    }
    snd(dim, "dig.stone", c, 1.2, 0.5);
  }, 10);
}

// ============================================ NIGHTMARE: ФИНАЛЬНАЯ АТАКА ===
const nmFly = [];
// Щупальце вылетает из темноты (с позиции сбоку от цели) прямо в неё.
function nmFlyTentacle(p, dim, from, to, shared, dmg) {
  const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_tentacle", from));
  if (!ent) return;
  nmFly.push({ ent, dim, from, to, born: now(), dur: NM.ULT.FLY, owner: p, hit: shared, dmg });
}
function tickNightFly(t) {
  for (let i = nmFly.length - 1; i >= 0; i--) {
    const f = nmFly[i];
    if (!ok(f.ent)) { nmFly.splice(i, 1); continue; }
    const k = Math.min(1, (t - f.born + 1) / f.dur);
    const pos = { x: f.from.x + (f.to.x - f.from.x) * k, y: f.from.y + (f.to.y - f.from.y) * k, z: f.from.z + (f.to.z - f.from.z) * k };
    safe(() => f.ent.teleport(pos, { dimension: f.dim }));
    if (k >= 1) {
      nmFly.splice(i, 1);
      spikes.push({ ent: f.ent, dim: f.dim, x: f.to.x, y: f.to.y, z: f.to.z, born: t, owner: f.owner, hit: f.hit, dmg: f.dmg, launch: 0.6 });
    }
  }
}

function castNightUlt(p) {
  const U = NM.ULT, t = now(), free = isTrial(p);
  if (t < nmCD(p, "ult") || p.hasTag("nm_busy")) return;
  if (!free && stamina(p) < U.COST) return deny(p, "§cНе хватает стамины для последней атаки");
  const targets = candidates(p.dimension, p.location, U.RADIUS, p, false).slice(0, U.MAX);
  if (!targets.length) return deny(p, "§7Нет целей");
  if (!free) p.triggerEvent("nm_ult_remove");
  nmSetCD(p, "ult", t + U.COOLDOWN);
  p.addTag("nm_busy");
  const dim = p.dimension;
  snd(dim, "mob.wither.spawn", p.location, 1.0, 0.5);

  // 1. тьма и слепота на всех целях
  for (const e of targets) {
    tryEffect(e, ["blindness"], U.BLIND, 0);
    if (isPlayerEnt(e)) tryEffect(e, ["darkness"], U.BLIND, 0);
  }

  // 2. предупреждение: тёмные кольца под каждой целью
  const c0 = targets.map((e) => ({ e, l: { ...e.location } }));
  for (let k = 0; k < U.WARN; k += 3) nmLater(k, () => {
    for (const { l } of c0) for (let j = 0; j < 8; j++) {
      const a = (j * Math.PI) / 4; fx(dim, "sansmode:nightmare_ink", { x: l.x + Math.cos(a) * 3, y: l.y + 0.1, z: l.z + Math.sin(a) * 3 });
    }
  });

  // 3. из темноты вылетают щупальца: по 2 на цель, со стороны
  nmLater(U.WARN, () => {
    if (!ok(p)) return;
    const shared = new Map();
    for (const { e, l } of c0) {
      const hit = new Set();
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, R = 5;
        const from = { x: l.x + Math.cos(a) * R, y: l.y + 0.6, z: l.z + Math.sin(a) * R };
        const to = { x: l.x, y: l.y + 0.6, z: l.z };
        nmFlyTentacle(p, dim, from, to, hit, U.DMG);
      }
      snd(dim, "dig.stone", l, 1.4, 0.6);
    }
  });

  // 4. слепота заканчивается — вокруг целей выстраиваются бластеры и стреляют
  nmLater(U.BLIND, () => {
    if (!ok(p)) { return; }
    for (const { e } of c0) {
      if (!ok(e) || (hp(e) ?? 0) <= 0) continue;
      const c = { ...e.location };
      for (let i = 0; i < U.BL_COUNT; i++) {
        const a = (i / U.BL_COUNT) * Math.PI * 2;
        const from = { x: c.x + Math.cos(a) * U.BL_R, y: c.y + 1.6, z: c.z + Math.sin(a) * U.BL_R };
        const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_blaster", from));
        if (!ent) continue;
        safe(() => ent.teleport(from, { facingLocation: { x: c.x, y: c.y + 1.0, z: c.z } }));
        safe(() => ent.triggerEvent("nightmaresans:charge"));
        nmBlasts.push({ ent, dim, owner: p, tgt: e, from, born: now(), fire: now() + U.BL_DELAY + i * U.BL_STAGGER, end: now() + U.BL_DELAY + i * U.BL_STAGGER + U.BL_BEAM, hit: new Set(), aim: null });
      }
      snd(dim, "mob.endermen.portal", c, 1.0, 0.5);
    }
  });
  nmLater(U.BLIND + U.BL_DELAY + U.BL_STAGGER * U.BL_COUNT + U.BL_BEAM + 6, () => {
    if (ok(p)) p.removeTag("nm_busy");
  });
}

// ============================================ NIGHTMARE: УДАР И ЗАХВАТ ЩУПАЛЬЦАМИ ===
// Длина щупалец на клиенте задаётся skin_id: 20+n (удар) / 40+n (захват), n = дистанция в полублоках.
const ARM = {
  STRIKE: { COST: 5, COOLDOWN: 30, RANGE: 7, DMG: 6, EXT: 5, HOLD: 3, RET: 6 },
  GRAB: { COST: 16, COOLDOWN: 200, RANGE: 12, EXT: 8, PULL: 12, HOLD_DIST: 2.2, KB_DMG: 2, KB_H: 2.4, KB_V: 0.6,
          BL_DELAY: 14, BL_BEAM: 8, BL_BACK: 3.5, BL_SIDE: 2.8, AFTER_FIRE: 8, RET: 8 },
};
const nmArms = [];

function armFace(p, at) {
  safe(() => p.teleport(p.location, { dimension: p.dimension, facingLocation: { x: at.x, y: p.location.y + 1.5, z: at.z }, keepVelocity: true }));
}
function armReach(p, st, mode, d) {
  if (d <= 0) { if (st.id !== 0) { st.id = 0; safe(() => p.triggerEvent("nightmare_skin_on")); } return; }
  const max = mode === "strike" ? 16 : 24;
  st.id = (mode === "strike" ? 20 : 40) + Math.max(1, Math.min(max, Math.round(d * 2)));
  safe(() => p.triggerEvent("nm_reach_" + st.id));
}
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function armEnd(p, a) {
  armReach(p, a, a.mode, 0);
  safe(() => p.removeTag("nm_busy"));
}

function castNightStrike(p) {
  const S = ARM.STRIKE, t = now(), free = isTrial(p), sneak = sneakOf(p);
  if (t < nmCD(p, "strike") || p.hasTag("nm_busy")) return;
  if (!free && stamina(p) < S.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, S.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  if (!free) p.triggerEvent("night_strike_remove");
  nmSetCD(p, "strike", t + S.COOLDOWN);
  p.addTag("nm_busy");
  armFace(p, tgt.location);
  snd(p.dimension, "mob.wither.shoot", p.location, 0.8, 1.4);
  const extra = sneak ? candidates(p.dimension, p.location, S.RANGE, p, false).filter((e) => e.id !== tgt.id)
    .sort((a, b) => hdist(a.location, p.location) - hdist(b.location, p.location)).slice(0, 2) : [];
  nmArms.push({ mode: "strike", p, tgt, targets: [tgt, ...extra], born: t, id: 0, dist: Math.max(1, hdist(p.location, tgt.location)), hit: false });
}

function castNightGrab(p) {
  const G = ARM.GRAB, t = now(), free = isTrial(p);
  if (t < nmCD(p, "grab") || p.hasTag("nm_busy")) return;
  if (!free && stamina(p) < G.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, G.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  if (!free) p.triggerEvent("night_grab_remove");
  nmSetCD(p, "grab", t + G.COOLDOWN);
  p.addTag("nm_busy");
  armFace(p, tgt.location);
  snd(p.dimension, "mob.wither.ambient", p.location, 1.0, 0.6);
  const dist = Math.max(1, hdist(p.location, tgt.location));
  const dir = norm({ x: tgt.location.x - p.location.x, y: 0, z: tgt.location.z - p.location.z });
  nmArms.push({ mode: "grab", p, tgt, born: t, id: 0, dist, dir, phase: "ext", phaseAt: t, cur: 0, step: Math.max(0.5, (dist - G.HOLD_DIST) / G.PULL), blasters: false, sneak: sneakOf(p) });
}

// 3 бластера выстраиваются позади цели и стреляют в неё
function armBlasters(a, t) {
  const G = ARM.GRAB, B = NM.BLAST, p = a.p, dim = p.dimension, c = a.hold;
  const side = { x: -a.dir.z, y: 0, z: a.dir.x };
  const tc = { x: c.x, y: c.y + 1.0, z: c.z };
  for (let k = -1; k <= 1; k++) {
    const from = { x: c.x + a.dir.x * G.BL_BACK + side.x * k * G.BL_SIDE, y: c.y + 1.6, z: c.z + a.dir.z * G.BL_BACK + side.z * k * G.BL_SIDE };
    const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_blaster", from));
    if (!ent) continue;
    safe(() => ent.teleport(from, { facingLocation: tc }));
    safe(() => ent.triggerEvent("nightmaresans:charge"));
    nmBlasts.push({ ent, dim, owner: p, tgt: a.tgt, from, born: t, fire: t + G.BL_DELAY, end: t + G.BL_DELAY + G.BL_BEAM, hit: new Set(), aim: null });
  }
  a.fireAt = t + G.BL_DELAY;
  snd(dim, "mob.endermen.portal", c, 1.0, 0.5);
}

function tickNightArms(t) {
  for (let i = nmArms.length - 1; i >= 0; i--) {
    const a = nmArms[i], p = a.p;
    if (!ok(p) || p.hasTag("nm_puddle")) { if (ok(p)) armEnd(p, a); nmArms.splice(i, 1); continue; }
    const age = t - a.born;
    if (a.mode === "strike") {
      const S = ARM.STRIKE, live = ok(a.tgt) && (hp(a.tgt) ?? 0) > 0;
      if (age < S.EXT) {
        if (live) { a.dist = Math.min(S.RANGE, Math.max(1, hdist(p.location, a.tgt.location))); if (age % 2 === 0) armFace(p, a.tgt.location); }
        armReach(p, a, "strike", (a.dist * (age + 1)) / S.EXT);
      } else if (age < S.EXT + S.HOLD) {
        armReach(p, a, "strike", a.dist);
        if (!a.hit) {
          a.hit = true;
          for (const e of a.targets || [a.tgt]) {
            if (!ok(e) || (hp(e) ?? 0) <= 0 || hdist(p.location, e.location) > S.RANGE + 1.5) continue;
            const l = e.location, d = norm({ x: l.x - p.location.x, y: 0, z: l.z - p.location.z });
            if (hurt(e, S.DMG, p, 0) >= 0) knock(e, d.x, d.z, 0.9, 0.25);
            fx(p.dimension, "sansmode:nightmare_ink", { x: l.x, y: l.y + 1, z: l.z });
            snd(p.dimension, "mob.wither.hurt", l, 0.8, 1.3);
          }
        }
      } else if (age < S.EXT + S.HOLD + S.RET) {
        armReach(p, a, "strike", (a.dist * (1 - (age - S.EXT - S.HOLD + 1) / S.RET)));
      } else { armEnd(p, a); nmArms.splice(i, 1); }
      continue;
    }

    // ---- захват ----
    const G = ARM.GRAB, live = ok(a.tgt) && (hp(a.tgt) ?? 0) > 0;
    if (a.phase !== "ret" && !live) { a.phase = "ret"; a.phaseAt = t; a.cur = a.cur || a.dist; }
    if (a.phase === "ext") {
      const pt = t - a.phaseAt;
      if (pt % 2 === 0) armFace(p, a.tgt.location);
      a.dist = Math.min(G.RANGE + 2, Math.max(1, hdist(p.location, a.tgt.location)));
      a.cur = (a.dist * (pt + 1)) / G.EXT;
      armReach(p, a, "grab", a.cur);
      if (pt + 1 >= G.EXT) { a.phase = "pull"; a.phaseAt = t; a.cur = a.dist; snd(p.dimension, "mob.wither.break_block", a.tgt.location, 0.8, 0.7); }
    } else if (a.phase === "pull") {
      const o = p.location, dest = { x: o.x + a.dir.x * G.HOLD_DIST, y: o.y, z: o.z + a.dir.z * G.HOLD_DIST };
      freezeBound(a.tgt);
      const arrived = stepToward(a.tgt, dest, a.step, p.dimension);
      a.cur = Math.max(G.HOLD_DIST, hdist(o, a.tgt.location));
      armReach(p, a, "grab", a.cur);
      if (arrived || t - a.phaseAt > G.PULL + 10) { a.phase = "hold"; a.phaseAt = t; a.hold = { x: dest.x, y: a.tgt.location.y, z: dest.z }; }
    } else if (a.phase === "hold") {
      freezeBound(a.tgt);
      safe(() => a.tgt.teleport(a.hold, { dimension: p.dimension, keepVelocity: false }));
      if (!isPlayerEnt(a.tgt)) safe(() => a.tgt.clearVelocity());
      armReach(p, a, "grab", G.HOLD_DIST);
      if (!a.blasters) { a.blasters = true; armBlasters(a, t); }
      if (t >= a.fireAt + G.AFTER_FIRE) { a.phase = "throw"; a.phaseAt = t; }
    } else if (a.phase === "throw") {
      const l = a.tgt.location;
      if (a.sneak) { // комбо: вместо отбрасывания — щупальца из земли вокруг, можно выбраться
        nmRingTentacles(p, a.hold, 2.8, 6, new Set(), 8);
        snd(p.dimension, "mob.wither.break_block", l, 1.0, 0.6);
      } else {
        if (hurt(a.tgt, G.KB_DMG, p, 0, true) >= 0) knock(a.tgt, a.dir.x, a.dir.z, G.KB_H, G.KB_V);
        snd(p.dimension, "random.explode", l, 0.8, 1.2);
      }
      fx(p.dimension, "sansmode:nightmare_ink", { x: l.x, y: l.y + 1, z: l.z });
      a.phase = "ret"; a.phaseAt = t; a.cur = G.HOLD_DIST;
    } else { // ret
      const pt = t - a.phaseAt, v = a.cur * (1 - (pt + 1) / G.RET);
      armReach(p, a, "grab", v);
      if (pt + 1 >= G.RET) { armEnd(p, a); nmArms.splice(i, 1); }
    }
  }
}

// ---------- НегаВарп: за цель + крест из костей ----------
function castNightWarp(p) {
  const W = NM.WARP, t = now(), free = isTrial(p);
  if (t < nmCD(p, "warp")) return;
  if (!free && stamina(p) < W.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, W.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  if (!free) p.triggerEvent("night_warp_remove");
  nmSetCD(p, "warp", t + W.COOLDOWN);
  const tl = tgt.location, v = viewDirH(tgt);
  const behind = { x: tl.x - v.x * W.BEHIND, y: tl.y, z: tl.z - v.z * W.BEHIND };
  safe(() => p.teleport(behind, { dimension: tgt.dimension, facingLocation: { x: tl.x, y: tl.y + 1, z: tl.z } }));
  snd(p.dimension, "mob.endermen.portal", behind, 1.0, 1.3);
  const c = { x: tl.x, y: tl.y + 1.0, z: tl.z }, sh = new Set();
  for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const from = { x: c.x + dx * W.CROSS_R, y: c.y + dy * W.CROSS_R, z: c.z };
    const ent = safe(() => p.dimension.spawnEntity("nightmaresans:nightmare_bone", from));
    if (ent) nmFlyers.push({ ent, dim: p.dimension, owner: p, c, pos: from, born: t, end: t + W.TICKS, hit: sh });
  }
}
function tickNightFlyers(t) {
  const W = NM.WARP;
  for (let i = nmFlyers.length - 1; i >= 0; i--) {
    const f = nmFlyers[i];
    if (!ok(f.ent) || !ok(f.owner) || t >= f.end) { safe(() => f.ent.remove()); nmFlyers.splice(i, 1); continue; }
    const d = sub(f.c, f.pos), dl = len(d);
    f.pos = dl <= W.SPEED ? f.c : add(f.pos, mul(d, W.SPEED / dl));
    safe(() => f.ent.teleport(f.pos, { dimension: f.dim, facingLocation: f.c }));
    for (const e of candidates(f.dim, f.pos, 2, f.owner, false)) {
      if (f.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - f.pos.x, l.z - f.pos.z) > 1.3 || Math.abs(l.y + 1 - f.pos.y) > 1.6) continue;
      f.hit.add(e.id); hurt(e, W.DMG, f.owner, 0);
    }
  }
}

// ---------- Впитывание слизи: тьма и слепота, потом щупальца ----------
function castNightAbsorb(p) {
  const A = NM.ABSORB, t = now(), free = isTrial(p);
  if (t < nmCD(p, "absorb")) return;
  if (!free && stamina(p) < A.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent("night_absorb_remove");
  nmSetCD(p, "absorb", t + A.COOLDOWN);
  const dim = p.dimension, o = { ...p.location };
  snd(dim, "mob.wither.spawn", o, 0.8, 0.7);
  const zone = () => candidates(dim, o, A.RADIUS, p, false);
  for (const e of zone()) { tryEffect(e, ["blindness"], A.DURATION, 0); if (isPlayerEnt(e)) tryEffect(e, ["darkness"], A.DURATION, 0); }
  for (let k = 0; k < A.DURATION; k += 10) nmLater(k, () => {        // слизь стекается к Nightmare
    for (let j = 0; j < 14; j++) {
      const a = rand(0, Math.PI * 2), r = rand(A.RADIUS * 0.4, A.RADIUS);
      fx(dim, "sansmode:nightmare_ink", { x: o.x + Math.cos(a) * r, y: o.y + rand(0.2, 2.2), z: o.z + Math.sin(a) * r });
    }
    for (const e of zone()) { tryEffect(e, ["blindness"], 40, 0); if (isPlayerEnt(e)) tryEffect(e, ["darkness"], 40, 0); }
  });
  nmLater(A.DURATION, () => {                                          // потом щупальца из земли
    if (!ok(p)) return;
    const shared = new Set();
    for (let i = 0; i < A.TENT_COUNT; i++) {
      const a = (i / A.TENT_COUNT) * Math.PI * 2 + rand(-0.2, 0.2), r = rand(2.0, A.TENT_RADIUS);
      const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r, y = groundY(dim, x, o.y, z);
      const ent = safe(() => dim.spawnEntity("nightmaresans:nightmare_tentacle", { x, y, z }));
      if (ent) spikes.push({ ent, dim, x, y, z, born: now(), owner: p, hit: shared, dmg: A.TENT_DMG, launch: 0.8 });
    }
    snd(dim, "dig.stone", o, 1.3, 0.5);
  });
}

// ---------- Превращение в лужу: 4 секунды, неуязвим и неподвижен ----------
function castNightPuddle(p) {
  const P = NM.PUDDLE, t = now(), free = isTrial(p);
  if (t < nmCD(p, "puddle") || p.hasTag("nm_puddle")) return;
  if (!free && stamina(p) < P.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent("night_puddle_remove");
  nmSetCD(p, "puddle", t + P.COOLDOWN);
  p.addTag("nm_puddle");
  p.triggerEvent("nightmare_puddle_on");
  tryEffect(p, ["resistance"], P.TICKS, 255);
  tryEffect(p, ["slowness"], P.TICKS, 255);
  snd(p.dimension, "mob.slime.big", p.location, 1.0, 0.6);
  nmLater(P.TICKS, () => { if (ok(p)) { p.removeTag("nm_puddle"); p.triggerEvent("nightmare_puddle_off"); snd(p.dimension, "mob.slime.big", p.location, 1.0, 1.2); } });
}

function tickNightmare(t) {
  for (let i = nmTimers.length - 1; i >= 0; i--) { if (t >= nmTimers[i].at) { const f = nmTimers[i].fn; nmTimers.splice(i, 1); safe(f); } }
  tickNightBlasts(t);
  tickNightArms(t);
  tickNightFall();
  tickNightFly(t);
  tickKillerKnives(t);
  tickKillerUlt(t);
  tickNightSink(t);
  tickNightFlyers(t);
}


// ============================================ КЕТЧУП + страховка регенерации ===
const KETCHUP = { AMOUNT: 20, COOLDOWN: 20 };
const ketchupCD = new Map();
const maxStaminaOf = (p) => (isGaster(p) ? 50 : isLastBreath(p) ? LB.FULL : isKiller(p) ? 52 : isNight(p) ? NM.FULL : isDust(p) ? DST.SLEEP_FULL : SLEEP.FULL);
function useKetchup(p) { // бутылка кетчупа: +20 стамины любому Сансу
  if (!isSansP(p)) return safe(() => p.sendMessage(tx("§cКетчуп помогает только Сансу")));
  const t = now();
  if (t < (ketchupCD.get(p.id) || 0)) return;
  const cur = stamina(p), max = maxStaminaOf(p);
  if (cur >= max) return safe(() => p.sendMessage(tx("§7Стамина и так полная")));
  ketchupCD.set(p.id, t + KETCHUP.COOLDOWN);
  safe(() => p.runCommand("clear @s sans:ketchup_bottle 0 1"));
  const n = Math.min(KETCHUP.AMOUNT, max - cur);
  for (let i = 0; i < n; i++) system.runTimeout(() => { if (ok(p)) safe(() => p.triggerEvent(addEvt(p))); }, i);
  snd(p.dimension, "random.drink", p.location, 1.0, 1.0);
  const l = p.location;
  for (let k = 0; k < 12; k++) fx(p.dimension, "minecraft:redstone_ore_dust_particle", { x: l.x + rand(-0.4, 0.4), y: l.y + rand(0.3, 1.8), z: l.z + rand(-0.4, 0.4) });
}

// Если штатная регенерация (контроллеры) молчит 8 секунд при неполной стамине — подхватываем: +1 в секунду, как раньше.
// Как только штатный реген оживает (стамина растёт сама), страховка отключается, двойного регена нет.
const regenWd = new Map();
function regenWatchdog(p, t) {
  const cur = stamina(p), max = maxStaminaOf(p);
  let w = regenWd.get(p.id);
  if (!w) { w = { last: cur, since: t, run: false, next: 0 }; regenWd.set(p.id, w); }
  if (cur < 0 || cur >= max) { w.last = cur; w.since = t; w.run = false; return; }
  if (!w.run) {
    if (cur !== w.last) { w.last = cur; w.since = t; return; }      // стамина меняется — штатный реген жив
    if (t - w.since >= 160) { w.run = true; w.next = t; }           // 8 секунд тишины — подхватываем
    return;
  }
  if (cur > w.last) { w.run = false; w.last = cur; w.since = t; return; } // выросла сама — реген ожил, страховку выключаем
  if (cur < w.last - 1) w.last = cur;                                // потратил — продолжаем с нового уровня
  if (t >= w.next) { safe(() => p.triggerEvent(addEvt(p))); w.next = t + 20; w.last = cur + 1; }
}
// Залипшие теги «занят» блокируют сон — убираем, если висят слишком долго.
const tagSeen = new Map();
function clearStaleTags(p, t) {
  if (ults.has(p.id) || papyrus.has(p.id)) return;
  for (const tg of p.getTags()) {
    if (!(tg.startsWith("sans_cast") || tg.startsWith("sans_combo") || tg === "nm_busy")) continue;
    const key = p.id + tg, first = tagSeen.get(key);
    if (first === undefined) { tagSeen.set(key, t); continue; }
    if (t - first > (tg === "nm_busy" ? 400 : 60)) { safe(() => p.removeTag(tg)); tagSeen.delete(key); }
  }
  for (const [k, v] of tagSeen) if (t - v > 800) tagSeen.delete(k);
}


// ============================================ Смена скина через тик (обход бага рендера Bedrock) ===
// У Killer и Nightmare при входе в режим меняется не только текстура, но и геометрия модели.
// Если включить skin_id и variant в тот же тик, что и смену тега, клиент иногда не успевает
// перестроить модель и держит старую (обычно до первой смены состояния аним-контроллера, т.е. до атаки).
// Поэтому режимные функции только ставят тег sans_skin_sync, а сам скин выставляется здесь, тиком позже.
const skinSyncAt = new Map(); // playerId -> тик, когда тег замечен впервые
function modeSkinOnEvt(p) {
  if (isError(p)) return "error_skin_on";
  if (isGaster(p)) return "gaster_skin_on";
  if (isLastBreath(p)) return p.hasTag("lastbreath_transforming") ? null : "lb_skin_on";
  if (isKiller(p)) return "killer_skin_on";
  if (isNight(p)) return "nightmare_skin_on";
  if (isDust(p)) return "dst_skin_on";
  if (safe(() => p.hasTag("horror_sans"))) return "horror_skin_on";
  if (isSansP(p)) return "horror_skin_off"; // сбрасывает на обычный вид Санса (skin_id 0)
  return null;
}
function tickSkinSync(t) {
  for (const p of world.getAllPlayers()) {
    if (!safe(() => p.hasTag("sans_skin_sync"))) { skinSyncAt.delete(p.id); continue; }
    const first = skinSyncAt.get(p.id);
    if (first === undefined) { skinSyncAt.set(p.id, t); continue; } // этот тик только замечаем тег
    if (t <= first) continue;                                        // ждём хотя бы один следующий тик
    const ev = modeSkinOnEvt(p);
    if (ev) safe(() => p.triggerEvent(ev));
    safe(() => p.removeTag("sans_skin_sync"));
    skinSyncAt.delete(p.id);
  }
}

// ======================================================== LAST BREATH: КОМБО ===
// База (без Shift) переиспользует существующие комбо-атаки обычного Санса — они и
// становятся новым "обычным" ударом Last Breath. Shift даёт новый, более тяжёлый уровень.
function lbCharge(p, name, cost) {
  if (stamina(p) < cost) { deny(p, trf("sans.msg.stamina_n", stamina(p), cost)); return false; }
  safe(() => p.triggerEvent(sevt(p, name)));
  return true;
}

// ---- Shift + кость: обычная атака костью -> мини-арена с бластерами по кругу -> платформа ----
function lbComboBoneArena(p) {
  const key = "lbbone:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  comboBlasterBones(p); // старт: всё, что уже даёт обычная атака костью
  const dim = p.dimension, t0 = now();
  const c = { owner: p, dim, start: t0, next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false, timeline: [] };
  c.timeline = [
    [50, (cc) => { // арена: кольцо костяных стен вокруг цели
      title(cc, "§l§4[ Last Breath: Арена ]");
      snd(dim, "mob.wither.spawn", ok(target) ? target.location : p.location, 1, 1.3);
      comboArena(p);
    }],
    [120, (cc) => { // бластеры по кругу, МЕДЛЕННО (чтобы был шанс увернуться)
      if (!ok(target)) return;
      const tl = target.location, t = now();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        addBlaster(cc, { target, ang: a, r: 9, h: 1.0, spin: 0.012, spawnAt: t, lockAt: t + 70 + i * 6, fireAt: t + 120 + i * 6, beamTicks: 20, dmg: 6, floor: 1 });
      }
    }],
    [320, (cc) => { // платформа + кости и бластеры в цель
      title(cc, "§l§4[ Last Breath: Платформа ]");
      comboPlatform(p);
    }],
    [460, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key, c);
}

// ---- Shift + ГБ: после выстрела бластеров на месте лучей появляются костяные шипы ----
function lbComboGbSpikes(p) {
  const key = "lbgb:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  comboGasterBehind(p); // 2 бластера сзади цели + дождь костей (уже существующее комбо)
  const dim = p.dimension;
  system.runTimeout(() => {
    if (!ok(target)) return;
    const l = target.location;
    title({ owner: p }, "§l§4[ Шипы на месте выстрела ]");
    snd(dim, "mob.wither.break_block", l, 1.2, 0.8);
    for (const d of [{ x: 1.6, z: 0 }, { x: -1.6, z: 0 }, { x: 0, z: 1.6 }, { x: 0, z: -1.6 }]) {
      const x = l.x + d.x, z = l.z + d.z, y = groundY(dim, x, l.y, z);
      system.runTimeout(() => {
        const ent = safe(() => dim.spawnEntity("playersans:bone_spike", { x, y, z }));
        fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
        if (ent) spikes.push({ ent, dim, x, y, z, owner: p, born: now(), life: CFG.SPIKES.LIFE, active_from: 0, active_to: CFG.SPIKES.LIFE });
      }, 8);
    }
  }, 70);
}

// ---- Shift + откидывание: 4 стены подряд, с разных сторон, последняя - в потолок ----
function lbComboFourWalls(p) {
  const key = "lbwalls4:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  const dim = p.dimension;
  const dirs = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }]; // 3 стены по бокам + потолок
  title({ owner: p }, "§l§4[ Last Breath: 4 стены ]");
  let delay = 0;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i], toCeil = i === dirs.length - 1;
    system.runTimeout(() => {
      if (!ok(target)) return;
      const l = target.location;
      snd(dim, "mob.wither.shoot", l, 1.2, toCeil ? 0.6 : 1.0);
      if (toCeil) knock(target, 0, 0, 0.05, 1.5);
      else knock(target, d.x, d.z, 1.6, 0.25);
      hurt(target, 6, p, 1, false, 0);
      fx(dim, "minecraft:blue_flame_particle", l);
      // кости-искры из стены, в которую впечатало
      for (let k = 0; k < 6; k++) fx(dim, "minecraft:villager_angry", { x: l.x + rand(-0.6, 0.6), y: l.y + rand(0.2, 1.8), z: l.z + rand(-0.6, 0.6) });
    }, delay);
    delay += 16;
  }
}

// ---- Shift + телекинез: подброс -> 4 волны разноцветных костей с разных сторон + бластеры ----
function lbComboTelekinesisColor(p) {
  const key = "lbtele:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  const dim = p.dimension;
  title({ owner: p }, "§l§4[ Last Breath: Телекинез ]");
  tryEffect(target, ["levitation"], 110, 4);
  snd(dim, "mob.wither.spawn", target.location, 1, 1.4);
  const c = { owner: p, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false, timeline: [] };
  const pairs = [[0, Math.PI], [Math.PI / 2, (Math.PI * 3) / 2], [Math.PI / 4, (Math.PI * 5) / 4], [(Math.PI * 3) / 4, (Math.PI * 7) / 4]];
  let t = 20;
  for (const [a1, a2] of pairs) {
    const at = t;
    c.timeline.push([at, () => { lbColorWave(p, target, "blue", a1); lbColorWave(p, target, "orange", a2); }]);
    c.timeline.push([at + 26, (cc) => {
      if (!ok(target)) return;
      const tnow = now();
      for (const a of [a1, a2, (a1 + a2) / 2]) addBlaster(cc, { target, ang: a, r: 6, h: 2.2, spin: 0, spawnAt: tnow, lockAt: tnow + 10, fireAt: tnow + 18, beamTicks: 10, dmg: 5, floor: 1 });
    }]);
    t += 46;
  }
  c.timeline.push([t + 20, (cc) => { cc.finishing = true; }]);
  ults.set(key, c);
}

// ---- Shift + wall: вместо стены — гигантский бластер хватает САМОГО санса и перебрасывает на 15 блоков, спасая его ----
// ---- Shift + spikes: крест из шипов (обычное комбо) + бластеры по кругу цели ----
function lbComboSpikesBlaster(p) {
  const key = "lbspikes:" + p.id;
  if (ults.has(key)) return;
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели для комбо");
  comboCrossSpikes(p); // старт: тот же крест шипов, что и у обычного комбо
  const dim = p.dimension;
  title({ owner: p }, "§l§4[ Last Breath: Шипы-бластеры ]");
  snd(dim, "mob.wither.spawn", target.location, 1, 1.2);
  const c = { owner: p, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false, timeline: [] };
  c.timeline = [
    [40, (cc) => { // пока шипы ещё поднимаются, по цели выстраиваются бластеры по кругу
      if (!ok(target)) return;
      const t = now();
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        addBlaster(cc, { target, ang: a, r: 7, h: 1.4, spin: 0.01, spawnAt: t, lockAt: t + 60 + i * 5, fireAt: t + 110 + i * 5, beamTicks: 16, dmg: 7, floor: 1 });
      }
    }],
    [170, (cc) => { cc.finishing = true; }],
  ];
  ults.set(key, c);
}

function lbComboWallSelf(p) {
  const key = "lbwallsave:" + p.id;
  if (ults.has(key)) return;
  const dim = p.dimension, o = { ...p.location }, h = viewDirH(p);
  const dest = { x: o.x - h.x * 15, y: o.y, z: o.z - h.z * 15 };
  dest.y = groundY(dim, dest.x, o.y, dest.z) + 0.1;
  title({ owner: p }, "§l§9[ Last Breath: Спасение ]");
  snd(dim, "mob.endermen.portal", o, 1.2, 0.6);
  tryEffect(p, ["resistance"], 50, 4);
  tryEffect(p, ["invisibility"], 24, 0);
  for (const e of candidates(dim, o, 5, p, true)) knock(e, (e.location.x - o.x) || rand(-1, 1), (e.location.z - o.z) || rand(-1, 1), 1.2, 0.3);
  system.runTimeout(() => {
    if (!ok(p)) return;
    safe(() => p.teleport(dest, { dimension: dim }));
    snd(dim, "mob.wither.break_block", dest, 1.4, 0.7);
    fx(dim, "minecraft:huge_explosion_emitter", dest);
    const c = { owner: p, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [], quiet: true, done: false, timeline: [] };
    const t = now();
    c.timeline = [
      [4, (cc) => addBlaster(cc, { target: p, ang: 0, r: 0.1, h: 2.4, spin: 0, spawnAt: t + 4, lockAt: t + 10, fireAt: t + 16, beamTicks: 18, dmg: 10, floor: 1, beamR: 2.8 })],
      [40, (cc) => { cc.finishing = true; }],
    ];
    ults.set(key, c);
  }, 16);
}

// ---- Разноцветные кости телекинеза: синяя бьёт, если цель ДВИЖЕТСЯ; оранжевая — если цель СТОИТ ----
const lbColorBones = [];
function lbColorWave(p, target, color, ang) {
  if (!ok(target)) return;
  const dim = p.dimension, tl = target.location;
  const from = { x: tl.x + Math.cos(ang) * 10, y: tl.y + 1.2, z: tl.z + Math.sin(ang) * 10 };
  const ent = safe(() => dim.spawnEntity(ET(p, "playersans:flying_bone"), from));
  if (!ent) return;
  safe(() => ent.triggerEvent(color === "blue" ? "dst_red" : "dst_default")); // визуально различаем синюю/оранжевую, где возможно
  snd(dim, "mob.skeleton.step", from, 1, color === "blue" ? 1.5 : 0.65);
  fx(dim, color === "blue" ? "minecraft:mob_flame_particle" : "minecraft:basic_flame_particle", from);
  const t0 = now(), fireAt = t0 + 24;
  lbColorBones.push({ ent, owner: p, target, color, startPos: { ...tl }, from, dim, fireAt, t0, done: false });
}
function tickLbColorBones(t) {
  for (let i = lbColorBones.length - 1; i >= 0; i--) {
    const b = lbColorBones[i];
    if (b.done || !ok(b.ent)) { if (ok(b.ent)) safe(() => b.ent.remove()); lbColorBones.splice(i, 1); continue; }
    const tgtNow = ok(b.target) ? b.target.location : b.from;
    const k = Math.max(0, Math.min(1, (t - b.t0) / (b.fireAt - b.t0)));
    const pos = { x: b.from.x + (tgtNow.x - b.from.x) * k, y: b.from.y + (tgtNow.y + 1 - b.from.y) * k, z: b.from.z + (tgtNow.z - b.from.z) * k };
    safe(() => b.ent.teleport(pos, { facingLocation: tgtNow }));
    if (t >= b.fireAt) {
      b.done = true;
      if (ok(b.target)) {
        const moved = Math.hypot(b.target.location.x - b.startPos.x, b.target.location.z - b.startPos.z) > 0.35;
        const good = (b.color === "blue" && moved) || (b.color === "orange" && !moved);
        if (good) { hurt(b.target, 4, b.owner, 1, false, 0); fx(b.dim, "minecraft:villager_angry", b.target.location); snd(b.dim, "mob.skeleton.hurt", b.target.location, 1, 1); }
      }
      safe(() => b.ent.remove());
    }
  }
}

// ============================================================ главный цикл ===
system.runInterval(() => {
  const t = now();
  for (const p of world.getAllPlayers()) {
    if (isSansP(p)) sansIds.add(p.id); else sansIds.delete(p.id);
    if (isError(p) && !p.hasTag("sans_sleep") && !dying.has(p.id) && t % 20 === 0) safe(() => p.triggerEvent("error_skin_on"));
    if (isError(p) && p.hasTag("sans_sleep") && !dying.has(p.id) && t % 20 === 0) safe(() => p.triggerEvent("error_sleep_skin_on"));
    if (isError(p) && p.hasTag("sans_sleep") && !dying.has(p.id)) errorSleepGlitch(p, t);
    if (isSansP(p) && !isLastBreath(p) && !dying.has(p.id)) safe(() => lastStandTick(p, t));
    if (isLastBreath(p) && !p.hasTag("lastbreath_transforming") && !dying.has(p.id) && stamina(p) <= 0) {
      const lh = lastHit.get(p.id);
      safe(() => startDeath(p, lh ? lh.k : null)); // стамина на нуле — пизда Сансу, обычная сцена смерти в скине Last Breath
    }
    if (p.hasTag("sans_dust_anim")) { for (const x of p.getTags()) if (x.startsWith("sans_cast") || x.startsWith("sans_combo") || x === "sans_bt") safe(() => p.removeTag(x)); continue; } // идёт превращение: способности и сон отключены
    if (p.hasTag("nm_puddle")) { for (const x of p.getTags()) if (x.startsWith("sans_cast")) safe(() => p.removeTag(x)); continue; }
    if (dying.has(p.id) || ([...dying.values()].some((d) => d.killer && d.killer.id === p.id))) { // участники сцены смерти
      for (const x of p.getTags()) if (x.startsWith("sans_cast") || x.startsWith("sans_combo")) safe(() => p.removeTag(x));
      continue;
    }
    const asleep = safe(() => sleepTick(p, t)) === true;
    if (!asleep && isSansP(p)) { safe(() => regenWatchdog(p, t)); if (t % 20 === 0) safe(() => clearStaleTags(p, t)); }
    if (asleep) {
      for (const x of p.getTags()) if (x.startsWith("sans_cast") || x.startsWith("sans_combo") || x === TAG_ULT) safe(() => p.removeTag(x));
      continue;
    }
    if (p.hasTag(TAG_SPIKES)) { p.removeTag(TAG_SPIKES); safe(() => {
      if (isLastBreath(p)) { if (sneaking(p)) { if (lbCharge(p, "bone_spikes_remove", LB.COST.spikes * 2)) lbComboSpikesBlaster(p); } else if (lbCharge(p, "bone_spikes_remove", LB.COST.spikes)) comboCrossSpikes(p); return; }
      if (!dustCombo(p, "dst_bone_spikes_remove", CFG.SPIKES.COST, (pay) => comboCrossSpikes(p, pay))) castSpikes(p);
    }); }
    if (p.hasTag("sans_bt")) { p.removeTag("sans_bt"); safe(() => blueVolley(p)); }
    if (p.hasTag("horror_cast_axe")) { p.removeTag("horror_cast_axe"); safe(() => castHorrorAxe(p)); }
    if (p.hasTag("horror_cast_cleaver")) { p.removeTag("horror_cast_cleaver"); safe(() => castHorrorCleaver(p)); }
    if (p.hasTag("sans_cast_wall")) { p.removeTag("sans_cast_wall"); safe(() => {
      if (isLastBreath(p)) { if (sneaking(p)) { if (lbCharge(p, "bone_wall_remove", LB.COST.wall * 2)) lbComboWallSelf(p); } else if (lbCharge(p, "bone_wall_remove", LB.COST.wall)) comboArena(p); return; }
      if (!dustCombo(p, "dst_bone_wall_remove", CFG.WALL.COST, (pay) => comboArena(p, pay))) castWall(p);
    }); }
    if (p.hasTag("sans_cast_tele")) { p.removeTag("sans_cast_tele"); safe(() => {
      if (isLastBreath(p)) { if (sneaking(p)) { if (lbCharge(p, "telekinesis_remove", LB.COST.tele * 2)) lbComboTelekinesisColor(p); } else if (lbCharge(p, "telekinesis_remove", LB.COST.tele)) comboSlam(p); return; }
      if (!dustCombo(p, "dst_telekinesis_remove", CFG.TELE.COST, (pay) => comboSlam(p, pay))) castTele(p);
    }); }
    if (p.hasTag("sans_combo_bone")) { p.removeTag("sans_combo_bone"); safe(() => { if (!isLastBreath(p)) comboBlasterBones(p); }); }
    if (p.hasTag("sans_combo_spikes")) { p.removeTag("sans_combo_spikes"); safe(() => { if (!isLastBreath(p)) comboCrossSpikes(p); }); }
    if (p.hasTag("sans_combo_wall")) { p.removeTag("sans_combo_wall"); safe(() => { if (!isLastBreath(p)) comboArena(p); }); }
    if (p.hasTag("sans_combo_throw")) { p.removeTag("sans_combo_throw"); safe(() => { if (!isLastBreath(p)) comboThrowWall(p); }); }
    if (p.hasTag("sans_combo_time")) { p.removeTag("sans_combo_time"); safe(() => comboTimeStop(p)); }
    if (p.hasTag("sans_combo_dtime")) { p.removeTag("sans_combo_dtime"); if (isDust(p)) safe(() => comboTimeStop(p)); }
    if (p.hasTag("sans_combo_slam")) { p.removeTag("sans_combo_slam"); safe(() => { if (!isLastBreath(p)) comboSlam(p); }); }
    if (p.hasTag("sans_combo_gb")) { p.removeTag("sans_combo_gb"); safe(() => { if (!isLastBreath(p)) comboGasterX(p); }); }
    if (p.hasTag("sans_combo_trial")) { p.removeTag("sans_combo_trial"); safe(() => comboTrial(p)); }
    if (p.hasTag("sans_combo_ult")) { p.removeTag("sans_combo_ult"); safe(() => castUltimate(p, true)); }
    if (p.hasTag(TAG_ULT)) { p.removeTag(TAG_ULT); safe(() => { if (!dustCombo(p, "dst_ult_remove", CFG.ULT.COST, (pay) => castUltimate(p, true, pay))) castUltimate(p); }); }
    if (p.hasTag("sans_cast_trial")) { p.removeTag("sans_cast_trial"); safe(() => castTrial(p)); }
    if (p.hasTag("sans_cast_grav")) { p.removeTag("sans_cast_grav"); safe(() => castGravity(p)); }
    if (p.hasTag("sans_cast_under")) { p.removeTag("sans_cast_under"); safe(() => castUnder(p)); }
    if (p.hasTag("sans_cast_nt_tent")) { p.removeTag("sans_cast_nt_tent"); safe(() => castNightTent(p)); }
    if (p.hasTag("sans_cast_nt_blast")) { p.removeTag("sans_cast_nt_blast"); safe(() => castNightBlast(p)); }
    if (p.hasTag("sans_cast_nt_warp")) { p.removeTag("sans_cast_nt_warp"); safe(() => castNightWarp(p)); }
    if (p.hasTag("sans_cast_nt_absorb")) { p.removeTag("sans_cast_nt_absorb"); safe(() => castNightAbsorb(p)); }
    if (p.hasTag("sans_cast_nt_strike")) { p.removeTag("sans_cast_nt_strike"); safe(() => castNightStrike(p)); }
    if (p.hasTag("sans_cast_nt_grab")) { p.removeTag("sans_cast_nt_grab"); safe(() => castNightGrab(p)); }
    if (p.hasTag("sans_cast_nt_ult")) { p.removeTag("sans_cast_nt_ult"); safe(() => castNightUlt(p)); }
    if (p.hasTag("sans_cast_nt_puddle")) { p.removeTag("sans_cast_nt_puddle"); safe(() => castNightPuddle(p)); }
    if (p.hasTag("sans_cast_papsummon")) { p.removeTag("sans_cast_papsummon"); safe(() => summonPapyrus(p)); }
    for (let k = 1; k <= 4; k++) if (p.hasTag("sans_cast_pap" + k)) { p.removeTag("sans_cast_pap" + k); safe(() => castPap(p, k)); }
    if (p.hasTag("sans_cast_bthrow")) { p.removeTag("sans_cast_bthrow"); try {
      if (isLastBreath(p)) {
        if (sneaking(p)) { if (lbCharge(p, "bone0_remove", LB.COST.bone * 2)) lbComboBoneArena(p); }
        else if (lbCharge(p, "bone0_remove", LB.COST.bone)) comboBlasterBones(p);
      } else if (!dustCombo(p, "dst_bone0_remove", COMBO.BLASTER.COST, (pay) => comboBlasterBones(p, pay))) onBoneThrow(p);
    } catch (e) { safe(() => p.sendMessage("§c[LB DEBUG bone0] " + e)); } }
    if (p.hasTag("sans_cast_gbfire")) { p.removeTag("sans_cast_gbfire"); try {
      if (isLastBreath(p)) {
        if (sneaking(p)) { if (lbCharge(p, "gb_remove", LB.COST.gb * 2)) lbComboGbSpikes(p); }
        else if (lbCharge(p, "gb_remove", LB.COST.gb)) comboGasterBehind(p);
      } else if (!dustCombo(p, "dst_gb_remove", 3, (pay) => comboGasterBehind(p, pay))) onGasterFire(p);
    } catch (e) { safe(() => p.sendMessage("§c[LB DEBUG gb] " + e)); } }
    if (p.hasTag("sans_cast_dctl")) { p.removeTag("sans_cast_dctl"); try {
      if (isLastBreath(p)) {
        if (sneaking(p)) { if (lbCharge(p, "control_remove", LB.COST.control * 2)) lbComboFourWalls(p); }
        else if (lbCharge(p, "control_remove", LB.COST.control)) comboThrowWall(p);
      } else if (isDust(p)) dustCombo(p, "dst_control_remove", 3, (pay) => comboPlatform(p, pay));
    } catch (e) { safe(() => p.sendMessage("§c[LB DEBUG control] " + e)); } }
    if (t % 40 === 0) safe(() => cleanupStale(p));
  }
  tickTrials(t);
  if (t % 40 === 0) { safe(sweepOrphans); safe(sweepControl); }
  tickSlides();
  tickFlings();
  tickSlams();
  tickTimeStops(t);
  safe(() => tickRains(t));
  safe(() => tickSkinSync(t));
  safe(() => tickDeaths(t));
  safe(() => tickLbColorBones(t));
  safe(() => trackMotion());
  safe(() => tickDustTrigger(t));
  safe(() => tickDustAnims(t));
  safe(() => tickPapyrus(t));
  safe(() => tickNightmare(t));
  safe(() => tickSpikes(t));
  safe(() => tickWalls(t));
  for (const [id, c] of [...ults]) safe(() => tickUlt(id, c, t));
}, 1);


// ============================================ KILLER SANS: НОЖ ===
const KN = { COST: 8, COOLDOWN: 20, RANGE: 3.6, DMG: 15, CONE: 0.5, KB: 0.5 };
const killerCD = new Map();
const kcd = (p, k) => killerCD.get(p.id + k) ?? -1e9;
function castKillerKnife(p) {
  if (!isKiller(p)) return;
  const t = now(), last = kcd(p, "knife");
  if (t - last < KN.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < KN.COST) return deny(p, "§cНе хватает стамины");
  const dim = p.dimension, dir = safe(() => p.getViewDirection()) || { x: 0, z: -1 };
  const hz = Math.hypot(dir.x, dir.z) || 1, fx_ = dir.x / hz, fz = dir.z / hz;
  const hits = candidates(dim, p.location, KN.RANGE, p, false).filter((e) => {
    const dx = e.location.x - p.location.x, dz = e.location.z - p.location.z, d = Math.hypot(dx, dz) || 1;
    return (dx * fx_ + dz * fz) / d >= KN.CONE;
  });
  if (!hits.length) return deny(p, "§7Нет цели");
  killerCD.set(p.id + "knife", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_8");
  snd(dim, "mob.wither.shoot", p.location, 1.0, 1.4);
  for (const e of hits) {
    const l = e.location;
    if (hurt(e, KN.DMG, p, 0) >= 0) knock(e, fx_, fz, KN.KB, 0.2);
    fx(dim, "bloodspray:blood_spray", { x: l.x, y: l.y + 1, z: l.z });
    snd(dim, "mob.wither.hurt", l, 0.8, 1.6);
  }
}

// ---- Веер ножей и круговые ножи: ножи-снаряды ----
const KF = { FAN_COST: 10, FAN_CD: 30, FAN_DMG: 6, FAN_N: 5, FAN_SIDE: 1.6, FAN_SPREAD: 0.55, FAN_SPEED: 0.9, FAN_LIFE: 26,
             CIR_COST: 16, CIR_CD: 60, CIR_DMG: 8, CIR_N: 12, CIR_R: 2.6, CIR_FORM: 10, CIR_SPEED: 1.1, CIR_LIFE: 70, CIR_RANGE: 14 };
const kknives = []; // { ent, pos, vel, dim, owner, born, life, dmg, homing, hit }
function spawnKnife(p, pos, vel, opts) {
  const dim = p.dimension;
  const ent = safe(() => dim.spawnEntity("killersans:killer_knife_proj", pos));
  if (!ent) return null;
  const face = opts.face || add(pos, vel);
  safe(() => ent.teleport(pos, { dimension: dim, facingLocation: face }));
  const k = { ent, pos: { ...pos }, vel, dim, owner: p, born: now(), life: opts.life, dmg: opts.dmg, homing: opts.homing || null, hit: new Set() };
  kknives.push(k);
  return k;
}
function castKillerFan(p) {
  if (!isKiller(p)) return;
  const F = KF, t = now();
  if (t - kcd(p, "fan") < F.FAN_CD) return;
  if (!isTrial(p) && stamina(p) < F.FAN_COST) return deny(p, "§cНе хватает стамины");
  const dir = safe(() => p.getViewDirection()) || { x: 0, z: -1 };
  const hz = Math.hypot(dir.x, dir.z) || 1, fx0 = dir.x / hz, fz0 = dir.z / hz;
  const right = { x: -fz0, z: fx0 }, base = p.location;
  killerCD.set(p.id + "fan", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_10");
  snd(p.dimension, "mob.wither.shoot", base, 1.0, 1.6);
  for (const side of [-1, 1]) {
    const o = { x: base.x + right.x * side * F.FAN_SIDE, y: base.y + 1.2, z: base.z + right.z * side * F.FAN_SIDE };
    for (let i = 0; i < F.FAN_N; i++) {
      const a = (i / (F.FAN_N - 1) - 0.5) * 2 * F.FAN_SPREAD, c = Math.cos(a), sn = Math.sin(a);
      const vx = fx0 * c - fz0 * sn, vz = fx0 * sn + fz0 * c;
      spawnKnife(p, o, { x: vx * F.FAN_SPEED, y: 0, z: vz * F.FAN_SPEED }, { life: F.FAN_LIFE, dmg: F.FAN_DMG });
    }
  }
}
function castKillerCircle(p) {
  if (!isKiller(p)) return;
  const C = KF, t = now();
  if (t - kcd(p, "circle") < C.CIR_CD) return;
  if (!isTrial(p) && stamina(p) < C.CIR_COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, C.CIR_RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  killerCD.set(p.id + "circle", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_16");
  snd(p.dimension, "mob.wither.ambient", p.location, 1.0, 1.2);
  const c = p.location;
  for (let i = 0; i < C.CIR_N; i++) {
    const a = (i / C.CIR_N) * Math.PI * 2;
    const pos = { x: c.x + Math.cos(a) * C.CIR_R, y: c.y + 1.2, z: c.z + Math.sin(a) * C.CIR_R };
    spawnKnife(p, pos, { x: 0, y: 0, z: 0 }, { life: C.CIR_LIFE, dmg: C.CIR_DMG, homing: { e: tgt, form: C.CIR_FORM, speed: C.CIR_SPEED }, face: { x: pos.x + Math.cos(a), y: pos.y, z: pos.z + Math.sin(a) } });
  }
}
function dropKnife(i) { const k = kknives[i]; safe(() => k.ent.remove()); kknives.splice(i, 1); }
function tickKillerKnives(t) {
  for (let i = kknives.length - 1; i >= 0; i--) {
    const k = kknives[i];
    if (!ok(k.owner) || !ok(k.ent) || t - k.born >= k.life) { dropKnife(i); continue; }
    let dir = null;
    if (k.homing) {
      const h = k.homing;
      if (t - k.born < h.form) { continue; }                      // строятся в круг и стоят
      if (!ok(h.e) || (hp(h.e) ?? 0) <= 0) { dropKnife(i); continue; }
      const aim = { x: h.e.location.x, y: h.e.location.y + 1, z: h.e.location.z };
      dir = norm(sub(aim, k.pos));
      k.vel = mul(dir, h.speed);
    } else {
      dir = norm(k.vel);
    }
    k.pos = add(k.pos, k.vel);
    safe(() => k.ent.teleport(k.pos, { dimension: k.dim, facingLocation: add(k.pos, dir) }));
    const sp = k.pos;
    let removed = false;
    for (const e of candidates(k.dim, sp, 1.6, k.owner, false)) {
      if (k.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - sp.x, (l.y + 1) - sp.y, l.z - sp.z) > 1.3) continue;
      k.hit.add(e.id);
      if (hurt(e, k.dmg, k.owner, 0) >= 0) knock(e, k.vel.x || 0, k.vel.z || 0, 0.3, 0.1);
      fx(k.dim, "bloodspray:blood_spray", { x: l.x, y: l.y + 1, z: l.z });
      if (k.homing) { dropKnife(i); removed = true; break; }
    }
    if (removed) continue;
  }
}
world.afterEvents.itemUse.subscribe((ev) => {
  const id = ev.itemStack?.typeId, p = ev.source;
  if (id === "killersans:killer_knife") safe(() => castKillerKnife(p));
  else if (id === "killersans:killer_fan") safe(() => castKillerFan(p));
  else if (id === "killersans:killer_circle") safe(() => castKillerCircle(p));
});


// ============================================ KILLER SANS: БЛАСТЕР, ОТБРАСЫВАНИЕ ===
const KB2 = { COST: 14, COOLDOWN: 60, RANGE: 14 };
const KK = { COST: 8, COOLDOWN: 40, RADIUS: 5.5, KB_H: 4.2, KB_V: 0.9 };
function castKillerBlaster(p) {
  if (!isKiller(p)) return;
  const B = NM.BLAST, t = now();
  if (t - kcd(p, "blaster") < KB2.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < KB2.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, KB2.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  killerCD.set(p.id + "blaster", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_14");
  const dim = p.dimension, l = p.location, tl = tgt.location;
  // 3 бластера вокруг цели вместо одного (трата стамины прежняя)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6, R = 3.4;
    const from = { x: tl.x + Math.cos(a) * R, y: tl.y + 1.8, z: tl.z + Math.sin(a) * R };
    const ent = safe(() => dim.spawnEntity("killersans:killer_blaster", from));
    if (!ent) continue;
    safe(() => ent.teleport(from, { facingLocation: { x: tl.x, y: tl.y + 1, z: tl.z } }));
    safe(() => ent.triggerEvent("nightmaresans:charge"));
    nmBlasts.push({ ent, dim, owner: p, tgt, from, born: t, fire: t + B.DELAY + i * 3, end: t + B.DELAY + i * 3 + B.BEAM, hit: new Set(), aim: null, sneak: false, fxId: "sansmode:killer_knife" });
  }
  snd(dim, "mob.wither.ambient", l, 1.0, 0.7);
}
function castKillerKnock(p) {
  if (!isKiller(p)) return;
  const K = KK, t = now();
  if (t - kcd(p, "knock") < K.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < K.COST) return deny(p, "§cНе хватает стамины");
  const hits = candidates(p.dimension, p.location, K.RADIUS, p, false);
  if (!hits.length) return deny(p, "§7Нет целей рядом");
  killerCD.set(p.id + "knock", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_8");
  const dim = p.dimension, c = p.location;
  for (const e of hits) {
    const dx = e.location.x - c.x, dz = e.location.z - c.z, d = Math.hypot(dx, dz) || 1;
    knock(e, dx / d, dz / d, K.KB_H, K.KB_V);
  }
  for (const R of [2, 3.5, 4.5]) for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    fx(dim, "sansmode:killer_knife", { x: c.x + Math.cos(a) * R, y: c.y + 0.5, z: c.z + Math.sin(a) * R });
  }
  snd(dim, "mob.wither.shoot", c, 1.2, 0.5);
}
world.afterEvents.itemUse.subscribe((ev) => {
  const id = ev.itemStack?.typeId, p = ev.source;
  if (id === "killersans:killer_gb") safe(() => castKillerBlaster(p));
  else if (id === "sans:ketchup_bottle") safe(() => useKetchup(p));
  else if (id === "killersans:killer_knock") safe(() => castKillerKnock(p));
  else if (id === "killersans:killer_tele") safe(() => castKillerTele(p));
  else if (id === "killersans:killer_bone") safe(() => castKillerBone(p));
});


// ============================================ KILLER SANS: ТЕЛЕПОРТ (подброс), КОСТИ ===
const KT = { COST: 6, COOLDOWN: 30, DIST: 15 };
const KBN = { COST: 8, COOLDOWN: 40, RANGE: 10, COUNT: 6, DMG: 8, RISE: 2.2 };
function castKillerTele(p) {
  if (!isKiller(p)) return;
  const T = KT, t = now();
  if (t - kcd(p, "tele") < T.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < T.COST) return deny(p, "§cНе хватает стамины");
  const dim = p.dimension, o = p.location;
  const dir = safe(() => p.getViewDirection()) || { x: 0, y: 0, z: -1 };
  const free = (x, y, z) => {
    const f = safe(() => dim.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }));
    const h = safe(() => dim.getBlock({ x: Math.floor(x), y: Math.floor(y + 1), z: Math.floor(z) }));
    return !!f && !!h && !f.isSolid && !h.isSolid;
  };
  // идём по взгляду шагами и останавливаемся перед первым препятствием
  let best = null;
  for (let d = 0.5; d <= T.DIST; d += 0.5) {
    const x = o.x + dir.x * d, y = o.y + dir.y * d, z = o.z + dir.z * d;
    if (!free(x, y, z)) break;
    best = { x, y, z };
  }
  if (!best || Math.hypot(best.x - o.x, best.y - o.y, best.z - o.z) < 1.5) return deny(p, "§7Путь заблокирован");
  killerCD.set(p.id + "tele", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_6");
  const ring = (c) => { for (let j = 0; j < 14; j++) { const a = (j / 14) * Math.PI * 2; fx(dim, "sansmode:killer_knife", { x: c.x + Math.cos(a) * 0.8, y: c.y + 0.3 + (j % 3) * 0.6, z: c.z + Math.sin(a) * 0.8 }); } };
  ring(o);
  snd(dim, "mob.endermen.teleport", o, 1.0, 1.3);
  safe(() => p.teleport(best, { dimension: dim, keepVelocity: false }));
  safe(() => p.addEffect("slow_falling", 20, { amplifier: 0, showParticles: false }));
  ring(best);
  snd(dim, "mob.endermen.teleport", best, 1.0, 0.9);
}
function castKillerBone(p) {
  if (!isKiller(p)) return;
  const K = KBN, t = now();
  if (t - kcd(p, "bone") < K.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < K.COST) return deny(p, "§cНе хватает стамины");
  const tgts = candidates(p.dimension, p.location, K.RANGE, p, false).slice(0, 4);
  if (!tgts.length) return deny(p, "§7Нет целей");
  killerCD.set(p.id + "bone", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_8");
  const dim = p.dimension;
  snd(dim, "mob.skeleton.hurt", p.location, 1.0, 0.6);
  for (const e of tgts) {
    const l = e.location, shared = new Set();
    { // центральная кость под самой целью: стоять на месте больше не спасает
      const y0 = groundY(dim, l.x, l.y, l.z);
      const c0 = safe(() => dim.spawnEntity("killersans:killer_bone_spike", { x: l.x, y: y0, z: l.z }));
      if (c0) spikes.push({ ent: c0, dim, x: l.x, y: y0, z: l.z, born: now(), owner: p, hit: shared, dmg: K.DMG, launch: 0.6 });
    }
    for (let i = 0; i < K.COUNT; i++) {
      const a = (i / K.COUNT) * Math.PI * 2, R = 1.4;
      const x = l.x + Math.cos(a) * R, z = l.z + Math.sin(a) * R, y = groundY(dim, x, l.y, z);
      const ent = safe(() => dim.spawnEntity("killersans:killer_bone_spike", { x, y, z }));
      if (ent) spikes.push({ ent, dim, x, y, z, born: now(), owner: p, hit: shared, dmg: K.DMG, launch: 0.6 });
    }
  }
}


// ============================================ KILLER SANS: НОЖЕВОЙ ШТОРМ ===
const KS = { COST: 16, COOLDOWN: 80, RANGE: 16, R: 7, N: 22, DMG: 6, SPEED: 1.25, LIFE: 70 };
function castKillerStorm(p) {
  if (!isKiller(p)) return;
  const t = now();
  if (t - kcd(p, "storm") < KS.COOLDOWN) return;
  if (!isTrial(p) && stamina(p) < KS.COST) return deny(p, "§cНе хватает стамины");
  const tgt = nearestTarget(p.dimension, p.location, KS.RANGE, p);
  if (!tgt) return deny(p, "§7Нет цели");
  killerCD.set(p.id + "storm", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_16");
  const dim = p.dimension, c = { x: tgt.location.x, y: tgt.location.y + 1, z: tgt.location.z };
  snd(dim, "mob.wither.ambient", p.location, 1.0, 1.1);
  const GA = Math.PI * (3 - Math.sqrt(5)); // золотой угол: ножи равномерно по сфере
  for (let i = 0; i < KS.N; i++) {
    const y = 1 - (2 * (i + 0.5)) / KS.N, r = Math.sqrt(1 - y * y), a = i * GA;
    const pos = { x: c.x + Math.cos(a) * r * KS.R, y: Math.max(c.y - 1, c.y + y * KS.R * 0.8), z: c.z + Math.sin(a) * r * KS.R };
    spawnKnife(p, pos, { x: 0, y: 0, z: 0 }, { life: KS.LIFE, dmg: KS.DMG, homing: { e: tgt, form: 8 + (i % 6) * 3, speed: KS.SPEED }, face: c });
  }
}

// ============================================ KILLER SANS: УЛЬТА ===
// 1) ножи со всех сторон 2) серые кости 3) ножи и кости из-под земли
// 4) по 5 бластеров на цель 5) ряд из 3 бластеров на цель: широкий луч достаёт и в прыжке, уйти можно только в бок
const KU = { COST: 32, COOLDOWN: 700, RADIUS: 22, MAX_TGT: 5, END: 330,
  KNIFE_DMG: 5, BONE_DMG: 5, GROUND_DMG: 6, BONE_SPEED: 1.35, BONE_DIST: 13,
  B5_N: 5, B5_R: 4.2, B5_DMG: 7, B5_LOCK: 26, B5_BEAM: 14,
  ROW_DMG: 14, ROW_DIST: 7, ROW_GAP: 2.4, ROW_LOCK: 28, ROW_BEAM: 16, ROW_HALF: 1.2, ROW_VERT: 3.0, BEAM_LEN: 30 };
const kUlts = [];      // сценарии ульты { owner, dim, start, tgts, ev: [{at, fn}] }
const kBones = [];     // летящие серые кости
const kGround = [];    // ножи, выезжающие из-под земли
const kBeams = [];     // бластеры ульты

function kUltTargets(p) {
  const l = p.location;
  return candidates(p.dimension, l, KU.RADIUS, p, false)
    .sort((a, b) => Math.hypot(a.location.x - l.x, a.location.z - l.z) - Math.hypot(b.location.x - l.x, b.location.z - l.z))
    .slice(0, KU.MAX_TGT);
}
const kTc = (e) => ({ x: e.location.x, y: e.location.y + 1, z: e.location.z });

function castKillerUlt(p) {
  if (!isKiller(p)) return;
  const t = now();
  if (t - kcd(p, "ult") < KU.COOLDOWN) return deny(p, "§7Ульта перезаряжается");
  if (!isTrial(p) && stamina(p) < KU.COST) return deny(p, "§cНе хватает стамины");
  const tgts = kUltTargets(p);
  if (!tgts.length) return deny(p, "§7Нет целей");
  killerCD.set(p.id + "ult", t);
  if (!isTrial(p)) p.triggerEvent("killer_spend_32");
  const dim = p.dimension, c = { owner: p, dim, start: t, tgts, ev: [] };
  safe(() => p.triggerEvent("ult_eyes_killer_on"));
  const at = (dt, fn) => c.ev.push({ at: t + dt, fn });
  snd(dim, "mob.wither.spawn", p.location, 1.2, 0.8);
  title({ owner: p }, "§4§lУЛЬТА");

  // фаза 1: ножи со всех сторон (три волны)
  for (const w of [0, 25, 50]) at(w, () => {
    for (const e of c.tgts) { if (!ok(e)) continue;
      for (let i = 0; i < 8; i++) {
        const a = rand(0, Math.PI * 2), r = rand(6, 9), tc = kTc(e);
        const pos = { x: tc.x + Math.cos(a) * r, y: tc.y + rand(-0.5, 5), z: tc.z + Math.sin(a) * r };
        spawnKnife(p, pos, { x: 0, y: 0, z: 0 }, { life: 60, dmg: KU.KNIFE_DMG, homing: { e, form: 4 + i * 2, speed: 1.15 }, face: tc });
      }
    }
  });
  // фаза 2: серые кости летят низом (три волны)
  for (const w of [75, 95, 115]) at(w, () => {
    for (const e of c.tgts) { if (!ok(e)) continue;
      const base = rand(0, Math.PI * 2);
      for (let i = 0; i < 6; i++) {
        const a = base + (i / 6) * Math.PI * 2, tc = kTc(e);
        const pos = { x: tc.x + Math.cos(a) * KU.BONE_DIST, y: e.location.y + 0.5, z: tc.z + Math.sin(a) * KU.BONE_DIST };
        const dir = norm({ x: tc.x - pos.x, y: 0, z: tc.z - pos.z });
        const ent = safe(() => dim.spawnEntity("killersans:killer_grey_bone", pos));
        if (!ent) continue;
        safe(() => ent.teleport(pos, { dimension: dim, facingLocation: add(pos, dir) }));
        kBones.push({ ent, dim, owner: p, pos: { ...pos }, vel: mul(dir, KU.BONE_SPEED), born: now(), life: 32, hit: new Set() });
      }
    }
  });
  // фаза 3: ножи и кости из-под земли (две волны, с предупреждением)
  for (const w of [135, 165]) at(w, () => {
    for (const e of c.tgts) { if (!ok(e)) continue;
      const l = e.location;
      for (let i = 0; i < 7; i++) {
        const a = rand(0, Math.PI * 2), r = i === 0 ? 0 : rand(0.8, 3.2);
        const x = l.x + Math.cos(a) * r, z = l.z + Math.sin(a) * r, y = groundY(dim, x, l.y, z), knife = i % 2 === 0;
        for (let k = 0; k < 3; k++) fx(dim, "sansmode:killer_knife", { x: x + rand(-0.3, 0.3), y: y + 0.1, z: z + rand(-0.3, 0.3) });
        snd(dim, "dig.stone", { x, y, z }, 0.6, 1.4);
        system.runTimeout(() => {
          if (!ok(p)) return;
          if (knife) {
            const pos = { x, y: y - 1.2, z };
            const ent = safe(() => dim.spawnEntity("killersans:killer_knife_proj", pos));
            if (!ent) return;
            safe(() => ent.teleport(pos, { dimension: dim, facingLocation: { x, y: pos.y + 5, z } }));
            kGround.push({ ent, dim, owner: p, x, z, y: pos.y, top: y + 1.3, born: now(), hit: new Set() });
          } else {
            const ent = safe(() => dim.spawnEntity("killersans:killer_bone_spike", { x, y, z }));
            if (ent) spikes.push({ ent, dim, x, y, z, born: now(), owner: p, hit: new Set(), dmg: KU.GROUND_DMG, launch: 0.6 });
          }
          snd(dim, "dig.stone", { x, y, z }, 1, 0.8);
        }, 14);
      }
    }
  });
  // фаза 4: по 5 бластеров на каждую цель
  at(195, () => {
    for (const e of c.tgts) { if (!ok(e)) continue;
      const base = rand(0, Math.PI * 2), tc = kTc(e);
      for (let i = 0; i < KU.B5_N; i++) {
        const a = base + (i / KU.B5_N) * Math.PI * 2;
        kSpawnBlaster(c, e, { x: tc.x + Math.cos(a) * KU.B5_R, y: tc.y + 1.4, z: tc.z + Math.sin(a) * KU.B5_R }, { mode: "point", lock: KU.B5_LOCK, beam: KU.B5_BEAM, dmg: KU.B5_DMG, shared: null });
      }
    }
  });
  // фаза 5: ряд из 3 бластеров на цель, широкий луч (прыжок не спасает, надо уйти в бок)
  at(262, () => {
    for (const e of c.tgts) { if (!ok(e)) continue;
      const a = rand(0, Math.PI * 2), d = { x: Math.cos(a), y: 0, z: Math.sin(a) }, perp = { x: -d.z, y: 0, z: d.x };
      const tc = kTc(e), shared = new Set();
      for (let j = -1; j <= 1; j++) {
        const off = j * KU.ROW_GAP;
        const pos = { x: tc.x + d.x * KU.ROW_DIST + perp.x * off, y: tc.y + 0.4, z: tc.z + d.z * KU.ROW_DIST + perp.z * off };
        kSpawnBlaster(c, e, pos, { mode: "row", dir: mul(d, -1), lock: KU.ROW_LOCK, beam: KU.ROW_BEAM, dmg: KU.ROW_DMG, shared });
      }
    }
  });
  kUlts.push(c);
}

function kSpawnBlaster(c, tgt, pos, o) {
  const ent = safe(() => c.dim.spawnEntity("killersans:killer_blaster", pos));
  if (!ent) return;
  const face = o.mode === "row" ? add(pos, o.dir) : kTc(tgt);
  safe(() => ent.teleport(pos, { dimension: c.dim, facingLocation: face }));
  safe(() => ent.triggerEvent("nightmaresans:charge"));
  snd(c.dim, "mob.endermen.portal", pos, 0.8, 0.6);
  const t = now();
  kBeams.push({ ent, dim: c.dim, owner: c.owner, tgt, pos, ...o, born: t, fireAt: t + o.lock, endAt: t + o.lock + o.beam, aim: o.mode === "row" ? add(pos, o.dir) : kTc(tgt), fired: false, hit: new Set() });
}

function tickKillerUlt(t) {
  // сценарии
  for (let i = kUlts.length - 1; i >= 0; i--) {
    const c = kUlts[i];
    if (!ok(c.owner) || t - c.start >= KU.END) { safe(() => c.owner.triggerEvent("ult_eyes_killer_off")); kUlts.splice(i, 1); continue; }
    for (let j = c.ev.length - 1; j >= 0; j--) if (t >= c.ev[j].at) { const f = c.ev[j].fn; c.ev.splice(j, 1); safe(f); }
  }
  // серые кости
  for (let i = kBones.length - 1; i >= 0; i--) {
    const b = kBones[i];
    if (!ok(b.ent) || !ok(b.owner) || t - b.born >= b.life) { safe(() => b.ent.remove()); kBones.splice(i, 1); continue; }
    b.pos = add(b.pos, b.vel);
    safe(() => b.ent.teleport(b.pos, { dimension: b.dim, facingLocation: add(b.pos, b.vel) }));
    for (const e of candidates(b.dim, b.pos, 2, b.owner, false)) {
      if (b.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - b.pos.x, l.z - b.pos.z) > 1.1 || b.pos.y < l.y - 0.4 || b.pos.y > l.y + 2) continue;
      b.hit.add(e.id);
      if (hurt(e, KU.BONE_DMG, b.owner, 0) >= 0) knock(e, b.vel.x, b.vel.z, 0.5, 0.15);
    }
  }
  // ножи из-под земли
  for (let i = kGround.length - 1; i >= 0; i--) {
    const g = kGround[i], age = t - g.born;
    if (!ok(g.ent) || !ok(g.owner) || age > 26) { safe(() => g.ent.remove()); kGround.splice(i, 1); continue; }
    if (age <= 10) { g.y += 0.28; safe(() => g.ent.teleport({ x: g.x, y: g.y, z: g.z }, { dimension: g.dim, facingLocation: { x: g.x, y: g.y + 5, z: g.z } })); }
    else if (age > 18) { g.y -= 0.3; safe(() => g.ent.teleport({ x: g.x, y: g.y, z: g.z }, { dimension: g.dim, facingLocation: { x: g.x, y: g.y + 5, z: g.z } })); }
    for (const e of candidates(g.dim, { x: g.x, y: g.top, z: g.z }, 2.5, g.owner, false)) {
      if (g.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - g.x, l.z - g.z) > 1.0 || l.y > g.top + 0.5 || l.y < g.top - 3) continue;
      g.hit.add(e.id);
      if (hurt(e, KU.GROUND_DMG, g.owner, 0) >= 0) knock(e, 0, 0, 0, 0.6);
    }
  }
  // бластеры ульты
  for (let i = kBeams.length - 1; i >= 0; i--) {
    const b = kBeams[i];
    if (!ok(b.ent) || !ok(b.owner) || t >= b.endAt) { safe(() => b.ent.remove()); kBeams.splice(i, 1); continue; }
    if (b.mode === "point" && !b.fired && t < b.fireAt - Math.min(10, Math.floor((b.fireAt - b.born) / 2)) && ok(b.tgt)) { b.aim = kTc(b.tgt); safe(() => b.ent.teleport(b.pos, { dimension: b.dim, facingLocation: b.aim })); }
    const axis = b.mode === "row" ? b.dir : norm(sub(b.aim, b.pos));
    if (t < b.fireAt) { // телеграф
      if (t % 2 === 0) for (let k = 2; k <= KU.BEAM_LEN; k += 4) fx(b.dim, "sansmode:killer_knife", add(b.pos, mul(axis, k)));
      continue;
    }
    if (!b.fired) { // выстрел: цель зафиксирована
      b.fired = true;
      safe(() => b.ent.teleport(b.pos, { dimension: b.dim, facingLocation: add(b.pos, axis) }));
      safe(() => b.ent.triggerEvent("nightmaresans:fire"));
      snd(b.dim, "mob.warden.sonic_boom", b.pos, 1.6, 0.8);
    }
    const end = add(b.pos, mul(axis, KU.BEAM_LEN));
    const hits = b.shared || b.hit;
    for (const e of candidates(b.dim, add(b.pos, mul(axis, KU.BEAM_LEN / 2)), KU.BEAM_LEN / 2 + 3, b.owner, false)) {
      if (hits.has(e.id)) continue;
      const l = kTc(e);
      let inside;
      if (b.mode === "row") { // широкий луч: по высоте с запасом, в бок узко
        const rel = sub(l, b.pos), along = rel.x * axis.x + rel.z * axis.z;
        const perp = Math.abs(rel.x * axis.z - rel.z * axis.x);
        inside = along >= 0 && along <= KU.BEAM_LEN && perp <= KU.ROW_HALF && Math.abs(l.y - b.pos.y) <= KU.ROW_VERT;
      } else {
        inside = segDist(l, b.pos, end) <= 1.4;
      }
      if (!inside) continue;
      hits.add(e.id);
      if (hurt(e, b.dmg, b.owner, 0) >= 0) knock(e, axis.x, axis.z, 0.7, 0.3);
    }
  }
}
world.afterEvents.itemUse.subscribe((ev) => {
  const id = ev.itemStack?.typeId, p = ev.source;
  if (id === "killersans:killer_storm") safe(() => castKillerStorm(p));
  else if (id === "killersans:killer_ult") safe(() => castKillerUlt(p));
  else if (id === "horrorsans:axe") { if (!HAS_CHARGE_API) safe(() => castHorrorAxe(p, 0)); }
  else if (id === "horrorsans:cleaver") safe(() => castHorrorCleaver(p));
  else if (id === "gasterbones:gaster_hand") safe(() => castGasterHand(p));
  else if (id === "gasterbones:grab") safe(() => castGsGrab(p));
  else if (id === "errorbones:strings") safe(() => castErrorStrings(p));
  else if (id === "errorbones:bones") safe(() => castErrorBones(p));
  else if (id === "errorbones:blasters") safe(() => castErrorBlasters(p));
  else if (id === "errorbones:teleport") safe(() => castErrorTeleport(p));
  else if (id === "errorbones:ultimate") safe(() => castErrorUltimate(p));
  else if (id === "errorbones:bonespikes") safe(() => castErrorBoneSpikes(p));
  else if (id === "errorbones:grab") safe(() => castErrorGrab(p));
  else if (id === "errorbones:chaos") safe(() => castErrorChaos(p));
  else if (id === "gasterbones:blue_orange") safe(() => castGsBO(p));
  else if (id === "gasterbones:ground_hands") safe(() => castGsGround(p));
  else if (id === "gasterbones:glitch") safe(() => castGsGlitch(p));
  else if (id === "gasterbones:hand_circle") safe(() => castGsCircle(p));
  else if (id === "gasterbones:ult") safe(() => castGsUlt(p));
  else if (id === "horrorsans:hunt") safe(() => castHunt(p));
  else if (id === "horrorsans:consume") safe(() => castConsume(p));
  else if (id === "horrorsans:spikes") safe(() => castSpikes(p));
  else if (id === "horrorsans:bone_wall") safe(() => castHorrorWall(p));
  else if (id === "horrorsans:axe_throw") safe(() => castAxeThrow(p));
});


// ====================================================== HORROR SANS: СПОСОБНОСТИ ===
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---- зарядка топора (зажать предмет)
if (HAS_CHARGE_API) {
  world.afterEvents.itemStartUse.subscribe((ev) => {
    const p = ev.source;
    if (ev.itemStack && ev.itemStack.typeId === "horrorsans:axe" && ok(p)) { const hs = horrorSt(p); hs.chargeStart = now(); hs.chargeFull = false; }
  });
  world.afterEvents.itemStopUse.subscribe((ev) => {
    const p = ev.source;
    if (!ev.itemStack || ev.itemStack.typeId !== "horrorsans:axe" || !ok(p)) return;
    const hs = horrorSt(p);
    if (hs.chargeStart < 0) return;
    const frac = Math.min(1, (now() - hs.chargeStart) / HORROR.CHARGE_MAX);
    hs.chargeStart = -1;
    safe(() => castHorrorAxe(p, frac < 0.1 ? 0 : frac));
  });
}
function tickHorrorCharge(p, t, hs) {
  if (hs.chargeStart < 0) return;
  if (!holdsItem(p, "horrorsans:axe")) { hs.chargeStart = -1; return; }
  const age = t - hs.chargeStart, frac = Math.min(1, age / HORROR.CHARGE_MAX), l = p.location;
  if (age > 6 && age % 8 === 0) fx(p.dimension, "minecraft:basic_smoke_particle", { x: l.x + rand(-0.3, 0.3), y: l.y + 1.9, z: l.z + rand(-0.3, 0.3) });
  if (frac >= 1 && !hs.chargeFull) { hs.chargeFull = true; snd(p.dimension, "random.anvil_land", l, 0.5, 0.6); for (let k = 0; k < 8; k++) fx(p.dimension, "minecraft:redstone_ore_dust_particle", { x: l.x + rand(-0.5, 0.5), y: l.y + rand(1, 2), z: l.z + rand(-0.5, 0.5) }); }
}

// ---- берсерк при беге + стамина берсерка (полоска опыта)
function showBerserk(p, hs) {
  const step = Math.min(6, Math.round((hs.berserk / HB.MAX) * 6));
  if (step === hs.barStep) return;
  hs.barStep = step;
  safe(() => { p.resetLevel(); if (step > 0) p.addExperience(step); });
}
function tickHorrorBerserk(p, t, hs) {
  const asleep = p.hasTag("sans_sleep"), exhausted = t < hs.exhaustedUntil;
  const sprinting = !asleep && !exhausted && safe(() => p.isSprinting) === true;
  if (sprinting && hs.berserk > 0) {
    hs.berserk = Math.max(0, hs.berserk - HB.DRAIN);
    hs.regenAt = t + HB.REGEN_DELAY;
    if (t % 5 === 0) { tryEffect(p, ["speed"], 12, 1); tryEffect(p, ["strength"], 12, 2); }
    if (t % 6 === 0) fx(p.dimension, "minecraft:basic_smoke_particle", { x: p.location.x, y: p.location.y + 0.2, z: p.location.z });
    if (hs.berserk <= 0) { // выдохся: тошнота, медлительность, отравление, из рта капает чёрная жижа
      hs.exhaustedUntil = t + HB.EXHAUST;
      tryEffect(p, ["nausea"], HB.EXHAUST, 0); tryEffect(p, ["slowness"], HB.EXHAUST, 1); tryEffect(p, ["poison"], 120, 0);
      snd(p.dimension, "mob.zombie.hurt", p.location, 1, 0.5);
    }
  } else if (exhausted) {
    if (t % 3 === 0) { // чёрная жижа изо рта
      const hd = p.getHeadLocation(), v = p.getViewDirection();
      fx(p.dimension, "horrorsans:ooze", { x: hd.x + v.x * 0.3, y: hd.y - 0.15, z: hd.z + v.z * 0.3 });
    }
    if (t + 1 >= hs.exhaustedUntil) hs.berserk = 15;
  } else if (t >= hs.regenAt && hs.berserk < HB.MAX) hs.berserk = Math.min(HB.MAX, hs.berserk + HB.REGEN);
  showBerserk(p, hs);
}

// ---- ОХОТА: вторая стамина (минута на поиск жертвы)
const HUNT = { RADIUS: 15, TICKS: 1200, CD: 400, LIE: 500 };
function castHunt(p) {
  const hs = horrorSt(p), t = now();
  if (hs.hunt || t < hs.huntCd) return;
  const victims = new Set();
  for (const e of candidates(p.dimension, p.location, HUNT.RADIUS, p, false)) {
    tryEffect(e, ["blindness"], HUNT.TICKS, 0); tryEffect(e, ["slowness"], HUNT.TICKS, 1); victims.add(e.id);
  }
  tryEffect(p, ["blindness"], HUNT.TICKS, 0); tryEffect(p, ["speed"], HUNT.TICKS, 1);
  hs.hunt = { start: t, victims, found: false };
  snd(p.dimension, "mob.wither.ambient", p.location, 1.4, 0.5);
}
function forceSleep(p, ticks) {
  const t = now(); let st = sleepState.get(p.id);
  if (!st) { const l = p.location; st = { x: l.x, y: l.y, z: l.z, still: 0, hp: hp(p), asleep: false, zAt: 0 }; sleepState.set(p.id, st); }
  st.asleep = true; st.zAt = 0; st.forcedUntil = t + ticks;
  p.addTag("sans_sleep");
  safe(() => p.triggerEvent("horror_sleep_skin_on"));
  snd(p.dimension, "mob.bat.takeoff", p.location, 0.6, 1.4);
}
function failHunt(p, hs, t) {
  hs.huntCd = t + HUNT.CD;
  tryEffect(p, ["slowness"], 40, 255); tryEffect(p, ["nausea"], 100, 0); tryEffect(p, ["blindness"], 100, 0);
  system.runTimeout(() => {
    if (!ok(p)) return;
    tryEffect(p, ["slowness"], HUNT.LIE, 255);
    forceSleep(p, HUNT.LIE); // падает и лежит 25 секунд
  }, 40);
}
function endHuntBar(p) { const n = Math.max(0, Math.min(36, stamina(p))); safe(() => p.runCommand("function horror_sans/" + n)); }
function tickHunt(p, t, hs) {
  const h = hs.hunt; if (!h) return;
  const left = HUNT.TICKS - (t - h.start);
  if (h.found) { // жертва найдена: охота удалась, можно видеть
    hs.hunt = null; hs.huntCd = t + HUNT.CD;
    safe(() => p.removeEffect("blindness"));
    endHuntBar(p);
    return;
  }
  if (left <= 0) { hs.hunt = null; failHunt(p, hs, t); endHuntBar(p); return; }
  if (t % 10 === 0) safe(() => p.onScreenDisplay.setActionBar(trf("sans.msg.hunt", Math.ceil(left / 20))));
}
world.afterEvents.entityHurt.subscribe((ev) => {
  const v = ev.hurtEntity; if (!v) return;
  const atk = safe(() => ev.damageSource.damagingEntity), proj = safe(() => ev.damageSource.damagingProjectile);
  const fromHorror = (e) => !!e && (safe(() => e.typeId) || "").startsWith("horrorsans:");
  for (const [id, hs] of hsMap) {
    if (!hs.hunt || !hs.hunt.victims.has(v.id)) continue;
    if ((atk && atk.id === id) || fromHorror(atk) || fromHorror(proj)) hs.hunt.found = true;
  }
});

// ---- ПОГЛОЩЕНИЕ
const CONS = { LEAP: 5, TELE: 12, EAT: 50, CD: 200, MEATLESS: ["skeleton", "stray", "bogged", "golem", "wither", "blaze", "vex", "shulker", "breeze", "creaking", "armor_stand"] };
function consumeHearts(e) { // сколько сердец стамины даёт добыча
  const id = e.typeId || "";
  if (CONS.MEATLESS.some((k) => id.includes(k))) return 0.5;
  if (isPlayerEnt(e)) return 4;
  const mx = safe(() => e.getComponent("minecraft:health").effectiveMax) ?? 20;
  return mx <= 12 ? 2 : mx <= 30 ? 4 : 6;
}
function castConsume(p) {
  const hs = horrorSt(p), t = now();
  if (hs.eating || t < hs.consumeCd) return;
  const o = p.location, dim = p.dimension;
  const list = (safe(() => dim.getEntities({ location: o, maxDistance: CONS.TELE, excludeFamilies: ["inanimate", "psans"], excludeTags: ["sans_ignore"] })) || [])
    .filter((e) => e.id !== p.id && ok(e) && (hp(e) ?? 0) > 0)
    .sort((a, b) => d3(a.location, o) - d3(b.location, o));
  if (!list.length) return deny(p, "§7Нет целей для поглощения");
  const target = list[0], el = target.location, dist = d3(o, el);
  hs.eating = true;
  const dx = el.x - o.x, dz = el.z - o.z, l = Math.hypot(dx, dz) || 1;
  if (dist <= CONS.LEAP) { // близко — прыжок
    snd(dim, "mob.zombie.attack", o, 1.2, 0.6);
    knock(p, dx / l, dz / l, Math.min(2.4, 0.6 + dist * 0.35), 0.4);
    system.runTimeout(() => beginEat(p, target), Math.min(14, 4 + Math.ceil(dist * 1.5)));
  } else { // далеко — телепортация
    for (let k = 0; k < 14; k++) fx(dim, "minecraft:basic_smoke_particle", { x: o.x + rand(-0.4, 0.4), y: o.y + rand(0, 1.8), z: o.z + rand(-0.4, 0.4) });
    snd(dim, "mob.endermen.portal", o, 1, 0.6);
    safe(() => p.teleport({ x: el.x - (dx / l) * 1.2, y: el.y, z: el.z - (dz / l) * 1.2 }, { facingLocation: { x: el.x, y: el.y + 1, z: el.z } }));
    system.runTimeout(() => beginEat(p, target), 4);
  }
}
function beginEat(p, target) {
  const hs = horrorSt(p);
  if (!ok(p) || !ok(target) || (hp(target) ?? 0) <= 0) { hs.eating = false; hs.consumeCd = now() + 40; return; }
  const dim = p.dimension, hearts = consumeHearts(target), el = target.location, o = p.location;
  if (d3(o, el) > 2.4) { const dx = el.x - o.x, dz = el.z - o.z, l = Math.hypot(dx, dz) || 1; safe(() => p.teleport({ x: el.x - (dx / l) * 1.1, y: el.y, z: el.z - (dz / l) * 1.1 }, { facingLocation: { x: el.x, y: el.y + 1, z: el.z } })); }
  tryEffect(target, ["slowness"], CONS.EAT + 10, 255); tryEffect(target, ["weakness"], CONS.EAT + 10, 255);
  tryEffect(p, ["slowness"], CONS.EAT, 255); tryEffect(p, ["resistance"], CONS.EAT + 10, 4);
  let step = 0;
  const rid = system.runInterval(() => {
    step += 2;
    if (!ok(p) || !ok(target)) { system.clearRun(rid); hs.eating = false; hs.consumeCd = now() + CONS.CD; return; }
    const l = target.location;
    for (let k = 0; k < 5; k++) fx(dim, "minecraft:redstone_ore_dust_particle", { x: l.x + rand(-0.4, 0.4), y: l.y + rand(0.2, 1.4), z: l.z + rand(-0.4, 0.4) });
    if (step % 6 === 0) snd(dim, "mob.zombie.wood", l, 0.9, rand(1.2, 1.7)); // хруст
    if (step >= CONS.EAT) { system.clearRun(rid); finishEat(p, target, hearts); }
  }, 2);
}
function finishEat(p, target, hearts) {
  const hs = horrorSt(p), dim = p.dimension;
  const l = { x: target.location.x, y: target.location.y, z: target.location.z };
  if (ok(target)) { if (isPlayerEnt(target)) hurt(target, 9999, p, 0, true); else safe(() => target.kill()); }
  safe(() => dim.spawnItem(new ItemStack("minecraft:bone", 2 + Math.floor(Math.random() * 3)), l)); // на месте остаются кости
  snd(dim, "mob.skeleton.death", l, 1, 0.7);
  const units = Math.round(hearts * 2); // 2 единицы стамины = 1 сердце
  for (let i = 0; i < units; i++) system.runTimeout(() => { if (ok(p)) safe(() => p.triggerEvent(addEvt(p))); }, i * 2);
  hs.eating = false; hs.consumeCd = now() + CONS.CD; // 10 секунд после конца поедания
}

// ---- БРОСОК ТОПОРА (летит как сюрикен, иссушение)
const thrownAxes = [];
function castAxeThrow(p) {
  const hs = horrorSt(p), t = now();
  if (t < hs.throwCd) return;
  hs.throwCd = t + HORROR.THROW_CD;
  const d = norm(p.getViewDirection()), start = add(p.getHeadLocation(), mul(d, 0.8));
  const ent = safe(() => p.dimension.spawnEntity("horrorsans:thrown_axe", start));
  if (!ent) return;
  safe(() => ent.setRotation({ x: 0, y: (-Math.atan2(d.x, d.z) * 180) / Math.PI }));
  snd(p.dimension, "random.bow", p.location, 1, 0.6);
  thrownAxes.push({ ent, dim: p.dimension, pos: start, dir: d, owner: p, born: t });
}
function tickAxes(t) {
  for (let i = thrownAxes.length - 1; i >= 0; i--) {
    const a = thrownAxes[i];
    const stop = () => { safe(() => a.ent.remove()); thrownAxes.splice(i, 1); };
    if (!ok(a.ent) || !ok(a.owner) || t - a.born > HORROR.THROW_RANGE / HORROR.THROW_SPEED + 2) { stop(); continue; }
    a.pos = add(a.pos, mul(a.dir, HORROR.THROW_SPEED));
    const b = safe(() => a.dim.getBlock({ x: Math.floor(a.pos.x), y: Math.floor(a.pos.y), z: Math.floor(a.pos.z) }));
    if (!b || !passable(b)) { snd(a.dim, "random.anvil_land", a.pos, 0.6, 1.4); fx(a.dim, "minecraft:basic_smoke_particle", a.pos); stop(); continue; }
    safe(() => a.ent.teleport(a.pos));
    const hit = candidates(a.dim, a.pos, 1.4, a.owner, false)[0];
    if (hit) {
      if (hurt(hit, HORROR.THROW_DMG, a.owner, 0, false) >= 0) {
        tryEffect(hit, ["wither"], HORROR.WITHER_TICKS, HORROR.WITHER_AMP); // иссушение вместо кровотечения
        knock(hit, a.dir.x, a.dir.z, 0.9, 0.25);
        snd(a.dim, "mob.zombie.hurt", hit.location, 1.2, 0.7);
        for (let k = 0; k < 6; k++) fx(a.dim, "minecraft:redstone_ore_dust_particle", { x: hit.location.x + rand(-0.3, 0.3), y: hit.location.y + rand(0.3, 1.5), z: hit.location.z + rand(-0.3, 0.3) });
      }
      stop();
    }
  }
}

// ---- КОСТЯНАЯ СТЕНА: ставится ПЕРЕД целями (по направлению их движения) в радиусе 10
function castHorrorWall(p) {
  const W = CFG.WALL, t = now();
  if (t < (wallCooldown.get(p.id) || 0)) return;
  const free = isTrial(p), dim = p.dimension, o = p.location;
  const targets = candidates(dim, o, 10, p, false).sort((a, b) => d3(a.location, o) - d3(b.location, o)).slice(0, 4);
  if (!targets.length) return deny(p, "§7Нет целей рядом");
  if (!free && stamina(p) < W.COST) return deny(p, "§cНе хватает стамины");
  if (!free) p.triggerEvent(sevt(p, "bone_wall_remove"));
  wallCooldown.set(p.id, t + W.COOLDOWN);
  for (const e of targets) {
    const v = safe(() => e.getVelocity()) || { x: 0, z: 0 };
    let hx = v.x, hz = v.z, sp = Math.hypot(hx, hz);
    if (sp < 0.04) { hx = o.x - e.location.x; hz = o.z - e.location.z; sp = 0; } // стоит на месте — перекрываем путь к игроку
    const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
    const dist = 2.2 + Math.min(1.5, sp * 8);                  // чем быстрее цель, тем дальше вперёд
    const cx = e.location.x + hx * dist, cz = e.location.z + hz * dist, perp = { x: -hz, z: hx };
    const half = 2.4, shared = { hit: new Set(), pushed: new Map() };
    for (let row = 0; row < W.ROWS; row++) {
      for (let u = -half; u <= half + 0.01; u += W.SPACING) {
        const x = cx + perp.x * u + hx * row * W.ROW_GAP + (row % 2 ? perp.x * W.SPACING / 2 : 0);
        const z = cz + perp.z * u + hz * row * W.ROW_GAP + (row % 2 ? perp.z * W.SPACING / 2 : 0);
        const delay = Math.floor(Math.abs(u) * 1.2);
        system.runTimeout(() => {
          if (!ok(p)) return;
          const y = groundY(dim, x, e.location.y, z);
          fx(dim, "minecraft:basic_smoke_particle", { x, y: y + 0.1, z });
          system.runTimeout(() => {
            const ent = safe(() => dim.spawnEntity(ET(p, "playersans:bone_wall_piece"), { x, y, z }));
            if (!ent) return;
            wallPieces.push({ red: false, ent, dim, x, y, z, nx: hx, nz: hz, born: now(), owner: p, shared, tall: false });
          }, W.WARN);
        }, delay);
      }
    }
    snd(dim, "dig.stone", { x: cx, y: e.location.y, z: cz }, 0.9, 0.8);
  }
}

// ---- общий тик Horror Sans
system.runInterval(() => {
  const t = now();
  for (const p of world.getAllPlayers()) {
    if (!safe(() => p.hasTag("horror_sans"))) { if (hsMap.has(p.id)) { hsMap.delete(p.id); safe(() => p.resetLevel()); } continue; }
    if (dying.has(p.id)) continue;
    const hs = horrorSt(p);
    safe(() => tickHorrorBerserk(p, t, hs));
    safe(() => tickHorrorCharge(p, t, hs));
    safe(() => tickHunt(p, t, hs));
  }
  safe(() => tickAxes(t));
}, 1);
world.afterEvents.playerLeave.subscribe((e) => { hsMap.delete(e.playerId); horrorCooldowns.delete(e.playerId); });

// ====================================================== GASTER: РУКА (прототип) ===
// Рука летит по взгляду; при попадании бьёт как обычная кость Санса (9 урона).
const GS = { HAND_DMG: 9, HAND_SPEED: 1.5, HAND_RANGE: 30, HAND_CD: 14, HAND_COST: 2 };
const gasterHands = [];
const gsCd = new Map();
function castGasterHand(p) {
  const t = now();
  if (t < (gsCd.get(p.id) || 0)) return;
  if (!isTrial(p) && stamina(p) < GS.HAND_COST) return deny(p, "§cНе хватает стамины");
  const d = norm(p.getViewDirection()), start = add(p.getHeadLocation(), mul(d, 0.8));
  const ent = safe(() => p.dimension.spawnEntity("gasterbones:hand", start));
  if (!ent) return;
  gsCd.set(p.id, t + GS.HAND_CD);
  if (!isTrial(p)) safe(() => p.triggerEvent(sevt(p, "hand")));
  safe(() => ent.setRotation({ x: 0, y: (-Math.atan2(d.x, d.z) * 180) / Math.PI }));
  snd(p.dimension, "mob.wither.shoot", p.location, 0.7, 1.3);
  gasterHands.push({ ent, dim: p.dimension, pos: start, dir: d, owner: p, born: t });
}
function tickGasterHands(t) {
  for (let i = gasterHands.length - 1; i >= 0; i--) {
    const a = gasterHands[i];
    const stop = () => { safe(() => a.ent.remove()); gasterHands.splice(i, 1); };
    if (!ok(a.ent) || !ok(a.owner) || t - a.born > GS.HAND_RANGE / GS.HAND_SPEED + 2) { stop(); continue; }
    a.pos = add(a.pos, mul(a.dir, GS.HAND_SPEED));
    const b = safe(() => a.dim.getBlock({ x: Math.floor(a.pos.x), y: Math.floor(a.pos.y), z: Math.floor(a.pos.z) }));
    if (!b || !passable(b)) { fx(a.dim, "minecraft:basic_smoke_particle", a.pos); stop(); continue; }
    safe(() => a.ent.teleport(a.pos));
    const hit = candidates(a.dim, a.pos, 1.3, a.owner, false)[0];
    if (hit) {
      if (hurt(hit, GS.HAND_DMG, a.owner, 0, false) >= 0) {
        knock(hit, a.dir.x, a.dir.z, 0.6, 0.2);
        snd(a.dim, "mob.zombie.hurt", hit.location, 1, 0.8);
      }
      stop();
    }
  }
}
system.runInterval(() => safe(() => tickGasterHands(now())), 1);


// ====================================================== GASTER: СПОСОБНОСТИ (ТЗ) ===
// Предметы gasterbones:grab / blue_orange / ground_hands / glitch / hand_circle / ult.
// Стамина тратится событиями игрока gs_c<N> (N = стоимость в единицах, 2 единицы = 1 сердце стамины).
// Все числа ниже можно менять.
const GSX = {
  GRAB:   { COST: 6,  CD: 100, RANGE: 10, SPEED: 1.6, HOLD: 46, LOCK: 18, FIRE: 30, BEAM: 10, DMG: 8, R: 6.5 },                 // захват рукой (макс. радиус 10)
  BO:     { COST: 8,  CD: 160, RANGE: 22, MAX_TARGETS: 4, PER: 3, WAVES: 2, WAVE_GAP: 78, R: 8, LOCK: 32, FIRE: 54, BEAM: 18, DMG: 8 }, // голубые/оранжевые бластеры
  GROUND: { COST: 8,  CD: 120, RADIUS: 15, MAX_TARGETS: 16, WARN: 16, WAVES: 2, WAVE_GAP: 36, DMG: 6, HIT_R: 1.2, LIFE: 24 },       // руки из-под земли
  GLITCH: { COST: 10, CD: 200, RADIUS: 15, TELEPORTS: 3, GAP: 20, DMG: 5, MIN_R: 3, MAX_R: 15 },                                    // глюк (урон 5 = 2,5 сердца за каждую телепортацию)
  CIRCLE: { COST: 12, CD: 240, RANGE: 26, HANDS: 12, R: 3.2, SPIN: 100, SPEED: 1.1, DMG: 6, LIFE: 90 },                            // круговорот рук (5 секунд кружатся)
  ULT:    { COST: 30, CD: 800, RADIUS: 25, MAX_TARGETS: 6,
            T_TELE: 6,           // тик телепорта всех целей (без урона)
            HOLD: 38,            // сколько руки держат цель (бластеры 2 шт. стреляют по ней)
            GROUND_DELAY: 40,    // 2 секунды после отпускания -> руки из земли
            WARN: 14, GROUND_DMG: 6,
            CROSS_START: 30, CROSS_GAP: 46, CROSS_VOLLEYS: 3,
            BEAM_DMG: 6,
            GLYPHS: 4, GLYPH_DMG: 3 },                         // символы Wingdings: 3 урона = 1,5 сердца каждый
};
const gsCdMap = new Map();
let gsSeq = 0;
const gsTitle = (p, text) => safe(() => p.runCommand(tt(text)));
const yawTo = (from, to) => (-Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
function gsReady(p, key) {
  if (!isGaster(p)) return false;
  if (now() < (gsCdMap.get(p.id + key) || 0)) { deny(p, "§7Перезарядка"); return false; }
  return true;
}
const gsSetCd = (p, key, ticks) => gsCdMap.set(p.id + key, now() + ticks);
function gsPay(p, cost) {
  if (isTrial(p)) return true;
  if (stamina(p) < cost) { deny(p, "§cНе хватает стамины"); return false; }
  safe(() => p.triggerEvent("gs_c" + cost));
  return true;
}
function gsTargets(p, radius, max) {
  const o = p.location;
  return candidates(p.dimension, o, radius, p, true).sort((a, b) => len(sub(a.location, o)) - len(sub(b.location, o))).slice(0, max);
}
const gsCtx = (owner, fixed) => ({ owner, dim: owner.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed, quiet: true, done: false, timeline: [] });
const gsRun = (c, tag) => ults.set("gs:" + tag + ":" + now() + ":" + (gsSeq++), c);
function gsHandEnt(dim, pos, yaw) {
  const e = safe(() => dim.spawnEntity("gasterbones:hand_big", pos));
  if (e) safe(() => e.setRotation({ x: 0, y: yaw }));
  return e;
}
// Случайная точка на земле вокруг c (кольцо rmin..rmax), куда можно встать
function gsRandSpot(dim, c, rmin, rmax) {
  for (let i = 0; i < 16; i++) {
    const a = rand(0, Math.PI * 2), r = rand(rmin, rmax), x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    const y = groundY(dim, x, c.y, z), bx = Math.floor(x), bz = Math.floor(z), by = Math.floor(y);
    const b0 = safe(() => dim.getBlock({ x: bx, y: by, z: bz })), b1 = safe(() => dim.getBlock({ x: bx, y: by + 1, z: bz })), bg = safe(() => dim.getBlock({ x: bx, y: by - 1, z: bz }));
    if (b0 && b1 && bg && passable(b0) && passable(b1) && !passable(bg)) return { x, y, z };
  }
  return null;
}

// ---- Бластеры Гастера: голубой / оранжевый в момент прицеливания
// Гастер стоит на месте -> голубой (бьёт только того, кто ДВИЖЕТСЯ); Гастер идёт -> оранжевый (бьёт только того, кто СТОИТ).
function gsRecolorBlaster(c, b, aim) {
  const kind = isMoving(c.owner) ? "orange" : "blue";
  const ent = safe(() => c.dim.spawnEntity(kind === "orange" ? "gasterbones:orange_blaster" : "gasterbones:blue_blaster", b.pos));
  if (!ent) return;
  safe(() => b.ent.remove());
  b.ent = ent; b.kind = kind;
  safe(() => ent.teleport(b.pos, { facingLocation: aim }));
  snd(c.dim, "beacon.activate", b.pos, 1, kind === "orange" ? 1.7 : 1.2);
}

// ---- «Удержание»: цель не может двинуться, пока её держит рука
const gsHolds = [];
function gsHold(tgt, ticks, hand) {
  const l = tgt.location;
  gsHolds.push({ tgt, dim: tgt.dimension, pos: { x: l.x, y: l.y, z: l.z }, until: now() + ticks, hand });
}
function tickGsHolds(t) {
  for (let i = gsHolds.length - 1; i >= 0; i--) {
    const h = gsHolds[i];
    if (!ok(h.tgt) || (hp(h.tgt) ?? 0) <= 0 || t >= h.until) { safe(() => h.hand && h.hand.remove()); gsHolds.splice(i, 1); continue; }
    safe(() => h.tgt.teleport(h.pos, { dimension: h.dim, keepVelocity: false }));
    if (h.hand && ok(h.hand)) safe(() => h.hand.teleport({ x: h.pos.x, y: h.pos.y + 1.1, z: h.pos.z }));
  }
}

// ======================= 1. ЗАХВАТ РУКОЙ ========================
// Вылетает рука, хватает ближайшую цель (до 10 блоков); по бокам от цели выстреливают бластеры Гастера.
const gsGrabs = [];
function castGsGrab(p) {
  const G = GSX.GRAB;
  if (!gsReady(p, "grab")) return;
  const tg = gsTargets(p, G.RANGE, 1)[0];
  if (!tg) return deny(p, trf("sans.msg.no_targets_range", G.RANGE));
  if (!gsPay(p, G.COST)) return;
  gsSetCd(p, "grab", G.CD);
  const dim = p.dimension, start = add(p.getHeadLocation(), mul(norm(p.getViewDirection()), 0.8));
  const hand = gsHandEnt(dim, start, yawTo(start, tg.location));
  if (!hand) return;
  snd(dim, "mob.wither.shoot", p.location, 0.8, 1.2);
  gsGrabs.push({ owner: p, tgt: tg, dim, hand, pos: start, born: now() });
}
function gsSideBlasters(owner, tgt) {
  const G = GSX.GRAB, c = gsCtx(owner, [tgt]), o = owner.location, tl = tgt.location, a0 = Math.atan2(tl.z - o.z, tl.x - o.x);
  c.timeline = [
    [0, (cc) => {
      const t = now();
      [-1, 1].forEach((sd, k) => addBlaster(cc, { target: tgt, ang: a0 + sd * Math.PI / 2, r: G.R, h: 1.0, spin: 0, spawnAt: t, lockAt: t + G.LOCK, fireAt: t + G.FIRE, beamTicks: G.BEAM, dmg: G.DMG, floor: CFG.ULT.BEAM_FLOOR, ik: "g" + k }));
    }],
    [G.FIRE + G.BEAM + 4, (cc) => { cc.finishing = true; }],
  ];
  gsRun(c, "grab");
}
function tickGsGrabs(t) {
  for (let i = gsGrabs.length - 1; i >= 0; i--) {
    const g = gsGrabs[i];
    if (!ok(g.owner) || !ok(g.hand) || !ok(g.tgt) || t - g.born > 40) { safe(() => g.hand.remove()); gsGrabs.splice(i, 1); continue; }
    const aim = center(g.tgt), d = sub(aim, g.pos);
    if (len(d) <= GSX.GRAB.SPEED + 0.6) { // схватила: держит цель, бластеры по бокам
      gsGrabs.splice(i, 1);
      gsHold(g.tgt, GSX.GRAB.HOLD, g.hand);
      snd(g.dim, "mob.irongolem.throw", aim, 1, 0.7);
      fx(g.dim, "sansmode:gaster_glitch", aim);
      gsSideBlasters(g.owner, g.tgt);
      continue;
    }
    g.pos = add(g.pos, mul(norm(d), GSX.GRAB.SPEED));
    safe(() => g.hand.teleport(g.pos));
    safe(() => g.hand.setRotation({ x: 0, y: yawTo(g.pos, aim) }));
  }
}


// ======================= ERROR: СИНИЕ НИТИ (захват / притягивание / обездвиживание) ========================
const ERR_STR = { COST: 8, RANGE: 12, CD: 60, PULL_SPEED: 0.7, CATCH_DIST: 2.2, HOLD: 60, LIFE: 120, LINE_PTS: 7 };
const errCdMap = new Map();
const errStrings = [];
function errStringFx(dim, a, b) {
  for (let i = 0; i <= ERR_STR.LINE_PTS; i++) {
    const k = i / ERR_STR.LINE_PTS;
    fx(dim, "sansmode:error_string", { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k + 0.6, z: a.z + (b.z - a.z) * k });
  }
}
function castErrorStrings(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  const t = now();
  if (t < (errCdMap.get(p.id) || 0)) return deny(p, "§7Перезарядка");
  const tg = gsTargets(p, ERR_STR.RANGE, 1)[0];
  if (!tg) return deny(p, trf("sans.msg.no_targets_range", ERR_STR.RANGE));
  const cost = CFG.TELE.COST;
  if (stamina(p) < cost) return deny(p, "§cНе хватает стамины");
  safe(() => p.triggerEvent("telekinesis_remove")); // та же плата, что у телекинеза
  errCdMap.set(p.id, t + ERR_STR.CD);
  snd(p.dimension, "mob.wither.shoot", p.location, 0.7, 1.4);
  errStrings.push({ owner: p, tgt: tg, dim: p.dimension, born: t, phase: "pull", until: 0 });
}
function tickErrStrings(t) {
  for (let i = errStrings.length - 1; i >= 0; i--) {
    const s = errStrings[i];
    if (!ok(s.owner) || !ok(s.tgt) || (hp(s.tgt) ?? 0) <= 0) { errStrings.splice(i, 1); continue; }
    const o = center(s.owner);
    if (s.phase === "pull") {
      if (t - s.born > ERR_STR.LIFE) { errStrings.splice(i, 1); continue; }
      const aim = center(s.tgt), d = sub(o, aim);
      if (len(d) <= ERR_STR.CATCH_DIST) { // поймали: держим на месте и продолжаем рисовать нити
        s.phase = "hold"; s.until = t + ERR_STR.HOLD;
        snd(s.dim, "mob.irongolem.throw", aim, 0.8, 1.2);
        gsHold(s.tgt, ERR_STR.HOLD, null);
        continue;
      }
      const step = mul(norm(d), Math.min(ERR_STR.PULL_SPEED, len(d)));
      const np = add(aim, step);
      safe(() => s.tgt.teleport(np, { dimension: s.dim, keepVelocity: false }));
      errStringFx(s.dim, o, np);
    } else {
      if (t >= s.until) { errStrings.splice(i, 1); continue; }
      errStringFx(s.dim, o, center(s.tgt));
    }
  }
}


// ======================= ERROR: КОСТИ, БЛАСТЕРЫ, ГЛИТЧ-ТЕЛЕПОРТ, УЛЬТА ========================
const ERR_BONE = { COST: 1, CD: 50, SIDES: 3 };
const ERR_BO = { COST: 1, CD: 140, LOCK: 22, FIRE: 42, BEAM: 24, R: 7.5, H: 1.0 };
const ERR_TP = { COST: 1, CD: 70, DIST: 9 };
const errCd = new Map(); // общий кулдаун-менеджер для костей/бластеров/телепорта Error
function errReady(p, key, cd) {
  const k = key + ":" + p.id, t = now();
  if (t < (errCd.get(k) || 0)) return false;
  errCd.set(k, t + cd);
  return true;
}

function castErrorBones(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "bone", ERR_BONE.CD)) return deny(p, "§7Перезарядка");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели");
  if (!isTrial(p)) {
    if (stamina(p) < ERR_BONE.COST) return deny(p, "§cНе хватает стамины");
    p.triggerEvent("error_bone_pay");
  }
  snd(p.dimension, "mob.wither.shoot", p.location, 0.8, 1.3);
  const a0 = rand(0, Math.PI * 2);
  const angs = Array.from({ length: ERR_BONE.SIDES }, (_, i) => a0 + (i * Math.PI * 2) / ERR_BONE.SIDES);
  flyCross(p, target, angs, FLY.FIRST, false); // кости летят с нескольких направлений одновременно
}

function castErrorBlasters(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "bo", ERR_BO.CD)) return deny(p, "§7Перезарядка");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели");
  if (!isTrial(p)) {
    if (stamina(p) < ERR_BO.COST) return deny(p, "§cНе хватает стамины");
    p.triggerEvent("error_gb_pay");
  }
  const o = p.location, tl = target.location, a0 = Math.atan2(tl.z - o.z, tl.x - o.x);
  const c = { owner: p, dim: p.dimension, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [target], quiet: true, done: false };
  title(c, "§l§9[ ERROR ]");
  const t = now();
  for (const d of [-0.6, 0, 0.6]) // три бластера одновременно, веером вокруг цели
    addBlaster(c, { target, ang: a0 + d, r: ERR_BO.R, h: ERR_BO.H, spin: 0, spawnAt: t, lockAt: t + ERR_BO.LOCK, fireAt: t + ERR_BO.FIRE, beamTicks: ERR_BO.BEAM, dmg: CFG.ULT.BEAM_DAMAGE, floor: CFG.ULT.BEAM_DAMAGE });
  c.timeline = [[ERR_BO.FIRE + ERR_BO.BEAM + 4, (cc) => { cc.finishing = true; }]];
  ults.set("errbo:" + p.id, c);
}

function castErrorTeleport(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "tp", ERR_TP.CD)) return deny(p, "§7Перезарядка");
  if (!isTrial(p)) {
    if (stamina(p) < ERR_TP.COST) return deny(p, "§cНе хватает стамины");
    p.triggerEvent("error_control_pay");
  }
  const dim = p.dimension, from = { ...p.location };
  const v = safe(() => p.getViewDirection()) || { x: 0, y: 0, z: 1 };
  const to = { x: from.x + v.x * ERR_TP.DIST, y: from.y + v.y * ERR_TP.DIST, z: from.z + v.z * ERR_TP.DIST };
  snd(dim, "mob.endermen.portal", from, 1.2, 0.6);
  for (let k = 0; k < 6; k++) { fx(dim, "sansmode:gaster_glitch", from); fx(dim, "sansmode:error_glitch_tp", from); }
  safe(() => p.teleport(to, { dimension: dim, keepVelocity: false }));
  for (let k = 0; k < 6; k++) { fx(dim, "sansmode:gaster_glitch", to); fx(dim, "sansmode:error_glitch_tp", to); }
  snd(dim, "mob.endermen.portal", to, 1.2, 1.3);
}

// Ульта Error: нити вокруг цели + несколько бластеров + нарастающий глитч -> финальный совместный удар.
// Полностью переиспользует проверенный движок обычной ультимативной атаки (castUltimate): прицел, урон,
// стоимость стамины и фазы бьёт он сам; здесь только фирменный глитч-пролог Error поверх него.
function castErrorUltimate(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (ults.has(p.id)) return;
  const tgts = findTargets(p);
  if (!tgts.length) return deny(p, "§7Поблизости нет целей");
  const dim = p.dimension, o = p.location;
  title({ owner: p }, "§l§5[ ERROR: СБОЙ ]");
  snd(dim, "mob.wither.spawn", o, 1.1, 0.7);
  for (const tg of tgts) errStringFx(dim, center(p), center(tg)); // нити вспыхивают вокруг всех целей
  let k = 0;
  for (const tg of tgts) system.runTimeout(() => { // нарастающий глитч на каждой цели
    if (!ok(tg)) return;
    for (let j = 0; j < 4; j++) fx(dim, "sansmode:gaster_glitch", center(tg));
  }, 10 + k++ * 6);
  system.runTimeout(() => safe(() => castUltimate(p)), 24); // совместный удар костей и бластеров
}


// ======================= ERROR: ШИПЫ, ДВОЙНОЙ ЗАХВАТ НИТЯМИ, ХАОС-ВОЛНЫ ========================
const ERR_SPIKES_CD = 70;
const ERR_GRAB = { COST: 1, CD: 160, HOLD: 40, DMG: 1, DMG_EVERY: 10, RELEASE_DELAY: 20, BO_R: 6, BO_H: 1.2, BO_LOCK: 16, BO_FIRE: 30, BO_BEAM: 20 };
const ERR_CHAOS = { COST: 1, CD: 400, RADIUS: 30, WAVES: [2, 3, 4], WAVE_GAP: 30, BO_R: 7, BO_H: 1.2, BO_LOCK: 18, BO_FIRE: 34, BO_BEAM: 22, GLITCH_TICKS: 60, GLITCH_STEP: 6 };
const errGrabs = [];

function castErrorBoneSpikes(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "spikes", ERR_SPIKES_CD)) return deny(p, "§7Перезарядка");
  castSpikes(p); // переиспользуем проверенную механику шипов (своя чёрно-красная кость уже подключена через ET())
}

function errSideBlasters(dim, owner, centre, count, R, H, LOCK, FIRE, BEAM) {
  const c = { owner, dim, start: now(), next: 0, bones: [], blasters: [], iframe: new Map(), cands: [], candsAt: -99, fixed: [], quiet: true, done: false };
  const t = now(), a0 = rand(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const ang = a0 + (i * Math.PI * 2) / count;
    addBlaster(c, { target: { location: centre, isValid: () => true, dimension: dim }, ang, r: R, h: H, spin: 0, spawnAt: t, lockAt: t + LOCK, fireAt: t + FIRE, beamTicks: BEAM, dmg: CFG.ULT.BEAM_DAMAGE, floor: CFG.ULT.BEAM_DAMAGE });
  }
  c.timeline = [[FIRE + BEAM + 4, (cc) => { cc.finishing = true; }]];
  ults.set("errbo:" + owner.id + ":" + t + ":" + Math.random(), c);
}

function castErrorGrab(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "grab", ERR_GRAB.CD)) return deny(p, "§7Перезарядка");
  const target = comboTarget(p);
  if (!target) return deny(p, "§7Нет цели");
  if (!isTrial(p)) {
    if (stamina(p) < ERR_GRAB.COST) return deny(p, "§cНе хватает стамины");
    p.triggerEvent("error_control_pay");
  }
  snd(p.dimension, "mob.irongolem.throw", target.location, 0.9, 1.1);
  gsHold(target, ERR_GRAB.HOLD, null); // держим цель за "руки/лапы" с двух сторон, она не может двигаться
  errGrabs.push({ owner: p, tgt: target, dim: p.dimension, start: now(), until: now() + ERR_GRAB.HOLD, lastHit: now() });
}

function tickErrGrabs(t) {
  for (let i = errGrabs.length - 1; i >= 0; i--) {
    const g = errGrabs[i];
    if (!ok(g.owner) || !ok(g.tgt) || (hp(g.tgt) ?? 0) <= 0) { errGrabs.splice(i, 1); continue; }
    const c = center(g.tgt);
    errStringFx(g.dim, add(c, { x: -0.6, y: 0.1, z: 0 }), c); // нить к левой "руке"
    errStringFx(g.dim, add(c, { x: 0.6, y: 0.1, z: 0 }), c);  // нить к правой "руке"
    if (t - g.lastHit >= ERR_GRAB.DMG_EVERY) { g.lastHit = t; hurt(g.tgt, ERR_GRAB.DMG, g.owner, 0, false, 0); }
    if (t >= g.until) {
      errGrabs.splice(i, 1);
      const dim = g.dim, pos = { ...c }, owner = g.owner;
      system.runTimeout(() => { // через секунду после отпускания — 4 бластера по бокам
        if (!ok(owner)) return;
        errSideBlasters(dim, owner, pos, 4, ERR_GRAB.BO_R, ERR_GRAB.BO_H, ERR_GRAB.BO_LOCK, ERR_GRAB.BO_FIRE, ERR_GRAB.BO_BEAM);
      }, ERR_GRAB.RELEASE_DELAY);
    }
  }
}

function castErrorChaos(p) {
  if (!safe(() => p.hasTag("error_sans"))) return;
  if (!errReady(p, "chaos", ERR_CHAOS.CD)) return deny(p, "§7Перезарядка");
  const dim = p.dimension, o = p.location;
  const tgts = candidates(dim, o, ERR_CHAOS.RADIUS, p, true);
  if (!tgts.length) return deny(p, "§7Поблизости нет целей");
  if (!isTrial(p)) {
    if (stamina(p) < ERR_CHAOS.COST) return deny(p, "§cНе хватает стамины");
    p.triggerEvent("error_bone_pay");
  }
  title({ owner: p }, "§l§5[ ОШИБКА РЕАЛЬНОСТИ ]");
  snd(dim, "mob.wither.spawn", o, 1.2, 0.6);
  // "ломаем" текстуры целей: плотный чёрно-фиолетовый глитч на каждой цели несколько секунд
  for (let step = 0; step <= ERR_CHAOS.GLITCH_TICKS; step += ERR_CHAOS.GLITCH_STEP) {
    system.runTimeout(() => {
      for (const tg of tgts) {
        if (!ok(tg)) continue;
        const c = center(tg);
        for (let k = 0; k < 3; k++) { fx(dim, "sansmode:gaster_glitch", c); fx(dim, "sansmode:error_glitch_tp", c); }
      }
    }, step);
  }
  // случайная точка в радиусе + 3 волны бластеров (2 -> 3 -> 4)
  const ang = rand(0, Math.PI * 2), dist = rand(4, ERR_CHAOS.RADIUS * 0.7);
  const point = { x: o.x + Math.cos(ang) * dist, y: o.y, z: o.z + Math.sin(ang) * dist };
  ERR_CHAOS.WAVES.forEach((count, idx) => {
    system.runTimeout(() => {
      if (!ok(p)) return;
      for (let k = 0; k < 3; k++) fx(dim, "sansmode:gaster_glitch", point);
      errSideBlasters(dim, p, point, count, ERR_CHAOS.BO_R, ERR_CHAOS.BO_H, ERR_CHAOS.BO_LOCK, ERR_CHAOS.BO_FIRE, ERR_CHAOS.BO_BEAM);
    }, idx * ERR_CHAOS.WAVE_GAP);
  });
}

// ======================= 2. ГОЛУБЫЕ И ОРАНЖЕВЫЕ БЛАСТЕРЫ ========================
function castGsBO(p) {
  const B = GSX.BO;
  if (!gsReady(p, "bo")) return;
  const tgs = gsTargets(p, B.RANGE, B.MAX_TARGETS);
  if (!tgs.length) return deny(p, "§7Поблизости нет целей");
  if (!gsPay(p, B.COST)) return;
  gsSetCd(p, "bo", B.CD);
  safe(() => p.sendMessage(tx("§7Бластеры в момент прицеливания: стоишь — §bголубые§7, идёшь — §6оранжевые")));
  const c = gsCtx(p, tgs);
  for (let w = 0; w < B.WAVES; w++) {
    c.timeline.push([w * B.WAVE_GAP, (cc) => {
      gsTitle(cc.owner, w ? "§l§6[ Бластеры ]" : "§l§b[ Бластеры ]");
      const t = now(), base = rand(0, Math.PI * 2);
      volley(cc, Array.from({ length: B.PER }, (_, k) => ({ ang: base + (k * Math.PI * 2) / B.PER, r: B.R, h: 0.8 + (k % 2) * 0.7, spin: w % 2 ? -0.012 : 0.012, spawnAt: t, lockAt: t + B.LOCK, fireAt: t + B.FIRE, beamTicks: B.BEAM, dmg: B.DMG, floor: CFG.ULT.BEAM_FLOOR, recolor: true, ik: "w" + w + "k" + k })));
    }]);
  }
  c.timeline.push([B.WAVES * B.WAVE_GAP, (cc) => { cc.finishing = true; }]);
  gsRun(c, "bo");
}

// ======================= 3. РУКИ ИЗ-ПОД ЗЕМЛИ ========================
const gsGround = [];
function gsGroundHandAt(owner, dim, spot, dmg, floor, warn) {
  const gy = groundY(dim, spot.x, spot.y, spot.z);
  for (let k = 0; k < warn; k += 3) system.runTimeout(() => { // предупреждение: кольцо символов на земле
    for (let j = 0; j < 6; j++) { const a = (j * Math.PI) / 3 + k * 0.12; fx(dim, "sansmode:gaster_glyph", { x: spot.x + Math.cos(a) * 0.9, y: gy + 0.15, z: spot.z + Math.sin(a) * 0.9 }); }
  }, k);
  system.runTimeout(() => {
    if (!ok(owner)) return;
    const yaw = yawTo(spot, owner.location), ents = [0, 90].map((off) => gsHandEnt(dim, { x: spot.x, y: gy - 2.3, z: spot.z }, yaw + off)).filter(Boolean);
    if (!ents.length) return;
    snd(dim, "dig.gravel", { x: spot.x, y: gy, z: spot.z }, 1.2, 0.6);
    gsGround.push({ owner, dim, x: spot.x, z: spot.z, gy, ents, born: now(), dmg, floor, hit: new Set() });
  }, warn);
}
function castGsGround(p) {
  const G = GSX.GROUND;
  if (!gsReady(p, "ground")) return;
  if (!gsTargets(p, G.RADIUS, 1).length) return deny(p, "§7Поблизости нет целей");
  if (!gsPay(p, G.COST)) return;
  gsSetCd(p, "ground", G.CD);
  gsTitle(p, "§l§6[ Руки ]");
  for (let w = 0; w < G.WAVES; w++) system.runTimeout(() => {
    if (!ok(p)) return;
    for (const e of gsTargets(p, G.RADIUS, G.MAX_TARGETS)) gsGroundHandAt(p, p.dimension, e.location, G.DMG, 0, G.WARN);
  }, w * G.WAVE_GAP);
}
function tickGsGround(t) {
  const G = GSX.GROUND, RISE = 6, SINK = 6;
  for (let i = gsGround.length - 1; i >= 0; i--) {
    const g = gsGround[i], age = t - g.born;
    if (!ok(g.owner) || age > G.LIFE) { g.ents.forEach((e) => safe(() => e.remove())); gsGround.splice(i, 1); continue; }
    const k = age < RISE ? age / RISE : age > G.LIFE - SINK ? (G.LIFE - age) / SINK : 1;
    const y = g.gy - 2.3 + 2.2 * k;
    for (const e of g.ents) safe(() => e.teleport({ x: g.x, y, z: g.z }));
    if (age < 2 || age > 9) continue;
    for (const e of candidates(g.dim, { x: g.x, y: g.gy, z: g.z }, 2.6, g.owner, true)) {
      if (g.hit.has(e.id)) continue;
      const l = e.location;
      if (Math.hypot(l.x - g.x, l.z - g.z) > G.HIT_R || l.y > g.gy + 2.2 || l.y < g.gy - 1.5) continue;
      g.hit.add(e.id);
      if (hurt(e, g.dmg, g.owner, g.floor, false) >= 0) { knock(e, 0, 0, 0, 0.55); fx(g.dim, "sansmode:gaster_glitch", center(e)); snd(g.dim, "mob.zombie.hurt", l, 1, 0.7); }
    }
  }
}

// ======================= 4. ГЛЮК ========================
// Все существа в радиусе 15 (кроме самого Гастера) 3 раза телепортируются в случайные места, каждая телепортация — 5 урона.
function castGsGlitch(p) {
  const G = GSX.GLITCH;
  if (!gsReady(p, "glitch")) return;
  const vic = candidates(p.dimension, p.location, G.RADIUS, p, false).slice(0, 40);
  if (!vic.length) return deny(p, "§7Поблизости никого нет");
  if (!gsPay(p, G.COST)) return;
  gsSetCd(p, "glitch", G.CD);
  gsTitle(p, "§l§5[ ГЛЮК ]");
  const dim = p.dimension, home = { ...p.location };
  snd(dim, "mob.endermen.portal", home, 1.3, 0.5);
  for (let k = 0; k < G.TELEPORTS; k++) system.runTimeout(() => {
    for (const e of vic) {
      if (!ok(e) || (hp(e) ?? 0) <= 0 || e.dimension !== dim) continue;
      fx(dim, "sansmode:gaster_glitch", center(e));
      const spot = gsRandSpot(dim, home, G.MIN_R, G.MAX_R);
      if (spot) { safe(() => e.teleport(spot, { dimension: dim, keepVelocity: false })); fx(dim, "sansmode:gaster_glitch", { x: spot.x, y: spot.y + 0.9, z: spot.z }); }
      hurt(e, G.DMG, p, 0, true);
    }
    snd(dim, "mob.endermen.portal", home, 1, 0.6 + k * 0.2);
  }, k * G.GAP);
}

// ======================= 5. КРУГОВОРОТ РУК ========================
// Вокруг Гастера вертится куча рук, через 5 секунд они летят в цели.
const gsCircles = [];
function castGsCircle(p) {
  const C = GSX.CIRCLE;
  if (!gsReady(p, "circle")) return;
  if (!gsPay(p, C.COST)) return;
  gsSetCd(p, "circle", C.CD);
  gsTitle(p, "§l§e[ Круговорот ]");
  const hands = [];
  for (let i = 0; i < C.HANDS; i++) {
    const ent = gsHandEnt(p.dimension, p.location, 0);
    if (ent) hands.push({ ent, a: (i / C.HANDS) * Math.PI * 2, ring: i % 2, state: "spin", launchAt: 0, pos: null, dir: null, tgt: null });
  }
  if (!hands.length) return;
  snd(p.dimension, "mob.wither.spawn", p.location, 0.8, 1.6);
  gsCircles.push({ owner: p, dim: p.dimension, hands, born: now(), launched: false });
}
function tickGsCircles(t) {
  const C = GSX.CIRCLE;
  for (let i = gsCircles.length - 1; i >= 0; i--) {
    const cs = gsCircles[i], age = t - cs.born;
    const dead = !ok(cs.owner) || cs.owner.dimension !== cs.dim || (hp(cs.owner) ?? 1) <= 0;
    if (dead || cs.hands.every((h) => h.state === "done")) { cs.hands.forEach((h) => safe(() => h.ent.remove())); gsCircles.splice(i, 1); continue; }
    const o = cs.owner.location;
    if (age >= C.SPIN && !cs.launched) { // залп: каждая рука выбирает цель
      cs.launched = true;
      const tgs = candidates(cs.dim, o, C.RANGE, cs.owner, true).sort((a, b) => len(sub(a.location, o)) - len(sub(b.location, o)));
      const vd = norm(cs.owner.getViewDirection());
      cs.hands.forEach((h, k) => {
        h.tgt = tgs.length ? tgs[k % tgs.length] : null;
        h.launchAt = t + k * 2;
        h.dir = norm(add(vd, { x: rand(-0.2, 0.2), y: rand(-0.1, 0.1), z: rand(-0.2, 0.2) }));
      });
      snd(cs.dim, "mob.wither.shoot", o, 1.2, 1.2);
    }
    for (const h of cs.hands) {
      if (h.state === "done" || !ok(h.ent)) { h.state = "done"; continue; }
      if (h.state === "spin" && (!cs.launched || t < h.launchAt)) { // кружимся вокруг Гастера (раскручиваемся к залпу)
        h.a += 0.1 + 0.07 * Math.min(1, age / C.SPIN);
        const r = C.R + h.ring * 1.3, pos = { x: o.x + Math.cos(h.a) * r, y: o.y + 1.0 + h.ring * 0.8 + Math.sin(h.a * 2) * 0.3, z: o.z + Math.sin(h.a) * r };
        h.pos = pos;
        safe(() => h.ent.teleport(pos));
        safe(() => h.ent.setRotation({ x: 0, y: yawTo(pos, o) }));
        continue;
      }
      h.state = "fly";
      const aim = h.tgt && ok(h.tgt) && (hp(h.tgt) ?? 0) > 0 ? center(h.tgt) : null;
      if (aim) h.dir = norm(sub(aim, h.pos));
      h.pos = add(h.pos, mul(h.dir, C.SPEED));
      const b = safe(() => cs.dim.getBlock({ x: Math.floor(h.pos.x), y: Math.floor(h.pos.y), z: Math.floor(h.pos.z) }));
      if (!b || !passable(b) || t - h.launchAt > C.LIFE) { fx(cs.dim, "minecraft:basic_smoke_particle", h.pos); safe(() => h.ent.remove()); h.state = "done"; continue; }
      safe(() => h.ent.teleport(h.pos));
      safe(() => h.ent.setRotation({ x: 0, y: yawTo({ x: 0, z: 0 }, h.dir) }));
      const hit = candidates(cs.dim, h.pos, 1.8, cs.owner, true).find((e) => len(sub(center(e), h.pos)) <= 1.4);
      if (hit) {
        if (hurt(hit, C.DMG, cs.owner, 0, false) >= 0) { knock(hit, h.dir.x, h.dir.z, 0.6, 0.25); snd(cs.dim, "mob.zombie.hurt", hit.location, 1, 0.8); fx(cs.dim, "sansmode:gaster_glitch", center(hit)); }
        safe(() => h.ent.remove()); h.state = "done";
      }
    }
  }
}

// ---- Символы Wingdings летят в цель (Ульта, финал)
const gsGlyphs = [];
function gsGlyphVolley(owner, targets) {
  const U = GSX.ULT, dim = owner.dimension, t = now();
  for (const tgt of targets) for (let k = 0; k < U.GLYPHS; k++) {
    const l = tgt.location, a = rand(0, Math.PI * 2), r = rand(8, 11);
    gsGlyphs.push({ owner, dim, tgt, pos: { x: l.x + Math.cos(a) * r, y: l.y + rand(0.8, 5), z: l.z + Math.sin(a) * r }, launchAt: t + 10 + k * 7 + Math.floor(rand(0, 4)), born: t });
  }
  snd(dim, "mob.endermen.portal", owner.location, 1, 0.4);
}
function tickGsGlyphs(t) {
  for (let i = gsGlyphs.length - 1; i >= 0; i--) {
    const g = gsGlyphs[i];
    if (!ok(g.owner) || !ok(g.tgt) || (hp(g.tgt) ?? 0) <= 0 || t - g.born > 120) { gsGlyphs.splice(i, 1); continue; }
    if (t < g.launchAt) { fx(g.dim, "sansmode:gaster_glyph", { x: g.pos.x + rand(-0.08, 0.08), y: g.pos.y + rand(-0.08, 0.08), z: g.pos.z }); continue; } // зависают и мерцают
    const aim = center(g.tgt), d = sub(aim, g.pos);
    if (len(d) <= 1.1) {
      if (hurt(g.tgt, GSX.ULT.GLYPH_DMG, g.owner, 0, true) >= 0) { knock(g.tgt, norm(d).x, norm(d).z, 0.3, 0.1); snd(g.dim, "random.glass", aim, 0.8, 1.6); }
      for (let k = 0; k < 3; k++) fx(g.dim, "sansmode:gaster_glyph", { x: aim.x + rand(-0.4, 0.4), y: aim.y + rand(-0.4, 0.4), z: aim.z + rand(-0.4, 0.4) });
      gsGlyphs.splice(i, 1); continue;
    }
    const dir = norm(d);
    g.pos = add(g.pos, mul(dir, 1.1));
    fx(g.dim, "sansmode:gaster_glyph", g.pos);
    fx(g.dim, "sansmode:gaster_glyph", sub(g.pos, mul(dir, 0.5)));
  }
}

// ======================= 6. УЛЬТА ========================
// 1) все цели телепортируются в случайные места (без урона);
// 2) через секунду: в каждую цель стреляют 2 бластера, и каждую захватывает рука;
// 3) через 2 секунды после отпускания из земли выходят руки там, где стояли цели;
// 4) бластеры крестом по 3 раза;  5) символы Wingdings (1,5 сердца каждый).
function castGsUlt(p) {
  const U = GSX.ULT;
  if (!gsReady(p, "ult")) return;
  const tgs = gsTargets(p, U.RADIUS, U.MAX_TARGETS);
  if (!tgs.length) return deny(p, "§7Поблизости нет целей");
  if (!gsPay(p, U.COST)) return;
  gsSetCd(p, "ult", U.CD);
  const c = gsCtx(p, tgs);
  c.spots = new Map();
  safe(() => p.triggerEvent("ult_eyes_gaster_on"));
  c.onEnd = () => safe(() => p.triggerEvent("ult_eyes_gaster_off"));
  const at = (tk, fn) => c.timeline.push([tk, fn]);

  at(0, (cc) => { gsTitle(cc.owner, "§l§5[ ... ]"); snd(cc.dim, "mob.wither.spawn", cc.owner.location, 1.2, 0.6); });
  at(U.T_TELE, (cc) => { // 1. телепорт всех целей, урона нет
    for (const e of cc.targets) {
      const spot = gsRandSpot(cc.dim, cc.owner.location, 6, 22);
      fx(cc.dim, "sansmode:gaster_glitch", center(e));
      if (spot) { safe(() => e.teleport(spot, { dimension: cc.dim, keepVelocity: false })); fx(cc.dim, "sansmode:gaster_glitch", { x: spot.x, y: spot.y + 0.9, z: spot.z }); }
    }
    snd(cc.dim, "mob.endermen.portal", cc.owner.location, 1.3, 0.5);
  });
  const T2 = U.T_TELE + 20; // 2. через секунду
  at(T2, (cc) => {
    const o = cc.owner.location, t = now();
    for (const e of cc.targets) {
      const l = e.location, a0 = Math.atan2(l.z - o.z, l.x - o.x);
      cc.spots.set(e.id, { x: l.x, y: l.y, z: l.z });
      gsHold(e, U.HOLD, gsHandEnt(cc.dim, { x: l.x, y: l.y + 1.1, z: l.z }, yawTo(l, o)));
      for (const sd of [-1, 1]) addBlaster(cc, { target: e, ang: a0 + (sd * Math.PI) / 2, r: 7, h: 1.0, spin: 0, spawnAt: t, lockAt: t + 14, fireAt: t + 26, beamTicks: 8, dmg: U.BEAM_DMG, floor: CFG.ULT.BEAM_FLOOR, ik: "a" + (sd > 0 ? 1 : 0) });
    }
    snd(cc.dim, "mob.irongolem.throw", o, 1.2, 0.6);
  });
  const T3 = T2 + U.HOLD + U.GROUND_DELAY; // 3. руки из земли там, где цели были в момент захвата
  at(T3 - U.WARN, (cc) => {
    for (const e of cc.targets) { const s = cc.spots.get(e.id); if (s) gsGroundHandAt(cc.owner, cc.dim, s, U.GROUND_DMG, CFG.ULT.BEAM_FLOOR, U.WARN); }
  });
  let Tc = T3 + U.CROSS_START; // 4. кресты бластеров
  for (let v = 0; v < U.CROSS_VOLLEYS; v++, Tc += U.CROSS_GAP) {
    at(Tc, (cc) => {
      const t = now(), base = rand(0, Math.PI * 2);
      volley(cc, [0, 1, 2, 3].map((k) => ({ ang: base + (k * Math.PI) / 2, r: 7.5, h: 1.0, spin: 0, spawnAt: t, lockAt: t + 14, fireAt: t + 28, beamTicks: 8, dmg: U.BEAM_DMG, floor: CFG.ULT.BEAM_FLOOR, ik: "c" + v + "k" + k })));
    });
  }
  const T5 = Tc + 6; // 5. символы Wingdings
  at(T5, (cc) => gsGlyphVolley(cc.owner, cc.targets));
  at(T5 + 12, (cc) => { cc.finishing = true; });
  gsRun(c, "ult");
}

system.runInterval(() => {
  const t = now();
  safe(() => tickGsHolds(t)); safe(() => tickGsGrabs(t)); safe(() => tickErrStrings(t)); safe(() => tickErrGrabs(t)); safe(() => tickGsGround(t)); safe(() => tickGsCircles(t)); safe(() => tickGsGlyphs(t));
}, 1);


// ====================================================== GASTER: ШЛЕЙФ ПЛАЩА ПРИ ХОДЬБЕ ===
// Низ плаща (кость cloak в модели) волочится по земле — анимация в RP; здесь — частицы тьмы, которые он оставляет за собой.
const GS_TRAIL = { MIN_SPEED: 0.05, BACK: 0.9, SPREAD: 0.55, EVERY: 2 };
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    if (!isGaster(p) || (hp(p) ?? 1) <= 0) continue;
    const v = safe(() => p.getVelocity());
    if (!v || safe(() => p.isGliding) === true) continue;
    const og = safe(() => p.isOnGround); // на старых версиях API свойства может не быть — тогда смотрим на вертикальную скорость
    if (og === undefined ? Math.abs(v.y) > 0.08 : og !== true) continue;
    const sp = Math.hypot(v.x, v.z);
    if (sp < GS_TRAIL.MIN_SPEED) continue;
    const nx = v.x / sp, nz = v.z / sp, l = p.location;
    for (let k = 0; k < 2; k++) {
      const side = rand(-GS_TRAIL.SPREAD, GS_TRAIL.SPREAD), back = GS_TRAIL.BACK + rand(0, 0.5);
      fx(p.dimension, "sansmode:gaster_trail", { x: l.x - nx * back - nz * side, y: l.y + 0.12, z: l.z - nz * back + nx * side });
    }
  }
}, GS_TRAIL.EVERY);
