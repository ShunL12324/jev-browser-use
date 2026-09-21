import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
export const seeds = {
  atlas: {personal:{name:'Alex Example',email:'alex@example.test',phone:'+1 202 555 0142',country:'Canada',city:'Toronto',address:'42 Sample Lane',postal:'M5V 2T6'},preferences:{role:'Frontend Engineer',mode:'Hybrid',salary:95000,startDate:'2027-02-15',sponsorship:'Yes',visa:'Work permit'},experience:[{company:'Sample Studio',title:'UI Engineer',start:'2021-03-01',end:'2023-06-30',summary:'Built accessible interfaces.'},{company:'Demo Systems',title:'Senior Engineer',start:'2023-07-01',end:'2026-08-31',summary:'Led component library development.'}],education:[{school:'Example Institute',degree:'Bachelor',subject:'Computer Science',year:2021}],skills:[{name:'React',level:'Advanced'},{name:'Testing',level:'Intermediate'}],consent:true},
  birch: {personal:{name:'Morgan Sample',email:'morgan@example.test',phone:'+44 7700 900123',country:'United Kingdom',city:'Manchester',address:'18 Fiction Road',postal:'M1 1AA'},preferences:{role:'Full Stack Engineer',mode:'Remote',salary:82000,startDate:'2027-03-22',sponsorship:'Yes',visa:'Skilled worker'},experience:[{company:'Fiction Labs',title:'Web Developer',start:'2020-09-01',end:'2022-12-31',summary:'Delivered internal web tools.'},{company:'Example Works',title:'Product Engineer',start:'2023-01-01',end:'2026-07-31',summary:'Improved forms and testing.'}],education:[{school:'Sample University',degree:'Master',subject:'Software Engineering',year:2020}],skills:[{name:'TypeScript',level:'Advanced'},{name:'SQL',level:'Intermediate'}],consent:true}
};
export const cities = {Canada:['Toronto','Vancouver','Montreal'],'United Kingdom':['London','Manchester','Edinburgh']};
export function resumeFor(seed) { const path=fileURLToPath(new URL(`./fixtures/${seed}.pdf`,import.meta.url)); const bytes=readFileSync(path); return {path,name:`${seed}.pdf`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,type:'application/pdf'}; }
export function flatten(value,prefix='') {return Object.fromEntries(Object.entries(value).flatMap(([k,v])=>{const p=prefix?`${prefix}.${k}`:k;return v!==null&&typeof v==='object'?Object.entries(flatten(v,p)):[[p,v]];}));}
function shapeErrors(expected,actual,path='payload') {
 if(expected===null||typeof expected!=='object')return [];
 if(actual===null||typeof actual!=='object'||Array.isArray(expected)!==Array.isArray(actual))return [path];
 const keys=Object.keys(expected),actualKeys=Object.keys(actual);
 const errors=actualKeys.filter(k=>!Object.hasOwn(expected,k)).map(k=>`${path}.${k}`);
 if(Array.isArray(expected)&&expected.length!==actual.length)errors.push(`${path}.length`);
 return errors.concat(keys.flatMap(k=>shapeErrors(expected[k],actual[k],`${path}.${k}`)));
}
export function checkSubmission(expected,payload,file,resume) {
 const a=flatten(expected), b=flatten(payload||{});
 const structureErrors=shapeErrors(expected,payload);
 const fieldChecks=Object.entries(a).map(([field,value])=>({field,expected:value,actual:Object.hasOwn(b,field)?b[field]:null,correct:Object.hasOwn(b,field)&&b[field]===value}));
 const unexpectedFields=Object.keys(b).filter(k=>!Object.hasOwn(a,k));
 const hash=file?createHash('sha256').update(file.buffer).digest('hex'):null;
 const upload={present:!!file,sha256:hash,size:file?.size||0,type:file?.mimetype||null,name:file?.originalname||null,expectedSha256:resume.sha256,expectedSize:resume.size,correct:!!file&&hash===resume.sha256&&file.mimetype==='application/pdf'&&file.size===resume.size};
 return {passed:fieldChecks.every(f=>f.correct)&&unexpectedFields.length===0&&structureErrors.length===0&&upload.correct,structureErrors,correctFields:fieldChecks.filter(f=>f.correct).length,totalFields:fieldChecks.length,fieldChecks,unexpectedFields,upload};
}
