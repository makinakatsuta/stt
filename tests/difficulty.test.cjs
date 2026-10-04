const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
globalThis.crypto=require('node:crypto').webcrypto;
require('../docs/wasm_exec.js');
let seed=1;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const quiet=new Proxy({}, {get:()=>()=>{}});
const context=vm.createContext({Math:Object.assign(Object.create(Math),{random}),window:{},sounds:quiet,narrator:quiet,console:{debug(){},error(e){throw Error(e);}},Date:{now:()=>1000},document:{getElementById:()=>null}});
const source=fs.readFileSync('docs/js/game-engine.js','utf8');
vm.runInContext(fs.readFileSync('docs/js/constants.js','utf8').replace(/export \{[^}]+\};/,'')+'\n'+source.replace(/^import .*;\r?\n/gm,'').replace('export class','class')+'\nglobalThis.Engine=GameEngine; globalThis.velocity=calculateRallyReturnVelocity;',context);
function game(d,role=1){const g=Object.create(context.Engine.prototype);Object.assign(g,{difficulty:d,role,mode:'cpu',state:'RALLY',keys:{},p1:{x:350},p2:{x:350},ball:{x:400,y:250,vx:0,vy:role===1?-6:6,active:true,easyReturnCount:2},pendingSwingUntil:0});for(const m of ['processBufferedSwing','checkTimeouts','syncPaddlePosition','addRipple'])g[m]=()=>{};g.getBallAssistKeys=()=>g.keys;g.awardPointTo=w=>{g.winner=w;g.ball.active=false;};return g;}

// Player returns run in JS in both engines. Exercise the actual acceptance
// method, including strict longitudinal and inclusive horizontal boundaries.
const oldReturn = vm.runInContext('(function(){' + source
 .replace(/^import .*;\r?\n/gm, '').replace('export class', 'class')
 .replace('const HARD_PLAYER_RETURN_FACTOR = 0.95;', 'const HARD_PLAYER_RETURN_FACTOR = 0.9;')
 + ';return GameEngine.prototype.tryPlayerReturn;})()', context);
function accepts(difficulty, role, dx, dy, method = context.Engine.prototype.tryPlayerReturn) {
 const g = game(difficulty, role);
 g.ball.x = 400 + dx;
 g.ball.y = (role === 1 ? 400 : 100) + dy;
 g.ball.vy = role === 1 ? 6 : -6;
 return method.call(g);
}
assert.equal(vm.runInContext('HARD_DIFFICULTY_FACTOR', context), 0.9);
assert.equal(vm.runInContext('HARD_PLAYER_RETURN_FACTOR', context), 0.95);
for (const role of [1, 2]) for (const sign of [-1, 1]) {
 assert.equal(accepts('hard', role, 0, sign * 85.499), true);
 assert.equal(accepts('hard', role, 0, sign * 85.5), false);
 assert.equal(accepts('normal', role, 0, sign * 85.5), true);
 assert.equal(accepts('normal', role, 0, sign * 89.999), true);
 assert.equal(accepts('normal', role, 0, sign * 90), false);
 assert.equal(accepts('easy', role, 0, sign * 129.999), true);
 assert.equal(accepts('easy', role, 0, sign * 130), false);
 assert.equal(accepts('hard', role, sign * 92.75, 0), true);
 assert.equal(accepts('hard', role, sign * 92.751, 0), false);
 assert.equal(accepts('normal', role, sign * 95, 0), true);
 assert.equal(accepts('normal', role, sign * 95.001, 0), false);
 assert.equal(accepts('easy', role, sign * 105, 0), true);
 assert.equal(accepts('easy', role, sign * 105.001, 0), false);
 for (const [dx, dy] of [[0, sign * 83], [sign * 92, 0], [sign * 92, sign * 83]]) {
  assert.equal(accepts('hard', role, dx, dy, oldReturn), false, 'old 90% rejects');
  assert.equal(accepts('hard', role, dx, dy), true, 'new 95% accepts');
 }
}
assert.equal(vm.runInContext('NORMAL_HIT_ZONE * HARD_PLAYER_RETURN_FACTOR', context), 85.5);
assert.equal(vm.runInContext('(NORMAL_PADDLE_MARGIN + BALL_RADIUS) * HARD_PLAYER_RETURN_FACTOR', context), 42.75);

