import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { seeds, cities, resumeFor, checkSubmission } from './data.mjs';
export async function createApp({frontend=true}={}) {
 const app=express(),runs=new Map(); app.use(express.json({limit:'100kb'}));
 app.post('/api/reset',(req,res)=>{const {seed='atlas',variant='standard'}=req.body||{};if(!Object.hasOwn(seeds,seed)||!['standard','alternate'].includes(variant))return res.status(400).json({error:'Unknown seed or variant'});const runId=randomUUID();runs.set(runId,{seed,variant,attempts:0,result:null});res.json({runId,url:`/?run=${runId}`,taskData:seeds[seed],resume:resumeFor(seed),variant});});
 const run=(req,res,next)=>{req.run=runs.get(req.params.id);if(!req.run)return res.status(404).json({error:'Unknown run; create a session first'});next();};
 app.get('/api/task/:id',run,(req,res)=>res.json({taskData:seeds[req.run.seed],resume:resumeFor(req.run.seed)}));
 app.get('/api/session/:id',run,(req,res)=>res.json({variant:req.run.variant}));
 app.get('/api/cities',async(req,res)=>{await new Promise(r=>setTimeout(r,350));res.json(cities[req.query.country]||[]);});
 app.get('/api/email',async(req,res)=>{await new Promise(r=>setTimeout(r,300));res.json({available:typeof req.query.value==='string'&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(req.query.value)&&!req.query.value.startsWith('taken@')});});
 app.get('/api/oracle/:id',run,(req,res)=>res.json({submitted:req.run.attempts>0,attempts:req.run.attempts,...(req.run.result||checkSubmission(seeds[req.run.seed],{},null,resumeFor(req.run.seed)))}));
 app.post('/api/submit/:id',run,multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1,fields:1}}).single('resume'),(req,res)=>{
  let payload;try{payload=JSON.parse(req.body.payload);if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error();}catch{return res.status(400).json({error:'Invalid payload'});}
  req.run.attempts++;req.run.result=checkSubmission(seeds[req.run.seed],payload,req.file,resumeFor(req.run.seed));res.status(req.run.result.passed?200:422).json({accepted:req.run.result.passed,receipt: req.run.result.passed?randomUUID():null,error:req.run.result.passed?null:'Application does not match the supplied task. Review all fields and attachment.'});
 });
 app.use('/api',(_req,res)=>res.status(404).json({error:'Not found'}));
 let vite;if(frontend){vite=await createViteServer({root:fileURLToPath(new URL('.',import.meta.url)),server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
 app.use((err,_req,res,_next)=>res.status(400).json({error:err.message}));
 return {app,close:()=>vite?.close()};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const {app}=await createApp();const port=Number(process.env.PORT||17431);app.listen(port,'127.0.0.1',()=>console.log(`Complex forms: http://127.0.0.1:${port}`));}
