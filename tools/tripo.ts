// Generate models with the Tripo3D API: scenery (live rock, corals) into web/models/scenery/, and
// fish into web/models/fish/ for side-by-side comparison with the procedural ones (lab.html?compare=1).
//
//   npm run tripo                               generate every scenery item that doesn't exist yet
//   npm run tripo -- rock_a coral_staghorn      generate (or regenerate) just these
//   npm run tripo -- fish_clownfish             fish are only generated when named
//   npm run tripo -- --list                     show the jobs and exit
//   npm run tripo -- --balance                  show the API credit balance and exit
//
// The API key is read from $TRIPO_API_KEY or ./tripo3d.ai.key (git-ignored, never served).
// Each model costs API credits (1 credit = $0.01; text-to-3D is roughly 10-40 credits).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimize } from './optimize-scenery.js';
import { isMain } from './heightmaps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'models', 'scenery');
const FISH_OUT = path.join(ROOT, 'web', 'models', 'fish');
const MANIFEST = path.join(ROOT, 'web', 'models', 'scenery.json');
const API = 'https://openapi.tripo3d.ai/v3';
const BALANCE_URL = 'https://api.tripo3d.ai/v2/openapi/user/balance';
const POLL_MS = 3000, STAGGER_MS = 500, TIMEOUT_MS = 10 * 60 * 1000;
const FISH_TEXTURE_SIZE = 1024;
const MAX_CREDITS_PER_MODEL = 40;
const ERROR_SNIPPET = 300;

// Shared style: physically plausible, unlit albedo (delight), no base, sits flat on the ground.
const STYLE = 'photorealistic, physically accurate natural materials, single isolated object resting on flat ground, no base, no stand, no water, no fish';
const NEG = 'pedestal, base plate, stand, text, cartoon, stylised, toy, plastic, glossy, fish';
// Fish: the swim shader adds the bend, so the body must be straight and seen side-on.
const FISH_STYLE = 'photorealistic, adult, straight neutral side-on pose, body NOT bent, fins naturally extended, mouth closed, no base or stand, isolated, accurate anatomy and markings';
const FISH_NEG = 'pedestal, base plate, stand, text, cartoon, stylised, toy, plastic, curved body, bent tail, open mouth, multiple fish, anemone, rock';

/**
 * 'rock' replaces procedural rock geometry; 'coral' fills a named coral slot in the reef; 'plant' and
 * 'prop' are placed on sand and rock feet; 'fish' is saved as web/models/fish/<species>.glb and is not
 * wired into the tank.
 */
export type JobKind = 'rock' | 'coral' | 'plant' | 'prop' | 'fish';

export interface Job {
  readonly kind: JobKind;
  readonly faces: number;
  readonly prompt: string;
  /** Extra negatives for this job. */
  readonly neg?: string;
  /** Fish only: the species id the model is saved under. */
  readonly species?: string;
}

/** One scenery.json entry. */
interface ManifestEntry { readonly file: string; readonly kind: JobKind; readonly task: string }

