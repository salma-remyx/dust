import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmitAuditLogEvent } = vi.hoisted(() => ({
  mockEmitAuditLogEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@app/lib/api/audit/workos_audit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@app/lib/api/audit/workos_audit")>();

  return { ...actual, emitAuditLogEvent: mockEmitAuditLogEvent };
});

import { getConversation } from "@app/lib/api/assistant/conversation/fetch";
import { updateConversationRequirements } from "@app/lib/api/assistant/conversation/permissions";
import {
  addSelectedConversationSpaces,
  assertCanUseSelectedSpaces,
  getEffectiveSpaceIdsForAgentRun,
  listSelectableRestrictedSpaces,
  RESTRICTED_SPACES_IN_INPUT_BAR_FEATURE_FLAG,
  type SelectedConversationSpacesError,
  validateSelectableRestrictedSpaces,
} from "@app/lib/api/assistant/conversation/selected_spaces";
import { Authenticator } from "@app/lib/auth";
import { ConversationSelectedSpaceResource } from "@app/lib/resources/conversation_selected_space_resource";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import type { Result } from "@app/types/shared/result";
import type { UserType, WorkspaceType } from "@app/types/user";

function unwrapResult<T>(
  result: Result<T, SelectedConversationSpacesError>
): T {
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
}

function expectErrCode<T>(
  result: Result<T, SelectedConversationSpacesError>,
  code: SelectedConversationSpacesError["code"]
) {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe(code);
  }
}

