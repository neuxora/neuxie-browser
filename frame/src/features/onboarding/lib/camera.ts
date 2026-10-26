/** The stage onboarding composes on, in its own pixels; the whole of it is
 *  scaled to the window, so every scene keeps its proportions. */
export const STAGE = { width: 1240, height: 780 } as const;

/** The window drawn on the stage, at its own full size. */
export const WINDOW = { width: 880, height: 560 } as const;

/** The page inside that window while it browses, in the window's pixels. */
export const PAGE = { x: 248, y: 8, width: 624, height: 544 } as const;

/** The page's new tab, laid out as the real one lays itself out at this
 *  size: the field's notch, the horizon, and the name low in the sky with
 *  the time under it. In the page's pixels. */
export const NEWTAB = {
  notch: { width: 380, height: 38 },
  horizon: 326,
  // The name box keeps the letters' own aspect (773.93 / 3652.93) at the
  // width the mock draws it, so the still wordmark and the dots that gather
  // into it are never stretched; its bottom edge holds the old baseline.
  name: { x: 199.5, y: 207.64, w: 225, h: 47.67 },
  when: 265,
} as const;

export type Shot = {
  /** How large the window is drawn. */
  scale: number;
  /** The point of the window to frame, in the window's pixels. */
  focus: readonly [number, number];
  /** Where on the stage that point lands. */
  at: readonly [number, number];
  /** How far down the window, in its pixels, it is drawn before it has
   *  faded into the ground; a shot without one shows all of it. */
  fade?: number;
};

const CENTRE = [WINDOW.width / 2, WINDOW.height / 2] as const;

/** One framing of the window per scene. Each keeps clear of the heading
 *  above it and the controls below it, and neighbours differ, so moving on
 *  is always a move. Welcome and leaving are `cover`. */
export const SHOTS = {
  // Whole, to the left, so the folder an import brings lands in plain view.
  import: { scale: 0.7, focus: CENTRE, at: [400, 468] },
  // Crossing to the right and closing in on the dock.
  essentials: { scale: 0.78, focus: [230, 410], at: [846, 560] },
  // Lowered out of the frame while the launcher has the stage.
  launcher: { scale: 0.7, focus: CENTRE, at: [620, 1180] },
  work: { scale: 0.82, focus: CENTRE, at: [620, 452] },
  // Sunk back under the choices, only its top showing: what they power.
  ai: { scale: 0.78, focus: [440, 0], at: [620, 500], fade: 240 },
  ready: { scale: 0.7, focus: CENTRE, at: [620, 462] },
} as const satisfies Record<string, Shot>;

/** Close enough on the window's page that its sky is all there is: the
 *  view, in stage pixels, is covered edge to edge with a little to spare,
 *  so the page's rounded corners never show. */
export function cover(view: { width: number; height: number }): Shot {
  const scale = Math.max(view.width / PAGE.width, view.height / PAGE.height, 1) * 1.04;
  return {
    scale,
    focus: [PAGE.x + PAGE.width / 2, PAGE.y + PAGE.height / 2],
    at: [STAGE.width / 2, STAGE.height / 2],
  };
}

/** Where a point of the window lands on the stage in a shot. */
export function land(shot: Shot, [x, y]: readonly [number, number]): [number, number] {
  return [
    shot.at[0] + shot.scale * (x - shot.focus[0]),
    shot.at[1] + shot.scale * (y - shot.focus[1]),
  ];
}

/** The transform that puts a shot's focus where it belongs, the window
 *  being drawn from its own top left and scaled about its centre. */
export function frame(shot: Shot): string {
  const [cx, cy] = CENTRE;
  const x = shot.at[0] - cx - shot.scale * (shot.focus[0] - cx);
  const y = shot.at[1] - cy - shot.scale * (shot.focus[1] - cy);
  return `translate(${round(x)}px, ${round(y)}px) scale(${round(shot.scale, 4)})`;
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
