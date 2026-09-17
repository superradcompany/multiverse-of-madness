export interface EntityObservation {
  kind: 'enemy' | 'projectile' | 'pickup' | 'object';
  engineType: number;
  health: number;
  position: { x: number; y: number; z: number };
  distance: number;
  relativeBearing: number;
  heading: number;
  direction: { x: number; y: number };
  // Geometric alignment only: +1 points toward the player, -1 away.
  towardPlayerAlignment: number;
}
