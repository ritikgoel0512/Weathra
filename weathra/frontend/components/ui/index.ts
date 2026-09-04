/**
 * The primitive layer's single import point — task 20.3.
 *
 * Screens import from here rather than reaching into individual files, so the boundary between
 * "the design system" and "this screen's markup" stays visible in an import line.
 *
 * What is deliberately *not* here: the attribution footer, the uncertainty indicator and the
 * AI-interpretation panel treatment (task 20.15), the application shell and its navigation (task
 * 20.12), and anything a single screen needs (task group 21).
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
