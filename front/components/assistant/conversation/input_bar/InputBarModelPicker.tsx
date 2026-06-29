import { getModelProviderLogo } from "@app/components/providers/types";
import { useTheme } from "@app/components/sparkle/ThemeContext";
import { useFeatureFlags } from "@app/lib/auth/AuthContext";
import { useModels } from "@app/lib/swr/models";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import { getProviderDisplayName } from "@app/types/assistant/models/providers";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Brain,
  Button,
  Check,
  ChevronRight,
  cn,
  HelpCircle,
  Icon,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Robot,
  Sliders04,
  Spinner,
  Stars01,
  Tooltip,
} from "@dust-tt/sparkle";
import type React from "react";
import { useState } from "react";

// Frontend-only picker. Tiers are display labels for now — selecting anything
// here only updates local UI state and does not affect generation.
type PickerMode = "default" | "tier" | "advanced";

const TIERS = ["Fast", "Balanced", "Powerful", "Frontier"] as const;
type TierIndex = 0 | 1 | 2 | 3;

const TIER_DESCRIPTIONS: Record<(typeof TIERS)[number], string> = {
  Fast: "Fastest responses. Best for simple questions and high-volume tasks.",
  Balanced: "A good balance of speed and quality for everyday conversations.",
  Powerful: "Higher quality for complex reasoning and multi-step tasks.",
  Frontier: "The most capable models available, for the hardest work.",
};

interface PickerState {
  mode: PickerMode;
  tierIndex: TierIndex;
  model: ModelConfigurationType | null;
}

function getDisplayLabel(state: PickerState): string {
  switch (state.mode) {
    case "default":
      return "Default";
    case "tier":
      return TIERS[state.tierIndex];
    case "advanced":
      return state.model?.displayName ?? "Advanced";
    default:
      return "Default";
  }
}

function SelectedCheck() {
  return (
    <div className="flex h-5 w-5 shrink-0 animate-in zoom-in-50 items-center justify-center rounded-full bg-highlight duration-150 dark:bg-highlight-night">
      <Icon visual={Check} size="xs" className="text-white" />
    </div>
  );
}

interface RowIconProps {
  visual: React.ComponentType;
  isActive: boolean;
}

function RowIcon({ visual, isActive }: RowIconProps) {
  return (
    <div
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
        isActive
          ? "bg-highlight-100 dark:bg-highlight-100-night"
          : "bg-muted-background dark:bg-muted-background-night"
      )}
    >
      <Icon
        visual={visual}
        size="sm"
        className={
          isActive
            ? "text-highlight dark:text-highlight-night"
            : "text-muted-foreground dark:text-muted-foreground-night"
        }
      />
    </div>
  );
}

interface TierSliderProps {
  tierIndex: TierIndex;
  onTierSelect: (index: TierIndex) => void;
}

