import { world, system, ItemStack } from "@minecraft/server";

const PAPYRUS = "sansmode:snowdin_papyrus";
const BONE = "sansmode:papyrus_bone";
const states = new Map();
const blueProjectiles = new Set();
const safe = (fn) => { try { return fn(); } catch (_) { return undefined; } };
const valid = (e) => !!e && safe(() => typeof e.isValid === "function" ? e.isValid() : e.isValid) !== false;
const rand = (a,b) => a + Math.random() * (b-a);
const add = (a,b) => ({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const mul = (a,k) => ({x:a.x*k,y:a.y*k,z:a.z*k});
const norm = (v) => { const n=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/n,y:v.y/n,z:v.z/n}; };
const center = (e) => ({x:e.location.x,y:e.location.y+0.9,z:e.location.z});
const fx = (dim,id,loc) => safe(() => dim.spawnParticle(id,loc));
const snd = (dim,id,loc,vol=1,pitch=1) => safe(() => dim.playSound(id,loc,{volume:vol,pitch}));
const msg = (p,key) => safe(() => p.sendMessage({rawtext:[{translate:key}]}));
const say = (st,key) => { for (const p of world.getAllPlayers()) if (p.dimension.id===st.dim.id && Math.hypot(p.location.x-st.boss.location.x,p.location.z-st.boss.location.z)<28) msg(p,key); };
const getState = (boss) => states.get(boss.id);
const invItem = (p,id) => {
  const inv=safe(() => p.getComponent("minecraft:inventory").container);
  if (!inv) return;
  for (let i=0;i<inv.size;i++) { const it=inv.getItem(i); if (it && it.typeId===id) return {inv,i,it}; }
};
function giveSilverKnife(p) {
  if (invItem(p,"sansmode:silver_knife")) return;
  const inv=safe(() => p.getComponent("minecraft:inventory").container);
  if (!inv) return;
  const item=safe(() => new ItemStack("sansmode:silver_knife",1));
  if (item) safe(() => inv.addItem(item));
}
function saveAndSet(dim,pos,type,st) {
  const b=safe(() => dim.getBlock(pos)); if (!b) return;
  const old=safe(() => b.permutation);
  st.blocks.push({pos:{...pos},old});
  safe(() => b.setType(type));
}
function clearPuzzle(st) {
  for (const x of st.blocks.splice(0)) {
    const b=safe(() => st.dim.getBlock(x.pos));
    if (b && x.old) safe(() => b.setPermutation(x.old));
    else if (b) safe(() => b.setType("minecraft:air"));
  }
  st.buttons.clear();
}
const PUZZLES = [
  {key:"papyrus.snowdin.q1",answer:1,blocks:["minecraft:red_concrete","minecraft:blue_concrete","minecraft:yellow_concrete"]},
  {key:"papyrus.snowdin.q2",answer:2,blocks:["minecraft:orange_concrete","minecraft:lime_concrete","minecraft:purple_concrete"]},
  {key:"papyrus.snowdin.q3",answer:0,blocks:["minecraft:cyan_concrete","minecraft:magenta_concrete","minecraft:white_concrete"]},
  {key:"papyrus.snowdin.q4",answer:2,blocks:["minecraft:light_blue_concrete","minecraft:green_concrete","minecraft:black_concrete"]},
  {key:"papyrus.snowdin.q5",answer:1,blocks:["minecraft:pink_concrete","minecraft:gray_concrete","minecraft:brown_concrete"]}
];
function showPuzzle(st) {
  clearPuzzle(st);
  if (st.index>=PUZZLES.length) {
    st.phase="done";
    say(st,"papyrus.snowdin.all_correct");
    return;
  }
  const q=PUZZLES[st.index], l=st.boss.location, y=Math.floor(l.y);
  const offsets=[{x:-2,z:1},{x:0,z:1},{x:2,z:1}];
  for (let i=0;i<3;i++) {
    const pos={x:Math.floor(l.x)+offsets[i].x,y,z:Math.floor(l.z)+offsets[i].z};
    saveAndSet(st.dim,pos,q.blocks[i],st);
    st.buttons.set(pos.x+","+pos.y+","+pos.z,i);
  }
  say(st,q.key);
  for (const p of world.getAllPlayers()) if (p.dimension.id===st.dim.id && Math.hypot(p.location.x-l.x,p.location.z-l.z)<28) msg(p,"papyrus.snowdin.choose");
}
function spawnBone(boss,target,opts={}) {
  if (!valid(boss)||!valid(target)) return;
  const dim=boss.dimension, from=opts.from||{x:boss.location.x,y:boss.location.y+1.15,z:boss.location.z};
  const to=opts.to||center(target), dir=norm(sub(to,from));
  const bone=safe(() => dim.spawnEntity(BONE,from));
  if (!bone) return;
  if (opts.blue) { blueProjectiles.add(bone.id); safe(() => bone.triggerEvent("papyrus:blue")); }
  if (opts.vertical) safe(() => bone.setRotation({x:90,y:0}));
  const pc=safe(() => bone.getComponent("minecraft:projectile"));
  if (pc) safe(() => pc.shoot(mul(dir,opts.speed||2.7)));
  else safe(() => bone.applyImpulse(mul(dir,opts.speed||2.7)));
  snd(dim,"random.bow",from,0.45,opts.blue?1.35:0.9);
  system.runTimeout(() => { if(valid(bone)) safe(() => bone.remove()); blueProjectiles.delete(bone.id); },100);
  return bone;
}
function answer(st,p,index) {
  if (st.phase!=="puzzle" || !valid(p)) return;
  const q=PUZZLES[st.index];
  if (index===q.answer) {
    msg(p,"papyrus.snowdin.correct");
    snd(st.dim,"random.levelup",p.location,0.65,1.2);
  } else {
    st.wrong++;
    msg(p,"papyrus.snowdin.wrong");
    spawnBone(st.boss,p,{speed:2.2});
    snd(st.dim,"mob.skeleton.hurt",p.location,0.8,0.7);
  }
  st.index++;
  if (st.wrong>=5) { startFight(st,p); return; }
  system.runTimeout(() => { if (valid(st.boss)&&st.phase==="puzzle") showPuzzle(st); },30);
}
function startFight(st,p) {
  clearPuzzle(st);
  st.phase="fight";
  st.target=p;
  safe(() => st.boss.triggerEvent("papyrus:combat_on"));
  giveSilverKnife(p);
  say(st,"papyrus.snowdin.fight_start");
  st.nextAttack=system.currentTick+35;
  snd(st.dim,"mob.wither.spawn",st.boss.location,1,1.1);
  fx(st.dim,"minecraft:totem_particle",center(st.boss));
}
function finishFight(st) {
  st.phase="defeated";
  clearPuzzle(st);
  say(st,"papyrus.snowdin.defeated");
  snd(st.dim,"random.levelup",st.boss.location,1,1.4);
}
function hit(p,boss,damage=5) {
  if (!valid(p)||p.typeId!=="minecraft:player") return;
  safe(() => p.applyDamage(damage,{cause:"projectile",damagingEntity:boss}));
  fx(p.dimension,"minecraft:crit_particle",center(p));
}
function lineBones(st,p,axis,count=7,blue=false) {
  const origin={x:st.boss.location.x,y:st.boss.location.y+0.8,z:st.boss.location.z};
  const dir=norm(sub(center(p),origin));
  const side=axis==="x"?{x:-dir.z,z:dir.x}:{x:dir.z,z:-dir.x};
  for(let i=0;i<count;i++){
    const k=i-(count-1)/2;
    const from={x:origin.x+side.x*k*1.15,y:origin.y,z:origin.z+side.z*k*1.15};
    spawnBone(st.boss,p,{from,to:add(from,mul(dir,18)),speed:3.0,blue});
  }
}
function attackFan(st,p) {
  const from={x:st.boss.location.x,y:st.boss.location.y+1.2,z:st.boss.location.z};
  const base=norm(sub(center(p),from)), yaw=Math.atan2(base.z,base.x);
  for(let i=-3;i<=3;i++){const a=yaw+i*0.19;spawnBone(st.boss,p,{from,to:{x:from.x+Math.cos(a)*18,y:from.y+base.y*5,z:from.z+Math.sin(a)*18},speed:2.9});}
  say(st,"papyrus.snowdin.attack_fan");
}
function attackRow(st,p) {
  lineBones(st,p,Math.random()<0.5?"x":"z",9,false);
  say(st,"papyrus.snowdin.attack_row");
}
function attackThrow(st,p) { spawnBone(st.boss,p,{speed:4.1}); say(st,"papyrus.snowdin.attack_throw"); }
function attackSpikes(st,p) {
  const l=p.location;
  for(let i=-2;i<=2;i++){
    const pos={x:l.x+i*1.15,y:l.y-1.0,z:l.z};
    const b=safe(()=>st.dim.spawnEntity(BONE,pos)); if(!b)continue;
    safe(()=>b.setRotation({x:90,y:0}));
    const pc=safe(()=>b.getComponent("minecraft:projectile")); if(pc)safe(()=>pc.shoot({x:0,y:3.2,z:0}));
    system.runTimeout(()=>{if(valid(b))safe(()=>b.remove());},45);
  }
  say(st,"papyrus.snowdin.attack_spikes");
}
function attackBlueSoul(st,p) {
  safe(()=>p.addEffect("slowness",60,{amplifier:255,showParticles:false}));
  safe(()=>p.addEffect("jump_boost",60,{amplifier:2,showParticles:true}));
  msg(p,"papyrus.snowdin.blue_soul");
  for(let i=0;i<5;i++) system.runTimeout(()=>{
    if(!valid(p)||st.phase!=="fight")return;
    const l=p.location;
    const from={x:l.x,y:l.y+7,z:l.z};
    const b=safe(()=>st.dim.spawnEntity(BONE,from)); if(!b)return;
    blueProjectiles.add(b.id); safe(()=>b.setRotation({x:90,y:0}));
    const pc=safe(()=>b.getComponent("minecraft:projectile")); if(pc)safe(()=>pc.shoot({x:0,y:-3.5,z:0}));
    system.runTimeout(()=>{if(valid(b))safe(()=>b.remove());blueProjectiles.delete(b.id);},55);
  },i*9);
}
function attackRing(st,p) {
  const c=center(p);
  for(let i=0;i<12;i++){const a=i*Math.PI/6, from={x:c.x+Math.cos(a)*8,y:c.y+rand(-1,1),z:c.z+Math.sin(a)*8};spawnBone(st.boss,p,{from,to:c,speed:3.2});}
  say(st,"papyrus.snowdin.attack_ring");
}
function attackCage(st,p) {
  const c=center(p);
  for(let i=0;i<4;i++) for(let k=-1;k<=1;k++){
    const a=i*Math.PI/2, from={x:c.x+Math.cos(a)*7+Math.cos(a+Math.PI/2)*k*1.2,y:c.y+k*0.6,z:c.z+Math.sin(a)*7+Math.sin(a+Math.PI/2)*k*1.2};
    spawnBone(st.boss,p,{from,to:c,speed:3.5});
  }
  say(st,"papyrus.snowdin.attack_cage");
}
function attackRain(st,p) {
  for(let i=0;i<11;i++) system.runTimeout(()=>{
    if(!valid(p)||st.phase!=="fight")return;
    const l=p.location, from={x:l.x+rand(-4,4),y:l.y+8,z:l.z+rand(-4,4)};
    const b=safe(()=>st.dim.spawnEntity(BONE,from)); if(!b)return;
    safe(()=>b.setRotation({x:90,y:0}));
    const pc=safe(()=>b.getComponent("minecraft:projectile")); if(pc)safe(()=>pc.shoot({x:0,y:-3.8,z:0}));
    system.runTimeout(()=>{if(valid(b))safe(()=>b.remove());},55);
  },i*4);
  say(st,"papyrus.snowdin.attack_rain");
}
function attackCross(st,p) {
  const c=center(p);
  for(let i=-3;i<=3;i++){
    spawnBone(st.boss,p,{from:{x:c.x+i*1.3,y:c.y+5,z:c.z-9},to:{x:c.x+i*1.3,y:c.y,z:c.z+9},speed:3.7});
    spawnBone(st.boss,p,{from:{x:c.x-9,y:c.y+5,z:c.z+i*1.3},to:{x:c.x+9,y:c.y,z:c.z+i*1.3},speed:3.7});
  }
  say(st,"papyrus.snowdin.attack_cross");
}
const ATTACKS=[attackFan,attackRow,attackThrow,attackSpikes,attackBlueSoul,attackRing,attackCage,attackRain,attackCross];
function tickFight(st,t) {
  if(!valid(st.boss)){clearPuzzle(st);states.delete(st.id);return;}
  if(!valid(st.target) || st.target.dimension.id!==st.dim.id){
    const nearby=safe(()=>st.dim.getPlayers({location:st.boss.location,maxDistance:28,closest:1}))||[];
    st.target=nearby[0];
  }
  if(!st.target)return;
  if(t>=st.nextAttack){
    const attack=ATTACKS[Math.floor(Math.random()*ATTACKS.length)];
    attack(st,st.target);
    st.nextAttack=t+65+Math.floor(Math.random()*25);
  }
}
function initBoss(boss) {
  if(!valid(boss)||boss.typeId!==PAPYRUS||states.has(boss.id))return;
  const st={id:boss.id,boss,dim:boss.dimension,phase:"puzzle",index:0,wrong:0,blocks:[],buttons:new Map(),target:null,nextAttack:0};
  states.set(boss.id,st);
  say(st,"papyrus.snowdin.greeting");
  system.runTimeout(()=>{if(valid(boss)&&st.phase==="puzzle")showPuzzle(st);},30);
}
world.afterEvents.entitySpawn.subscribe(ev=>{if(safe(()=>ev.entity.typeId)===PAPYRUS)initBoss(ev.entity);});
function onPuzzleInteract(player,block){
  if(!player||!block)return;
  const l=block.location, key=Math.floor(l.x)+","+Math.floor(l.y)+","+Math.floor(l.z);
  for(const st of states.values()){
    if(st.phase!=="puzzle"||player.dimension.id!==st.dim.id)continue;
    if(st.buttons.has(key)){answer(st,player,st.buttons.get(key));return;}
  }
}
if(world.afterEvents.playerInteractWithBlock) world.afterEvents.playerInteractWithBlock.subscribe(ev=>onPuzzleInteract(ev.player,ev.block));
else if(world.afterEvents.itemUseOn) world.afterEvents.itemUseOn.subscribe(ev=>onPuzzleInteract(ev.source,ev.block));
if(world.afterEvents.projectileHitEntity)world.afterEvents.projectileHitEntity.subscribe(ev=>{
  const b=safe(()=>ev.projectile), id=safe(()=>b.id);
  if(!id||!blueProjectiles.has(id))return;
  const hitEnt=safe(()=>ev.getEntityHit().entity);
  if(hitEnt&&hitEnt.typeId==="minecraft:player")safe(()=>hitEnt.addEffect("slowness",60,{amplifier:255,showParticles:true}));
  blueProjectiles.delete(id);
});
world.afterEvents.entityHurt.subscribe(ev=>{
  const target=ev.hurtEntity;
  if(!target||target.typeId!==PAPYRUS)return;
  const st=getState(target);
  if(!st||st.phase!=="fight")return;
  const attacker=safe(()=>ev.damageSource.damagingEntity);
  if(!attacker||attacker.typeId!=="minecraft:player")return;
  const held=safe(()=>attacker.getComponent("minecraft:equippable").getEquipment("Mainhand"));
  if(!held)return;
  const amount=held.typeId==="sansmode:red_knife"?9999:held.typeId==="sansmode:silver_knife"?60:0;
  if(!amount)return;
  const hp=safe(()=>target.getComponent("minecraft:health"));
  if(!hp)return;
  if(amount>=hp.currentValue){finishFight(st);system.runTimeout(()=>{if(valid(target))safe(()=>target.kill());},1);return;}
  const extra=Math.max(0,amount-(Number(ev.damage)||0));
  if(extra>0)safe(()=>hp.setCurrentValue(Math.max(0,hp.currentValue-extra)));
});
world.afterEvents.entityDie.subscribe(ev=>{
  const dead=ev.deadEntity;
  if(dead&&dead.typeId===PAPYRUS){const st=getState(dead);if(st){clearPuzzle(st);states.delete(dead.id);}}
});
system.runInterval(()=>{
  const t=system.currentTick;
  for(const st of states.values())if(st.phase==="fight")tickFight(st,t);
},5);
