// Photo px <-> CSS px: turn by -rot about the image centre (fish in photos are rarely level; see
// tools/fit-anatomy.mjs, which fits `rot`), mirror, then scale and move.
import type { PhotoPoint, RefPhoto } from './refs.js';

/** Photo px -> CSS px: scale s, then offset (tx, ty). */
export interface ViewTransform { s: number; tx: number; ty: number }

export interface PhotoSize { readonly naturalWidth: number; readonly naturalHeight: number }

export const rotationOf = (ref: RefPhoto): number => (-ref.rot * Math.PI) / 180;

export function photoToView(ref: RefPhoto, img: PhotoSize, view: ViewTransform, [x, y]: readonly [number, number]): PhotoPoint {
  const a = rotationOf(ref), c = Math.cos(a), s = Math.sin(a), cx = img.naturalWidth / 2, cy = img.naturalHeight / 2;
  const rx = cx + (x - cx) * c - (y - cy) * s, ry = cy + (x - cx) * s + (y - cy) * c;
  return [view.tx + view.s * (ref.mirror ? img.naturalWidth - rx : rx), view.ty + view.s * ry];
}

export function viewToPhoto(ref: RefPhoto, img: PhotoSize, view: ViewTransform, [u, v]: readonly [number, number]): PhotoPoint {
  const a = rotationOf(ref), c = Math.cos(a), s = Math.sin(a), cx = img.naturalWidth / 2, cy = img.naturalHeight / 2;
  let rx = (u - view.tx) / view.s;
  const ry = (v - view.ty) / view.s;
  if (ref.mirror) rx = img.naturalWidth - rx;
  return [cx + (rx - cx) * c + (ry - cy) * s, cy - (rx - cx) * s + (ry - cy) * c];
}
