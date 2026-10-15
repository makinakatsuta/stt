// Quantitative integration simulation. Run from the repository root.
// 4 independent seed streams, 50 best-of-three matches each, per difficulty.
// The policy sees only delayed current x/y/direction, never shot plans or future
// positions. 300ms sensory delay, 200ms observations, half-speed tilt movement,
// one swing per incoming flight with an independent 8% execution lapse.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
globalThis.crypto = require('node:crypto').webcrypto;
require('../docs/wasm_exec.js');
const baseline = process.argv.includes('--baseline');
const jsOnly = process.argv.includes('--js-only') || baseline;
const quick = process.argv.includes('--quick');
const sensitivityOnly = process.argv.includes('--sensitivity-only');
const read = file => baseline ? cp.execFileSync('git', ['show', 'HEAD:' + file], {encoding:'utf8'}) : fs.readFileSync(file,'utf8');
let physicsSeed, playerSeed, now = 1000;
const next = s => (Math.imul(s,1664525)+1013904223) >>> 0;
const random = () => ((physicsSeed=next(physicsSeed))/4294967296);
const playerRandom = () => ((playerSeed=next(playerSeed))/4294967296);
const quiet = new Proxy({}, {get:()=>()=>{}});
const ctx = vm.createContext({Math:Object.assign(Object.create(Math),{random}),
  Date:{now:()=>now}, window:{}, document:{getElementById:()=>null},
  sounds:quiet, narrator:quiet, console:{debug(){},error(e){throw e;}}});
vm.runInContext(read('docs/js/constants.js').replace(/export \{[^}]+\};/,'')+'\n'+
  read('docs/js/game-engine.js').replace(/^import .*;\r?\n/gm,'').replace('export class','class')+
  '\nglobalThis.Engine=GameEngine;',ctx);
