// Animated count-up for hero numbers. Wraps Svelte's Tween so a card can feed
// it fresh values on every poll and render the eased in-between frames.
// Honors prefers-reduced-motion by snapping instantly.

import { cubicOut } from "svelte/easing";
import { Tween } from "svelte/motion";

const reducedMotion =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

export class CountUp {
  #tween: Tween<number>;

  constructor(initial = 0, duration = 650) {
    this.#tween = new Tween(initial, {
      duration: reducedMotion ? 0 : duration,
      easing: cubicOut,
    });
  }

  /** Aim the counter at a new value (call from $effect on derived data). */
  set(value: number): void {
    if (!Number.isFinite(value)) return;
    this.#tween.target = value;
  }

  /** The eased current value — reactive, render this. */
  get value(): number {
    return this.#tween.current;
  }
}
