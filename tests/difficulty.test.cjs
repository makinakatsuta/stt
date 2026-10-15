const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
globalThis.crypto=require('node:crypto').webcrypto;
require('../docs/wasm_exec.js');
let seed=1;
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const quiet=new Proxy({}, {get:()=>()=>{}});
const context=vm.createContext({Math:Object.assign(Object.create(Math),{random}),window:{},sounds:quiet,narrator:quiet,
 console:{debug(){},error(e){throw e;}},Date:{now:()=>1000},document:{getElementById:()=>null}});
const source=fs.readFileSync('docs/js/game-engine.js','utf8');
vm.runInContext(fs.readFileSync('docs/js/constants.js','utf8').replace(/export \{[^}]+\};/,'')+'\n'+source.replace(/^import .*;\r?\n/gm,'').replace('export class','class')+'\nglobalThis.Engine=GameEngine;',context);
function game(d,role=1){
 const g=Object.create(context.Engine.prototype);
 Object.assign(g,{difficulty:d,role,mode:'cpu',state:'RALLY',keys:{},p1:{x:350},p2:{x:350},ball:{x:400,y:250,vx:0,vy:role===1?-6:6,active:true,easyReturnCount:2},pendingSwingUntil:0});
 for(const m of ['processBufferedSwing','checkTimeouts','syncPaddlePosition','addRipple'])g[m]=()=>{};
 g.awardPointTo=w=>{g.winner=w;g.ball.active=false;};return g;
}
function accepts(d,role,dx,dy,mode='cpu'){
 const g=game(d,role);g.mode=mode;g.net={send(){}};
 g.ball.x=400+dx;g.ball.y=(role===1?400:100)+dy;g.ball.vy=role===1?6:-6;
 return g.tryPlayerReturn();
}
for(const role of [1,2])for(const sign of [-1,1])for(const [d,zone,margin,mode] of [
 ['easy',130,105,'cpu'],['normal',120,110,'cpu'],['hard',110,105,'cpu'],
 ['normal',90,95,'online'],['hard',95,100,'online']]){
 assert.equal(accepts(d,role,0,sign*(zone-.001),mode),true);
 assert.equal(accepts(d,role,0,sign*zone,mode),false);
 assert.equal(accepts(d,role,sign*margin,0,mode),true);
 assert.equal(accepts(d,role,sign*(margin+.001),0,mode),false);
}
for(const role of [1,2])for(const d of ['normal','hard']){
 const values=[];
 for(const count of [0,2,6,12,24]){
  const a=game(d,role),b=game(d,role);
  for(const g of [a,b]){g.normalReturnCount=count;g.ball.y=role===1?130:370;}
  b[role===1?'p2':'p1'].x=10;a.prepareNormalCpuShot();b.prepareNormalCpuShot();
  assert.ok(b.ball.normalReturnChance<a.ball.normalReturnChance,'placement rewards player skill');
  const plan=JSON.stringify(b.ball);b.prepareNormalCpuShot();assert.equal(JSON.stringify(b.ball),plan,'one plan per shot');
  values.push(a.ball.normalReturnChance);
 }
 assert.ok(values[1]>values[2] && values[2]>values[3] && values[3]===values[4],'rally fatigue');
}
for(const role of [1,2])for(const count of [0,2,6,12])for(const d of ['normal','hard'])for(let i=0;i<300;i++){
 const g=game(d,role);g.normalReturnCount=count;g.ball.x=[30,400,770][i%3];g.ball.vx=i%2?3:-3;
 const arrival=vm.runInContext('predictedBallX',context)(g.ball.x,g.ball.y,g.ball.vx,g.ball.vy,role===1?100:400);
 g.prepareNormalCpuShot();
 const limit=count===0?(d==='normal'?15:25):count<6?(d==='normal'?55:75):(d==='normal'?80:125);
 assert.ok(Math.abs(g.ball.normalTargetX-arrival)<=limit+1e-9,'bounded course');
 const min=d==='normal'?5:count===0?6.5:6.8,max=d==='normal'?6.5:count===0?7.2:count<6?7.6:7.8;
 assert.ok(g.ball.normalSpeed>=min && g.ball.normalSpeed<=max,'bounded CPU speed');
 assert.ok(g.ball.normalReturnChance>=(d==='normal'?.69:.76) && g.ball.normalReturnChance<=(d==='normal'?.86:.90));
}
for(const d of ['easy','normal','hard']){const g=game(d);assert.equal(g.canCpuReturn(),true);assert.equal(g.canCpuReturn(),false);}
for(const role of [1,2]){const g=game('easy',role);g.ball.easyReturnCount=7;assert.equal(g.canCpuReturn(),false);}
(async()=>{
 const go=new Go();const {instance}=await WebAssembly.instantiate(fs.readFileSync('docs/main.wasm'),go.importObject);go.run(instance);
 for(const d of ['easy','normal','hard'])for(const role of [1,2])for(const ratio of [0,.5,1]){
  const a=game(d,role),b=game(d,role);
  for(const g of [a,b]){g.ball.active=false;g.useTilt=true;g.tiltSpeed=ratio;g.keys={ArrowRight:true};}
  context.window.updatePhysicsWasm=undefined;a.updatePhysics();context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();
  assert.equal(a['p'+role].x,b['p'+role].x,'manual movement parity');
  if(d!=='easy')assert.equal(a['p'+role].x,350+11*ratio);
 }
 // Same seeds, both roles and edges, compare each frame through scoring.
 for(const d of ['easy','normal','hard'])for(const role of [1,2])for(const x of [30,400,770])for(const count of [0,6,12]){
  const a=game(d,role),b=game(d,role);a.ball.x=b.ball.x=x;a.normalReturnCount=b.normalReturnCount=count;
  let sa=456,sb=456;
  for(let frame=0;frame<2000 && !a.winner;frame++){
   seed=sa;context.window.updatePhysicsWasm=undefined;a.updatePhysics();sa=seed;
   seed=sb;context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();sb=seed;
   assert.equal(sa,sb,'random consumption parity');assert.equal(a.winner,b.winner,'score parity');
   for(const p of ['p1','p2'])assert.ok(Math.abs(a[p].x-b[p].x)<1e-9,'CPU movement parity');
   for(const key of ['x','y','vx','vy'])assert.ok(Math.abs(a.ball[key]-b.ball[key])<1e-8,d+'/'+role+'/'+x+'/'+frame+'/'+key);
  }
  assert.ok(a.winner,'rally terminates');
 }
 for(const backend of [undefined,globalThis.updatePhysicsWasm])for(const d of ['easy','normal','hard'])for(const role of [1,2]){
  context.window.updatePhysicsWasm=backend;
  const g=game(d,role);g.ball.y=role===1?300:200;g.ball.vy=role===1?6:-6;
  for(let frame=0;frame<100 && !g.winner;frame++)g.updatePhysics();
  assert.equal(g.winner,3-role,'idle player loses');assert.equal(g['p'+role].x,350,'no auto movement');
 }
 const goSource=fs.readFileSync('main_wasm.go','utf8').split('func calculateRallyReturnVelocity')[0];
 const jsNames=[...(source+fs.readFileSync('docs/js/constants.js','utf8')).matchAll(/const (\w+) =/g)].map(m=>m[1]);
 for(const m of goSource.matchAll(/\t(\w+)\s+=\s+([0-9.]+)\s*\n/g)){
  const name=jsNames.find(n=>n.replaceAll('_','').toLowerCase()===m[1].toLowerCase());
  if(name)assert.equal(vm.runInContext(name,context),Number(m[2]),'shared parameter '+name);
 }
 const start=source.lastIndexOf("if (this.difficulty === 'easy') {",source.indexOf('const speedCategory = Math.random();'));
 const end=source.indexOf("this.addRipple(this.ball.x, this.ball.y, 'serve');",start);
 assert.ok(start>=0 && end>start,'CPU service branch found');
 const serve=vm.runInContext('(function(){'+source.slice(start,end)+'})',context);
 for(const d of ['normal','hard'])for(let i=0;i<10000;i++){
  const g=game(d);serve.call(g);assert.ok(Math.abs(g.ball.vx)<=2);
  assert.ok(g.ball.vy>0 && g.ball.vy<=(d==='normal'?6.5:7.8),d+' CPU serve '+g.ball.vy);
 }
 console.log('Difficulty: boundaries, placement, fatigue, speed/course limits, manual input, JS/WASM parity and CPU serves passed.');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
