export interface CanvasFitInput {
  stageWidth: number;
  stageHeight: number;
  frameWidth: number;
  frameHeight: number;
  devicePixelRatio: number;
}

export interface CanvasFitResult {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
}

const MIN_BACKING_SCALE = 0.25;
const MAX_BACKING_SCALE = 2;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Calculate an equal-aspect canvas size for a stage.
 *
 * CSS dimensions are returned in CSS pixels. Backing dimensions preserve the
 * existing integer supersampling policy so layout scale and render resolution
 * can be changed independently without distorting the VM frame.
 */
export function calculateCanvasFit(input: CanvasFitInput): CanvasFitResult | null {
  if (
    !isPositiveFinite(input.stageWidth) ||
    !isPositiveFinite(input.stageHeight) ||
    !isPositiveFinite(input.frameWidth) ||
    !isPositiveFinite(input.frameHeight) ||
    !isPositiveFinite(input.devicePixelRatio)
  ) {
    return null;
  }

  const exactScale = Math.min(
    (input.stageWidth * input.devicePixelRatio) / input.frameWidth,
    (input.stageHeight * input.devicePixelRatio) / input.frameHeight,
  );
  // CSS must use the exact fit scale. The backing store may stay at the
  // minimum render scale, but flooring the CSS scale would crop tiny stages.
  const cssScale = exactScale;
  const backingScale =
    exactScale >= 1 ? Math.min(MAX_BACKING_SCALE, Math.ceil(exactScale)) : Math.max(MIN_BACKING_SCALE, exactScale);

  return {
    cssWidth: Math.round(input.frameWidth * cssScale) / input.devicePixelRatio,
    cssHeight: Math.round(input.frameHeight * cssScale) / input.devicePixelRatio,
    backingWidth: Math.max(1, Math.round(input.frameWidth * backingScale)),
    backingHeight: Math.max(1, Math.round(input.frameHeight * backingScale)),
  };
}
