import { resolve } from "node:path";
import type { Sandbox } from "microsandbox";

// Upgrade only the observation/control wrapper. The running WASM instance,
// heap, game tick, and framebuffer remain owned by the existing process.
export async function upgradeBridge(sandbox: Sandbox): Promise<void> {
  await sandbox
    .fs()
    .copyFromHost(resolve("dist/engine.mjs"), "/game/engine-progression.mjs");
  const result = await sandbox.exec("node", [
    "--input-type=module",
    "-e",
    `
    import fs from 'node:fs';
    const deadline=setTimeout(()=>{console.error('Bridge upgrade timed out');process.exit(1);},30000);
    const pid = fs.readdirSync('/proc').filter(n => /^\\d+$/.test(n)).find(n => {
      try { return fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0').includes('/game/bridge.mjs'); } catch { return false; }
    });
    if (!pid) throw new Error('Running game bridge not found');
    process.kill(Number(pid), 'SIGUSR1');
    let endpoint;
    for (let i=0;i<30;i++) {
      try { endpoint=(await (await fetch('http://127.0.0.1:9229/json/list')).json())[0]?.webSocketDebuggerUrl; if(endpoint)break; } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    if(!endpoint)throw new Error('Cannot attach to guest-local bridge inspector');
    const ws=new WebSocket(endpoint); await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let sequence=0; const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const props=async id=>(await send('Runtime.getProperties',{objectId:id,ownProperties:true}));
    try {
      const handler=await send('Runtime.evaluate',{expression:"process._getActiveHandles().find(h=>h.constructor.name==='Server').listeners('request')[0]"});
      const info=await props(handler.result.objectId);
      const scopes=await props(info.internalProperties.find(p=>p.name==='[[Scopes]]').value.objectId);
      let game;
      for(const scope of scopes.result){if(!scope.value?.objectId)continue;const fields=await props(scope.value.objectId);game=fields.result.find(p=>p.name==='game')?.value.objectId;if(game)break;}
      if(!game)throw new Error('Cannot locate running engine; no state changed');
      const upgraded=await send('Runtime.callFunctionOn',{objectId:game,returnByValue:true,functionDeclaration:\`function(){
        const before=this.state(), frame=this.frame(), old=Object.getPrototypeOf(this);
        const Engine=process.getBuiltinModule('module').createRequire('/game/bridge.mjs')('/game/engine-progression.mjs').DoomEngine;
        try {
          Object.setPrototypeOf(this,Engine.prototype);
          const after=this.state();
          for(const key of Object.keys(before)) if(!['keys','keyPickups','progressEvents'].includes(key) && JSON.stringify(before[key])!==JSON.stringify(after[key])) throw new Error('Upgrade changed '+key);
          if(!frame.equals(this.frame()))throw new Error('Upgrade changed framebuffer');
          if(!Array.isArray(after.keys))throw new Error('Upgrade did not expose inventory');
          return {tick:after.tick,keys:after.keys,preserved:true};
        } catch(error){Object.setPrototypeOf(this,old);throw error;}
      }\`});
      if(upgraded.exceptionDetails)throw new Error(JSON.stringify(upgraded.exceptionDetails));
      console.log(JSON.stringify(upgraded.result.value));
    } finally {
      await send('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('inspector').close(),100)"}).catch(()=>{});
      ws.close(); clearTimeout(deadline);
    }
  `,
  ]);
  if (!result.success)
    throw new Error(
      `Game bridge upgrade failed without restarting gameplay: ${result.stderr()}`,
    );
}
