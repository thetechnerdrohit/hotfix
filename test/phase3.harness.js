import * as THREE from 'three';
import { PlayerEntity } from '../src/game/entities.js';
import { Match } from '../src/game/match.js';
import { makeGraph, TEST_ROOM_NODES } from '../src/world/waypoints.js';
import { WeaponSystem } from '../src/combat/weapons.js';
import { applyDamage } from '../src/combat/damage.js';
import { MATCH, COMBAT, BOTS } from '../src/config.js';
let F=0; const ok=(c,m)=>{ if(!c){F++;console.error('  ✗',m);}else console.log('  ✓',m); };
const vf=v=>Number.isFinite(v.x)&&Number.isFinite(v.y)&&Number.isFinite(v.z);
function box(x,b,z,w,h,d){return{min:new THREE.Vector3(x-w/2,b,z-d/2),max:new THREE.Vector3(x+w/2,b+h,z+d/2)};}
const rc=[box(0,0,-12.25,25,4,.5),box(0,0,12.25,25,4,.5),box(12.25,0,0,.5,4,24),box(-12.25,0,0,.5,4,24),box(5,0,0,1.4,.5,1.4),box(5,0,-1.8,1.4,1,1.4),box(5,0,-3.6,1.4,1.5,1.4),box(-6,0,5,2,1.2,2)];
class FC{constructor(){this.pos=new THREE.Vector3(0,0,10.5);this.vel=new THREE.Vector3();this.grounded=true;this.coyote=0;this.jumpBuffer=0;this.sprinting=false;this.sprintSuppress=0;this.landImpact=0;}}
const scene={add(){}}; const graph=makeGraph(TEST_ROOM_NODES); const DT=1/60;

console.log('\n=== graph ==='); const pb=new Int16Array(graph.nodes.length);
ok(graph.nodes.length===16,`16 nodes`);
let reach=true; for(let i=0;i<16;i++) if(graph.path(0,i,pb)===0) reach=false; ok(reach,'all reachable from 0');
graph.path(3,12,pb); graph.path(9,1,pb); ok(graph.path(0,14,pb)>0,'BFS stamp-reuse correct');

console.log('\n=== construct + fight ===');
const w=new WeaponSystem(rc,[]); const p=new PlayerEntity(1,new FC(),w,{yaw:0,pitch:0}); w.owner=p;
const m=new Match(p,w,graph,scene,rc); w.targets=m.enemiesOfPlayer;
ok(m.bots.length===9,'9 bots'); ok(m.seTeam.length===5&&m.bugTeam.length===5,'5v5');
ok(new Set(m.bots.map(b=>b.name).concat(p.name)).size===10,'10 unique names');
ok(p.name==='you','player=you');
const idE=m.enemiesOfPlayer, idC=m.dynamicColliders;
let posOk=true,hpOk=true,cOk=true,fired=false,killed=false,kf=0;
m.onBotFired=()=>fired=true; m.onKillFeed=()=>kf++; m.onBotKilled=()=>killed=true;
let t=0; while(m.state==='live'&&t<60*200){ m.update(DT); t++;
  for(const c of m.allCombatants){ if(!vf(c.pos))posOk=false; if(!Number.isFinite(c.hp)||c.hp>c.maxHp+1e-3)hpOk=false; }
  if(m.dynamicColliders.length<m._staticCount)cOk=false;
  for(let i=0;i<m.dynamicColliders.length;i++){const c=m.dynamicColliders[i];if(!vf(c.min)||!vf(c.max))cOk=false;}
}
console.log(`  (ran ${t} ticks; ${m.state}; se=${m.scores.se} bug=${m.scores.bug})`);
ok(posOk,'no NaN positions'); ok(hpOk,'hp bounded'); ok(cOk,'colliders valid every frame');
ok(m.enemiesOfPlayer===idE,'enemiesOfPlayer identity stable'); ok(m.dynamicColliders===idC,'dynamicColliders identity stable');
ok(fired,'bots fired'); ok(killed,'a bot was killed'); ok(kf>0,`kill-feed (${kf})`);
ok(m.scores.se+m.scores.bug>0,`scores accrued`);
if(m.state==='over'){ ok(!!m.result&&['se','bug','draw'].includes(m.result.winner),`winner=${m.result.winner}`);
  ok(m.scores.se>=MATCH.killTarget||m.scores.bug>=MATCH.killTarget||m.clock<=0,'ended on target or time'); }

