/**
 * One-time model fetch for the Arm Track 3 on-device path.
 *
 * Downloads all-MiniLM-L6-v2 (int8 quantized ONNX, ~22 MB) into ./models.
 * After this runs, the on-device reasoner needs no network for anything —
 * including inference. That is the point: a cloud model needs a round-trip per
 * utterance, this needs none, ever.
 *
 * The model is deliberately NOT committed. 22 MB of binary does not belong in a
 * contest repo, and the deterministic path — which is the default — needs none
 * of this.
 *
 * Run: npm run fetch:model
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const ROOT = join(process.cwd(), 'models', ...MODEL_ID.split('/'));

const FILES = [
  ['config.json', ''],
  ['tokenizer.json', ''],
  ['tokenizer_config.json', ''],
  ['onnx/model_quantized.onnx', 'onnx'],
];

mkdirSync(join(ROOT, 'onnx'), { recursive: true });

let total = 0;
for (const [rel] of FILES) {
  const dest = join(ROOT, rel);
  if (existsSync(dest) && statSync(dest).size > 0) {
    total += statSync(dest).size;
    console.log(`  have  ${rel} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    continue;
  }
  process.stdout.write(`  fetch ${rel} ... `);
  const res = await fetch(`${BASE}/${rel}`, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`FAILED ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  total += buf.length;
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

console.log(`\n  model ready in ./models — ${(total / 1e6).toFixed(1)} MB total`);
console.log('  the on-device path is now fully offline; no further network access is used.');
console.log('  verify: npx vitest run packages/reasoner');