function TierSlider({ tierIndex, onTierSelect }: TierSliderProps) {
  const tierPct = (tierIndex / (TIERS.length - 1)) * 100;

  return (
    <div className="animate-in fade-in slide-in-from-top-1 px-3 pb-3 pt-1 duration-150">
      {/* Track */}
      <div className="relative mb-2.5 h-1.5">
        <div className="absolute inset-0 rounded-full bg-highlight-100 dark:bg-highlight-100-night" />
        <div
          className="absolute bottom-0 left-0 top-0 rounded-full bg-highlight transition-[width] duration-200 ease-out dark:bg-highlight-night"
          style={{ width: `${tierPct}%` }}
        />
        <div
          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-highlight transition-[left] duration-200 ease-out dark:bg-highlight-night"
          style={{ left: `${tierPct}%`, top: "50%" }}
        />
      </div>
      {/* Evenly spaced, clickable labels. */}
      <div className="relative h-4">
        {TIERS.map((tier, i) => {
          const isActive = tierIndex === i;
          const pct = (i / (TIERS.length - 1)) * 100;
          // Edge labels align to the track ends; inner labels are centered on
          // their stop so they never overlap.
          const style: React.CSSProperties =
            i === 0
              ? { left: 0 }
              : i === TIERS.length - 1
                ? { right: 0 }
                : { left: `${pct}%`, transform: "translateX(-50%)" };
          return (
            <button
              key={tier}
              type="button"
              style={style}
              onClick={() => onTierSelect(i as TierIndex)}
              className={cn(
                "absolute top-0 text-xs font-medium",
                isActive
                  ? "text-highlight dark:text-highlight-night"
                  : "text-muted-foreground dark:text-muted-foreground-night"
              )}
            >
              {tier}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface AdvancedModelListProps {
  owner: LightWorkspaceType;
  isOpen: boolean;
  selectedModelId: string | null;
  onModelSelect: (model: ModelConfigurationType) => void;
}

function AdvancedModelList({
  owner,
  isOpen,
  selectedModelId,
  onModelSelect,
}: AdvancedModelListProps) {
  const { isDark } = useTheme();
  // Only fetch the model list while the advanced section is expanded.
  const { models, isModelsLoading } = useModels({ owner, disabled: !isOpen });

  if (isModelsLoading) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="max-h-56 animate-in fade-in slide-in-from-top-1 overflow-y-auto px-1 pb-1 duration-150">
      {models.map((model) => {
        const isSelected = model.modelId === selectedModelId;
        return (
          <button
            key={`${model.providerId}/${model.modelId}`}
            type="button"
            onClick={() => onModelSelect(model)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted-background dark:hover:bg-muted-background-night"
          >
            <Icon
              visual={getModelProviderLogo(model.providerId, isDark)}
              size="sm"
            />
            <span
              className={cn(
                "truncate text-sm",
                isSelected
                  ? "text-highlight dark:text-highlight-night"
                  : "text-foreground dark:text-foreground-night"
              )}
            >
              {model.displayName}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground dark:text-muted-foreground-night">
              {getProviderDisplayName(model.providerId)}
            </span>
            <div className="grow" />
            {isSelected && (
              <Icon
                visual={Check}
                size="sm"
                className="text-highlight dark:text-highlight-night"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

interface InputBarModelPickerProps {
  owner: LightWorkspaceType;
  buttonSize: "xs" | "sm";
  disabled?: boolean;
}

export function InputBarModelPicker({
  owner,
  buttonSize,
  disabled,
}: InputBarModelPickerProps) {
  const { hasFeature } = useFeatureFlags();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<PickerState>({
    mode: "default",
    tierIndex: 1,
    model: null,
  });

  if (!hasFeature("models_picker")) {
    return null;
  }

  return (
    // Non-modal: a modal popover scroll-locks the body (shifting the layout)
    // and disables pointer events behind it (input-bar icons become
    // unclickable). See `onFocusOutside` below for the auto-close fix.
    <PopoverRoot open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost-secondary"
          size={buttonSize}
          icon={Stars01}
          // Icon-only on mobile to save toolbar space; the selection is still
          // shown in the panel. The label is kept on larger screens.
          label={isMobile ? undefined : getDisplayLabel(state)}
          tooltip={isMobile ? getDisplayLabel(state) : undefined}
          disabled={disabled}
          isSelect
        />
      </PopoverTrigger>
      <PopoverContent
        fullWidth
        side="top"
        align="start"
        collisionPadding={8}
        // Opening the popover must not steal focus into it on mobile, which
        // would shift the viewport.
        onOpenAutoFocus={(e) => {
          if (isMobile) {
            e.preventDefault();
          }
        }}
        // The input bar refocuses the editor when its container is clicked,
        // which would otherwise close the popover right after opening. Keep it
        // open on focus-out; outside taps still close it via pointer-down.
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="w-72 max-w-[calc(100vw-1.5rem)] p-1">
          {/* ── Default ── */}
          <button
            type="button"
            onClick={() => setState((prev) => ({ ...prev, mode: "default" }))}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150",
              state.mode === "default"
                ? "bg-highlight-50 dark:bg-highlight-50-night"
                : "hover:bg-muted-background dark:hover:bg-muted-background-night"
            )}
          >
            <RowIcon visual={Robot} isActive={state.mode === "default"} />
            <span
              className={cn(
                "flex-1 text-sm font-medium",
                state.mode === "default"
                  ? "text-highlight dark:text-highlight-night"
                  : "text-foreground dark:text-foreground-night"
              )}
            >
              Default
            </span>
            <Tooltip
              side="top"
              label="Uses the model configured on the agent."
              tooltipTriggerAsChild
              trigger={
                <span
                  className="flex items-center text-muted-foreground dark:text-muted-foreground-night"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon visual={HelpCircle} size="xs" />
                </span>
              }
            />
            {state.mode === "default" && <SelectedCheck />}
          </button>

          {/* ── Tier ── */}
          <div
            className={cn(
              "rounded-xl transition-colors duration-150",
              state.mode === "tier"
                ? "bg-highlight-50 dark:bg-highlight-50-night"
                : "cursor-pointer hover:bg-muted-background dark:hover:bg-muted-background-night"
            )}
            onClick={() => {
              if (state.mode !== "tier") {
                setState((prev) => ({ ...prev, mode: "tier" }));
              }
            }}
          >
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <RowIcon visual={Sliders04} isActive={state.mode === "tier"} />
              <span
                className={cn(
                  "flex-1 text-sm font-medium",
                  state.mode === "tier"
                    ? "text-highlight dark:text-highlight-night"
                    : "text-foreground dark:text-foreground-night"
                )}
              >
                {TIERS[state.tierIndex]}
              </span>
              <Tooltip
                side="top"
                label={TIER_DESCRIPTIONS[TIERS[state.tierIndex]]}
                tooltipTriggerAsChild
                trigger={
                  <span
                    className="flex items-center text-muted-foreground dark:text-muted-foreground-night"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon visual={HelpCircle} size="xs" />
                  </span>
                }
              />
              {state.mode === "tier" && <SelectedCheck />}
            </div>
            {state.mode === "tier" && (
              <TierSlider
                tierIndex={state.tierIndex}
                onTierSelect={(tierIndex) =>
                  setState((prev) => ({ ...prev, mode: "tier", tierIndex }))
                }
              />
            )}
          </div>

          {/* ── Advanced ── */}
          <button
            type="button"
            onClick={() =>
              setState((prev) => ({
                ...prev,
                mode: prev.mode === "advanced" ? "tier" : "advanced",
              }))
            }
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150",
              state.mode === "advanced"
                ? "bg-highlight-50 dark:bg-highlight-50-night"
                : "hover:bg-muted-background dark:hover:bg-muted-background-night"
            )}
          >
            <RowIcon visual={Brain} isActive={state.mode === "advanced"} />
            <span
              className={cn(
                "flex-1 text-sm font-medium",
                state.mode === "advanced"
                  ? "text-highlight dark:text-highlight-night"
                  : "text-foreground dark:text-foreground-night"
              )}
            >
              Advanced
            </span>
            <Icon
              visual={ChevronRight}
              size="sm"
              className={cn(
                "transition-transform duration-150",
                state.mode === "advanced"
                  ? "rotate-90 text-highlight dark:text-highlight-night"
                  : "text-muted-foreground dark:text-muted-foreground-night"
              )}
            />
          </button>

          {state.mode === "advanced" && (
            <AdvancedModelList
              owner={owner}
              isOpen={isOpen}
              selectedModelId={state.model?.modelId ?? null}
              onModelSelect={(model) =>
                setState((prev) => ({ ...prev, mode: "advanced", model }))
              }
            />
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
