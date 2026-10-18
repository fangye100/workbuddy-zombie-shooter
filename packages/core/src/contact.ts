/** 严格穿入才算重叠；接触容差取 10μm 与两 Float32 ULP 中较大者。 */
export function intervalsPenetrate(aMin:number,aMax:number,bMin:number,bMax:number):boolean {
  const tolerance=Math.max(1e-5,Math.max(Math.abs(aMin),Math.abs(aMax),Math.abs(bMin),Math.abs(bMax))*2**-22);
  return aMax>bMin+tolerance&&aMin<bMax-tolerance;
}
