// A minimal DOM for building scenes in Node: canvases whose 2D context accepts every drawing call
// and reads back zeros. The reef's layout never depends on texture pixels, so this is enough to run
// buildReef() headlessly and compare layouts.

const FAKE_GRADIENT = { addColorStop: (): void => {} };

function fakeContext(canvas: { width: number; height: number }): object {
  const target: Record<string | symbol, unknown> = {
    canvas,
    createLinearGradient: () => FAKE_GRADIENT,
    createRadialGradient: () => FAKE_GRADIENT,
    createConicGradient: () => FAKE_GRADIENT,
    createPattern: () => ({}),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    measureText: () => ({ width: 0 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  // Any other method is a no-op; any property assignment (fillStyle, globalAlpha...) is kept.
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : () => {}),
    set: (t, key, value) => { t[key] = value; return true; },
  });
}

class FakeCanvas {
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  private ctx: object | null = null;
  getContext(): object {
    this.ctx ??= fakeContext(this);
    return this.ctx;
  }
  toDataURL(): string { return 'data:,'; }
  addEventListener(): void {}
}

export function installFakeDom(): void {
  const g = globalThis as Record<string, unknown>;
  if (g['document']) return;
  g['document'] = {
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {} }),
    createElementNS: () => new FakeCanvas(),
  };
  g['HTMLCanvasElement'] = FakeCanvas;
  g['self'] = globalThis;
  g['location'] = new URL('http://localhost/index.html');
}
