// Generate models with the Tripo3D API: scenery (live rock, corals) into pc/models/scenery/, and
// fish into pc/models/fish/ for side-by-side comparison with the procedural ones (lab.html?compare=1).
//
//   node tools/tripo.mjs              generate every scenery item that doesn't exist yet
//   node tools/tripo.mjs rock_a coral_staghorn   generate (or regenerate) just these
//   node tools/tripo.mjs fish_clownfish          fish are only generated when named
//   node tools/tripo.mjs --list       show the jobs and exit
//
// The API key is read from $TRIPO_API_KEY or ./tripo3d.ai.key (git-ignored, never served).
// Each model costs API credits (1 credit = $0.01; text-to-3D is roughly 10-40 credits).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize } from './optimize-scenery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'pc', 'models', 'scenery');
const FISH_OUT = path.join(ROOT, 'pc', 'models', 'fish');
const MANIFEST = path.join(ROOT, 'pc', 'models', 'scenery.json');
const API = 'https://openapi.tripo3d.ai/v3';

// Shared style: physically plausible, unlit albedo (delight), no base, sits flat on the ground.
const STYLE = 'photorealistic, physically accurate natural materials, single isolated object resting on flat ground, no base, no stand, no water, no fish';
const NEG = 'pedestal, base plate, stand, text, cartoon, stylised, toy, plastic, glossy, fish';
// Fish: the swim shader adds the bend, so the body must be straight and seen side-on.
const FISH_STYLE = 'photorealistic, adult, straight neutral side-on pose, body NOT bent, fins naturally extended, mouth closed, no base or stand, isolated, accurate anatomy and markings';
const FISH_NEG = 'pedestal, base plate, stand, text, cartoon, stylised, toy, plastic, curved body, bent tail, open mouth, multiple fish, anemone, rock';

// kind: 'rock' replaces procedural rock geometry; 'coral' fills a named coral slot in reef.js;
// 'fish' is saved as pc/models/fish/<species>.glb and is not wired into the tank.
export const JOBS = {
  rock_a: { kind: 'rock', faces: 30000, prompt: 'Large porous reef aquarium live rock, rounded boulder, rough limestone full of holes and crevices, patches of pink and purple coralline algae, tan and grey base colour' },
  rock_b: { kind: 'rock', faces: 30000, prompt: 'Tall jagged reef aquarium live rock pillar, honeycomb porous calcium carbonate, deep pockets and overhangs, encrusted with purple coralline algae and brown film algae' },
  rock_c: { kind: 'rock', faces: 30000, prompt: 'Flat wide reef aquarium live rock shelf slab, porous dead coral skeleton texture, small holes, pink coralline algae crust on top, beige underneath' },
  rock_d: { kind: 'rock', faces: 30000, prompt: 'Arched reef aquarium live rock with a natural cave opening, very porous branching coral rubble texture, mottled pink, mauve and cream coralline algae' },
  coral_staghorn: { kind: 'coral', faces: 40000, prompt: 'Living staghorn acropora coral colony, many thick cylindrical branches forking upward, bright orange tissue with paler yellow growing tips, tiny polyp bumps along the branches' },
  coral_finger: { kind: 'coral', faces: 40000, prompt: 'Dome-shaped colony of white finger coral (Porites), hundreds of short blunt cream-white fingers packed into a hemisphere' },
  coral_cauliflower: { kind: 'coral', faces: 40000, prompt: 'Lavender cauliflower coral colony (Pocillopora), rounded bush of short knobby lumpy branches, soft lavender-purple with pale tips' },
  coral_brain: { kind: 'coral', faces: 30000, prompt: 'Round brain coral (Diploria) boulder, deep meandering grooves and ridges over the whole dome, olive green ridges with tan valleys' },
  coral_leather: { kind: 'coral', faces: 30000, prompt: 'Toadstool leather coral (Sarcophyton), short thick smooth stalk with a wide wavy folded mushroom cap, pale green-yellow cap covered in fine polyp texture' },
  coral_fan: { kind: 'coral', faces: 30000, prompt: 'Pink ruffled lettuce coral (Pectinia), clusters of thin wavy upright plates with frilly edges, pink and magenta with lighter edges' },
  fish_clownfish: { kind: 'fish', species: 'clownfish', faces: 20000, prompt: 'Single Ocellaris clownfish (Amphiprion ocellaris), oval laterally compressed body, bright orange, three white vertical bands (behind the eye, mid-body bulging forward, at the tail base) each with a thin black edge, rounded orange fins with black margins, large dark eye' },
};