console.log('\n=== bot damage == player damage (all difficulties) ===');
for(const d of ['easy','normal','hard']){ BOTS.difficulty=d;
  const w2=new WeaponSystem(rc,[]);const p2=new PlayerEntity(1,new FC(),w2,{yaw:0,pitch:0});const m2=new Match(p2,w2,graph,scene,rc);
  p2.protectedUntil=-1; p2.hp=100; applyDamage(p2,COMBAT.rifle.body,m2.bugBots[0],false);
  ok(p2.hp===100-COMBAT.rifle.body,`[${d}] body dmg=${COMBAT.rifle.body}`); } BOTS.difficulty='normal';

console.log('\n=== onDanger rich payload (source pos, copied) ===');
{ const w3=new WeaponSystem(rc,[]);const p3=new PlayerEntity(1,new FC(),w3,{yaw:0,pitch:0});const m3=new Match(p3,w3,graph,scene,rc);
  p3.protectedUntil=-1; let cap=null; p3.onDanger=r=>{ cap={ hasSource:r.hasSource, sx:r.sourcePos.x, sz:r.sourcePos.z, isHead:r.isHead, sameRef:r.sourcePos===m3.bugBots[0].pos }; };
  const s=m3.bugBots[0]; s.pos.set(3,0,4); s.dead=false; applyDamage(p3,COMBAT.rifle.body,s,true);
  ok(cap&&cap.hasSource===true,'onDanger hasSource=true when attacker present');
  ok(cap&&Number.isFinite(cap.sx)&&cap.sx===3&&cap.sz===4,'onDanger sourcePos COPIED attacker pos (3,4)');
  ok(cap&&cap.sameRef===false,'sourcePos is NOT the attacker vector (reused scratch, F7)');
  ok(cap&&cap.isHead===true,'onDanger.isHead');
  // hasSource=false path (no attacker):
  let cap2=null; p3.hp=100; p3.dead=false; p3.onDanger=r=>{ cap2={hasSource:r.hasSource}; };
  applyDamage(p3,10,null,false); ok(cap2&&cap2.hasSource===false,'onDanger hasSource=false when no attacker'); }

console.log('\n=== F3 trade + F10 protection excludes from lists ===');
{ const w4=new WeaponSystem(rc,[]);const p4=new PlayerEntity(1,new FC(),w4,{yaw:0,pitch:0});const m4=new Match(p4,w4,graph,scene,rc);
  m4.update(DT); ok(m4.enemiesOfPlayer.length===0,'protected Bugs excluded from player targets (F10)');
  const a=m4.seBots[0],b=m4.bugBots[0]; a.hp=1;b.hp=1;a.dead=false;b.dead=false;a.protectedUntil=-1;b.protectedUntil=-1;
  const s0=m4.scores.se,s1=m4.scores.bug; applyDamage(a,50,b,false); applyDamage(b,50,a,false);
  ok(a.dead&&b.dead&&m4.scores.se-s0===1&&m4.scores.bug-s1===1,'both die, both credited (F3)'); }

console.log('\n=== restart ===');
{ m.restart(); ok(m.scores.se===0&&m.scores.bug===0,'scores 0'); ok(Math.abs(m.clock-MATCH.timeLimit)<1e-6,'clock reset');
  ok(m.state==='live'&&m.playerAlive,'live+alive'); ok(m.bots.every(b=>!b.dead&&b._respawnTimer===0),'all bots alive, no pending respawn'); }
console.log(`\n${F===0?'ALL PASSED':F+' FAIL'}`); process.exit(F?1:0);
