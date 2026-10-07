/** Runtime headings are atan2(z, x): 0 faces +X, positive turns toward +Z.
 * Render Y rotations turn a +Z-forward character toward +X. Convert at the
 * presentation boundary; combat rays and navigation keep their heading contract.
 */
export function characterYaw(heading: number): number {
  return Math.PI / 2 - heading;
}
