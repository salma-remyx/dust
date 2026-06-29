import { getModelProviderLogo } from "@app/components/providers/types";
import { useTheme } from "@app/components/sparkle/ThemeContext";
import { useFeatureFlags } from "@app/lib/auth/AuthContext";
import { useModels } from "@app/lib/swr/models";
import type { AgentModelConfigurationType } from "@app/types/assistant/agent";
import { getProviderDisplayName } from "@app/types/assistant/models/providers";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";
import { assertNeverAndIgnore } from "@app/types/shared/utils/assert_never";
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

// `modelId` is not unique across providers, so identify models by
// `providerId/modelId`. Used for radio values and equality checks.
function getModelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`;
}

interface InputBarModelPickerProps {
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

  // Reset on agent change
  const agentModelKey = agentModel
    ? `${agentModel.providerId}/${agentModel.modelId}`
    : null;
  const [prevAgentModelKey, setPrevAgentModelKey] = useState(agentModelKey);
  if (agentModelKey !== prevAgentModelKey) {
    setPrevAgentModelKey(agentModelKey);
    setSelection({ kind: "advanced", model: null });
  }

  const { models, isModelsLoading } = useModels({
    owner,
    disabled: !hasModelsPicker,
  });

  // Match on providerId + modelId, since modelId is not unique across providers.
  const resolvedAgentModel = useMemo(
    () =>
      models.find(
        (m) =>
          m.providerId === agentModel?.providerId &&
          m.modelId === agentModel?.modelId
      ) ?? null,
    [models, agentModel?.providerId, agentModel?.modelId]
  );

  const isAdvancedActive = selection.kind === "advanced";
  // In advanced mode, fall back to the agent's model until the user picks one.
  const effectiveAdvancedModel = isAdvancedActive
    ? (selection.model ?? resolvedAgentModel)
    : resolvedAgentModel;

  const label = (() => {
    switch (selection.kind) {
      case "tier":
        return selection.tier;
      case "advanced":
        return effectiveAdvancedModel?.displayName ?? "Advanced";
      default:
        assertNeverAndIgnore(selection);
        return "Advanced";
    }
  })();

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
                  value={
                    effectiveAdvancedModel
                      ? getModelKey(effectiveAdvancedModel)
                      : undefined
                  }
                >
                  {models.map((model) => (
                    <DropdownMenuRadioItem
                      key={getModelKey(model)}
                      value={getModelKey(model)}
                      icon={getModelProviderLogo(model.providerId, isDark)}
                      label={model.displayName}
                      description={getProviderDisplayName(model.providerId)}
                      endComponent={
                        resolvedAgentModel &&
                        getModelKey(model) ===
                          getModelKey(resolvedAgentModel) ? (
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
