import { and, asc, eq } from "drizzle-orm";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import type { AiIntakePhotoCreateInput, AiIntakePhotoRecord, AiIntakePhotoRepository } from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;

/**
 * Sprint 91: no dedicated transaction capability - every operation here is a
 * single statement, run directly against whatever db handle is passed in.
 * Takes an explicit schema module (mirroring
 * repositories/ai-product-intake/drizzle.ts) so the same code works against
 * either dialect's table object.
 */
export function createDrizzleAiIntakePhotoRepository(db: any, schema: Schema): AiIntakePhotoRepository {
  const table = (schema as Record<string, any>).aiIntakePhotos;
  return {
    async create(input: AiIntakePhotoCreateInput): Promise<AiIntakePhotoRecord> {
      await db.insert(table).values({
        id: input.id,
        intakeId: input.intakeId,
        storageKey: input.storageKey,
        originalFilename: input.originalFilename,
        createdByAdminUserId: input.createdByAdminUserId,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      const [row] = await db.select().from(table).where(eq(table.id, input.id));
      return row as AiIntakePhotoRecord;
    },

    async listByIntake(intakeId: string): Promise<AiIntakePhotoRecord[]> {
      const rows = await db
        .select()
        .from(table)
        .where(eq(table.intakeId, intakeId))
        .orderBy(asc(table.createdAt), asc(table.id));
      return rows as AiIntakePhotoRecord[];
    },

    async findByIdAndIntake(intakeId: string, id: string): Promise<AiIntakePhotoRecord | null> {
      const [row] = await db.select().from(table).where(and(eq(table.id, id), eq(table.intakeId, intakeId)));
      return (row as AiIntakePhotoRecord) ?? null;
    },

    async deleteById(id: string): Promise<void> {
      await db.delete(table).where(eq(table.id, id));
    },
  };
}