(async()=>{
 const go=new Go();const {instance}=await WebAssembly.instantiate(fs.readFileSync('docs/main.wasm'),go.importObject);go.run(instance);
 for(const d of ['easy','normal','hard']) for(const role of [1,2]) for(const ratio of [0,0.5,1]){
  const a=game(d,role),b=game(d,role);a.ball.active=b.ball.active=false;a.useTilt=b.useTilt=true;a.tiltSpeed=b.tiltSpeed=ratio;a.keys=b.keys={ArrowRight:true};context.window.updatePhysicsWasm=undefined;a.updatePhysics();context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();assert.equal(a['p'+role].x,b['p'+role].x,`${d} movement ${role}/${ratio}`);
 }
 for(const role of [1,2]) {
  const g=game('easy',role);g.ball.easyReturnCount=0;assert.equal(g.canCpuReturn(),true);assert.equal(g.canCpuReturn(),false);
  g.ball.easyCpuAttempted=false;g.ball.easyReturnCount=7;assert.equal(g.canCpuReturn(),false);
 }
 for(const d of ['easy','normal','hard'])for(const role of [1,2])for(const x of [30,400,770]){
  const a=game(d,role),b=game(d,role);for(const g of [a,b]){g.ball.x=x;g.ball.vx=3;g.prepareNormalCpuShot();}
  context.window.updatePhysicsWasm=undefined;a.updatePhysics();context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();
  for(const player of ['p1','p2'])assert.ok(Math.abs(a[player].x-b[player].x)<1e-10,'CPU pursuit '+d+'/'+role+'/'+x);
 }
 const goSource=fs.readFileSync('main_wasm.go','utf8').split('func calculateRallyReturnVelocity')[0];
 const jsNames=[...(''+source+fs.readFileSync('docs/js/constants.js','utf8')).matchAll(/const (\w+) =/g)].map(m=>m[1]);
 for(const m of goSource.matchAll(/\t(\w+)\s+=\s+([0-9.]+)\s*\n/g)){
  const name=jsNames.find(n=>n.replaceAll('_','').toLowerCase()===m[1].toLowerCase());
  if(name)assert.equal(vm.runInContext(name,context),Number(m[2]),'JS/WASM parameter '+name);
 }
 const stats={};
 for(const d of ['easy','normal','hard']){
  seed=123;let hits=0,effort=0,straight=0;
  for(let i=0;i<4000;i++){
   const g=game(d);g.p1.x=80+(i%6)*100;g.ball.x=300+(i%3)*100;g.p2.x=10+(i%7)*100;g.prepareNormalCpuShot();
   if(d==='easy'){if(random()<0.9)hits++;const v=context.velocity(0,6,0,d,1);effort+=Math.max(0,Math.abs(g.ball.x-(g.p1.x+50))-105)*v.vy/300/11.5;continue;}
   if(random()<g.ball.normalReturnChance)hits++;
   const v=vm.runInContext('normalCpuVelocity',context)(g.ball,1);const target=g.ball.x+v.vx*300/v.vy;
   effort+=Math.max(0,Math.abs(target-(g.p1.x+50))-(d==='hard'?92.75:95))*Math.abs(v.vy)/300/(d==='hard'?9.9:11);if(Math.abs(v.vx)<0.5)straight++;
   // Same shared shot plan is consumed by both physical engines, on either side.
   if(i<40) for(const role of [1,2]){
    g.role=role;g.ball.x=400;g.p1.x=g.p2.x=350;g.ball.y=role===1?106:394;g.ball.vy=role===1?-6:6;
    const result=globalThis.updatePhysicsWasm(g.ball,g.p1,g.p2,{},'cpu','RALLY',role,d,1000,1);
    if(result.events.some(e=>e.type==='ball_hit')){const expected=vm.runInContext('normalCpuVelocity',context)(g.ball,role===1?1:-1);assert.ok(Math.abs(result.ball.vx-expected.vx)<1e-10);assert.ok(Math.abs(result.ball.vy-expected.vy)<1e-10);}
   }
  }
  stats[d]={hits,effort,straight};
 }
 assert.ok(stats.easy.hits<stats.normal.hits && stats.normal.hits<stats.hard.hits);assert.ok(stats.normal.effort>stats.easy.effort && stats.hard.effort>stats.normal.effort);assert.ok(stats.hard.straight<=stats.normal.straight);
 // Actual frame simulation, same delayed virtual player and keyboard policy.
 for(const backend of ['js','wasm']){
  context.window.updatePhysicsWasm=backend==='wasm'?globalThis.updatePhysicsWasm:undefined;
  const actualReturns={};
  for(const d of ['easy','normal','hard']){let hits=0;
   for(let i=0;i<4000;i++){const g=game(d,i%2+1);g.ball.x=400;g.ball.y=g.role===1?106:394;g.ball.vy=g.role===1?-6:6;g.updatePhysics();if(g.ball.vy*(g.role===1?1:-1)>0)hits++;}
   actualReturns[d]=hits;
  }
  assert.ok(actualReturns.easy<actualReturns.normal && actualReturns.normal<actualReturns.hard,JSON.stringify(actualReturns));
  console.log(backend,'CPU returns / 4000 (after Easy grace):',actualReturns);
  if(process.argv.includes('--contracts-only') || (backend==='wasm' && process.argv.includes('--js-only')))continue;
  const wins={};
  for(const d of ['easy','normal','hard']){seed=456;let won=0;
   for(let match=0;match<200;match++){let p=0,c=0;
    while(Math.max(p,c)<11 || Math.abs(p-c)<2){const g=game(d);g.useTilt=true;g.tiltSpeed=0.5;g.ball.easyReturnCount=0;let target=350;
     for(let frame=0;frame<50000 && !g.winner;frame++){
      if(frame%30===0)target=g.ball.x-50;g.keys={ArrowLeft:g.p1.x>target+10,ArrowRight:g.p1.x<target-10};g.updatePhysics();
      if(frame%6===0 && random()<0.96 && g.ball.y>=400)g.tryPlayerReturn();
     }
     assert.ok(g.winner,'rally terminates '+backend+' '+d+' '+JSON.stringify(g.ball));if(g.winner===1)p++;else c++;if(p+c>150)throw Error('match fails to terminate');
    }if(p>c)won++;
   }wins[d]=won;console.log(backend,d,'completed',won,'wins');
  }console.log(backend,'player wins / 200:',wins);assert.ok(wins.easy>wins.normal);assert.ok(wins.normal>wins.hard+10,'Hard player win rate statistically lower');
 }
 // Execute the CPU serve branch, including all following statements.
 const start=source.indexOf('// 難易度に応じてサーブの速度や角度を調整');const end=source.indexOf("this.addRipple(this.ball.x, this.ball.y, 'serve');",start);
 const serve=vm.runInContext('(function(){'+source.slice(start,end)+'})',context);let sharp=0,fast=0;seed=789;for(let i=0;i<10000;i++){const g=game('hard');serve.call(g);if(Math.abs(g.ball.vx)>2)sharp++;if(g.ball.vy>=8.5)fast++;}assert.ok(sharp>6000);assert.ok(fast>3300&&fast<3700);
 console.log('Difficulty regression passed',stats,{sharp,fast});process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});


