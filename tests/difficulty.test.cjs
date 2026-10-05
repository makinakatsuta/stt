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
function accepts(difficulty, role, dx, dy, mode = 'cpu') {
 const g = game(difficulty, role);
 g.ball.x = 400 + dx;
 g.ball.y = (role === 1 ? 400 : 100) + dy;
 g.ball.vy = role === 1 ? 6 : -6;
 g.mode = mode;
 g.net = {send(){}};
 return g.tryPlayerReturn();
}
assert.equal(vm.runInContext('HARD_DIFFICULTY_FACTOR', context), 0.9);
assert.equal(vm.runInContext('NORMAL_PADDLE_SPEED', context), 11);
for (const role of [1, 2]) for (const sign of [-1, 1]) {
 assert.equal(accepts('hard', role, 0, sign * 94.999), true);
 assert.equal(accepts('hard', role, 0, sign * 95), false);
 assert.equal(accepts('normal', role, 0, sign * 85.5), true);
 assert.equal(accepts('normal', role, 0, sign * 89.999), true);
 assert.equal(accepts('normal', role, 0, sign * 104.999), true);
 assert.equal(accepts('normal', role, 0, sign * 105), false);
 assert.equal(accepts('easy', role, 0, sign * 129.999), true);
 assert.equal(accepts('easy', role, 0, sign * 130), false);
 assert.equal(accepts('hard', role, sign * 100, 0), true);
 assert.equal(accepts('hard', role, sign * 100.001, 0), false);
 assert.equal(accepts('normal', role, sign * 100, 0), true);
 assert.equal(accepts('normal', role, sign * 100.001, 0), false);
 assert.equal(accepts('easy', role, sign * 105, 0), true);
 assert.equal(accepts('easy', role, sign * 105.001, 0), false);
 // Online keeps the original Normal acceptance boundaries.
 assert.equal(accepts('normal', role, 0, sign * 89.999, 'online'), true);
 assert.equal(accepts('normal', role, 0, sign * 90, 'online'), false);
 assert.equal(accepts('normal', role, sign * 95, 0, 'online'), true);
 assert.equal(accepts('normal', role, sign * 95.001, 0, 'online'), false);
}
assert.equal(vm.runInContext('HARD_HIT_ZONE', context), 95);
assert.equal(vm.runInContext('HARD_PADDLE_MARGIN', context), 50);
// Freeze all existing Normal constants, acceptance and deterministic plans.
const normalConstants={NORMAL_PADDLE_SPEED:11,NORMAL_CPU_SPEED:5.2,NORMAL_HIT_ZONE:105,NORMAL_PADDLE_MARGIN:40,NORMAL_RETURN_MAX_SPEED:7.5,NORMAL_OUT_SPEED:13,NORMAL_SERVE_SPEED_FACTOR:1.10,NORMAL_FAST_SERVE_CHANCE:0.15,NORMAL_FAST_SERVE_VY_MIN:8.5,NORMAL_FAST_SERVE_VY_MAX:9.5,STANDARD_RALLY_ACCELERATION:1.02,STANDARD_RALLY_MAX_SPEED:13,NORMAL_SIDE_OUT_CHANCE:0.15};
for(const [name,value] of Object.entries(normalConstants))assert.equal(vm.runInContext(name,context),value,name);
for(const snapshot of JSON.parse(fs.readFileSync('tests/fixtures/normal-balance.json','utf8'))){
 const {role,count,x}=snapshot;seed=100+role+count+x;
 const g=game('normal',role);g.normalReturnCount=count;g.ball.x=x;g.ball.vx=3;g.prepareNormalCpuShot();
 assert.equal(g.ball.normalTargetX,snapshot.target);assert.equal(g.ball.normalSpeed,snapshot.speed);assert.equal(g.ball.normalReturnChance,snapshot.chance);
}
assert.equal(vm.runInContext('HARD_RALLY_ACCELERATION',context),1.03);
assert.equal(vm.runInContext('HARD_RALLY_MAX_SPEED',context),14);
// Reproducible Bernoulli sampling of the shared plan, without contact retries.
const sampledRates=[];
for(const count of [0,12]) {
 seed=20261006;let hits=0;
 for(let i=0;i<10000;i++) {
  const g=game('hard');g.normalReturnCount=count;
  g.ball.vy=-9;g.p2.x=i%2?10:350;g.prepareNormalCpuShot();
  if(random()<g.ball.normalReturnChance)hits++;
 }
 const rate=hits/10000;sampledRates.push(rate);
 assert.ok(rate>=(count===0?.92:.87) && rate<=(count===0?.96:.92), 'Hard sampled rate '+rate);
 assert.ok(hits<10000 && hits>8700,'CPU misses without becoming weak');
}
assert.ok(sampledRates[1]<sampledRates[0],'Long rallies increase misses');
for(const count of [0,2,4,6,12])for(let i=0;i<1000;i++){
 const g=game('hard');g.normalReturnCount=count;g.prepareNormalCpuShot();
 const min=count===0?7.5:count<6?7.8:8.2,max=count===0?8.2:count<6?8.8:9.5;
 assert.ok(g.ball.normalSpeed>=min && g.ball.normalSpeed<=max);
 assert.ok(g.ball.normalReturnChance<=0.955 && g.ball.normalReturnChance>=0.88);
 assert.notEqual(g.ball.normalReturnChance,0.99);
 if(count>=12)assert.ok(g.ball.normalReturnChance<=0.91);
}
// Good placement and longer rallies reduce Hard returns on either side.
for(const role of [1,2]){
 const chances=[];
 for(const count of [0,2,6,12,24]){
  const aligned=game('hard',role),moved=game('hard',role);
  for(const g of [aligned,moved]){g.normalReturnCount=count;g.ball.y=role===1?130:370;g.ball.x=400;}
  moved[role===1?'p2':'p1'].x=10;
  aligned.prepareNormalCpuShot();moved.prepareNormalCpuShot();
  assert.ok(moved.ball.normalReturnChance<aligned.ball.normalReturnChance,'placement rewards movement');
  const fixed=moved.ball.normalReturnChance;moved.prepareNormalCpuShot();assert.equal(moved.ball.normalReturnChance,fixed);
  chances.push(aligned.ball.normalReturnChance);
  if(count>=12)assert.ok(moved.ball.normalReturnChance>=.88 && aligned.ball.normalReturnChance<=.91);
 }
 assert.ok(chances[0]===chances[1] && chances[1]>chances[2] && chances[2]>chances[3]);
 assert.equal(chances[3],chances[4]);
}
// Force attack/non-attack choices to test their separate bounds and frequency.
const seededRandom=context.Math.random;
for(const attack of [false,true]){
 const values=[0.999999,attack?0.299999:0.3,0.999999,0.5,0.5];
 context.Math.random=()=>values.shift()??0.5;
 const g=game('hard');g.normalReturnCount=6;g.p1.x=50;g.prepareNormalCpuShot();
 const delta=g.ball.normalTargetX-400;
 assert.ok(delta<=(attack?160:150));assert.ok(delta>(attack?159:149));
}
context.Math.random=seededRandom;
let attacks=0;seed=101;
for(let i=0;i<10000;i++){const g=game('hard');g.normalReturnCount=6;g.p1.x=50;g.prepareNormalCpuShot();if(g.ball.normalTargetX-400>=130)attacks++;}
// Positive courses >=130 include 30% attacks plus ~4.7% random courses.
assert.ok(attacks>3200 && attacks<3800,'late attack mix '+attacks);
// Fast incoming shots must not exceed the stage-specific CPU speed cap.
for (const role of [1, 2]) for (let i = 0; i < 100; i++) {
 for (const d of ['normal', 'hard']) {
  const g = game(d, role);g.ball.vy = role === 1 ? -20 : 20;
  g.prepareNormalCpuShot();
  if (d === 'normal') assert.equal(g.ball.normalSpeed, 7.5);
  else assert.ok(g.ball.normalSpeed >= 7.5 && g.ball.normalSpeed <= 8.2);
 }
 for (const [d, mode] of [['easy', 'cpu'], ['normal', 'online'], ['hard', 'online']]) {
  const g = game(d, role);g.mode = mode;g.prepareNormalCpuShot();
  assert.equal(g.ball.normalSpeed, undefined);
 }
}

