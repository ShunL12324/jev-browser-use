// Host-driven Playwright proves fixture usability ONLY. Never a Jev benchmark.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.FIXTURE_URL||'http://127.0.0.1:17431';
const session=await fetch(`${base}/api/reset`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seed:'atlas',variant:'standard'})}).then(r=>r.json());
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const start=performance.now();
try{
 const d=session.taskData;await page.goto(base+session.url);const fill=(label,value,scope=page)=>scope.getByLabel(label,{exact:true}).fill(String(value));const select=(label,value,scope=page)=>scope.getByLabel(label,{exact:true}).selectOption(value);const next=()=>page.getByRole('button',{name:'Continue',exact:true}).click();
 await next();assert.equal(await page.getByRole('heading',{name:'Contact details'}).count(),1);
 for(const [key,label] of Object.entries({name:'Full name',email:'Email',phone:'Phone',address:'Street address',postal:'Postal code'}))await fill(label,d.personal[key]);
 await select('Country','United Kingdom');await select('City','London');await select('Country',d.personal.country);await select('City',d.personal.city);
 await page.getByText('Email available',{exact:true}).waitFor();await next();
 await page.getByRole('button',{name:/Target role/}).click();await page.getByRole('option',{name:d.preferences.role,exact:true}).click();await page.getByLabel(d.preferences.mode,{exact:true}).check();await fill('Expected annual salary',d.preferences.salary);await fill('Available start date',d.preferences.startDate);await select('Require sponsorship',d.preferences.sponsorship);await select('Visa category',d.preferences.visa);await next();
 await page.getByRole('button',{name:'Add work experience',exact:true}).click();await page.getByRole('button',{name:'Add work experience',exact:true}).click();await page.getByRole('button',{name:'Remove work experience 3',exact:true}).click();
 for(const [i,row] of d.experience.entries()){const group=page.getByRole('group',{name:`Work experience ${i+1}`,exact:true});for(const [key,label] of Object.entries({company:'Company',title:'Job title',start:'Start date',end:'End date',summary:'Responsibilities'}))await fill(label,row[key],group);}
 await page.getByRole('button',{name:'Add education',exact:true}).click();await page.getByRole('button',{name:'Remove education 2',exact:true}).click();
 const school=page.getByRole('group',{name:'Education 1',exact:true});for(const [key,label] of Object.entries({school:'School',subject:'Subject',year:'Graduation year'}))await fill(label,d.education[0][key],school);await select('Degree',d.education[0].degree,school);await next();
 for(const [i,row] of d.skills.entries()){await fill(`Skill ${i+1}`,row.name);await select(`Proficiency ${i+1}`,row.level);}await page.getByLabel('Résumé PDF',{exact:true}).setInputFiles(session.resume.path);await page.getByLabel('I consent to processing this application',{exact:true}).check();await next();
 await page.getByRole('button',{name:'Back',exact:true}).click();assert.match(await page.locator('.upload').innerText(),/atlas.pdf/);await next();
 assert.equal((await fetch(`${base}/api/oracle/${session.runId}`).then(r=>r.json())).submitted,false);
 await page.getByRole('button',{name:'Submit application',exact:true}).click();await page.getByRole('button',{name:'Keep editing',exact:true}).click();await page.getByRole('button',{name:'Submit application',exact:true}).click();await page.getByRole('button',{name:'Confirm and submit',exact:true}).click();await page.getByRole('heading',{name:'Application received'}).waitFor();
 const oracle=await fetch(`${base}/api/oracle/${session.runId}`).then(r=>r.json());assert.equal(oracle.passed,true);assert.equal(oracle.correctFields,32);assert.deepEqual(errors,[]);
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/mechanical.png',fullPage:true});const report={classification:'host mechanical; not Jev benchmark',seed:'atlas',variant:'standard',runId:session.runId,durationMs:Math.round(performance.now()-start),oracle,errors};await writeFile('artifacts/mechanical.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close()}
