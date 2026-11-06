// Reporting for the in-page checks: files go through the dev server's /__save (into out/, which the
// dev server allows), the result through /__done (tools/check.ts waits for it).

/** Check output directory, relative to the repository root as /__save expects. */
export const CHECK_OUT_DIR = 'out/';

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/** Saves a file and returns its path. */
export async function saveFile(path: string, body: Blob): Promise<string> {
  await fetch('/__save?path=' + encodeURIComponent(path), { method: 'POST', body });
  return path;
}

/** Reports the check's result; a missing server (opened by hand) is not an error. */
export async function postDone(body: string): Promise<void> {
  await fetch('/__done', { method: 'POST', body }).catch(() => undefined);
}
