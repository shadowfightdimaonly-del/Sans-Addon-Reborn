import "./sans_attacks.js";
import "./snowdin_sans.js";
import "./papyrus_snowdin.js";
import { MolangVariableMap, world } from "@minecraft/server";

const BLOOD_COLOR = {
  NONE: -1,
  RED: 0,
  GREEN: 1,
  PINK: 2,
  BLACK: 3,
};
const BLOOD_PARTICLE = {
  [BLOOD_COLOR.RED]: "bloodspray:blood_spray",
  [BLOOD_COLOR.GREEN]: "bloodspray:green_blood_spray",
  [BLOOD_COLOR.PINK]: "bloodspray:pink_blood_spray",
  [BLOOD_COLOR.BLACK]: "bloodspray:black_blood_spray",
};
const BLOOD_COLOR_MAP = [
  { typeId: "minecraft:enderman", color: BLOOD_COLOR.PINK },
  { typeId: "minecraft:ender_dragon", color: BLOOD_COLOR.PINK },
  { typeId: "minecraft:endermite", color: BLOOD_COLOR.PINK },
  { typeId: "minecraft:shulker", color: BLOOD_COLOR.PINK },
  { typeId: "minecraft:warden", color: BLOOD_COLOR.BLACK },
  { typeId: "minecraft:skeleton", color: BLOOD_COLOR.NONE },
  { typeId: "minecraft:stray", color: BLOOD_COLOR.BLACK },
  { typeId: "minecraft:iron_golem", color: BLOOD_COLOR.NONE },
  { typeId: "minecraft:copper_golem", color: BLOOD_COLOR.NONE },
  { typeId: "minecraft:wither_skeleton", color: BLOOD_COLOR.NONE },
  { typeId: "minecraft:skeleton_horse", color: BLOOD_COLOR.NONE },
  { typeId: "minecraft:bogged", color: BLOOD_COLOR.BLACK },
  { typeId: "minecraft:creaking", color: BLOOD_COLOR.BLACK },
  { typeId: "minecraft:creeper", color: BLOOD_COLOR.GREEN },
  { typeId: "minecraft:spider", color: BLOOD_COLOR.GREEN },
  { typeId: "minecraft:cave_spider", color: BLOOD_COLOR.GREEN },
  { typeId: "minecraft:slime", color: BLOOD_COLOR.GREEN },
];

world.afterEvents.entityHurt.subscribe((event) => {
  const { hurtEntity, damageSource } = event;
  if (!hurtEntity) {
    return;
  }

  const loc = hurtEntity.location;
  const spawnLoc = { x: loc.x, y: loc.y + 1.0, z: loc.z };
  const dimension = hurtEntity.dimension;
  const blockPos = {
    x: Math.floor(loc.x),
    y: Math.floor(loc.y),
    z: Math.floor(loc.z),
  };
  const headPos = { ...blockPos, y: blockPos.y + 1 };
  const waterIds = new Set([
    "minecraft:water",
    "minecraft:flowing_water",
    "minecraft:bubble_column",
  ]);
  const isWaterBlock = (pos) => {
    const block = dimension.getBlock(pos);
    return block && waterIds.has(block.typeId);
  };
  const isInWater = isWaterBlock(blockPos) || isWaterBlock(headPos);

  const damagingEntity = damageSource?.damagingEntity;
  let isCritical = false;
  const cause = damageSource?.cause;
  const causeText = typeof cause === "string" ? cause.toLowerCase() : "";
  const isMaceSmash =
    cause === "maceSmash" ||
    cause === "mace_smash" ||
    causeText.includes("mace");
  const isTntKill =
    causeText.includes("tnt") || causeText.includes("explosion");

  if (damagingEntity && damagingEntity.typeId === "minecraft:player") {
    const velocity = damagingEntity.getVelocity?.();
    const falling = velocity && velocity.y < -0.08;
    const onGround =
      "isOnGround" in damagingEntity ? damagingEntity.isOnGround : undefined;
    isCritical = (falling && onGround !== true) || isMaceSmash;
  }

  if (isTntKill) {
    isCritical = true;
  }

  let isKilled = false;
  const health = hurtEntity.getComponent("health");
  if (health && typeof health.currentValue === "number") {
    isKilled = health.currentValue <= 0;
  }

  const molang = new MolangVariableMap();
  molang.setFloat("variable.crit", isCritical && isKilled ? 1.0 : 0.0);
  const typeId = hurtEntity.typeId;
  const matched = BLOOD_COLOR_MAP.find((entry) => entry.typeId === typeId);
  const bloodColor = matched ? matched.color : BLOOD_COLOR.RED;

  molang.setFloat("variable.blood_color", bloodColor);
  if (bloodColor === BLOOD_COLOR.NONE) {
    return;
  }
  const particleId = BLOOD_PARTICLE[BLOOD_COLOR.RED]; // only bloodspray:blood_spray exists in the resource pack
  // Horror Sans: топор/тесак дают вдвое больше крови
  let heavyBlood = false;
  if (damagingEntity && damagingEntity.typeId === "minecraft:player") {
    const held = damagingEntity.getComponent?.("minecraft:equippable")?.getEquipment?.("Mainhand");
    heavyBlood = !!held && (held.typeId === "horrorsans:axe" || held.typeId === "horrorsans:cleaver");
  }
  dimension.spawnParticle(particleId, spawnLoc, molang);
  if (heavyBlood) dimension.spawnParticle(particleId, spawnLoc, molang);
  if (isCritical && isKilled) {
    try {
      dimension.playSound("blood.gibs", spawnLoc);
    } catch (e) {
      dimension.runCommand(`playsound blood.gibs @a ${spawnLoc.x} ${spawnLoc.y} ${spawnLoc.z}`);
    }
  }
});
