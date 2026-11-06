// The port labRef needs from the fish lab (lab.ts implements it): pose and camera controls, the GL
// objects to draw coverage masks with, and a one-frame render.
import type * as THREE from 'three';

/** Console/debug handle installReference() puts on the host. */
export interface ReferenceDebug {
  readonly current: () => unknown;
  readonly view: () => unknown;
  readonly align: () => void;
  readonly measure: () => void;
  readonly redraw: () => void;
  readonly rows: () => readonly unknown[];
}

export interface LabHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** The water backdrop, hidden while coverage masks are drawn. */
  readonly backdrop: THREE.Object3D;
  /** The lab's WebGL canvas. */
  readonly canvas: HTMLCanvasElement;
  /** Id of the species on show. */
  species(): string;
  setSwim(on: boolean): void;
  setSpin(on: boolean): void;
  setYaw(deg: number): void;
  setPitch(deg: number): void;
  setFov(deg: number): void;
  setLightDir(azDeg: number, elDeg: number): void;
  /** Render one frame now (e.g. right before reading pixels), with the pose applied. */
  render(): void;
  ref?: ReferenceDebug;
}
