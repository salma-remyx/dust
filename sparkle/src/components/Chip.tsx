import { AnimatedText } from "@sparkle/components/AnimatedText";
import {
  LinkWrapper,
  type LinkWrapperProps,
} from "@sparkle/components/LinkWrapper";
import { XClose } from "@sparkle/icons/v2-stroke";
import { cn } from "@sparkle/lib/utils";
import { cva } from "class-variance-authority";
import React, { type ComponentType, type ReactNode } from "react";
import { Icon, type IconProps } from "./Icon";

export const CHIP_SIZES = ["mini", "xs", "sm"] as const;

type ChipSizeType = (typeof CHIP_SIZES)[number];

export const CHIP_COLORS = [
  "primary",
  "success",
  "warning",
  "info",
  "highlight",
  "green",
  "blue",
  "rose",
  "golden",
  "white",
] as const;

type ChipColorType = (typeof CHIP_COLORS)[number];

const chipVariants = cva("inline-flex box-border items-center", {
  variants: {
    size: {
      // Aligned to Figma Badge tiers: Small (20px), Medium (24px), Large (32px).
      mini: "rounded-lg min-h-5 text-xs font-medium px-1.5 gap-1",
      xs: "rounded-[9px] min-h-6 heading-xs px-[9px] gap-1",
      sm: "rounded-xl min-h-8 heading-sm px-3 gap-1.5",
    },
    // Borderless, light (50) background with a darker (700) label, per the
    // Figma Badge design. Semantic scales (highlight/success/info/warning)
    // auto-flip in the `.dark` block, so they need no dark variants.
    // Raw palette scales (stone/emerald/blue/rose/golden) are not redefined in
    // `.dark`, so they carry explicit dark variants (shade -> 1000 - shade).
    // Use the literal Figma hues: "Gray" is stone (warm), "Green" is emerald.
    color: {
      primary: cn(
        "bg-stone-50 text-stone-700",
        "dark:bg-stone-950 dark:text-stone-300"
      ),
      highlight: cn("bg-highlight-50 text-highlight-700"),
      success: cn("bg-success-50 text-success-700"),
      info: cn("bg-info-50 text-info-700"),
      warning: cn("bg-warning-50 text-warning-700"),
      green: cn(
        "bg-emerald-50 text-emerald-700",
        "dark:bg-emerald-950 dark:text-emerald-300"
      ),
      blue: cn(
        "bg-blue-50 text-blue-700",
        "dark:bg-blue-950 dark:text-blue-300"
      ),
      rose: cn(
        "bg-rose-50 text-rose-700",
        "dark:bg-rose-950 dark:text-rose-300"
      ),
      golden: cn(
        "bg-golden-50 text-golden-700",
        "dark:bg-golden-950 dark:text-golden-300"
      ),
      white: cn("border bg-background border-border", "text-primary-700"),
    },
  },
  defaultVariants: {
    size: "xs",
    color: "primary",
  },
});

const closeIconVariants: Record<ChipColorType, string> = {
  primary: cn(
    "text-stone-700 hover:text-stone-900 active:text-stone-950",
    "dark:text-stone-300 dark:hover:text-stone-100 dark:active:text-stone-50"
  ),
  highlight: cn(
    "text-highlight-700 hover:text-highlight-900 active:text-highlight-950"
  ),
  success: cn(
    "text-success-700 hover:text-success-900 active:text-success-950"
  ),
  warning: cn(
    "text-warning-700 hover:text-warning-900 active:text-warning-950"
  ),
  info: cn("text-info-700 hover:text-info-900 active:text-info-950"),
  green: cn(
    "text-emerald-700 hover:text-emerald-900 active:text-emerald-950",
    "dark:text-emerald-300 dark:hover:text-emerald-100 dark:active:text-emerald-50"
  ),
  blue: cn(
    "text-blue-700 hover:text-blue-900 active:text-blue-950",
    "dark:text-blue-300 dark:hover:text-blue-100 dark:active:text-blue-50"
  ),
  rose: cn(
    "text-rose-700 hover:text-rose-900 active:text-rose-950",
    "dark:text-rose-300 dark:hover:text-rose-100 dark:active:text-rose-50"
  ),
  golden: cn(
    "text-golden-700 hover:text-golden-900 active:text-golden-950",
    "dark:text-golden-300 dark:hover:text-golden-100 dark:active:text-golden-50"
  ),
  white: cn("text-primary-700 hover:text-primary-900 active:text-primary-950"),
};

interface ChipInternalButtonProps {
  icon: ComponentType;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  size?: "xs" | "sm";
  "aria-label"?: string;
}

const ChipButton = React.forwardRef<HTMLButtonElement, ChipInternalButtonProps>(
  ({ icon, onClick, className, size = "xs", "aria-label": ariaLabel }, ref) => (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        "rounded-md p-0.5",
        "transition-colors duration-200 motion-reduce:transition-none",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Icon visual={icon} size={size} />
    </button>
  )
);
ChipButton.displayName = "ChipButton";

type ChipBaseProps = {
  size?: ChipSizeType;
  color?: ChipColorType;
  label?: string;
  children?: ReactNode;
  className?: string;
  isBusy?: boolean;
  icon?: ComponentType;
  onRemove?: () => void;
};

type ChipButtonProps = ChipBaseProps & {
  onClick?: () => void;
} & {
  [K in keyof Omit<LinkWrapperProps, "children" | "className">]?: never;
};

type ChipLinkProps = ChipBaseProps &
  Omit<LinkWrapperProps, "children"> & {
    onClick?: never;
  };

export type ChipProps = ChipLinkProps | ChipButtonProps;

// TODO(yuka: 1606): we should update this component so that you cannot have both
// onClick and onRemove at the same time. We should use div when there is no onClick,
// but use button when there is onClick.
// Since we can have a button inside a button with current implementation, the top level element is a div
// with a role="button", a tabIndex={0} to make it focusable, and onKeyDown handler.
const Chip = React.forwardRef<HTMLDivElement, ChipProps>(
  (
    {
      size,
      color,
      label,
      children,
      className,
      isBusy,
      icon,
      onRemove,
      onClick,
      href,
      ...linkProps
    }: ChipProps,
    ref
  ) => {
    const chipContent = (
      <div
        className={cn(
          chipVariants({ size, color }),
          className,
          onClick && "cursor-pointer"
        )}
        aria-label={label}
        ref={ref}
        onClick={onClick ? () => onClick() : undefined}
        role={onClick ? "button" : undefined}
        onKeyDown={(e) => {
          if (
            onClick &&
            (e.key === "Enter" || e.key === " ") &&
            e.target === e.currentTarget
          ) {
            onClick();
          }
        }}
        tabIndex={onClick ? 0 : undefined}
      >
        {children}
        {icon && (
          <Icon
            visual={icon}
            size={size === "mini" ? "xs" : (size as IconProps["size"])}
          />
        )}
        {label && (
          <span className={cn("grow truncate", onClick && "cursor-pointer")}>
            {isBusy ? (
              <AnimatedText variant={color}>{label}</AnimatedText>
            ) : (
              label
            )}
          </span>
        )}
        {onRemove && (
          <ChipButton
            icon={XClose}
            size={size === "sm" ? "sm" : "xs"}
            className={cn("-mr-1", closeIconVariants[color || "primary"])}
            aria-label="Remove"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
          />
        )}
      </div>
    );
    return href ? (
      <LinkWrapper href={href} {...linkProps}>
        {chipContent}
      </LinkWrapper>
    ) : (
      chipContent
    );
  }
);

Chip.displayName = "Chip";

export { Chip };