export const JOBS: Readonly<Record<string, Job>> = {
  rock_a: { kind: 'rock', faces: 30000, prompt: 'Large porous reef aquarium live rock, rounded boulder, rough limestone full of holes and crevices, patches of pink and purple coralline algae, tan and grey base colour' },
  rock_b: { kind: 'rock', faces: 30000, prompt: 'Tall jagged reef aquarium live rock pillar, honeycomb porous calcium carbonate, deep pockets and overhangs, encrusted with purple coralline algae and brown film algae' },
  rock_c: { kind: 'rock', faces: 30000, prompt: 'Flat wide reef aquarium live rock shelf slab, porous dead coral skeleton texture, small holes, pink coralline algae crust on top, beige underneath' },
  rock_d: { kind: 'rock', faces: 30000, prompt: 'Arched reef aquarium live rock with a natural cave opening, very porous branching coral rubble texture, mottled pink, mauve and cream coralline algae' },
  rock_e: { kind: 'rock', faces: 30000, prompt: 'Reef aquarium live rock ledge with a deep shaded overhang underneath, porous limestone, crevices big enough for a small fish, crust of pink and violet coralline algae on the upper surface, grey-beige below' },
  rock_f: { kind: 'rock', faces: 30000, prompt: 'Low wide mound of reef live rock rubble, many fist-sized porous coral fragments cemented together, small gaps between pieces, cream and tan with scattered purple coralline algae and short green turf algae' },
  rock_g: { kind: 'rock', faces: 30000, prompt: 'Rounded reef aquarium live rock boulder, dense pitted surface with many small boreholes from worms and sponges, mottled ochre, rust and grey with patches of maroon coralline algae' },
  rock_h: { kind: 'rock', faces: 30000, prompt: 'Branching reef aquarium live rock made of old dead acropora skeleton, thick knobbly arms reaching sideways, rough porous texture, bleached cream with pink coralline algae on the arm tops' },
  coral_staghorn: { kind: 'coral', faces: 40000, prompt: 'Living staghorn acropora coral colony, many thick cylindrical branches forking upward, bright orange tissue with paler yellow growing tips, tiny polyp bumps along the branches' },
  coral_finger: { kind: 'coral', faces: 40000, prompt: 'Dome-shaped colony of white finger coral (Porites), hundreds of short blunt cream-white fingers packed into a hemisphere' },
  coral_cauliflower: { kind: 'coral', faces: 40000, prompt: 'Lavender cauliflower coral colony (Pocillopora), rounded bush of short knobby lumpy branches, soft lavender-purple with pale tips' },
  coral_leather: { kind: 'coral', faces: 30000, prompt: 'Toadstool leather coral (Sarcophyton), short thick smooth stalk with a wide wavy folded mushroom cap, pale green-yellow cap covered in fine polyp texture' },
  coral_fan: { kind: 'coral', faces: 30000, prompt: 'Pink ruffled lettuce coral (Pectinia), clusters of thin wavy upright plates with frilly edges, pink and magenta with lighter edges' },
  // Plants: 'plant' kind, placed on sand and rock feet by the reef, swaying with the current in the shader.
  plant_halimeda: { kind: 'plant', faces: 30000, prompt: 'Clump of Halimeda cactus macroalgae, many upright branching chains of small flat green coin-shaped calcified segments, bright green with pale lime edges, growing from a small holdfast in sand' },
  plant_caulerpa: { kind: 'plant', faces: 30000, prompt: 'Clump of Caulerpa racemosa grape macroalgae, upright stalks densely covered in small glossy round green bead-like vesicles, short creeping runners at the base, rich green' },
  // Batch 1: two rock families with flat crusts (the first rocks' "coralline
  // algae" came out as raised blobs), a table coral and Montipora plates (horizontals), a barrel sponge.
  // neg: extra negatives for that job.
  rock_i: { kind: 'rock', faces: 30000, neg: 'raised growths, flowers, blobs, bumps on top', prompt: 'Large reef aquarium live rock boulder after years in a reef tank, dense irregular shape with a few deep holes and ledges, surface almost entirely covered in smooth flat paint-like coralline algae crust in mottled deep purple, maroon and dusky pink, flush with the rock with no raised growths, olive-brown turf algae in the hollows, a few small flat orange encrusting sponges' },
  rock_j: { kind: 'rock', faces: 30000, neg: 'raised growths, flowers, blobs', prompt: 'Reef live rock ledge, tall irregular slab with an undercut base, weathered dark grey and brown limestone with small pores, short olive-green and brown turf algae on the upper faces, scattered flat maroon coralline patches flush with the surface, a few white calcareous worm tubes, no raised growths' },
  coral_table: { kind: 'coral', faces: 40000, neg: 'rubble, gravel, dome, mound, bowl', prompt: 'Table coral colony (Acropora hyacinthus), one broad flat horizontal plate of tightly fused fine branchlets on a short thick central stalk, plate thick at the edge, upper surface covered in tiny upright branchlet tips, soft brown and olive tissue with pale cream growing rim, colony base broken off cleanly, no rubble' },
  sponge_barrel: { kind: 'coral', faces: 30000, neg: 'closed top, rubble', prompt: 'Giant barrel sponge (Xestospongia muta), tall thick-walled vase shape wider at the top with a deep central opening, outer wall covered in rough knobbly vertical ridges and furrows, dull brownish red to terracotta, paler inside the rim' },
  // (The first take of this prompt grew orange finger branches: kept as coral_digitata in scenery.json.
  // Retried with the shape spelled out and branches forbidden. sponge_ear came out as orange tubes:
  // kept as sponge_tube_orange.)
  coral_montipora: { kind: 'coral', faces: 30000, neg: 'branches, fingers, tubes, cylinders, spikes, single blob, dome, rubble', prompt: 'Plating Montipora coral (Montipora capricornis), a stack of four thin flat overlapping plates like curled dinner plates or rose petals spiralling outwards, each plate horizontal and wavy-edged, no branches, plate upper surfaces smooth and finely pitted with tiny polyp pores, rich orange-red tissue with paler cream rims' },
  // Batch 2: accents, scale cues and silhouettes.
  clam_tridacna: { kind: 'prop', faces: 20000, neg: 'closed shell', prompt: 'Maxima giant clam (Tridacna maxima), oval fluted grey-white shell with wavy scalloped ridges, opened with the thick fleshy mantle spread over the shell lips, mantle electric blue and teal with dark green mottled spots and a pale siphon opening in the middle' },
  coral_brain: { kind: 'coral', faces: 30000, neg: 'spikes, points, spines, pagoda, hedgehog', prompt: 'Grooved brain coral (Diploria labyrinthiformis) round boulder, smooth rounded meandering ridges and valleys winding over the whole dome exactly like a human brain, no spikes, no points, ridges olive-tan, valleys pale cream-green' },
  sponge_tube: { kind: 'coral', faces: 30000, neg: 'fused, solid, closed tops', prompt: 'Cluster of five yellow tube sponges (Aplysina fistularis), thick upright hollow tubes of different heights joined at the base, each open at the top, rough porous outer surface, bright sulphur yellow' },
  coral_bubble: { kind: 'coral', faces: 30000, neg: 'branches, cauliflower', prompt: 'Bubble coral (Plerogyra sinuosa) colony, rounded mound densely covered in plump grape-like translucent bubble vesicles, creamy white with a faint green tint, short ridged skeleton walls showing at the base' },
  zoanthid_rock: { kind: 'coral', faces: 30000, prompt: 'Small reef rubble rock carpeted on top with a dense mat of zoanthid polyps (Zoanthus), hundreds of short fleshy tubes with flat open discs, discs bright orange centres with green rims, rock underside grey and porous' },
  sea_rod: { kind: 'coral', faces: 30000, neg: 'thin twigs, many branches, broken, fan, net', prompt: 'Knobby sea rod gorgonian (Eunicea), a few thick upright candelabra branches forking from a short trunk, each branch finger-thick and covered in raised polyp calyces, dull purple-brown with tan tips' },
  sea_cucumber: { kind: 'prop', faces: 20000, prompt: 'Sea cucumber (Holothuria), soft elongated sausage-shaped body lying on sand, wrinkled leathery skin with small rounded papillae, dark brown with mottled tan' },
  urchin_pencil: { kind: 'prop', faces: 20000, neg: 'thin needles, long sharp spines', prompt: 'Slate pencil sea urchin (Heterocentrotus mamillatus), round test with about twenty thick blunt cylindrical spines radiating, spines banded red-brown and cream' },
  sponge_ear: { kind: 'coral', faces: 30000, neg: 'lettuce, ruffles', prompt: 'Orange elephant ear sponge (Agelas clathrodes), a few thick wavy upright ear-shaped plates growing from a common base, rough porous surface, bright orange' },
  fish_clownfish: { kind: 'fish', species: 'clownfish', faces: 20000, prompt: 'Single Ocellaris clownfish (Amphiprion ocellaris), oval laterally compressed body, bright orange, three white vertical bands (behind the eye, mid-body bulging forward, at the tail base) each with a thin black edge, rounded orange fins with black margins, large dark eye' },
};

