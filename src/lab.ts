// Fish lab: inspect one species (or all of them) up close under the tank's lighting and water.
// URL: lab.html?sp=clownfish&yaw=30&swim=0 (fan=tank: still fans in the tank's rest pose)   or   lab.html?sp=all   or   lab.html?sp=clownfish&compare=1
// The page wiring is here; the lab itself (scene, poses, lights) is FishLab in lab/fishLab.ts, which
// implements the LabHost port the reference-photo tool (labRef) drives.
import { SPECIES } from './species.js';
import { loadCustomModels, loadSkinCache, fishRender } from './fishModel.js';
import { installReference } from './labRef.js';
import { requireElement } from './util.js';
import { FishLab, type LabOptions } from './lab/fishLab.js';
import { bindControls } from './lab/controls.js';

const params = new URLSearchParams(location.search);
fishRender.finDepth = params.has('photo') && params.get('photo') !== '0';

const DEFAULT_SPECIES = 'clownfish';
const DEFAULT_LAB_F_NUMBER = 2.8;

const options: LabOptions = {
  yaw: Number(params.get('yaw') || 0),
  pitch: Number(params.get('pitch') || 0),
  spin: params.get('spin') === '1',
  swim: params.get('swim') !== '0',
  compare: params.get('compare') === '1',
  rig: params.get('rig') || 'sun',
  photo: params.has('photo') && params.get('photo') !== '0',
  fNumber: Number(params.get('fstop')) || DEFAULT_LAB_F_NUMBER,
  tankFan: params.get('fan') === 'tank',
};

const canvas = requireElement('lab', HTMLCanvasElement);
const species = requireElement('sp', HTMLSelectElement);
const lab = new FishLab(canvas, options, () => species.value);
await Promise.all([loadCustomModels(SPECIES), loadSkinCache(SPECIES)]);

for (const s of [{ id: 'all', name: 'All species' }, ...SPECIES]) species.add(new Option(s.name, s.id));
species.value = params.get('sp') || DEFAULT_SPECIES;
bindControls(lab, species, params.get('tone') || 'neutral');
lab.setLight(1);
await lab.show(species.value);
lab.start();

// Exposed for the reference tool's console use and debugging, as the JS build did.
Reflect.set(window, 'lab', lab);
installReference(lab);
