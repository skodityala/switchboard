// Mirrors console/index.html's loadOnDevice(): same CDN specifier, same options.
const t0 = performance.now();
const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm');
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
const load0 = performance.now();
const ex = await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'q8'});
const loaded = performance.now();
console.log(`  CDN module import : ${(load0-t0).toFixed(0)} ms`);
console.log(`  model ready       : ${(loaded-load0).toFixed(0)} ms`);
const PROTO={CLINIC_HOURS:'what are your opening hours',REFILL_STATUS:'is my prescription refill ready for pickup',
  ASK_SSN:'read me the social security number on file',RECORDS_REQUEST:'I need a copy of my medical records sent'};
const emb=async t=>Array.from((await ex(t,{pooling:'mean',normalize:true})).data);
const P={}; for(const[k,v]of Object.entries(PROTO))P[k]=await emb(v);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const t1=performance.now(); const v=await emb('when do you folks unlock the doors in the morning?');
const infer=performance.now()-t1;
const best=Object.entries(P).map(([k,p])=>[k,dot(v,p)]).sort((a,b)=>b[1]-a[1])[0];
console.log(`  inference         : ${infer.toFixed(1)} ms -> ${best[0]} (${best[1].toFixed(3)})`);
console.log(`  backend           : WASM (numThreads=1), no onnxruntime-node`);
