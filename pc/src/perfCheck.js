// ?check=perf (node tools/check.mjs perf --gpu=1): what a frame costs and where. Times present() (the
// draw only, no simulation) with gl.finish() around it. Each comparison alternates its two settings
// batch by batch (10 batches of 10 frames each) and reports both medians and their ratio, so a machine
// busy with other work slows both alike: compare the ratios, not the milliseconds.
//   reef       with and without the reef (what its triangles and materials cost)
//   fishLod    the fish bodies' levels of detail on and off (fishModel.js)
//   res        full and half the pixels (fill-rate and post-processing share)
// and the triangles drawn per frame in each case.
import { setLodEnabled } from './lod.js';

export async function main(aq) {
  const { renderer, reef, present, step } = aq;
  const gl = renderer.getContext();
  aq.fitCanvas();
  for (let i = 0; i < 30; i++) { step(1 / 30); present(); }   // compile and settle
  gl.finish();
  const batch = () => { gl.finish(); const t0 = performance.now(); for (let i = 0; i < 10; i++) present(); gl.finish(); return (performance.now() - t0) / 10; };
  const tris = () => { renderer.info.autoReset = false; renderer.info.reset(); present(); const t = renderer.info.render.triangles; renderer.info.autoReset = true; return t; };
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const ab = (on, off) => {
    const A = [], B = [];
    on(); const ta = tris(); off(); const tb = tris();
    for (let i = 0; i < 10; i++) { on(); A.push(batch()); off(); B.push(batch()); }
    on();
    const a = median(A), b = median(B);
    return { msOn: +a.toFixed(1), msOff: +b.toFixed(1), ratio: +(a / b).toFixed(3), trisOn: ta, trisOff: tb };
  };
  const pr = renderer.getPixelRatio(), w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  const res = (k) => () => { renderer.setPixelRatio(pr * k); renderer.setSize(w, h, false); };
  const r = { size: [renderer.domElement.width, renderer.domElement.height] };
  r.fishLod = ab(() => setLodEnabled(true), () => setLodEnabled(false));
  r.reef = ab(() => { reef.group.visible = true; }, () => { reef.group.visible = false; });
  r.res = ab(res(1), res(Math.SQRT1_2));
  res(1)();
  r.gpu = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })();
  console.info('perf', JSON.stringify(r));
  await fetch('/__done', { method: 'POST', body: JSON.stringify(r, null, 1) }).catch(() => {});
}