// Local course limits apply to reflected arrival positions, on both sides.
for (const role of [1,2]) for (const count of [0,2,4,6,12]) {
 const peaks={};
 for (const d of ['normal','hard']) {
  let peak=0;
  for(let i=0;i<500;i++) {
   const g=game(d,role);g.normalReturnCount=count;
   g.ball.x=[30,400,770][i%3];g.ball.vx=i%2?3:-3;
   const arrival=vm.runInContext('predictedBallX',context)(g.ball.x,g.ball.y,g.ball.vx,g.ball.vy,role===1?100:400);
   g.prepareNormalCpuShot();
   const delta=Math.abs(g.ball.normalTargetX-arrival);
   const limit=count===0?(d==='normal'?15:30):count<6?(d==='normal'?80:90):(d==='normal'?120:160);
   assert.ok(delta<=limit+1e-9,d+' course '+count);
   const target=g.ball.normalTargetX;g.prepareNormalCpuShot();assert.equal(g.ball.normalTargetX,target);
   peak=Math.max(peak,delta);
  }
  peaks[d]=peak;
 }
 if(count>=6)assert.ok(peaks.hard>150 && peaks.hard>peaks.normal);
}
// A practiced virtual player samples position every 30 frames (~500ms).
// Hard should remain beatable with this policy, without changing game tuning.
seed=456;let practicedWins=0;
for(let match=0;match<40;match++){
 let p=0,c=0;
 while(Math.max(p,c)<11 || Math.abs(p-c)<2){
  const g=game('hard');g.useTilt=true;g.tiltSpeed=0.5;let target=350;
  for(let frame=0;frame<50000 && !g.winner;frame++){
   if(frame%30===0)target=g.ball.x-50;
   g.keys={ArrowLeft:g.p1.x>target+10,ArrowRight:g.p1.x<target-10};g.updatePhysics();
   if(frame%6===0 && random()<0.96 && g.ball.y>=400)g.tryPlayerReturn();
  }
  assert.ok(g.winner,'practiced Hard rally terminates');if(g.winner===1)p++;else c++;
  assert.ok(p+c<=150,'practiced Hard match terminates');
 }
 if(p>c)practicedWins++;
}
assert.ok(practicedWins>0 && practicedWins<40,'Hard is beatable but challenging with practiced pursuit');
console.log('JS practiced Hard player wins / 40:',practicedWins);

