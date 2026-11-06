// A fast 64-bit (two-lane) hash for the reef light cache key, over numbers, strings, typed arrays and
// texture thumbnails.
import * as THREE from 'three';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LANE_B_SEED = 0x2545f491;
const GOLDEN = 0x9e3779b9;
const MURMUR_M = 0x5bd1e995;
const HEX_DIGITS = 8;
const THUMB_SIZE = 8;
const DATA_SAMPLES = 8192;

export class Hasher {
  private a = FNV_OFFSET;
  private b = LANE_B_SEED;

  u32(x: number): void {
    this.a = Math.imul(this.a ^ x, FNV_PRIME);
    this.b = Math.imul(((this.b ^ x) + GOLDEN) | 0, MURMUR_M);
    this.b ^= this.b >>> 15;
  }

  private words(view: ArrayLike<number>): void {
    for (let i = 0; i < view.length; i++) this.u32(view[i] ?? 0);
  }

  /** Any typed array, by its bytes. */
  bytes(arr: ArrayBufferView): void {
    const length = arr.byteLength;
    this.u32(length);
    if (length % 4 === 0) this.words(new Uint32Array(arr.buffer, arr.byteOffset, length >> 2));
    else this.words(new Uint16Array(arr.buffer, arr.byteOffset, length >> 1));
  }

  str(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i));
  }

  floats(list: Iterable<number>): void {
    this.bytes(Float32Array.from(list));
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(HEX_DIGITS, '0') + (this.b >>> 0).toString(16).padStart(HEX_DIGITS, '0');
  }
}

type SampledArray = Uint8Array | Uint8ClampedArray | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

function isSampledArray(value: unknown): value is SampledArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && !(value instanceof BigInt64Array) && !(value instanceof BigUint64Array);
}

interface ImageLike { readonly width?: unknown; readonly height?: unknown; readonly data?: unknown }

const asImage = (image: unknown): ImageLike | null => (typeof image === 'object' && image !== null ? image : null);
const int32 = (v: unknown): number => (typeof v === 'number' ? v | 0 : 0);

/** A strided sample of a data texture's texels, in the texture's own array type. */
function strided(data: SampledArray): SampledArray {
  const step = Math.max(1, Math.floor(data.length / DATA_SAMPLES));
  const sample = data.slice(0, Math.ceil(data.length / step));
  for (let i = 0, j = 0; i < data.length; i += step, j++) sample[j] = data[i] ?? 0;
  return sample;
}

/** Hashes textures by their settings and an 8x8 thumbnail (or a texel sample for data textures). */
export class TextureHasher {
  private thumb: CanvasRenderingContext2D | null = null;

  hash(H: Hasher, t: THREE.Texture): void {
    H.str(`${t.constructor.name}|${t.wrapS},${t.wrapT}|${t.repeat.x},${t.repeat.y},${t.offset.x},${t.offset.y},${t.rotation}|${t.colorSpace}|${t.flipY}|${t.channel}`);
    const image: unknown = t.image;
    const im = asImage(image);
    if (!im) return;
    H.u32(int32(im.width));
    H.u32(int32(im.height));
    if (im.data) {
      if (isSampledArray(im.data)) H.bytes(strided(im.data));
      return;
    }
    try {
      const g = this.thumbnailContext();
      g.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
      g.drawImage(image as CanvasImageSource, 0, 0, THUMB_SIZE, THUMB_SIZE);
      H.bytes(g.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data);
    } catch { /* an image it can't draw: its size stands in */ }
  }

  private thumbnailContext(): CanvasRenderingContext2D {
    if (!this.thumb) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = THUMB_SIZE;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) throw new Error('2D canvas context unavailable');
      this.thumb = g;
    }
    return this.thumb;
  }
}