describe("selected conversation Spaces", () => {
  let auth: Authenticator;
  let globalSpace: SpaceResource;
  let user: UserType;
  let workspace: WorkspaceType;

  beforeEach(async () => {
    const setup = await createResourceTest({});
    auth = setup.authenticator;
    globalSpace = setup.globalSpace;
    user = setup.user.toJSON();
    workspace = auth.getNonNullableWorkspace();
    mockEmitAuditLogEvent.mockClear();
  });

  async function enableFeature() {
    await FeatureFlagFactory.basic(
      auth,
      RESTRICTED_SPACES_IN_INPUT_BAR_FEATURE_FLAG
    );
  }

  function regularGroup(space: SpaceResource) {
    const group = space.groups.find((g) => g.kind === "regular");
    if (!group) {
      throw new Error("Expected regular member group on Space");
    }
    return group;
  }

  async function addCurrentUser(space: SpaceResource) {
    const internalAdminAuth = await Authenticator.internalAdminForWorkspace(
      workspace.sId
    );
    await regularGroup(space).dangerouslyAddMembers(internalAdminAuth, {
      users: [user],
    });
    await auth.refresh();
  }

  async function memberRestrictedSpace() {
    const space = await SpaceFactory.regular(workspace);
    await addCurrentUser(space);
    return space;
  }

  async function conversation() {
    return ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
      visibility: "unlisted",
    });
  }

  async function fetchConversation(conversationId: string) {
    const result = await getConversation(auth, conversationId);
    if (result.isErr()) {
      throw result.error;
    }

    return result.value;
  }

  it("rejects selected Spaces when the feature flag is disabled", async () => {
    const restrictedSpace = await memberRestrictedSpace();

    expectErrCode(
      await validateSelectableRestrictedSpaces(auth, {
        spaceIds: [restrictedSpace.sId],
      }),
      "feature_flag_not_found"
    );
  });

  it("rejects selected Spaces for project conversations", async () => {
    await enableFeature();
    const restrictedSpace = await memberRestrictedSpace();
    const projectSpace = await SpaceFactory.project(workspace, user.id);
    await addCurrentUser(projectSpace);
    const projectConversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
      spaceId: projectSpace.id,
      visibility: "unlisted",
    });

    expectErrCode(
      await assertCanUseSelectedSpaces(auth, {
        conversation: projectConversation,
        spaceIds: [restrictedSpace.sId],
      }),
      "conversation_not_mutable"
    );
    expectErrCode(
      await listSelectableRestrictedSpaces(auth, {
        conversation: projectConversation,
      }),
      "conversation_not_mutable"
    );
  });

  it("lists selectable restricted regular Spaces and marks selected ones", async () => {
    await enableFeature();
    const selectedSpace = await memberRestrictedSpace();
    const selectableSpace = await memberRestrictedSpace();
    const inaccessibleSpace = await SpaceFactory.regular(workspace);
    const projectSpace = await SpaceFactory.project(workspace, user.id);
    const conv = await conversation();

    await ConversationSelectedSpaceResource.upsertForConversation(auth, {
      conversation: conv,
      origin: "input_bar",
      spaces: [selectedSpace],
    });

    const selectableSpaces = unwrapResult(
      await listSelectableRestrictedSpaces(auth, { conversation: conv })
    );
    expect(selectableSpaces).toHaveLength(2);
    expect(selectableSpaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sId: selectedSpace.sId, selected: true }),
        expect.objectContaining({ sId: selectableSpace.sId, selected: false }),
      ])
    );
    expect(selectableSpaces.map((space) => space.sId)).not.toEqual(
      expect.arrayContaining([
        globalSpace.sId,
        inaccessibleSpace.sId,
        projectSpace.sId,
      ])
    );
  });

  it("rejects inaccessible and non-restricted Spaces", async () => {
    await enableFeature();
    const inaccessibleSpace = await SpaceFactory.regular(workspace);

    expectErrCode(
      await validateSelectableRestrictedSpaces(auth, {
        spaceIds: [inaccessibleSpace.sId],
      }),
      "space_not_found"
    );
    expectErrCode(
      await validateSelectableRestrictedSpaces(auth, {
        spaceIds: [globalSpace.sId],
      }),
      "space_not_restricted"
    );
  });

  it("materializes selected Spaces, dedupes input, and emits audit events", async () => {
    await enableFeature();
    const selectedSpace = await memberRestrictedSpace();
    const conv = await conversation();

    const result = unwrapResult(
      await addSelectedConversationSpaces(auth, {
        conversation: conv,
        origin: "input_bar",
        spaceIds: [selectedSpace.sId, selectedSpace.sId],
      })
    );

    expect(result.selectedSpaces).toEqual([
      expect.objectContaining({ sId: selectedSpace.sId, selected: true }),
    ]);
    expect(result.effectiveAcl.spaceIds).toContain(selectedSpace.sId);
    expect(mockEmitAuditLogEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.restricted_space_selected",
        metadata: {
          conversation_id: conv.sId,
          origin: "input_bar",
          space_id: selectedSpace.sId,
        },
      })
    );
  });

  it("does not persist selected Spaces when ACL materialization fails", async () => {
    await enableFeature();
    const selectedSpace = await memberRestrictedSpace();
    const conv = await conversation();
    const missingConversationId = `${conv.sId}_missing`;

    expectErrCode(
      await addSelectedConversationSpaces(auth, {
        conversation: { ...conv, sId: missingConversationId },
        origin: "input_bar",
        spaceIds: [selectedSpace.sId],
      }),
      "space_not_selectable"
    );
    expect(
      await ConversationSelectedSpaceResource.listActiveSpacesByConversation(
        auth,
        { conversation: conv }
      )
    ).toEqual([]);
    expect(mockEmitAuditLogEvent).not.toHaveBeenCalled();
  });

  it("uses selected Spaces as effective runtime scope when still valid", async () => {
    await enableFeature();
    const selectedSpace = await memberRestrictedSpace();
    const requestedSpaceModelIds = [globalSpace.id];
    const agentConfiguration = await AgentConfigurationFactory.createTestAgent(
      auth,
      { requestedSpaceIds: requestedSpaceModelIds }
    );
    const conv = await conversation();

    await ConversationSelectedSpaceResource.upsertForConversation(auth, {
      conversation: conv,
      origin: "input_bar",
      spaces: [selectedSpace],
    });

    const effectiveSpaceIds = await getEffectiveSpaceIdsForAgentRun(auth, {
      agentConfiguration,
      conversation: conv,
    });

    expect(effectiveSpaceIds).toEqual(
      expect.arrayContaining([globalSpace.sId, selectedSpace.sId])
    );
  });

  it("ignores selected Spaces at runtime when the feature flag is disabled", async () => {
    const selectedSpace = await memberRestrictedSpace();
    const requestedSpaceModelIds = [globalSpace.id];
    const agentConfiguration = await AgentConfigurationFactory.createTestAgent(
      auth,
      { requestedSpaceIds: requestedSpaceModelIds }
    );
    const conv = await conversation();

    await ConversationSelectedSpaceResource.upsertForConversation(auth, {
      conversation: conv,
      origin: "input_bar",
      spaces: [selectedSpace],
    });

    await expect(
      getEffectiveSpaceIdsForAgentRun(auth, {
        agentConfiguration,
        conversation: conv,
      })
    ).resolves.toEqual([globalSpace.sId]);
  });

  it("keeps selected Spaces when refreshing project requirements", async () => {
    const selectedSpace = await memberRestrictedSpace();
    const projectSpace = await SpaceFactory.project(workspace, user.id);
    await addCurrentUser(projectSpace);
    const projectConversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
      spaceId: projectSpace.id,
      visibility: "unlisted",
    });
    await ConversationSelectedSpaceResource.upsertForConversation(auth, {
      conversation: projectConversation,
      origin: "pod_context",
      spaces: [selectedSpace],
    });

    await updateConversationRequirements(auth, {
      conversation: await fetchConversation(projectConversation.sId),
    });

    const updatedConversation = await fetchConversation(
      projectConversation.sId
    );
    expect(updatedConversation.requestedSpaceIds).toHaveLength(2);
    expect(updatedConversation.requestedSpaceIds).toEqual(
      expect.arrayContaining([projectSpace.sId, selectedSpace.sId])
    );
  });
});