interface Target { readonly dir: string; readonly name: string; readonly size?: number }

/** Where a job's model goes: scenery under its job id, fish under their species id. */
const target = (id: string, job: Job): Target => job.kind === 'fish'
  ? { dir: FISH_OUT, name: job.species ?? id, size: FISH_TEXTURE_SIZE }
  : { dir: OUT, name: id };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function apiKey(): string {
  const env = process.env['TRIPO_API_KEY'];
  if (env) return env.trim();
  const f = path.join(ROOT, 'tripo3d.ai.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('No API key: set TRIPO_API_KEY or create tripo3d.ai.key in the project root');
}

async function call(key: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  const json: unknown = await r.json().catch(() => ({}));
  const ok = r.ok && isRecord(json) && json['code'] === 0 && isRecord(json['data']);
  if (!ok) throw new Error(`${method} ${url.replace(API, '')} -> HTTP ${r.status} ${JSON.stringify(json).slice(0, ERROR_SNIPPET)}`);
  return json['data'] as Record<string, unknown>;
}

interface Balance { readonly balance: number; readonly frozen: number }

async function balance(key: string): Promise<Balance | null> {
  const r: unknown = await fetch(BALANCE_URL, { headers: { Authorization: `Bearer ${key}` } }).then((x) => x.json()).catch(() => null);
  if (!isRecord(r) || r['code'] !== 0 || !isRecord(r['data'])) return null;
  return { balance: Number(r['data']['balance'] ?? 0), frozen: Number(r['data']['frozen'] ?? 0) };
}

async function download(url: string, file: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${path.basename(file)}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

async function generate(key: string, id: string, job: Job): Promise<ManifestEntry> {
  const fish = job.kind === 'fish';
  const { dir, name, size } = target(id, job);
  const task = await call(key, 'POST', `${API}/generation/text-to-model`, {
    prompt: `${job.prompt}. ${fish ? FISH_STYLE : STYLE}`,
    negative_prompt: (fish ? FISH_NEG : NEG) + (job.neg ? ', ' + job.neg : ''),
    model: 'v3.1-20260211',
    texture: true,
    pbr: true,
    texture_quality: 'detailed',
    texture_version: 'v3.5-20260815',
    delight: true,               // remove baked-in lighting so our underwater lighting is the only light
    face_limit: job.faces,
  });
  const taskId = String(task['task_id']);
  console.log(`${id}: task ${taskId}`);
  const t0 = Date.now();
  let last: unknown = -1;
  for (;;) {
    await sleep(POLL_MS);
    const d = await call(key, 'GET', `${API}/tasks/${taskId}`);
    const status = String(d['status']);
    if (d['progress'] !== last) {
      console.log(`${id}: ${status} ${String(d['progress'] ?? '')}%`);
      last = d['progress'];
    }
    if (status === 'success') {
      // Download straight away: result URLs expire after a few minutes.
      const output = isRecord(d['output']) ? d['output'] : {};
      const modelUrl = output['model_url'], previewUrl = output['rendered_image_url'];
      if (typeof modelUrl !== 'string') throw new Error(`${id}: no model_url in the result`);
      fs.mkdirSync(dir, { recursive: true });
      await download(modelUrl, path.join(dir, `${name}.glb`));
      fs.rmSync(path.join(dir, 'src', `${name}.glb`), { force: true });   // new original replaces the old one
      await optimize(name, size !== undefined ? { dir, size } : { dir });
      if (typeof previewUrl === 'string') await download(previewUrl, path.join(dir, `${name}.preview.webp`)).catch(() => undefined);
      return { file: `${path.basename(dir)}/${name}.glb`, kind: job.kind, task: taskId };
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(status)) throw new Error(`${id}: task ${status}`);
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`${id}: timed out`);
  }
}

async function main(args: readonly string[]): Promise<number> {
  if (args.includes('--list')) {
    for (const [id, j] of Object.entries(JOBS)) console.log(`${id.padEnd(18)} ${j.kind.padEnd(6)} ${j.prompt}`);
    return 0;
  }
  if (args.includes('--balance')) {
    const b = await balance(apiKey());
    console.log(b ? `API balance: ${b.balance} credits (frozen ${b.frozen})` : 'Balance unavailable');
    return 0;
  }
  const manifest: Record<string, unknown> = fs.existsSync(MANIFEST) ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>) : {};
  const ids = args.length ? [...args] : Object.entries(JOBS).filter(([id, j]) => {
    const t = target(id, j);
    return j.kind !== 'fish' && !fs.existsSync(path.join(t.dir, `${t.name}.glb`));
  }).map(([id]) => id);
  const unknown = ids.filter((id) => !(id in JOBS));
  if (unknown.length) {
    console.error('Unknown job(s):', unknown.join(', '));
    return 1;
  }
  if (!ids.length) {
    console.log('Nothing to generate.');
    return 0;
  }

  const key = apiKey();
  // API credits are separate from a Tripo Studio subscription; top up at platform.tripo3d.ai.
  const bal = await balance(key);
  if (bal) {
    console.log(`API balance: ${bal.balance} credits`);
    const worst = MAX_CREDITS_PER_MODEL * ids.length;
    if (bal.balance < worst) console.warn(`Warning: ${ids.length} model(s) may need up to ~${worst} credits`);
    if (bal.balance <= 0) {
      console.error('No API credits. Buy some for the API key (Studio credits do not apply).');
      return 1;
    }
  }
  console.log(`Generating ${ids.length} model(s): ${ids.join(', ')}`);
  const results = await Promise.allSettled(ids.map(async (id, i) => {
    await sleep(i * STAGGER_MS);
    const job = JOBS[id];
    if (!job) throw new Error(`Unknown job ${id}`);
    return { id, entry: await generate(key, id, job) };
  }));
  let scenery = false;
  for (const r of results) {
    // Fish stay out of scenery.json (the reef treats every non-rock entry as a coral).
    if (r.status === 'rejected') console.error(errorMessage(r.reason));
    else if (r.value.entry.kind !== 'fish') {
      manifest[r.value.id] = r.value.entry;
      scenery = true;
    }
  }
  if (scenery) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Done: ${results.filter((r) => r.status === 'fulfilled').length}/${ids.length} saved`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
