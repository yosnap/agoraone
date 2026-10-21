/**
 * Where the first-person walker stands and faces, written every frame by the 3D navigation and read by
 * the minimap. A plain mutable object on purpose: per-frame values must not re-render React.
 * `heading` is in radians, 0 facing −z (north on the map) and growing clockwise.
 */
export const playerPose = { x: 0, z: 0, heading: 0 };
