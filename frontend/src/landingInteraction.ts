export type EyePoint = Readonly<{ x: number; y: number }>;

export function eyeTarget(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }): EyePoint {
  const horizontal = ((clientX - bounds.left) / bounds.width - 0.5) * 24;
  const vertical = ((clientY - bounds.top) / bounds.height - 0.5) * 14;
  return { x: Math.max(-11, Math.min(11, horizontal)), y: Math.max(-6, Math.min(6, vertical)) };
}

export function shouldEnterEyePipeline(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function activateEyeEntry(enter: () => void, key?: string): boolean {
  if (key !== undefined && !shouldEnterEyePipeline(key)) return false;
  enter();
  return true;
}