function game(difficulty) {
  const g=Object.create(ctx.Engine.prototype);
  Object.assign(g,{difficulty,role:1,mode:'cpu',keys:{},ball:{},p1:{x:350},p2:{x:350},
    scores:{p1:0,p2:0},gameScores:{p1:0,p2:0},maxScore:11,matchGames:3,serverRole:1,
    useTilt:true,tiltSpeed:0.5,gameStartTime:now,tasks:[],
    scheduleGameplayTask(fn,delay){this.tasks.push({fn,at:now+delay});return fn;},
    clearGameplayTasks(){this.tasks=[];},cancelGameplayTask(fn){this.tasks=this.tasks.filter(t=>t.fn!==fn);},
    net:{send(){},paddleLastSent:now},finishMatch(winner){this.winner=winner;this.tasks=[];}});
  for(const method of ['updateScoreboard','updateServerDisplay','addRipple','syncPaddlePosition','setGameplayChromeHidden'])g[method]=()=>{};
  return g;
}
function task(g) {
  assert.ok(g.tasks.length,'service task exists');
  g.tasks.sort((a,b)=>a.at-b.at);
  const t=g.tasks.shift();now=t.at;t.fn();
}
function startRally(g,type) {
  if(g.state!=='SERVE_SELECT' && g.state!=='PRE_SERVE_READY')g.prepareServeSequence();
  if(g.serverRole===1){g.selectServeType(type);now+=350;g.handleActionInput();task(g);now+=350;g.handleActionInput();}
  else {task(g);now+=350;g.handleActionInput();task(g);}
  assert.equal(g.state,'RALLY');
}
function rally(g,policy='standard') {
  let history=[],observation={x:400,y:250,vy:0},target=350,swung=false,incoming=false,returns=0;
  for(let frame=0;frame<12000 && g.state==='RALLY';frame++){
    now+=1000/60;
    history.push({x:g.ball.x,y:g.ball.y,vy:g.ball.vy});
    const delay=policy==='slow'?36:policy==='skilled'?12:18;
    if(frame%12===0 && history.length>delay){observation=history[history.length-1-delay];target=observation.x-50;}
    if(history.length>60)history.shift();
    g.keys=policy==='idle'?{}:{ArrowLeft:g.p1.x>target+10,ArrowRight:g.p1.x<target-10};
    if(observation.vy<=0){incoming=false;swung=false;}
    else incoming=true;
    if(policy!=='idle' && incoming && !swung && observation.y>=280){
      swung=true;
      if(playerRandom()>=0.08){g.handleActionInput();if(g.ball.vy<0)returns++;}
    }
    g.updatePhysics();
  }
  assert.equal(g.state,'POINT_WON','rally must terminate');
  return returns;
}
function match(d,policy,index){
  const g=game(d);let points=0,returns=0;const serveCounts=[0,0,0];
  while(!g.winner){
    const type=1+(index+points)%3;
    startRally(g,type);if(g.serverRole===1)serveCounts[type-1]++;
    returns+=rally(g,policy);points++;
    assert.ok(points<400,'match terminates');
    const skip=g.intervalSkipCallback;g.intervalSkipCallback=null;skip();
    if(!g.winner && g.state==='POINT_WON')task(g);
  }
  return {winner:g.winner,points,returns,serveCounts};
}
(async()=>{
  if(!jsOnly){const go=new Go();const {instance}=await WebAssembly.instantiate(fs.readFileSync('docs/main.wasm'),go.importObject);go.run(instance);}
  const results={};
  for(const backend of jsOnly?['js']:['js','wasm']){
    ctx.window.updatePhysicsWasm=backend==='wasm'?globalThis.updatePhysicsWasm:undefined;
    results[backend]=sensitivityOnly ? JSON.parse(fs.readFileSync('tests/fixtures/player-win-rate-3.31.58.json','utf8')).after.results[backend] : {};
    for(const d of sensitivityOnly?[]:['easy','normal','hard']){
      const groups=[];
      for(const seed of [456,20261016,1729,8675309]){
        now=1000;physicsSeed=seed;playerSeed=seed^0x5a5a5a5a;
        let wins=0,points=0,returns=0,serveCounts=[0,0,0];
        for(let i=0;i<(quick?5:50);i++){
          const r=match(d,'standard',i);wins+=r.winner===1;points+=r.points;returns+=r.returns;
          serveCounts=serveCounts.map((n,j)=>n+r.serveCounts[j]);
        }
        groups.push({seed,wins,matches:quick?5:50,points,returns,serveCounts});
      }
      const wins=groups.reduce((s,r)=>s+r.wins,0),matches=groups.reduce((s,r)=>s+r.matches,0);
      results[backend][d]={wins,matches,rate:wins/matches,groups};
      console.log(backend,d,JSON.stringify(results[backend][d]));
    }
    // Change only sensory latency; skill must affect the actual match results.
    if(!baseline && !quick){
      const sensitivity={};
      for(const policy of ['slow','skilled']){
        let wins=0,points=0,returns=0;
        for(const seed of [456,20261016,1729,8675309]){
          now=1000;physicsSeed=seed;playerSeed=seed^0x5a5a5a5a;
          for(let i=0;i<10;i++){const r=match('hard',policy,i);wins+=r.winner===1;points+=r.points;returns+=r.returns;}
        }
        sensitivity[policy]={wins,matches:40,points,returns};
      }
      assert.ok(sensitivity.slow.wins/40<results[backend].hard.rate,'slower reactions reduce wins');
      assert.ok(sensitivity.skilled.wins/40>results[backend].hard.rate,'better reactions improve wins');
      results[backend].sensitivity=sensitivity;
      console.log(backend,'skill sensitivity',JSON.stringify(sensitivity));
    }
    // Negative control: a stationary, silent player must lose naturally.
    for(const d of ['easy','normal','hard']){
      physicsSeed=73;playerSeed=93;const g=game(d);g.serverRole=2;startRally(g,1);
      rally(g,'idle');assert.equal(g.scores.p2,1);assert.equal(g.normalReturnCount||0,0);
    }
  }
  if(!baseline && !quick){for(const r of Object.values(results)){
    assert.ok(r.normal.wins>=190,'Normal >=190/200');assert.ok(r.hard.wins>=150,'Hard >=150/200');
    assert.ok(r.normal.wins>=r.hard.wins+10,'Normal clearly easier');
  }}
  if(!jsOnly)assert.deepEqual(results.js,results.wasm,'same seeds produce identical complete matches');
  if(process.env.STT_WIN_REPORT)fs.writeFileSync(process.env.STT_WIN_REPORT,JSON.stringify({baseline,policy:{delayMs:300,observationMs:200,executionLapse:0.08,tiltRatio:0.5},results},null,2)+'\n');
  console.log('Win-rate simulation passed.');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
