import './runtime-env.ts';
import { Sandbox } from 'microsandbox';
import { writeFile } from 'node:fs/promises';
const command=async(type:string)=>{const r=await fetch('http://localhost:4317/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type})});if(!r.ok)throw new Error(await r.text());};
const before=await(await fetch('http://localhost:4317/api/session')).json() as any;
await command('pause');
try{
 const s=await(await fetch('http://localhost:4317/api/session')).json()as any;
 const parent=await(await Sandbox.get(s.mainId)).connect();
 const name='mom-progression-probe-'+Date.now().toString(36);
 const child=await parent.branch(name);
 await writeFile('/tmp/mom-progression-probe.json',JSON.stringify({name,identity:child.id,state:s.worlds.find((w:any)=>w.id===s.mainId).state,stats:s.worlds.find((w:any)=>w.id===s.mainId).stats}));
 console.log(name);
}finally{if(before.running)await command('resume');}
