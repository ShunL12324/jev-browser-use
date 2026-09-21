import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createApp} from './server.mjs';
import {seeds,resumeFor,flatten} from './data.mjs';
test('independent HTTP oracle: exact fields, bytes, reset and negative submissions',async()=>{
 const {app}=await createApp({frontend:false});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
 const reset=async(seed='atlas')=>fetch(`${base}/api/reset`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seed})}).then(r=>r.json());
 const oracle=async id=>fetch(`${base}/api/oracle/${id}`).then(r=>r.json());
 const submit=async(id,payload,fileSeed='atlas',withFile=true)=>{const body=new FormData();body.append('payload',JSON.stringify(payload));if(withFile)body.append('resume',new Blob([readFileSync(resumeFor(fileSeed).path)],{type:'application/pdf'}),`${fileSeed}.pdf`);return fetch(`${base}/api/submit/${id}`,{method:'POST',body});};
 let {runId}=await reset();let result=await oracle(runId);assert.equal(result.submitted,false);assert.equal(result.passed,false);assert.equal(result.totalFields,32);
 assert.equal((await submit(runId,{})).status,422);result=await oracle(runId);assert.equal(result.passed,false);assert.equal(result.correctFields,0);
 await submit(runId,{...seeds.atlas,personal:{...seeds.atlas.personal,name:'Wrong'}});result=await oracle(runId);assert.equal(result.correctFields,31);assert.equal(result.passed,false);
 await submit(runId,seeds.atlas,'birch');result=await oracle(runId);assert.equal(result.correctFields,32);assert.equal(result.upload.correct,false);assert.equal(result.passed,false);
 await submit(runId,seeds.atlas,'atlas',false);assert.equal((await oracle(runId)).passed,false);
 await submit(runId,{...seeds.atlas,extra:'unauthorized'});assert.equal((await oracle(runId)).passed,false);
 await submit(runId,{...seeds.atlas,extra:{}});assert.equal((await oracle(runId)).passed,false);
 const extraRow=structuredClone(seeds.atlas);extraRow.experience.push({});await submit(runId,extraRow);assert.equal((await oracle(runId)).passed,false);
 const wrongShape=structuredClone(seeds.atlas);wrongShape.experience={...wrongShape.experience};await submit(runId,wrongShape);assert.equal((await oracle(runId)).passed,false);
 const wrongType=structuredClone(seeds.atlas);wrongType.preferences.salary='95000';await submit(runId,wrongType);assert.equal((await oracle(runId)).passed,false);
 for(const seed of Object.keys(seeds)){const session=await reset(seed);assert.equal(Object.keys(flatten(session.taskData)).length,32);assert.equal((await submit(session.runId,session.taskData,seed)).status,200);result=await oracle(session.runId);assert.equal(result.passed,true);assert.equal(result.upload.size,resumeFor(seed).size);}
 const fresh=await reset();assert.equal((await oracle(fresh.runId)).submitted,false);
 }finally{await new Promise(r=>server.close(r));}
});
