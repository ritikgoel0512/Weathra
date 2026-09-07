/**
 * The primitive layer's single import point — task 20.3.
 *
 * Screens import from here rather than reaching into individual files, so the boundary between
 * "the design system" and "this screen's markup" stays visible in an import line.
 *
 * What is deliberately *not* here: the application shell and its navigation (task 20.12), and
 * anything a single screen needs (task group 21). The provenance layer — attribution, uncertainty,
 * the analytics method note and the AI-interpretation treatment — joined in task 20.15 and is
 * exported below, because every product screen in group 21 needs all four.
 */

export { Badge, DataClassBadge, DATA_CLASS_LABELS, DATA_CLASS_DESCRIPTIONS } from "./badge";
export type { BadgeProps, BadgeTone, DataClassBadgeProps } from "./badge";

export { Button } from "./button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./button";

export { Field } from "./field";
export type { FieldControl, FieldProps } from "./field";

export { Input } from "./input";
export type { InputProps } from "./input";

export { Metric } from "./metric";
export type { MetricProps } from "./metric";

export { ScrollRegion } from "./scroll-region";
export type { ScrollRegionProps } from "./scroll-region";

export { Select } from "./select";
export type { SelectOption, SelectProps } from "./select";

export { Skeleton } from "./skeleton";
export type { SkeletonProps } from "./skeleton";

export { Card, CardBody, CardFooter, CardHeader, Surface } from "./surface";
export type { CardHeaderProps, CardProps, SurfaceLevel, SurfaceProps } from "./surface";

export { EmptyState, ErrorState, LoadingState } from "./states";
export type { EmptyStateProps, ErrorStateProps, LoadingStateProps } from "./states";

export { TabPanel, Tabs, tabId, tabPanelId } from "./tabs";
export type { TabDescriptor, TabPanelProps, TabsProps } from "./tabs";

export {
  AttributionFooter,
  CONFIDENCE_LABELS,
  COMPUTED_BY_WEATHRA,
  INTERPRETATION_BOUNDARY,
  InterpretationPanel,
  MethodNote,
  NO_SPREAD_AVAILABLE,
  NOT_REPORTED,
  ProvenanceSection,
  UncertaintyIndicator,
  formatInstant,
  formatLocalStamp,
} from "./provenance";
export type {
  Attribution,
  AttributionFooterProps,
  AttributionPeriod,
  InterpretationPanelProps,
  MethodNoteProps,
  ProvenanceSectionProps,
  UncertaintyIndicatorProps,
} from "./provenance";

export { LocationImage, slugForLocation } from "./location-image";
export type { LocationImageProps } from "./location-image";

export { EmptyChart } from "./chart-frame";
export type { ChartFrameProps } from "./chart-frame";

export { Meter } from "./meter";
export type { MeterProps } from "./meter";

export { FixtureBanner } from "./fixture-banner";
