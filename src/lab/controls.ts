// The lab page's toolbar: species, swim/spin/compare toggles, yaw, light level, rig and tone mapping.
import { requireElement } from '../util.js';
import type { FishLab } from './fishLab.js';

const PERCENT = 100;

const input = (id: string): HTMLInputElement => requireElement(id, HTMLInputElement);
const select = (id: string): HTMLSelectElement => requireElement(id, HTMLSelectElement);

export function bindControls(lab: FishLab, species: HTMLSelectElement, tone: string): void {
  species.onchange = () => { void lab.show(species.value); };

  const swim = input('swim'), spin = input('spin'), compare = input('compare'), yaw = input('yaw');
  swim.checked = lab.swim;
  swim.onchange = () => lab.setSwim(swim.checked);
  spin.checked = lab.spin;
  spin.onchange = () => lab.setSpin(spin.checked);
  compare.checked = lab.compare;
  compare.onchange = () => { lab.setCompare(compare.checked); void lab.show(species.value); };
  yaw.value = String(lab.yawDeg);
  yaw.oninput = () => lab.setYaw(Number(yaw.value));
  // Programmatic changes (the reference tool, the console) keep the controls in step.
  lab.onChange({
    yaw: (deg) => { yaw.value = String(deg); },
    swim: (on) => { swim.checked = on; },
    spin: (on) => { spin.checked = on; },
  });

  const light = input('light');
  light.oninput = () => lab.setLight(Number(light.value) / PERCENT);
  const rig = select('rig');
  rig.value = lab.rig.preset;
  rig.onchange = () => { lab.rig.preset = rig.value; lab.setLight(); };
  const toneSelect = select('tone');
  toneSelect.value = tone;
  toneSelect.onchange = () => lab.setTone(toneSelect.value);
  lab.setTone(toneSelect.value);
}
