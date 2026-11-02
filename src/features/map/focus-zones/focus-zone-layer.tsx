import { memo } from 'react';
import { Polygon } from 'react-native-maps';

import type { FocusContour } from './focus-zones';

/** Fill opacity per isoline level, outermost first. */
const FILL_OPACITY = [0.16, 0.22, 0.3] as const;
const STROKE_OPACITY = 0.95;
const STROKE_WIDTH = 1.5;

/** Isolines of the focus zones, lowest level first so inner levels stack on top. */
export function FocusZoneLayer({
  contours,
  onPressContour,
}: {
  contours: readonly FocusContour[];
  onPressContour?: (contour: FocusContour) => void;
}) {
  return contours.map((contour) => (
    <FocusContourPolygon key={contour.id} contour={contour} onPress={onPressContour} />
  ));
}

const FocusContourPolygon = memo(function FocusContourPolygon({
  contour,
  onPress,
}: {
  contour: FocusContour;
  onPress?: (contour: FocusContour) => void;
}) {
  return (
    <Polygon
      tappable={onPress !== undefined}
      onPress={onPress ? () => onPress(contour) : undefined}
      coordinates={contour.coordinates}
      holes={contour.holes.length > 0 ? contour.holes : undefined}
      fillColor={rgba(contour.color, FILL_OPACITY[contour.levelIndex])}
      strokeColor={rgba(contour.color, STROKE_OPACITY)}
      strokeWidth={STROKE_WIDTH}
      lineJoin="round"
      zIndex={5 + contour.levelIndex}
    />
  );
});

function rgba(hex: string, opacity: number) {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}
