import { getModelProviderLogo } from "@app/components/providers/types";
import { useTheme } from "@app/components/sparkle/ThemeContext";
import { useFeatureFlags } from "@app/lib/auth/AuthContext";
import { useModels } from "@app/lib/swr/models";
import type { AgentModelConfigurationType } from "@app/types/assistant/agent";
import { getProviderDisplayName } from "@app/types/assistant/models/providers";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Button,
  Chip,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Spinner,
  Stars01,
} from "@dust-tt/sparkle";
import { useMemo, useState } from "react";

// Frontend-only picker. Tiers are display labels for now — selecting anything
// here only updates local UI state and does not affect generation.
const TIERS = ["Fast", "Balanced", "Powerful", "Frontier"] as const;
type Tier = (typeof TIERS)[number];

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  Fast: "Fastest responses, for simple, high-volume tasks.",
  Balanced: "A good balance of speed and quality for everyday work.",
  Powerful: "Higher quality for complex, multi-step reasoning.",
  Frontier: "The most capable models, for the hardest work.",
};

// Either one of the named tiers, or "advanced" with an explicitly picked model.
// In advanced mode, a null model means "follow the agent's configured model".
type Selection =
  | { kind: "tier"; tier: Tier }
  | { kind: "advanced"; model: ModelConfigurationType | null };

interface InputBarModelPickerProps {
  // The selected agent's configured model. Used as the default preselection:
  // for most agents this resolves to "Advanced > the agent's model".
  agentModel: AgentModelConfigurationType | null;
  owner: LightWorkspaceType;
  buttonSize: "xs" | "sm";
  disabled?: boolean;
}

export function InputBarModelPicker({
  agentModel,
  owner,
  buttonSize,
  disabled,
}: InputBarModelPickerProps) {
  const { hasFeature } = useFeatureFlags();
  const hasModelsPicker = hasFeature("models_picker");
  const { isDark } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  // Default the cursor to the agent's preselection (Advanced > its model).
  const [selection, setSelection] = useState<Selection>({
    kind: "advanced",
    model: null,
  });

  // Fetch eagerly (not gated on open): the trigger label resolves the agent's
  // model name from this list even while the dropdown is closed. SWR caches it.
  // Skipped entirely when the flag is off (the component renders null below).
  const { models, isModelsLoading } = useModels({
    owner,
    disabled: !hasModelsPicker,
  });

  // The agent's configured model resolved against the enabled model list.
  const resolvedAgentModel = useMemo(
    () => models.find((m) => m.modelId === agentModel?.modelId) ?? null,
    [models, agentModel?.modelId]
  );

  const isAdvancedActive = selection.kind === "advanced";
  // In advanced mode, fall back to the agent's model until the user picks one.
  const effectiveAdvancedModel = isAdvancedActive
    ? (selection.model ?? resolvedAgentModel)
    : resolvedAgentModel;

  const label =
    selection.kind === "tier"
      ? selection.tier
      : (effectiveAdvancedModel?.displayName ?? "Advanced");

  if (!hasModelsPicker) {
    return null;
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost-secondary"
          size={buttonSize}
          icon={Stars01}
          label={label}
          disabled={disabled}
          isSelect
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="start" side="top">
        <DropdownMenuRadioGroup
          value={selection.kind === "tier" ? selection.tier : undefined}
        >
          {TIERS.map((tier) => (
            <DropdownMenuRadioItem
              key={tier}
              value={tier}
              label={tier}
              description={TIER_DESCRIPTIONS[tier]}
              onClick={() => setSelection({ kind: "tier", tier })}
            />
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            label="Advanced"
            className={cn(
              isAdvancedActive && "bg-highlight-50 dark:bg-highlight-50-night"
            )}
          />
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-72">
              {isModelsLoading ? (
                <div className="flex h-20 items-center justify-center">
                  <Spinner size="sm" />
                </div>
              ) : (
                <DropdownMenuRadioGroup
                  value={effectiveAdvancedModel?.modelId ?? undefined}
                >
                  {models.map((model) => (
                    <DropdownMenuRadioItem
                      key={`${model.providerId}/${model.modelId}`}
                      value={model.modelId}
                      icon={getModelProviderLogo(model.providerId, isDark)}
                      label={model.displayName}
                      description={getProviderDisplayName(model.providerId)}
                      // Flag the agent's configured model so the default is
                      // recognizable when the picker opens.
                      endComponent={
                        model.modelId === resolvedAgentModel?.modelId ? (
                          <Chip size="mini" label="Default" color="highlight" />
                        ) : undefined
                      }
                      onClick={() => setSelection({ kind: "advanced", model })}
                    />
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