// Where a job's model goes: scenery under its job id, fish under their species id.
const target = (id, job) => job.kind === 'fish'
  ? { dir: FISH_OUT, name: job.species, size: 1024 }
  : { dir: OUT, name: id };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  if (process.env.TRIPO_API_KEY) return process.env.TRIPO_API_KEY.trim();
  const f = path.join(ROOT, 'tripo3d.ai.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('No API key: set TRIPO_API_KEY or create tripo3d.ai.key in the project root');
}

async function call(key, method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.code !== 0) throw new Error(`${method} ${url.replace(API, '')} -> HTTP ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
}

async function generate(key, id, job) {
  const fish = job.kind === 'fish';
  const { dir, name, size } = target(id, job);
  const { task_id } = await call(key, 'POST', `${API}/generation/text-to-model`, {
    prompt: `${job.prompt}. ${fish ? FISH_STYLE : STYLE}`,
    negative_prompt: fish ? FISH_NEG : NEG,
    model: 'v3.1-20260211',
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
    texture_version: 'v3.5-20260815',
    delight: true,               // remove baked-in lighting so our underwater lighting is the only light
    face_limit: job.faces,
  });
  console.log(`${id}: task ${task_id}`);
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    await sleep(3000);
    const d = await call(key, 'GET', `${API}/tasks/${task_id}`);
    if (d.progress !== last) { console.log(`${id}: ${d.status} ${d.progress ?? ''}%`); last = d.progress; }
    if (d.status === 'success') {
      // Download straight away: result URLs expire after a few minutes.
      const save = async (url, file) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`download ${file}: HTTP ${r.status}`);
        fs.writeFileSync(path.join(dir, file), Buffer.from(await r.arrayBuffer()));
      };
      fs.mkdirSync(dir, { recursive: true });
      await save(d.output.model_url, `${name}.glb`);
      fs.rmSync(path.join(dir, 'src', `${name}.glb`), { force: true });   // new original replaces the old one
      await optimize(name, { dir, size });
      if (d.output.rendered_image_url) await save(d.output.rendered_image_url, `${name}.preview.webp`).catch(() => {});
      return { file: `${path.basename(dir)}/${name}.glb`, kind: job.kind, task: task_id };
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(d.status)) throw new Error(`${id}: task ${d.status}`);
    if (Date.now() - t0 > 10 * 60 * 1000) throw new Error(`${id}: timed out`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [id, j] of Object.entries(JOBS)) console.log(`${id.padEnd(18)} ${j.kind.padEnd(6)} ${j.prompt}`);
  process.exit(0);
}
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const ids = args.length ? args : Object.keys(JOBS).filter((id) => {
  const j = JOBS[id], t = target(id, j);
  return j.kind !== 'fish' && !fs.existsSync(path.join(t.dir, `${t.name}.glb`));
});
const unknown = ids.filter((id) => !JOBS[id]);
if (unknown.length) { console.error('Unknown job(s):', unknown.join(', ')); process.exit(1); }
if (!ids.length) { console.log('Nothing to generate.'); process.exit(0); }

const key = apiKey();
// API credits are separate from a Tripo Studio subscription; top up at platform.tripo3d.ai.
const bal = await fetch('https://api.tripo3d.ai/v2/openapi/user/balance', { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json()).catch(() => null);
if (bal?.code === 0) {
  console.log(`API balance: ${bal.data.balance} credits`);
  if (bal.data.balance < 40 * ids.length) console.warn(`Warning: ${ids.length} model(s) may need up to ~${40 * ids.length} credits`);
  if (bal.data.balance <= 0) { console.error('No API credits. Buy some for the API key (Studio credits do not apply).'); process.exit(1); }
}
console.log(`Generating ${ids.length} model(s): ${ids.join(', ')}`);
const results = await Promise.allSettled(ids.map((id, i) => sleep(i * 500).then(() => generate(key, id, JOBS[id]))));
let scenery = false;
results.forEach((r, i) => {
  // Fish stay out of scenery.json (reef.js treats every non-rock entry as a coral).
  if (r.status === 'fulfilled') { if (r.value.kind !== 'fish') { manifest[ids[i]] = r.value; scenery = true; } }
  else console.error(r.reason.message);
});
if (scenery) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Done: ${results.filter((r) => r.status === 'fulfilled').length}/${ids.length} saved`);
