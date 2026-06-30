import { Card } from "@sparkle/components/Card";
import { Counter } from "@sparkle/components/Counter";
import { cn } from "@sparkle/lib/utils";
import React from "react";

interface OptionCardSharedProps {
  counterValue?: number;
  selected?: boolean;
  disabled?: boolean;
  disableHover?: boolean;
  className?: string;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
}

interface OptionCardOptionProps extends OptionCardSharedProps {
  type?: "option";
  label: string;
  description?: string | null;
  onClick?: () => void;
}

interface OptionCardInputProps extends OptionCardSharedProps {
  // Input state (mirrors Figma's `State=Input`): a free-text "type something
  // else" option. The field is rendered and styled by OptionCard (borderless,
  // faint placeholder); the card keeps the same chrome and counter.
  type: "input";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // Accessible name for the field (screen readers). Falls back to the
  // placeholder so the input is never unlabeled.
  ariaLabel?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  name?: string;
  id?: string;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}

export type OptionCardProps = OptionCardOptionProps | OptionCardInputProps;

export function OptionCard(props: OptionCardProps) {
  const {
    counterValue,
    selected = false,
    disabled = false,
    disableHover = false,
    className,
    onFocusCapture,
    onMouseEnter,
  } = props;

  const isInput = props.type === "input";
  const onClick = isInput ? undefined : props.onClick;
  const isInteractive = onClick !== undefined && !disabled;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Enter" || e.key === " ") && onClick) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <Card
      variant="tertiary"
      size="sm"
      className={cn(
        "w-full items-center gap-2 text-left transition-colors",
        isInteractive && "cursor-pointer",
        // In input mode `disabled` targets the field, not the card chrome.
        !isInput && disabled && "pointer-events-none opacity-60",
        // Selected state is a flat "transparency-selected" overlay (6% of the
        // foreground); the token is dark-mode aware on its own.
        selected && "bg-foreground/[0.06] hover:bg-foreground/[0.06]",
        // In input mode, focus uses the bordered-input focus treatment
        // (border-dark), matching the design system's Input focus state.
        isInput && "focus-within:border-border-dark",
        !selected &&
          !disableHover &&
          !isInput &&
          "hover:bg-muted-background/60",
        className
      )}
      onClick={disabled ? undefined : onClick}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      onFocusCapture={onFocusCapture}
      onMouseEnter={onMouseEnter}
      tabIndex={
        isInput ? undefined : disabled ? -1 : isInteractive ? 0 : undefined
      }
      aria-pressed={isInteractive ? selected : undefined}
    >
      {counterValue !== undefined && (
        <Counter
          value={counterValue}
          size="xs"
          variant="outline"
          className="shrink-0"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {props.type === "input" ? (
          <input
            ref={props.inputRef}
            type="text"
            id={props.id}
            name={props.name}
            value={props.value}
            placeholder={props.placeholder}
            aria-label={props.ariaLabel ?? props.placeholder}
            disabled={disabled}
            onChange={(e) => props.onChange(e.target.value)}
            onFocus={props.onFocus}
            onBlur={props.onBlur}
            onKeyDown={props.onKeyDown}
            className={cn(
              "w-full border-0 bg-transparent p-0 shadow-none outline-none",
              // No blue focus ring on the field; focus is shown by the card's
              // greyscale border (focus-within) instead.
              "focus:ring-0 focus-visible:ring-0 focus-visible:outline-none",
              "copy-sm text-foreground placeholder:text-faint",
              "disabled:cursor-not-allowed"
            )}
          />
        ) : (
          <>
            <span className="text-sm font-medium tracking-[-0.28px] text-foreground">
              {props.label}
            </span>
            {props.description && (
              <span className="text-xs text-muted-foreground">
                {props.description}
              </span>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
