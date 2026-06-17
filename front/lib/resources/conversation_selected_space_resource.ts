import type { Authenticator } from "@app/lib/auth";
import type { ConversationSelectedSpaceOrigin } from "@app/lib/models/agent/conversation_selected_space";
import { ConversationSelectedSpaceModel } from "@app/lib/models/agent/conversation_selected_space";
import { BaseResource } from "@app/lib/resources/base_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import type { ReadonlyAttributesType } from "@app/lib/resources/storage/types";
import type { ModelStaticWorkspaceAware } from "@app/lib/resources/storage/wrappers/workspace_models";
import { withTransaction } from "@app/lib/utils/sql_utils";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import type { Attributes, Transaction } from "sequelize";
import { Op } from "sequelize";

function orderSpacesByModelIds({
  spaces,
  spaceModelIds,
}: {
  spaces: SpaceResource[];
  spaceModelIds: ModelId[];
}): SpaceResource[] {
  const spacesByModelId = new Map(spaces.map((space) => [space.id, space]));

  return spaceModelIds
    .map((spaceModelId) => spacesByModelId.get(spaceModelId))
    .filter((space): space is SpaceResource => space !== undefined);
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ConversationSelectedSpaceResource
  extends ReadonlyAttributesType<ConversationSelectedSpaceModel> {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ConversationSelectedSpaceResource extends BaseResource<ConversationSelectedSpaceModel> {
  static model: ModelStaticWorkspaceAware<ConversationSelectedSpaceModel> =
    ConversationSelectedSpaceModel;

  constructor(
    model: ModelStaticWorkspaceAware<ConversationSelectedSpaceModel>,
    blob: Attributes<ConversationSelectedSpaceModel>
  ) {
    super(model, blob);
  }

  static async listByConversation(
    auth: Authenticator,
    {
      conversation,
      activeOnly = true,
      transaction,
    }: {
      conversation: ConversationWithoutContentType;
      activeOnly?: boolean;
      transaction?: Transaction;
    }
  ): Promise<ConversationSelectedSpaceResource[]> {
    const rows = await this.model.findAll({
      where: {
        workspaceId: auth.getNonNullableWorkspace().id,
        conversationId: conversation.id,
        ...(activeOnly ? { removedAt: null } : {}),
      },
      order: [["id", "ASC"]],
      transaction,
    });

    return rows.map((row) => new this(this.model, row.get()));
  }

  static async listActiveSpacesByConversation(
    auth: Authenticator,
    {
      conversation,
      transaction,
    }: {
      conversation: ConversationWithoutContentType;
      transaction?: Transaction;
    }
  ): Promise<SpaceResource[]> {
    const selectedSpaces = await this.listByConversation(auth, {
      conversation,
      transaction,
    });

    const selectedSpaceModelIds = selectedSpaces.map(
      (selectedSpace) => selectedSpace.spaceId
    );
    const spaces = await SpaceResource.fetchByModelIds(
      auth,
      selectedSpaceModelIds,
      { transaction }
    );

    return orderSpacesByModelIds({
      spaces,
      spaceModelIds: selectedSpaceModelIds,
    });
  }

  static async upsertForConversation(
    auth: Authenticator,
    {
      conversation,
      spaces,
      origin,
      transaction,
    }: {
      conversation: ConversationWithoutContentType;
      spaces: SpaceResource[];
      origin: ConversationSelectedSpaceOrigin;
      transaction?: Transaction;
    }
  ): Promise<{
    selectedSpaces: ConversationSelectedSpaceResource[];
    createdSpaces: SpaceResource[];
    reactivatedSpaces: SpaceResource[];
  }> {
    return withTransaction(async (t) => {
      const workspace = auth.getNonNullableWorkspace();
      const user = auth.getNonNullableUser();
      const spaceModelIds = spaces.map((space) => space.id);

      if (spaceModelIds.length === 0) {
        return {
          selectedSpaces: [],
          createdSpaces: [],
          reactivatedSpaces: [],
        };
      }

      const existingRows = await this.model.findAll({
        where: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          spaceId: {
            [Op.in]: spaceModelIds,
          },
        },
        order: [["id", "ASC"]],
        transaction: t,
      });
      const existingSpaceModelIds = new Set(
        existingRows.map((row) => row.spaceId)
      );
      const reactivatedSpaceModelIds = existingRows
        .filter((row) => row.removedAt !== null)
        .map((row) => row.spaceId);
      const reactivatedRowModelIds = existingRows
        .filter((row) => row.removedAt !== null)
        .map((row) => row.id);
      const spacesByModelId = new Map(spaces.map((space) => [space.id, space]));

      const createdSpaces = spaces.filter(
        (space) => !existingSpaceModelIds.has(space.id)
      );

      if (createdSpaces.length > 0) {
        await this.model.bulkCreate(
          createdSpaces.map((space) => ({
            workspaceId: workspace.id,
            conversationId: conversation.id,
            spaceId: space.id,
            selectedByUserId: user.id,
            origin,
            removedAt: null,
          })),
          { ignoreDuplicates: true, transaction: t }
        );
      }

      if (reactivatedRowModelIds.length > 0) {
        await this.model.update(
          {
            selectedByUserId: user.id,
            origin,
            removedAt: null,
          },
          {
            where: {
              workspaceId: workspace.id,
              id: {
                [Op.in]: reactivatedRowModelIds,
              },
            },
            transaction: t,
          }
        );
      }

      const selectedRows = await this.model.findAll({
        where: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          spaceId: {
            [Op.in]: spaceModelIds,
          },
        },
        order: [["id", "ASC"]],
        transaction: t,
      });

      return {
        selectedSpaces: selectedRows.map(
          (row) => new this(this.model, row.get())
        ),
        createdSpaces,
        reactivatedSpaces: reactivatedSpaceModelIds
          .map((spaceModelId) => spacesByModelId.get(spaceModelId))
          .filter((space): space is SpaceResource => space !== undefined),
      };
    }, transaction);
  }

  static async deleteForConversation(
    auth: Authenticator,
    {
      conversation,
      transaction,
    }: {
      conversation: { id: ModelId };
      transaction?: Transaction;
    }
  ): Promise<number> {
    return this.model.destroy({
      where: {
        workspaceId: auth.getNonNullableWorkspace().id,
        conversationId: conversation.id,
      },
      transaction,
    });
  }

  static async deleteAllBySpace(
    auth: Authenticator,
    {
      spaceModelId,
      transaction,
    }: {
      spaceModelId: ModelId;
      transaction?: Transaction;
    }
  ): Promise<number> {
    return this.model.destroy({
      where: {
        workspaceId: auth.getNonNullableWorkspace().id,
        spaceId: spaceModelId,
      },
      transaction,
    });
  }

  async delete(
    _auth: Authenticator,
    { transaction }: { transaction?: Transaction }
  ): Promise<Result<number, Error>> {
    const deletedCount = await this.model.destroy({
      where: { id: this.id },
      transaction,
    });

    return new Ok(deletedCount);
  }
}
