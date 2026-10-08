import type { RUM } from "./types";

let instance: RUM | undefined;

export function getRUM(): RUM | undefined {
  return instance;
}

export function setRUM(rum: RUM | undefined): void {
  instance = rum;
}
