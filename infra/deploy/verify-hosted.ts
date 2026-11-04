import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createCanvas } from '../../packages/grounding/node_modules/@napi-rs/canvas/index.js';
import { PDFDocument, StandardFonts } from '../../apps/api/node_modules/pdf-lib/cjs/index.js';
import { ConvexStore } from '../../packages/db/src/index.js';
import { embedQuery } from '../../packages/grounding/src/index.js';
import { createLesson } from '../../packages/tutor-core/src/index.js';

const environment = process.argv.includes('--production') ? 'production' : 'preview';
if (!process.argv.includes('--run')) throw new Error('Explicit --run is required. This creates and deletes only an isolated verification owner.');
const env = parseEnv(await readFile(new URL(`../../.tokai/cloud/${environment}-api.env`, import.meta.url),'utf8'));
const automation = parseEnv(await readFile(new URL('../../.tokai/cloud/automation.env',import.meta.url),'utf8')).VERCEL_AUTOMATION_BYPASS_SECRET!;
const origin = env.APP_ORIGIN!, site = env.CONVEX_SITE_URL!, store = ConvexStore.fromEnv(env); await store.initialize();
let token = '', principal: Awaited<ReturnType<typeof store.authenticate>> | undefined;
const result: Record<string, unknown> = { environment, origin, fixtureProviders: false, paidProviderCalls: 0 };
async function call(path:string, init:RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set('Origin',origin); headers.set('x-vercel-protection-bypass',automation);
  if(token) headers.set('Authorization',`Bearer ${token}`); if(init.body && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  const response = await fetch(origin+path,{...init,headers,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok) { let code=''; try { const data=await response.json() as any;code=data.code??data.error?.code??''; } catch {} throw new Error(`Hosted ${path.split('?')[0]} returned HTTP${response.status} ${code}`); }
  return response;
}
const json = (body:unknown,method='POST') => ({method,body:JSON.stringify(body)});
async function direct(ticket:{url:string;headers:Record<string,string>},body?:Buffer) {
  if(new URL(ticket.url).origin !== site) throw new Error('Unexpected private transfer origin.');
  const response=await fetch(ticket.url,{method:body?'PUT':'GET',headers:{...ticket.headers,Origin:origin},...(body?{body:new Uint8Array(body)}:{}),redirect:'error',signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`Scoped private transfer returned HTTP${response.status}`); return response;
}
async function upload(bytes:Buffer,mimeType:string,filename:string) {
  const intent=await (await call('/v1/sources/uploads',json({title:'Isolated hosted verification',filename,mimeType,bytes:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')}))).json() as any;
  await direct({url:intent.uploadUrl,headers:intent.headers},bytes); return intent.source.id as string;
}
async function poll<T>(read:()=>Promise<T>,done:(value:T)=>boolean,label:string):Promise<T> {
  for(let count=0;count<100;count++) { const value=await read(); if(done(value)) return value; if(count%10===0)console.info(JSON.stringify({waiting:label,elapsedSeconds:count*2})); await delay(2000); }
  throw new Error(`${label} did not complete within its bound.`);
}
try {
  const health=await(await call('/health/ready')).json() as any; if(health.database!=='convex')throw new Error('Hosted API is not using Convex.');
  token=(await(await call('/v1/guest-sessions', {method:'POST'})).json() as any).token; principal=await store.authenticate(token);
  const large=Buffer.alloc(6*1024*1024,32); large.write('Isolated transfer integrity test; no lesson content.');
  const largeId=await upload(large,'text/plain','transfer-only.txt');
  const largeTicket=await(await call(`/v1/sources/${largeId}/download-ticket`,json({}))).json() as any;
  const downloaded=Buffer.from(await(await direct(largeTicket.transfer)).arrayBuffer());
  if(!downloaded.equals(large))throw new Error('Large private transfer bytes changed.');
  result.privateTransferBytes=large.length; await call(`/v1/sources/${largeId}`,json({},'DELETE'));
  const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);
  document.addPage([700,300]).drawText('Fractions describe equal parts of the same whole. One half equals two quarters.',{x:30,y:200,size:16,font});
  document.addPage([700,300]).drawText('Electric current travels around a closed circuit.',{x:30,y:200,size:16,font});
  const canvas=createCanvas(1400,400),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1400,400);ctx.fillStyle='black';ctx.font='42px Arial';
  ctx.fillText('Mitochondria release usable energy from food.',35,100);ctx.fillText('Cellular respiration produces ATP for cells.',35,190);
  const image=await document.embedPng(canvas.toBuffer('image/png'));document.addPage([700,200]).drawImage(image,{x:0,y:0,width:700,height:200});
  const sourceId=await upload(Buffer.from(await document.save()),'application/pdf','mixed-native.pdf'),started=Date.now();
  await call(`/v1/sources/${sourceId}/complete`,json({}));
  const source=await poll(async()=>((await(await call('/v1/sources')).json()) as any).sources.find((source:any)=>source.id===sourceId),value=>{if(value?.status==='failed')throw new Error('Hosted native source job failed.');return value?.status==='ready';},'native-source');
  if(source.pages!==3)throw new Error('Native PDF parser did not retain3pages.');
  const vector=await embedQuery('How do mitochondria make usable energy for cells?');
  const hits=await store.chunks.search(principal,{sourceIds:[sourceId],text:'mitochondria',embedding:vector,limit:3});
  if(!hits.some(hit=>hit.page===3&&/mitochondria/i.test(hit.text)))throw new Error('Actual scanned-page evidence is missing.');
  Object.assign(result,{actualScheduledNativeProcessing:true,pages:source.pages,chunks:source.chunks,embeddingDimensions:vector.length,processingMs:Date.now()-started});
  const stranger=await store.authenticate((await store.createGuest()).token);
  try { let denied=false;try{await store.chunks.search(stranger,{sourceIds:[sourceId],embedding:vector,limit:3});}catch(error){denied=(error as any).status===404;}if(!denied)throw new Error('Source ownership did not reject another owner.');result.crossOwnerDenied=true;}finally{await store.deleteOwner(stranger);}
  const sample=await(await call('/v1/sessions',json({topic:'photosynthesis',mode:'sample'}))).json() as any;
  const queued=await(await call(`/v1/sessions/${sample.session.id}/artifacts`,json({kind:'export',format:'pdf'}))).json() as any;
  await poll(async()=>store.resources.get<any>(principal!,'artifact',queued.artifact.id),value=>{if(value.data.status==='failed')throw new Error('Hosted PDF export failed.');return value.data.status==='ready';},'pdf-export');
  const pdfTicket=await(await call(`/v1/artifacts/${queued.artifact.id}/download-ticket`,json({}))).json() as any;
  const pdf=Buffer.from(await(await direct(pdfTicket.transfer)).arrayBuffer());if(pdf.subarray(0,5).toString()!=='%PDF-')throw new Error('Hosted export is not a PDF.');
  result.actualPdfBytes=pdf.length;
  if(process.argv.includes('--voice-rotation')) {
    // Explicit isolated transport fixture: no tutor/STT/TTS request is sent.
    const lesson=createLesson({id:randomUUID(),topic:'fractions',mode:'live',now:new Date().toISOString(),messageId:randomUUID()});await store.create(principal,lesson);
    async function open() {
      const ticket=await(await call(`/v1/sessions/${lesson.id}/voice-ticket`,json({}))).json() as any;
      const address=new URL('/v1/voice',origin);address.protocol='wss:';address.searchParams.set('ticket',ticket.ticket);
      const socket=new WebSocket(address,{headers:{Origin:origin,'x-vercel-protection-bypass':automation}});let audio=0;let ready:any;
      const closed=new Promise<{code:number;reason:string}>(resolve=>socket.once('close',(code,reason)=>resolve({code,reason:reason.toString()})));
      const timer=setTimeout(()=>socket.terminate(),285000);
      // Exercise actual lightweight learner selection activity without opening
      // any speech/model provider; ordinary idle sessions correctly close sooner.
      const activity=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'selection.update',selectedNodeId:lesson.board.nodes[0]?.id}));},30000);
      await new Promise<void>((resolve,reject)=>{socket.once('error',()=>reject(new Error('Hosted WebSocket upgrade failed.')));socket.on('message',(data,binary)=>{if(binary){audio++;return;}const event=JSON.parse(data.toString());if(event.type==='session.ready'){ready=event;resolve();}});socket.once('close',()=>{clearTimeout(timer);clearInterval(activity);if(!ready)reject(new Error('Hosted WebSocket closed before ready.'));});});
      return{socket,closed,audio:()=>audio,ready,address};
    }
    const voiceStarted=Date.now(),first=await open();
    const reuseStatus=await new Promise<number>((resolve,reject)=>{const duplicate=new WebSocket(first.address,{headers:{Origin:origin,'x-vercel-protection-bypass':automation}});duplicate.on('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode??0);duplicate.terminate();});duplicate.once('open',()=>{duplicate.close();reject(new Error('A consumed hosted voice ticket was reused.'));});duplicate.on('error',()=>{});setTimeout(()=>{duplicate.terminate();reject(new Error('Hosted duplicate-ticket check timed out.'));},10000).unref();});
    if(reuseStatus!==401)throw new Error(`Consumed hosted voice ticket returned unexpected HTTP${reuseStatus}.`);
    console.info(JSON.stringify({waiting:'real-platform-voice-rotation',expectedSeconds:240}));
    const closed=await first.closed;if(closed.code!==1012||closed.reason!=='Voice connection rotating')throw new Error('Hosted connection did not rotate cleanly.');
    const second=await open();if(second.ready.session.id!==lesson.id||first.audio()||second.audio())throw new Error('Hosted reconnect did not preserve snapshot-only recovery.');
    console.info(JSON.stringify({waiting:'post-rotation-platform-lifetime',seconds:75}));await delay(75000);
    if(second.socket.readyState!==WebSocket.OPEN)throw new Error('Hosted reconnect did not survive past the first function lifetime.');second.socket.close();await second.closed;
    Object.assign(result,{actualHostedRotation:true,transportFixtureOnly:true,audioReplay:false,singleUseTicket:true,voiceObservedMs:Date.now()-voiceStarted});
  }
  result.success=true;
} finally {
  if(principal){await call('/v1/me',json({},'DELETE'));result.isolatedOwnerDeleted=true;}
  await store.close();await writeFile(new URL(`../../.tokai/cloud/${environment}-verification.json`,import.meta.url),JSON.stringify(result,null,2));
}
console.info(JSON.stringify(result));