(async()=>{
 const go=new Go();const {instance}=await WebAssembly.instantiate(fs.readFileSync('docs/main.wasm'),go.importObject);go.run(instance);
 for(const d of ['easy','normal','hard']) for(const role of [1,2]) for(const ratio of [0,0.5,1]){
  const a=game(d,role),b=game(d,role);a.ball.active=b.ball.active=false;a.useTilt=b.useTilt=true;a.tiltSpeed=b.tiltSpeed=ratio;a.keys=b.keys={ArrowRight:true};context.window.updatePhysicsWasm=undefined;a.updatePhysics();context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();assert.equal(a['p'+role].x,b['p'+role].x,`${d} movement ${role}/${ratio}`);if(d!=='easy')assert.equal(a['p'+role].x,350+11*ratio,'Normal/Hard responsive movement');
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
 // Execute identical fixed plans at CPU contact, including later rally angles.
 for(const d of ['normal','hard'])for(const role of [1,2])for(const count of [0,2,6,12]) {
  const a=game(d,role);a.normalReturnCount=count;a.ball.x=400;
  a.ball.y=role===1?106:394;a.prepareNormalCpuShot();a.ball.normalReturnChance=1;
  const b=game(d,role);b.normalReturnCount=count;b.ball={...a.ball};
  context.window.updatePhysicsWasm=undefined;a.updatePhysics();
  context.window.updatePhysicsWasm=globalThis.updatePhysicsWasm;b.updatePhysics();
  assert.ok(a.ball.vy*(role===1?1:-1)>0,'CPU contact occurs');
  for(const key of ['vx','vy'])assert.ok(Math.abs(a.ball[key]-b.ball[key])<1e-10,'shared plan '+d+'/'+role+'/'+count+'/'+key);
 }
 const goSource=fs.readFileSync('main_wasm.go','utf8').split('func calculateRallyReturnVelocity')[0];
 const jsNames=[...(''+source+fs.readFileSync('docs/js/constants.js','utf8')).matchAll(/const (\w+) =/g)].map(m=>m[1]);
 for(const m of goSource.matchAll(/\t(\w+)\s+=\s+([0-9.]+)\s*\n/g)){
  const name=jsNames.find(n=>n.replaceAll('_','').toLowerCase()===m[1].toLowerCase());
  if(name)assert.equal(vm.runInContext(name,context),Number(m[2]),'JS/WASM parameter '+name);
 }
 const stats={};
 for(const d of ['easy','normal','hard']){
  seed=123;let hits=0,effort=0,straight=0,movement=0;
  for(let i=0;i<4000;i++){
   const g=game(d);g.normalReturnCount=(i%4)*2;g.p1.x=80+(i%6)*100;g.ball.x=300+(i%3)*100;g.p2.x=10+(i%7)*100;g.prepareNormalCpuShot();
   if(d==='easy'){if(random()<0.9)hits++;const v=context.velocity(0,6,0,d,1);effort+=Math.max(0,Math.abs(g.ball.x-(g.p1.x+50))-105)*v.vy/300/11.5;continue;}
   if(random()<g.ball.normalReturnChance)hits++;
   const v=vm.runInContext('normalCpuVelocity',context)(g.ball,1);const target=g.ball.x+v.vx*300/v.vy;
   movement+=Math.max(0,Math.abs(target-(g.p1.x+50))-100);
   effort+=Math.max(0,Math.abs(target-(g.p1.x+50))-100)*Math.abs(v.vy)/300/11;if(Math.abs(v.vx)<0.5)straight++;
   // Same shared shot plan is consumed by both physical engines, on either side.
   if(i<40) for(const role of [1,2]){
    g.role=role;g.ball.x=400;g.p1.x=g.p2.x=350;g.ball.y=role===1?106:394;g.ball.vy=role===1?-6:6;
    const result=globalThis.updatePhysicsWasm(g.ball,g.p1,g.p2,{},'cpu','RALLY',role,d,1000,1);
    if(result.events.some(e=>e.type==='ball_hit')){const expected=vm.runInContext('normalCpuVelocity',context)(g.ball,role===1?1:-1);assert.ok(Math.abs(result.ball.vx-expected.vx)<1e-10);assert.ok(Math.abs(result.ball.vy-expected.vy)<1e-10);}
   }
  }
  stats[d]={hits,effort,straight,movement};
 }
 assert.ok(stats.easy.hits<stats.normal.hits);assert.ok(stats.normal.effort>stats.easy.effort && stats.hard.effort>stats.normal.effort);assert.ok(stats.hard.movement>stats.normal.movement,'Hard requires more lateral travel');assert.ok(stats.hard.straight<=stats.normal.straight);assert.ok(stats.hard.effort<stats.normal.effort*2,'Hard movement effort below twice Normal');assert.ok(stats.hard.movement<stats.normal.movement*2,'Hard required lateral travel below twice Normal');
 // Actual frame simulation, same delayed virtual player and keyboard policy.
 for(const backend of ['js','wasm']){
  context.window.updatePhysicsWasm=backend==='wasm'?globalThis.updatePhysicsWasm:undefined;
  const actualReturns={};
  for(const d of ['easy','normal','hard']){let hits=0;
   for(let i=0;i<4000;i++){const g=game(d,i%2+1);g.ball.x=400;g.ball.y=g.role===1?106:394;g.ball.vy=g.role===1?-6:6;g.updatePhysics();if(g.ball.vy*(g.role===1?1:-1)>0)hits++;}
   actualReturns[d]=hits;
  }
  assert.ok(actualReturns.easy<actualReturns.normal,JSON.stringify(actualReturns));
  assert.ok(actualReturns.hard>=3700 && actualReturns.hard<3900,'Hard early CPU returns remain strong but fallible: '+actualReturns.hard);
  const fatigueReturns={};
  for(const count of [0,12]){
   let hits=0;
   for(let i=0;i<4000;i++){
    const g=game('hard',i%2+1);g.normalReturnCount=count;
    g.ball.x=400;g.ball.y=g.role===1?106:394;g.ball.vy=g.role===1?-6:6;g.updatePhysics();
    if(g.ball.vy*(g.role===1?1:-1)>0)hits++;
   }
   fatigueReturns[count]=hits;
  }
  assert.ok(fatigueReturns[0]-fatigueReturns[12]>100,backend+' fatigue causes more CPU misses');
  console.log(backend,'Hard CPU returns before/after fatigue / 4000:',fatigueReturns);
  console.log(backend,'CPU returns / 4000 (after Easy grace):',actualReturns);
  if(process.argv.includes('--contracts-only') || (backend==='wasm' && process.argv.includes('--js-only')))continue;
  const wins={},points={};
  for(const d of ['easy','normal','hard']){seed=456;let won=0,totalPlayerPoints=0;
   for(let match=0;match<200;match++){let p=0,c=0;
    while(Math.max(p,c)<11 || Math.abs(p-c)<2){const g=game(d);g.useTilt=true;g.tiltSpeed=0.5;g.ball.easyReturnCount=0;let target=350;
     for(let frame=0;frame<50000 && !g.winner;frame++){
      // Sample audio position once a second to model delayed pursuit.
      if(frame%60===0)target=g.ball.x-50;g.keys={ArrowLeft:g.p1.x>target+10,ArrowRight:g.p1.x<target-10};g.updatePhysics();
      if(frame%6===0 && random()<0.96 && g.ball.y>=400)g.tryPlayerReturn();
     }
     assert.ok(g.winner,'rally terminates '+backend+' '+d+' '+JSON.stringify(g.ball));if(g.winner===1)p++;else c++;if(p+c>150)throw Error('match fails to terminate');
    }totalPlayerPoints+=p;if(p>c)won++;
   }wins[d]=won;points[d]=totalPlayerPoints;console.log(backend,d,'completed',won,'wins,',totalPlayerPoints,'points');
  }console.log(backend,'player wins / 200:',wins,'points:',points);assert.ok(wins.hard>0,'Hard zero wins is unacceptable');assert.ok(wins.hard>=3,'Hard must provide a realistic chance of winning');assert.ok(wins.hard<wins.normal);assert.ok(wins.easy>wins.normal);assert.ok(wins.normal>wins.hard+10,'Hard player win rate statistically lower');
  assert.ok(points.hard>=600,'Hard player averages at least three points per match');
  assert.ok(points.hard<points.normal,'Hard scoring remains more difficult than Normal');
  // Keep the original slow policy above; independently test improvement.
  seed=456;let skilledWins=0,skilledPoints=0;
  for(let match=0;match<200;match++){
   let p=0,c=0;
   while(Math.max(p,c)<11 || Math.abs(p-c)<2){
    const g=game('hard');g.useTilt=true;g.tiltSpeed=0.5;let target=350;
    for(let frame=0;frame<50000 && !g.winner;frame++){
     if(frame%30===0)target=g.ball.x-50;
     g.keys={ArrowLeft:g.p1.x>target+10,ArrowRight:g.p1.x<target-10};g.updatePhysics();
     if(frame%6===0 && random()<0.96 && g.ball.y>=400)g.tryPlayerReturn();
    }
    assert.ok(g.winner,'skilled Hard rally terminates');if(g.winner===1)p++;else c++;
    assert.ok(p+c<=150,'skilled Hard match terminates');
   }
   skilledPoints+=p;if(p>c)skilledWins++;
  }
  assert.ok(skilledPoints>points.hard && skilledWins>wins.hard,'Hard scoring and skill progression');
  assert.ok(skilledWins>=40 && skilledWins<wins.normal,'Practiced Hard player can win while Hard stays harder than Normal');
  console.log(backend,'skilled Hard player / 200:',{wins:skilledWins,points:skilledPoints});
 }
 // Execute the CPU serve branch, including all following statements.
 const start=source.indexOf('// 難易度に応じてサーブの速度や角度を調整');const end=source.indexOf("this.addRipple(this.ball.x, this.ball.y, 'serve');",start);
 const serve=vm.runInContext('(function(){'+source.slice(start,end)+'})',context);
 const serveStats={straight:0,left:0,right:0,slow:0,standard:0,fast:0};seed=789;
 for(let i=0;i<10000;i++){
  const g=game('hard');serve.call(g);const {vx,vy}=g.ball;
  assert.ok(Math.abs(vx)<=2.5 && vy>=4.2 && vy<=8.8);
  if(Math.abs(vx)<=0.4)serveStats.straight++;else {assert.ok(Math.abs(vx)>=1);serveStats[vx<0?'left':'right']++;}
  if(vy<=5)serveStats.slow++;else if(vy<7.5){assert.ok(vy>=5.8 && vy<=6.8);serveStats.standard++;}else serveStats.fast++;
 }
 for(const [name,rate] of Object.entries({straight:.5,left:.25,right:.25,slow:.15,standard:.6,fast:.25}))assert.ok(Math.abs(serveStats[name]/10000-rate)<.025,name+' distribution');
 console.log('Difficulty regression passed',stats,serveStats);process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
